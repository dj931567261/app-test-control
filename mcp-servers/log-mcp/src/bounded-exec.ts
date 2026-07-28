import { spawn, type ChildProcess } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const TERMINATION_GRACE_MS = 500;
const FORCE_CLOSE_GRACE_MS = 2_000;
export const MAX_COMMAND_DIAGNOSTIC_BYTES = 64 * 1024;

export interface BoundedExecOptions {
  timeoutMs?: number;
  /** Combined stdout + stderr byte limit. */
  maxBufferBytes?: number;
  signal?: AbortSignal;
}

export interface BoundedExecResult {
  stdout: string;
  stderr: string;
}

export class BoundedExecError extends Error {
  readonly code?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(
    message: string,
    options: {
      stdout?: string;
      stderr?: string;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BoundedExecError";
    const causeCode = (options.cause as NodeJS.ErrnoException | undefined)?.code;
    if (causeCode !== undefined) this.code = causeCode;
    this.stdout = options.stdout ?? "";
    this.stderr = options.stderr ?? "";
    this.exitCode = options.exitCode ?? null;
    this.signal = options.signal ?? null;
  }
}

/** Bound helper stderr before it is embedded in an MCP error response. */
export function truncateCommandDiagnostic(
  value: string | undefined,
  maxBytes: number = MAX_COMMAND_DIAGNOSTIC_BYTES,
): string | undefined {
  if (value === undefined) return undefined;
  positiveSafeInteger(maxBytes, "maxBytes");
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (encoded[end] ?? 0) >> 6 === 0b10) end -= 1;
  return `${encoded.subarray(0, end).toString("utf8")}\n...[diagnostic truncated; original_bytes=${encoded.length}, limit_bytes=${maxBytes}]`;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function abortMessage(signal: AbortSignal): string {
  const reason = signal.reason;
  return reason instanceof Error && reason.message
    ? `command aborted: ${reason.message}`
    : "command aborted";
}

/**
 * Execute an argv-only command with bounded output and hard process cleanup.
 *
 * Node's execFile timeout/AbortSignal/maxBuffer paths initially send SIGTERM,
 * but the returned promise can remain pending forever when a helper ignores
 * TERM. This runner owns a process group on POSIX, escalates TERM to KILL, and
 * settles only after the child's stdio has closed (or has been forcibly
 * destroyed after a final bounded drain window).
 */
export async function execFileBounded(
  bin: string,
  args: readonly string[],
  options: BoundedExecOptions = {},
): Promise<BoundedExecResult> {
  const timeoutMs = positiveSafeInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "timeoutMs",
  );
  const maxBufferBytes = positiveSafeInteger(
    options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
    "maxBufferBytes",
  );
  if (options.signal?.aborted) {
    throw new BoundedExecError(abortMessage(options.signal), {
      cause: options.signal.reason,
    });
  }

  return new Promise<BoundedExecResult>((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(bin, [...args], {
      detached,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let bufferedBytes = 0;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let spawnError: Error | undefined;
    let forcedFailure: { message: string; cause?: unknown } | undefined;
    let settled = false;
    let closed = false;
    let termTimer: ReturnType<typeof setTimeout> | undefined;
    let forceCloseTimer: ReturnType<typeof setTimeout> | undefined;

    const stdout = () => Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = () => Buffer.concat(stderrChunks).toString("utf8");

    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      if (termTimer) clearTimeout(termTimer);
      if (forceCloseTimer) clearTimeout(forceCloseTimer);
    };

    const removeAbortListener = () => {
      options.signal?.removeEventListener("abort", onAbort);
    };

    const sendSignal = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      if (detached) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ESRCH") return;
          // Fall back to the direct child on platforms/filesystems where a
          // detached process group could not be signalled as expected.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // A concurrent natural exit is equivalent to a successful signal.
      }
    };

    const processGroupExists = (): boolean => {
      if (!detached || child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    };

    const wait = (milliseconds: number): Promise<void> =>
      new Promise((done) => setTimeout(done, milliseconds));

    const reapResidualProcessGroup = async (): Promise<void> => {
      if (!processGroupExists()) return;
      forcedFailure ??= {
        message: "command left a background process in its process group",
      };
      sendSignal("SIGTERM");
      await wait(TERMINATION_GRACE_MS);
      if (processGroupExists()) sendSignal("SIGKILL");
      const deadline = Date.now() + FORCE_CLOSE_GRACE_MS;
      while (processGroupExists() && Date.now() < deadline) {
        await wait(20);
      }
      if (processGroupExists()) {
        forcedFailure = {
          message: "command process group survived SIGTERM/SIGKILL cleanup",
        };
      }
    };

    const finalize = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      removeAbortListener();
      const capturedStdout = stdout();
      const capturedStderr = stderr();
      if (forcedFailure) {
        reject(
          new BoundedExecError(forcedFailure.message, {
            stdout: capturedStdout,
            stderr: capturedStderr,
            exitCode,
            signal: exitSignal,
            ...(forcedFailure.cause === undefined
              ? {}
              : { cause: forcedFailure.cause }),
          }),
        );
      } else if (spawnError) {
        reject(
          new BoundedExecError(`failed to start command: ${spawnError.message}`, {
            stdout: capturedStdout,
            stderr: capturedStderr,
            exitCode,
            signal: exitSignal,
            cause: spawnError,
          }),
        );
      } else if (exitCode !== 0) {
        reject(
          new BoundedExecError(
            `command exited with code ${exitCode ?? "null"}${exitSignal ? ` (signal ${exitSignal})` : ""}`,
            {
              stdout: capturedStdout,
              stderr: capturedStderr,
              exitCode,
              signal: exitSignal,
            },
          ),
        );
      } else {
        resolve({ stdout: capturedStdout, stderr: capturedStderr });
      }
    };

    const forceCloseStdio = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      // Destroying inherited pipes should cause `close`; keep a final fallback
      // so a buggy platform binding cannot retain the MCP request forever.
      setImmediate(() => {
        if (!closed) finalize();
      });
    };

    const beginTermination = (message: string, cause?: unknown) => {
      if (forcedFailure || settled) return;
      forcedFailure = { message, ...(cause === undefined ? {} : { cause }) };
      sendSignal("SIGTERM");
      termTimer = setTimeout(() => {
        if (closed) return;
        sendSignal("SIGKILL");
        forceCloseTimer = setTimeout(() => {
          if (!closed) forceCloseStdio();
        }, FORCE_CLOSE_GRACE_MS);
      }, TERMINATION_GRACE_MS);
    };

    const appendBounded = (target: Buffer[], chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBufferBytes - bufferedBytes;
      if (remaining > 0) {
        const accepted = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);
        target.push(Buffer.from(accepted));
        bufferedBytes += accepted.length;
      }
      if (buffer.length > remaining) {
        beginTermination(
          `command output exceeded maxBufferBytes=${maxBufferBytes}`,
        );
      }
    };

    const onAbort = () => {
      beginTermination(abortMessage(options.signal!), options.signal?.reason);
    };

    child.stdout?.on("data", (chunk: Buffer | string) => appendBounded(stdoutChunks, chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => appendBounded(stderrChunks, chunk));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    child.once("close", (code, signal) => {
      closed = true;
      exitCode = code;
      exitSignal = signal;
      void reapResidualProcessGroup().then(finalize, (error: unknown) => {
        forcedFailure = {
          message: `failed to verify command process-group cleanup: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
        };
        finalize();
      });
    });

    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeoutTimer = setTimeout(() => {
      beginTermination(`command timed out after ${timeoutMs}ms`);
    }, timeoutMs);
  });
}
