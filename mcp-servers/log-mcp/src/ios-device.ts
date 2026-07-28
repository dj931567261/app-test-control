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
import { pipeCaptureToFile } from "./file-capture.js";

const execFileAsync = promisify(execFile);

// Binaries are overridable for testing / non-standard installs. Resolve the
// environment at call time so tests and long-running MCP processes can apply
// configuration without reloading this module.
const ideviceIdBin = () => process.env.IDEVICE_ID_BIN ?? "idevice_id";
const ideviceSyslogBin = () => process.env.IDEVICESYSLOG_BIN ?? "idevicesyslog";
const ideviceCrashReportBin = () =>
  process.env.IDEVICECRASHREPORT_BIN ?? "idevicecrashreport";
const ideviceInstallerBin = () =>
  process.env.IDEVICEINSTALLER_BIN ?? "ideviceinstaller";
const ideviceInfoBin = () => process.env.IDEVICEINFO_BIN ?? "ideviceinfo";

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
  const out = await run(ideviceIdBin(), ["-l"]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Fetch a single info key via ideviceinfo; returns undefined on failure. */
async function infoKey(udid: string, key: string): Promise<string | undefined> {
  try {
    const out = await run(ideviceInfoBin(), ["-u", udid, "-k", key], {
      timeoutMs: 10_000,
    });
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
        `${ideviceIdBin()} -l`,
      );
    }
    return preferred;
  }
  if (udids.length === 0) {
    throw new IosDeviceError(
      "No iOS real devices connected. Plug in and trust the device, then retry.",
      `${ideviceIdBin()} -l`,
    );
  }
  if (udids.length > 1) {
    throw new IosDeviceError(
      `Multiple iOS devices connected (${udids.join(", ")}). Pass "device" explicitly.`,
      `${ideviceIdBin()} -l`,
    );
  }
  return udids[0]!;
}

export interface SpawnedIosDeviceLog {
  process: ChildProcess;
  udid: string;
  maxBytes: number;
  didReachLimit: () => boolean;
  /** Runtime/limit failure retained even when the child has already exited. */
  getTerminationError: () => string | undefined;
  /** Stop the child and wait until the capture file has been flushed. Idempotent. */
  close: () => Promise<void>;
}

/** 单次真机日志默认最多写 256 MiB，避免未过滤 syslog 长时间占满磁盘。 */
export const DEFAULT_IOS_DEVICE_SYSLOG_MAX_BYTES = 256 * 1024 * 1024;
/** 即使调用方显式放宽，也保留 2 GiB 的硬上限。 */
export const MAX_IOS_DEVICE_SYSLOG_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Spawn `idevicesyslog -u <udid>` into a file. Optionally narrow with the
 * process filter (`-p NAME`); multiple names use idevicesyslog's `A|B` syntax.
 * Real-device analog of ios.ts spawnIosLogStream (simulator).
 */
export async function spawnDeviceSyslog(opts: {
  udid?: string;
  outFilePath: string;
  /** Only include records emitted by these process names (idevicesyslog -p). */
  processMatch?: string[];
  /** Maximum bytes appended by this capture before it is stopped. */
  maxBytes?: number;
  /** Runtime failures after a successful spawn are reported here if provided. */
  onError?: (error: Error) => void;
}): Promise<SpawnedIosDeviceLog> {
  const bin = ideviceSyslogBin();
  const maxBytes = opts.maxBytes ?? DEFAULT_IOS_DEVICE_SYSLOG_MAX_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > MAX_IOS_DEVICE_SYSLOG_MAX_BYTES
  ) {
    throw new IosDeviceError(
      `maxBytes must be a positive safe integer no greater than ${MAX_IOS_DEVICE_SYSLOG_MAX_BYTES}`,
      `${bin} -u <udid>`,
    );
  }
  const processes: string[] = [];
  for (const rawName of opts.processMatch ?? []) {
    const name = rawName.trim();
    if (!name || name.includes("|")) {
      throw new IosDeviceError(
        "processMatch entries must be non-empty process names without '|'",
        `${bin} -p <process>`,
      );
    }
    if (!processes.includes(name)) processes.push(name);
  }
  const udid = await pickDevice(opts.udid);
  const args = ["-u", udid];
  if (processes.length > 0) args.push("-p", processes.join("|"));
  const out = createWriteStream(opts.outFilePath, { flags: "a" });
  const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  let terminationError: string | undefined;
  let reachedLimit = false;
  const reportRuntimeError = (error: Error) => {
    terminationError ??= error.message;
    opts.onError?.(error);
  };
  const lifecycle = pipeCaptureToFile(proc, out, `${bin} ${args.join(" ")}`, {
    maxBytes,
    onError: reportRuntimeError,
    onLimit: (limit) => {
      reachedLimit = true;
      reportRuntimeError(
        new IosDeviceError(
          `iOS device syslog reached maxBytes=${limit}; capture stopped to protect disk usage`,
          `${bin} ${args.join(" ")}`,
        ),
      );
    },
  });

  try {
    await lifecycle.ready;
  } catch (cause) {
    if (reachedLimit) {
      // A deliberately tiny limit can be reached during the startup grace
      // window. Flush it and still return a terminal-capable handle so the
      // capture manager can expose reason=limit_reached instead of losing it.
      try {
        await lifecycle.close();
      } catch (closeCause) {
        throw new IosDeviceError(
          `Syslog reached maxBytes during startup but failed to flush: ${closeCause instanceof Error ? closeCause.message : String(closeCause)}`,
          `${bin} ${args.join(" ")}`,
        );
      }
    } else {
      await lifecycle.close().catch(() => undefined);
      throw new IosDeviceError(
        `Failed to start ${bin}: ${cause instanceof Error ? cause.message : String(cause)}`,
        `${bin} ${args.join(" ")}`,
      );
    }
  }

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= lifecycle.close().catch((cause: unknown) => {
      throw new IosDeviceError(
        `Failed to stop ${bin} cleanly: ${cause instanceof Error ? cause.message : String(cause)}`,
        `${bin} ${args.join(" ")}`,
      );
    });
    return closePromise;
  };

  return {
    process: proc,
    udid,
    maxBytes,
    didReachLimit: () => reachedLimit,
    getTerminationError: () => terminationError,
    close,
  };
}

/**
 * Extract report paths from idevicecrashreport's "Copy: /X" (keep mode) or
 * "Move: /X" (remove mode) stdout lines. The leading slash is a device-side
 * root marker and is stripped; the result remains relative to the output dir.
 */
export function parseCopiedReports(stdout: string): string[] {
  const files: string[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^(?:Copy|Move):\s*\/?(.+)$/);
    if (m && m[1]) files.push(m[1].trim());
  }
  return files;
}

interface ReportDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function parseReportDateParts(name: string): ReportDateParts | null {
  const m = name.match(
    /(?:^|[^0-9])(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(?![0-9])/,
  );
  if (!m) return null;
  const parts: ReportDateParts = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6]),
  };
  if (
    parts.year < 2000 ||
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.day > 31 ||
    parts.hour > 23 ||
    parts.minute > 59 ||
    parts.second > 59
  ) {
    return null;
  }
  // Date constructors normalize values such as 2025-02-29 to March 1. Reject
  // those before either local-zone or explicit-device-zone conversion.
  if (!sameDateParts(new Date(partsAsUtc(parts)), parts, true)) return null;
  return parts;
}

function sameDateParts(date: Date, parts: ReportDateParts, utc: boolean): boolean {
  const read = (local: number, universal: number) => (utc ? universal : local);
  return (
    read(date.getFullYear(), date.getUTCFullYear()) === parts.year &&
    read(date.getMonth(), date.getUTCMonth()) === parts.month - 1 &&
    read(date.getDate(), date.getUTCDate()) === parts.day &&
    read(date.getHours(), date.getUTCHours()) === parts.hour &&
    read(date.getMinutes(), date.getUTCMinutes()) === parts.minute &&
    read(date.getSeconds(), date.getUTCSeconds()) === parts.second
  );
}

function partsAsUtc(parts: ReportDateParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

function formatterForTimeZone(timeZone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return null;
  }
}

function formattedDateParts(
  formatter: Intl.DateTimeFormat,
  epochMs: number,
): ReportDateParts | null {
  const values = new Map(
    formatter
      .formatToParts(new Date(epochMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const parts: ReportDateParts = {
    year: values.get("year") ?? Number.NaN,
    month: values.get("month") ?? Number.NaN,
    day: values.get("day") ?? Number.NaN,
    hour: values.get("hour") ?? Number.NaN,
    minute: values.get("minute") ?? Number.NaN,
    second: values.get("second") ?? Number.NaN,
  };
  return Object.values(parts).every(Number.isFinite) ? parts : null;
}

/** Convert a wall-clock value in an IANA time zone to an epoch. */
function zonedDatePartsToEpoch(parts: ReportDateParts, timeZone: string): number | null {
  const formatter = formatterForTimeZone(timeZone);
  if (!formatter) return null;
  const target = partsAsUtc(parts);
  let guess = target;
  // Offset calculation is iterative because DST offset at the UTC guess can
  // differ from the offset at the final instant.
  for (let i = 0; i < 4; i += 1) {
    const observed = formattedDateParts(formatter, guess);
    if (!observed) return null;
    const delta = target - partsAsUtc(observed);
    guess += delta;
    if (delta === 0) break;
  }
  const finalParts = formattedDateParts(formatter, guess);
  if (!finalParts) return null;
  if (partsAsUtc(finalParts) !== target) return null;

  // During a DST rollback the same wall clock can map to two instants. The
  // iterative solver above finds one of them (usually the earlier one), which
  // could make a just-created report look an hour old and fall outside a short
  // since_minutes window. Collect offsets immediately around the transition,
  // verify every derived candidate, and choose the latest valid instant. This
  // favors surfacing a report over silently dropping it.
  const offsets = new Set<number>();
  const probeDelta = 36 * 60 * 60_000;
  for (const probe of [guess, guess - probeDelta, guess + probeDelta]) {
    const observed = formattedDateParts(formatter, probe);
    if (observed) offsets.add(partsAsUtc(observed) - probe);
  }
  const candidates = [guess];
  for (const offset of offsets) {
    const candidate = target - offset;
    const observed = formattedDateParts(formatter, candidate);
    if (observed && partsAsUtc(observed) === target) candidates.push(candidate);
  }
  return Math.max(...candidates);
}

/**
 * Parse the wall-clock timestamp embedded in a crash-report filename. If an
 * IANA `timeZone` is supplied, interpret it in the device's zone; otherwise use
 * the host's local zone. Invalid/calendar-normalized values return null.
 */
export function parseReportTimestamp(name: string, timeZone?: string): number | null {
  const parts = parseReportDateParts(name);
  if (!parts) return null;
  if (timeZone !== undefined) return zonedDatePartsToEpoch(parts, timeZone);
  const date = new Date(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return sameDateParts(date, parts, false) ? date.getTime() : null;
}

export interface ReportTimeFilterOptions {
  /** Parse filename wall clocks in this IANA zone when the device reports it. */
  timeZone?: string;
  /**
   * If the device zone is unavailable, widen by the maximum UTC offset (14h).
   * This deliberately favors false positives over missing a recent crash.
   */
  conservativeUnknownTimeZone?: boolean;
}

/**
 * Keep reports whose filename timestamp is within `sinceMinutes`. Unparseable
 * names are kept rather than silently losing a crash. `now` is injectable and
 * must represent the time at which the pull request started.
 */
export function filterReportsSince(
  files: string[],
  sinceMinutes: number,
  now: number = Date.now(),
  options: ReportTimeFilterOptions = {},
): string[] {
  if (!Number.isInteger(sinceMinutes) || sinceMinutes <= 0) {
    throw new RangeError("sinceMinutes must be a positive integer");
  }
  if (!Number.isFinite(now)) throw new RangeError("now must be a finite epoch timestamp");
  const unknownZoneAllowance = options.conservativeUnknownTimeZone
    ? 14 * 60 * 60_000
    : 0;
  const cutoff = now - sinceMinutes * 60_000 - unknownZoneAllowance;
  return files.filter((file) => {
    // In conservative mode, parse the wall clock as UTC and widen the cutoff.
    // This is independent of the host's zone and covers current UTC-12..+14.
    const ts = options.conservativeUnknownTimeZone
      ? (() => {
          const parts = parseReportDateParts(file);
          if (!parts) return null;
          const date = new Date(partsAsUtc(parts));
          return sameDateParts(date, parts, true) ? date.getTime() : null;
        })()
      : parseReportTimestamp(file, options.timeZone);
    return ts === null || ts >= cutoff;
  });
}

/** Resolve a tool-reported device-relative path and enforce output containment. */
export function resolveReportPath(outDir: string, relativeReportPath: string): string {
  if (!path.isAbsolute(outDir)) {
    throw new Error(`outDir must be an absolute path: "${outDir}"`);
  }
  if (
    relativeReportPath.length === 0 ||
    relativeReportPath.includes("\0") ||
    path.posix.isAbsolute(relativeReportPath) ||
    relativeReportPath.split(/[\\/]/).some((part) => part === "..")
  ) {
    throw new Error(
      `Unsafe crash-report path returned by idevicecrashreport: "${relativeReportPath}"`,
    );
  }
  const root = path.resolve(outDir);
  const resolved = path.resolve(root, ...relativeReportPath.split(/[\\/]+/));
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Crash-report path escapes outDir: "${relativeReportPath}"`);
  }
  return resolved;
}

/**
 * Normalize and validate the process filter used by idevicecrashreport.
 *
 * Read-only pulls may omit the filter, but an explicitly supplied value must
 * contain more than whitespace. Destructive pulls are deliberately stricter:
 * they must always name one exact executable/process so an accidental missing
 * argument can never remove the device's entire crash-report backlog.
 */
export function validateCrashReportFilter(
  filter: string | undefined,
  options: { removingFromDevice?: boolean } = {},
): string | undefined {
  const normalized = filter?.trim();
  if (normalized === undefined || normalized.length === 0) {
    if (options.removingFromDevice === true) {
      throw new Error(
        "Refusing to remove crash reports from the device: remove_from_device=true requires a non-empty, non-whitespace filter containing the exact executable/process name.",
      );
    }
    if (filter !== undefined) {
      throw new Error(
        "filter must contain a non-empty, non-whitespace executable/process name; omit it for an unfiltered read-only pull.",
      );
    }
    return undefined;
  }
  return normalized;
}

/**
 * Pull crash reports off the device into an absolute outDir. Keeping reports is
 * the default. `sinceMinutes` filters only the returned list because the CLI has
 * no server-side time predicate; therefore removal and time filtering cannot be
 * combined safely. The cutoff is frozen before device lookup/transfer.
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
  since_reference_time: string | null;
  device_time_zone: string | null;
  time_filter_mode: "none" | "device-time-zone" | "conservative-unknown-time-zone";
}> {
  // Freeze before any async work. A report near the cutoff must not age out
  // during an idevicecrashreport transfer that can take up to 120 seconds.
  const sinceReferenceTime = Date.now();
  if (!path.isAbsolute(opts.outDir)) {
    throw new Error(`outDir must be an absolute path: "${opts.outDir}"`);
  }
  if (
    opts.sinceMinutes !== undefined &&
    (!Number.isInteger(opts.sinceMinutes) || opts.sinceMinutes <= 0)
  ) {
    throw new RangeError("sinceMinutes must be a positive integer");
  }
  const filter = validateCrashReportFilter(opts.filter, {
    removingFromDevice: opts.keepOnDevice === false,
  });
  if (opts.keepOnDevice === false && opts.sinceMinutes !== undefined) {
    throw new Error(
      "Cannot combine remove_from_device with since_minutes: idevicecrashreport has no server-side time filter and would remove older reports too.",
    );
  }

  const outDir = path.resolve(opts.outDir);
  const udid = await pickDevice(opts.udid);
  const reportedTimeZone =
    opts.sinceMinutes !== undefined ? await infoKey(udid, "TimeZone") : undefined;
  const deviceTimeZone =
    reportedTimeZone && formatterForTimeZone(reportedTimeZone)
      ? reportedTimeZone
      : undefined;

  // idevicecrashreport requires the target directory to already exist.
  await mkdir(outDir, { recursive: true });
  const args = ["-u", udid];
  if (opts.keepOnDevice !== false) args.push("-k");
  if (opts.extract !== false) args.push("-e");
  if (filter !== undefined) args.push("-f", filter);
  args.push(outDir);
  const bin = ideviceCrashReportBin();
  const output = await run(bin, args, { timeoutMs: 120_000 });

  const allCopied = parseCopiedReports(output);
  const kept =
    opts.sinceMinutes !== undefined
      ? filterReportsSince(allCopied, opts.sinceMinutes, sinceReferenceTime, {
          ...(deviceTimeZone
            ? { timeZone: deviceTimeZone }
            : { conservativeUnknownTimeZone: true }),
        })
      : allCopied;
  const files = kept.map((relative) => resolveReportPath(outDir, relative));
  return {
    udid,
    out_dir: outDir,
    count: files.length,
    files,
    total_copied: allCopied.length,
    since_reference_time:
      opts.sinceMinutes === undefined
        ? null
        : new Date(sinceReferenceTime).toISOString(),
    device_time_zone: deviceTimeZone ?? null,
    time_filter_mode:
      opts.sinceMinutes === undefined
        ? "none"
        : deviceTimeZone
          ? "device-time-zone"
          : "conservative-unknown-time-zone",
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
  const out = await run(ideviceInstallerBin(), ["-u", udid, "list", typeFlag], {
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
