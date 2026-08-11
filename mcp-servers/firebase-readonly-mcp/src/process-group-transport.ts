import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const MAX_PROTOCOL_LINE_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const CLOSE_GRACE_MS = 1_000;
const WRITE_DRAIN_TIMEOUT_MS = 5_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface ProcessGroupTransportOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
}

function delay(milliseconds: number): Promise<void> {
  // Keep cleanup timers referenced. Once a group leader has closed, its
  // descendants may no longer own any of our stdio handles; an unref'ed timer
  // could let the gateway exit before the remaining process group is reaped.
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForClose(child: ChildProcessWithoutNullStreams, milliseconds: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    once(child, "close").then(() => true),
    delay(milliseconds).then(() => false),
  ]);
}

function processGroupExists(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM still proves that at least one process in the group exists. This
    // can be transient on macOS while an orphaned child is being reaped; keep
    // polling rather than reporting a false cleanup failure immediately.
    if (code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupExit(groupId: number, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (processGroupExists(groupId)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(25, remaining));
  }
  return true;
}

async function waitForDrainOrClose(
  child: ChildProcessWithoutNullStreams,
  milliseconds: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.off("drain", onDrain);
      child.stdin.off("error", onError);
      child.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => finish();
    const onError = () => finish(new Error("official Firebase MCP stdin closed during write"));
    const onClose = () => finish(new Error("official Firebase MCP closed during write"));
    const timer = setTimeout(
      () => finish(new Error("official Firebase MCP write backpressure timed out")),
      milliseconds,
    );
    timer.unref();
    child.stdin.once("drain", onDrain);
    child.stdin.once("error", onError);
    child.once("close", onClose);
    if (
      child.exitCode !== null
      || child.signalCode !== null
      || !child.stdin.writable
      || child.stdin.destroyed
    ) {
      onClose();
    }
  });
}

/**
 * Minimal stdio MCP transport with bounded protocol/stderr buffers and POSIX
 * process-group cleanup. It intentionally exposes no child output to callers.
 */
export class ProcessGroupStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  #child?: ChildProcessWithoutNullStreams;
  #buffer = Buffer.alloc(0);
  #closing?: Promise<void>;
  #orphanCleanup?: Promise<void>;
  #cleanupFailure?: Error;
  #stderrBytes = 0;
  #started = false;

  constructor(private readonly options: ProcessGroupTransportOptions) {}

  async start(): Promise<void> {
    if (this.#started || this.#closing) {
      throw new Error("official Firebase MCP transport may only be started once");
    }
    this.#started = true;
    const child = spawn(this.options.command, [...this.options.args], {
      cwd: this.options.cwd,
      env: this.options.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;

    child.stdout.on("data", (chunk: Buffer) => this.#consumeStdout(chunk));
    child.stdout.on("error", (error) => this.#fail(error));
    child.stdin.on("error", (error) => this.#fail(error));
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderrBytes += chunk.byteLength;
      if (this.#stderrBytes > MAX_STDERR_BYTES) {
        this.#fail(new Error("official Firebase MCP exceeded the stderr byte limit"));
        void this.close();
      }
    });
    child.on("error", (error) => this.#fail(error));
    child.on("close", () => {
      this.#child = undefined;
      this.#buffer = Buffer.alloc(0);
      // A detached POSIX group leader can exit after spawning a descendant
      // that closed the inherited pipes. Start group cleanup even when no
      // caller explicitly invokes close() after the unexpected disconnect.
      if (!this.#closing && process.platform !== "win32" && child.pid) {
        this.#orphanCleanup = this.#ensureProcessGroupClosed(child.pid).catch((error) => {
          const failure = error instanceof Error
            ? error
            : new Error("official Firebase MCP process-group cleanup failed");
          this.#cleanupFailure ??= failure;
          this.#fail(failure);
        });
      }
      this.onclose?.();
    });

    await Promise.race([
      once(child, "spawn").then(() => undefined),
      once(child, "error").then(([error]) => Promise.reject(error)),
    ]);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.#child;
    if (!child?.stdin.writable) throw new Error("official Firebase MCP transport is not connected");
    const payload = serializeMessage(message);
    if (Buffer.byteLength(payload, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
      throw new Error("official Firebase MCP request exceeded the protocol limit");
    }
    if (!child.stdin.write(payload, "utf8")) {
      await waitForDrainOrClose(child, WRITE_DRAIN_TIMEOUT_MS);
    }
  }

  close(): Promise<void> {
    if (!this.#closing) this.#closing = this.#closeOnce();
    return this.#closing;
  }

  async #closeOnce(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    this.#buffer = Buffer.alloc(0);
    let closeFailure: Error | undefined;
    if (child) {
      try {
        child.stdin.end();
      } catch (error) {
        this.#fail(error);
      }
      if (!(await waitForClose(child, CLOSE_GRACE_MS))) {
        this.#signal(child, "SIGTERM");
        if (!(await waitForClose(child, CLOSE_GRACE_MS))) {
          this.#signal(child, "SIGKILL");
          if (!(await waitForClose(child, CLOSE_GRACE_MS))) {
            closeFailure = new Error(
              "official Firebase MCP group leader did not close after SIGKILL",
            );
          }
        }
      }
      if (process.platform !== "win32" && child.pid) {
        try {
          await this.#ensureProcessGroupClosed(child.pid);
        } catch (error) {
          closeFailure ??= error instanceof Error
            ? error
            : new Error("official Firebase MCP process-group cleanup failed");
        }
      }
    }
    await this.#orphanCleanup;
    if (this.#cleanupFailure) throw this.#cleanupFailure;
    if (closeFailure) throw closeFailure;
  }

  #signal(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && child.pid) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") this.#fail(error);
    }
  }

  async #ensureProcessGroupClosed(groupId: number): Promise<void> {
    if (!processGroupExists(groupId)) return;
    try {
      process.kill(-groupId, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      return;
    }
    if (await waitForProcessGroupExit(groupId, CLOSE_GRACE_MS)) return;
    try {
      process.kill(-groupId, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      return;
    }
    if (!(await waitForProcessGroupExit(groupId, CLOSE_GRACE_MS))) {
      throw new Error("official Firebase MCP process group did not close after SIGKILL");
    }
  }

  #consumeStdout(chunk: Buffer): void {
    // Process the incoming chunk a line at a time. Never concatenate more than
    // one bounded protocol line, even if a hostile child writes a huge chunk
    // containing many newlines in one syscall.
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      if (this.#buffer.length + segment.length > MAX_PROTOCOL_LINE_BYTES) {
        this.#fail(new Error("official Firebase MCP emitted an oversized protocol line"));
        void this.close();
        return;
      }
      if (newline < 0) {
        if (segment.length > 0) {
          this.#buffer = this.#buffer.length === 0
            ? Buffer.from(segment)
            : Buffer.concat([this.#buffer, segment]);
        }
        return;
      }
      const encodedLine = this.#buffer.length === 0
        ? segment
        : Buffer.concat([this.#buffer, segment]);
      this.#buffer = Buffer.alloc(0);
      try {
        const line = UTF8_DECODER.decode(encodedLine).replace(/\r$/u, "");
        this.onmessage?.(deserializeMessage(line));
      } catch {
        this.#fail(new Error("official Firebase MCP emitted an invalid protocol message"));
        void this.close();
        return;
      }
      offset = newline + 1;
    }
  }

  #fail(error: unknown): void {
    this.onerror?.(error instanceof Error ? error : new Error("official Firebase MCP transport failed"));
  }
}
