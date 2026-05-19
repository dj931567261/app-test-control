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
import { listCaptures, startCapture, startIosCapture, stopCapture } from "./captures.js";
import { listSimulators, SimctlError } from "./ios.js";
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
  "Stop the background logcat capture for a session.",
  { session_id: z.string() },
  async ({ session_id }) => {
    const result = stopCapture(session_id);
    return asText(result);
  },
);

// ---------- list_captures ----------
server.tool(
  "list_captures",
  "List active background logcat captures.",
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

// ---------- boot ----------
const transport = new StdioServerTransport();
await server.connect(transport);
