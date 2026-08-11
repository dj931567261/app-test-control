#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { cleanDiagnostic } from "./diagnostic.js";
import { TrustedBuildRunner } from "./runner.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_RELATIVE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\u0000-\u001f\u007f]+$/;
const PROBE_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const ADDITIVE_LOCAL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const DESTRUCTIVE_LOCAL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const GRADLE_EXECUTION_ANNOTATIONS = {
  ...DESTRUCTIVE_LOCAL_ANNOTATIONS,
  // local_trusted intentionally cannot enforce network denial. Advertise the
  // broadest behavior of this backend-selectable tool to MCP clients.
  openWorldHint: true,
} as const;

function asText(payload: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
    }],
  };
}

export function publicError(error: unknown): string {
  return cleanDiagnostic(error, 600);
}

function asError(error: unknown) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: publicError(error) }],
  };
}

export function createBuildRunnerServer(runner = new TrustedBuildRunner()): McpServer {
  const server = new McpServer({ name: "build-runner-mcp", version: "0.2.0" });

  server.registerTool(
    "probe_capabilities",
    {
      description: "Probe the v2 runner contract for exactly the configured backend. Docker stays fail-closed unless every strong-isolation claim, including workspace quota, is attested. Explicit local_trusted may run approved trusted projects with a minimal environment and disposable cache overlay, but always reports network/filesystem/resource isolation as not enforced and auto_patch_eligible=false. There is no automatic backend fallback.",
      inputSchema: {},
      annotations: PROBE_ANNOTATIONS,
    },
    async () => asText(await runner.probeCapabilities()),
  );

  server.registerTool(
    "seal_gradle_cache",
    {
      description: "Create a retained, content-addressed, read-only Gradle cache seed from only caches/modules-2 and complete wrapper/dists. It excludes Gradle properties, init scripts, lock/partial files, non-marker empty files, and credential-like paths. The user must approve this local filesystem copy first.",
      inputSchema: {
        source_gradle_home: z.string().min(1).max(4096).describe(
          "Absolute Gradle user-home directory to copy from after all Gradle processes have stopped.",
        ),
      },
      annotations: ADDITIVE_LOCAL_ANNOTATIONS,
    },
    async ({ source_gradle_home }) => {
      try {
        return asText(await runner.sealGradleCache(source_gradle_home));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "create_build_environment",
    {
      description: "Re-audit one sealed CrashFix baseline/candidate workspace against the caller-approved manifest and canonical-diff identities, verify one sealed Gradle cache seed, one exact offline Gradle command plan, and the explicitly expected configured backend. Returns a single-use opaque environment id plus public execution-environment and workspace identities; it does not run Gradle.",
      inputSchema: {
        expected_backend: z.enum(["docker", "local_trusted"]).describe(
          "Backend locked by the active CrashFix session; it must exactly match this runner configuration.",
        ),
        role: z.enum(["baseline", "candidate"]),
        phase: z.enum(["regression", "affected", "static_analysis", "build"]),
        workspace_root: z.string().min(1).max(4096).describe(
          "Absolute private root returned by the CrashFix snapshot clone helper.",
        ),
        snapshot_root: z.string().min(1).max(4096).describe(
          "Absolute sealed snapshot private root from the same active CrashFix session.",
        ),
        expected_source_snapshot_sha256: z.string().regex(SHA256),
        expected_workspace_manifest_sha256: z.string().regex(SHA256).describe(
          "Full current_manifest_sha256 from the caller's immediately preceding approved workspace audit.",
        ),
        expected_workspace_canonical_diff_sha256: z.string().regex(SHA256).describe(
          "Full canonical_diff_sha256 from the same caller-approved workspace audit.",
        ),
        cache_seed_id: z.string().uuid().describe(
          "Opaque in-memory id returned by this runner process from seal_gradle_cache.",
        ),
        project_relative_dir: z.string().min(1).max(1024).regex(SAFE_RELATIVE).optional().default("."),
        artifact_relative_path: z.string().min(5).max(1024).regex(SAFE_RELATIVE).optional().describe(
          "Required only for build phase; one APK path relative to the private workspace, which must be absent before execution.",
        ),
        expected_signer_certificate_sha256: z.string().regex(SHA256).optional().describe(
          "Required only for build phase; the separately approved non-production test signer certificate SHA-256.",
        ),
        tasks: z.array(z.string().min(1).max(256)).min(1).max(16),
      },
      annotations: ADDITIVE_LOCAL_ANNOTATIONS,
    },
    async (input) => {
      try {
        return asText(await runner.createBuildEnvironment({
          expectedBackend: input.expected_backend,
          role: input.role,
          phase: input.phase,
          workspaceRoot: input.workspace_root,
          snapshotRoot: input.snapshot_root,
          expectedSourceSnapshotSha256: input.expected_source_snapshot_sha256,
          expectedWorkspaceManifestSha256: input.expected_workspace_manifest_sha256,
          expectedWorkspaceCanonicalDiffSha256:
            input.expected_workspace_canonical_diff_sha256,
          cacheSeedId: input.cache_seed_id,
          projectRelativeDir: input.project_relative_dir,
          artifactRelativePath: input.artifact_relative_path,
          expectedSignerCertificateSha256: input.expected_signer_certificate_sha256,
          tasks: input.tasks,
        }));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "dispose_gradle_cache",
    {
      description: "Delete one retained sealed Gradle cache seed created by this runner process. Call only after the user separately confirms cleanup; refusing cleanup does not change CrashFix status.",
      inputSchema: {
        cache_seed_id: z.string().uuid(),
      },
      annotations: DESTRUCTIVE_LOCAL_ANNOTATIONS,
    },
    async ({ cache_seed_id }) => {
      try {
        return asText(await runner.disposeGradleCache(cache_seed_id));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "run_gradle",
    {
      description: "Consume exactly one previously created build environment. No command, environment, path, network, or Gradle arguments can be added at run time. The command is capped at 60 seconds. Docker uses its attested container; local_trusted uses a private process group and disposable cache copy without claiming host isolation.",
      inputSchema: {
        environment_id: z.string().uuid(),
      },
      annotations: GRADLE_EXECUTION_ANNOTATIONS,
    },
    async ({ environment_id }) => {
      try {
        return asText(await runner.runGradle(environment_id));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "inspect_apk",
    {
      description: "Consume and inspect the immutable private copy of the one APK path bound before a successful build-phase run. Docker uses tools from its pinned image; local_trusted uses fixed, hashed host SDK tools. The unpublished staging copy is then destroyed.",
      inputSchema: {
        environment_id: z.string().uuid(),
      },
      annotations: DESTRUCTIVE_LOCAL_ANNOTATIONS,
    },
    async ({ environment_id }) => {
      try {
        return asText(await runner.inspectApk(environment_id));
      } catch (error) {
        return asError(error);
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const runner = new TrustedBuildRunner();
  const server = createBuildRunnerServer(runner);
  let closing = false;
  let requestedExitCode = 0;
  const close = async (successCode: number): Promise<void> => {
    if (!closing && requestedExitCode !== 1) requestedExitCode = successCode;
    if (closing) return;
    closing = true;
    try {
      await runner.close();
      process.exit(requestedExitCode);
    } catch {
      process.stderr.write("build-runner: shutdown containment cleanup failed\n");
      // Never intentionally exit while container absence is unproven. Keep a
      // referenced retry timer so detached Docker work cannot outlive us merely
      // because the first daemon cleanup attempt failed.
      requestedExitCode = 1;
      closing = false;
      setTimeout(() => void close(requestedExitCode), 1_000);
    }
  };
  process.once("SIGINT", () => void close(130));
  process.once("SIGTERM", () => void close(143));
  process.stdin.once("end", () => void close(0));
  await server.connect(new StdioServerTransport());
}

/**
 * Keep startup failures on the stdio control channel bounded and free of host
 * paths. Uncaught top-level-await rejections would otherwise make Node print a
 * full stack before the MCP client can report a safe initialization failure.
 */
export async function runEntrypoint(start: () => Promise<void>): Promise<void> {
  try {
    await start();
  } catch {
    process.stderr.write("build-runner: startup failed\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runEntrypoint(main);
}
