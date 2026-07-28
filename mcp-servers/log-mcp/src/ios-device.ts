// Real iOS device support via libimobiledevice (idevice_id / idevicesyslog /
// idevicecrashreport / ideviceinstaller). This is the counterpart to ios.ts,
// which is simulator-only (xcrun simctl + local .ips). Real-device crashes do
// NOT land in ~/Library/Logs/DiagnosticReports — they must be pulled off the
// device with idevicecrashreport, and live logs come from idevicesyslog.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  link,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { pipeCaptureToFile } from "./file-capture.js";
import { execFileBounded, truncateCommandDiagnostic } from "./bounded-exec.js";
import {
  DEFAULT_CAPTURE_MAX_BYTES,
  MAX_CAPTURE_MAX_BYTES,
  openCaptureOutput,
  remainingCaptureBytes,
  validateCaptureMaxBytes,
  type OpenedCaptureOutput,
} from "./capture-output.js";
import { openSecureDirectory } from "./secure-directory.js";

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

const MAX_CONNECTED_IOS_DEVICES = 32;
const MAX_IOS_DEVICE_INFO_BYTES = 512;

async function run(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal; maxBufferBytes?: number } = {},
): Promise<string> {
  try {
    const { stdout } = await execFileBounded(bin, args, {
      timeoutMs: opts.timeoutMs ?? 30_000,
      maxBufferBytes: opts.maxBufferBytes ?? 32 * 1024 * 1024,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
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
      truncateCommandDiagnostic(e.stderr),
    );
  }
}

/** List UDIDs of USB-connected real devices (idevice_id -l). */
export async function listDeviceUdids(signal?: AbortSignal): Promise<string[]> {
  const out = await run(ideviceIdBin(), ["-l"], {
    signal,
    maxBufferBytes: 1024 * 1024,
  });
  const udids = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (udids.length > MAX_CONNECTED_IOS_DEVICES) {
    throw new IosDeviceError(
      `idevice_id returned more than ${MAX_CONNECTED_IOS_DEVICES} connected devices`,
      `${ideviceIdBin()} -l`,
    );
  }
  for (const udid of udids) {
    if (Buffer.byteLength(udid, "utf8") > MAX_IOS_DEVICE_INFO_BYTES) {
      throw new IosDeviceError(
        `idevice_id returned an overlong device identifier`,
        `${ideviceIdBin()} -l`,
      );
    }
  }
  return Array.from(new Set(udids));
}

/** Fetch a single info key via ideviceinfo; returns undefined on failure. */
async function infoKey(
  udid: string,
  key: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const out = await run(ideviceInfoBin(), ["-u", udid, "-k", key], {
      timeoutMs: 10_000,
      maxBufferBytes: 64 * 1024,
      ...(signal !== undefined ? { signal } : {}),
    });
    const v = boundedUtf8(out.trim(), MAX_IOS_DEVICE_INFO_BYTES).value;
    return v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** List connected real devices with best-effort name / model / OS version. */
export async function listDevices(): Promise<IosDevice[]> {
  const udids = await listDeviceUdids();
  const deadline = AbortSignal.timeout(30_000);
  const devices: IosDevice[] = [];
  // Bound concurrent helper processes even if a compromised idevice_id emits
  // the maximum accepted number of synthetic UDIDs.
  for (const udid of udids) {
    const [name, product_type, os_version] = await Promise.all([
      infoKey(udid, "DeviceName", deadline),
      infoKey(udid, "ProductType", deadline),
      infoKey(udid, "ProductVersion", deadline),
    ]);
    const d: IosDevice = { udid };
    if (name !== undefined) d.name = name;
    if (product_type !== undefined) d.product_type = product_type;
    if (os_version !== undefined) d.os_version = os_version;
    devices.push(d);
  }
  return devices;
}

/** Resolve a target UDID: explicit preferred, else the sole connected device. */
export async function pickDevice(
  preferred?: string,
  signal?: AbortSignal,
): Promise<string> {
  const udids = await listDeviceUdids(signal);
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
  /** Startup verification; capture manager registers the provisional child first. */
  ready?: Promise<void>;
  /** Stop the child and wait until the capture file has been flushed. Idempotent. */
  close: () => Promise<void>;
}

/** 单个真机日志文件默认最多 256 MiB，避免未过滤 syslog 长时间占满磁盘。 */
export const DEFAULT_IOS_DEVICE_SYSLOG_MAX_BYTES = DEFAULT_CAPTURE_MAX_BYTES;
/** 即使调用方显式放宽，也保留 2 GiB 的硬上限。 */
export const MAX_IOS_DEVICE_SYSLOG_MAX_BYTES = MAX_CAPTURE_MAX_BYTES;

function normalizeSyslogProcesses(processMatch: string[] | undefined): string[] {
  const processes: string[] = [];
  for (const rawName of processMatch ?? []) {
    const name = rawName.trim();
    if (!name || name.includes("|")) {
      throw new IosDeviceError(
        "processMatch entries must be non-empty process names without '|'",
        `${ideviceSyslogBin()} -p <process>`,
      );
    }
    if (!processes.includes(name)) processes.push(name);
  }
  return processes;
}

/** Spawn against an already selected device and an already validated output fd. */
export function beginDeviceSyslog(opts: {
  udid: string;
  output: OpenedCaptureOutput;
  processMatch?: string[];
  maxBytes?: number;
  onError?: (error: Error) => void;
}): SpawnedIosDeviceLog & { ready: Promise<void> } {
  const bin = ideviceSyslogBin();
  let maxBytes: number;
  try {
    maxBytes = validateCaptureMaxBytes(opts.maxBytes);
  } catch (error) {
    throw new IosDeviceError(
      error instanceof Error ? error.message : String(error),
      `${bin} -u <udid>`,
    );
  }
  const processes = normalizeSyslogProcesses(opts.processMatch);
  let remainingBytes: number;
  try {
    remainingBytes = remainingCaptureBytes(opts.output, maxBytes);
  } catch (error) {
    throw new IosDeviceError(
      error instanceof Error ? error.message : String(error),
      `open ${opts.output.requestedPath}`,
    );
  }

  const args = ["-u", opts.udid];
  if (processes.length > 0) args.push("-p", processes.join("|"));
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
          new IosDeviceError(
            `iOS device syslog reached maxBytes=${maxBytes}; capture stopped to protect disk usage`,
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
    udid: opts.udid,
    maxBytes,
    didReachLimit: () => reachedLimit,
    getTerminationError: () => terminationError,
    ready: lifecycle.ready,
    close,
  };
}

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
  /** Maximum total size of the capture file before this capture is stopped. */
  maxBytes?: number;
  /** Runtime failures after a successful spawn are reported here if provided. */
  onError?: (error: Error) => void;
}): Promise<SpawnedIosDeviceLog> {
  const bin = ideviceSyslogBin();
  let maxBytes: number;
  try {
    maxBytes = validateCaptureMaxBytes(opts.maxBytes);
  } catch (error) {
    throw new IosDeviceError(
      error instanceof Error ? error.message : String(error),
      `${bin} -u <udid>`,
    );
  }
  // Preserve fail-fast validation before any device lookup or filesystem work.
  normalizeSyslogProcesses(opts.processMatch);
  const output = await openCaptureOutput(opts.outFilePath).catch((cause: unknown) => {
    throw new IosDeviceError(
      `Refusing unsafe iOS syslog output "${opts.outFilePath}": ${cause instanceof Error ? cause.message : String(cause)}`,
      `open ${opts.outFilePath}`,
    );
  });
  let started: ReturnType<typeof beginDeviceSyslog> | undefined;

  try {
    const udid = await pickDevice(opts.udid);
    started = beginDeviceSyslog({
      udid,
      output,
      maxBytes,
      ...(opts.processMatch !== undefined ? { processMatch: opts.processMatch } : {}),
      ...(opts.onError !== undefined ? { onError: opts.onError } : {}),
    });
    await started.ready;
  } catch (cause) {
    if (started?.didReachLimit()) {
      // A deliberately tiny limit can be reached during the startup grace
      // window. Flush it and still return a terminal-capable handle so the
      // capture manager can expose reason=limit_reached instead of losing it.
      try {
        await started.close();
      } catch (closeCause) {
        throw new IosDeviceError(
          `Syslog reached maxBytes during startup but failed to flush: ${closeCause instanceof Error ? closeCause.message : String(closeCause)}`,
          `${bin} -u ${started.udid}`,
        );
      }
    } else {
      if (started) await started.close().catch(() => undefined);
      else await output.close().catch(() => undefined);
      throw new IosDeviceError(
        `Failed to start ${bin}: ${cause instanceof Error ? cause.message : String(cause)}`,
        `${bin} -u ${started?.udid ?? opts.udid ?? "<auto>"}`,
      );
    }
  }
  return started!;
}

/**
 * Extract report paths from idevicecrashreport's "Link: /X", "Copy: /X", or
 * "Move: /X" stdout lines. The leading slash is a device-side root marker and
 * is stripped; the result remains relative to the output dir and must still be
 * passed through resolveReportPath before being exposed to callers.
 */
export function parseCopiedReports(stdout: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const m = line.match(/^(?:Link|Copy|Move):\s*\/?(.+)$/);
    const reportPath = m?.[1]?.trim();
    if (!reportPath) continue;
    if (reportPath.length > MAX_DEVICE_CRASH_REPORT_PATH_LENGTH) {
      throw new Error(
        `idevicecrashreport returned a path longer than ${MAX_DEVICE_CRASH_REPORT_PATH_LENGTH} characters`,
      );
    }
    if (seen.has(reportPath)) continue;
    if (files.length >= MAX_DEVICE_CRASH_REPORTS) {
      throw new Error(
        `idevicecrashreport returned more than ${MAX_DEVICE_CRASH_REPORTS} report paths`,
      );
    }
    seen.add(reportPath);
    files.push(reportPath);
  }
  return files;
}

export const MAX_DEVICE_CRASH_REPORTS = 128;
export const MAX_DEVICE_CRASH_REPORT_PATH_LENGTH = 4_096;
export const MAX_DEVICE_CRASH_REPORT_BYTES = 256 * 1024 * 1024;
/** Total logical bytes allowed in one private idevicecrashreport staging run. */
export const MAX_DEVICE_CRASH_STAGING_BYTES = 512 * 1024 * 1024;
/** Files plus directories allowed in one private staging tree. */
export const MAX_DEVICE_CRASH_STAGING_ENTRIES = 2_000;
const DEVICE_CRASH_STAGING_POLL_MS = 25;

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

export interface DirectoryIdentity {
  requestedPath: string;
  canonicalPath: string;
  inodeKey: string;
  dev: bigint;
  ino: bigint;
  handle: FileHandle;
  assertUnchanged: () => Promise<void>;
  close: () => Promise<void>;
}

async function readDirectoryIdentity(directory: string): Promise<DirectoryIdentity> {
  const secured = await openSecureDirectory(directory);
  return {
    requestedPath: secured.requestedPath,
    canonicalPath: secured.canonicalPath,
    inodeKey: `${secured.dev}:${secured.ino}`,
    dev: secured.dev,
    ino: secured.ino,
    handle: secured.handle,
    assertUnchanged: secured.assertUnchanged,
    close: secured.close,
  };
}

async function assertDirectoryIdentity(identity: DirectoryIdentity): Promise<void> {
  await identity.assertUnchanged();
  const current = await stat(identity.canonicalPath, { bigint: true });
  if (
    !current.isDirectory() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  ) {
    throw new Error("Crash-report outDir changed during idevicecrashreport transfer");
  }
}

export interface CrashStagingUsage {
  entries: number;
  bytes: number;
}

/**
 * Scan staging without following links. Logical file sizes are used so sparse
 * files cannot bypass the quota. Unsafe entry types/hardlinks fail closed.
 */
export async function scanCrashStaging(
  stagingRoot: string,
): Promise<CrashStagingUsage> {
  const pending: Array<{ directory: string; root: boolean }> = [
    { directory: stagingRoot, root: true },
  ];
  let entries = 0;
  let bytes = 0n;
  const expectedUid =
    typeof process.geteuid === "function" ? BigInt(process.geteuid()) : undefined;

  while (pending.length > 0) {
    const { directory, root } = pending.pop()!;
    let opened;
    try {
      opened = await opendir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !root) continue;
      throw error;
    }
    try {
      for await (const entry of opened) {
        entries += 1;
        if (entries > MAX_DEVICE_CRASH_STAGING_ENTRIES) {
          throw new Error(
            `idevicecrashreport staging exceeded ${MAX_DEVICE_CRASH_STAGING_ENTRIES} entries`,
          );
        }
        const entryPath = path.join(directory, entry.name);
        if (entryPath.length > MAX_DEVICE_CRASH_REPORT_PATH_LENGTH) {
          throw new Error(
            `idevicecrashreport staging path exceeded ${MAX_DEVICE_CRASH_REPORT_PATH_LENGTH} characters`,
          );
        }
        let info;
        try {
          info = await lstat(entryPath, { bigint: true });
        } catch (error) {
          // The producer may atomically rename a temporary entry while a live
          // scan is in progress. The next poll/final scan sees its replacement.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (expectedUid !== undefined && info.uid !== expectedUid) {
          throw new Error("idevicecrashreport staging contains an entry owned by another user");
        }
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
          throw new Error(
            `idevicecrashreport staging contains an unsafe entry type: "${entryPath}"`,
          );
        }
        if (info.isDirectory()) {
          pending.push({ directory: entryPath, root: false });
          continue;
        }
        if (info.nlink !== 1n) {
          throw new Error(
            `idevicecrashreport staging contains a multi-link file: "${entryPath}"`,
          );
        }
        bytes += info.size;
        if (bytes > BigInt(MAX_DEVICE_CRASH_STAGING_BYTES)) {
          throw new Error(
            `idevicecrashreport staging exceeded ${MAX_DEVICE_CRASH_STAGING_BYTES} bytes`,
          );
        }
      }
    } finally {
      await opened.close().catch(() => undefined);
    }
  }
  return { entries, bytes: Number(bytes) };
}

async function monitorCrashStaging(
  stagingRoot: string,
  done: Promise<void>,
  abortController: AbortController,
): Promise<void> {
  let completed = false;
  void done.then(() => {
    completed = true;
  });
  while (!completed) {
    try {
      await scanCrashStaging(stagingRoot);
    } catch (error) {
      abortController.abort(error);
      throw error;
    }
    await Promise.race([
      done,
      new Promise<void>((resolve) => {
        setTimeout(resolve, DEVICE_CRASH_STAGING_POLL_MS);
      }),
    ]);
  }
  // Always take a final post-exit snapshot before any file is published.
  await scanCrashStaging(stagingRoot);
}

async function rejectUnsafePublishedReport(destination: string): Promise<boolean> {
  let current;
  try {
    current = await lstat(destination, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n) {
    throw new Error(`Refusing unsafe existing crash-report destination: "${destination}"`);
  }
  if (
    typeof process.geteuid === "function" &&
    current.uid !== BigInt(process.geteuid())
  ) {
    throw new Error(`Existing crash-report destination must be owned by the current user`);
  }
  return true;
}

function stableCrashReportName(relativeReportPath: string): string {
  return `${createHash("sha256").update(relativeReportPath).digest("hex")}.ips`;
}

async function hashVerifiedFile(
  filePath: string,
  expected?: { dev: bigint; ino: bigint; size: bigint; mtimeNs?: bigint },
): Promise<{
  digest: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}> {
  const handle = await open(
    filePath,
    fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(MAX_DEVICE_CRASH_REPORT_BYTES) ||
      (expected !== undefined &&
        (before.dev !== expected.dev ||
          before.ino !== expected.ino ||
          before.size !== expected.size ||
          (expected.mtimeNs !== undefined && before.mtimeNs !== expected.mtimeNs)))
    ) {
      throw new Error(`Crash report changed before hashing: "${filePath}"`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0n;
    while (offset < before.size) {
      const remaining = before.size - offset;
      const requested = Number(
        remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length),
      );
      const { bytesRead } = await handle.read(buffer, 0, requested, Number(offset));
      if (bytesRead === 0) throw new Error(`Crash report ended while hashing: "${filePath}"`);
      hash.update(buffer.subarray(0, bytesRead));
      offset += BigInt(bytesRead);
    }
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs
    ) {
      throw new Error(`Crash report changed while hashing: "${filePath}"`);
    }
    return {
      digest: hash.digest("hex"),
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs,
    };
  } finally {
    await handle.close();
  }
}

interface StagedReportForPublish {
  relative: string;
  canonicalPath: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

interface PublishPlan {
  staged: StagedReportForPublish;
  stableName: string;
  destination: string;
  reuseExisting: boolean;
  sourceDigest: string;
  publishedIdentity?: { dev: bigint; ino: bigint; size: bigint };
}

async function planStagedReportPublication(
  finalRoot: DirectoryIdentity,
  staged: StagedReportForPublish,
): Promise<PublishPlan> {
  const sourceHash = await hashVerifiedFile(staged.canonicalPath, staged);
  const primaryName = stableCrashReportName(staged.relative);

  const choose = async (stableName: string): Promise<PublishPlan | undefined> => {
    const destination = resolveReportPath(finalRoot.canonicalPath, stableName);
    const exists = await rejectUnsafePublishedReport(destination);
    if (!exists) {
      return {
        staged,
        stableName,
        destination,
        reuseExisting: false,
        sourceDigest: sourceHash.digest,
      };
    }
    const existingPath = await validatePulledReportPath(finalRoot, stableName);
    const existingHash = await hashVerifiedFile(existingPath);
    if (existingHash.digest === sourceHash.digest && existingHash.size === sourceHash.size) {
      return {
        staged,
        stableName,
        destination: existingPath,
        reuseExisting: true,
        sourceDigest: sourceHash.digest,
      };
    }
    return undefined;
  };

  const primary = await choose(primaryName);
  if (primary) return primary;
  const alternateName = `${createHash("sha256")
    .update(staged.relative)
    .update("\0")
    .update(sourceHash.digest)
    .digest("hex")}.ips`;
  const alternate = await choose(alternateName);
  if (alternate) return alternate;
  throw new Error(
    `Stable crash-report destination collision for "${staged.relative}"`,
  );
}

async function publishStagedReport(
  finalRoot: DirectoryIdentity,
  plan: PublishPlan,
): Promise<string> {
  await assertDirectoryIdentity(finalRoot);
  if (plan.reuseExisting) return plan.destination;
  const source = await open(
    plan.staged.canonicalPath,
    fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
  );
  let tempPath: string | undefined;
  let temp: FileHandle | undefined;
  try {
    const sourceBefore = await source.stat({ bigint: true });
    if (
      !sourceBefore.isFile() ||
      sourceBefore.nlink !== 1n ||
      sourceBefore.dev !== plan.staged.dev ||
      sourceBefore.ino !== plan.staged.ino ||
      sourceBefore.size !== plan.staged.size ||
      sourceBefore.mtimeNs !== plan.staged.mtimeNs
    ) {
      throw new Error(`Staged crash report changed before private copy`);
    }
    const flags =
      fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW;
    for (let attempt = 0; attempt < 8 && !temp; attempt += 1) {
      tempPath = path.join(
        finalRoot.canonicalPath,
        `.incoming-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
      );
      try {
        temp = await open(tempPath, flags, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (!temp || !tempPath) throw new Error("Could not allocate crash-report publish temp");

    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0n;
    while (position < plan.staged.size) {
      const remaining = plan.staged.size - position;
      const requested = Number(
        remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length),
      );
      const { bytesRead } = await source.read(
        buffer,
        0,
        requested,
        Number(position),
      );
      if (bytesRead === 0) throw new Error("Staged crash report ended during publication");
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        const result = await temp.write(
          chunk,
          written,
          chunk.length - written,
          Number(position) + written,
        );
        if (result.bytesWritten === 0) {
          throw new Error("Crash-report publish temp stopped accepting bytes");
        }
        written += result.bytesWritten;
      }
      position += BigInt(bytesRead);
    }
    const sourceAfter = await source.stat({ bigint: true });
    if (
      sourceAfter.dev !== sourceBefore.dev ||
      sourceAfter.ino !== sourceBefore.ino ||
      sourceAfter.size !== sourceBefore.size ||
      sourceAfter.mtimeNs !== sourceBefore.mtimeNs ||
      digest.digest("hex") !== plan.sourceDigest
    ) {
      throw new Error(`Staged crash report changed during private publication copy`);
    }
    await temp.chmod(0o600);
    await temp.sync();
    const tempStat = await temp.stat({ bigint: true });
    if (
      !tempStat.isFile() ||
      tempStat.nlink !== 1n ||
      tempStat.size !== plan.staged.size ||
      (tempStat.mode & 0o777n) !== 0o600n
    ) {
      throw new Error("Crash-report publish temp failed verification");
    }
    await temp.close();
    temp = undefined;
    await assertDirectoryIdentity(finalRoot);
    // link(2) with a new destination is atomic and never overwrites an existing
    // stable report. Removing the random name leaves a single-link final inode.
    await link(tempPath, plan.destination);
    plan.publishedIdentity = {
      dev: tempStat.dev,
      ino: tempStat.ino,
      size: tempStat.size,
    };
    await unlink(tempPath);
    tempPath = undefined;
    const verified = await validatePulledReportPath(finalRoot, plan.stableName);
    const published = await stat(verified, { bigint: true });
    if (
      !plan.publishedIdentity ||
      published.dev !== plan.publishedIdentity.dev ||
      published.ino !== plan.publishedIdentity.ino ||
      published.size !== plan.publishedIdentity.size
    ) {
      throw new Error(
        `Crash report changed while it was published: "${plan.staged.relative}"`,
      );
    }
    await assertDirectoryIdentity(finalRoot);
    return verified;
  } finally {
    await source.close().catch(() => undefined);
    if (temp) await temp.close().catch(() => undefined);
    if (tempPath) await unlink(tempPath).catch(() => undefined);
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Validate one CLI-reported path and return its canonical regular-file path. */
export async function validatePulledReportPath(
  outDirIdentity: DirectoryIdentity,
  relativeReportPath: string,
): Promise<string> {
  const lexicalPath = resolveReportPath(
    outDirIdentity.canonicalPath,
    relativeReportPath,
  );
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error("This platform cannot safely validate pulled crash reports");
  }

  let handle: FileHandle;
  try {
    // Open the lexical CLI-announced entry itself. Opening realpath first would
    // silently accept a symlink so long as its target remained inside outDir.
    handle = await open(
      lexicalPath,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    throw new Error(
      `Crash report announced by idevicecrashreport cannot be opened safely: "${relativeReportPath}" (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  try {
    const openedStat = await handle.stat({ bigint: true });
    if (!openedStat.isFile() || openedStat.nlink !== 1n) {
      throw new Error(
        `Crash report is not a single-link regular file: "${relativeReportPath}"`,
      );
    }
    if (
      typeof process.geteuid === "function" &&
      openedStat.uid !== BigInt(process.geteuid())
    ) {
      throw new Error(`Crash report must be owned by the current user: "${relativeReportPath}"`);
    }
    if (openedStat.size > BigInt(MAX_DEVICE_CRASH_REPORT_BYTES)) {
      throw new Error(
        `Crash report exceeds ${MAX_DEVICE_CRASH_REPORT_BYTES} byte limit: "${relativeReportPath}"`,
      );
    }

    const finalCanonicalPath = await realpath(lexicalPath);
    const preSecurePathStat = await stat(finalCanonicalPath, { bigint: true });
    if (
      !isContainedPath(outDirIdentity.canonicalPath, finalCanonicalPath) ||
      !preSecurePathStat.isFile() ||
      preSecurePathStat.dev !== openedStat.dev ||
      preSecurePathStat.ino !== openedStat.ino
    ) {
      throw new Error(
        `Crash report resolves outside outDir or changed during validation: "${relativeReportPath}" -> "${finalCanonicalPath}"`,
      );
    }
    await handle.chmod(0o600);
    const securedStat = await handle.stat({ bigint: true });
    if (
      securedStat.dev !== openedStat.dev ||
      securedStat.ino !== openedStat.ino ||
      (securedStat.mode & 0o777n) !== 0o600n
    ) {
      throw new Error(`Crash report permissions could not be secured: "${relativeReportPath}"`);
    }

    const finalStat = await stat(finalCanonicalPath, { bigint: true });
    if (
      !finalStat.isFile() ||
      finalStat.dev !== securedStat.dev ||
      finalStat.ino !== securedStat.ino
    ) {
      throw new Error(
        `Crash report changed while it was being validated: "${relativeReportPath}"`,
      );
    }
    if (!isContainedPath(outDirIdentity.canonicalPath, finalCanonicalPath)) {
      throw new Error(
        `Crash report resolves outside outDir: "${relativeReportPath}" -> "${finalCanonicalPath}"`,
      );
    }
    return finalCanonicalPath;
  } finally {
    await handle.close();
  }
}

/**
 * Normalize and validate the process filter used by idevicecrashreport.
 *
 * Read-only pulls may omit the filter, but an explicitly supplied value must
 * contain more than whitespace. Device-side removal is intentionally disabled:
 * idevicecrashreport's -f is substring matching and cannot be a safe deletion
 * boundary.
 */
export function validateCrashReportFilter(
  filter: string | undefined,
  options: { removingFromDevice?: boolean } = {},
): string | undefined {
  if (options.removingFromDevice === true) {
    throw new Error(
      "remove_from_device=true is not supported: ios_pull_device_crashes is read-only and always keeps crash reports on the device.",
    );
  }
  const normalized = filter?.trim();
  if (normalized === undefined || normalized.length === 0) {
    if (filter !== undefined) {
      throw new Error(
        "filter must contain a non-empty, non-whitespace filename substring; omit it for an unfiltered read-only pull.",
      );
    }
    return undefined;
  }
  return normalized;
}

/**
 * Pull crash reports off the device into an absolute outDir. Reports are always
 * kept on the device: idevicecrashreport's process filter is substring-based,
 * so it is not a safe boundary for deletion. `sinceMinutes` filters only the
 * returned list because the CLI has no server-side time predicate. The cutoff
 * is frozen before device lookup/transfer.
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
  if (opts.keepOnDevice === false) {
    throw new Error(
      "keepOnDevice=false is not supported: pullDeviceCrashes is read-only and always keeps crash reports on the device.",
    );
  }
  if (!path.isAbsolute(opts.outDir)) {
    throw new Error(`outDir must be an absolute path: "${opts.outDir}"`);
  }
  if (
    opts.sinceMinutes !== undefined &&
    (!Number.isInteger(opts.sinceMinutes) || opts.sinceMinutes <= 0)
  ) {
    throw new RangeError("sinceMinutes must be a positive integer");
  }
  const filter = validateCrashReportFilter(opts.filter);

  const outDir = path.resolve(opts.outDir);
  const udid = await pickDevice(opts.udid);
  const reportedTimeZone =
    opts.sinceMinutes !== undefined ? await infoKey(udid, "TimeZone") : undefined;
  const deviceTimeZone =
    reportedTimeZone && formatterForTimeZone(reportedTimeZone)
      ? reportedTimeZone
      : undefined;

  // The external helper writes only into a per-invocation private staging
  // directory. Nothing becomes caller-visible until the helper has exited,
  // staging quotas have passed, and every announced report has been verified.
  const outDirIdentity = await readDirectoryIdentity(outDir);
  let stagingPath: string | undefined;
  let stagingIdentity: DirectoryIdentity | undefined;
  try {
    await assertDirectoryIdentity(outDirIdentity);
    stagingPath = await mkdtemp(
      path.join(outDirIdentity.canonicalPath, ".ios-crash-pull-"),
    );
    stagingIdentity = await readDirectoryIdentity(stagingPath);
    if (path.dirname(stagingIdentity.canonicalPath) !== outDirIdentity.canonicalPath) {
      throw new Error("Crash-report staging directory escaped the requested outDir");
    }

    const args = ["-u", udid, "-k"];
    if (opts.extract !== false) args.push("-e");
    if (filter !== undefined) args.push("-f", filter);
    args.push(stagingIdentity.canonicalPath);
    const bin = ideviceCrashReportBin();
    const abortController = new AbortController();
    let markCommandDone!: () => void;
    const commandDone = new Promise<void>((resolve) => {
      markCommandDone = resolve;
    });
    let monitorError: unknown;
    const monitor = monitorCrashStaging(
      stagingIdentity.canonicalPath,
      commandDone,
      abortController,
    ).catch((error: unknown) => {
      monitorError = error;
    });
    let output: string | undefined;
    let commandError: unknown;
    try {
      output = await run(bin, args, {
        timeoutMs: 120_000,
        maxBufferBytes: 4 * 1024 * 1024,
        signal: abortController.signal,
      });
    } catch (error) {
      commandError = error;
    } finally {
      markCommandDone();
      await monitor;
    }
    if (monitorError) throw monitorError;
    if (commandError) throw commandError;
    if (output === undefined) throw new Error("idevicecrashreport returned no output");

    await assertDirectoryIdentity(stagingIdentity);
    await assertDirectoryIdentity(outDirIdentity);
    const allCopied = parseCopiedReports(output);
    // Validate the complete announced set before time filtering or publishing.
    // An old/malformed entry cannot hide behind sinceMinutes.
    const validatedStaged: Array<{
      relative: string;
      canonicalPath: string;
      dev: bigint;
      ino: bigint;
      size: bigint;
      mtimeNs: bigint;
    }> = [];
    let validatedBytes = 0n;
    for (const relative of allCopied) {
      const canonicalPath = await validatePulledReportPath(stagingIdentity, relative);
      const identity = await stat(canonicalPath, { bigint: true });
      validatedBytes += identity.size;
      if (validatedBytes > BigInt(MAX_DEVICE_CRASH_STAGING_BYTES)) {
        throw new Error(
          `Validated crash reports exceed ${MAX_DEVICE_CRASH_STAGING_BYTES} bytes`,
        );
      }
      validatedStaged.push({
        relative,
        canonicalPath,
        dev: identity.dev,
        ino: identity.ino,
        size: identity.size,
        mtimeNs: identity.mtimeNs,
      });
    }

    const keptRelative =
      opts.sinceMinutes !== undefined
        ? filterReportsSince(allCopied, opts.sinceMinutes, sinceReferenceTime, {
            ...(deviceTimeZone
              ? { timeZone: deviceTimeZone }
              : { conservativeUnknownTimeZone: true }),
          })
        : allCopied;
    const keptSet = new Set(keptRelative);
    const selectedStaged = validatedStaged.filter((entry) => keptSet.has(entry.relative));
    const plans: PublishPlan[] = [];
    const plannedNames = new Set<string>();
    for (const staged of selectedStaged) {
      const plan = await planStagedReportPublication(outDirIdentity, staged);
      if (plannedNames.has(plan.stableName)) {
        throw new Error(`Duplicate crash-report publication target: "${plan.stableName}"`);
      }
      plannedNames.add(plan.stableName);
      plans.push(plan);
    }

    const published: Array<{ relative: string; canonicalPath: string }> = [];
    const newlyPublished: PublishPlan[] = [];
    let publishedBytes = 0n;
    try {
      for (const plan of plans) {
        publishedBytes += plan.staged.size;
        if (publishedBytes > BigInt(MAX_DEVICE_CRASH_STAGING_BYTES)) {
          throw new Error(
            `Published crash reports exceed ${MAX_DEVICE_CRASH_STAGING_BYTES} bytes`,
          );
        }
        if (!plan.reuseExisting) newlyPublished.push(plan);
        const canonicalPath = await publishStagedReport(outDirIdentity, plan);
        published.push({ relative: plan.staged.relative, canonicalPath });
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const plan of newlyPublished.reverse()) {
        try {
          const current = await open(
            plan.destination,
            fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
          );
          try {
            const identity = await current.stat({ bigint: true });
            if (
              !plan.publishedIdentity ||
              identity.dev !== plan.publishedIdentity.dev ||
              identity.ino !== plan.publishedIdentity.ino ||
              identity.size !== plan.publishedIdentity.size
            ) {
              throw new Error(`Refusing to roll back a changed crash-report destination`);
            }
          } finally {
            await current.close();
          }
          await unlink(plan.destination);
        } catch (rollbackError) {
          if ((rollbackError as NodeJS.ErrnoException).code !== "ENOENT") {
            rollbackErrors.push(rollbackError);
          }
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Crash-report publication failed and rollback was incomplete",
        );
      }
      throw error;
    }
    const files = Array.from(
      new Set(
        published
          .filter((entry) => keptSet.has(entry.relative))
          .map((entry) => entry.canonicalPath),
      ),
    );
    await assertDirectoryIdentity(outDirIdentity);
    return {
      udid,
      out_dir: outDirIdentity.canonicalPath,
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
  } finally {
    if (stagingIdentity) {
      await stagingIdentity.close().catch(() => undefined);
    }
    if (stagingPath && stagingIdentity) {
      // Delete only the exact staging inode created by this invocation. If the
      // path was swapped, leave it untouched and surface no unsafe recursive rm.
      try {
        const current = await lstat(stagingPath, { bigint: true });
        if (
          current.isDirectory() &&
          current.dev === stagingIdentity.dev &&
          current.ino === stagingIdentity.ino
        ) {
          await rm(stagingPath, { recursive: true, force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await outDirIdentity.close();
  }
}

export interface IosInstalledApp {
  bundle_id: string;
  version?: string;
  name?: string;
}

export const MAX_IOS_INSTALLED_APPS = 512;
const MAX_IOS_APP_BUNDLE_BYTES = 256;
const MAX_IOS_APP_VERSION_BYTES = 64;
const MAX_IOS_APP_NAME_BYTES = 256;

export interface IosInstalledAppsResult {
  apps: IosInstalledApp[];
  total_detected: number;
  results_truncated: boolean;
  fields_truncated: boolean;
}

function boundedUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return { value, truncated: false };
  let end = maxBytes;
  while (end > 0 && (encoded[end] ?? 0) >> 6 === 0b10) end -= 1;
  return { value: encoded.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * List installed apps via `ideviceinstaller list`. type selects user/system/all.
 * Parses the CSV-ish default output: `bundleId, "version", "DisplayName"`.
 */
export async function listAppsWithMeta(opts: {
  udid?: string;
  type?: "user" | "system" | "all";
}): Promise<IosInstalledAppsResult> {
  const udid = await pickDevice(opts.udid);
  const typeFlag =
    opts.type === "system" ? "--system" : opts.type === "all" ? "--all" : "--user";
  const out = await run(ideviceInstallerBin(), ["-u", udid, "list", typeFlag], {
    timeoutMs: 60_000,
    maxBufferBytes: 4 * 1024 * 1024,
  });
  const apps: IosInstalledApp[] = [];
  let totalDetected = 0;
  let fieldsTruncated = false;
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip the header row emitted by newer ideviceinstaller.
    if (trimmed.startsWith("CFBundleIdentifier")) continue;
    totalDetected += 1;
    if (apps.length >= MAX_IOS_INSTALLED_APPS) continue;
    const m = trimmed.match(/^([^,]+),\s*"([^"]*)",\s*"([^"]*)"/);
    if (m) {
      const bundle = boundedUtf8(m[1]!.trim(), MAX_IOS_APP_BUNDLE_BYTES);
      const version = boundedUtf8(m[2]!, MAX_IOS_APP_VERSION_BYTES);
      const name = boundedUtf8(m[3]!, MAX_IOS_APP_NAME_BYTES);
      fieldsTruncated ||= bundle.truncated || version.truncated || name.truncated;
      apps.push({ bundle_id: bundle.value, version: version.value, name: name.value });
    } else {
      // Fallback: first comma-separated token as bundle id.
      const bid = trimmed.split(",")[0]?.trim();
      if (bid) {
        const bundle = boundedUtf8(bid, MAX_IOS_APP_BUNDLE_BYTES);
        fieldsTruncated ||= bundle.truncated;
        apps.push({ bundle_id: bundle.value });
      }
    }
  }
  return {
    apps,
    total_detected: totalDetected,
    results_truncated: totalDetected > apps.length,
    fields_truncated: fieldsTruncated,
  };
}

export async function listApps(opts: {
  udid?: string;
  type?: "user" | "system" | "all";
}): Promise<IosInstalledApp[]> {
  return (await listAppsWithMeta(opts)).apps;
}
