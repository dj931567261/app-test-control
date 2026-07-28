// xcrun simctl wrappers + iOS log stream spawning.
// iOS support is simulator-focused; real-device flow needs idevicesyslog / Apple Configurator
// and is intentionally out of scope here.

import { spawn, type ChildProcess } from "node:child_process";
import { pipeCaptureToFile } from "./file-capture.js";
import { execFileBounded, truncateCommandDiagnostic } from "./bounded-exec.js";
import {
  remainingCaptureBytes,
  validateCaptureMaxBytes,
  type OpenedCaptureOutput,
} from "./capture-output.js";

const xcrunBin = () => process.env.XCRUN_BIN ?? "xcrun";

export interface IosSimulator {
  udid: string;
  name: string;
  state: string;     // Booted | Shutdown | ...
  runtime: string;   // e.g. "com.apple.CoreSimulator.SimRuntime.iOS-17-5"
  deviceTypeId?: string;
}

export interface IosSimulatorListResult {
  simulators: IosSimulator[];
  totalDetected: number;
  resultsTruncated: boolean;
  fieldsTruncated: boolean;
}

export const MAX_IOS_SIMULATORS = 128;
const MAX_IOS_SIMULATOR_SCAN_ITEMS = 10_000;
const MAX_IOS_SIMULATOR_FIELD_BYTES = 256;

function boundedSimulatorField(value: unknown): { value: string; truncated: boolean } {
  const text = typeof value === "string" ? value : "";
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= MAX_IOS_SIMULATOR_FIELD_BYTES) {
    return { value: text, truncated: false };
  }
  let end = MAX_IOS_SIMULATOR_FIELD_BYTES;
  while (end > 0 && (encoded[end] ?? 0) >> 6 === 0b10) end -= 1;
  return { value: encoded.subarray(0, end).toString("utf8"), truncated: true };
}

export class SimctlError extends Error {
  constructor(message: string, public readonly cmd: string, public readonly stderr?: string) {
    super(message);
    this.name = "SimctlError";
  }
}

async function runSimctl(
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal; maxBufferBytes?: number } = {},
): Promise<string> {
  const bin = xcrunBin();
  try {
    const { stdout } = await execFileBounded(bin, ["simctl", ...args], {
      timeoutMs: opts.timeoutMs ?? 30_000,
      maxBufferBytes: opts.maxBufferBytes ?? 32 * 1024 * 1024,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    throw new SimctlError(
      `xcrun simctl ${args.join(" ")} failed: ${e.message}`,
      `xcrun simctl ${args.join(" ")}`,
      truncateCommandDiagnostic(e.stderr),
    );
  }
}

export async function listSimulatorsWithMeta(
  opts: { onlyBooted?: boolean; signal?: AbortSignal } = {},
): Promise<IosSimulatorListResult> {
  const out = await runSimctl(["list", "devices", "--json"], {
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    maxBufferBytes: 4 * 1024 * 1024,
  });
  const parsed: unknown = JSON.parse(out);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SimctlError("simctl returned a non-object JSON payload", "xcrun simctl list devices");
  }
  const devicesValue = (parsed as Record<string, unknown>)["devices"];
  if (
    devicesValue !== undefined &&
    (typeof devicesValue !== "object" || devicesValue === null || Array.isArray(devicesValue))
  ) {
    throw new SimctlError("simctl returned an invalid devices map", "xcrun simctl list devices");
  }
  const devicesMap = (devicesValue ?? {}) as Record<string, unknown>;
  const result: IosSimulator[] = [];
  let totalDetected = 0;
  let fieldsTruncated = false;
  let scanned = 0;
  for (const [runtime, devices] of Object.entries(devicesMap)) {
    if (!Array.isArray(devices)) continue;
    for (const d of devices) {
      scanned += 1;
      if (scanned > MAX_IOS_SIMULATOR_SCAN_ITEMS) {
        throw new SimctlError(
          `simctl returned more than ${MAX_IOS_SIMULATOR_SCAN_ITEMS} simulator records`,
          "xcrun simctl list devices",
        );
      }
      if (typeof d !== "object" || d === null || Array.isArray(d)) continue;
      const dev = d as Record<string, unknown>;
      const state = boundedSimulatorField(dev["state"]);
      if (opts.onlyBooted && state.value !== "Booted") continue;
      totalDetected += 1;
      if (result.length >= MAX_IOS_SIMULATORS) continue;
      const udid = boundedSimulatorField(dev["udid"]);
      const name = boundedSimulatorField(dev["name"]);
      const runtimeField = boundedSimulatorField(runtime);
      const deviceType = boundedSimulatorField(dev["deviceTypeIdentifier"]);
      fieldsTruncated ||=
        state.truncated ||
        udid.truncated ||
        name.truncated ||
        runtimeField.truncated ||
        deviceType.truncated;
      result.push({
        udid: udid.value,
        name: name.value,
        state: state.value,
        runtime: runtimeField.value,
        ...(deviceType.value ? { deviceTypeId: deviceType.value } : {}),
      });
    }
  }
  return {
    simulators: result,
    totalDetected,
    resultsTruncated: totalDetected > result.length,
    fieldsTruncated,
  };
}

export async function listSimulators(
  opts: { onlyBooted?: boolean; signal?: AbortSignal } = {},
): Promise<IosSimulator[]> {
  return (await listSimulatorsWithMeta(opts)).simulators;
}

export async function pickSimulator(
  preferred?: string,
  signal?: AbortSignal,
): Promise<string> {
  const booted = await listSimulators({
    onlyBooted: true,
    ...(signal !== undefined ? { signal } : {}),
  });
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
  maxBytes: number;
  didReachLimit: () => boolean;
  getTerminationError: () => string | undefined;
  ready: Promise<void>;
  close: () => Promise<void>;
}

/**
 * Spawn `xcrun simctl spawn <udid> log stream` into a file. Optionally filter
 * via an Apple log predicate (e.g. 'processImagePath CONTAINS "MyApp"').
 */
export function spawnIosLogStream(opts: {
  udid: string;
  output: OpenedCaptureOutput;
  predicate?: string;
  level?: "default" | "info" | "debug";
  maxBytes?: number;
  onError?: (error: Error) => void;
}): SpawnedIosLog {
  const maxBytes = validateCaptureMaxBytes(opts.maxBytes);
  const remainingBytes = remainingCaptureBytes(opts.output, maxBytes);
  const args = ["simctl", "spawn", opts.udid, "log", "stream"];
  if (opts.level) args.push(`--level=${opts.level}`);
  if (opts.predicate) {
    args.push("--predicate", opts.predicate);
  }
  const bin = xcrunBin();
  const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
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
          new SimctlError(
            `iOS Simulator log stream reached maxBytes=${maxBytes}; capture stopped to protect disk usage`,
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
    udid: opts.udid,
    maxBytes,
    didReachLimit: () => reachedLimit,
    getTerminationError: () => terminationError,
    ready: lifecycle.ready,
    close: lifecycle.close,
  };
}
