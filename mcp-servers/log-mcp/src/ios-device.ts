// Real iOS device support via libimobiledevice (idevice_id / idevicesyslog /
// idevicecrashreport / ideviceinstaller). This is the counterpart to ios.ts,
// which is simulator-only (xcrun simctl + local .ips). Real-device crashes do
// NOT land in ~/Library/Logs/DiagnosticReports — they must be pulled off the
// device with idevicecrashreport, and live logs come from idevicesyslog.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

// Binaries are overridable for testing / non-standard installs.
const IDEVICE_ID_BIN = process.env.IDEVICE_ID_BIN ?? "idevice_id";
const IDEVICESYSLOG_BIN = process.env.IDEVICESYSLOG_BIN ?? "idevicesyslog";
const IDEVICECRASHREPORT_BIN = process.env.IDEVICECRASHREPORT_BIN ?? "idevicecrashreport";
const IDEVICEINSTALLER_BIN = process.env.IDEVICEINSTALLER_BIN ?? "ideviceinstaller";
const IDEVICEINFO_BIN = process.env.IDEVICEINFO_BIN ?? "ideviceinfo";

export interface IosDevice {
  udid: string;
  name?: string;
  product_type?: string;
  os_version?: string;
}

export class IosDeviceError extends Error {
  constructor(
    message: string,
    public readonly cmd: string,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = "IosDeviceError";
  }
}

async function run(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    // ENOENT → libimobiledevice not installed; give an actionable hint.
    if (e.code === "ENOENT") {
      throw new IosDeviceError(
        `${bin} not found. Install libimobiledevice (e.g. 'brew install libimobiledevice').`,
        `${bin} ${args.join(" ")}`,
      );
    }
    throw new IosDeviceError(
      `${bin} ${args.join(" ")} failed: ${e.message}`,
      `${bin} ${args.join(" ")}`,
      e.stderr,
    );
  }
}

/** List UDIDs of USB-connected real devices (idevice_id -l). */
export async function listDeviceUdids(): Promise<string[]> {
  const out = await run(IDEVICE_ID_BIN, ["-l"]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Fetch a single info key via ideviceinfo; returns undefined on failure. */
async function infoKey(udid: string, key: string): Promise<string | undefined> {
  try {
    const out = await run(IDEVICEINFO_BIN, ["-u", udid, "-k", key], { timeoutMs: 10_000 });
    const v = out.trim();
    return v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** List connected real devices with best-effort name / model / OS version. */
export async function listDevices(): Promise<IosDevice[]> {
  const udids = await listDeviceUdids();
  const devices = await Promise.all(
    udids.map(async (udid): Promise<IosDevice> => {
      const [name, product_type, os_version] = await Promise.all([
        infoKey(udid, "DeviceName"),
        infoKey(udid, "ProductType"),
        infoKey(udid, "ProductVersion"),
      ]);
      const d: IosDevice = { udid };
      if (name !== undefined) d.name = name;
      if (product_type !== undefined) d.product_type = product_type;
      if (os_version !== undefined) d.os_version = os_version;
      return d;
    }),
  );
  return devices;
}

/** Resolve a target UDID: explicit preferred, else the sole connected device. */
export async function pickDevice(preferred?: string): Promise<string> {
  const udids = await listDeviceUdids();
  if (preferred) {
    if (!udids.includes(preferred)) {
      throw new IosDeviceError(
        `Device "${preferred}" not found among connected devices [${udids.join(", ") || "none"}]`,
        `${IDEVICE_ID_BIN} -l`,
      );
    }
    return preferred;
  }
  if (udids.length === 0) {
    throw new IosDeviceError(
      "No iOS real devices connected. Plug in and trust the device, then retry.",
      `${IDEVICE_ID_BIN} -l`,
    );
  }
  if (udids.length > 1) {
    throw new IosDeviceError(
      `Multiple iOS devices connected (${udids.join(", ")}). Pass "device" explicitly.`,
      `${IDEVICE_ID_BIN} -l`,
    );
  }
  return udids[0]!;
}

export interface SpawnedIosDeviceLog {
  process: ChildProcess;
  udid: string;
}

/**
 * Spawn `idevicesyslog -u <udid>` into a file. Optionally narrow with a
 * process-name match (-m NAME, repeatable) which idevicesyslog filters
 * client-side. Real-device analog of ios.ts spawnIosLogStream (simulator).
 */
export async function spawnDeviceSyslog(opts: {
  udid?: string;
  outFilePath: string;
  /** Only include lines mentioning any of these process names (idevicesyslog -m). */
  processMatch?: string[];
}): Promise<SpawnedIosDeviceLog> {
  const udid = await pickDevice(opts.udid);
  const args = ["-u", udid];
  for (const m of opts.processMatch ?? []) {
    args.push("-m", m);
  }
  const out = createWriteStream(opts.outFilePath, { flags: "a" });
  const proc = spawn(IDEVICESYSLOG_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout?.pipe(out);
  proc.stderr?.pipe(out);
  return { process: proc, udid };
}

/**
 * Extract report paths from idevicecrashreport's "Copy: /X" stdout lines.
 * The captured path is RELATIVE to the output directory (the leading slash is
 * idevicecrashreport's device-side root marker, not an absolute host path).
 * Callers join it with the out dir — see pullDeviceCrashes.
 */
export function parseCopiedReports(stdout: string): string[] {
  const files: string[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^Copy:\s*\/?(.+)$/);
    if (m && m[1]) files.push(m[1].trim());
  }
  return files;
}

/**
 * Parse the wall-clock timestamp embedded in a crash-report filename
 * (e.g. "Runner-2025-04-27-173725.ips" → epoch ms). The stamp is the device's
 * LOCAL time; when the phone is tethered its zone usually matches the host, but
 * a mismatch skews the comparison — so callers should treat since_minutes as a
 * generous window, not an exact cutoff. Returns null if no stamp is present.
 */
export function parseReportTimestamp(name: string): number | null {
  const m = name.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const t = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  ).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Keep only reports whose filename timestamp is within the last `sinceMinutes`.
 * Names without a parseable stamp are KEPT (safer to surface than silently drop
 * a crash). `now` is injectable for testing. Pure — no I/O.
 */
export function filterReportsSince(
  files: string[],
  sinceMinutes: number,
  now: number = Date.now(),
): string[] {
  const cutoff = now - sinceMinutes * 60_000;
  return files.filter((f) => {
    const ts = parseReportTimestamp(f);
    return ts === null || ts >= cutoff;
  });
}

/**
 * Pull crash reports off the device into outDir via idevicecrashreport.
 * By default keeps them on-device (-k) and extracts raw .crash/.ips (-e).
 * Optional case-sensitive name filter (-f) narrows what gets copied to ONE
 * app/process. `sinceMinutes` narrows the RETURNED list to reports whose
 * filename timestamp is within the window (idevicecrashreport itself has no
 * time filter, so all matching files still land on disk — this only trims the
 * response so a per-step QA loop isn't handed the device's entire backlog).
 * Returned `files` are absolute host paths (outDir joined), ready to open.
 */
export async function pullDeviceCrashes(opts: {
  udid?: string;
  outDir: string;
  filter?: string;
  keepOnDevice?: boolean;
  extract?: boolean;
  sinceMinutes?: number;
}): Promise<{
  udid: string;
  out_dir: string;
  count: number;
  files: string[];
  total_copied: number;
}> {
  const udid = await pickDevice(opts.udid);
  // idevicecrashreport requires the target directory to already exist.
  await mkdir(opts.outDir, { recursive: true });
  const args = ["-u", udid];
  if (opts.keepOnDevice !== false) args.push("-k"); // default: do not delete from device
  if (opts.extract !== false) args.push("-e"); // default: extract raw report
  if (opts.filter) args.push("-f", opts.filter);
  args.push(opts.outDir);
  const output = await run(IDEVICECRASHREPORT_BIN, args, { timeoutMs: 120_000 });

  // idevicecrashreport prints "Copy: /<path-relative-to-outDir>", so the parsed
  // names are relative (usually a basename, sometimes "Retired/Foo.ips"). Filter
  // by timestamp on those names, then join with outDir so callers get paths they
  // can hand straight to analyzer.parse_ips_file — no manual joining required.
  const allCopied = parseCopiedReports(output);
  const kept =
    opts.sinceMinutes !== undefined
      ? filterReportsSince(allCopied, opts.sinceMinutes)
      : allCopied;
  const files = kept.map((rel) => path.join(opts.outDir, rel));
  return {
    udid,
    out_dir: opts.outDir,
    count: files.length,
    files,
    total_copied: allCopied.length,
  };
}

export interface IosInstalledApp {
  bundle_id: string;
  version?: string;
  name?: string;
}

/**
 * List installed apps via `ideviceinstaller list`. type selects user/system/all.
 * Parses the CSV-ish default output: `bundleId, "version", "DisplayName"`.
 */
export async function listApps(opts: {
  udid?: string;
  type?: "user" | "system" | "all";
}): Promise<IosInstalledApp[]> {
  const udid = await pickDevice(opts.udid);
  const typeFlag =
    opts.type === "system" ? "--system" : opts.type === "all" ? "--all" : "--user";
  const out = await run(IDEVICEINSTALLER_BIN, ["-u", udid, "list", typeFlag], {
    timeoutMs: 60_000,
  });
  const apps: IosInstalledApp[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip the header row emitted by newer ideviceinstaller.
    if (trimmed.startsWith("CFBundleIdentifier")) continue;
    const m = trimmed.match(/^([^,]+),\s*"([^"]*)",\s*"([^"]*)"/);
    if (m) {
      apps.push({ bundle_id: m[1]!.trim(), version: m[2], name: m[3] });
    } else {
      // Fallback: first comma-separated token as bundle id.
      const bid = trimmed.split(",")[0]?.trim();
      if (bid) apps.push({ bundle_id: bid });
    }
  }
  return apps;
}
