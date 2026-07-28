#!/usr/bin/env node
// log-mcp: Android logcat / ANR / tombstone capture as MCP tools.
// See PLAN.md §4.1 for the tool surface.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";

import {
  AdbError,
  clearLogcat,
  dumpLogcat,
  dumpsysMeminfo,
  listDevices,
  pickDevice,
  pullViaBugreport,
} from "./adb.js";
import { parseCrashes } from "./crash-parser.js";
import {
  listCaptures,
  startCapture,
  startIosCapture,
  startIosDeviceCapture,
  stopCapture,
} from "./captures.js";
import { listSimulators, SimctlError } from "./ios.js";
import {
  DEFAULT_IOS_DEVICE_SYSLOG_MAX_BYTES,
  IosDeviceError,
  MAX_IOS_DEVICE_SYSLOG_MAX_BYTES,
  listApps as listIosDeviceApps,
  listDevices as listIosDevices,
  pullDeviceCrashes,
  validateCrashReportFilter,
} from "./ios-device.js";
import { copyIpsFiles, DIAGNOSTIC_REPORTS, listIpsFiles } from "./ips.js";

const server = new McpServer({
  name: "log-mcp",
  version: "0.1.0",
});

function asText(payload: unknown): { content: [{ type: "text"; text: string }] } {
  const text =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}

function asError(err: unknown): {
  isError: true;
  content: [{ type: "text"; text: string }];
} {
  let text: string;
  if (err instanceof AdbError) {
    text = `${err.message}${err.stderr ? `\nstderr: ${err.stderr}` : ""}`;
  } else if (err instanceof SimctlError) {
    text = `${err.message}${err.stderr ? `\nstderr: ${err.stderr}` : ""}`;
  } else if (err instanceof IosDeviceError) {
    text = `${err.message}${err.stderr ? `\nstderr: ${err.stderr}` : ""}`;
  } else if (err instanceof Error) {
    text = err.message;
  } else {
    text = String(err);
  }
  return { isError: true, content: [{ type: "text", text }] };
}

// ---------- list_devices ----------
server.tool(
  "list_devices",
  "List connected Android devices visible to adb.",
  {},
  async () => {
    try {
      const devices = await listDevices();
      return asText(devices);
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- clear_logs ----------
server.tool(
  "clear_logs",
  "Clear the device's logcat buffer. Call this before performing an action to capture only its logs.",
  {
    device: z.string().optional().describe("adb serial; auto if omitted"),
  },
  async ({ device }) => {
    try {
      await clearLogcat(device);
      const target = await pickDevice(device);
      return asText({ ok: true, device: target });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- start_capture ----------
server.tool(
  "start_capture",
  "Start a background logcat capture to a file under <session_dir>/logs/logcat.txt.",
  {
    session_id: z.string().describe("logical id, used as Map key"),
    session_dir: z.string().describe("absolute path of the session directory"),
    device: z.string().optional(),
    buffers: z
      .array(z.string())
      .optional()
      .describe(
        "logcat buffer names; default ['main','system','crash']. Pass [] to use device default.",
      ),
  },
  async ({ session_id, session_dir, device, buffers }) => {
    try {
      const bufList = buffers ?? ["main", "system", "crash"];
      const bufferArgs = bufList.flatMap((b) => ["-b", b]);
      const { outFile, device: dev } = await startCapture({
        sessionId: session_id,
        sessionDir: session_dir,
        device,
        bufferArgs,
      });
      return asText({ ok: true, session_id, device: dev, out_file: outFile });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- stop_capture ----------
server.tool(
  "stop_capture",
  "Stop an Android/iOS background capture. Returns stopped=true for a clean stop; if the process already failed, returns stopped=false with retained status/reason/exit/error details.",
  { session_id: z.string() },
  async ({ session_id }) => {
    try {
      const result = await stopCapture(session_id);
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- list_captures ----------
server.tool(
  "list_captures",
  "List Android/iOS captures with running/stopping status plus up to 64 recent failed terminal records, including reason, exit code, signal and error.",
  {},
  async () => asText(listCaptures()),
);

// ---------- get_recent_crashes ----------
server.tool(
  "get_recent_crashes",
  "Dump current logcat and parse for FATAL EXCEPTION / ANR / native crashes. Returns structured records.",
  {
    device: z.string().optional(),
    package: z
      .string()
      .optional()
      .describe("filter by process/package substring"),
    grep: z
      .string()
      .optional()
      .describe("additional substring filter on signature/stack"),
    include_full_stack: z
      .boolean()
      .optional()
      .default(true),
  },
  async ({ device, package: pkg, grep, include_full_stack }) => {
    try {
      const log = await dumpLogcat(device);
      let crashes = parseCrashes(log);
      if (pkg) {
        crashes = crashes.filter(
          (c) =>
            (c.process && c.process.includes(pkg)) ||
            c.stack.includes(pkg),
        );
      }
      if (grep) {
        crashes = crashes.filter(
          (c) => c.signature.includes(grep) || c.stack.includes(grep),
        );
      }
      const trimmed = crashes.map((c) => ({
        kind: c.kind,
        time: c.time,
        pid: c.pid,
        tid: c.tid,
        process: c.process,
        signature: c.signature,
        stack: include_full_stack ? c.stack : c.stack.split("\n").slice(0, 5).join("\n"),
      }));
      return asText({ count: trimmed.length, crashes: trimmed });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- pull_anr_traces ----------
server.tool(
  "pull_anr_traces",
  "Run `adb bugreport` and return its zip path. ANR traces live inside bugreport-*/FS/data/anr/.",
  {
    out_dir: z.string().describe("absolute directory to drop the bugreport zip into"),
    device: z.string().optional(),
  },
  async ({ out_dir, device }) => {
    try {
      await mkdir(out_dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const outZip = path.join(out_dir, `bugreport-${stamp}.zip`);
      await pullViaBugreport({ device, outZipPath: outZip });
      return asText({ ok: true, zip: outZip });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- pull_tombstones ----------
// Direct pull from /data/tombstones/ requires root; use bugreport as the
// portable path. The caller can unzip and inspect FS/data/tombstones/.
server.tool(
  "pull_tombstones",
  "Pull tombstones via bugreport (no-root path). Returns the bugreport zip; tombstones are inside FS/data/tombstones/.",
  {
    out_dir: z.string(),
    device: z.string().optional(),
  },
  async ({ out_dir, device }) => {
    try {
      await mkdir(out_dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const outZip = path.join(out_dir, `tombstones-bugreport-${stamp}.zip`);
      await pullViaBugreport({ device, outZipPath: outZip });
      return asText({ ok: true, zip: outZip, note: "Unzip and inspect FS/data/tombstones/" });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- get_memory_info ----------
server.tool(
  "get_memory_info",
  "Run `dumpsys meminfo <package>` and return raw output.",
  {
    package: z.string(),
    device: z.string().optional(),
  },
  async ({ package: pkg, device }) => {
    try {
      const out = await dumpsysMeminfo({ package: pkg, device });
      return asText(out);
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- save_log_snippet (utility) ----------
server.tool(
  "save_log_snippet",
  "Dump current logcat (or read an existing capture file) and write a snippet to a path. Useful for archiving per-step logs.",
  {
    out_path: z.string().describe("absolute file path to write the snippet"),
    source: z
      .enum(["logcat-dump", "capture-file"])
      .default("logcat-dump"),
    capture_file: z
      .string()
      .optional()
      .describe("when source=capture-file, path to read"),
    last_lines: z.number().int().positive().optional(),
    grep: z.string().optional(),
    device: z.string().optional(),
  },
  async ({ out_path, source, capture_file, last_lines, grep, device }) => {
    try {
      let content: string;
      if (source === "capture-file") {
        if (!capture_file) throw new Error("capture_file is required when source=capture-file");
        content = await readFile(capture_file, "utf8");
      } else {
        content = await dumpLogcat(device);
      }
      if (grep) {
        const needle = grep;
        content = content
          .split("\n")
          .filter((l) => l.includes(needle))
          .join("\n");
      }
      if (last_lines) {
        const lines = content.split("\n");
        content = lines.slice(Math.max(0, lines.length - last_lines)).join("\n");
      }
      await mkdir(path.dirname(out_path), { recursive: true });
      await writeFile(out_path, content, "utf8");
      return asText({ ok: true, out_path, bytes: content.length });
    } catch (err) {
      return asError(err);
    }
  },
);

// =========================
//   iOS Simulator tools
// =========================

// ---------- ios_list_simulators ----------
server.tool(
  "ios_list_simulators",
  "List iOS simulators known to xcrun simctl. Use only_booted=true to see currently running ones.",
  {
    only_booted: z.boolean().optional().default(false),
  },
  async ({ only_booted }) => {
    try {
      const sims = await listSimulators({ onlyBooted: only_booted });
      return asText({ count: sims.length, simulators: sims });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- ios_start_capture ----------
server.tool(
  "ios_start_capture",
  "Start a background `xcrun simctl spawn <udid> log stream` to <session_dir>/logs/ios-log.txt. Optionally narrow with an Apple log predicate.",
  {
    session_id: z.string(),
    session_dir: z.string(),
    simulator_udid: z.string().optional(),
    predicate: z
      .string()
      .optional()
      .describe(
        'Apple log predicate, e.g. \'process == "MyApp"\' or \'subsystem CONTAINS "com.example"\'.',
      ),
    level: z.enum(["default", "info", "debug"]).optional(),
  },
  async ({ session_id, session_dir, simulator_udid, predicate, level }) => {
    try {
      const startOpts: Parameters<typeof startIosCapture>[0] = {
        sessionId: session_id,
        sessionDir: session_dir,
      };
      if (simulator_udid !== undefined) startOpts.simulatorUdid = simulator_udid;
      if (predicate !== undefined) startOpts.predicate = predicate;
      if (level !== undefined) startOpts.level = level;
      const { outFile, udid } = await startIosCapture(startOpts);
      return asText({ ok: true, session_id, udid, out_file: outFile });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- ios_list_ips ----------
server.tool(
  "ios_list_ips",
  "List Apple .ips crash files under ~/Library/Logs/DiagnosticReports/ (simulator crashes land here too). Filter by since_minutes / bundle_id / proc_name.",
  {
    since_minutes: z.number().int().positive().optional(),
    bundle_id: z.string().optional(),
    proc_name: z.string().optional(),
    reports_dir: z.string().optional().describe("override default DiagnosticReports dir"),
  },
  async (input) => {
    try {
      const files = await listIpsFiles(input);
      return asText({
        count: files.length,
        reports_dir: input.reports_dir ?? DIAGNOSTIC_REPORTS,
        files,
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- ios_pull_ips ----------
server.tool(
  "ios_pull_ips",
  "Copy matching .ips files into an output directory (e.g. <session>/crashes/) for archiving and analyzer input.",
  {
    out_dir: z.string().describe("absolute target directory"),
    since_minutes: z.number().int().positive().optional(),
    bundle_id: z.string().optional(),
    proc_name: z.string().optional(),
    reports_dir: z.string().optional(),
    limit: z.number().int().positive().optional(),
  },
  async ({ out_dir, since_minutes, bundle_id, proc_name, reports_dir, limit }) => {
    try {
      const listOpts: Parameters<typeof listIpsFiles>[0] = {};
      if (since_minutes !== undefined) listOpts.since_minutes = since_minutes;
      if (bundle_id !== undefined) listOpts.bundle_id = bundle_id;
      if (proc_name !== undefined) listOpts.proc_name = proc_name;
      if (reports_dir !== undefined) listOpts.reports_dir = reports_dir;
      let files = await listIpsFiles(listOpts);
      if (limit) files = files.slice(0, limit);
      const copied = await copyIpsFiles(files, out_dir);
      return asText({ ok: true, count: copied.length, copied });
    } catch (err) {
      return asError(err);
    }
  },
);

// =========================
//   iOS Real-Device tools (libimobiledevice)
// =========================
// Unlike the simulator tools above, these target physical iPhones/iPads over
// USB. Real-device crashes never reach ~/Library/Logs/DiagnosticReports, so
// ios_list_ips / ios_pull_ips do NOT see them — use ios_pull_device_crashes.

// ---------- ios_list_devices ----------
server.tool(
  "ios_list_devices",
  "List connected real iOS devices (USB) via libimobiledevice, with name / model / OS version. Distinct from ios_list_simulators.",
  {},
  async () => {
    try {
      const devices = await listIosDevices();
      return asText({ count: devices.length, devices });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- ios_device_start_capture ----------
server.tool(
  "ios_device_start_capture",
  "Start a bounded background idevicesyslog capture from a real iOS device to <session_dir>/logs/ios-device-syslog.txt. Optionally filter by exact process name(s). The capture stops automatically at max_bytes (default 256 MiB) and exposes a limit_reached failure via list_captures/stop_capture. Stop manually with stop_capture.",
  {
    session_id: z.string(),
    session_dir: z.string(),
    device: z.string().optional().describe("device UDID; auto if a single device is connected"),
    process_match: z
      .array(
        z.string().trim().min(1).refine((name) => !name.includes("|"), {
          message: "process name must not contain '|'",
        }),
      )
      .optional()
      .describe("only include records emitted by these process names (idevicesyslog -p)"),
    max_bytes: z
      .number()
      .int()
      .positive()
      .max(MAX_IOS_DEVICE_SYSLOG_MAX_BYTES)
      .optional()
      .default(DEFAULT_IOS_DEVICE_SYSLOG_MAX_BYTES)
      .describe("maximum bytes appended by this capture before automatic stop"),
  },
  async ({ session_id, session_dir, device, process_match, max_bytes }) => {
    try {
      const startOpts: Parameters<typeof startIosDeviceCapture>[0] = {
        sessionId: session_id,
        sessionDir: session_dir,
        maxBytes: max_bytes,
      };
      if (device !== undefined) startOpts.udid = device;
      if (process_match !== undefined) startOpts.processMatch = process_match;
      const { outFile, udid, maxBytes } = await startIosDeviceCapture(startOpts);
      return asText({ ok: true, session_id, udid, out_file: outFile, max_bytes: maxBytes });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- ios_pull_device_crashes ----------
server.tool(
  "ios_pull_device_crashes",
  "Pull crash reports off a real iOS device via idevicecrashreport. Real-device crashes do NOT appear in ios_list_ips. Returns contained absolute report paths (not raw stdout). `since_minutes` uses a cutoff frozen before transfer and the device time zone when available; without it, a conservative 14-hour allowance prevents host/device-zone misses. Destructive removal requires a non-empty exact process `filter` and cannot be combined with since_minutes; the default keeps every report on the device.",
  {
    out_dir: z
      .string()
      .refine((value) => path.isAbsolute(value), "out_dir must be an absolute path")
      .describe("absolute target directory"),
    device: z.string().optional().describe("device UDID; auto if a single device is connected"),
    filter: z
      .string()
      .trim()
      .min(1, "filter must contain a non-empty, non-whitespace executable/process name")
      .optional()
      .describe("case-sensitive executable/process name filter (idevicecrashreport -f); omit when unknown and do not substitute the bundle id"),
    since_minutes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("filter returned files against a request-start cutoff; the device stores/copies all matching reports because the CLI has no time predicate"),
    remove_from_device: z
      .boolean()
      .optional()
      .default(false)
      .describe("if true, move/delete only reports selected by the required non-empty exact process `filter`; incompatible with since_minutes (default false keeps them)"),
  },
  async ({ out_dir, device, filter, since_minutes, remove_from_device }) => {
    try {
      const normalizedFilter = validateCrashReportFilter(filter, {
        removingFromDevice: remove_from_device,
      });
      const pullOpts: Parameters<typeof pullDeviceCrashes>[0] = {
        outDir: out_dir,
        keepOnDevice: !remove_from_device,
      };
      if (device !== undefined) pullOpts.udid = device;
      if (normalizedFilter !== undefined) pullOpts.filter = normalizedFilter;
      if (since_minutes !== undefined) pullOpts.sinceMinutes = since_minutes;
      const result = await pullDeviceCrashes(pullOpts);
      return asText({ ok: true, ...result });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- ios_device_list_apps ----------
server.tool(
  "ios_device_list_apps",
  "List installed apps on a real iOS device via ideviceinstaller. type=user (default) / system / all.",
  {
    device: z.string().optional().describe("device UDID; auto if a single device is connected"),
    type: z.enum(["user", "system", "all"]).optional().default("user"),
  },
  async ({ device, type }) => {
    try {
      const appsOpts: Parameters<typeof listIosDeviceApps>[0] = { type };
      if (device !== undefined) appsOpts.udid = device;
      const apps = await listIosDeviceApps(appsOpts);
      return asText({ count: apps.length, apps });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- boot ----------
const transport = new StdioServerTransport();
await server.connect(transport);
