import type { ChildProcess } from "node:child_process";
import type { WriteStream } from "node:fs";
import { Transform } from "node:stream";

const PROCESS_CLOSE_TIMEOUT_MS = 3_000;
const PROCESS_STARTUP_GRACE_MS = 250;

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

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

function endOutput(out: WriteStream): void {
  if (!out.destroyed && !out.writableEnded) out.end();
}

/**
 * Pipe both child output streams into one file without allowing the first pipe
 * to close the destination. The returned idempotent hook stops the child and
 * resolves only after the output stream has flushed its tail.
 */
export interface FileCaptureLifecycle {
  ready: Promise<void>;
  close: () => Promise<void>;
}

export interface FileCaptureOptions {
  /** Stop the child after at most this many bytes have been appended. */
  maxBytes?: number;
  /** Called exactly once, before the child is stopped, when maxBytes is reached. */
  onLimit?: (maxBytes: number) => void;
  /** Receives process/output failures that occur after startup succeeds. */
  onError?: (error: Error) => void;
}

export function pipeCaptureToFile(
  proc: ChildProcess,
  out: WriteStream,
  label: string,
  options: FileCaptureOptions = {},
): FileCaptureLifecycle {
  if (
    options.maxBytes !== undefined &&
    (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0)
  ) {
    proc.kill("SIGTERM");
    out.destroy();
    throw new RangeError("maxBytes must be a positive safe integer");
  }

  let childClosed = false;
  let limitReached = false;
  let bytesWritten = 0;
  let limitKillTimer: ReturnType<typeof setTimeout> | undefined;
  const limiter =
    options.maxBytes === undefined
      ? undefined
      : new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            const maxBytes = options.maxBytes!;
            const remaining = maxBytes - bytesWritten;
            if (remaining > 0) {
              const accepted = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
              bytesWritten += accepted.length;
              this.push(accepted);
            }
            if (!limitReached && bytesWritten >= maxBytes) {
              limitReached = true;
              try {
                options.onLimit?.(maxBytes);
              } catch (error) {
                // A diagnostic callback must never crash the MCP process.
                console.error(
                  `[log-mcp] capture limit callback failed: ${toError(error).message}`,
                );
              }
              if (!childClosed) {
                proc.kill("SIGTERM");
                // A long-running capture may ignore TERM. Escalate without
                // waiting for an external stop_capture call, otherwise the
                // process/session would remain alive while all output is dropped.
                limitKillTimer = setTimeout(() => {
                  if (!childClosed) proc.kill("SIGKILL");
                }, PROCESS_CLOSE_TIMEOUT_MS);
                limitKillTimer.unref();
              }
            }
            callback();
          },
        });
  const destination = limiter ?? out;

  proc.stdout?.pipe(destination, { end: false });
  proc.stderr?.pipe(destination, { end: false });
  // When bounded, both child streams share the limiter. The child close handler
  // ends it exactly once, which in turn flushes and ends the file stream.
  limiter?.pipe(out);

  let startupState: "pending" | "ready" | "failed" = "pending";
  let processError: Error | undefined;
  let outputError: Error | undefined;

  let resolveChildExited!: () => void;
  const childExitedPromise = new Promise<void>((resolve) => {
    resolveChildExited = resolve;
  });

  let resolveChildClosed!: () => void;
  const childClosedPromise = new Promise<void>((resolve) => {
    resolveChildClosed = resolve;
  });

  let outputDone = false;
  let resolveOutputDone!: () => void;
  const outputDonePromise = new Promise<void>((resolve) => {
    resolveOutputDone = resolve;
  });
  const markOutputDone = () => {
    if (outputDone) return;
    outputDone = true;
    resolveOutputDone();
  };

  let rejectStartup!: (error: Error) => void;
  let childSpawned = false;
  let outputOpened = false;
  const startupPromise = new Promise<void>((resolve, reject) => {
    rejectStartup = reject;
    const maybeReady = () => {
      if (startupState === "pending" && childSpawned && outputOpened) {
        startupState = "ready";
        resolve();
      }
    };
    proc.once("spawn", () => {
      childSpawned = true;
      maybeReady();
    });
    out.once("open", () => {
      outputOpened = true;
      maybeReady();
    });
  });

  const reportOrReject = (error: Error) => {
    if (startupState === "pending") {
      startupState = "failed";
      rejectStartup(error);
    } else if (startupState === "ready") {
      try {
        options.onError?.(error);
      } catch (callbackError) {
        // Runtime diagnostics are best-effort and must not crash the MCP server.
        console.error(
          `[log-mcp] capture error callback failed: ${toError(callbackError).message}`,
        );
      }
    }
  };

  proc.on("error", (value) => {
    processError = toError(value);
    reportOrReject(processError);
  });
  proc.once("exit", resolveChildExited);
  out.on("error", (value) => {
    outputError = toError(value);
    reportOrReject(outputError);
    if (!childClosed) proc.kill("SIGTERM");
    limiter?.destroy();
    markOutputDone();
  });
  limiter?.on("error", (value) => {
    outputError = toError(value);
    reportOrReject(outputError);
    if (!childClosed) proc.kill("SIGTERM");
    if (!out.destroyed) out.destroy(outputError);
    markOutputDone();
  });
  out.once("finish", markOutputDone);
  out.once("close", markOutputDone);

  proc.once("close", () => {
    childClosed = true;
    if (limitKillTimer) clearTimeout(limitKillTimer);
    proc.stdout?.unpipe(destination);
    proc.stderr?.unpipe(destination);
    if (limiter) {
      if (!limiter.destroyed && !limiter.writableEnded) limiter.end();
    } else {
      endOutput(out);
    }
    resolveChildClosed();
  });

  const ready = (async () => {
    await startupPromise;
    const exitedDuringStartup = await settlesBefore(
      childExitedPromise,
      PROCESS_STARTUP_GRACE_MS,
    );
    if (exitedDuringStartup) {
      throw new Error(
        `${label} exited during startup (code=${proc.exitCode ?? "null"}, signal=${proc.signalCode ?? "none"})`,
      );
    }
    if (processError) throw new Error(`${label} failed during startup: ${processError.message}`);
    if (outputError) throw new Error(`${label} output failed during startup: ${outputError.message}`);
  })();

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      if (!childClosed) {
        proc.kill("SIGTERM");
        await settlesBefore(childClosedPromise, PROCESS_CLOSE_TIMEOUT_MS);
      }
      if (!childClosed) {
        proc.kill("SIGKILL");
        await settlesBefore(childClosedPromise, PROCESS_CLOSE_TIMEOUT_MS);
      }
      if (!childClosed) {
        throw new Error(`${label} did not stop after SIGTERM/SIGKILL`);
      }

      if (limiter) {
        if (!limiter.destroyed && !limiter.writableEnded) limiter.end();
      } else {
        endOutput(out);
      }
      const flushed = await settlesBefore(outputDonePromise, PROCESS_CLOSE_TIMEOUT_MS);
      if (!flushed || !outputDone) {
        out.destroy();
        throw new Error(`Timed out flushing capture file for ${label}`);
      }
      if (processError) throw new Error(`${label} failed: ${processError.message}`);
      if (outputError) throw new Error(`${label} output failed: ${outputError.message}`);
    })();
    return closePromise;
  };

  return { ready, close };
}
