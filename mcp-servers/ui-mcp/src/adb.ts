// Minimal adb wrapper for ui-mcp. Kept local instead of shared to keep
// each workspace package self-contained for now. Refactor to a shared
// helper if a third consumer appears.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ADB_BIN = process.env.ADB_BIN ?? "adb";

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

export async function runAdb(args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
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

export async function listDevices(): Promise<Array<{ serial: string; state: string }>> {
  const out = await runAdb(["devices"]);
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

export async function pickDevice(preferred?: string): Promise<string> {
  const devices = (await listDevices()).filter((d) => d.state === "device");
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
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const target = await pickDevice(device);
  return runAdb([...deviceArgs(target), "shell", cmd], opts);
}

export async function inputTap(opts: { x: number; y: number; device?: string }): Promise<void> {
  const target = await pickDevice(opts.device);
  await runAdb([...deviceArgs(target), "shell", "input", "tap", String(opts.x), String(opts.y)]);
}

export async function inputText(opts: { text: string; device?: string }): Promise<void> {
  const target = await pickDevice(opts.device);
  // adb shell input text: spaces must be %s, special chars need escaping.
  // We escape conservatively for shell.
  const escaped = opts.text
    .replace(/ /g, "%s")
    .replace(/(["\\$`!])/g, "\\$1");
  await runAdb([...deviceArgs(target), "shell", "input", "text", escaped]);
}
