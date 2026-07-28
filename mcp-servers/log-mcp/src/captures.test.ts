import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";

import {
  listCaptures,
  startIosDeviceCapture,
  stopCapture,
} from "./captures.js";
import { pipeCaptureToFile } from "./file-capture.js";

async function makeExecutable(file: string, source: string): Promise<void> {
  await writeFile(file, source, "utf8");
  await chmod(file, 0o755);
}

async function waitForText(file: string, text: string, occurrences = 1): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
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

async function waitForCaptureStatus(sessionId: string, status: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
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
    const stopping = stopCapture("restart-race");
    await assert.rejects(
      startIosDeviceCapture({
        sessionId: "restart-race",
        sessionDir: temp,
        udid: "test-udid",
      }),
      /already running/,
    );
    const first = await firstStarting;
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
