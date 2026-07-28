// Tracks background logcat capture processes keyed by session id.

import path from "node:path";
import { pickDevice as pickAndroidDevice, spawnLogcat } from "./adb.js";
import { pickSimulator, spawnIosLogStream } from "./ios.js";
import { beginDeviceSyslog, pickDevice as pickIosDevice } from "./ios-device.js";
import type { ChildProcess } from "node:child_process";
import {
  DEFAULT_CAPTURE_MAX_BYTES,
  MAX_CAPTURE_MAX_BYTES,
  openCaptureOutput,
  validateCaptureMaxBytes,
  type OpenedCaptureOutput,
} from "./capture-output.js";
import {
  assertDirectChild,
  openSecureDirectory,
  type SecureDirectory,
} from "./secure-directory.js";

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
  outputIdentity: OutputIdentity;
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
  outFile: string;
  abortController: AbortController;
  outputIdentity?: OutputIdentity;
  pending?: PendingCapture;
  cleanup?: Promise<void>;
}
const startingSessions = new Map<string, StartReservation>();
const MAX_CONCURRENT_CAPTURES = 8;
const STOP_TIMEOUT_MS = 3_000;
const SHUTDOWN_TIMEOUT_MS = STOP_TIMEOUT_MS * 3 + 1_000;
let shuttingDown = false;
let shutdownPromise: Promise<void> | undefined;

interface OutputIdentity {
  canonicalPath: string;
  inodeKey: string;
}

interface PendingCapture {
  process: ChildProcess;
  close: () => Promise<void>;
}

function evidenceCheckedClose(
  platformClose: () => Promise<void>,
  output: OpenedCaptureOutput,
  directory: SecureDirectory,
): () => Promise<void> {
  let promise: Promise<void> | undefined;
  return () => {
    promise ??= (async () => {
      const failures: unknown[] = [];
      try {
        await platformClose();
      } catch (error) {
        failures.push(error);
      }
      try {
        await output.assertPathUnchanged();
      } catch (error) {
        failures.push(error);
      }
      try {
        await directory.assertUnchanged();
      } catch (error) {
        failures.push(error);
      }
      try {
        await directory.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Capture stopped but its private output evidence failed verification",
        );
      }
    })();
    return promise;
  };
}

export { DEFAULT_CAPTURE_MAX_BYTES, MAX_CAPTURE_MAX_BYTES };

function normalizedOutputPath(outFile: string): string {
  return path.resolve(outFile);
}

function outputOwner(outFile: string): string | undefined {
  const normalized = normalizedOutputPath(outFile);
  for (const handle of captures.values()) {
    if (normalizedOutputPath(handle.outFile) === normalized) return handle.sessionId;
  }
  for (const [sessionId, reservation] of startingSessions) {
    if (reservation.outFile === normalized) return sessionId;
  }
  return undefined;
}

function outputIdentityOwner(
  identity: OutputIdentity,
  excludingSessionId: string,
): string | undefined {
  const conflicts = (candidate: OutputIdentity | undefined) =>
    candidate !== undefined &&
    (candidate.canonicalPath === identity.canonicalPath ||
      candidate.inodeKey === identity.inodeKey);
  for (const handle of captures.values()) {
    if (handle.sessionId !== excludingSessionId && conflicts(handle.outputIdentity)) {
      return handle.sessionId;
    }
  }
  for (const [sessionId, reservation] of startingSessions) {
    if (sessionId !== excludingSessionId && conflicts(reservation.outputIdentity)) {
      return sessionId;
    }
  }
  return undefined;
}

function reserveSession(sessionId: string, outFile: string): StartReservation {
  if (shuttingDown) throw new Error("Capture manager is shutting down");
  if (captures.has(sessionId) || startingSessions.has(sessionId)) {
    throw new Error(`Capture already running for session "${sessionId}"`);
  }
  const owner = outputOwner(outFile);
  if (owner !== undefined) {
    throw new Error(
      `Capture output "${outFile}" is already in use by session "${owner}"`,
    );
  }
  if (captures.size + startingSessions.size >= MAX_CONCURRENT_CAPTURES) {
    throw new Error(
      `Capture concurrency limit reached (${MAX_CONCURRENT_CAPTURES}); stop an existing capture before starting another`,
    );
  }
  // Reserve before the first await so concurrent starts cannot both spawn.
  let resolve!: () => void;
  const done = new Promise<void>((doneResolve) => {
    resolve = doneResolve;
  });
  const reservation: StartReservation = {
    done,
    resolve,
    outFile: normalizedOutputPath(outFile),
    abortController: new AbortController(),
  };
  startingSessions.set(sessionId, reservation);
  return reservation;
}

function releaseSessionReservation(
  sessionId: string,
  expected: StartReservation,
): void {
  const reservation = startingSessions.get(sessionId);
  if (reservation !== expected) return;
  startingSessions.delete(sessionId);
  reservation.resolve();
}

function assertStartAllowed(reservation: StartReservation): void {
  if (shuttingDown) {
    throw new Error("Capture manager is shutting down");
  }
  if (reservation.abortController.signal.aborted) {
    throw new Error("Capture start was cancelled");
  }
}

function claimOutputIdentity(
  sessionId: string,
  reservation: StartReservation,
  output: OpenedCaptureOutput,
): OutputIdentity {
  assertStartAllowed(reservation);
  const identity: OutputIdentity = {
    canonicalPath: output.canonicalPath,
    inodeKey: output.inodeKey,
  };
  const owner = outputIdentityOwner(identity, sessionId);
  if (owner !== undefined) {
    throw new Error(
      `Capture output "${output.requestedPath}" resolves to a file already in use by session "${owner}"`,
    );
  }
  reservation.outputIdentity = identity;
  return identity;
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

function processIsAlive(process: ChildProcess): boolean {
  return process.exitCode === null && process.signalCode === null;
}

async function closePendingCapture(pending: PendingCapture): Promise<void> {
  let closeError: unknown;
  try {
    await pending.close();
  } catch (error) {
    closeError = error;
  }
  if (processIsAlive(pending.process)) {
    pending.process.kill("SIGKILL");
    const closed = new Promise<void>((resolve) => {
      if (!processIsAlive(pending.process)) {
        resolve();
        return;
      }
      pending.process.once("close", () => resolve());
    });
    await settlesBefore(closed, STOP_TIMEOUT_MS);
  }
  if (processIsAlive(pending.process)) {
    throw new Error("Provisional capture process did not stop after SIGKILL");
  }
  if (closeError) throw closeError;
}

function requestReservationCleanup(reservation: StartReservation): Promise<void> {
  reservation.abortController.abort();
  if (!reservation.pending) return Promise.resolve();
  reservation.cleanup ??= closePendingCapture(reservation.pending);
  // shutdown/starting code awaits this promise; this observation prevents an
  // early rejection from becoming an unhandled rejection in the meantime.
  void reservation.cleanup.catch(() => undefined);
  return reservation.cleanup;
}

function attachPendingCapture(
  reservation: StartReservation,
  pending: PendingCapture,
): void {
  reservation.pending = pending;
  if (shuttingDown || reservation.abortController.signal.aborted) {
    void requestReservationCleanup(reservation);
  }
}

async function awaitCaptureReady(
  reservation: StartReservation,
  pending: PendingCapture & {
    ready: Promise<void>;
    didReachLimit?: () => boolean;
  },
): Promise<void> {
  attachPendingCapture(reservation, pending);
  try {
    await pending.ready;
    assertStartAllowed(reservation);
  } catch (error) {
    if (
      pending.didReachLimit?.() &&
      !shuttingDown &&
      !reservation.abortController.signal.aborted
    ) {
      // Preserve a startup-time limit as an observable terminal lifecycle. The
      // caller registers the already-closed handle; sticky exit state then
      // finalizes it as limit_reached.
      await pending.close();
      return;
    }
    let cleanupError: unknown;
    try {
      await requestReservationCleanup(reservation);
    } catch (cleanupCause) {
      cleanupError = cleanupCause;
    }
    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Capture startup failed and its provisional process could not be cleaned up`,
      );
    }
    throw error;
  }
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
  maxBytes?: number;
}): Promise<{ outFile: string; device: string; maxBytes: number }> {
  const maxBytes = validateCaptureMaxBytes(opts.maxBytes);
  const logsDir = path.join(opts.sessionDir, "logs");
  const outFile = path.join(logsDir, "logcat.txt");
  const reservation = reserveSession(opts.sessionId, outFile);
  let output: OpenedCaptureOutput | undefined;
  let outputHandedOff = false;
  let directory: SecureDirectory | undefined;
  let directoryHandedOff = false;
  try {
    directory = await openSecureDirectory(logsDir);
    assertStartAllowed(reservation);
    const device = await pickAndroidDevice(
      opts.device,
      reservation.abortController.signal,
    );
    assertStartAllowed(reservation);
    await directory.assertUnchanged();
    output = await openCaptureOutput(path.join(directory.canonicalPath, "logcat.txt"));
    assertDirectChild(directory, output.canonicalPath);
    await directory.assertUnchanged();
    const outputIdentity = claimOutputIdentity(opts.sessionId, reservation, output);

    let handle: CaptureHandle | undefined;
    let pendingRuntimeError: string | undefined;
    const started = spawnLogcat({
      device,
      output,
      bufferArgs: opts.bufferArgs,
      maxBytes,
      onError: (error) => {
        pendingRuntimeError = error.message;
        if (handle) handle.error = error.message;
        console.error(`[log-mcp] Android capture failed: ${error.message}`);
      },
    });
    outputHandedOff = true;
    await awaitCaptureReady(reservation, started);

    handle = {
      sessionId: opts.sessionId,
      platform: "android",
      device,
      outFile: output.canonicalPath,
      process: started.process,
      startedAt: Date.now(),
      close: evidenceCheckedClose(started.close, output, directory),
      processClosed: false,
      stopRequested: false,
      didReachLimit: started.didReachLimit,
      getTerminationError: started.getTerminationError,
      outputIdentity,
      ...(pendingRuntimeError !== undefined ? { error: pendingRuntimeError } : {}),
    };
    if (shuttingDown) {
      await started.close();
      throw new Error("Capture manager is shutting down");
    }
    directoryHandedOff = true;
    registerCapture(handle);

    return { outFile: output.canonicalPath, device, maxBytes };
  } finally {
    if (output && !outputHandedOff) await output.close().catch(() => undefined);
    if (directory && !directoryHandedOff) await directory.close().catch(() => undefined);
    releaseSessionReservation(opts.sessionId, reservation);
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
  // A stop request owns a lifecycle even while it is still starting. Cancel
  // device discovery and any provisional child first; merely waiting can time
  // out and let the original start publish an unbounded writer afterwards.
  const reservation = startingSessions.get(sessionId);
  let cancelledOutFile: string | undefined;
  if (reservation) {
    cancelledOutFile = reservation.outFile;
    const cleanup = requestReservationCleanup(reservation);
    const cancellation = Promise.allSettled([reservation.done, cleanup]);
    const finished = await settlesBefore(cancellation, SHUTDOWN_TIMEOUT_MS);
    if (!finished) {
      throw new Error(`Timed out cancelling capture "${sessionId}" while it was starting`);
    }
    const [, cleanupResult] = await cancellation;
    if (cleanupResult?.status === "rejected") {
      throw new Error(
        `Failed to clean up capture "${sessionId}" while it was starting: ${
          cleanupResult.reason instanceof Error
            ? cleanupResult.reason.message
            : String(cleanupResult.reason)
        }`,
      );
    }
  }
  const handle = captures.get(sessionId);
  if (!handle) {
    const failure = recentFailures.get(sessionId);
    if (!failure) {
      return cancelledOutFile === undefined
        ? { stopped: false }
        : { stopped: true, outFile: cancelledOutFile };
    }
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
  maxBytes?: number;
}): Promise<{ outFile: string; udid: string; maxBytes: number }> {
  const maxBytes = validateCaptureMaxBytes(opts.maxBytes);
  const logsDir = path.join(opts.sessionDir, "logs");
  const outFile = path.join(logsDir, "ios-log.txt");
  const reservation = reserveSession(opts.sessionId, outFile);
  let output: OpenedCaptureOutput | undefined;
  let outputHandedOff = false;
  let directory: SecureDirectory | undefined;
  let directoryHandedOff = false;
  try {
    directory = await openSecureDirectory(logsDir);
    assertStartAllowed(reservation);
    const udid = await pickSimulator(
      opts.simulatorUdid,
      reservation.abortController.signal,
    );
    assertStartAllowed(reservation);
    await directory.assertUnchanged();
    output = await openCaptureOutput(path.join(directory.canonicalPath, "ios-log.txt"));
    assertDirectChild(directory, output.canonicalPath);
    await directory.assertUnchanged();
    const outputIdentity = claimOutputIdentity(opts.sessionId, reservation, output);

    let handle: CaptureHandle | undefined;
    let pendingRuntimeError: string | undefined;
    const spawnOpts: Parameters<typeof spawnIosLogStream>[0] = {
      udid,
      output,
      maxBytes,
      onError: (error) => {
        pendingRuntimeError = error.message;
        if (handle) handle.error = error.message;
        console.error(`[log-mcp] iOS Simulator capture failed: ${error.message}`);
      },
    };
    if (opts.predicate !== undefined) spawnOpts.predicate = opts.predicate;
    if (opts.level !== undefined) spawnOpts.level = opts.level;
    const started = spawnIosLogStream(spawnOpts);
    outputHandedOff = true;
    await awaitCaptureReady(reservation, started);

    handle = {
      sessionId: opts.sessionId,
      platform: "ios",
      device: udid,
      outFile: output.canonicalPath,
      process: started.process,
      startedAt: Date.now(),
      close: evidenceCheckedClose(started.close, output, directory),
      processClosed: false,
      stopRequested: false,
      didReachLimit: started.didReachLimit,
      getTerminationError: started.getTerminationError,
      outputIdentity,
      ...(pendingRuntimeError !== undefined ? { error: pendingRuntimeError } : {}),
    };
    if (shuttingDown) {
      await started.close();
      throw new Error("Capture manager is shutting down");
    }
    directoryHandedOff = true;
    registerCapture(handle);

    return { outFile: output.canonicalPath, udid, maxBytes };
  } finally {
    if (output && !outputHandedOff) await output.close().catch(() => undefined);
    if (directory && !directoryHandedOff) await directory.close().catch(() => undefined);
    releaseSessionReservation(opts.sessionId, reservation);
  }
}

export async function startIosDeviceCapture(opts: {
  sessionId: string;
  sessionDir: string;
  udid?: string;
  processMatch?: string[];
  maxBytes?: number;
}): Promise<{ outFile: string; udid: string; maxBytes: number }> {
  const requestedMaxBytes = validateCaptureMaxBytes(opts.maxBytes);
  const logsDir = path.join(opts.sessionDir, "logs");
  const outFile = path.join(logsDir, "ios-device-syslog.txt");
  const reservation = reserveSession(opts.sessionId, outFile);
  let output: OpenedCaptureOutput | undefined;
  let outputHandedOff = false;
  let directory: SecureDirectory | undefined;
  let directoryHandedOff = false;
  try {
    directory = await openSecureDirectory(logsDir);
    assertStartAllowed(reservation);
    const udid = await pickIosDevice(
      opts.udid,
      reservation.abortController.signal,
    );
    assertStartAllowed(reservation);
    await directory.assertUnchanged();
    output = await openCaptureOutput(
      path.join(directory.canonicalPath, "ios-device-syslog.txt"),
    );
    assertDirectChild(directory, output.canonicalPath);
    await directory.assertUnchanged();
    const outputIdentity = claimOutputIdentity(opts.sessionId, reservation, output);

    const spawnOpts: Parameters<typeof beginDeviceSyslog>[0] = {
      udid,
      output,
      maxBytes: requestedMaxBytes,
    };
    if (opts.processMatch !== undefined) spawnOpts.processMatch = opts.processMatch;
    let handle: CaptureHandle | undefined;
    let pendingRuntimeError: string | undefined;
    spawnOpts.onError = (error) => {
      pendingRuntimeError = error.message;
      if (handle) handle.error = error.message;
      console.error(`[log-mcp] iOS device capture failed: ${error.message}`);
    };
    const started = beginDeviceSyslog(spawnOpts);
    outputHandedOff = true;
    await awaitCaptureReady(reservation, started);

    handle = {
      sessionId: opts.sessionId,
      platform: "ios-device",
      device: udid,
      outFile: output.canonicalPath,
      process: started.process,
      startedAt: Date.now(),
      close: evidenceCheckedClose(started.close, output, directory),
      processClosed: false,
      stopRequested: false,
      didReachLimit: started.didReachLimit,
      getTerminationError: started.getTerminationError,
      outputIdentity,
      ...(pendingRuntimeError !== undefined ? { error: pendingRuntimeError } : {}),
    };
    if (shuttingDown) {
      await started.close();
      throw new Error("Capture manager is shutting down");
    }
    directoryHandedOff = true;
    registerCapture(handle);

    return { outFile: output.canonicalPath, udid, maxBytes: started.maxBytes };
  } finally {
    if (output && !outputHandedOff) await output.close().catch(() => undefined);
    if (directory && !directoryHandedOff) await directory.close().catch(() => undefined);
    releaseSessionReservation(opts.sessionId, reservation);
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

/**
 * Stop every capture and reject future starts. The shared promise makes stdin
 * EOF, transport close and OS signal handlers safe to race with one another.
 */
export function shutdownCaptures(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    // No reservation can be added after shuttingDown is latched. Abort device
    // discovery immediately and close provisional children in parallel with
    // already registered captures; never wait for one class before stopping the
    // other.
    const reservations = Array.from(startingSessions.values());
    const provisionalCleanup = reservations.map((reservation) =>
      requestReservationCleanup(reservation),
    );
    const pendingStarts = reservations.map((reservation) => reservation.done);
    const ids = Array.from(captures.keys());
    const activeStops = ids.map((id) => stopCapture(id));
    const allShutdownWork = Promise.allSettled([
      ...provisionalCleanup,
      ...pendingStarts,
      ...activeStops,
    ]);

    const graceful = await settlesBefore(allShutdownWork, STOP_TIMEOUT_MS);
    if (!graceful) {
      // TERM/normal close did not finish promptly. Force-kill both registered
      // and provisional generations, then spend only the remaining global
      // deadline waiting for their shared close/finally paths to settle.
      cleanup("SIGKILL");
      for (const reservation of reservations) {
        if (reservation.pending && processIsAlive(reservation.pending.process)) {
          reservation.pending.process.kill("SIGKILL");
        }
      }
      const remaining = Math.max(1, deadline - Date.now());
      await settlesBefore(allShutdownWork, remaining);
    }

    if (captures.size > 0) {
      // close() already attempted TERM then KILL. One final best-effort KILL is
      // useful for a platform hook that failed before reaching that sequence.
      cleanup("SIGKILL");
      const closed = Array.from(captures.values(), (handle) => {
        if (
          handle.processClosed ||
          handle.process.exitCode !== null ||
          handle.process.signalCode !== null
        ) {
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          handle.process.once("close", () => resolve());
        });
      });
      const remaining = Math.max(1, deadline - Date.now());
      await settlesBefore(Promise.allSettled(closed), remaining);
    }

    if (captures.size > 0 || startingSessions.size > 0) {
      throw new Error(
        `Failed to stop ${captures.size} active and ${startingSessions.size} starting capture process(es) during shutdown deadline`,
      );
    }
  })();
  return shutdownPromise;
}

function shutdownAndExit(exitCode: number): void {
  void shutdownCaptures().then(
    () => process.exit(exitCode),
    (error: unknown) => {
      // Do not force-exit while a child may still be alive: keeping the parent
      // around is safer than orphaning an unbounded log writer.
      console.error(
        `[log-mcp] shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = exitCode;
    },
  );
}

process.on("SIGINT", () => shutdownAndExit(130));
process.on("SIGTERM", () => shutdownAndExit(143));
