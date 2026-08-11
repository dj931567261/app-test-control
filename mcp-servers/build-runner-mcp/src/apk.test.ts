import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { disposeStagedApk, inspectApk, stageApk } from "./apk.js";
import type { RunnerConfig } from "./config.js";
import type { BuildBackend, CapabilityResult } from "./docker-backend.js";
import type { ProcessResult } from "./process-runner.js";

function processResult(
  stdout: string,
  stderr = "",
  exitCode = 0,
): ProcessResult {
  return {
    stdout,
    stderr,
    stdoutRawSha256: createHash("sha256").update(Buffer.from(stdout, "utf8")).digest("hex"),
    stderrRawSha256: createHash("sha256").update(Buffer.from(stderr, "utf8")).digest("hex"),
    exitCode,
    signal: null,
    durationMs: 1,
  };
}

class InspectorBackend implements BuildBackend {
  constructor(
    readonly signerOutput = `Signer #1 certificate SHA-256 digest: ${"AB:".repeat(31)}AB\n`,
  ) {}

  readonly backend = "docker" as const;
  readonly config: RunnerConfig = {
    backend: "docker",
    dockerBin: "/fake/docker",
    dockerHost: "unix:///fake/docker.sock",
    ociRuntime: "runc",
    image: `example/android@sha256:${"a".repeat(64)}`,
    javaHome: "/opt/java/openjdk",
    androidSdkRoot: "/opt/android-sdk",
    apkAnalyzer: "/opt/android-sdk/apkanalyzer",
    apkSigner: "/opt/android-sdk/apksigner",
    maxMemoryMb: 1024,
    maxCpus: 1,
    maxPids: 64,
    gradleHomeMb: 1024,
    tmpMb: 128,
    maxOutputBytes: 4096,
  };
  async initialize(): Promise<void> {}
  async close(): Promise<void> {}
  async probe(): Promise<CapabilityResult> { return { available: false, backend: "docker", reasons: [] }; }
  executionProfile(): Record<string, unknown> { return {}; }
  async runBuildCommand(): Promise<ProcessResult> { throw new Error("unused"); }
  async runReadOnlyArtifactCommand(options: {
    tool: "apkanalyzer" | "apksigner";
    argsBeforeArtifact: readonly string[];
  }): Promise<ProcessResult> {
    const key = options.argsBeforeArtifact.join(" ");
    const stdout = options.tool === "apksigner"
      ? this.signerOutput
      : key === "manifest application-id"
        ? "com.example.demo\n"
        : key === "manifest version-name"
          ? "1.2.3\n"
          : key === "manifest version-code"
            ? "42\n"
            : "true\n";
    return processResult(stdout);
  }
}

test("APK inspection binds artifact-derived identity and labels variant as task-bound", async (t) => {
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), "build-runner-apk-")));
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  await mkdir(path.join(workspace, "app/build/outputs/apk/debug"), { recursive: true, mode: 0o700 });
  const relative = "app/build/outputs/apk/debug/app-debug.apk";
  await writeFile(path.join(workspace, relative), Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), {
    mode: 0o600,
  });
  const result = await inspectApk({
    backend: new InspectorBackend(),
    workspaceDir: workspace,
    artifactRelativePath: relative,
    tasks: [":app:assembleDebug"],
  });
  assert.equal(result.package, "com.example.demo");
  assert.equal(result.version_name, "1.2.3");
  assert.equal(result.version_code, "42");
  assert.equal(result.debuggable, true);
  assert.equal(result.signed, true);
  assert.equal(result.signature_status, "verified");
  assert.deepEqual(result.signer_certificate_sha256, ["ab".repeat(32)]);
  assert.equal(result.variant, "Debug");
  assert.equal(result.variant_source, "task-bound");
  assert.equal(result.variant_artifact_derived, false);
  assert.match(result.artifact_sha256, /^[a-f0-9]{64}$/);

  await assert.rejects(
    inspectApk({
      backend: new InspectorBackend(),
      workspaceDir: workspace,
      artifactRelativePath: "../outside.apk",
      tasks: ["assembleDebug"],
    }),
    /relative|inside|safe/i,
  );
});

test("APK staging creates an immutable private copy and removes it after inspection", async (t) => {
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), "build-runner-apk-stage-source-")));
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  const relative = "app/build/outputs/apk/debug/app-debug.apk";
  await mkdir(path.join(workspace, "app/build/outputs/apk/debug"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(workspace, relative), Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]), {
    mode: 0o600,
  });

  const staged = await stageApk({ workspaceDir: workspace, artifactRelativePath: relative });
  assert.notEqual(staged.root, workspace);
  const inspected = await inspectApk({
    backend: new InspectorBackend(),
    workspaceDir: staged.root,
    artifactRelativePath: staged.relativePath,
    tasks: [":app:assembleDebug"],
  });
  assert.equal(inspected.artifact_sha256, staged.sha256);
  await disposeStagedApk(staged);
  await assert.rejects(access(staged.root), /ENOENT/);
});

test("APK inspection rejects an invalid or unverifiable signature", async (t) => {
  class InvalidSignerBackend extends InspectorBackend {
    override async runReadOnlyArtifactCommand(
      options: Parameters<BuildBackend["runReadOnlyArtifactCommand"]>[0],
    ): Promise<ProcessResult> {
      if (options.tool === "apksigner") {
        return processResult("", "invalid", 1);
      }
      return super.runReadOnlyArtifactCommand(options);
    }
  }
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), "build-runner-apk-invalid-signature-")));
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  const relative = "app.apk";
  await writeFile(path.join(workspace, relative), Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]), { mode: 0o600 });
  await assert.rejects(
    inspectApk({
      backend: new InvalidSignerBackend(),
      workspaceDir: workspace,
      artifactRelativePath: relative,
      tasks: ["assembleDebug"],
    }),
    /signature verification failed/i,
  );
});

test("APK signer parsing excludes source-stamp certificates and rejects source-stamp-only output", async (t) => {
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), "build-runner-apk-source-stamp-")));
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  await writeFile(
    path.join(workspace, "app.apk"),
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]),
    { mode: 0o600 },
  );
  const signer = `Signer #1 certificate SHA-256 digest: ${"AB:".repeat(31)}AB\n`;
  const sourceStamp = `Source Stamp Signer certificate SHA-256 digest: ${"CD:".repeat(31)}CD\n`;
  const inspected = await inspectApk({
    backend: new InspectorBackend(`${signer}${sourceStamp}`),
    workspaceDir: workspace,
    artifactRelativePath: "app.apk",
    tasks: ["assembleDebug"],
  });
  assert.deepEqual(inspected.signer_certificate_sha256, ["ab".repeat(32)]);

  await assert.rejects(
    inspectApk({
      backend: new InspectorBackend(sourceStamp),
      workspaceDir: workspace,
      artifactRelativePath: "app.apk",
      tasks: ["assembleDebug"],
    }),
    /omitted certificate identity/i,
  );
});
