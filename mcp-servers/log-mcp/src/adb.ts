import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  open,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { pipeCaptureToFile } from "./file-capture.js";
import { execFileBounded, truncateCommandDiagnostic } from "./bounded-exec.js";
import { assertDirectChild, openSecureDirectory } from "./secure-directory.js";
import {
  remainingCaptureBytes,
  validateCaptureMaxBytes,
  type OpenedCaptureOutput,
} from "./capture-output.js";

const adbBin = () => process.env.ADB_BIN ?? "adb";
const MAX_ADB_DEVICES = 64;
const MAX_ADB_DEVICE_LINE_BYTES = 4_096;
const MAX_ADB_DEVICE_FIELD_BYTES = 512;
export const MAX_BUGREPORT_BYTES = 2 * 1024 * 1024 * 1024;
const BUGREPORT_MONITOR_INTERVAL_MS = 50;

export interface AdbDevice {
  serial: string;
  state: string; // device | offline | unauthorized
  model?: string;
  product?: string;
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

function deviceArgs(device?: string): string[] {
  return device ? ["-s", device] : [];
}

/** Quote one argument for the remote POSIX shell used by `adb shell`. */
export function quoteAdbShellArg(value: string): string {
  if (value.includes("\0")) {
    throw new RangeError("adb shell arguments must not contain NUL bytes");
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export async function runAdb(
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal; maxBufferBytes?: number } = {},
): Promise<string> {
  const bin = adbBin();
  try {
    const { stdout } = await execFileBounded(bin, args, {
      timeoutMs: opts.timeoutMs ?? 30_000,
      maxBufferBytes: opts.maxBufferBytes ?? 32 * 1024 * 1024,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    throw new AdbError(
      `adb ${args.join(" ")} failed: ${e.message}`,
      `${bin} ${args.join(" ")}`,
      truncateCommandDiagnostic(e.stderr),
    );
  }
}

export async function listDevices(signal?: AbortSignal): Promise<AdbDevice[]> {
  const out = await runAdb(["devices", "-l"], {
    signal,
    maxBufferBytes: 1024 * 1024,
  });
  const lines = out.split("\n").slice(1); // skip header
  const devices: AdbDevice[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (Buffer.byteLength(trimmed, "utf8") > MAX_ADB_DEVICE_LINE_BYTES) {
      throw new AdbError("adb returned an overlong device record", "adb devices -l");
    }
    const parts = trimmed.split(/\s+/);
    const serial = parts[0];
    const state = parts[1];
    if (!serial || !state) continue;
    if (
      Buffer.byteLength(serial, "utf8") > MAX_ADB_DEVICE_FIELD_BYTES ||
      Buffer.byteLength(state, "utf8") > MAX_ADB_DEVICE_FIELD_BYTES
    ) {
      throw new AdbError("adb returned an overlong device identifier/state", "adb devices -l");
    }
    if (devices.length >= MAX_ADB_DEVICES) {
      throw new AdbError(
        `adb returned more than ${MAX_ADB_DEVICES} device records`,
        "adb devices -l",
      );
    }
    const device: AdbDevice = { serial, state };
    for (const part of parts.slice(2)) {
      const [k, v] = part.split(":");
      if (v && Buffer.byteLength(v, "utf8") > MAX_ADB_DEVICE_FIELD_BYTES) {
        throw new AdbError("adb returned an overlong device metadata field", "adb devices -l");
      }
      if (k === "model" && v) device.model = v;
      if (k === "product" && v) device.product = v;
    }
    devices.push(device);
  }
  return devices;
}

export async function pickDevice(
  preferred?: string,
  signal?: AbortSignal,
): Promise<string> {
  const devices = (await listDevices(signal)).filter((d) => d.state === "device");
  if (preferred) {
    if (!devices.some((d) => d.serial === preferred)) {
      throw new AdbError(
        `Preferred device "${preferred}" not found or not ready`,
        "adb devices",
      );
    }
    return preferred;
  }
  if (devices.length === 0) {
    throw new AdbError("No adb devices connected and ready", "adb devices");
  }
  if (devices.length > 1) {
    throw new AdbError(
      `Multiple devices connected (${devices.map((d) => d.serial).join(", ")}). Pass "device" explicitly.`,
      "adb devices",
    );
  }
  return devices[0]!.serial;
}

export async function clearLogcat(device?: string): Promise<void> {
  const target = await pickDevice(device);
  await runAdb([...deviceArgs(target), "logcat", "-c"]);
}

export async function dumpLogcat(
  device?: string,
  extra: string[] = [],
): Promise<string> {
  const target = await pickDevice(device);
  return runAdb([...deviceArgs(target), "logcat", "-d", ...extra]);
}

export interface SpawnedLogcat {
  process: ChildProcess;
  device: string;
  maxBytes: number;
  didReachLimit: () => boolean;
  getTerminationError: () => string | undefined;
  ready: Promise<void>;
  close: () => Promise<void>;
}

export function spawnLogcat(opts: {
  device: string;
  output: OpenedCaptureOutput;
  bufferArgs?: string[];
  maxBytes?: number;
  onError?: (error: Error) => void;
}): SpawnedLogcat {
  const bin = adbBin();
  const maxBytes = validateCaptureMaxBytes(opts.maxBytes);
  const remainingBytes = remainingCaptureBytes(opts.output, maxBytes);
  const args = [...deviceArgs(opts.device), "logcat", ...(opts.bufferArgs ?? [])];
  // Use shell redirection via spawn with shell:false; instead pipe through Node.
  const proc = spawn(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let terminationError: string | undefined;
  let reachedLimit = false;
  const reportRuntimeError = (error: Error) => {
    terminationError ??= error.message;
    opts.onError?.(error);
  };
  let out: ReturnType<OpenedCaptureOutput["createWriteStream"]> | undefined;
  let lifecycle: ReturnType<typeof pipeCaptureToFile>;
  try {
    out = opts.output.createWriteStream();
    lifecycle = pipeCaptureToFile(proc, out, `${bin} ${args.join(" ")}`, {
      maxBytes: remainingBytes,
      onError: reportRuntimeError,
      onLimit: () => {
        reachedLimit = true;
        reportRuntimeError(
          new AdbError(
            `Android logcat reached maxBytes=${maxBytes}; capture stopped to protect disk usage`,
            `${bin} ${args.join(" ")}`,
          ),
        );
      },
    });
  } catch (error) {
    proc.kill("SIGKILL");
    out?.destroy();
    throw error;
  }
  return {
    process: proc,
    device: opts.device,
    maxBytes,
    didReachLimit: () => reachedLimit,
    getTerminationError: () => terminationError,
    ready: lifecycle.ready,
    close: lifecycle.close,
  };
}

export async function pullViaBugreport(opts: {
  device?: string;
  outZipPath: string;
}): Promise<string> {
  const target = await pickDevice(opts.device);
  if (!path.isAbsolute(opts.outZipPath) || opts.outZipPath.includes("\0")) {
    throw new Error("bugreport output must be a non-empty absolute path without NUL");
  }
  const filename = path.basename(opts.outZipPath);
  if (
    filename.length === 0 ||
    filename === "." ||
    filename === ".." ||
    Buffer.byteLength(filename, "utf8") > 255
  ) {
    throw new Error(`Unsafe bugreport output filename: "${filename}"`);
  }
  const directory = await openSecureDirectory(path.dirname(opts.outZipPath));
  const destination = path.join(directory.canonicalPath, filename);
  assertDirectChild(directory, destination);
  let tempPath = path.join(
    directory.canonicalPath,
    `.${filename}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let linkedDestinationIdentity:
    | { dev: bigint; ino: bigint; size: bigint }
    | undefined;
  let completed = false;
  const abortController = new AbortController();
  let done = false;
  let monitorError: unknown;
  const inspectTemp = async (): Promise<void> => {
    let info;
    try {
      info = await lstat(tempPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1n ||
      (typeof process.geteuid === "function" &&
        info.uid !== BigInt(process.geteuid()))
    ) {
      throw new Error("adb bugreport created an unsafe staging entry");
    }
    if (info.size > BigInt(MAX_BUGREPORT_BYTES)) {
      throw new Error(`adb bugreport exceeded ${MAX_BUGREPORT_BYTES} bytes`);
    }
  };
  const monitor = (async () => {
    while (!done) {
      try {
        await inspectTemp();
      } catch (error) {
        monitorError = error;
        abortController.abort(error);
        return;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, BUGREPORT_MONITOR_INTERVAL_MS);
      });
    }
    try {
      await inspectTemp();
    } catch (error) {
      monitorError = error;
    }
  })();

  try {
    let commandError: unknown;
    try {
      await runAdb([...deviceArgs(target), "bugreport", tempPath], {
        timeoutMs: 5 * 60_000,
        maxBufferBytes: 4 * 1024 * 1024,
        signal: abortController.signal,
      });
    } catch (error) {
      commandError = error;
    } finally {
      done = true;
      await monitor;
    }
    if (monitorError) throw monitorError;
    if (commandError) throw commandError;
    await directory.assertUnchanged();
    if (typeof fsConstants.O_NOFOLLOW !== "number") {
      throw new Error("This platform cannot safely validate bugreport output");
    }
    const source = await open(
      tempPath,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
    let identity: { dev: bigint; ino: bigint; size: bigint };
    try {
      const current = await source.stat({ bigint: true });
      if (
        !current.isFile() ||
        current.nlink !== 1n ||
        current.size > BigInt(MAX_BUGREPORT_BYTES) ||
        (typeof process.geteuid === "function" &&
          current.uid !== BigInt(process.geteuid()))
      ) {
        throw new Error("adb bugreport output failed final descriptor validation");
      }
      await source.chmod(0o600);
      const secured = await source.stat({ bigint: true });
      if (
        secured.dev !== current.dev ||
        secured.ino !== current.ino ||
        secured.size !== current.size ||
        (secured.mode & 0o777n) !== 0o600n
      ) {
        throw new Error("adb bugreport output permissions could not be secured");
      }
      const canonicalTemp = await realpath(tempPath);
      const pathIdentity = await stat(canonicalTemp, { bigint: true });
      if (
        path.dirname(canonicalTemp) !== directory.canonicalPath ||
        pathIdentity.dev !== secured.dev ||
        pathIdentity.ino !== secured.ino
      ) {
        throw new Error("adb bugreport output changed during validation");
      }
      identity = { dev: secured.dev, ino: secured.ino, size: secured.size };
    } finally {
      await source.close();
    }

    await directory.assertUnchanged();
    // Atomic no-overwrite publication; an old report/symlink is never replaced.
    await link(tempPath, destination);
    linkedDestinationIdentity = identity;
    await unlink(tempPath);
    tempPath = "";
    const published = await open(
      destination,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
    try {
      const current = await published.stat({ bigint: true });
      if (
        !current.isFile() ||
        current.nlink !== 1n ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        current.size !== identity.size ||
        (current.mode & 0o777n) !== 0o600n
      ) {
        throw new Error("Published bugreport failed final verification");
      }
    } finally {
      await published.close();
    }
    await directory.assertUnchanged();
    const result = await realpath(destination);
    completed = true;
    return result;
  } finally {
    if (tempPath) await unlink(tempPath).catch(() => undefined);
    if (!completed && linkedDestinationIdentity) {
      try {
        const current = await open(
          destination,
          fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
        );
        try {
          const info = await current.stat({ bigint: true });
          if (
            info.dev === linkedDestinationIdentity.dev &&
            info.ino === linkedDestinationIdentity.ino &&
            info.size === linkedDestinationIdentity.size
          ) {
            await unlink(destination);
          }
        } finally {
          await current.close();
        }
      } catch {
        // Never delete a path whose identity can no longer be proven.
      }
    }
    await directory.close().catch(() => undefined);
  }
}

export async function dumpsysMeminfo(opts: {
  package: string;
  device?: string;
}): Promise<string> {
  const target = await pickDevice(opts.device);
  // `adb shell` joins nominal argv into one device-shell command. Quote the
  // caller-controlled process/package value so metacharacters cannot execute
  // an additional command on the connected device.
  const command = `dumpsys meminfo ${quoteAdbShellArg(opts.package)}`;
  return runAdb([...deviceArgs(target), "shell", command], {
    maxBufferBytes: 2 * 1024 * 1024,
  });
}
