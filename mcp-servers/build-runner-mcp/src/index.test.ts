import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { publicError } from "./index.js";

const execFileAsync = promisify(execFile);

function textPayload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((item) => item.text ?? "")
    .join("\n");
  return JSON.parse(text) as Record<string, unknown>;
}

test("public errors fail closed on absolute paths containing spaces or Unicode", () => {
  assert.equal(
    publicError(new Error("audit failed at /tmp/测试 project/private file: denied")),
    "audit failed at <PATH>",
  );
  assert.equal(
    publicError(new Error("spawn C:\\Users\\Example User\\private.exe ENOENT")),
    "spawn <PATH>",
  );
  assert.equal(
    publicError(new Error("daemon unix:///Users/example/.docker/run/docker.sock unavailable")),
    "daemon <DOCKER_SOCKET>",
  );
  assert.equal(
    publicError(new Error("daemon unix:///Users/example/Docker Socket/docker.sock unavailable")),
    "daemon <DOCKER_SOCKET>",
  );
  if (process.env.HOME) {
    assert.equal(
      publicError(new Error(`read ${process.env.HOME}/private folder/secret failed`)),
      "read <PATH>",
    );
  }
});

test("entrypoint reports a fixed bounded startup failure without a stack or host path", async () => {
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const moduleUrl = pathToFileURL(path.join(sourceDir, "index.ts")).href;
  const injectedPath = "/tmp/private startup/secret-config.json";
  const expression = [
    `import { runEntrypoint } from ${JSON.stringify(moduleUrl)};`,
    `await runEntrypoint(async () => { throw new Error(${JSON.stringify(injectedPath)}); });`,
  ].join("\n");
  await assert.rejects(
    execFileAsync(process.execPath, [
      "--import", "tsx",
      "--input-type=module",
      "--eval", expression,
    ], { encoding: "utf8" }),
    (error: unknown) => {
      const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
      assert.equal(failure.code, 1);
      assert.equal(failure.stdout, "");
      assert.equal(failure.stderr, "build-runner: startup failed\n");
      assert.equal(failure.stderr?.includes(injectedPath), false);
      assert.equal(failure.stderr?.includes("Error:"), false);
      return true;
    },
  );
});

test("build runner advertises strict schemas and fails closed when sandbox is unconfigured", async () => {
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.join(sourceDir, "index.ts")],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      APP_TEST_CTRL_BUILD_RUNNER_BACKEND: "docker",
      APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN: "",
      APP_TEST_CTRL_BUILD_RUNNER_IMAGE: "",
    },
  });
  const client = new Client({ name: "build-runner-index-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      "create_build_environment",
      "dispose_gradle_cache",
      "inspect_apk",
      "probe_capabilities",
      "run_gradle",
      "seal_gradle_cache",
    ]);
    const annotationByName = new Map(
      listed.tools.map((tool) => [tool.name, tool.annotations] as const),
    );
    assert.deepEqual(annotationByName.get("probe_capabilities"), {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    for (const name of ["seal_gradle_cache", "create_build_environment"] as const) {
      assert.deepEqual(annotationByName.get(name), {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
    }
    for (const name of ["dispose_gradle_cache", "inspect_apk"] as const) {
      assert.deepEqual(annotationByName.get(name), {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      });
    }
    assert.deepEqual(annotationByName.get("run_gradle"), {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    const create = listed.tools.find((tool) => tool.name === "create_build_environment");
    assert.ok(create);
    const properties = create.inputSchema.properties as Record<string, unknown>;
    assert.deepEqual(Object.keys(properties).sort(), [
      "artifact_relative_path",
      "cache_seed_id",
      "expected_backend",
      "expected_signer_certificate_sha256",
      "expected_source_snapshot_sha256",
      "expected_workspace_canonical_diff_sha256",
      "expected_workspace_manifest_sha256",
      "phase",
      "project_relative_dir",
      "role",
      "snapshot_root",
      "tasks",
      "workspace_root",
    ]);
    assert.deepEqual([...(create.inputSchema.required as string[])].sort(), [
      "cache_seed_id",
      "expected_backend",
      "expected_source_snapshot_sha256",
      "expected_workspace_canonical_diff_sha256",
      "expected_workspace_manifest_sha256",
      "phase",
      "role",
      "snapshot_root",
      "tasks",
      "workspace_root",
    ]);
    assert.equal(create.inputSchema.additionalProperties, false);

    const run = listed.tools.find((tool) => tool.name === "run_gradle");
    assert.deepEqual(run?.inputSchema.required, ["environment_id"]);
    const inspect = listed.tools.find((tool) => tool.name === "inspect_apk");
    assert.deepEqual(inspect?.inputSchema.required, ["environment_id"]);

    const probe = await client.callTool({ name: "probe_capabilities", arguments: {} });
    assert.notEqual(probe.isError, true);
    const payload = textPayload(probe);
    assert.equal(payload.available, false);
    assert.equal(payload.auto_patch_eligible, false);
    assert.equal(payload.schema_version, "build-runner-capabilities/v2");
    assert.equal(payload.execution_profile, "docker_strict");
    assert.equal(JSON.stringify(payload).includes(process.env.HOME ?? "__never__"), false);

    const unknown = await client.callTool({
      name: "run_gradle",
      arguments: { environment_id: "00000000-0000-4000-8000-000000000000" },
    });
    assert.equal(unknown.isError, true);
  } finally {
    await client.close();
  }
});
