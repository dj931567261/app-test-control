// Discover and safely copy Apple .ips crash files from
// ~/Library/Logs/DiagnosticReports/. Both macOS host and iOS Simulator crashes
// land in this directory.

import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openSecureDirectory } from "./secure-directory.js";

export const DIAGNOSTIC_REPORTS = path.join(
  os.homedir(),
  "Library",
  "Logs",
  "DiagnosticReports",
);

/** A first-line Apple IPS header is normally only a few KiB. */
export const MAX_IPS_HEADER_BYTES = 64 * 1024;
/** Refuse unexpectedly huge individual reports before copying or parsing. */
export const MAX_IPS_FILE_BYTES = 256 * 1024 * 1024;
/** Bound one tool call even when many reports match. */
export const MAX_IPS_TOTAL_COPY_BYTES = 512 * 1024 * 1024;
export const MAX_IPS_DIRECTORY_ENTRIES = 10_000;
export const MAX_IPS_CANDIDATES = 2_000;
export const MAX_IPS_RESULTS = 64;
export const MAX_IPS_COPY_FILES = 100;
export const MAX_IPS_FILTER_LENGTH = 512;
export const MAX_IPS_PATH_LENGTH = 4_096;
const MAX_IPS_HEADER_VALUE_LENGTH = 1_024;

export interface IpsFileSummary {
  path: string;
  filename: string;
  proc_name: string;
  bundle_id?: string;
  timestamp: string; // string as stored in header
  bug_type?: string;
  os_version?: string;
  size: number;
  mtime_ms: number;
}

export interface ListIpsOpts {
  /** Only include .ips whose mtime is newer than this many minutes ago. */
  since_minutes?: number;
  /** Substring match on `bundleID` (case-insensitive). */
  bundle_id?: string;
  /** Substring match on `name` / `procName` / `app_name`. */
  proc_name?: string;
  /** Optional absolute override directory (testing). */
  reports_dir?: string;
}

interface FileIdentity {
  canonicalPath: string;
  rootCanonicalPath: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

interface DirectoryIdentity {
  requestedPath: string;
  canonicalPath: string;
  dev: bigint;
  ino: bigint;
  handle: FileHandle;
  assertSecureUnchanged?: () => Promise<void>;
}

// `ios_pull_ips` passes the exact objects returned by listIpsFiles. Keeping the
// verified identity out-of-band prevents callers from forging dev/inode fields
// in JSON while allowing copyIpsFiles to detect source replacement.
const listedIdentities = new WeakMap<IpsFileSummary, FileIdentity>();

function sameInode(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
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

function validateAbsolutePath(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.length > MAX_IPS_PATH_LENGTH ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    throw new Error(
      `${label} must be a non-empty absolute path no longer than ${MAX_IPS_PATH_LENGTH} characters`,
    );
  }
  return path.resolve(value);
}

function normalizeFilter(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > MAX_IPS_FILTER_LENGTH) {
    throw new RangeError(
      `${label} must contain 1-${MAX_IPS_FILTER_LENGTH} non-whitespace characters`,
    );
  }
  return normalized;
}

function safeHeaderString(
  header: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = header[key];
    if (
      typeof value === "string" &&
      value.length <= MAX_IPS_HEADER_VALUE_LENGTH
    ) {
      return value;
    }
  }
  return undefined;
}

function requiredOpenFlags(): { readFile: number; readDirectory: number } {
  if (
    typeof fsConstants.O_NOFOLLOW !== "number" ||
    typeof fsConstants.O_NONBLOCK !== "number" ||
    typeof fsConstants.O_DIRECTORY !== "number"
  ) {
    throw new Error("This platform cannot safely inspect IPS files");
  }
  return {
    readFile:
      fsConstants.O_RDONLY |
      fsConstants.O_NONBLOCK |
      fsConstants.O_NOFOLLOW,
    readDirectory:
      fsConstants.O_RDONLY |
      fsConstants.O_DIRECTORY |
      fsConstants.O_NOFOLLOW,
  };
}

async function openDirectoryIdentity(
  directory: string,
  options: { create?: boolean; securePermissions?: boolean } = {},
): Promise<DirectoryIdentity> {
  const requestedPath = validateAbsolutePath(directory, "directory");
  if (options.create && options.securePermissions) {
    const secured = await openSecureDirectory(requestedPath);
    return {
      requestedPath: secured.requestedPath,
      canonicalPath: secured.canonicalPath,
      dev: secured.dev,
      ino: secured.ino,
      handle: secured.handle,
      assertSecureUnchanged: secured.assertUnchanged,
    };
  }
  if (options.create) {
    await mkdir(requestedPath, { recursive: true, mode: 0o700 });
  }
  const { readDirectory } = requiredOpenFlags();
  const handle = await open(requestedPath, readDirectory);
  try {
    const openedStat = await handle.stat({ bigint: true });
    if (!openedStat.isDirectory()) {
      throw new Error(`Path is not a directory: "${requestedPath}"`);
    }
    if (
      options.securePermissions &&
      typeof process.geteuid === "function" &&
      openedStat.uid !== BigInt(process.geteuid())
    ) {
      throw new Error(`Directory must be owned by the current user: "${requestedPath}"`);
    }
    let securedStat = openedStat;
    if (options.securePermissions) {
      await handle.chmod(0o700);
      securedStat = await handle.stat({ bigint: true });
      if (
        !sameInode(openedStat, securedStat) ||
        (securedStat.mode & 0o777n) !== 0o700n
      ) {
        throw new Error(`Directory permissions could not be secured: "${requestedPath}"`);
      }
    }

    const canonicalPath = await realpath(requestedPath);
    const canonicalStat = await stat(canonicalPath, { bigint: true });
    if (!canonicalStat.isDirectory() || !sameInode(securedStat, canonicalStat)) {
      throw new Error(`Directory changed while it was being opened: "${requestedPath}"`);
    }
    return {
      requestedPath,
      canonicalPath,
      dev: securedStat.dev,
      ino: securedStat.ino,
      handle,
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertDirectoryUnchanged(identity: DirectoryIdentity): Promise<void> {
  await identity.assertSecureUnchanged?.();
  const current = await stat(identity.canonicalPath, { bigint: true });
  if (!current.isDirectory() || !sameInode(identity, current)) {
    throw new Error(`Directory changed during IPS operation: "${identity.requestedPath}"`);
  }
}

async function readBoundedHeader(
  handle: FileHandle,
  fileSize: bigint,
): Promise<Record<string, unknown> | null> {
  const requested = Math.min(
    Number(fileSize),
    MAX_IPS_HEADER_BYTES + 1,
  );
  if (requested === 0) return null;
  const buffer = Buffer.allocUnsafe(requested);
  const { bytesRead } = await handle.read(buffer, 0, requested, 0);
  if (bytesRead === 0) return null;

  const available = buffer.subarray(0, bytesRead);
  const newline = available.indexOf(0x0a);
  const headerEnd = newline === -1 ? bytesRead : newline;
  if (headerEnd > MAX_IPS_HEADER_BYTES) return null;
  if (newline === -1 && fileSize > BigInt(MAX_IPS_HEADER_BYTES)) return null;
  const withoutCarriageReturn =
    headerEnd > 0 && available[headerEnd - 1] === 0x0d
      ? available.subarray(0, headerEnd - 1)
      : available.subarray(0, headerEnd);
  if (withoutCarriageReturn.length === 0) return null;

  try {
    const parsed: unknown = JSON.parse(withoutCarriageReturn.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function inspectIpsFile(
  root: DirectoryIdentity,
  filename: string,
  sinceMs: number,
  bundleFilter: string | undefined,
  procFilter: string | undefined,
): Promise<IpsFileSummary | null> {
  const lexicalPath = path.join(root.canonicalPath, filename);
  const { readFile } = requiredOpenFlags();
  let handle: FileHandle;
  try {
    handle = await open(lexicalPath, readFile);
  } catch {
    // A raced-away file, symlink, FIFO, or unreadable entry is not a valid
    // report. Ignore it without ever falling back to a following/blocking open.
    return null;
  }

  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(MAX_IPS_FILE_BYTES) ||
      before.size > BigInt(Number.MAX_SAFE_INTEGER) ||
      (sinceMs > 0 && Number(before.mtimeMs) < sinceMs)
    ) {
      return null;
    }

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(lexicalPath);
    } catch {
      return null;
    }
    if (!isContainedPath(root.canonicalPath, canonicalPath)) return null;
    const pathStat = await stat(canonicalPath, { bigint: true });
    if (!pathStat.isFile() || !sameInode(before, pathStat)) return null;

    const header = await readBoundedHeader(handle, before.size);
    if (!header) return null;
    const after = await handle.stat({ bigint: true });
    if (
      !sameInode(before, after) ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      return null;
    }

    const procName =
      safeHeaderString(header, "name", "procName", "app_name") ?? "unknown";
    const bundleId = safeHeaderString(header, "bundleID", "app_identifier");
    if (bundleFilter && !bundleId?.toLowerCase().includes(bundleFilter)) return null;
    if (procFilter && !procName.toLowerCase().includes(procFilter)) return null;

    const summary: IpsFileSummary = {
      path: canonicalPath,
      filename,
      proc_name: procName,
      ...(bundleId !== undefined ? { bundle_id: bundleId } : {}),
      timestamp: safeHeaderString(header, "timestamp") ?? "",
      ...(safeHeaderString(header, "bug_type") !== undefined
        ? { bug_type: safeHeaderString(header, "bug_type")! }
        : {}),
      ...(safeHeaderString(header, "os_version") !== undefined
        ? { os_version: safeHeaderString(header, "os_version")! }
        : {}),
      size: Number(after.size),
      mtime_ms: Number(after.mtimeMs),
    };
    listedIdentities.set(summary, {
      canonicalPath,
      rootCanonicalPath: root.canonicalPath,
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeNs: after.mtimeNs,
    });
    return summary;
  } finally {
    await handle.close();
  }
}

export interface ListIpsResult {
  files: IpsFileSummary[];
  total_detected: number;
  results_truncated: boolean;
}

export async function listIpsFilesWithMeta(
  opts: ListIpsOpts = {},
): Promise<ListIpsResult> {
  if (
    opts.since_minutes !== undefined &&
    (!Number.isSafeInteger(opts.since_minutes) || opts.since_minutes <= 0)
  ) {
    throw new RangeError("since_minutes must be a positive safe integer");
  }
  const bundleFilter = normalizeFilter(opts.bundle_id, "bundle_id");
  const procFilter = normalizeFilter(opts.proc_name, "proc_name");
  const requestedDir = opts.reports_dir ?? DIAGNOSTIC_REPORTS;
  let root: DirectoryIdentity;
  try {
    root = await openDirectoryIdentity(requestedDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { files: [], total_detected: 0, results_truncated: false };
    }
    throw error;
  }

  try {
    const sinceMs = opts.since_minutes
      ? Date.now() - opts.since_minutes * 60_000
      : 0;
    const results: IpsFileSummary[] = [];
    let entryCount = 0;
    let candidateCount = 0;
    const directory = await opendir(root.canonicalPath);
    for await (const entry of directory) {
      entryCount += 1;
      if (entryCount > MAX_IPS_DIRECTORY_ENTRIES) {
        throw new Error(
          `DiagnosticReports contains more than ${MAX_IPS_DIRECTORY_ENTRIES} entries`,
        );
      }
      if (!entry.name.endsWith(".ips") || !entry.isFile()) continue;
      candidateCount += 1;
      if (candidateCount > MAX_IPS_CANDIDATES) {
        throw new Error(
          `DiagnosticReports contains more than ${MAX_IPS_CANDIDATES} IPS candidates`,
        );
      }
      const summary = await inspectIpsFile(
        root,
        entry.name,
        sinceMs,
        bundleFilter,
        procFilter,
      );
      if (summary) results.push(summary);
    }
    await assertDirectoryUnchanged(root);
    results.sort((left, right) => right.mtime_ms - left.mtime_ms);
    return {
      files: results.slice(0, MAX_IPS_RESULTS),
      total_detected: results.length,
      results_truncated: results.length > MAX_IPS_RESULTS,
    };
  } finally {
    await root.handle.close();
  }
}

export async function listIpsFiles(opts: ListIpsOpts = {}): Promise<IpsFileSummary[]> {
  return (await listIpsFilesWithMeta(opts)).files;
}

function validateIpsFilename(filename: string): void {
  if (
    filename.length === 0 ||
    Buffer.byteLength(filename, "utf8") > 255 ||
    filename.includes("\0") ||
    filename !== path.basename(filename) ||
    !filename.endsWith(".ips")
  ) {
    throw new Error(`Unsafe IPS filename: "${filename}"`);
  }
}

async function validateListedSource(
  summary: IpsFileSummary,
  identity: FileIdentity,
): Promise<FileHandle> {
  if (
    summary.path !== identity.canonicalPath ||
    summary.filename !== path.basename(identity.canonicalPath) ||
    !isContainedPath(identity.rootCanonicalPath, identity.canonicalPath)
  ) {
    throw new Error(`IPS source metadata changed before copy: "${summary.filename}"`);
  }
  const { readFile } = requiredOpenFlags();
  const handle = await open(identity.canonicalPath, readFile);
  try {
    const current = await handle.stat({ bigint: true });
    if (
      !current.isFile() ||
      current.nlink !== 1n ||
      !sameInode(identity, current) ||
      current.size !== identity.size ||
      current.mtimeNs !== identity.mtimeNs
    ) {
      throw new Error(`IPS source changed before copy: "${summary.filename}"`);
    }
    const canonicalPath = await realpath(identity.canonicalPath);
    const pathStat = await stat(canonicalPath, { bigint: true });
    if (
      canonicalPath !== identity.canonicalPath ||
      !pathStat.isFile() ||
      !sameInode(identity, pathStat) ||
      !isContainedPath(identity.rootCanonicalPath, canonicalPath)
    ) {
      throw new Error(`IPS source path changed before copy: "${summary.filename}"`);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function createPrivateTemp(
  root: DirectoryIdentity,
  filename: string,
): Promise<{ path: string; handle: FileHandle }> {
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    fsConstants.O_NOFOLLOW;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const tempPath = path.join(
      root.canonicalPath,
      `.${filename}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
    );
    try {
      return { path: tempPath, handle: await open(tempPath, flags, 0o600) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Could not allocate a private temporary file for "${filename}"`);
}

async function copyExactBytes(
  source: FileHandle,
  destination: FileHandle,
  size: bigint,
): Promise<void> {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0n;
  while (position < size) {
    const remaining = size - position;
    const requested = Number(
      remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length),
    );
    const { bytesRead } = await source.read(
      buffer,
      0,
      requested,
      Number(position),
    );
    if (bytesRead === 0) throw new Error("IPS source ended during copy");
    let written = 0;
    while (written < bytesRead) {
      const result = await destination.write(
        buffer,
        written,
        bytesRead - written,
        Number(position) + written,
      );
      if (result.bytesWritten === 0) throw new Error("IPS destination stopped accepting data");
      written += result.bytesWritten;
    }
    position += BigInt(bytesRead);
  }
}

async function rejectUnsafeExistingDestination(
  destination: string,
  sourceIdentities: FileIdentity[],
): Promise<void> {
  let existing;
  try {
    existing = await lstat(destination, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1n) {
    throw new Error(`Refusing unsafe existing IPS destination: "${destination}"`);
  }
  if (
    typeof process.geteuid === "function" &&
    existing.uid !== BigInt(process.geteuid())
  ) {
    throw new Error(`IPS destination must be owned by the current user: "${destination}"`);
  }
  if (sourceIdentities.some((source) => sameInode(source, existing))) {
    throw new Error(`IPS destination aliases a source file: "${destination}"`);
  }
}

async function verifyCopiedDestination(
  root: DirectoryIdentity,
  destination: string,
  expected: { dev: bigint; ino: bigint; size: bigint },
): Promise<string> {
  const { readFile } = requiredOpenFlags();
  const handle = await open(destination, readFile);
  try {
    const current = await handle.stat({ bigint: true });
    if (
      !current.isFile() ||
      current.nlink !== 1n ||
      !sameInode(expected, current) ||
      current.size !== expected.size ||
      (current.mode & 0o777n) !== 0o600n
    ) {
      throw new Error(`Copied IPS destination failed verification: "${destination}"`);
    }
    const canonicalPath = await realpath(destination);
    const pathStat = await stat(canonicalPath, { bigint: true });
    if (
      !isContainedPath(root.canonicalPath, canonicalPath) ||
      !pathStat.isFile() ||
      !sameInode(current, pathStat)
    ) {
      throw new Error(`Copied IPS destination escaped output directory: "${destination}"`);
    }
    return canonicalPath;
  } finally {
    await handle.close();
  }
}

export async function copyIpsFiles(
  files: IpsFileSummary[],
  outDir: string,
): Promise<Array<{ from: string; to: string }>> {
  if (files.length > MAX_IPS_COPY_FILES) {
    throw new RangeError(`At most ${MAX_IPS_COPY_FILES} IPS files may be copied per call`);
  }
  const filenames = new Set<string>();
  const identities: FileIdentity[] = [];
  let totalBytes = 0n;
  for (const summary of files) {
    validateIpsFilename(summary.filename);
    if (filenames.has(summary.filename)) {
      throw new Error(`Duplicate IPS destination filename: "${summary.filename}"`);
    }
    filenames.add(summary.filename);
    const identity = listedIdentities.get(summary);
    if (!identity) {
      throw new Error(
        `IPS source was not produced by the current listIpsFiles call: "${summary.filename}"`,
      );
    }
    totalBytes += identity.size;
    if (totalBytes > BigInt(MAX_IPS_TOTAL_COPY_BYTES)) {
      throw new RangeError(
        `IPS copy exceeds total byte limit ${MAX_IPS_TOTAL_COPY_BYTES}`,
      );
    }
    identities.push(identity);
  }

  const outputRoot = await openDirectoryIdentity(outDir, {
    create: true,
    securePermissions: true,
  });
  const result: Array<{ from: string; to: string }> = [];
  try {
    for (let index = 0; index < files.length; index += 1) {
      const summary = files[index]!;
      const identity = identities[index]!;
      const destination = path.join(outputRoot.canonicalPath, summary.filename);
      if (!isContainedPath(outputRoot.canonicalPath, destination)) {
        throw new Error(`IPS destination escapes output directory: "${summary.filename}"`);
      }
      await rejectUnsafeExistingDestination(destination, identities);
      const source = await validateListedSource(summary, identity);
      let tempPath: string | undefined;
      try {
        const temp = await createPrivateTemp(outputRoot, summary.filename);
        tempPath = temp.path;
        let tempStat: { dev: bigint; ino: bigint; size: bigint };
        try {
          await copyExactBytes(source, temp.handle, identity.size);
          await temp.handle.chmod(0o600);
          await temp.handle.sync();
          const current = await temp.handle.stat({ bigint: true });
          if (
            !current.isFile() ||
            current.nlink !== 1n ||
            current.size !== identity.size
          ) {
            throw new Error(`Temporary IPS copy failed verification: "${summary.filename}"`);
          }
          tempStat = { dev: current.dev, ino: current.ino, size: current.size };
        } finally {
          await temp.handle.close();
        }

        const sourceAfter = await source.stat({ bigint: true });
        if (
          !sameInode(identity, sourceAfter) ||
          sourceAfter.size !== identity.size ||
          sourceAfter.mtimeNs !== identity.mtimeNs
        ) {
          throw new Error(`IPS source changed during copy: "${summary.filename}"`);
        }
        await assertDirectoryUnchanged(outputRoot);
        await rename(tempPath, destination);
        tempPath = undefined;
        const canonicalDestination = await verifyCopiedDestination(
          outputRoot,
          destination,
          tempStat,
        );
        result.push({ from: identity.canonicalPath, to: canonicalDestination });
      } finally {
        await source.close().catch(() => undefined);
        if (tempPath) await unlink(tempPath).catch(() => undefined);
      }
    }
    await assertDirectoryUnchanged(outputRoot);
    return result;
  } finally {
    await outputRoot.handle.close();
  }
}
