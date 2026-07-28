import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { pipeCaptureToFile } from "./file-capture.js";

const execFileAsync = promisify(execFile);

const ADB_BIN = process.env.ADB_BIN ?? "adb";

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

export async function runAdb(
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(ADB_BIN, args, {
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    throw new AdbError(
      `adb ${args.join(" ")} failed: ${e.message}`,
      `${ADB_BIN} ${args.join(" ")}`,
      e.stderr,
    );
  }
}

export async function listDevices(): Promise<AdbDevice[]> {
  const out = await runAdb(["devices", "-l"]);
  const lines = out.split("\n").slice(1); // skip header
  const devices: AdbDevice[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const serial = parts[0];
    const state = parts[1];
    if (!serial || !state) continue;
    const device: AdbDevice = { serial, state };
    for (const part of parts.slice(2)) {
      const [k, v] = part.split(":");
      if (k === "model" && v) device.model = v;
      if (k === "product" && v) device.product = v;
    }
    devices.push(device);
  }
  return devices;
}

export async function pickDevice(preferred?: string): Promise<string> {
  const devices = (await listDevices()).filter((d) => d.state === "device");
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
  close: () => Promise<void>;
}

export async function spawnLogcat(opts: {
  device?: string;
  outFilePath: string;
  bufferArgs?: string[];
}): Promise<SpawnedLogcat> {
  const target = await pickDevice(opts.device);
  const args = [...deviceArgs(target), "logcat", ...(opts.bufferArgs ?? [])];
  // Use shell redirection via spawn with shell:false; instead pipe through Node.
  const { createWriteStream } = await import("node:fs");
  const out = createWriteStream(opts.outFilePath, { flags: "a" });
  const proc = spawn(ADB_BIN, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lifecycle = pipeCaptureToFile(proc, out, `${ADB_BIN} ${args.join(" ")}`);
  try {
    await lifecycle.ready;
  } catch (error) {
    await lifecycle.close().catch(() => undefined);
    throw error;
  }
  const { close } = lifecycle;
  return { process: proc, device: target, close };
}

export async function pullViaBugreport(opts: {
  device?: string;
  outZipPath: string;
}): Promise<void> {
  const target = await pickDevice(opts.device);
  await runAdb(
    [...deviceArgs(target), "bugreport", opts.outZipPath],
    { timeoutMs: 5 * 60_000 },
  );
}

export async function dumpsysMeminfo(opts: {
  package: string;
  device?: string;
}): Promise<string> {
  const target = await pickDevice(opts.device);
  return runAdb([
    ...deviceArgs(target),
    "shell",
    "dumpsys",
    "meminfo",
    opts.package,
  ]);
}
