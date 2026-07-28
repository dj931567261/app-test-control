import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { EventEmitter, once } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  listCaptures,
  startCapture,
  startIosCapture,
  startIosDeviceCapture,
  stopCapture,
} from "./captures.js";
import { pipeCaptureToFile } from "./file-capture.js";
import { openCaptureOutput } from "./capture-output.js";

async function makeExecutable(file: string, source: string): Promise<void> {
  await writeFile(file, source, "utf8");
  await chmod(file, 0o755);
}

async function waitForText(file: string, text: string, occurrences = 1): Promise<void> {
  // CI runs this file alongside several process-heavy MCP suites. Give the
  // fixture enough wall-clock time to be scheduled without weakening the
  // assertion: success still requires the exact marker to be observed.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const content = await readFile(file, "utf8");
      if (content.split(text).length - 1 >= occurrences) return;
    } catch {
      // The writer may not have opened the file on the first turn yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for ${JSON.stringify(text)} in ${file}`);
}

async function waitForFile(file: string): Promise<string> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      const content = await readFile(file, "utf8");
      if (content.trim()) return content;
    } catch {
      // Producer has not created the marker yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${file}`);
}

async function waitForProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for process ${pid} to exit`);
}

async function waitForCaptureStatus(sessionId: string, status: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const capture = listCaptures().find((item) => item.sessionId === sessionId);
    if (capture?.status === status) return capture;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for capture ${JSON.stringify(sessionId)} to become ${status}`);
}

test("shared file capture waits for stdout and stderr tails to flush", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-file-capture-"));
  const outFile = path.join(temp, "capture.log");
  try {
    const script = [
      'process.stdout.write("started\\n");',
      "process.on('SIGTERM', () => {",
      "  let pending = 2;",
      "  const done = () => { if (--pending === 0) process.exit(0); };",
      '  process.stdout.write("stdout-tail\\n", done);',
      '  process.stderr.write("stderr-tail\\n", done);',
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const proc = spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lifecycle = pipeCaptureToFile(
      proc,
      createWriteStream(outFile, { flags: "a" }),
      "fixture capture",
    );

    await lifecycle.ready;
    await waitForText(outFile, "started");
    await Promise.all([lifecycle.close(), lifecycle.close()]);

    const content = await readFile(outFile, "utf8");
    assert.match(content, /^stdout-tail$/m);
    assert.match(content, /^stderr-tail$/m);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("shared file capture rejects a command that exits during startup", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-file-startup-"));
  const outFile = path.join(temp, "capture.log");
  try {
    const proc = spawn(
      process.execPath,
      ["-e", 'process.stderr.write("bad arguments\\n", () => process.exit(2));'],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const lifecycle = pipeCaptureToFile(
      proc,
      createWriteStream(outFile, { flags: "a" }),
      "failing fixture",
    );

    await assert.rejects(lifecycle.ready, /exited during startup.*code=2/);
    await lifecycle.close();
    assert.match(await readFile(outFile, "utf8"), /bad arguments/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("shared file capture rejects close-before-spawn instead of hanging ready", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-file-pre-spawn-close-"));
  const outFile = path.join(temp, "capture.log");
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const fakeProcessState = Object.assign(events, {
    stdout,
    stderr,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: () => true,
  });
  const fakeProcess = fakeProcessState as unknown as ChildProcess;
  const out = createWriteStream(outFile, { flags: "a" });
  const lifecycle = pipeCaptureToFile(fakeProcess, out, "pre-spawn fixture");
  try {
    fakeProcessState.exitCode = 0;
    fakeProcess.emit("close", 0, null);
    await assert.rejects(lifecycle.ready, /closed before startup completed/);
    await lifecycle.close();
  } finally {
    stdout.destroy();
    stderr.destroy();
    out.destroy();
    await rm(temp, { recursive: true, force: true });
  }
});

test("shared file capture escalates to SIGKILL when a limit-stopped child ignores SIGTERM", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-file-limit-kill-"));
  const outFile = path.join(temp, "capture.log");
  const proc = spawn(
    process.execPath,
    [
      "-e",
      [
        "process.on('SIGTERM', () => {});",
        "setTimeout(() => {",
        "  const chunk = 'k'.repeat(4096);",
        "  setInterval(() => process.stdout.write(chunk), 5);",
        "}, 350);",
      ].join("\n"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const lifecycle = pipeCaptureToFile(
    proc,
    createWriteStream(outFile, { flags: "a" }),
    "limit kill fixture",
    { maxBytes: 8192 },
  );
  try {
    await lifecycle.ready;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("limit-stopped child was not force-killed")),
        5000,
      );
      proc.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await lifecycle.close();
    assert.equal(proc.signalCode, "SIGKILL");
    assert.equal((await stat(outFile)).size, 8192);
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await lifecycle.close().catch(() => undefined);
    await rm(temp, { recursive: true, force: true });
  }
});

test("shared file capture force-stops an ignore-TERM child after output failure", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-file-output-error-"));
  const outFile = path.join(temp, "capture.log");
  const proc = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const out = createWriteStream(outFile, { flags: "a" });
  const lifecycle = pipeCaptureToFile(proc, out, "output error fixture");
  try {
    await lifecycle.ready;
    const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
    out.destroy(new Error("simulated disk failure"));
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("output-failed child was not force-killed")),
          5_000,
        );
        timer.unref();
      }),
    ]);
    assert.equal(proc.signalCode, "SIGKILL");
    await assert.rejects(lifecycle.close(), /output failed.*simulated disk failure/i);
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await lifecycle.close().catch(() => undefined);
    await rm(temp, { recursive: true, force: true });
  }
});

test("validated capture descriptor cannot be redirected by a later path swap", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-output-swap-"));
  const outputPath = path.join(temp, "capture.log");
  const openedPath = path.join(temp, "opened.log");
  const victimPath = path.join(temp, "victim.log");
  try {
    await writeFile(outputPath, "original\n", "utf8");
    await writeFile(victimPath, "victim\n", "utf8");
    const output = await openCaptureOutput(outputPath);

    // Simulate an attacker replacing the checked pathname before the writer is
    // attached. The writer must stay bound to the validated descriptor.
    await rename(outputPath, openedPath);
    await symlink(victimPath, outputPath);
    const stream = output.createWriteStream();
    stream.end("capture\n");
    await once(stream, "close");

    assert.equal(await readFile(victimPath, "utf8"), "victim\n");
    assert.equal(await readFile(openedPath, "utf8"), "original\ncapture\n");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("capture output secures legacy permissions and rejects pre-existing hard links", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-output-security-"));
  const legacyPath = path.join(temp, "legacy.log");
  const victimPath = path.join(temp, "victim.log");
  const linkedPath = path.join(temp, "linked.log");
  try {
    await writeFile(legacyPath, "legacy\n", { mode: 0o644 });
    await chmod(legacyPath, 0o644);
    const output = await openCaptureOutput(legacyPath);
    assert.equal((await stat(legacyPath)).mode & 0o777, 0o600);
    await output.close();

    await writeFile(victimPath, "do-not-touch\n", { mode: 0o600 });
    await link(victimPath, linkedPath);
    await assert.rejects(
      openCaptureOutput(linkedPath),
      /must not have multiple hard links/,
    );
    assert.equal(await readFile(victimPath, "utf8"), "do-not-touch\n");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("iOS device capture blocks restart while stopping and flushes the tail", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-capture-"));
  const idBin = path.join(temp, "fake-idevice-id");
  const syslogBin = path.join(temp, "fake-idevicesyslog");
  const oldId = process.env.IDEVICE_ID_BIN;
  const oldSyslog = process.env.IDEVICESYSLOG_BIN;
  try {
    await makeExecutable(idBin, "#!/bin/sh\nprintf 'test-udid\\n'\n");
    await makeExecutable(
      syslogBin,
      [
        "#!/usr/bin/env node",
        'process.stdout.write(`started:${process.pid}\\n`);',
        "process.on('SIGTERM', () => {",
        '  process.stdout.write(`tail:${process.pid}\\n`, () => process.exit(0));',
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    process.env.IDEVICE_ID_BIN = idBin;
    process.env.IDEVICESYSLOG_BIN = syslogBin;

    const firstStarting = startIosDeviceCapture({
      sessionId: "restart-race",
      sessionDir: temp,
      udid: "test-udid",
    });
    await assert.rejects(
      startIosDeviceCapture({
        sessionId: "restart-race",
        sessionDir: temp,
        udid: "test-udid",
      }),
      /already running/,
    );
    await assert.rejects(
      startIosDeviceCapture({
        sessionId: "different-id-same-output",
        sessionDir: temp,
        udid: "test-udid",
      }),
      /output .* already in use/,
    );
    const first = await firstStarting;
    const stopping = stopCapture("restart-race");
    await assert.rejects(
      startIosDeviceCapture({
        sessionId: "restart-race",
        sessionDir: temp,
        udid: "test-udid",
      }),
      /already running/,
    );
    assert.equal((await stopping).stopped, true);
    assert.equal(listCaptures().length, 0);

    let beforeSecond = "";
    try {
      beforeSecond = await readFile(first.outFile, "utf8");
    } catch {
      // The early-stop race may complete before the fixture writes its banner.
    }
    const startedBefore = beforeSecond.match(/^started:/gm)?.length ?? 0;
    const tailsBefore = beforeSecond.match(/^tail:/gm)?.length ?? 0;

    const second = await startIosDeviceCapture({
      sessionId: "restart-race",
      sessionDir: temp,
      udid: "test-udid",
    });
    await waitForText(second.outFile, "started:", startedBefore + 1);
    assert.equal(listCaptures()[0]?.sessionId, "restart-race");
    await stopCapture("restart-race");

    const content = await readFile(second.outFile, "utf8");
    assert.equal(content.match(/^started:/gm)?.length, startedBefore + 1);
    assert.equal(content.match(/^tail:/gm)?.length, tailsBefore + 1);
    assert.equal(listCaptures().length, 0);
  } finally {
    // Best effort in case an assertion failed after starting the fixture.
    await stopCapture("restart-race").catch(() => undefined);
    if (oldId === undefined) delete process.env.IDEVICE_ID_BIN;
    else process.env.IDEVICE_ID_BIN = oldId;
    if (oldSyslog === undefined) delete process.env.IDEVICESYSLOG_BIN;
    else process.env.IDEVICESYSLOG_BIN = oldSyslog;
    await rm(temp, { recursive: true, force: true });
  }
});

test("capture output lease rejects parent-symlink and hardlink aliases", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-output-alias-"));
  const idBin = path.join(temp, "fake-idevice-id");
  const syslogBin = path.join(temp, "fake-idevicesyslog");
  const oldId = process.env.IDEVICE_ID_BIN;
  const oldSyslog = process.env.IDEVICESYSLOG_BIN;
  const activeIds = ["real-owner", "hardlink-owner"];
  try {
    await makeExecutable(idBin, "#!/bin/sh\nprintf 'test-udid\\n'\n");
    await makeExecutable(
      syslogBin,
      [
        "#!/usr/bin/env node",
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    process.env.IDEVICE_ID_BIN = idBin;
    process.env.IDEVICESYSLOG_BIN = syslogBin;

    const realSession = path.join(temp, "real-session");
    const aliasSession = path.join(temp, "alias-session");
    await mkdir(path.join(realSession, "logs"), { recursive: true });
    await mkdir(aliasSession, { recursive: true });
    await symlink(path.join(realSession, "logs"), path.join(aliasSession, "logs"));

    await startIosDeviceCapture({
      sessionId: activeIds[0]!,
      sessionDir: realSession,
      udid: "test-udid",
    });
    await assert.rejects(
      startIosDeviceCapture({
        sessionId: "parent-symlink-alias",
        sessionDir: aliasSession,
        udid: "test-udid",
      }),
      /resolves to a file already in use|must not be a symbolic link/,
    );
    await stopCapture(activeIds[0]!);

    const firstSession = path.join(temp, "hardlink-a");
    const secondSession = path.join(temp, "hardlink-b");
    await mkdir(path.join(firstSession, "logs"), { recursive: true });
    await mkdir(path.join(secondSession, "logs"), { recursive: true });
    const firstOutput = path.join(firstSession, "logs", "ios-device-syslog.txt");
    const secondOutput = path.join(secondSession, "logs", "ios-device-syslog.txt");
    await writeFile(firstOutput, "existing\n", "utf8");
    await startIosDeviceCapture({
      sessionId: activeIds[1]!,
      sessionDir: firstSession,
      udid: "test-udid",
    });
    // Creating an alias after the first descriptor is open must not let a
    // second start attach to a pre-existing multi-link inode.
    await link(firstOutput, secondOutput);
    await assert.rejects(
      startIosDeviceCapture({
        sessionId: "hardlink-alias",
        sessionDir: secondSession,
        udid: "test-udid",
      }),
      /must not have multiple hard links/,
    );
  } finally {
    await Promise.allSettled(activeIds.map((id) => stopCapture(id)));
    if (oldId === undefined) delete process.env.IDEVICE_ID_BIN;
    else process.env.IDEVICE_ID_BIN = oldId;
    if (oldSyslog === undefined) delete process.env.IDEVICESYSLOG_BIN;
    else process.env.IDEVICESYSLOG_BIN = oldSyslog;
    await rm(temp, { recursive: true, force: true });
  }
});

test("stop_capture fails closed when the private logs directory is replaced", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-output-dir-swap-"));
  const idBin = path.join(temp, "fake-idevice-id");
  const syslogBin = path.join(temp, "fake-idevicesyslog");
  const sessionDir = path.join(temp, "session");
  const sessionId = `directory-swap-${Date.now()}`;
  const oldId = process.env.IDEVICE_ID_BIN;
  const oldSyslog = process.env.IDEVICESYSLOG_BIN;
  try {
    await makeExecutable(idBin, "#!/bin/sh\nprintf 'test-udid\\n'\n");
    await makeExecutable(
      syslogBin,
      [
        "#!/usr/bin/env node",
        "process.on('SIGTERM', () => process.exit(0));",
        "process.stdout.write('started\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    process.env.IDEVICE_ID_BIN = idBin;
    process.env.IDEVICESYSLOG_BIN = syslogBin;
    await startIosDeviceCapture({
      sessionId,
      sessionDir,
      udid: "test-udid",
    });
    await rename(path.join(sessionDir, "logs"), path.join(sessionDir, "logs-moved"));
    await mkdir(path.join(sessionDir, "logs"), { mode: 0o700 });

    await assert.rejects(
      stopCapture(sessionId),
      /private output evidence failed verification/i,
    );
    const terminal = listCaptures().find((entry) => entry.sessionId === sessionId);
    assert.equal(terminal?.status, "failed");
    assert.equal(terminal?.reason, "cleanup_failed");
  } finally {
    await stopCapture(sessionId).catch(() => undefined);
    if (oldId === undefined) delete process.env.IDEVICE_ID_BIN;
    else process.env.IDEVICE_ID_BIN = oldId;
    if (oldSyslog === undefined) delete process.env.IDEVICESYSLOG_BIN;
    else process.env.IDEVICESYSLOG_BIN = oldSyslog;
    await rm(temp, { recursive: true, force: true });
  }
});

test("unexpected non-zero exit remains observable and does not block restart", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-unexpected-exit-"));
  const idBin = path.join(temp, "fake-idevice-id");
  const syslogBin = path.join(temp, "fake-idevicesyslog");
  const oldId = process.env.IDEVICE_ID_BIN;
  const oldSyslog = process.env.IDEVICESYSLOG_BIN;
  const sessionId = "unexpected-nonzero";
  try {
    await makeExecutable(idBin, "#!/bin/sh\nprintf 'test-udid\\n'\n");
    await makeExecutable(
      syslogBin,
      [
        "#!/usr/bin/env node",
        'process.stdout.write("started\\n");',
        "setTimeout(() => {",
        '  process.stdout.write("tail-before-exit\\n", () => process.exit(7));',
        "}, 400);",
      ].join("\n"),
    );
    process.env.IDEVICE_ID_BIN = idBin;
    process.env.IDEVICESYSLOG_BIN = syslogBin;

    const started = await startIosDeviceCapture({
      sessionId,
      sessionDir: temp,
      udid: "test-udid",
    });
    const failed = await waitForCaptureStatus(sessionId, "failed");

    assert.equal(failed.status, "failed");
    assert.equal(failed.reason, "nonzero_exit");
    assert.equal(failed.exitCode, 7);
    assert.equal(failed.signal, null);
    assert.equal(typeof failed.endedAt, "number");
    assert.match(failed.error ?? "", /unexpectedly.*code=7/i);
    assert.match(await readFile(started.outFile, "utf8"), /^tail-before-exit$/m);

    const [firstStop, secondStop] = await Promise.all([
      stopCapture(sessionId),
      stopCapture(sessionId),
    ]);
    for (const result of [firstStop, secondStop]) {
      assert.equal(result.stopped, false);
      assert.equal(result.status, "failed");
      assert.equal(result.exitCode, 7);
      assert.match(result.error ?? "", /unexpectedly.*code=7/i);
    }
    assert.deepEqual(await stopCapture("never-started"), { stopped: false });

    // A retained terminal record is diagnostic only: it must not reserve the
    // session id, and a successfully registered replacement supersedes it.
    await makeExecutable(
      syslogBin,
      [
        "#!/usr/bin/env node",
        'process.stdout.write("restarted\\n");',
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const restarted = await startIosDeviceCapture({
      sessionId,
      sessionDir: temp,
      udid: "test-udid",
    });
    await waitForText(restarted.outFile, "restarted");
    const running = listCaptures().filter((item) => item.sessionId === sessionId);
    assert.equal(running.length, 1);
    assert.equal(running[0]?.status, "running");
    assert.equal((await stopCapture(sessionId)).stopped, true);
    assert.equal(listCaptures().some((item) => item.sessionId === sessionId), false);
  } finally {
    await stopCapture(sessionId).catch(() => undefined);
    if (oldId === undefined) delete process.env.IDEVICE_ID_BIN;
    else process.env.IDEVICE_ID_BIN = oldId;
    if (oldSyslog === undefined) delete process.env.IDEVICESYSLOG_BIN;
    else process.env.IDEVICESYSLOG_BIN = oldSyslog;
    await rm(temp, { recursive: true, force: true });
  }
});

test("an unrequested zero exit is still a failed long-running capture", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-unexpected-close-"));
  const idBin = path.join(temp, "fake-idevice-id");
  const syslogBin = path.join(temp, "fake-idevicesyslog");
  const oldId = process.env.IDEVICE_ID_BIN;
  const oldSyslog = process.env.IDEVICESYSLOG_BIN;
  const sessionId = "unexpected-zero";
  try {
    await makeExecutable(idBin, "#!/bin/sh\nprintf 'test-udid\\n'\n");
    await makeExecutable(
      syslogBin,
      [
        "#!/usr/bin/env node",
        'process.stdout.write("started\\n");',
        "setTimeout(() => process.exit(0), 400);",
      ].join("\n"),
    );
    process.env.IDEVICE_ID_BIN = idBin;
    process.env.IDEVICESYSLOG_BIN = syslogBin;

    await startIosDeviceCapture({
      sessionId,
      sessionDir: temp,
      udid: "test-udid",
    });
    const failed = await waitForCaptureStatus(sessionId, "failed");
    assert.equal(failed.reason, "unexpected_close");
    assert.equal(failed.exitCode, 0);
    assert.equal(failed.signal, null);

    const stopped = await stopCapture(sessionId);
    assert.equal(stopped.stopped, false);
    assert.equal(stopped.status, "failed");
    assert.equal(stopped.exitCode, 0);

    // Clear the retained record without exposing test-only state: successful
    // registration of the same session id supersedes the previous generation.
    await makeExecutable(
      syslogBin,
      [
        "#!/usr/bin/env node",
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    await startIosDeviceCapture({ sessionId, sessionDir: temp, udid: "test-udid" });
    await stopCapture(sessionId);
  } finally {
    await stopCapture(sessionId).catch(() => undefined);
    if (oldId === undefined) delete process.env.IDEVICE_ID_BIN;
    else process.env.IDEVICE_ID_BIN = oldId;
    if (oldSyslog === undefined) delete process.env.IDEVICESYSLOG_BIN;
    else process.env.IDEVICESYSLOG_BIN = oldSyslog;
    await rm(temp, { recursive: true, force: true });
  }
});

test("iOS device byte limit becomes an observable limit_reached terminal state", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-capture-limit-"));
  const idBin = path.join(temp, "fake-idevice-id");
  const syslogBin = path.join(temp, "fake-idevicesyslog");
  const oldId = process.env.IDEVICE_ID_BIN;
  const oldSyslog = process.env.IDEVICESYSLOG_BIN;
  const sessionId = "ios-device-limit";
  try {
    await makeExecutable(idBin, "#!/bin/sh\nprintf 'test-udid\\n'\n");
    await makeExecutable(
      syslogBin,
      [
        "#!/usr/bin/env node",
        "process.on('SIGTERM', () => process.exit(0));",
        "setTimeout(() => {",
        "  const chunk = 'z'.repeat(4096);",
        "  setInterval(() => process.stdout.write(chunk), 5);",
        "}, 350);",
      ].join("\n"),
    );
    process.env.IDEVICE_ID_BIN = idBin;
    process.env.IDEVICESYSLOG_BIN = syslogBin;

    const started = await startIosDeviceCapture({
      sessionId,
      sessionDir: temp,
      udid: "test-udid",
      maxBytes: 8192,
    });
    assert.equal(started.maxBytes, 8192);

    const failed = await waitForCaptureStatus(sessionId, "failed");
    assert.equal(failed.reason, "limit_reached");
    assert.match(failed.error ?? "", /maxBytes=8192/);
    assert.equal((await stat(started.outFile)).size, 8192);

    const stopped = await stopCapture(sessionId);
    assert.equal(stopped.stopped, false);
    assert.equal(stopped.reason, "limit_reached");
    assert.match(stopped.error ?? "", /maxBytes=8192/);
  } finally {
    await stopCapture(sessionId).catch(() => undefined);
    if (oldId === undefined) delete process.env.IDEVICE_ID_BIN;
    else process.env.IDEVICE_ID_BIN = oldId;
    if (oldSyslog === undefined) delete process.env.IDEVICESYSLOG_BIN;
    else process.env.IDEVICESYSLOG_BIN = oldSyslog;
    await rm(temp, { recursive: true, force: true });
  }
});

test("Android and iOS Simulator captures enforce the same total-file byte limit", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-cross-platform-limit-"));
  const fakeTool = path.join(temp, "fake-mobile-log-tool");
  const oldAdb = process.env.ADB_BIN;
  const oldXcrun = process.env.XCRUN_BIN;
  const sessionIds = ["android-limit", "simulator-limit"];
  try {
    await makeExecutable(
      fakeTool,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args[0] === 'devices') {",
        "  process.stdout.write('List of devices attached\\ntest-device device product:test model:Fixture\\n');",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'simctl' && args[1] === 'list') {",
        "  process.stdout.write(JSON.stringify({devices:{runtime:[{udid:'test-sim',name:'Fixture',state:'Booted'}]}}));",
        "  process.exit(0);",
        "}",
        "process.on('SIGTERM', () => process.exit(0));",
        "setTimeout(() => {",
        "  const chunk = 'l'.repeat(4096);",
        "  setInterval(() => process.stdout.write(chunk), 5);",
        "}, 350);",
      ].join("\n"),
    );
    process.env.ADB_BIN = fakeTool;
    process.env.XCRUN_BIN = fakeTool;

    const android = await startCapture({
      sessionId: sessionIds[0]!,
      sessionDir: path.join(temp, "android"),
      device: "test-device",
      bufferArgs: [],
      maxBytes: 8192,
    });
    assert.equal(android.maxBytes, 8192);
    const androidFailed = await waitForCaptureStatus(sessionIds[0]!, "failed");
    assert.equal(androidFailed.reason, "limit_reached");
    assert.equal((await stat(android.outFile)).size, 8192);

    const simulator = await startIosCapture({
      sessionId: sessionIds[1]!,
      sessionDir: path.join(temp, "simulator"),
      simulatorUdid: "test-sim",
      maxBytes: 8192,
    });
    assert.equal(simulator.maxBytes, 8192);
    const simulatorFailed = await waitForCaptureStatus(sessionIds[1]!, "failed");
    assert.equal(simulatorFailed.reason, "limit_reached");
    assert.equal((await stat(simulator.outFile)).size, 8192);
  } finally {
    await Promise.allSettled(sessionIds.map((id) => stopCapture(id)));
    if (oldAdb === undefined) delete process.env.ADB_BIN;
    else process.env.ADB_BIN = oldAdb;
    if (oldXcrun === undefined) delete process.env.XCRUN_BIN;
    else process.env.XCRUN_BIN = oldXcrun;
    await rm(temp, { recursive: true, force: true });
  }
});

test("a byte limit reached during startup is retained as limit_reached", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-startup-limit-"));
  const idBin = path.join(temp, "fake-idevice-id");
  const syslogBin = path.join(temp, "fake-idevicesyslog");
  const oldId = process.env.IDEVICE_ID_BIN;
  const oldSyslog = process.env.IDEVICESYSLOG_BIN;
  const sessionId = "startup-limit";
  try {
    await makeExecutable(idBin, "#!/bin/sh\nprintf 'test-udid\\n'\n");
    await makeExecutable(
      syslogBin,
      [
        "#!/usr/bin/env node",
        "process.on('SIGTERM', () => process.exit(0));",
        "process.stdout.write('s'.repeat(4096));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    process.env.IDEVICE_ID_BIN = idBin;
    process.env.IDEVICESYSLOG_BIN = syslogBin;

    const started = await startIosDeviceCapture({
      sessionId,
      sessionDir: temp,
      udid: "test-udid",
      maxBytes: 1024,
    });
    assert.equal(started.maxBytes, 1024);

    const failed = await waitForCaptureStatus(sessionId, "failed");
    assert.equal(failed.reason, "limit_reached");
    assert.match(failed.error ?? "", /maxBytes=1024/);
    assert.equal((await stat(started.outFile)).size, 1024);
    assert.equal((await stopCapture(sessionId)).reason, "limit_reached");
  } finally {
    await stopCapture(sessionId).catch(() => undefined);
    if (oldId === undefined) delete process.env.IDEVICE_ID_BIN;
    else process.env.IDEVICE_ID_BIN = oldId;
    if (oldSyslog === undefined) delete process.env.IDEVICESYSLOG_BIN;
    else process.env.IDEVICESYSLOG_BIN = oldSyslog;
    await rm(temp, { recursive: true, force: true });
  }
});

test("stop_capture does not hide a byte limit reached while flushing the child tail", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-stop-limit-race-"));
  const idBin = path.join(temp, "fake-idevice-id");
  const syslogBin = path.join(temp, "fake-idevicesyslog");
  const oldId = process.env.IDEVICE_ID_BIN;
  const oldSyslog = process.env.IDEVICESYSLOG_BIN;
  const sessionId = "stop-limit-race";
  try {
    await makeExecutable(idBin, "#!/bin/sh\nprintf 'test-udid\\n'\n");
    await makeExecutable(
      syslogBin,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('h'.repeat(4096));",
        "let stopping = false;",
        "process.on('SIGTERM', () => {",
        "  if (stopping) return;",
        "  stopping = true;",
        "  process.stdout.write('t'.repeat(8192), () => process.exit(0));",
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    process.env.IDEVICE_ID_BIN = idBin;
    process.env.IDEVICESYSLOG_BIN = syslogBin;

    const started = await startIosDeviceCapture({
      sessionId,
      sessionDir: temp,
      udid: "test-udid",
      maxBytes: 8192,
    });
    await waitForText(started.outFile, "hhh");

    const stopped = await stopCapture(sessionId);
    assert.equal(stopped.stopped, false);
    assert.equal(stopped.reason, "limit_reached");
    assert.match(stopped.error ?? "", /maxBytes=8192/);
    assert.equal((await stat(started.outFile)).size, 8192);
  } finally {
    await stopCapture(sessionId).catch(() => undefined);
    if (oldId === undefined) delete process.env.IDEVICE_ID_BIN;
    else process.env.IDEVICE_ID_BIN = oldId;
    if (oldSyslog === undefined) delete process.env.IDEVICESYSLOG_BIN;
    else process.env.IDEVICESYSLOG_BIN = oldSyslog;
    await rm(temp, { recursive: true, force: true });
  }
});

test("capture manager bounds concurrent processes", { timeout: 10_000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-concurrency-limit-"));
  const idBin = path.join(temp, "fake-idevice-id");
  const syslogBin = path.join(temp, "fake-idevicesyslog");
  const oldId = process.env.IDEVICE_ID_BIN;
  const oldSyslog = process.env.IDEVICESYSLOG_BIN;
  const sessionIds = Array.from({ length: 9 }, (_, index) => `concurrency-${index}`);
  try {
    await makeExecutable(idBin, "#!/bin/sh\nprintf 'test-udid\\n'\n");
    await makeExecutable(
      syslogBin,
      [
        "#!/usr/bin/env node",
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    process.env.IDEVICE_ID_BIN = idBin;
    process.env.IDEVICESYSLOG_BIN = syslogBin;

    await Promise.all(
      sessionIds.slice(0, 8).map((sessionId) =>
        startIosDeviceCapture({
          sessionId,
          sessionDir: path.join(temp, sessionId),
          udid: "test-udid",
        }),
      ),
    );
    await assert.rejects(
      startIosDeviceCapture({
        sessionId: sessionIds[8]!,
        sessionDir: path.join(temp, sessionIds[8]!),
        udid: "test-udid",
      }),
      /concurrency limit reached \(8\)/,
    );
  } finally {
    await Promise.allSettled(sessionIds.map((sessionId) => stopCapture(sessionId)));
    if (oldId === undefined) delete process.env.IDEVICE_ID_BIN;
    else process.env.IDEVICE_ID_BIN = oldId;
    if (oldSyslog === undefined) delete process.env.IDEVICESYSLOG_BIN;
    else process.env.IDEVICESYSLOG_BIN = oldSyslog;
    await rm(temp, { recursive: true, force: true });
  }
});

test("stop_capture cancels a pending device lookup instead of allowing a late capture", { timeout: 10_000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-pending-stop-"));
  const idBin = path.join(temp, "fake-idevice-id");
  const pidFile = path.join(temp, "lookup-child.pid");
  const sessionDir = path.join(temp, "session");
  const oldId = process.env.IDEVICE_ID_BIN;
  const oldPidFile = process.env.PENDING_STOP_PID_FILE;
  const sessionId = "pending-stop";
  try {
    await makeExecutable(
      idBin,
      [
        "#!/usr/bin/env node",
        'require("node:fs").writeFileSync(process.env.PENDING_STOP_PID_FILE, String(process.pid));',
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    process.env.IDEVICE_ID_BIN = idBin;
    process.env.PENDING_STOP_PID_FILE = pidFile;

    const startOutcome = startIosDeviceCapture({
      sessionId,
      sessionDir,
      udid: "test-udid",
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const lookupPid = Number((await waitForFile(pidFile)).trim());

    const stopped = await stopCapture(sessionId);
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.outFile, path.join(sessionDir, "logs", "ios-device-syslog.txt"));
    const outcome = await startOutcome;
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.match(String(outcome.error), /aborted|cancelled/i);
    }
    assert.equal(listCaptures().some((item) => item.sessionId === sessionId), false);
    await waitForProcessGone(lookupPid);
  } finally {
    await stopCapture(sessionId).catch(() => undefined);
    if (oldId === undefined) delete process.env.IDEVICE_ID_BIN;
    else process.env.IDEVICE_ID_BIN = oldId;
    if (oldPidFile === undefined) delete process.env.PENDING_STOP_PID_FILE;
    else process.env.PENDING_STOP_PID_FILE = oldPidFile;
    await rm(temp, { recursive: true, force: true });
  }
});

test("stdin EOF reaps a child spawned before capture registration", { timeout: 10_000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-pending-eof-"));
  const idBin = path.join(temp, "fake-idevice-id");
  const syslogBin = path.join(temp, "fake-idevicesyslog");
  const pidFile = path.join(temp, "pending-child.pid");
  const sessionDir = path.join(temp, "session");
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined,
    ),
  );
  let serverProcess: ChildProcess | undefined;
  let client: Client | undefined;
  try {
    await makeExecutable(idBin, "#!/bin/sh\nprintf 'test-udid\\n'\n");
    await makeExecutable(
      syslogBin,
      [
        "#!/usr/bin/env node",
        'require("node:fs").writeFileSync(process.env.PENDING_CHILD_PID_FILE, String(process.pid));',
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", path.join(sourceDir, "index.ts")],
      env: {
        ...environment,
        IDEVICE_ID_BIN: idBin,
        IDEVICESYSLOG_BIN: syslogBin,
        PENDING_CHILD_PID_FILE: pidFile,
      },
      stderr: "pipe",
    });
    client = new Client({ name: "pending-eof-test", version: "1.0.0" });
    await client.connect(transport);
    const startCall = client.callTool({
      name: "ios_device_start_capture",
      arguments: {
        session_id: "pending-eof",
        session_dir: sessionDir,
        device: "test-udid",
      },
    }).catch(() => undefined);
    const capturePid = Number((await waitForFile(pidFile)).trim());
    assert.equal(Number.isInteger(capturePid), true);

    serverProcess = (transport as unknown as { _process?: ChildProcess })._process;
    assert.ok(serverProcess?.stdin);
    const serverClosed = new Promise<void>((resolve) => {
      serverProcess!.once("close", () => resolve());
    });
    serverProcess.stdin.end();
    await Promise.race([
      serverClosed,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("log-mcp did not exit after pending-start EOF")),
          5_000,
        );
        timer.unref();
      }),
    ]);
    await startCall;
    assert.throws(() => process.kill(capturePid, 0), /ESRCH/);
  } finally {
    if (
      serverProcess &&
      serverProcess.exitCode === null &&
      serverProcess.signalCode === null
    ) {
      serverProcess.kill("SIGKILL");
    }
    await client?.close().catch(() => undefined);
    await rm(temp, { recursive: true, force: true });
  }
});

test("stdin EOF aborts a pending device lookup within the shutdown deadline", { timeout: 10_000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-lookup-eof-"));
  const idBin = path.join(temp, "fake-idevice-id");
  const pidFile = path.join(temp, "lookup-child.pid");
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined,
    ),
  );
  let serverProcess: ChildProcess | undefined;
  let client: Client | undefined;
  try {
    await makeExecutable(
      idBin,
      [
        "#!/usr/bin/env node",
        'require("node:fs").writeFileSync(process.env.LOOKUP_CHILD_PID_FILE, String(process.pid));',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", path.join(sourceDir, "index.ts")],
      env: {
        ...environment,
        IDEVICE_ID_BIN: idBin,
        LOOKUP_CHILD_PID_FILE: pidFile,
      },
      stderr: "pipe",
    });
    client = new Client({ name: "lookup-eof-test", version: "1.0.0" });
    await client.connect(transport);
    const startCall = client.callTool({
      name: "ios_device_start_capture",
      arguments: {
        session_id: "lookup-eof",
        session_dir: path.join(temp, "session"),
        device: "test-udid",
      },
    }).catch(() => undefined);
    const lookupPid = Number((await waitForFile(pidFile)).trim());

    serverProcess = (transport as unknown as { _process?: ChildProcess })._process;
    assert.ok(serverProcess?.stdin);
    const serverClosed = new Promise<void>((resolve) => {
      serverProcess!.once("close", () => resolve());
    });
    serverProcess.stdin.end();
    await Promise.race([
      serverClosed,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("log-mcp did not abort pending lookup after EOF")),
          5_000,
        );
        timer.unref();
      }),
    ]);
    await startCall;
    assert.throws(() => process.kill(lookupPid, 0), /ESRCH/);
  } finally {
    if (
      serverProcess &&
      serverProcess.exitCode === null &&
      serverProcess.signalCode === null
    ) {
      serverProcess.kill("SIGKILL");
    }
    await client?.close().catch(() => undefined);
    await rm(temp, { recursive: true, force: true });
  }
});

test("stdin EOF gracefully stops and reaps background captures", { timeout: 10_000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-stdin-eof-"));
  const idBin = path.join(temp, "fake-idevice-id");
  const syslogBin = path.join(temp, "fake-idevicesyslog");
  const sessionDir = path.join(temp, "session");
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return entry[1] !== undefined;
    }),
  );
  let serverProcess: ChildProcess | undefined;
  let client: Client | undefined;
  try {
    await makeExecutable(idBin, "#!/bin/sh\nprintf 'test-udid\\n'\n");
    await makeExecutable(
      syslogBin,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(`started:${process.pid}\\n`);",
        "process.on('SIGTERM', () => {",
        "  process.stdout.write('stopped-on-eof\\n', () => process.exit(0));",
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", path.join(sourceDir, "index.ts")],
      env: {
        ...environment,
        IDEVICE_ID_BIN: idBin,
        IDEVICESYSLOG_BIN: syslogBin,
      },
      stderr: "pipe",
    });
    client = new Client({ name: "stdin-eof-test", version: "1.0.0" });
    await client.connect(transport);
    const started = await client.callTool({
      name: "ios_device_start_capture",
      arguments: {
        session_id: "stdin-eof",
        session_dir: sessionDir,
        device: "test-udid",
        max_bytes: 1024 * 1024,
      },
    });
    assert.notEqual(started.isError, true);

    const outFile = path.join(sessionDir, "logs", "ios-device-syslog.txt");
    await waitForText(outFile, "started:");
    const capturePid = Number(
      (await readFile(outFile, "utf8")).match(/started:(\d+)/)?.[1],
    );
    assert.equal(Number.isInteger(capturePid), true);

    serverProcess = (
      transport as unknown as { _process?: ChildProcess }
    )._process;
    assert.ok(serverProcess?.stdin);
    const serverClosed = new Promise<void>((resolve) => {
      serverProcess!.once("close", () => resolve());
    });
    serverProcess.stdin.end();
    await Promise.race([
      serverClosed,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("log-mcp did not exit after stdin EOF")),
          5_000,
        );
        timer.unref();
      }),
    ]);

    assert.match(await readFile(outFile, "utf8"), /^stopped-on-eof$/m);
    assert.throws(() => process.kill(capturePid, 0), /ESRCH/);
  } finally {
    if (
      serverProcess &&
      serverProcess.exitCode === null &&
      serverProcess.signalCode === null
    ) {
      serverProcess.kill("SIGKILL");
    }
    await client?.close().catch(() => undefined);
    await rm(temp, { recursive: true, force: true });
  }
});
