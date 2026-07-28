#!/usr/bin/env node
// log-mcp: Android logcat / ANR / tombstone capture as MCP tools.
// See PLAN.md §4.1 for the tool surface.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";

import {
  AdbError,
  clearLogcat,
  dumpLogcat,
  dumpsysMeminfo,
  listDevices,
  pickDevice,
  pullViaBugreport,
} from "./adb.js";
import {
  boundCrashRecords,
  MAX_PARSED_CRASH_RECORDS,
  parseCrashesWithMeta,
} from "./crash-parser.js";
import {
  DEFAULT_CAPTURE_MAX_BYTES,
  MAX_CAPTURE_MAX_BYTES,
  listCaptures,
  startCapture,
  startIosCapture,
  startIosDeviceCapture,
  stopCapture,
  shutdownCaptures,
} from "./captures.js";
import { listSimulatorsWithMeta, SimctlError } from "./ios.js";
import {
  IosDeviceError,
  listAppsWithMeta as listIosDeviceApps,
  listDevices as listIosDevices,
  pullDeviceCrashes,
  validateCrashReportFilter,
} from "./ios-device.js";
import {
  copyIpsFiles,
  DIAGNOSTIC_REPORTS,
  listIpsFiles,
  listIpsFilesWithMeta,
  MAX_IPS_COPY_FILES,
  MAX_IPS_FILTER_LENGTH,
  MAX_IPS_PATH_LENGTH,
} from "./ips.js";
import {
  MAX_SNIPPET_FILTER_LENGTH,
  MAX_SNIPPET_LAST_LINES,
  MAX_SNIPPET_PATH_LENGTH,
  saveSnippetFromFile,
  saveSnippetFromText,
} from "./snippet.js";
import {
  MAX_COMMAND_DIAGNOSTIC_BYTES,
  truncateCommandDiagnostic,
} from "./bounded-exec.js";

const MAX_SESSION_ID_LENGTH = 128;
const MAX_DEVICE_ID_LENGTH = 256;
const MAX_PACKAGE_LENGTH = 512;
const MAX_COMMAND_FILTER_LENGTH = 512;
const MAX_BUFFER_NAME_LENGTH = 64;
const MAX_CAPTURE_BUFFERS = 8;
const MAX_PREDICATE_LENGTH = 4_096;
const MAX_PROCESS_NAME_LENGTH = 256;
const MAX_PROCESS_MATCH_COUNT = 16;
const MAX_SINCE_MINUTES = 10 * 366 * 24 * 60;
const MAX_MCP_TEXT_RESPONSE_BYTES = 4 * 1024 * 1024;

function boundedArgument(maxLength: number, label: string) {
  return z
    .string()
    .trim()
    .min(1, `${label} must not be empty`)
    .max(maxLength, `${label} must not exceed ${maxLength} characters`)
    .refine((value) => !value.includes("\0"), `${label} must not contain NUL`);
}

function absolutePathArgument(maxLength: number, label: string) {
  return z
    .string()
    .min(1, `${label} must not be empty`)
    .max(maxLength, `${label} must not exceed ${maxLength} characters`)
    .refine((value) => !value.includes("\0"), `${label} must not contain NUL`)
    .refine((value) => path.isAbsolute(value), `${label} must be an absolute path`);
}

const sessionIdArgument = boundedArgument(MAX_SESSION_ID_LENGTH, "session_id");
const deviceArgument = boundedArgument(MAX_DEVICE_ID_LENGTH, "device");
const sessionDirectoryArgument = absolutePathArgument(MAX_IPS_PATH_LENGTH, "session_dir");
const sinceMinutesArgument = z
  .number()
  .int()
  .positive()
  .max(MAX_SINCE_MINUTES);

const server = new McpServer({
  name: "log-mcp",
  version: "0.1.0",
});

type TextToolResult = {
  isError?: true;
  content: [{ type: "text"; text: string }];
};

function asText(payload: unknown): TextToolResult {
  const text =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  const responseBytes = Buffer.byteLength(text, "utf8");
  if (responseBytes > MAX_MCP_TEXT_RESPONSE_BYTES) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "tool response exceeded the MCP text safety limit",
          response_bytes: responseBytes,
          limit_bytes: MAX_MCP_TEXT_RESPONSE_BYTES,
          truncated: true,
        }),
      }],
    };
  }
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
  text = truncateCommandDiagnostic(text, MAX_COMMAND_DIAGNOSTIC_BYTES) ?? "Unknown error";
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
    device: deviceArgument.optional().describe("adb serial; auto if omitted"),
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
  "Start a bounded background logcat capture to <session_dir>/logs/logcat.txt. max_bytes limits the total output-file size; reaching it records limit_reached.",
  {
    session_id: sessionIdArgument.describe("logical id, used as Map key"),
    session_dir: sessionDirectoryArgument.describe("absolute path of the session directory"),
    device: deviceArgument.optional(),
    buffers: z
      .array(boundedArgument(MAX_BUFFER_NAME_LENGTH, "buffer name"))
      .max(MAX_CAPTURE_BUFFERS)
      .optional()
      .describe(
        "logcat buffer names; default ['main','system','crash']. Pass [] to use device default.",
      ),
    max_bytes: z
      .number()
      .int()
      .positive()
      .max(MAX_CAPTURE_MAX_BYTES)
      .optional()
      .default(DEFAULT_CAPTURE_MAX_BYTES)
      .describe("maximum total size of the logcat output file before automatic stop"),
  },
  async ({ session_id, session_dir, device, buffers, max_bytes }) => {
    try {
      const bufList = buffers ?? ["main", "system", "crash"];
      const bufferArgs = bufList.flatMap((b) => ["-b", b]);
      const { outFile, device: dev } = await startCapture({
        sessionId: session_id,
        sessionDir: session_dir,
        device,
        bufferArgs,
        maxBytes: max_bytes,
      });
      return asText({
        ok: true,
        session_id,
        device: dev,
        out_file: outFile,
        max_bytes,
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- stop_capture ----------
server.tool(
  "stop_capture",
  "Stop or cancel an Android/iOS background capture, including one still starting. Returns stopped=true for a clean stop/cancellation; if the process already failed, returns stopped=false with retained status/reason/exit/error details.",
  { session_id: sessionIdArgument },
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
    device: deviceArgument.optional(),
    package: boundedArgument(MAX_PACKAGE_LENGTH, "package")
      .optional()
      .describe("filter by process/package substring"),
    grep: boundedArgument(MAX_COMMAND_FILTER_LENGTH, "grep")
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
      const parsed = parseCrashesWithMeta(log, {
        maxRecords: MAX_PARSED_CRASH_RECORDS,
        predicate: (crash) =>
          (!pkg ||
            (crash.process?.includes(pkg) ?? false) ||
            crash.stack.includes(pkg)) &&
          (!grep || crash.signature.includes(grep) || crash.stack.includes(grep)),
      });
      const bounded = boundCrashRecords(parsed.crashes, {
        includeFullStack: include_full_stack,
        parseLimitReached: parsed.limitReached,
        totalDetected: parsed.totalDetected,
      });
      return asText({ count: bounded.crashes.length, ...bounded });
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
    out_dir: absolutePathArgument(MAX_IPS_PATH_LENGTH, "out_dir")
      .describe("absolute directory to drop the bugreport zip into"),
    device: deviceArgument.optional(),
  },
  async ({ out_dir, device }) => {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const outZip = path.join(out_dir, `bugreport-${stamp}.zip`);
      const published = await pullViaBugreport({ device, outZipPath: outZip });
      return asText({ ok: true, zip: published });
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
    out_dir: absolutePathArgument(MAX_IPS_PATH_LENGTH, "out_dir"),
    device: deviceArgument.optional(),
  },
  async ({ out_dir, device }) => {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const outZip = path.join(out_dir, `tombstones-bugreport-${stamp}.zip`);
      const published = await pullViaBugreport({ device, outZipPath: outZip });
      return asText({ ok: true, zip: published, note: "Unzip and inspect FS/data/tombstones/" });
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
    package: boundedArgument(MAX_PACKAGE_LENGTH, "package"),
    device: deviceArgument.optional(),
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
  "Select a bounded logcat/capture-file snippet with streaming line processing and atomically write a private regular output file. Useful for archiving per-step logs.",
  {
    out_path: absolutePathArgument(MAX_SNIPPET_PATH_LENGTH, "out_path")
      .describe("absolute file path to write the snippet"),
    source: z
      .enum(["logcat-dump", "capture-file"])
      .default("logcat-dump"),
    capture_file: absolutePathArgument(MAX_SNIPPET_PATH_LENGTH, "capture_file")
      .optional()
      .describe("when source=capture-file, path to read"),
    last_lines: z.number().int().positive().max(MAX_SNIPPET_LAST_LINES).optional(),
    grep: z.string().min(1).max(MAX_SNIPPET_FILTER_LENGTH).optional(),
    device: deviceArgument.optional(),
  },
  async ({ out_path, source, capture_file, last_lines, grep, device }) => {
    try {
      const selection = {
        ...(grep !== undefined ? { grep } : {}),
        ...(last_lines !== undefined ? { lastLines: last_lines } : {}),
      };
      let saved;
      if (source === "capture-file") {
        if (!capture_file) throw new Error("capture_file is required when source=capture-file");
        saved = await saveSnippetFromFile({
          captureFile: capture_file,
          outPath: out_path,
          ...selection,
        });
      } else {
        const content = await dumpLogcat(device);
        saved = await saveSnippetFromText({
          content,
          outPath: out_path,
          ...selection,
        });
      }
      return asText({
        ok: true,
        out_path: saved.outPath,
        bytes: saved.bytes,
        source_bytes: saved.sourceBytes,
        selected_lines: saved.selectedLines,
        truncated: saved.truncated,
      });
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
      const listed = await listSimulatorsWithMeta({ onlyBooted: only_booted });
      return asText({
        count: listed.simulators.length,
        total_detected: listed.totalDetected,
        results_truncated: listed.resultsTruncated,
        fields_truncated: listed.fieldsTruncated,
        simulators: listed.simulators,
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- ios_start_capture ----------
server.tool(
  "ios_start_capture",
  "Start a bounded background `xcrun simctl spawn <udid> log stream` to <session_dir>/logs/ios-log.txt. max_bytes limits total output-file size; optionally narrow with an Apple log predicate.",
  {
    session_id: sessionIdArgument,
    session_dir: sessionDirectoryArgument,
    simulator_udid: deviceArgument.optional(),
    predicate: z
      .string()
      .min(1)
      .max(MAX_PREDICATE_LENGTH)
      .refine((value) => !value.includes("\0"), "predicate must not contain NUL")
      .optional()
      .describe(
        'Apple log predicate, e.g. \'process == "MyApp"\' or \'subsystem CONTAINS "com.example"\'.',
      ),
    level: z.enum(["default", "info", "debug"]).optional(),
    max_bytes: z
      .number()
      .int()
      .positive()
      .max(MAX_CAPTURE_MAX_BYTES)
      .optional()
      .default(DEFAULT_CAPTURE_MAX_BYTES)
      .describe("maximum total size of the Simulator log output file before automatic stop"),
  },
  async ({ session_id, session_dir, simulator_udid, predicate, level, max_bytes }) => {
    try {
      const startOpts: Parameters<typeof startIosCapture>[0] = {
        sessionId: session_id,
        sessionDir: session_dir,
        maxBytes: max_bytes,
      };
      if (simulator_udid !== undefined) startOpts.simulatorUdid = simulator_udid;
      if (predicate !== undefined) startOpts.predicate = predicate;
      if (level !== undefined) startOpts.level = level;
      const { outFile, udid } = await startIosCapture(startOpts);
      return asText({
        ok: true,
        session_id,
        udid,
        out_file: outFile,
        max_bytes,
      });
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
    since_minutes: sinceMinutesArgument.optional(),
    bundle_id: boundedArgument(MAX_IPS_FILTER_LENGTH, "bundle_id").optional(),
    proc_name: boundedArgument(MAX_IPS_FILTER_LENGTH, "proc_name").optional(),
    reports_dir: absolutePathArgument(MAX_IPS_PATH_LENGTH, "reports_dir")
      .optional()
      .describe("override default DiagnosticReports dir"),
  },
  async (input) => {
    try {
      const listed = await listIpsFilesWithMeta(input);
      return asText({
        count: listed.files.length,
        total_detected: listed.total_detected,
        results_truncated: listed.results_truncated,
        reports_dir: input.reports_dir ?? DIAGNOSTIC_REPORTS,
        files: listed.files,
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
    out_dir: absolutePathArgument(MAX_IPS_PATH_LENGTH, "out_dir")
      .describe("absolute target directory"),
    since_minutes: sinceMinutesArgument.optional(),
    bundle_id: boundedArgument(MAX_IPS_FILTER_LENGTH, "bundle_id").optional(),
    proc_name: boundedArgument(MAX_IPS_FILTER_LENGTH, "proc_name").optional(),
    reports_dir: absolutePathArgument(MAX_IPS_PATH_LENGTH, "reports_dir").optional(),
    limit: z.number().int().positive().max(MAX_IPS_COPY_FILES).optional().default(MAX_IPS_COPY_FILES),
  },
  async ({ out_dir, since_minutes, bundle_id, proc_name, reports_dir, limit }) => {
    try {
      const listOpts: Parameters<typeof listIpsFiles>[0] = {};
      if (since_minutes !== undefined) listOpts.since_minutes = since_minutes;
      if (bundle_id !== undefined) listOpts.bundle_id = bundle_id;
      if (proc_name !== undefined) listOpts.proc_name = proc_name;
      if (reports_dir !== undefined) listOpts.reports_dir = reports_dir;
      let files = await listIpsFiles(listOpts);
      files = files.slice(0, limit);
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
  "Start a bounded background idevicesyslog capture from a real iOS device to <session_dir>/logs/ios-device-syslog.txt. Optionally filter by exact process name(s). max_bytes is the total size limit for that output file (default 256 MiB); reaching it stops capture and exposes limit_reached via list_captures/stop_capture. Stop manually with stop_capture.",
  {
    session_id: sessionIdArgument,
    session_dir: sessionDirectoryArgument,
    device: deviceArgument.optional().describe("device UDID; auto if a single device is connected"),
    process_match: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(MAX_PROCESS_NAME_LENGTH)
          .refine((name) => !name.includes("|") && !name.includes("\0"), {
            message: "process name must not contain '|' or NUL",
          }),
      )
      .max(MAX_PROCESS_MATCH_COUNT)
      .optional()
      .describe("only include records emitted by these process names (idevicesyslog -p)"),
    max_bytes: z
      .number()
      .int()
      .positive()
      .max(MAX_CAPTURE_MAX_BYTES)
      .optional()
      .default(DEFAULT_CAPTURE_MAX_BYTES)
      .describe("maximum total size of this capture output file before automatic stop"),
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
  "Read-only pull of crash reports from a real iOS device via idevicecrashreport. Reports are always kept on-device. Real-device crashes do NOT appear in ios_list_ips. Returns contained absolute paths for Link/Copy/Move output. `filter` is only a case-sensitive filename substring hint, never a deletion boundary. `since_minutes` filters the returned list after the CLI has copied matching history.",
  {
    out_dir: absolutePathArgument(MAX_IPS_PATH_LENGTH, "out_dir")
      .describe("absolute target directory"),
    device: deviceArgument.optional().describe("device UDID; auto if a single device is connected"),
    filter: z
      .string()
      .trim()
      .min(1, "filter must contain a non-empty, non-whitespace filename substring")
      .max(MAX_IPS_FILTER_LENGTH)
      .refine((value) => !value.includes("\0"), "filter must not contain NUL")
      .optional()
      .describe("case-sensitive filename substring filter (idevicecrashreport -f); read-only optimization only, omit when unknown"),
    since_minutes: sinceMinutesArgument
      .optional()
      .describe("filter returned files against a request-start cutoff; the device stores/copies all matching reports because the CLI has no time predicate"),
    remove_from_device: z
      .boolean()
      .optional()
      .default(false)
      .describe("unsupported safety guard: true is always rejected; reports are always kept on-device"),
  },
  async ({ out_dir, device, filter, since_minutes, remove_from_device }) => {
    try {
      const normalizedFilter = validateCrashReportFilter(filter, {
        removingFromDevice: remove_from_device,
      });
      const pullOpts: Parameters<typeof pullDeviceCrashes>[0] = {
        outDir: out_dir,
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
    device: deviceArgument.optional().describe("device UDID; auto if a single device is connected"),
    type: z.enum(["user", "system", "all"]).optional().default("user"),
  },
  async ({ device, type }) => {
    try {
      const appsOpts: Parameters<typeof listIosDeviceApps>[0] = { type };
      if (device !== undefined) appsOpts.udid = device;
      const listed = await listIosDeviceApps(appsOpts);
      return asText({
        count: listed.apps.length,
        total_detected: listed.total_detected,
        results_truncated: listed.results_truncated,
        fields_truncated: listed.fields_truncated,
        apps: listed.apps,
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- boot ----------
const transport = new StdioServerTransport();

// Stdio clients do not always terminate us with a signal. In particular, a
// crashed parent can leave only an EOF/close on stdin while background capture
// children keep this process alive. Treat either event as an idempotent graceful
// shutdown so those writers are stopped and flushed before Node exits.
const shutdownOnInputClose = () => {
  void shutdownCaptures().catch((error: unknown) => {
    console.error(
      `[log-mcp] stdin-close shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
};
process.stdin.once("end", shutdownOnInputClose);
process.stdin.once("close", shutdownOnInputClose);
await server.connect(transport);
