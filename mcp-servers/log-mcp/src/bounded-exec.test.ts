import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import {
  BoundedExecError,
  execFileBounded,
  truncateCommandDiagnostic,
} from "./bounded-exec.js";

async function makeIgnoreTermHelper(directory: string): Promise<string> {
  const helper = path.join(directory, "ignore-term");
  await writeFile(
    helper,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "process.on('SIGTERM', () => {});",
      "const readyIndex = process.argv.indexOf('--ready');",
      "const readyPath = readyIndex === -1 ? null : process.argv[readyIndex + 1];",
      "const markReady = () => { if (readyPath) fs.writeFileSync(readyPath, 'ready'); };",
      "if (process.argv.includes('--grandchild')) {",
      '  const { spawn } = require("node:child_process");',
      "  const source = \"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)\";",
      "  const grandchild = spawn(process.execPath, ['-e', source],",
      "    { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });",
      "  grandchild.once('message', () => {",
      "    markReady();",
      '    process.stdout.write(`PID:${process.pid} GRANDCHILD:${grandchild.pid}\\n`);',
      "  });",
      "} else if (process.argv.includes('--background')) {",
      '  const { spawn } = require("node:child_process");',
      "  const marker = process.argv[process.argv.indexOf('--background') + 1];",
      "  const source = \"const fs=require('node:fs');process.on('SIGTERM',()=>{});process.send('ready');setTimeout(()=>fs.writeFileSync(process.argv[1],'survived'),900);setInterval(()=>{},1000)\";",
      "  const grandchild = spawn(process.execPath, ['-e', source, marker],",
      "    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
      "  grandchild.once('message', () => {",
      "    grandchild.disconnect();",
      "    grandchild.unref();",
      '    process.stdout.write(`PID:${process.pid} GRANDCHILD:${grandchild.pid}\\n`, () => process.exit(0));',
      "  });",
      "} else {",
      "  markReady();",
      '  process.stdout.write(`PID:${process.pid}\\n`);',
      "}",
      "if (process.argv.includes('--flood')) {",
      "  const chunk = Buffer.alloc(4096, 0x78);",
      "  setInterval(() => process.stdout.write(chunk), 1);",
      "}",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(helper, 0o700);
  return helper;
}

async function waitForReady(file: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      if ((await readFile(file, "utf8")) === "ready") return;
    } catch {
      // The helper has not completed signal-handler setup yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`ignore-TERM fixture did not become ready: ${file}`);
}

function pidFrom(error: BoundedExecError): number {
  const match = /^PID:(\d+)/m.exec(error.stdout);
  assert.ok(match, `helper pid missing from bounded stdout: ${error.stdout}`);
  return Number(match[1]);
}

function assertProcessGone(pid: number): void {
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    `process ${pid} survived bounded command cleanup`,
  );
}

test("bounded command escalates timeout from TERM to KILL and awaits close", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-bounded-timeout-"));
  try {
    const helper = await makeIgnoreTermHelper(temp);
    const ready = path.join(temp, "timeout.ready");
    const startedAt = Date.now();
    const pending = execFileBounded(helper, ["--ready", ready], {
      timeoutMs: 10_000,
    }).then(
      () => assert.fail("ignore-TERM helper unexpectedly completed"),
      (cause: unknown) => cause,
    );
    await waitForReady(ready);
    const error = await pending;
    assert.ok(error instanceof BoundedExecError);
    assert.match(error.message, /timed out after 10000ms/);
    assert.equal(error.signal, "SIGKILL");
    assert.ok(Date.now() - startedAt < 13_000, "timeout cleanup exceeded hard deadline");
    assertProcessGone(pidFrom(error));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("bounded command abort escalates against an ignore-TERM helper", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-bounded-abort-"));
  try {
    const helper = await makeIgnoreTermHelper(temp);
    const ready = path.join(temp, "abort.ready");
    const controller = new AbortController();
    const pending = execFileBounded(helper, ["--ready", ready], {
      timeoutMs: 60_000,
      signal: controller.signal,
    }).then(
      () => assert.fail("aborted helper unexpectedly completed"),
      (cause: unknown) => cause,
    );
    await waitForReady(ready);
    controller.abort(new Error("test cancellation"));
    const error = await pending;
    assert.ok(error instanceof BoundedExecError);
    assert.match(error.message, /command aborted: test cancellation/);
    assert.equal(error.signal, "SIGKILL");
    assertProcessGone(pidFrom(error));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("bounded command maxBuffer escalates and retains only bounded output", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-bounded-buffer-"));
  try {
    const helper = await makeIgnoreTermHelper(temp);
    const error = await execFileBounded(helper, ["--flood"], {
      timeoutMs: 60_000,
      maxBufferBytes: 1_024,
    }).then(
      () => assert.fail("output-flooding helper unexpectedly completed"),
      (cause: unknown) => cause,
    );
    assert.ok(error instanceof BoundedExecError);
    assert.match(error.message, /exceeded maxBufferBytes=1024/);
    assert.equal(Buffer.byteLength(error.stdout) + Buffer.byteLength(error.stderr), 1_024);
    assert.equal(error.signal, "SIGKILL");
    assertProcessGone(pidFrom(error));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("bounded command kills an ignore-TERM process group that inherits stdout", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-bounded-group-"));
  try {
    const helper = await makeIgnoreTermHelper(temp);
    const ready = path.join(temp, "group.ready");
    const pending = execFileBounded(helper, ["--grandchild", "--ready", ready], {
      timeoutMs: 10_000,
    }).then(
      () => assert.fail("process group unexpectedly completed"),
      (cause: unknown) => cause,
    );
    await waitForReady(ready);
    const error = await pending;
    assert.ok(error instanceof BoundedExecError);
    assert.match(error.message, /timed out/);
    assert.equal(error.signal, "SIGKILL");
    const match = /^PID:(\d+) GRANDCHILD:(\d+)/m.exec(error.stdout);
    assert.ok(match, `parent/grandchild pids missing: ${error.stdout}`);
    assertProcessGone(Number(match[1]));
    assertProcessGone(Number(match[2]));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("command diagnostics are UTF-8 safe and explicitly truncated", () => {
  const diagnostic = truncateCommandDiagnostic(`head-${"界".repeat(100)}`, 32)!;
  assert.ok(!diagnostic.includes("�"));
  assert.match(diagnostic, /diagnostic truncated; original_bytes=305, limit_bytes=32/);
  assert.equal(truncateCommandDiagnostic("small", 32), "small");
});

test("successful parent exit rejects and reaps a background process group", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-bounded-background-"));
  const marker = path.join(temp, "background-survived.txt");
  try {
    const helper = await makeIgnoreTermHelper(temp);
    const error = await execFileBounded(helper, ["--background", marker], {
      timeoutMs: 10_000,
    }).then(
      () => assert.fail("background descendant was accepted as a clean command"),
      (cause: unknown) => cause,
    );
    assert.ok(error instanceof BoundedExecError);
    assert.match(error.message, /left a background process/);
    const match = /^PID:(\d+) GRANDCHILD:(\d+)/m.exec(error.stdout);
    assert.ok(match, `background pids missing: ${error.stdout}`);
    assertProcessGone(Number(match[1]));
    assertProcessGone(Number(match[2]));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await assert.rejects(readFile(marker), /ENOENT/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
