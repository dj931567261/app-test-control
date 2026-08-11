import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { ProcessGroupStdioTransport } from "./process-group-transport.js";

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function childFixture(t: TestContext, source: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "firebase-transport-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const entry = path.join(root, "child.mjs");
  await writeFile(entry, source, { mode: 0o600 });
  return entry;
}

test("send rejects promptly when a backpressured upstream closes without drain", async (t) => {
  const entry = await childFixture(t, "setTimeout(() => process.exit(0), 50);\n");
  const transport = new ProcessGroupStdioTransport({
    command: process.execPath,
    args: [entry],
    cwd: path.dirname(entry),
    env: { PATH: process.env.PATH ?? "" },
  });
  t.after(async () => transport.close().catch(() => undefined));
  await transport.start();
  await assert.rejects(
    transport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "fixture",
      params: { value: "x".repeat(1024 * 1024) },
    }),
    /closed during write|stdin closed during write/,
  );
});

test("an oversized upstream protocol line fails closed", async (t) => {
  const entry = await childFixture(t, [
    "process.stdout.write('x'.repeat(2 * 1024 * 1024 + 1));",
    "setTimeout(() => process.exit(0), 10_000);",
    "",
  ].join("\n"));
  const transport = new ProcessGroupStdioTransport({
    command: process.execPath,
    args: [entry],
    cwd: path.dirname(entry),
    env: { PATH: process.env.PATH ?? "" },
  });
  t.after(async () => transport.close().catch(() => undefined));
  const failure = new Promise<Error>((resolve) => {
    transport.onerror = resolve;
  });
  await transport.start();
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error("transport did not reject oversized output")),
      3_000,
    );
    timeout.unref();
  });
  const error = await Promise.race([failure, deadline]).finally(() => clearTimeout(timeout));
  assert.match(error.message, /oversized protocol line/);
});

test(
  "an unexpected POSIX group-leader close reaps descendants that closed stdio",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "firebase-transport-group-test-"));
    t.after(async () => rm(root, { recursive: true, force: true }));
    const pidFile = path.join(root, "descendant.pid");
    const entry = path.join(root, "leader.mjs");
    await writeFile(entry, [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const descendant = spawn(process.execPath, [",
      "  '-e',",
      "  `setInterval(() => {}, 1000);`,",
      "], { detached: false, stdio: 'ignore' });",
      "writeFileSync(process.env.PID_FILE, String(descendant.pid));",
      "setTimeout(() => process.exit(0), 50);",
      "",
    ].join("\n"), { mode: 0o600 });

    const transport = new ProcessGroupStdioTransport({
      command: process.execPath,
      args: [entry],
      cwd: root,
      env: { PATH: process.env.PATH ?? "", PID_FILE: pidFile },
    });
    let descendantPid: number | undefined;
    t.after(async () => {
      await transport.close().catch(() => undefined);
      try {
        if (descendantPid && processExists(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      } catch (error) {
        // Some macOS test sandboxes deny all probes once an orphan has already
        // been adopted, even when the preceding group SIGTERM succeeded.
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
    });
    const closed = new Promise<void>((resolve) => {
      transport.onclose = resolve;
    });
    await transport.start();
    await closed;
    descendantPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    assert.equal(Number.isSafeInteger(descendantPid) && descendantPid > 0, true);

    // close() joins the cleanup that the unexpected close handler already
    // started; success proves the whole process group disappeared.
    await transport.close();
    assert.equal(processExists(descendantPid), false);
  },
);
