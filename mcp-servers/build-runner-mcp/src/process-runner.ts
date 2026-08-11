import { spawn, type ChildProcess } from "node:child_process";
import { createHash, type Hash } from "node:crypto";

const TERMINATION_GRACE_MS = 500;
const FORCE_CLOSE_GRACE_MS = 2_000;
const FINAL_SETTLE_GRACE_MS = 1_000;
const CLEANUP_POLL_MS = 20;

export interface ProcessResult {
  stdout: string;
  stderr: string;
  /** SHA-256 of the exact captured stdout bytes, before UTF-8 decoding. */
  stdoutRawSha256: string;
  /** SHA-256 of the exact captured stderr bytes, before UTF-8 decoding. */
  stderrRawSha256: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface ProcessRunnerStatus {
  activeProcesses: number;
  unresolvedProcesses: number;
  poisoned: boolean;
  cleaning: boolean;
  closing: boolean;
  closed: boolean;
}

interface ProcessRunnerTimings {
  terminationGraceMs: number;
  forceCloseGraceMs: number;
  finalSettleGraceMs: number;
  cleanupPollMs: number;
}

/**
 * Test seam for exercising fail-closed states which a normally privileged
 * process cannot create reliably (SIGKILL cannot be ignored). Production code
 * must omit it.
 */
export interface ProcessRunnerTestHooks {
  processGroupExists?(processGroupId: number): boolean;
  signalProcessGroup?(processGroupId: number, signal: NodeJS.Signals): void;
}

export interface ProcessRunnerConfig {
  /** Test-only shorter waits. Omitting a field retains the production value. */
  testOnlyTimings?: Partial<ProcessRunnerTimings>;
  /** Test-only process-control seam. Production code must omit this. */
  testOnlyHooks?: ProcessRunnerTestHooks;
}

export class ProcessRunError extends Error {
  readonly code: string;
  readonly result?: ProcessResult;

  constructor(code: string, message: string, result?: ProcessResult, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProcessRunError";
    this.code = code;
    this.result = result;
  }
}

interface TerminationReason {
  code: string;
  message: string;
  cause?: unknown;
}

interface ManagedProcess {
  readonly token: symbol;
  readonly child: ChildProcess;
  readonly pid?: number;
  readonly detached: boolean;
  readonly started: number;
  readonly stdoutChunks: Buffer[];
  readonly stderrChunks: Buffer[];
  readonly stdoutDigest: Hash;
  readonly stderrDigest: Hash;
  readonly maxOutputBytes: number;
  readonly abortSignal?: AbortSignal;
  readonly resolve: (result: ProcessResult) => void;
  readonly reject: (error: ProcessRunError) => void;
  capturedBytes: number;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  exitObserved: boolean;
  closeObserved: boolean;
  settled: boolean;
  poisoned: boolean;
  termination?: TerminationReason;
  cleanupTask?: Promise<void>;
  timeout?: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
}

type GroupStatus = "absent" | "present" | "unknown";

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Owns every process it starts until both the child close event and Unix
 * process-group absence have been proved. A failed proof poisons this runner:
 * no later process is admitted until cleanup succeeds, or close succeeds.
 */
export class ProcessRunner {
  readonly #records = new Map<symbol, ManagedProcess>();
  readonly #timings: ProcessRunnerTimings;
  readonly #testHooks?: ProcessRunnerTestHooks;
  #poisoned = false;
  #cleaning = false;
  #closing = false;
  #closed = false;
  #cleanupPromise?: Promise<void>;
  #closePromise?: Promise<void>;

  constructor(config: ProcessRunnerConfig = {}) {
    const overrides = config.testOnlyTimings ?? {};
    this.#timings = {
      terminationGraceMs: positiveInteger(
        overrides.terminationGraceMs ?? TERMINATION_GRACE_MS,
        "terminationGraceMs",
      ),
      forceCloseGraceMs: positiveInteger(
        overrides.forceCloseGraceMs ?? FORCE_CLOSE_GRACE_MS,
        "forceCloseGraceMs",
      ),
      finalSettleGraceMs: positiveInteger(
        overrides.finalSettleGraceMs ?? FINAL_SETTLE_GRACE_MS,
        "finalSettleGraceMs",
      ),
      cleanupPollMs: positiveInteger(
        overrides.cleanupPollMs ?? CLEANUP_POLL_MS,
        "cleanupPollMs",
      ),
    };
    this.#testHooks = config.testOnlyHooks;
  }

  status(): ProcessRunnerStatus {
    let unresolvedProcesses = 0;
    for (const record of this.#records.values()) {
      if (record.poisoned) unresolvedProcesses += 1;
    }
    return {
      activeProcesses: this.#records.size,
      unresolvedProcesses,
      poisoned: this.#poisoned,
      cleaning: this.#cleaning,
      closing: this.#closing,
      closed: this.#closed,
    };
  }

  /** Execute one argv-only process with bounded output and group cleanup. */
  async run(
    executable: string,
    args: readonly string[],
    options: ProcessOptions,
  ): Promise<ProcessResult> {
    const timeoutMs = positiveInteger(options.timeoutMs, "timeoutMs");
    const maxOutputBytes = positiveInteger(options.maxOutputBytes, "maxOutputBytes");
    if (this.#closed || this.#closing) {
      throw new ProcessRunError("PROCESS_RUNNER_CLOSED", "process runner is closing or closed");
    }
    if (this.#cleaning) {
      throw new ProcessRunError("PROCESS_RUNNER_CLEANING", "process runner cleanup is in progress");
    }
    if (this.#poisoned || [...this.#records.values()].some((record) => record.poisoned)) {
      this.#poisoned = true;
      throw new ProcessRunError(
        "PROCESS_RUNNER_POISONED",
        "a previous process cleanup is unresolved; cleanup must prove absence before another run",
      );
    }
    if (options.signal?.aborted) {
      throw new ProcessRunError(
        "ABORTED",
        "process was aborted before start",
        undefined,
        options.signal.reason,
      );
    }

    return new Promise<ProcessResult>((resolve, reject) => {
      const detached = process.platform !== "win32";
      let child: ChildProcess;
      try {
        child = spawn(executable, [...args], {
          cwd: options.cwd,
          env: options.env,
          detached,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        reject(new ProcessRunError(
          "SPAWN_FAILED",
          `failed to start process: ${cause.message}`,
          undefined,
          cause,
        ));
        return;
      }

      const record: ManagedProcess = {
        token: Symbol("managed-process"),
        child,
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        detached,
        started: Date.now(),
        stdoutChunks: [],
        stderrChunks: [],
        stdoutDigest: createHash("sha256"),
        stderrDigest: createHash("sha256"),
        maxOutputBytes,
        ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
        resolve,
        reject,
        capturedBytes: 0,
        exitCode: null,
        exitSignal: null,
        exitObserved: false,
        closeObserved: false,
        settled: false,
        poisoned: false,
      };
      this.#records.set(record.token, record);

      const append = (target: Buffer[], digest: Hash, chunk: Buffer | string): void => {
        if (record.settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = Math.max(0, record.maxOutputBytes - record.capturedBytes);
        if (remaining > 0) {
          const accepted = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);
          target.push(Buffer.from(accepted));
          digest.update(accepted);
          record.capturedBytes += accepted.length;
        }
        if (buffer.length > remaining) {
          this.#requestTermination(record, {
            code: "OUTPUT_LIMIT",
            message: `process output exceeded ${record.maxOutputBytes} bytes`,
          });
        }
      };

      child.stdout?.on("data", (chunk: Buffer | string) => (
        append(record.stdoutChunks, record.stdoutDigest, chunk)
      ));
      child.stderr?.on("data", (chunk: Buffer | string) => (
        append(record.stderrChunks, record.stderrDigest, chunk)
      ));
      child.once("error", (error) => {
        this.#requestTermination(record, {
          code: "SPAWN_FAILED",
          message: `failed to start process: ${error.message}`,
          cause: error,
        });
      });
      child.once("exit", (code, signal) => {
        record.exitObserved = true;
        record.exitCode = code;
        record.exitSignal = signal;
      });
      child.once("close", (code, signal) => {
        record.closeObserved = true;
        // Some platforms can report close without a separately observed exit.
        record.exitObserved = true;
        if (record.exitCode === null && code !== null) record.exitCode = code;
        if (record.exitSignal === null && signal !== null) record.exitSignal = signal;
        this.#handleClose(record);
      });

      const abort = (): void => this.#requestTermination(record, {
        code: "ABORTED",
        message: "process was aborted",
        cause: options.signal?.reason,
      });
      record.abortListener = abort;
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();

      record.timeout = setTimeout(
        () => this.#requestTermination(record, {
          code: "TIMEOUT",
          message: `process exceeded timeoutMs=${timeoutMs}`,
        }),
        timeoutMs,
      );
    });
  }

  /**
   * Abort all admitted processes and prove that no owned process group remains.
   * A failed call is retryable. It never admits a new process while running.
   */
  async cleanup(): Promise<void> {
    if (this.#closed) return;
    if (this.#cleanupPromise) return this.#cleanupPromise;
    this.#cleaning = true;
    const cleanup = this.#cleanupInternal();
    this.#cleanupPromise = cleanup;
    try {
      await cleanup;
    } finally {
      if (this.#cleanupPromise === cleanup) this.#cleanupPromise = undefined;
      this.#cleaning = false;
    }
  }

  /**
   * Permanently stop admission, then perform retryable cleanup. If cleanup
   * fails, another close() call retries the proof while admission stays shut.
   */
  async close(): Promise<void> {
    this.#closing = true;
    if (this.#closed) return;
    if (this.#closePromise) return this.#closePromise;
    const closing = (async () => {
      await this.cleanup();
      if (this.#records.size !== 0 || this.#poisoned) {
        throw new ProcessRunError(
          "PROCESS_CLEANUP_INCOMPLETE",
          "process runner close could not prove that every process group is absent",
        );
      }
      this.#closed = true;
    })();
    this.#closePromise = closing;
    try {
      await closing;
    } finally {
      if (this.#closePromise === closing) this.#closePromise = undefined;
    }
  }

  async #cleanupInternal(): Promise<void> {
    const records = [...this.#records.values()];
    await Promise.all(records.map(async (record) => {
      if (this.#proveAbsent(record)) return;

      if (record.cleanupTask) {
        await record.cleanupTask;
      } else if (!record.poisoned || !record.exitObserved) {
        // It is safe to retry signals while the original leader has not emitted
        // exit. After leader exit, an old PGID may have been reused; delayed
        // cleanup therefore only polls for absence and never signals blindly.
        this.#requestTermination(record, {
          code: "PROCESS_RUNNER_CLEANUP",
          message: "process was stopped by process runner cleanup",
        }, true);
        await record.cleanupTask;
      } else {
        await this.#waitForAbsence(
          record,
          this.#timings.forceCloseGraceMs + this.#timings.finalSettleGraceMs,
        );
      }
    }));

    for (const record of [...this.#records.values()]) this.#proveAbsent(record);
    this.#poisoned = [...this.#records.values()].some((record) => record.poisoned);
    if (this.#records.size !== 0) {
      throw new ProcessRunError(
        "PROCESS_CLEANUP_INCOMPLETE",
        "could not prove that every managed process group is absent",
      );
    }
    this.#poisoned = false;
  }

  #requestTermination(
    record: ManagedProcess,
    reason: TerminationReason,
    retry = false,
  ): void {
    if (!record.termination) record.termination = reason;
    if (record.cleanupTask && !retry) return;
    if (record.cleanupTask) return;
    const task = this.#driveTermination(record);
    record.cleanupTask = task;
    void task.finally(() => {
      if (record.cleanupTask === task) record.cleanupTask = undefined;
    });
  }

  async #driveTermination(record: ManagedProcess): Promise<void> {
    const reason = record.termination ?? {
      code: "PROCESS_RUNNER_CLEANUP",
      message: "process was stopped by process runner cleanup",
    };
    this.#signal(record, "SIGTERM");
    let absent = await this.#waitForAbsence(record, this.#timings.terminationGraceMs);
    if (!absent) {
      this.#signal(record, "SIGKILL");
      absent = await this.#waitForAbsence(record, this.#timings.forceCloseGraceMs);
    }
    if (!absent) {
      record.child.stdout?.destroy();
      record.child.stderr?.destroy();
      absent = await this.#waitForAbsence(record, this.#timings.finalSettleGraceMs);
    }

    if (absent) {
      this.#settleRejected(record, reason);
      return;
    }

    // Do not unref or delete the child. Keeping both the ChildProcess and PGID
    // registry entry is intentional: service shutdown and later cleanup must
    // remain blocked until absence can actually be proved.
    record.poisoned = true;
    this.#poisoned = true;
    this.#settleRejected(record, {
      code: "PROCESS_STUCK",
      message: "process or process group survived the final cleanup deadline",
      cause: reason.cause,
    }, false);
  }

  #handleClose(record: ManagedProcess): void {
    if (this.#proveAbsent(record)) {
      if (record.termination) this.#settleRejected(record, record.termination);
      else this.#settleResolved(record);
      return;
    }
    if (record.settled || record.cleanupTask) return;
    this.#requestTermination(record, {
      code: "PROCESS_LEAK",
      message: "process left a background process or an unprovable process group",
    });
  }

  #groupStatus(record: ManagedProcess): GroupStatus {
    if (!record.detached || record.pid === undefined) {
      return record.closeObserved ? "absent" : "unknown";
    }
    try {
      if (this.#testHooks?.processGroupExists) {
        return this.#testHooks.processGroupExists(record.pid) ? "present" : "absent";
      }
      process.kill(-record.pid, 0);
      return "present";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "unknown";
    }
  }

  #signal(record: ManagedProcess, signal: NodeJS.Signals): void {
    if (record.pid === undefined) return;
    if (record.detached) {
      try {
        if (this.#testHooks?.signalProcessGroup) {
          this.#testHooks.signalProcessGroup(record.pid, signal);
        } else {
          process.kill(-record.pid, signal);
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        // A group signal failure is not proof of absence. Try the retained
        // ChildProcess handle, then rely exclusively on the later proof.
      }
    }
    try {
      record.child.kill(signal);
    } catch {
      // A concurrent exit is accepted only after #proveAbsent succeeds.
    }
  }

  async #waitForAbsence(record: ManagedProcess, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (this.#proveAbsent(record)) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return this.#proveAbsent(record);
      await delay(Math.min(this.#timings.cleanupPollMs, remaining));
    }
  }

  #proveAbsent(record: ManagedProcess): boolean {
    if (!record.closeObserved || this.#groupStatus(record) !== "absent") return false;
    if (this.#records.get(record.token) === record) this.#records.delete(record.token);
    record.poisoned = false;
    this.#poisoned = [...this.#records.values()].some((entry) => entry.poisoned);
    return true;
  }

  #result(record: ManagedProcess): ProcessResult {
    return {
      stdout: Buffer.concat(record.stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(record.stderrChunks).toString("utf8"),
      stdoutRawSha256: record.stdoutDigest.digest("hex"),
      stderrRawSha256: record.stderrDigest.digest("hex"),
      exitCode: record.exitCode,
      signal: record.exitSignal,
      durationMs: Date.now() - record.started,
    };
  }

  #finish(record: ManagedProcess): void {
    if (record.timeout) clearTimeout(record.timeout);
    if (record.abortListener) {
      record.abortSignal?.removeEventListener("abort", record.abortListener);
    }
  }

  #settleResolved(record: ManagedProcess): void {
    if (record.settled) return;
    record.settled = true;
    this.#finish(record);
    record.resolve(this.#result(record));
  }

  #settleRejected(
    record: ManagedProcess,
    reason: TerminationReason,
    requireAbsence = true,
  ): void {
    if (record.settled) return;
    if (requireAbsence && !this.#proveAbsent(record)) return;
    record.settled = true;
    this.#finish(record);
    record.reject(new ProcessRunError(
      reason.code,
      reason.message,
      this.#result(record),
      reason.cause,
    ));
  }
}

const defaultProcessRunner = new ProcessRunner();

/**
 * Backwards-compatible module runner. Long-lived owners that need a lifecycle
 * proof (for example DockerBackend) should own a ProcessRunner instance and
 * await its retryable close() hook instead of sharing this singleton.
 */
export async function runProcess(
  executable: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  return defaultProcessRunner.run(executable, args, options);
}
