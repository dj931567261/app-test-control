// xcrun simctl wrappers + iOS log stream spawning.
// iOS support is simulator-focused; real-device flow needs idevicesyslog / Apple Configurator
// and is intentionally out of scope here.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream } from "node:fs";
import { pipeCaptureToFile } from "./file-capture.js";

const execFileAsync = promisify(execFile);

export interface IosSimulator {
  udid: string;
  name: string;
  state: string;     // Booted | Shutdown | ...
  runtime: string;   // e.g. "com.apple.CoreSimulator.SimRuntime.iOS-17-5"
  deviceTypeId?: string;
}

export class SimctlError extends Error {
  constructor(message: string, public readonly cmd: string, public readonly stderr?: string) {
    super(message);
    this.name = "SimctlError";
  }
}

async function runSimctl(args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync("xcrun", ["simctl", ...args], {
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    throw new SimctlError(
      `xcrun simctl ${args.join(" ")} failed: ${e.message}`,
      `xcrun simctl ${args.join(" ")}`,
      e.stderr,
    );
  }
}

export async function listSimulators(opts: { onlyBooted?: boolean } = {}): Promise<IosSimulator[]> {
  const out = await runSimctl(["list", "devices", "--json"]);
  const data = JSON.parse(out) as { devices?: Record<string, unknown[]> };
  const result: IosSimulator[] = [];
  for (const [runtime, devices] of Object.entries(data.devices ?? {})) {
    for (const d of devices ?? []) {
      const dev = d as Record<string, unknown>;
      const state = (dev["state"] as string) ?? "";
      if (opts.onlyBooted && state !== "Booted") continue;
      result.push({
        udid: (dev["udid"] as string) ?? "",
        name: (dev["name"] as string) ?? "",
        state,
        runtime,
        deviceTypeId: dev["deviceTypeIdentifier"] as string | undefined,
      });
    }
  }
  return result;
}

export async function pickSimulator(preferred?: string): Promise<string> {
  const booted = await listSimulators({ onlyBooted: true });
  if (preferred) {
    if (!booted.some((s) => s.udid === preferred)) {
      throw new SimctlError(
        `Simulator "${preferred}" is not booted. Boot it via Simulator.app or 'xcrun simctl boot <udid>'.`,
        "xcrun simctl list devices",
      );
    }
    return preferred;
  }
  if (booted.length === 0) {
    throw new SimctlError(
      "No iOS simulators are booted. Run 'xcrun simctl boot <udid>' or open one in Simulator.app.",
      "xcrun simctl list devices",
    );
  }
  if (booted.length > 1) {
    throw new SimctlError(
      `Multiple booted simulators (${booted.map((s) => `${s.udid} (${s.name})`).join(", ")}); pass simulator_udid explicitly.`,
      "xcrun simctl list devices",
    );
  }
  return booted[0]!.udid;
}

export interface SpawnedIosLog {
  process: ChildProcess;
  udid: string;
  close: () => Promise<void>;
}

/**
 * Spawn `xcrun simctl spawn <udid> log stream` into a file. Optionally filter
 * via an Apple log predicate (e.g. 'processImagePath CONTAINS "MyApp"').
 */
export async function spawnIosLogStream(opts: {
  udid?: string;
  outFilePath: string;
  predicate?: string;
  level?: "default" | "info" | "debug";
}): Promise<SpawnedIosLog> {
  const udid = await pickSimulator(opts.udid);
  const args = ["simctl", "spawn", udid, "log", "stream"];
  if (opts.level) args.push(`--level=${opts.level}`);
  if (opts.predicate) {
    args.push("--predicate", opts.predicate);
  }
  const out = createWriteStream(opts.outFilePath, { flags: "a" });
  const proc = spawn("xcrun", args, { stdio: ["ignore", "pipe", "pipe"] });
  const lifecycle = pipeCaptureToFile(proc, out, `xcrun ${args.join(" ")}`);
  try {
    await lifecycle.ready;
  } catch (error) {
    await lifecycle.close().catch(() => undefined);
    throw error;
  }
  const { close } = lifecycle;
  return { process: proc, udid, close };
}
