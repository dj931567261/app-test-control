// Tracks background logcat capture processes keyed by session id.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawnLogcat } from "./adb.js";
import { spawnIosLogStream } from "./ios.js";
import { spawnDeviceSyslog } from "./ios-device.js";
import type { ChildProcess } from "node:child_process";

type CapturePlatform = "android" | "ios" | "ios-device";

interface CaptureHandle {
  sessionId: string;
  platform: CapturePlatform;
  device: string;
  outFile: string;
  process: ChildProcess;
  startedAt: number;
}

const captures = new Map<string, CaptureHandle>();

export async function startCapture(opts: {
  sessionId: string;
  sessionDir: string; // absolute path to session dir
  device?: string;
  bufferArgs?: string[]; // e.g. ["-b", "main", "-b", "crash"]
}): Promise<{ outFile: string; device: string }> {
  if (captures.has(opts.sessionId)) {
    throw new Error(`Capture already running for session "${opts.sessionId}"`);
  }
  const logsDir = path.join(opts.sessionDir, "logs");
  await mkdir(logsDir, { recursive: true });
  const outFile = path.join(logsDir, "logcat.txt");

  const { process: proc, device } = await spawnLogcat({
    device: opts.device,
    outFilePath: outFile,
    bufferArgs: opts.bufferArgs,
  });

  captures.set(opts.sessionId, {
    sessionId: opts.sessionId,
    platform: "android",
    device,
    outFile,
    process: proc,
    startedAt: Date.now(),
  });

  proc.once("exit", () => {
    captures.delete(opts.sessionId);
  });

  return { outFile, device };
}

export function stopCapture(sessionId: string): { stopped: boolean; outFile?: string } {
  const handle = captures.get(sessionId);
  if (!handle) return { stopped: false };
  handle.process.kill("SIGTERM");
  captures.delete(sessionId);
  return { stopped: true, outFile: handle.outFile };
}

export async function startIosCapture(opts: {
  sessionId: string;
  sessionDir: string;
  simulatorUdid?: string;
  predicate?: string;
  level?: "default" | "info" | "debug";
}): Promise<{ outFile: string; udid: string }> {
  if (captures.has(opts.sessionId)) {
    throw new Error(`Capture already running for session "${opts.sessionId}"`);
  }
  const logsDir = path.join(opts.sessionDir, "logs");
  await mkdir(logsDir, { recursive: true });
  const outFile = path.join(logsDir, "ios-log.txt");

  const spawnOpts: Parameters<typeof spawnIosLogStream>[0] = { outFilePath: outFile };
  if (opts.simulatorUdid !== undefined) spawnOpts.udid = opts.simulatorUdid;
  if (opts.predicate !== undefined) spawnOpts.predicate = opts.predicate;
  if (opts.level !== undefined) spawnOpts.level = opts.level;
  const { process: proc, udid } = await spawnIosLogStream(spawnOpts);

  captures.set(opts.sessionId, {
    sessionId: opts.sessionId,
    platform: "ios",
    device: udid,
    outFile,
    process: proc,
    startedAt: Date.now(),
  });

  proc.once("exit", () => {
    captures.delete(opts.sessionId);
  });

  return { outFile, udid };
}

export async function startIosDeviceCapture(opts: {
  sessionId: string;
  sessionDir: string;
  udid?: string;
  processMatch?: string[];
}): Promise<{ outFile: string; udid: string }> {
  if (captures.has(opts.sessionId)) {
    throw new Error(`Capture already running for session "${opts.sessionId}"`);
  }
  const logsDir = path.join(opts.sessionDir, "logs");
  await mkdir(logsDir, { recursive: true });
  const outFile = path.join(logsDir, "ios-device-syslog.txt");

  const spawnOpts: Parameters<typeof spawnDeviceSyslog>[0] = { outFilePath: outFile };
  if (opts.udid !== undefined) spawnOpts.udid = opts.udid;
  if (opts.processMatch !== undefined) spawnOpts.processMatch = opts.processMatch;
  const { process: proc, udid } = await spawnDeviceSyslog(spawnOpts);

  captures.set(opts.sessionId, {
    sessionId: opts.sessionId,
    platform: "ios-device",
    device: udid,
    outFile,
    process: proc,
    startedAt: Date.now(),
  });

  proc.once("exit", () => {
    captures.delete(opts.sessionId);
  });

  return { outFile, udid };
}

export function listCaptures(): Array<{
  sessionId: string;
  platform: CapturePlatform;
  device: string;
  outFile: string;
  startedAt: number;
}> {
  return Array.from(captures.values()).map((h) => ({
    sessionId: h.sessionId,
    platform: h.platform,
    device: h.device,
    outFile: h.outFile,
    startedAt: h.startedAt,
  }));
}

// On process exit, clean up background captures.
function cleanup() {
  for (const h of captures.values()) {
    try {
      h.process.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});
