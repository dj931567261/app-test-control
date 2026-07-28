// Tracks background logcat capture processes keyed by session id.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawnLogcat } from "./adb.js";
import { spawnIosLogStream } from "./ios.js";
import { spawnDeviceSyslog } from "./ios-device.js";
import type { ChildProcess } from "node:child_process";

type CapturePlatform = "android" | "ios" | "ios-device";
type CaptureFailureReason =
  | "unexpected_close"
  | "nonzero_exit"
  | "unexpected_signal"
  | "limit_reached"
  | "cleanup_failed";

interface CaptureFailureRecord {
  sessionId: string;
  platform: CapturePlatform;
  device: string;
  outFile: string;
  startedAt: number;
  endedAt: number;
  status: "failed";
  reason: CaptureFailureReason;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: string;
}

interface CaptureHandle {
  sessionId: string;
  platform: CapturePlatform;
  device: string;
  outFile: string;
  process: ChildProcess;
  startedAt: number;
  /** Platform-specific idempotent stop + file-flush hook. */
  close: () => Promise<void>;
  closing?: Promise<void>;
  finalizing?: Promise<CaptureFailureRecord>;
  processClosed: boolean;
  stopRequested: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stopError?: string;
  failure?: CaptureFailureRecord;
  error?: string;
  didReachLimit?: () => boolean;
  getTerminationError?: () => string | undefined;
}

const captures = new Map<string, CaptureHandle>();
// Failed captures remain queryable after their process is gone, but the
// history is diagnostic only and must never grow without bound or reserve a
// session id. Map insertion order gives us a small FIFO/LRU-like window.
const recentFailures = new Map<string, CaptureFailureRecord>();
const MAX_RECENT_FAILURES = 64;
interface StartReservation {
  done: Promise<void>;
  resolve: () => void;
}
const startingSessions = new Map<string, StartReservation>();
const STOP_TIMEOUT_MS = 3_000;
const SHUTDOWN_TIMEOUT_MS = STOP_TIMEOUT_MS * 3 + 1_000;
let shuttingDown = false;

function reserveSession(sessionId: string): void {
  if (shuttingDown) throw new Error("Capture manager is shutting down");
  if (captures.has(sessionId) || startingSessions.has(sessionId)) {
    throw new Error(`Capture already running for session "${sessionId}"`);
  }
  // Reserve before the first await so concurrent starts cannot both spawn.
  let resolve!: () => void;
  const done = new Promise<void>((doneResolve) => {
    resolve = doneResolve;
  });
  startingSessions.set(sessionId, { done, resolve });
}

function releaseSessionReservation(sessionId: string): void {
  const reservation = startingSessions.get(sessionId);
  if (!reservation) return;
  startingSessions.delete(sessionId);
  reservation.resolve();
}

function deleteIfCurrent(handle: CaptureHandle): void {
  // An old process may emit `close` after a replacement with the same session
  // id has started. Never let that stale callback remove the new handle.
  if (captures.get(handle.sessionId) === handle) {
    captures.delete(handle.sessionId);
  }
}

function rememberFailure(record: CaptureFailureRecord): void {
  // Refresh a repeated session id so eviction always removes the oldest
  // observable lifecycle, not the most recently failed one.
  recentFailures.delete(record.sessionId);
  recentFailures.set(record.sessionId, record);
  while (recentFailures.size > MAX_RECENT_FAILURES) {
    const oldest = recentFailures.keys().next();
    if (oldest.done) break;
    recentFailures.delete(oldest.value);
  }
}

function currentExit(handle: CaptureHandle): {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
} {
  return {
    exitCode: handle.exitCode ?? handle.process.exitCode,
    signal: handle.signal ?? handle.process.signalCode,
  };
}

function exitFailureReason(
  handle: CaptureHandle,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): CaptureFailureReason {
  if (handle.didReachLimit?.()) return "limit_reached";
  if (exitCode !== null && exitCode !== 0) return "nonzero_exit";
  if (signal !== null) return "unexpected_signal";
  return "unexpected_close";
}

function isAbnormalRequestedStopExit(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): boolean {
  if (exitCode !== null && exitCode !== 0) return true;
  return signal !== null && signal !== "SIGTERM" && signal !== "SIGKILL";
}

function buildFailure(
  handle: CaptureHandle,
  reason: CaptureFailureReason,
  cleanupError?: string,
): CaptureFailureRecord {
  const { exitCode, signal } = currentExit(handle);
  const details = `code=${exitCode ?? "null"}, signal=${signal ?? "none"}`;
  const messages =
    reason === "cleanup_failed"
      ? [`Capture cleanup failed (${details})`]
      : reason === "limit_reached"
        ? [`Capture stopped after reaching its byte limit (${details})`]
        : [`Capture process exited unexpectedly (${details})`];
  const runtimeError = handle.error ?? handle.getTerminationError?.();
  if (runtimeError && runtimeError !== cleanupError) {
    messages.push(`runtime error: ${runtimeError}`);
  }
  if (cleanupError) messages.push(`cleanup error: ${cleanupError}`);
  return {
    sessionId: handle.sessionId,
    platform: handle.platform,
    device: handle.device,
    outFile: handle.outFile,
    startedAt: handle.startedAt,
    endedAt: Date.now(),
    status: "failed",
    reason,
    exitCode,
    signal,
    error: messages.join("; "),
  };
}

function terminalizeFailure(
  handle: CaptureHandle,
  reason: CaptureFailureReason,
  cleanupError?: string,
): CaptureFailureRecord {
  if (handle.failure) return handle.failure;
  const record = buildFailure(handle, reason, cleanupError);
  handle.failure = record;
  // Identity-check both removal and recording. A delayed callback from an old
  // child must neither delete nor attach a failure to a replacement capture.
  if (captures.get(handle.sessionId) === handle) {
    captures.delete(handle.sessionId);
    rememberFailure(record);
  }
  return record;
}

function failedStopResult(record: CaptureFailureRecord): {
  stopped: false;
  outFile: string;
  status: "failed";
  reason: CaptureFailureReason;
  endedAt: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: string;
} {
  return {
    stopped: false,
    outFile: record.outFile,
    status: record.status,
    reason: record.reason,
    endedAt: record.endedAt,
    exitCode: record.exitCode,
    signal: record.signal,
    error: record.error,
  };
}

function ensureClosing(handle: CaptureHandle): Promise<void> {
  // Defer invocation by one microtask so even an accidental synchronous throw
  // from a platform close hook becomes a shared rejected promise.
  handle.closing ??= Promise.resolve().then(() => handle.close());
  return handle.closing;
}

/** Deadline helper that neither leaks a referenced timer nor leaves one behind. */
function settlesBefore(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (beforeDeadline: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(beforeDeadline);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    void promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

function beginUnexpectedCloseFinalization(handle: CaptureHandle): void {
  if (handle.stopRequested || handle.finalizing) return;
  const closing = ensureClosing(handle);
  handle.finalizing = (async () => {
    let cleanupError: string | undefined;
    try {
      await closing;
    } catch (error: unknown) {
      cleanupError = error instanceof Error ? error.message : String(error);
      handle.error ??= cleanupError;
      // stderr is safe for an stdio MCP; never write diagnostics to stdout.
      console.error(`[log-mcp] capture close failed: ${cleanupError}`);
    }
    const { exitCode, signal } = currentExit(handle);
    return terminalizeFailure(
      handle,
      exitFailureReason(handle, exitCode, signal),
      cleanupError,
    );
  })();
  // The finalizer catches platform-close failures and always resolves to a
  // terminal record, so observing it in the background cannot reject.
  void handle.finalizing;
}

function registerCapture(handle: CaptureHandle): void {
  // A new successfully registered generation supersedes any diagnostic record
  // for the same session without letting that record block restart.
  recentFailures.delete(handle.sessionId);
  captures.set(handle.sessionId, handle);
  handle.process.once("close", (exitCode, signal) => {
    handle.processClosed = true;
    handle.exitCode = exitCode;
    handle.signal = signal;
    if (!handle.stopRequested) {
      beginUnexpectedCloseFinalization(handle);
    } else if (handle.stopError) {
      // A close hook can fail while the child is still alive. Keep the handle
      // until this late close proves the writer is gone, then release the id
      // while retaining the cleanup failure for diagnostics.
      terminalizeFailure(handle, "cleanup_failed", handle.stopError);
    }
  });
  // The long-running child can exit in the narrow gap between the helper's
  // startup grace check and registration here. `close` may already have fired,
  // so also inspect the sticky exit/signal fields after installing the listener.
  if (handle.process.exitCode !== null || handle.process.signalCode !== null) {
    beginUnexpectedCloseFinalization(handle);
  }
}

export async function startCapture(opts: {
  sessionId: string;
  sessionDir: string; // absolute path to session dir
  device?: string;
  bufferArgs?: string[]; // e.g. ["-b", "main", "-b", "crash"]
}): Promise<{ outFile: string; device: string }> {
  reserveSession(opts.sessionId);
  try {
    const logsDir = path.join(opts.sessionDir, "logs");
    await mkdir(logsDir, { recursive: true });
    const outFile = path.join(logsDir, "logcat.txt");

    const { process: proc, device, close } = await spawnLogcat({
      device: opts.device,
      outFilePath: outFile,
      bufferArgs: opts.bufferArgs,
    });

    const handle: CaptureHandle = {
      sessionId: opts.sessionId,
      platform: "android",
      device,
      outFile,
      process: proc,
      startedAt: Date.now(),
      close,
      processClosed: false,
      stopRequested: false,
    };
    if (shuttingDown) {
      await close();
      throw new Error("Capture manager is shutting down");
    }
    registerCapture(handle);

    return { outFile, device };
  } finally {
    releaseSessionReservation(opts.sessionId);
  }
}

export async function stopCapture(
  sessionId: string,
): Promise<{
  stopped: boolean;
  outFile?: string;
  status?: "failed";
  reason?: CaptureFailureReason;
  endedAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
}> {
  // If start is between reservation and registration, wait for it to either
  // publish a handle or fail; never report stopped:false while it can still
  // become a live capture immediately afterwards.
  const pendingStart = startingSessions.get(sessionId)?.done;
  if (pendingStart) {
    const finished = await settlesBefore(pendingStart, SHUTDOWN_TIMEOUT_MS);
    if (!finished) {
      throw new Error(`Timed out waiting for capture "${sessionId}" to start before stopping it`);
    }
  }
  const handle = captures.get(sessionId);
  if (!handle) {
    const failure = recentFailures.get(sessionId);
    if (!failure) return { stopped: false };
    return failedStopResult(failure);
  }

  // An `exit` can become sticky just before the `close` callback is delivered.
  // Let the already-failed lifecycle win over a later stop request.
  if (
    !handle.stopRequested &&
    (handle.didReachLimit?.() ||
      handle.processClosed ||
      handle.process.exitCode !== null ||
      handle.process.signalCode !== null)
  ) {
    beginUnexpectedCloseFinalization(handle);
  }
  if (handle.finalizing) {
    const failure = await handle.finalizing;
    return failedStopResult(failure);
  }

  // Record intent before invoking close so its synchronous/next-tick process
  // events cannot be misclassified as an unexpected termination.
  handle.stopRequested = true;
  const closing = ensureClosing(handle);
  try {
    await closing;
    const { exitCode, signal } = currentExit(handle);
    // The byte limit can be reached after stopRequested is latched but before
    // the shared close hook finishes. Re-check it here so that narrow race does
    // not turn a truncated capture into a false clean stop.
    if (handle.didReachLimit?.() || isAbnormalRequestedStopExit(exitCode, signal)) {
      const failure = terminalizeFailure(
        handle,
        exitFailureReason(handle, exitCode, signal),
      );
      return failedStopResult(failure);
    }
    deleteIfCurrent(handle);
    return { stopped: true, outFile: handle.outFile };
  } catch (error) {
    handle.stopError = error instanceof Error ? error.message : String(error);
    handle.error ??= handle.stopError;
    // If the child is already gone, removal is safe even when final flushing
    // failed. If it is still alive, retain the handle so restart cannot overlap
    // an orphaned writer and a caller can retry/inspect the failure.
    if (
      handle.processClosed ||
      handle.process.exitCode !== null ||
      handle.process.signalCode !== null
    ) {
      terminalizeFailure(handle, "cleanup_failed", handle.stopError);
    }
    throw error;
  }
}

export async function startIosCapture(opts: {
  sessionId: string;
  sessionDir: string;
  simulatorUdid?: string;
  predicate?: string;
  level?: "default" | "info" | "debug";
}): Promise<{ outFile: string; udid: string }> {
  reserveSession(opts.sessionId);
  try {
    const logsDir = path.join(opts.sessionDir, "logs");
    await mkdir(logsDir, { recursive: true });
    const outFile = path.join(logsDir, "ios-log.txt");

    const spawnOpts: Parameters<typeof spawnIosLogStream>[0] = { outFilePath: outFile };
    if (opts.simulatorUdid !== undefined) spawnOpts.udid = opts.simulatorUdid;
    if (opts.predicate !== undefined) spawnOpts.predicate = opts.predicate;
    if (opts.level !== undefined) spawnOpts.level = opts.level;
    const { process: proc, udid, close } = await spawnIosLogStream(spawnOpts);

    const handle: CaptureHandle = {
      sessionId: opts.sessionId,
      platform: "ios",
      device: udid,
      outFile,
      process: proc,
      startedAt: Date.now(),
      close,
      processClosed: false,
      stopRequested: false,
    };
    if (shuttingDown) {
      await close();
      throw new Error("Capture manager is shutting down");
    }
    registerCapture(handle);

    return { outFile, udid };
  } finally {
    releaseSessionReservation(opts.sessionId);
  }
}

export async function startIosDeviceCapture(opts: {
  sessionId: string;
  sessionDir: string;
  udid?: string;
  processMatch?: string[];
  maxBytes?: number;
}): Promise<{ outFile: string; udid: string; maxBytes: number }> {
  reserveSession(opts.sessionId);
  try {
    const logsDir = path.join(opts.sessionDir, "logs");
    await mkdir(logsDir, { recursive: true });
    const outFile = path.join(logsDir, "ios-device-syslog.txt");

    const spawnOpts: Parameters<typeof spawnDeviceSyslog>[0] = { outFilePath: outFile };
    if (opts.udid !== undefined) spawnOpts.udid = opts.udid;
    if (opts.processMatch !== undefined) spawnOpts.processMatch = opts.processMatch;
    if (opts.maxBytes !== undefined) spawnOpts.maxBytes = opts.maxBytes;
    let handle: CaptureHandle | undefined;
    let pendingRuntimeError: string | undefined;
    spawnOpts.onError = (error) => {
      pendingRuntimeError = error.message;
      if (handle) handle.error = error.message;
      console.error(`[log-mcp] iOS device capture failed: ${error.message}`);
    };
    const {
      process: proc,
      udid,
      close,
      maxBytes,
      didReachLimit,
      getTerminationError,
    } = await spawnDeviceSyslog(spawnOpts);

    handle = {
      sessionId: opts.sessionId,
      platform: "ios-device",
      device: udid,
      outFile,
      process: proc,
      startedAt: Date.now(),
      close,
      processClosed: false,
      stopRequested: false,
      didReachLimit,
      getTerminationError,
      ...(pendingRuntimeError !== undefined ? { error: pendingRuntimeError } : {}),
    };
    if (shuttingDown) {
      await close();
      throw new Error("Capture manager is shutting down");
    }
    registerCapture(handle);

    return { outFile, udid, maxBytes };
  } finally {
    releaseSessionReservation(opts.sessionId);
  }
}

export function listCaptures(): Array<{
  sessionId: string;
  platform: CapturePlatform;
  device: string;
  outFile: string;
  startedAt: number;
  status: "running" | "stopping" | "failed";
  reason?: CaptureFailureReason;
  endedAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
}> {
  const active = Array.from(captures.values()).map((h) => ({
    sessionId: h.sessionId,
    platform: h.platform,
    device: h.device,
    outFile: h.outFile,
    startedAt: h.startedAt,
    status: (h.closing || h.didReachLimit?.() ? "stopping" : "running") as
      | "running"
      | "stopping",
    ...(h.error !== undefined ? { error: h.error } : {}),
  }));
  return [...active, ...recentFailures.values()];
}

// On process exit, clean up background captures.
function cleanup(signal: NodeJS.Signals = "SIGTERM") {
  for (const h of captures.values()) {
    try {
      h.process.kill(signal);
    } catch {
      // ignore
    }
  }
}
process.on("exit", () => cleanup());

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // A real-device start owns a spawned child during its startup grace window,
  // before it can be registered in `captures`. Let in-flight starts observe
  // `shuttingDown` and close that child before snapshotting active handles.
  const pendingStarts = Array.from(startingSessions.values(), (item) => item.done);
  await settlesBefore(Promise.allSettled(pendingStarts), SHUTDOWN_TIMEOUT_MS);
  const ids = Array.from(captures.keys());
  const stopped = await settlesBefore(
    Promise.allSettled(ids.map((id) => stopCapture(id))),
    SHUTDOWN_TIMEOUT_MS,
  );
  // A close hook may require TERM + KILL + file flush (up to 9 seconds). Only
  // force-kill anything still tracked after that full budget has elapsed.
  cleanup(stopped && captures.size === 0 ? "SIGTERM" : "SIGKILL");
  process.exit(exitCode);
}

process.on("SIGINT", () => void shutdown(130));
process.on("SIGTERM", () => void shutdown(143));
