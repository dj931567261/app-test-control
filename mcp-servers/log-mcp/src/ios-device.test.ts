// Unit tests for the pure helpers behind ios_pull_device_crashes.
// These guard the since_minutes filtering — the logic that decides whether a
// real crash is surfaced or dropped — without needing a physical device.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

import {
  DEFAULT_IOS_DEVICE_SYSLOG_MAX_BYTES,
  IosDeviceError,
  MAX_IOS_DEVICE_SYSLOG_MAX_BYTES,
  parseCopiedReports,
  parseReportTimestamp,
  filterReportsSince,
  pullDeviceCrashes,
  resolveReportPath,
  spawnDeviceSyslog,
  validateCrashReportFilter,
} from "./ios-device.js";

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

test("parseCopiedReports accepts Move lines emitted when reports are removed", () => {
  assert.deepEqual(
    parseCopiedReports(
      [
        "Move: /Runner-2025-04-27-173725.ips",
        "Copy: /Retired/Other-2025-04-27-173726.ips",
      ].join("\n"),
    ),
    [
      "Runner-2025-04-27-173725.ips",
      "Retired/Other-2025-04-27-173726.ips",
    ],
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

test("validateCrashReportFilter trims names and protects destructive pulls", () => {
  assert.equal(validateCrashReportFilter(undefined), undefined);
  assert.equal(validateCrashReportFilter("  MyApp\t"), "MyApp");
  assert.equal(
    validateCrashReportFilter("  MyApp  ", { removingFromDevice: true }),
    "MyApp",
  );
  assert.throws(
    () => validateCrashReportFilter(" \t\n "),
    /non-empty, non-whitespace executable\/process name/,
  );
  assert.throws(
    () => validateCrashReportFilter(undefined, { removingFromDevice: true }),
    /Refusing to remove crash reports.*requires a non-empty, non-whitespace filter/,
  );
  assert.throws(
    () => validateCrashReportFilter(" \t ", { removingFromDevice: true }),
    /Refusing to remove crash reports.*requires a non-empty, non-whitespace filter/,
  );
});

test("pullDeviceCrashes rejects unsafe removal/time and relative output before device I/O", async () => {
  await assert.rejects(
    pullDeviceCrashes({
      outDir: "/tmp/crashes",
      keepOnDevice: false,
    }),
    /Refusing to remove crash reports.*requires a non-empty, non-whitespace filter/,
  );
  await assert.rejects(
    pullDeviceCrashes({
      outDir: "/tmp/crashes",
      keepOnDevice: false,
      filter: " \t ",
    }),
    /Refusing to remove crash reports.*requires a non-empty, non-whitespace filter/,
  );
  await assert.rejects(
    pullDeviceCrashes({
      outDir: "/tmp/crashes",
      keepOnDevice: false,
      filter: "MyApp",
      sinceMinutes: 5,
    }),
    /Cannot combine remove_from_device with since_minutes/,
  );
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
    /non-empty, non-whitespace executable\/process name/,
  );
});

test("ios_pull_device_crashes tool rejects destructive calls without a filter", async () => {
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
      /Refusing to remove crash reports.*requires a non-empty, non-whitespace filter/,
    );

    const whitespaceResult = await client.callTool({
      name: "ios_pull_device_crashes",
      arguments: {
        out_dir: path.join(os.tmpdir(), "ios-removal-guard-tool-test"),
        filter: " \t ",
        remove_from_device: true,
      },
    });
    const whitespaceText = (
      whitespaceResult.content as Array<{ type: string; text?: string }>
    )
      .map((item) => item.text ?? "")
      .join("\n");
    assert.equal(whitespaceResult.isError, true);
    assert.match(
      whitespaceText,
      /filter must contain a non-empty, non-whitespace executable\/process name/,
    );
  } finally {
    await client.close();
  }
});

async function makeExecutable(file: string, source: string): Promise<void> {
  await writeFile(file, source, "utf8");
  await chmod(file, 0o755);
}

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

test("pullDeviceCrashes is read-only by default and scopes destructive pulls", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-ios-pull-"));
  const idBin = path.join(temp, "fake-idevice-id");
  const crashBin = path.join(temp, "fake-idevicecrashreport");
  const argsFile = path.join(temp, "args.txt");
  const keepOutDir = path.join(temp, "keep-reports");
  const removeOutDir = path.join(temp, "remove-reports");
  const oldId = process.env.IDEVICE_ID_BIN;
  const oldCrash = process.env.IDEVICECRASHREPORT_BIN;
  const oldArgsFile = process.env.CRASHREPORT_ARGS_FILE;
  try {
    await makeExecutable(idBin, "#!/bin/sh\nprintf 'test-udid\\n'\n");
    await makeExecutable(
      crashBin,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > \"$CRASHREPORT_ARGS_FILE\"",
        "case \" $* \" in",
        "  *\" -k \"*) printf 'Copy: /App-2025-04-27-173725.ips\\n' ;;",
        "  *) printf 'Move: /App-2025-04-27-173725.ips\\n' ;;",
        "esac",
      ].join("\n"),
    );
    process.env.IDEVICE_ID_BIN = idBin;
    process.env.IDEVICECRASHREPORT_BIN = crashBin;
    process.env.CRASHREPORT_ARGS_FILE = argsFile;

    const readOnly = await pullDeviceCrashes({
      udid: "test-udid",
      outDir: keepOutDir,
    });
    assert.equal(readOnly.count, 1);
    assert.deepEqual((await readFile(argsFile, "utf8")).trim().split("\n"), [
      "-u",
      "test-udid",
      "-k",
      "-e",
      keepOutDir,
    ]);

    const destructive = await pullDeviceCrashes({
      udid: "test-udid",
      outDir: removeOutDir,
      keepOnDevice: false,
      filter: "  App  ",
    });
    assert.equal(destructive.count, 1);
    assert.equal(destructive.total_copied, 1);
    assert.equal(destructive.time_filter_mode, "none");
    assert.deepEqual(destructive.files, [
      path.join(removeOutDir, "App-2025-04-27-173725.ips"),
    ]);
    assert.deepEqual((await readFile(argsFile, "utf8")).trim().split("\n"), [
      "-u",
      "test-udid",
      "-e",
      "-f",
      "App",
      removeOutDir,
    ]);
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
