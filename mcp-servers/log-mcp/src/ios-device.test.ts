// Unit tests for the pure helpers behind ios_pull_device_crashes.
// These guard the since_minutes filtering — the logic that decides whether a
// real crash is surfaced or dropped — without needing a physical device.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";

import {
  DEFAULT_IOS_DEVICE_SYSLOG_MAX_BYTES,
  IosDeviceError,
  MAX_IOS_DEVICE_SYSLOG_MAX_BYTES,
  MAX_DEVICE_CRASH_REPORT_PATH_LENGTH,
  MAX_DEVICE_CRASH_REPORTS,
  MAX_DEVICE_CRASH_STAGING_BYTES,
  MAX_DEVICE_CRASH_STAGING_ENTRIES,
  parseCopiedReports,
  parseReportTimestamp,
  filterReportsSince,
  pullDeviceCrashes,
  resolveReportPath,
  scanCrashStaging,
  spawnDeviceSyslog,
  validateCrashReportFilter,
} from "./ios-device.js";

const execFileAsync = promisify(execFile);

test("parseCopiedReports extracts paths from 'Copy:' lines, stripping leading slash", () => {
  const stdout = [
    "DeviceName ...",
    "Copy: /Runner-2025-04-27-173725.ips",
    "Copy: /ExcUserFault_Zalo-2025-04-22-141141.ips",
    "Copy:/no-space-2025-01-01-000000.ips",
    "Done.",
  ].join("\n");
  assert.deepEqual(parseCopiedReports(stdout), [
    "Runner-2025-04-27-173725.ips",
    "ExcUserFault_Zalo-2025-04-22-141141.ips",
    "no-space-2025-01-01-000000.ips",
  ]);
});

test("parseCopiedReports returns [] when nothing was copied", () => {
  assert.deepEqual(parseCopiedReports("DeviceName foo\nNothing to copy\n"), []);
});

test("parseCopiedReports accepts Link, Copy, and Move report lines", () => {
  assert.deepEqual(
    parseCopiedReports(
      [
        "Link: /DiagnosticLogs/Runner-2025-04-27-173724.ips",
        "Move: /Runner-2025-04-27-173725.ips",
        "Copy: /Retired/Other-2025-04-27-173726.ips",
      ].join("\n"),
    ),
    [
      "DiagnosticLogs/Runner-2025-04-27-173724.ips",
      "Runner-2025-04-27-173725.ips",
      "Retired/Other-2025-04-27-173726.ips",
    ],
  );
});

test("parseCopiedReports deduplicates and enforces count/path bounds", () => {
  assert.deepEqual(
    parseCopiedReports("Copy: /Same.ips\nLink: /Same.ips\n"),
    ["Same.ips"],
  );
  assert.throws(
    () => parseCopiedReports(`Copy: /${"x".repeat(MAX_DEVICE_CRASH_REPORT_PATH_LENGTH + 1)}\n`),
    /path longer than/i,
  );
  const tooMany = Array.from(
    { length: MAX_DEVICE_CRASH_REPORTS + 1 },
    (_, index) => `Copy: /${index}.ips`,
  ).join("\n");
  assert.throws(() => parseCopiedReports(tooMany), /more than .* report paths/i);
});

test("paths parsed from Link lines still require output-directory containment", () => {
  const [linkedPath] = parseCopiedReports("Link: /../../outside.ips\n");
  assert.equal(linkedPath, "../../outside.ips");
  assert.throws(
    () => resolveReportPath("/tmp/crashes", linkedPath!),
    /Unsafe crash-report path/,
  );
});

test("parseReportTimestamp parses the embedded wall-clock stamp", () => {
  const ts = parseReportTimestamp("Runner-2025-04-27-173725.ips");
  assert.notEqual(ts, null);
  // Local time 2025-04-27 17:37:25 — compare via the same local constructor.
  assert.equal(ts, new Date(2025, 3, 27, 17, 37, 25).getTime());
});

test("parseReportTimestamp tolerates prefixes/suffixes around the stamp", () => {
  assert.notEqual(
    parseReportTimestamp("ExcUserFault_Zalo-2025-04-22-141141.ips"),
    null,
  );
  assert.notEqual(
    parseReportTimestamp("Analytics-Journal-90Day-2025-05-18-080418.ips.ca"),
    null,
  );
});

test("parseReportTimestamp returns null when there is no stamp", () => {
  assert.equal(parseReportTimestamp("log-bb-stats.plist"), null);
  assert.equal(parseReportTimestamp("README"), null);
});

test("parseReportTimestamp rejects normalized/invalid calendar values", () => {
  assert.equal(parseReportTimestamp("App-2025-02-29-120000.ips"), null);
  assert.equal(
    parseReportTimestamp("App-2025-02-29-120000.ips", "Asia/Shanghai"),
    null,
  );
  assert.equal(parseReportTimestamp("App-2025-13-01-120000.ips"), null);
  assert.equal(parseReportTimestamp("App-2025-01-01-240000.ips"), null);
  assert.notEqual(parseReportTimestamp("App-2024-02-29-235959.ips"), null);
});

test("parseReportTimestamp can interpret the device IANA time zone", () => {
  assert.equal(
    parseReportTimestamp("Runner-2025-04-27-173725.ips", "Asia/Shanghai"),
    Date.parse("2025-04-27T09:37:25Z"),
  );
  assert.equal(
    parseReportTimestamp("Runner-2025-04-27-173725.ips", "Not/AZone"),
    null,
  );
});

test("DST rollback ambiguity uses the latest valid instant to avoid false expiry", () => {
  const filename = "App-2025-11-02-013000.ips";
  assert.equal(
    parseReportTimestamp(filename, "America/New_York"),
    Date.parse("2025-11-02T06:30:00Z"),
  );
  assert.deepEqual(
    filterReportsSince(
      [filename],
      10,
      Date.parse("2025-11-02T06:35:00Z"),
      { timeZone: "America/New_York" },
    ),
    [filename],
  );
});

test("filterReportsSince keeps only reports within the window", () => {
  const now = new Date(2025, 3, 27, 18, 0, 0).getTime(); // 18:00
  const files = [
    "App-2025-04-27-175500.ips", // 5 min ago — keep
    "App-2025-04-27-173000.ips", // 30 min ago — drop (window 10)
    "App-2025-04-20-120000.ips", // days ago — drop
  ];
  assert.deepEqual(filterReportsSince(files, 10, now), [
    "App-2025-04-27-175500.ips",
  ]);
});

test("filterReportsSince keeps unparseable names (never silently drop a crash)", () => {
  const now = new Date(2025, 3, 27, 18, 0, 0).getTime();
  const files = [
    "weird-name-no-stamp.ips", // unparseable — keep
    "App-2025-04-20-120000.ips", // old — drop
  ];
  assert.deepEqual(filterReportsSince(files, 10, now), [
    "weird-name-no-stamp.ips",
  ]);
});

test("filterReportsSince includes reports exactly at the cutoff boundary", () => {
  const now = new Date(2025, 3, 27, 18, 0, 0).getTime();
  const files = ["App-2025-04-27-175000.ips"]; // exactly 10 min ago
  assert.deepEqual(filterReportsSince(files, 10, now), [
    "App-2025-04-27-175000.ips",
  ]);
});

test("filterReportsSince validates its numeric boundary inputs", () => {
  assert.throws(() => filterReportsSince([], 0), /positive integer/);
  assert.throws(() => filterReportsSince([], 1.5), /positive integer/);
  assert.throws(() => filterReportsSince([], 1, Number.NaN), /finite/);
});

test("filterReportsSince uses an explicit device zone without host-zone skew", () => {
  const now = Date.parse("2025-04-27T10:00:00Z");
  const files = [
    "App-2025-04-27-175500.ips", // 09:55Z in Shanghai — keep
    "App-2025-04-27-170000.ips", // 09:00Z — drop
  ];
  assert.deepEqual(
    filterReportsSince(files, 10, now, { timeZone: "Asia/Shanghai" }),
    ["App-2025-04-27-175500.ips"],
  );
});

test("unknown-zone mode widens conservatively instead of missing timezone-shifted reports", () => {
  const now = Date.parse("2025-04-27T10:00:00Z");
  assert.deepEqual(
    filterReportsSince(
      [
        "App-2025-04-26-210500.ips", // may be recent in a UTC-12 zone
        "App-2025-04-25-000000.ips", // too old even with the allowance
      ],
      10,
      now,
      { conservativeUnknownTimeZone: true },
    ),
    ["App-2025-04-26-210500.ips"],
  );
});

test("resolveReportPath accepts nested reports and rejects escapes", () => {
  assert.equal(
    resolveReportPath("/tmp/crashes", "Retired/App-2025-01-01-000000.ips"),
    path.resolve("/tmp/crashes/Retired/App-2025-01-01-000000.ips"),
  );
  assert.throws(() => resolveReportPath("relative", "App.ips"), /absolute/);
  assert.throws(() => resolveReportPath("/tmp/crashes", "../escape.ips"), /Unsafe/);
  assert.throws(() => resolveReportPath("/tmp/crashes", "/escape.ips"), /Unsafe/);
  assert.throws(() => resolveReportPath("/tmp/crashes", "..\\escape.ips"), /Unsafe/);
});

test("validateCrashReportFilter trims read-only filters and rejects all removal", () => {
  assert.equal(validateCrashReportFilter(undefined), undefined);
  assert.equal(validateCrashReportFilter("  MyApp\t"), "MyApp");
  assert.throws(
    () => validateCrashReportFilter(" \t\n "),
    /non-empty, non-whitespace filename substring/,
  );
  assert.throws(
    () => validateCrashReportFilter(undefined, { removingFromDevice: true }),
    /remove_from_device=true is not supported.*read-only.*always keeps/,
  );
  assert.throws(
    () => validateCrashReportFilter("MyApp", { removingFromDevice: true }),
    /remove_from_device=true is not supported.*read-only.*always keeps/,
  );
});

test("pullDeviceCrashes rejects every destructive request before device I/O", async () => {
  await assert.rejects(
    pullDeviceCrashes({
      outDir: "/tmp/crashes",
      keepOnDevice: false,
    }),
    /keepOnDevice=false is not supported.*read-only.*always keeps/,
  );
  await assert.rejects(
    pullDeviceCrashes({
      outDir: "/tmp/crashes",
      keepOnDevice: false,
      filter: "MyApp",
    }),
    /keepOnDevice=false is not supported.*read-only.*always keeps/,
  );
  await assert.rejects(
    pullDeviceCrashes({
      outDir: "/tmp/crashes",
      keepOnDevice: false,
      filter: "MyApp",
      sinceMinutes: 5,
    }),
    /keepOnDevice=false is not supported.*read-only.*always keeps/,
  );
});

test("pullDeviceCrashes validates read-only arguments before device I/O", async () => {
  await assert.rejects(
    pullDeviceCrashes({ outDir: "relative/crashes" }),
    /outDir must be an absolute path/,
  );
  await assert.rejects(
    pullDeviceCrashes({ outDir: "/tmp/crashes", sinceMinutes: -1 }),
    /positive integer/,
  );
  await assert.rejects(
    pullDeviceCrashes({ outDir: "/tmp/crashes", filter: " \n " }),
    /non-empty, non-whitespace filename substring/,
  );
});

test("ios_pull_device_crashes tool rejects all destructive calls", async () => {
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return entry[1] !== undefined;
    }),
  );
  // If validation regresses, this binary makes the accidental device-I/O path
  // fail with a different message, so the assertion below cannot pass falsely.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.join(sourceDir, "index.ts")],
    env: {
      ...environment,
      IDEVICE_ID_BIN: "/usr/bin/false",
      IDEVICECRASHREPORT_BIN: "/usr/bin/false",
    },
  });
  const client = new Client({ name: "ios-removal-guard-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "ios_pull_device_crashes",
      arguments: {
        out_dir: path.join(os.tmpdir(), "ios-removal-guard-tool-test"),
        remove_from_device: true,
      },
    });
    const text = (result.content as Array<{ type: string; text?: string }>)
      .map((item) => item.text ?? "")
      .join("\n");
    assert.equal(result.isError, true);
    assert.match(
      text,
      /remove_from_device=true is not supported.*read-only.*always keeps/,
    );

    const filteredResult = await client.callTool({
      name: "ios_pull_device_crashes",
      arguments: {
        out_dir: path.join(os.tmpdir(), "ios-removal-guard-tool-test"),
        filter: "App",
        remove_from_device: true,
      },
    });
    const filteredText = (
      filteredResult.content as Array<{ type: string; text?: string }>
    )
      .map((item) => item.text ?? "")
      .join("\n");
    assert.equal(filteredResult.isError, true);
    assert.match(
      filteredText,
      /remove_from_device=true is not supported.*read-only.*always keeps/,
    );
  } finally {
    await client.close();
  }
});

async function makeExecutable(file: string, source: string): Promise<void> {
  await writeFile(file, source, "utf8");
  await chmod(file, 0o755);
}

test("spawnDeviceSyslog rejects existing non-regular output paths", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-ios-output-type-"));
  const target = path.join(temp, "target.log");
  const linkedOutput = path.join(temp, "linked.log");
  const fifoOutput = path.join(temp, "capture.fifo");
  try {
    await writeFile(target, "existing", "utf8");
    await symlink(target, linkedOutput);
    await execFileAsync("mkfifo", [fifoOutput]);

    await assert.rejects(
      spawnDeviceSyslog({
        udid: "test-udid",
        outFilePath: linkedOutput,
      }),
      /Refusing unsafe iOS syslog output.*symlink|ELOOP/i,
    );
    await assert.rejects(
      spawnDeviceSyslog({
        udid: "test-udid",
        outFilePath: temp,
      }),
      /Refusing unsafe iOS syslog output|EISDIR/i,
    );
    const startedAt = Date.now();
    await assert.rejects(
      spawnDeviceSyslog({
        udid: "test-udid",
        outFilePath: fifoOutput,
      }),
      /Refusing unsafe iOS syslog output|ENXIO|regular file/i,
    );
    assert.ok(Date.now() - startedAt < 1_000, "FIFO validation must not block waiting for a reader");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("spawnDeviceSyslog waits for startup errors and flushes on close", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-ios-device-"));
  const idBin = path.join(temp, "fake-idevice-id");
  const syslogBin = path.join(temp, "fake-idevicesyslog");
  const outFile = path.join(temp, "capture.log");
  const oldId = process.env.IDEVICE_ID_BIN;
  const oldSyslog = process.env.IDEVICESYSLOG_BIN;
  try {
    await assert.rejects(
      spawnDeviceSyslog({
        udid: "test-udid",
        outFilePath: outFile,
        processMatch: ["Bad|Name"],
      }),
      /without '\|'/,
    );
    await makeExecutable(idBin, "#!/bin/sh\nprintf 'test-udid\\n'\n");
    await makeExecutable(
      syslogBin,
      [
        "#!/usr/bin/env node",
        'process.stdout.write(`args:${JSON.stringify(process.argv.slice(2))}\\n`);',
        'process.stdout.write("head\\n");',
        'process.stderr.write("stderr\\n");',
        "process.on('SIGTERM', () => {",
        '  process.stdout.write("tail\\n", () => process.exit(0));',
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    process.env.IDEVICE_ID_BIN = idBin;
    process.env.IDEVICESYSLOG_BIN = path.join(temp, "missing-syslog");

    await assert.rejects(
      spawnDeviceSyslog({ udid: "test-udid", outFilePath: outFile }),
      (error: unknown) =>
        error instanceof IosDeviceError && /Failed to start/.test(error.message),
    );

    process.env.IDEVICESYSLOG_BIN = syslogBin;
    await assert.rejects(
      spawnDeviceSyslog({
        udid: "test-udid",
        outFilePath: path.join(temp, "missing-parent", "capture.log"),
      }),
      /ENOENT/,
    );

    // A successfully exec'ed native command can still fail immediately. This
    // must be reported by start_capture rather than as a short-lived success.
    process.env.IDEVICESYSLOG_BIN = "/usr/bin/false";
    await assert.rejects(
      spawnDeviceSyslog({ udid: "test-udid", outFilePath: outFile }),
      /exited during startup \(code=1/,
    );

    process.env.IDEVICESYSLOG_BIN = syslogBin;
    const capture = await spawnDeviceSyslog({
      udid: "test-udid",
      outFilePath: outFile,
      processMatch: ["MyApp", "Helper", "MyApp"],
    });
    assert.equal(capture.udid, "test-udid");
    assert.equal(capture.maxBytes, DEFAULT_IOS_DEVICE_SYSLOG_MAX_BYTES);
    // The OS-level spawn event precedes execution of the fixture's JS body.
    // Poll rather than relying on a timing-sensitive fixed sleep on loaded CI.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if ((await readFile(outFile, "utf8")).includes("head")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const timeoutCountBefore = process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "Timeout").length;
    await capture.close();
    // Idempotent close must not race a second kill/flush.
    await capture.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const timeoutCountAfter = process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "Timeout").length;
    assert.ok(
      timeoutCountAfter <= timeoutCountBefore,
      `close leaked a referenced timeout (${timeoutCountBefore} -> ${timeoutCountAfter})`,
    );
    const content = await readFile(outFile, "utf8");
    assert.match(content, /args:\["-u","test-udid","-p","MyApp\|Helper"\]/);
    assert.match(content, /head/);
    assert.match(content, /stderr/);
    assert.match(content, /tail/);
  } finally {
    if (oldId === undefined) delete process.env.IDEVICE_ID_BIN;
    else process.env.IDEVICE_ID_BIN = oldId;
    if (oldSyslog === undefined) delete process.env.IDEVICESYSLOG_BIN;
    else process.env.IDEVICESYSLOG_BIN = oldSyslog;
    await rm(temp, { recursive: true, force: true });
  }
});

test("spawnDeviceSyslog stops at maxBytes and retains the termination reason", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-ios-device-limit-"));
  const idBin = path.join(temp, "fake-idevice-id");
  const syslogBin = path.join(temp, "fake-idevicesyslog");
  const outFile = path.join(temp, "capture.log");
  const oldId = process.env.IDEVICE_ID_BIN;
  const oldSyslog = process.env.IDEVICESYSLOG_BIN;
  let capture: Awaited<ReturnType<typeof spawnDeviceSyslog>> | undefined;
  try {
    await assert.rejects(
      spawnDeviceSyslog({
        udid: "test-udid",
        outFilePath: outFile,
        maxBytes: 0,
      }),
      /maxBytes must be a positive safe integer/,
    );
    await assert.rejects(
      spawnDeviceSyslog({
        udid: "test-udid",
        outFilePath: outFile,
        maxBytes: MAX_IOS_DEVICE_SYSLOG_MAX_BYTES + 1,
      }),
      /no greater than/,
    );
    await makeExecutable(idBin, "#!/bin/sh\nprintf 'test-udid\\n'\n");
    await makeExecutable(
      syslogBin,
      [
        "#!/usr/bin/env node",
        "process.on('SIGTERM', () => process.exit(0));",
        "setTimeout(() => {",
        "  const chunk = 'x'.repeat(4096);",
        "  setInterval(() => process.stdout.write(chunk), 5);",
        "}, 350);",
      ].join("\n"),
    );
    process.env.IDEVICE_ID_BIN = idBin;
    process.env.IDEVICESYSLOG_BIN = syslogBin;
    await writeFile(outFile, "p".repeat(4096), "utf8");

    let observedError = "";
    capture = await spawnDeviceSyslog({
      udid: "test-udid",
      outFilePath: outFile,
      maxBytes: 8192,
      onError: (error) => {
        observedError = error.message;
      },
    });
    const closed =
      capture.process.exitCode !== null || capture.process.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => capture!.process.once("close", () => resolve()));
    await closed;
    await capture.close();

    assert.equal(capture.maxBytes, 8192);
    assert.equal(capture.didReachLimit(), true);
    assert.equal((await stat(outFile)).size, 8192);
    assert.match(observedError, /reached maxBytes=8192/);
    assert.match(capture.getTerminationError() ?? "", /reached maxBytes=8192/);

    await assert.rejects(
      spawnDeviceSyslog({
        udid: "test-udid",
        outFilePath: outFile,
        maxBytes: 8192,
      }),
      /already contains 8192 bytes.*maxBytes=8192/,
    );
    assert.equal((await stat(outFile)).size, 8192);
  } finally {
    await capture?.close().catch(() => undefined);
    if (oldId === undefined) delete process.env.IDEVICE_ID_BIN;
    else process.env.IDEVICE_ID_BIN = oldId;
    if (oldSyslog === undefined) delete process.env.IDEVICESYSLOG_BIN;
    else process.env.IDEVICESYSLOG_BIN = oldSyslog;
    await rm(temp, { recursive: true, force: true });
  }
});

test("ios_device_start_capture exposes max_bytes and a limit_reached terminal state", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-ios-tool-limit-"));
  const idBin = path.join(temp, "fake-idevice-id");
  const syslogBin = path.join(temp, "fake-idevicesyslog");
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return entry[1] !== undefined;
    }),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.join(sourceDir, "index.ts")],
    env: {
      ...environment,
      IDEVICE_ID_BIN: idBin,
      IDEVICESYSLOG_BIN: syslogBin,
    },
  });
  const client = new Client({ name: "ios-syslog-limit-test", version: "1.0.0" });
  const decode = (result: Awaited<ReturnType<typeof client.callTool>>): unknown => {
    const item = (result.content as Array<{ type: string; text?: string }>).find(
      (entry) => entry.type === "text",
    );
    return JSON.parse(item?.text ?? "null");
  };
  try {
    await makeExecutable(idBin, "#!/bin/sh\nprintf 'test-udid\\n'\n");
    await makeExecutable(
      syslogBin,
      [
        "#!/usr/bin/env node",
        "process.on('SIGTERM', () => process.exit(0));",
        "setTimeout(() => {",
        "  const chunk = 'm'.repeat(4096);",
        "  setInterval(() => process.stdout.write(chunk), 5);",
        "}, 350);",
      ].join("\n"),
    );
    await client.connect(transport);
    const tooLarge = await client.callTool({
      name: "ios_device_start_capture",
      arguments: {
        session_id: `tool-too-large-${Date.now()}`,
        session_dir: path.join(temp, "too-large"),
        device: "test-udid",
        max_bytes: MAX_IOS_DEVICE_SYSLOG_MAX_BYTES + 1,
      },
    });
    assert.equal(tooLarge.isError, true);

    const defaultId = `tool-default-${Date.now()}`;
    const defaultStarted = decode(
      await client.callTool({
        name: "ios_device_start_capture",
        arguments: {
          session_id: defaultId,
          session_dir: path.join(temp, "default"),
          device: "test-udid",
        },
      }),
    ) as { ok: boolean; max_bytes: number };
    assert.equal(defaultStarted.ok, true);
    assert.equal(defaultStarted.max_bytes, DEFAULT_IOS_DEVICE_SYSLOG_MAX_BYTES);
    const defaultStopped = decode(
      await client.callTool({
        name: "stop_capture",
        arguments: { session_id: defaultId },
      }),
    ) as { stopped: boolean };
    assert.equal(defaultStopped.stopped, true);

    const sessionId = `tool-limit-${Date.now()}`;
    const started = decode(
      await client.callTool({
        name: "ios_device_start_capture",
        arguments: {
          session_id: sessionId,
          session_dir: path.join(temp, "limited"),
          device: "test-udid",
          max_bytes: 8192,
        },
      }),
    ) as { ok: boolean; max_bytes: number };
    assert.equal(started.ok, true);
    assert.equal(started.max_bytes, 8192);

    let failed: { status?: string; reason?: string; error?: string } | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const captures = decode(
        await client.callTool({ name: "list_captures", arguments: {} }),
      ) as Array<{ sessionId: string; status?: string; reason?: string; error?: string }>;
      failed = captures.find((entry) => entry.sessionId === sessionId);
      if (failed?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.reason, "limit_reached");
    assert.match(failed?.error ?? "", /maxBytes=8192/);

    const stopped = decode(
      await client.callTool({
        name: "stop_capture",
        arguments: { session_id: sessionId },
      }),
    ) as { stopped: boolean; status?: string; reason?: string };
    assert.equal(stopped.stopped, false);
    assert.equal(stopped.status, "failed");
    assert.equal(stopped.reason, "limit_reached");
  } finally {
    await client.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("pullDeviceCrashes is always read-only and resolves Link reports", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-ios-pull-"));
  const idBin = path.join(temp, "fake-idevice-id");
  const crashBin = path.join(temp, "fake-idevicecrashreport");
  const argsFile = path.join(temp, "args.txt");
  const keepOutDir = path.join(temp, "keep-reports");
  const oldId = process.env.IDEVICE_ID_BIN;
  const oldCrash = process.env.IDEVICECRASHREPORT_BIN;
  const oldArgsFile = process.env.CRASHREPORT_ARGS_FILE;
  try {
    await makeExecutable(idBin, "#!/bin/sh\nprintf 'test-udid\\n'\n");
    await makeExecutable(
      crashBin,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        "const args = process.argv.slice(2);",
        'fs.writeFileSync(process.env.CRASHREPORT_ARGS_FILE, args.join("\\n") + "\\n");',
        "const out = args.at(-1);",
        'fs.mkdirSync(path.join(out, "Retired"), { recursive: true });',
        'const linked = path.join(out, "Retired", "App-2025-04-27-173724.ips");',
        'fs.writeFileSync(linked, "linked report\\n");',
        'fs.writeFileSync(path.join(out, "App-2025-04-27-173725.ips"), "copied report\\n");',
        'process.stdout.write("Link: /Retired/App-2025-04-27-173724.ips\\n");',
        'process.stdout.write("Copy: /App-2025-04-27-173725.ips\\n");',
      ].join("\n"),
    );
    process.env.IDEVICE_ID_BIN = idBin;
    process.env.IDEVICECRASHREPORT_BIN = crashBin;
    process.env.CRASHREPORT_ARGS_FILE = argsFile;

    const readOnly = await pullDeviceCrashes({
      udid: "test-udid",
      outDir: keepOutDir,
    });
    assert.equal(readOnly.count, 2);
    assert.equal(readOnly.total_copied, 2);
    const canonicalKeepOutDir = await realpath(keepOutDir);
    assert.equal(readOnly.files.length, 2);
    for (const file of readOnly.files) {
      assert.equal(path.dirname(file), canonicalKeepOutDir);
      assert.match(path.basename(file), /^[a-f0-9]{64}\.ips$/);
    }
    assert.deepEqual(
      await Promise.all(readOnly.files.map((file) => readFile(file, "utf8"))),
      ["linked report\n", "copied report\n"],
    );
    assert.equal((await stat(readOnly.out_dir)).mode & 0o777, 0o700);
    for (const file of readOnly.files) {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    const firstArgs = (await readFile(argsFile, "utf8")).trim().split("\n");
    assert.deepEqual(firstArgs.slice(0, -1), [
      "-u",
      "test-udid",
      "-k",
      "-e",
    ]);
    assert.match(firstArgs.at(-1) ?? "", new RegExp(`^${canonicalKeepOutDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.ios-crash-pull-`));

    const filteredReadOnly = await pullDeviceCrashes({
      udid: "test-udid",
      outDir: keepOutDir,
      keepOnDevice: true,
      filter: "  App  ",
    });
    assert.equal(filteredReadOnly.count, 2);
    assert.deepEqual(filteredReadOnly.files, readOnly.files);
    assert.equal(filteredReadOnly.time_filter_mode, "none");
    const filteredArgs = (await readFile(argsFile, "utf8")).trim().split("\n");
    assert.deepEqual(filteredArgs.slice(0, -1), [
      "-u",
      "test-udid",
      "-k",
      "-e",
      "-f",
      "App",
    ]);
    assert.match(filteredArgs.at(-1) ?? "", /\/\.ios-crash-pull-/);
  } finally {
    if (oldId === undefined) delete process.env.IDEVICE_ID_BIN;
    else process.env.IDEVICE_ID_BIN = oldId;
    if (oldCrash === undefined) delete process.env.IDEVICECRASHREPORT_BIN;
    else process.env.IDEVICECRASHREPORT_BIN = oldCrash;
    if (oldArgsFile === undefined) delete process.env.CRASHREPORT_ARGS_FILE;
    else process.env.CRASHREPORT_ARGS_FILE = oldArgsFile;
    await rm(temp, { recursive: true, force: true });
  }
});

test("crash staging rejects a sparse file beyond the total-byte quota", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-ios-staging-bytes-"));
  try {
    const sparse = await open(path.join(temp, "oversized.ips"), "w", 0o600);
    await sparse.truncate(MAX_DEVICE_CRASH_STAGING_BYTES + 1);
    await sparse.close();
    await assert.rejects(
      scanCrashStaging(temp),
      new RegExp(`exceeded ${MAX_DEVICE_CRASH_STAGING_BYTES} bytes`),
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("runtime staging quota kills an ignore-TERM helper and removes staging", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-ios-staging-runtime-"));
  const idBin = path.join(temp, "fake-idevice-id");
  const crashBin = path.join(temp, "fake-idevicecrashreport");
  const pidFile = path.join(temp, "helper.pid");
  const outDir = path.join(temp, "reports");
  const oldId = process.env.IDEVICE_ID_BIN;
  const oldCrash = process.env.IDEVICECRASHREPORT_BIN;
  const oldPid = process.env.CRASHREPORT_PID_FILE;
  try {
    await makeExecutable(idBin, "#!/bin/sh\nprintf 'test-udid\\n'\n");
    await makeExecutable(
      crashBin,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        "process.on('SIGTERM', () => {});",
        "fs.writeFileSync(process.env.CRASHREPORT_PID_FILE, String(process.pid));",
        "const out = process.argv.at(-1);",
        `for (let i = 0; i < ${MAX_DEVICE_CRASH_STAGING_ENTRIES + 1}; i += 1) {`,
        "  fs.writeFileSync(path.join(out, `${i}.ips`), '');",
        "}",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    process.env.IDEVICE_ID_BIN = idBin;
    process.env.IDEVICECRASHREPORT_BIN = crashBin;
    process.env.CRASHREPORT_PID_FILE = pidFile;

    await assert.rejects(
      pullDeviceCrashes({ udid: "test-udid", outDir }),
      new RegExp(`exceeded ${MAX_DEVICE_CRASH_STAGING_ENTRIES} entries`),
    );
    const helperPid = Number(await readFile(pidFile, "utf8"));
    assert.throws(
      () => process.kill(helperPid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
    assert.equal(
      (await readdir(outDir)).some((name) => name.startsWith(".ios-crash-pull-")),
      false,
    );
  } finally {
    if (oldId === undefined) delete process.env.IDEVICE_ID_BIN;
    else process.env.IDEVICE_ID_BIN = oldId;
    if (oldCrash === undefined) delete process.env.IDEVICECRASHREPORT_BIN;
    else process.env.IDEVICECRASHREPORT_BIN = oldCrash;
    if (oldPid === undefined) delete process.env.CRASHREPORT_PID_FILE;
    else process.env.CRASHREPORT_PID_FILE = oldPid;
    await rm(temp, { recursive: true, force: true });
  }
});

test("batch publication preflight leaves no partial new evidence", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-ios-publish-batch-"));
  const idBin = path.join(temp, "fake-idevice-id");
  const crashBin = path.join(temp, "fake-idevicecrashreport");
  const outDir = path.join(temp, "reports");
  const outside = path.join(temp, "outside.ips");
  const first = "First-2025-04-27-173724.ips";
  const second = "Second-2025-04-27-173725.ips";
  const stable = (relative: string) =>
    `${createHash("sha256").update(relative).digest("hex")}.ips`;
  const oldId = process.env.IDEVICE_ID_BIN;
  const oldCrash = process.env.IDEVICECRASHREPORT_BIN;
  try {
    await makeExecutable(idBin, "#!/bin/sh\nprintf 'test-udid\\n'\n");
    await makeExecutable(
      crashBin,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        "const out = process.argv.at(-1);",
        `fs.writeFileSync(path.join(out, ${JSON.stringify(first)}), 'first');`,
        `fs.writeFileSync(path.join(out, ${JSON.stringify(second)}), 'second');`,
        `process.stdout.write('Copy: /${first}\\nCopy: /${second}\\n');`,
      ].join("\n"),
    );
    await mkdir(outDir, { mode: 0o700 });
    await writeFile(outside, "do not replace", "utf8");
    await symlink(outside, path.join(outDir, stable(second)));
    process.env.IDEVICE_ID_BIN = idBin;
    process.env.IDEVICECRASHREPORT_BIN = crashBin;

    await assert.rejects(
      pullDeviceCrashes({ udid: "test-udid", outDir }),
      /unsafe existing crash-report destination/i,
    );
    await assert.rejects(stat(path.join(outDir, stable(first))), /ENOENT/);
    assert.equal(await readFile(outside, "utf8"), "do not replace");
  } finally {
    if (oldId === undefined) delete process.env.IDEVICE_ID_BIN;
    else process.env.IDEVICE_ID_BIN = oldId;
    if (oldCrash === undefined) delete process.env.IDEVICECRASHREPORT_BIN;
    else process.env.IDEVICECRASHREPORT_BIN = oldCrash;
    await rm(temp, { recursive: true, force: true });
  }
});

test("published crash evidence is isolated from a detached staging writer", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-ios-detached-writer-"));
  const idBin = path.join(temp, "fake-idevice-id");
  const crashBin = path.join(temp, "fake-idevicecrashreport");
  const pidFile = path.join(temp, "writer.pid");
  const outDir = path.join(temp, "reports");
  const oldId = process.env.IDEVICE_ID_BIN;
  const oldCrash = process.env.IDEVICECRASHREPORT_BIN;
  const oldPid = process.env.CRASHREPORT_PID_FILE;
  let writerPid: number | undefined;
  try {
    await makeExecutable(idBin, "#!/bin/sh\nprintf 'test-udid\\n'\n");
    await makeExecutable(
      crashBin,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const { spawn } = require("node:child_process");',
        "const out = process.argv.at(-1);",
        "const report = path.join(out, 'Stable-2025-04-27-173725.ips');",
        "fs.writeFileSync(report, 'stable');",
        "const source = `const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'a');fs.writeFileSync(process.argv[2],String(process.pid));process.send('ready');setTimeout(()=>{fs.writeSync(fd,'-late-mutation');fs.closeSync(fd);process.exit(0)},1500)`;",
        "const writer = spawn(process.execPath, ['-e', source, report, process.env.CRASHREPORT_PID_FILE], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
        "writer.once('message', () => {",
        "  writer.disconnect();",
        "  writer.unref();",
        "  process.stdout.write('Copy: /Stable-2025-04-27-173725.ips\\n');",
        "});",
      ].join("\n"),
    );
    process.env.IDEVICE_ID_BIN = idBin;
    process.env.IDEVICECRASHREPORT_BIN = crashBin;
    process.env.CRASHREPORT_PID_FILE = pidFile;

    const pulled = await pullDeviceCrashes({ udid: "test-udid", outDir });
    assert.equal(pulled.files.length, 1);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        writerPid = Number(await readFile(pidFile, "utf8"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    assert.ok(writerPid, "detached writer pid was not recorded");
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    assert.equal(await readFile(pulled.files[0]!, "utf8"), "stable");
  } finally {
    if (writerPid) {
      try {
        process.kill(writerPid, "SIGKILL");
      } catch {
        // It normally exits after its delayed write.
      }
    }
    if (oldId === undefined) delete process.env.IDEVICE_ID_BIN;
    else process.env.IDEVICE_ID_BIN = oldId;
    if (oldCrash === undefined) delete process.env.IDEVICECRASHREPORT_BIN;
    else process.env.IDEVICECRASHREPORT_BIN = oldCrash;
    if (oldPid === undefined) delete process.env.CRASHREPORT_PID_FILE;
    else process.env.CRASHREPORT_PID_FILE = oldPid;
    await rm(temp, { recursive: true, force: true });
  }
});

test("pullDeviceCrashes rejects missing, non-regular, and escaping announced reports", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-ios-invalid-pull-"));
  const idBin = path.join(temp, "fake-idevice-id");
  const crashBin = path.join(temp, "fake-idevicecrashreport");
  const outside = path.join(temp, "outside.ips");
  const oldId = process.env.IDEVICE_ID_BIN;
  const oldCrash = process.env.IDEVICECRASHREPORT_BIN;
  const oldMode = process.env.CRASHREPORT_TEST_MODE;
  const oldOutside = process.env.CRASHREPORT_OUTSIDE;
  try {
    await makeExecutable(idBin, "#!/bin/sh\nprintf 'test-udid\\n'\n");
    await writeFile(outside, "outside report\n", "utf8");
    await makeExecutable(
      crashBin,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        "const out = process.argv.at(-1);",
        "if (process.env.CRASHREPORT_TEST_MODE === 'missing') {",
        "  process.stdout.write('Copy: /Missing.ips\\n');",
        "} else if (process.env.CRASHREPORT_TEST_MODE === 'directory') {",
        "  fs.mkdirSync(path.join(out, 'Directory.ips'), { recursive: true });",
        "  process.stdout.write('Copy: /Directory.ips\\n');",
        "} else if (process.env.CRASHREPORT_TEST_MODE === 'hardlink') {",
        "  fs.linkSync(process.env.CRASHREPORT_OUTSIDE, path.join(out, 'Hardlink.ips'));",
        "  process.stdout.write('Link: /Hardlink.ips\\n');",
        "} else {",
        "  fs.symlinkSync(process.env.CRASHREPORT_OUTSIDE, path.join(out, 'Escape.ips'));",
        "  process.stdout.write('Link: /Escape.ips\\n');",
        "}",
      ].join("\n"),
    );
    process.env.IDEVICE_ID_BIN = idBin;
    process.env.IDEVICECRASHREPORT_BIN = crashBin;
    process.env.CRASHREPORT_OUTSIDE = outside;

    process.env.CRASHREPORT_TEST_MODE = "missing";
    await assert.rejects(
      pullDeviceCrashes({
        udid: "test-udid",
        outDir: path.join(temp, "missing"),
      }),
      /cannot be opened safely.*Missing\.ips/i,
    );

    process.env.CRASHREPORT_TEST_MODE = "directory";
    await assert.rejects(
      pullDeviceCrashes({
        udid: "test-udid",
        outDir: path.join(temp, "directory"),
      }),
      /not a single-link regular file.*Directory\.ips/i,
    );

    process.env.CRASHREPORT_TEST_MODE = "escape";
    await assert.rejects(
      pullDeviceCrashes({
        udid: "test-udid",
        outDir: path.join(temp, "escape"),
      }),
      /cannot be opened safely.*Escape\.ips|staging contains an unsafe entry type/i,
    );

    process.env.CRASHREPORT_TEST_MODE = "hardlink";
    await assert.rejects(
      pullDeviceCrashes({
        udid: "test-udid",
        outDir: path.join(temp, "hardlink"),
      }),
      /not a single-link regular file.*Hardlink\.ips|staging contains a multi-link file/i,
    );
    assert.equal(await readFile(outside, "utf8"), "outside report\n");

    const realOutDir = path.join(temp, "real-output-directory");
    const linkedOutDir = path.join(temp, "linked-output-directory");
    await mkdir(realOutDir);
    await symlink(realOutDir, linkedOutDir);
    await assert.rejects(
      pullDeviceCrashes({
        udid: "test-udid",
        outDir: linkedOutDir,
      }),
      /ELOOP|ENOTDIR|symbolic link/i,
    );
  } finally {
    if (oldId === undefined) delete process.env.IDEVICE_ID_BIN;
    else process.env.IDEVICE_ID_BIN = oldId;
    if (oldCrash === undefined) delete process.env.IDEVICECRASHREPORT_BIN;
    else process.env.IDEVICECRASHREPORT_BIN = oldCrash;
    if (oldMode === undefined) delete process.env.CRASHREPORT_TEST_MODE;
    else process.env.CRASHREPORT_TEST_MODE = oldMode;
    if (oldOutside === undefined) delete process.env.CRASHREPORT_OUTSIDE;
    else process.env.CRASHREPORT_OUTSIDE = oldOutside;
    await rm(temp, { recursive: true, force: true });
  }
});
