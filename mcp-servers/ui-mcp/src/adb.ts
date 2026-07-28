// Minimal adb wrapper for ui-mcp. Kept local instead of shared to keep
// each workspace package self-contained for now. Refactor to a shared
// helper if a third consumer appears.

import { spawn } from "node:child_process";

const MAX_ADB_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_ADB_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_ADB_STDIN_BYTES = 64 * 1024;
const PROCESS_KILL_GRACE_MS = 250;
const PROCESS_FORCE_CLOSE_GRACE_MS = 1_000;

function adbBin(): string {
  // Resolve at call time so tests and embedding processes can safely provide a
  // scoped ADB implementation without reloading this module.
  return process.env.ADB_BIN ?? "adb";
}

export class AdbError extends Error {
  constructor(
    message: string,
    public readonly cmd: string,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = "AdbError";
  }
}

export class AdbDeadlineError extends AdbError {
  constructor(message: string, cmd: string, stderr?: string) {
    super(message, cmd, stderr);
    this.name = "AdbDeadlineError";
  }
}

export class AdbAbortError extends AdbError {
  constructor(message: string, cmd: string, stderr?: string) {
    super(message, cmd, stderr);
    this.name = "AdbAbortError";
  }
}

function deviceArgs(device?: string): string[] {
  return device ? ["-s", device] : [];
}

export interface RunAdbOptions {
  timeoutMs?: number;
  /** Absolute Date.now()-based deadline shared across a multi-command action. */
  deadlineAtMs?: number;
  /** Safe argv used only in diagnostics when actual argv contains secrets. */
  displayArgs?: string[];
  /** Suppress child error text/stderr that may echo a secret argv value. */
  redactFailureOutput?: boolean;
  /** MCP request cancellation; aborts the whole adb process group. */
  signal?: AbortSignal;
  /** Optional command body sent over stdin instead of exposing it in argv. */
  stdinText?: string;
}

/**
 * Execute argv directly with bounded output and a hard TERM -> KILL lifecycle.
 * Node's `execFile({ timeout })` only sends SIGTERM and can wait forever when a
 * broken/fake adb or one of its pipe-inheriting descendants ignores that signal.
 */
function execAdbWithHardTimeout(
  bin: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  stdinText?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(bin, args, {
      detached,
      shell: false,
      windowsHide: true,
      stdio: [stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let bufferedBytes = 0;
    let settled = false;
    let closed = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let spawnError: NodeJS.ErrnoException | undefined;
    let forcedFailure: { message: string; code: string } | undefined;
    let termTimer: ReturnType<typeof setTimeout> | undefined;
    let forceCloseTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = () => {
      if (termTimer !== undefined) clearTimeout(termTimer);
      if (forceCloseTimer !== undefined) clearTimeout(forceCloseTimer);
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", onAbort);
    };

    const capturedStdout = () => Buffer.concat(stdoutChunks).toString("utf8");
    const capturedStderr = () => Buffer.concat(stderrChunks).toString("utf8");

    const failure = (
      message: string,
      code: string | number | undefined,
      cause?: unknown,
    ): NodeJS.ErrnoException & { stderr?: string; signal?: string } => {
      const error = new Error(message, cause === undefined ? undefined : { cause }) as
        NodeJS.ErrnoException & { stderr?: string; signal?: string };
      if (code !== undefined) error.code = String(code);
      if (exitSignal !== null) error.signal = exitSignal;
      error.stderr = capturedStderr();
      return error;
    };

    const finalize = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (forcedFailure) {
        reject(failure(forcedFailure.message, forcedFailure.code));
      } else if (spawnError) {
        const error = failure(
          `failed to start adb: ${spawnError.message}`,
          spawnError.code,
          spawnError,
        );
        reject(error);
      } else if (exitCode !== 0) {
        reject(
          failure(
            `adb exited with code ${exitCode ?? "null"}${exitSignal ? ` (signal ${exitSignal})` : ""}`,
            exitCode ?? undefined,
          ),
        );
      } else {
        resolve(capturedStdout());
      }
    };

    const sendSignal = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      if (detached) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        }
      }
      try {
        child.kill(signal);
      } catch {
        // A concurrent natural exit is equivalent to successful termination.
      }
    };

    const forceCloseAfterKill = () => {
      if (settled || forceCloseTimer !== undefined) return;
      forceCloseTimer = setTimeout(() => {
        if (settled) return;
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finalize();
      }, PROCESS_FORCE_CLOSE_GRACE_MS);
    };

    const beginTermination = (message: string, code: string) => {
      if (settled || forcedFailure !== undefined) return;
      forcedFailure = { message, code };
      sendSignal("SIGTERM");
      termTimer = setTimeout(() => {
        if (!settled) {
          sendSignal("SIGKILL");
          forceCloseAfterKill();
        }
      }, PROCESS_KILL_GRACE_MS);
    };

    const onAbort = () => {
      beginTermination("adb operation aborted by the MCP caller", "ABORT_ERR");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    if (stdinText !== undefined) {
      const encodedInput = Buffer.from(stdinText, "utf8");
      if (encodedInput.length > MAX_ADB_STDIN_BYTES) {
        beginTermination(
          `adb stdin exceeded ${MAX_ADB_STDIN_BYTES} byte limit`,
          "ERR_CHILD_PROCESS_STDIN_MAXBUFFER",
        );
        child.stdin?.destroy();
      } else if (forcedFailure === undefined) {
        child.stdin?.once("error", (error) => {
          beginTermination(`failed writing adb stdin: ${error.message}`, "EIO");
        });
        child.stdin?.end(encodedInput);
      }
    }

    const appendBounded = (target: Buffer[], chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_ADB_OUTPUT_BYTES - bufferedBytes;
      if (remaining > 0) {
        const accepted = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);
        target.push(Buffer.from(accepted));
        bufferedBytes += accepted.length;
      }
      if (buffer.length > remaining) {
        beginTermination(
          `adb output exceeded maxBuffer=${MAX_ADB_OUTPUT_BYTES}`,
          "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        );
      }
    };

    child.stdout?.on("data", (chunk: Buffer | string) => appendBounded(stdoutChunks, chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => appendBounded(stderrChunks, chunk));
    child.stdout?.on("error", (error) => {
      beginTermination(`failed reading adb stdout: ${error.message}`, "EIO");
    });
    child.stderr?.on("error", (error) => {
      beginTermination(`failed reading adb stderr: ${error.message}`, "EIO");
    });
    child.once("error", (error) => {
      spawnError = error;
      // Spawn failures normally emit close as well. Retain a bounded fallback in
      // case a platform binding violates that lifecycle.
      setImmediate(() => {
        if (!closed && child.pid === undefined) finalize();
      });
    });
    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    child.once("close", (code, signal) => {
      closed = true;
      exitCode = code;
      exitSignal = signal;
      finalize();
    });

    timeoutTimer = setTimeout(() => {
      beginTermination(`adb timed out after ${timeoutMs}ms`, "ETIMEDOUT");
    }, timeoutMs);
  });
}

export function remainingDeadlineMs(deadlineAtMs: number): number {
  if (!Number.isFinite(deadlineAtMs)) {
    throw new RangeError("deadlineAtMs must be a finite absolute timestamp");
  }
  const remaining = Math.ceil(deadlineAtMs - Date.now());
  if (remaining <= 0) {
    throw new AdbDeadlineError(
      "ADB operation deadline elapsed",
      `${adbBin()} [deadline]`,
    );
  }
  return remaining;
}

export function adbErrorFromFailure(
  args: string[],
  error: NodeJS.ErrnoException & { stderr?: string; code?: string | number; signal?: string },
  opts: RunAdbOptions = {},
): AdbError {
  const displayArgs = opts.displayArgs ?? args;
  const detail = opts.redactFailureOutput
    ? `process failed (code=${error.code ?? "unknown"}, signal=${error.signal ?? "none"})`
    : error.message;
  const diagnosticStderr = (() => {
    if (opts.redactFailureOutput && error.stderr) {
      return "[adb stderr redacted because the command contained sensitive input]";
    }
    if (!error.stderr) return error.stderr;
    const encoded = Buffer.from(error.stderr, "utf8");
    if (encoded.length <= MAX_ADB_DIAGNOSTIC_BYTES) return error.stderr;
    let end = MAX_ADB_DIAGNOSTIC_BYTES;
    while (end > 0 && (encoded[end] ?? 0) >> 6 === 0b10) end -= 1;
    return `${encoded.subarray(0, end).toString("utf8")}\n...[adb stderr truncated]`;
  })();
  return new AdbError(
    `adb ${displayArgs.join(" ")} failed: ${detail}`,
    `${adbBin()} ${displayArgs.join(" ")}`,
    diagnosticStderr,
  );
}

export async function runAdb(args: string[], opts: RunAdbOptions = {}): Promise<string> {
  const normalTimeout = opts.timeoutMs ?? 30_000;
  if (!Number.isFinite(normalTimeout) || normalTimeout <= 0) {
    throw new RangeError("timeoutMs must be a positive finite number");
  }
  if (opts.signal?.aborted) {
    const displayArgs = opts.displayArgs ?? args;
    const cmd = `${adbBin()} ${displayArgs.join(" ")}`;
    throw new AdbAbortError(`${cmd} aborted by the MCP caller`, cmd);
  }
  let timeout = normalTimeout;
  let deadlineLimited = false;
  if (opts.deadlineAtMs !== undefined) {
    const remaining = remainingDeadlineMs(opts.deadlineAtMs);
    if (remaining <= timeout) {
      timeout = remaining;
      deadlineLimited = true;
    }
  }
  try {
    return await execAdbWithHardTimeout(
      adbBin(),
      args,
      timeout,
      opts.signal,
      opts.stdinText,
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stderr?: string;
      code?: string | number;
      signal?: string;
    };
    const failure = adbErrorFromFailure(args, e, opts);
    if (e.code === "ABORT_ERR") {
      throw new AdbAbortError(
        `${failure.cmd} aborted by the MCP caller`,
        failure.cmd,
        failure.stderr,
      );
    }
    if (
      opts.deadlineAtMs !== undefined &&
      deadlineLimited &&
      e.code === "ETIMEDOUT"
    ) {
      throw new AdbDeadlineError(
        `${failure.cmd} exceeded the shared operation deadline`,
        failure.cmd,
        failure.stderr,
      );
    }
    throw failure;
  }
}

export async function listDevices(
  opts: RunAdbOptions = {},
): Promise<Array<{ serial: string; state: string }>> {
  const out = await runAdb(["devices"], opts);
  const lines = out.split("\n").slice(1);
  const devices: Array<{ serial: string; state: string }> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const serial = parts[0];
    const state = parts[1];
    if (serial && state) devices.push({ serial, state });
  }
  return devices;
}

export async function pickDevice(
  preferred?: string,
  opts: RunAdbOptions = {},
): Promise<string> {
  const devices = (await listDevices(opts)).filter((d) => d.state === "device");
  if (preferred) {
    if (!devices.some((d) => d.serial === preferred)) {
      throw new AdbError(`Device "${preferred}" not found or not ready`, "adb devices");
    }
    return preferred;
  }
  if (devices.length === 0) {
    throw new AdbError("No adb devices connected and ready", "adb devices");
  }
  if (devices.length > 1) {
    throw new AdbError(
      `Multiple devices (${devices.map((d) => d.serial).join(", ")}); pass "device" explicitly`,
      "adb devices",
    );
  }
  return devices[0]!.serial;
}

export async function adbShell(
  device: string | undefined,
  cmd: string,
  opts: RunAdbOptions = {},
): Promise<string> {
  const target = await pickDevice(device, opts);
  return runAdb([...deviceArgs(target), "shell", cmd], opts);
}

export async function inputTap(opts: {
  x: number;
  y: number;
  device?: string;
  deadlineAtMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const adbOpts: RunAdbOptions = {
    ...(opts.deadlineAtMs === undefined ? {} : { deadlineAtMs: opts.deadlineAtMs }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  };
  const target = await pickDevice(opts.device, adbOpts);
  await runAdb(
    [...deviceArgs(target), "shell", "input", "tap", String(opts.x), String(opts.y)],
    adbOpts,
  );
}

/** Quote one argument for the remote POSIX shell used by `adb shell`. */
export function quoteAdbShellArg(value: string): string {
  if (value.includes("\0")) {
    throw new RangeError("adb shell arguments must not contain NUL bytes");
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export async function inputText(opts: {
  text: string;
  device?: string;
  deadlineAtMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const adbOpts: RunAdbOptions = {
    ...(opts.deadlineAtMs === undefined ? {} : { deadlineAtMs: opts.deadlineAtMs }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  };
  const target = await pickDevice(opts.device, adbOpts);
  // adb concatenates arguments after `shell` into a command interpreted by the
  // device shell. Passing raw text as a nominal argv therefore still permits
  // separators such as `;`, `&`, `|` and newlines to execute another command.
  // Quote the complete input argument for that remote shell; %s is Android's
  // documented encoding for a space in `input text`.
  const encoded = opts.text.replace(/ /g, "%s");
  const command = `input text ${quoteAdbShellArg(encoded)}`;
  await runAdb([...deviceArgs(target), "shell"], {
    ...adbOpts,
    stdinText: `${command}\nexit\n`,
    displayArgs: [
      ...deviceArgs(target),
      "shell",
      "input text '[REDACTED]'",
    ],
    redactFailureOutput: true,
  });
}

export function deleteKeyEvents(observedCharacters: number): string[] {
  if (
    !Number.isSafeInteger(observedCharacters) ||
    observedCharacters < 0 ||
    observedCharacters > 10_000
  ) {
    throw new RangeError(
      "observedCharacters must be a safe integer between 0 and 10000",
    );
  }
  return Array.from({ length: observedCharacters }, () => "KEYCODE_DEL");
}

/**
 * Best-effort clearing for the currently focused field. Move to the end, then
 * send exactly the observed number of DEL events. The caller must re-read and
 * verify the same field afterwards; extra deletes can damage adjacent OTP/PIN
 * cells after focus automatically moves.
 */
export async function clearFocusedText(opts: {
  device?: string;
  observedCharacters: number;
  deadlineAtMs?: number;
  signal?: AbortSignal;
  /** Locks mutation uncertainty immediately before the DEL command starts. */
  onDeleteStarted?: () => void;
}): Promise<void> {
  const adbOpts: RunAdbOptions = {
    ...(opts.deadlineAtMs === undefined ? {} : { deadlineAtMs: opts.deadlineAtMs }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  };
  const target = await pickDevice(opts.device, adbOpts);
  const deleteEvents = deleteKeyEvents(opts.observedCharacters);
  await runAdb(
    [
      ...deviceArgs(target),
      "shell",
      "input",
      "keyevent",
      "KEYCODE_MOVE_END",
    ],
    adbOpts,
  );
  if (deleteEvents.length === 0) return;
  opts.onDeleteStarted?.();
  await runAdb(
    [
      ...deviceArgs(target),
      "shell",
      "input",
      "keyevent",
      ...deleteEvents,
    ],
    adbOpts,
  );
}
