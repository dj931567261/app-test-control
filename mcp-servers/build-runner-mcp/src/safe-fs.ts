import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import {
  access,
  lstat,
  open,
  readdir,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function stableFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function stableSourceFlags(): number {
  if (fsConstants.O_NOFOLLOW === undefined || fsConstants.O_NONBLOCK === undefined) {
    throw new Error("stable file I/O requires O_NOFOLLOW and O_NONBLOCK");
  }
  return fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
}

function exclusiveDestinationFlags(): number {
  if (fsConstants.O_NOFOLLOW === undefined || fsConstants.O_NONBLOCK === undefined) {
    throw new Error("stable file I/O requires O_NOFOLLOW and O_NONBLOCK");
  }
  return fsConstants.O_WRONLY
    | fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | fsConstants.O_NOFOLLOW
    | fsConstants.O_NONBLOCK;
}

function assertStableRegularFile(
  value: Stats,
  label: string,
  options: { maxBytes: number; allowEmpty: boolean; allowRootOwner: boolean },
): void {
  const uid = currentUid();
  if (
    !value.isFile()
    || value.isSymbolicLink()
    || value.nlink !== 1
    || value.size > options.maxBytes
    || (!options.allowEmpty && value.size < 1)
    || (value.uid !== uid && !(options.allowRootOwner && value.uid === 0))
    || (value.mode & 0o022) !== 0
  ) {
    throw new Error(`${label} must be a bounded, single-link trusted regular file`);
  }
}

export interface StableFileResult {
  path: string;
  size: number;
  sha256: string;
  content?: Buffer;
}

/**
 * Read one path through a pinned O_NOFOLLOW descriptor. The exact declared size
 * is consumed, one extra byte proves EOF, and the path/descriptor identity is
 * rechecked before returning. `capture` is only for already-bounded metadata.
 */
export async function readStableRegularFile(
  input: string,
  label: string,
  options: {
    maxBytes: number;
    allowEmpty?: boolean;
    allowRootOwner?: boolean;
    expectedSize?: number;
    expectedSha256?: string;
    capture?: boolean;
  },
): Promise<StableFileResult> {
  const before = await lstat(input);
  assertStableRegularFile(before, label, {
    maxBytes: options.maxBytes,
    allowEmpty: options.allowEmpty ?? false,
    allowRootOwner: options.allowRootOwner ?? false,
  });
  if (options.expectedSize !== undefined && before.size !== options.expectedSize) {
    throw new Error(`${label} size differs from its approved manifest`);
  }
  const handle = await open(input, stableSourceFlags());
  try {
    const opened = await handle.stat();
    if (!stableFileIdentity(before, opened)) throw new Error(`${label} changed before reading`);
    const digest = createHash("sha256");
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, before.size)));
    let position = 0;
    while (position < before.size) {
      const wanted = Math.min(buffer.length, before.size - position);
      const { bytesRead } = await handle.read(buffer, 0, wanted, position);
      if (bytesRead <= 0) throw new Error(`${label} ended before its declared size`);
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      if (options.capture) chunks.push(Buffer.from(chunk));
      position += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, before.size)).bytesRead !== 0) {
      throw new Error(`${label} grew while being read`);
    }
    const sha256 = digest.digest("hex");
    if (options.expectedSha256 !== undefined && sha256 !== options.expectedSha256) {
      throw new Error(`${label} content differs from its approved manifest`);
    }
    const afterHandle = await handle.stat();
    const afterPath = await lstat(input);
    if (!stableFileIdentity(before, afterHandle) || !stableFileIdentity(before, afterPath)) {
      throw new Error(`${label} changed while reading`);
    }
    return {
      path: input,
      size: before.size,
      sha256,
      ...(options.capture ? { content: Buffer.concat(chunks) } : {}),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Copy one approved source through pinned descriptors without following a link
 * or reading beyond its declared byte count. The destination must not exist.
 */
export async function copyStableRegularFile(options: {
  source: string;
  destination: string;
  label: string;
  maxBytes: number;
  expectedSize: number;
  expectedSha256: string;
  expectedSourceMode?: number;
  destinationMode: number;
  allowEmpty?: boolean;
  allowRootOwner?: boolean;
}): Promise<StableFileResult> {
  const before = await lstat(options.source);
  assertStableRegularFile(before, options.label, {
    maxBytes: options.maxBytes,
    allowEmpty: options.allowEmpty ?? false,
    allowRootOwner: options.allowRootOwner ?? false,
  });
  if (before.size !== options.expectedSize) {
    throw new Error(`${options.label} size differs from its approved manifest`);
  }
  if (
    options.expectedSourceMode !== undefined
    && (before.mode & 0o777) !== options.expectedSourceMode
  ) {
    throw new Error(`${options.label} mode differs from its approved source mode`);
  }
  const source = await open(options.source, stableSourceFlags());
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  let destinationIdentity: Stats | undefined;
  let primaryError: unknown;
  try {
    const opened = await source.stat();
    if (!stableFileIdentity(before, opened)) {
      throw new Error(`${options.label} changed before copying`);
    }
    destination = await open(options.destination, exclusiveDestinationFlags(), 0o600);
    destinationIdentity = await destination.stat();
    assertStableRegularFile(destinationIdentity, `${options.label} destination`, {
      maxBytes: options.maxBytes,
      allowEmpty: true,
      allowRootOwner: false,
    });
    if (destinationIdentity.size !== 0) {
      throw new Error(`${options.label} destination was not created empty`);
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, before.size)));
    let position = 0;
    while (position < before.size) {
      const wanted = Math.min(buffer.length, before.size - position);
      const { bytesRead } = await source.read(buffer, 0, wanted, position);
      if (bytesRead <= 0) throw new Error(`${options.label} ended before its declared size`);
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await destination.write(
          chunk,
          offset,
          bytesRead - offset,
          position + offset,
        );
        if (bytesWritten <= 0) throw new Error(`${options.label} destination stopped accepting bytes`);
        offset += bytesWritten;
      }
      position += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await source.read(extra, 0, 1, before.size)).bytesRead !== 0) {
      throw new Error(`${options.label} grew while being copied`);
    }
    const sha256 = digest.digest("hex");
    if (sha256 !== options.expectedSha256) {
      throw new Error(`${options.label} content differs from its approved manifest`);
    }
    await destination.chmod(options.destinationMode);
    const sourceAfterHandle = await source.stat();
    const sourceAfterPath = await lstat(options.source);
    if (
      !stableFileIdentity(before, sourceAfterHandle)
      || !stableFileIdentity(before, sourceAfterPath)
    ) {
      throw new Error(`${options.label} changed while copying`);
    }
    const destinationAfterHandle = await destination.stat();
    const destinationAfterPath = await lstat(options.destination);
    if (
      destinationAfterHandle.dev !== destinationIdentity.dev
      || destinationAfterHandle.ino !== destinationIdentity.ino
      || destinationAfterHandle.size !== options.expectedSize
      || destinationAfterPath.dev !== destinationAfterHandle.dev
      || destinationAfterPath.ino !== destinationAfterHandle.ino
      || destinationAfterPath.size !== destinationAfterHandle.size
      || destinationAfterPath.nlink !== 1
      || destinationAfterPath.uid !== currentUid()
      || (destinationAfterPath.mode & 0o777) !== options.destinationMode
    ) {
      throw new Error(`${options.label} destination identity changed while copying`);
    }
    return {
      path: options.destination,
      size: options.expectedSize,
      sha256,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await destination?.close().catch((error) => {
      primaryError ??= error;
    });
    await source.close().catch((error) => {
      primaryError ??= error;
    });
    if (primaryError !== undefined && destinationIdentity !== undefined) {
      try {
        const current = await lstat(options.destination);
        if (current.dev !== destinationIdentity.dev || current.ino !== destinationIdentity.ino) {
          throw new Error(`${options.label} failed and destination cleanup identity drifted`);
        }
        await unlink(options.destination);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new AggregateError(
            [primaryError, cleanupError],
            `${options.label} failed and destination cleanup could not be proven`,
          );
        }
      }
    }
  }
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("build-runner requires numeric filesystem ownership");
  return uid;
}

function assertSafeAbsolute(input: string, label: string): string {
  if (!input || CONTROL_RE.test(input) || !path.isAbsolute(input)) {
    throw new Error(`${label} must be a safe absolute path`);
  }
  return path.normalize(input);
}

function assertDirectoryStat(value: Stats, label: string): void {
  if (!value.isDirectory()) throw new Error(`${label} must be a directory`);
  if ((value.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be group/other writable`);
  }
  if (value.uid !== currentUid()) throw new Error(`${label} must be owned by the current user`);
}

function assertTrustedDirectoryStat(value: Stats, label: string): void {
  if (!value.isDirectory()) throw new Error(`${label} must be a directory`);
  const uid = currentUid();
  if (value.uid !== 0 && value.uid !== uid) {
    throw new Error(`${label} must be owned by root or the current user`);
  }
  if ((value.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be group/other writable`);
  }
}

export interface SafeAncestorChainOptions {
  /**
   * Trusted-local toolchains commonly live below macOS `/Applications` or a
   * Homebrew Cellar whose root/current-user-owned ancestor is group writable.
   * This option never permits world-writable non-sticky ancestors and is not
   * used for Docker sockets, workspaces, caches, snapshots, or cleanup roots.
   */
  allowTrustedGroupWritable?: boolean;
}

/** Validate every directory from an absolute candidate through the filesystem root. */
export async function assertSafeAncestorChain(
  candidate: string,
  label: string,
  options: SafeAncestorChainOptions = {},
): Promise<void> {
  const uid = currentUid();
  let current = assertSafeAbsolute(candidate, `${label} ancestor`);
  for (;;) {
    const value = await lstat(current);
    if (!value.isDirectory()) throw new Error(`${label} ancestor must be a directory`);
    if (value.uid !== 0 && value.uid !== uid) {
      throw new Error(`${label} has an ancestor owned by an untrusted user`);
    }
    const groupWritable = (value.mode & 0o020) !== 0;
    const worldWritable = (value.mode & 0o002) !== 0;
    const trustedStickyRoot = value.uid === 0 && (value.mode & 0o1000) !== 0;
    if (
      !trustedStickyRoot
      && (worldWritable || (groupWritable && !options.allowTrustedGroupWritable))
    ) {
      throw new Error(`${label} has an unsafe writable ancestor`);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Reject symlinked path components by requiring the normalized input to equal realpath. */
export async function canonicalOwnedDirectory(
  input: string,
  label: string,
  options: { exactMode?: number } = {},
): Promise<string> {
  const normalized = assertSafeAbsolute(input, label);
  const canonical = await realpath(normalized);
  if (canonical !== normalized) throw new Error(`${label} must not traverse symlinks`);
  await assertSafeAncestorChain(path.dirname(canonical), label);
  const before = await lstat(canonical);
  assertDirectoryStat(before, label);
  if (options.exactMode !== undefined && (before.mode & 0o777) !== options.exactMode) {
    throw new Error(`${label} permissions must be ${options.exactMode.toString(8)}`);
  }
  return canonical;
}

/** Canonicalize a non-writable root/current-user owned toolchain directory. */
export async function canonicalTrustedDirectory(
  input: string,
  label: string,
  options: SafeAncestorChainOptions = {},
): Promise<string> {
  const normalized = assertSafeAbsolute(input, label);
  const canonical = await realpath(normalized);
  await assertSafeAncestorChain(path.dirname(canonical), label, options);
  const before = await lstat(canonical);
  assertTrustedDirectoryStat(before, label);
  const after = await lstat(canonical);
  if (
    after.dev !== before.dev
    || after.ino !== before.ino
    || after.mode !== before.mode
    || after.uid !== before.uid
  ) {
    throw new Error(`${label} changed during validation`);
  }
  return canonical;
}

export async function canonicalTrustedExecutable(
  input: string,
  label: string,
  options: SafeAncestorChainOptions = {},
): Promise<string> {
  const normalized = assertSafeAbsolute(input, label);
  const canonical = await realpath(normalized);
  await assertSafeAncestorChain(path.dirname(canonical), label, options);
  const value = await stat(canonical);
  if (!value.isFile()) throw new Error(`${label} must be a regular file`);
  const uid = currentUid();
  if (value.uid !== 0 && value.uid !== uid) {
    throw new Error(`${label} must be owned by root or the current user`);
  }
  if ((value.mode & 0o022) !== 0) throw new Error(`${label} must not be group/other writable`);
  await access(canonical, fsConstants.X_OK);
  return canonical;
}

export function assertDisjointRoots(roots: readonly string[]): void {
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      const a = roots[left]!;
      const b = roots[right]!;
      if (a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`)) {
        throw new Error("trusted roots must be pairwise disjoint");
      }
    }
  }
}

export function normalizeRelativePath(input: string, label: string): string {
  if (
    !input
    || input.length > 1024
    || CONTROL_RE.test(input)
    || input.includes("\\")
    || path.posix.isAbsolute(input)
  ) {
    throw new Error(`${label} must be a safe POSIX relative path`);
  }
  const normalized = path.posix.normalize(input);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} must stay inside its root`);
  }
  if (normalized !== input || input.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must already be normalized`);
  }
  return normalized;
}

export async function existingDirectoryInside(
  root: string,
  relative: string,
  label: string,
): Promise<string> {
  const safe = relative === "." ? "." : normalizeRelativePath(relative, label);
  const candidate = safe === "." ? root : path.join(root, ...safe.split("/"));
  const canonical = await realpath(candidate);
  if (canonical !== root && !canonical.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} escaped its root`);
  }
  const value = await stat(canonical);
  assertDirectoryStat(value, label);
  return canonical;
}

export async function existingRegularFileInside(
  root: string,
  relative: string,
  label: string,
  maxBytes: number,
  options: { allowEmpty?: boolean } = {},
): Promise<{ path: string; size: number; sha256: string; mode: number }> {
  const safe = normalizeRelativePath(relative, label);
  const candidate = path.join(root, ...safe.split("/"));
  const linkCheck = await lstat(candidate);
  if (!linkCheck.isFile() || linkCheck.isSymbolicLink() || linkCheck.nlink !== 1) {
    throw new Error(`${label} must be a single-link regular file`);
  }
  const canonical = await realpath(candidate);
  if (!canonical.startsWith(`${root}${path.sep}`)) throw new Error(`${label} escaped its root`);
  const value = await lstat(canonical);
  if (!value.isFile() || value.nlink !== 1) throw new Error(`${label} must be a single-link regular file`);
  if (value.uid !== currentUid() || (value.mode & 0o022) !== 0) {
    throw new Error(`${label} must be current-user owned and not group/other writable`);
  }
  if (value.dev !== linkCheck.dev || value.ino !== linkCheck.ino) {
    throw new Error(`${label} changed during path validation`);
  }
  if ((!options.allowEmpty && value.size < 1) || value.size > maxBytes) {
    throw new Error(`${label} exceeds its byte limit`);
  }
  const handle = await open(canonical, "r");
  try {
    const digest = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) digest.update(chunk as Buffer);
    const after = await handle.stat();
    if (
      after.dev !== value.dev
      || after.ino !== value.ino
      || after.size !== value.size
      || after.mtimeMs !== value.mtimeMs
    ) {
      throw new Error(`${label} changed while hashing`);
    }
    return {
      path: canonical,
      size: value.size,
      sha256: digest.digest("hex"),
      mode: value.mode & 0o777,
    };
  } finally {
    await handle.close();
  }
}

export interface HashedEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export async function hashSelectedFiles(
  root: string,
  relativeFiles: readonly string[],
  options: {
    maxFiles?: number;
    maxTotalBytes?: number;
    maxFileBytes?: number;
    allowEmpty?: (relative: string) => boolean;
  } = {},
): Promise<HashedEntry[]> {
  const maxFiles = options.maxFiles ?? 256;
  const maxTotalBytes = options.maxTotalBytes ?? 32 * 1024 * 1024;
  const maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024;
  if (relativeFiles.length > maxFiles) throw new Error("selected file count exceeds limit");
  const out: HashedEntry[] = [];
  let total = 0;
  for (const relative of [...new Set(relativeFiles)].sort()) {
    const file = await existingRegularFileInside(root, relative, relative, maxFileBytes, {
      allowEmpty: options.allowEmpty?.(relative) ?? false,
    });
    total += file.size;
    if (total > maxTotalBytes) throw new Error("selected files exceed total byte limit");
    out.push({ path: relative, bytes: file.size, sha256: file.sha256 });
  }
  return out;
}

export async function listFilesRecursively(
  root: string,
  options: { maxFiles: number; maxBytes: number; maxFileBytes: number },
): Promise<string[]> {
  const files: string[] = [];
  let bytes = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
    for (const entry of entries) {
      if (!entry.name || CONTROL_RE.test(entry.name) || entry.name === "." || entry.name === "..") {
        throw new Error("directory contains an unsafe entry name");
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const value = await lstat(absolute);
      if (value.isSymbolicLink()) throw new Error(`symlink is not allowed: ${relative}`);
      if (value.isDirectory()) {
        assertDirectoryStat(value, `directory ${relative}`);
        await visit(absolute, relative);
      } else if (value.isFile()) {
        if (value.nlink !== 1) throw new Error(`hard link is not allowed: ${relative}`);
        if ((value.mode & 0o022) !== 0) throw new Error(`file is group/other writable: ${relative}`);
        if (value.uid !== currentUid()) throw new Error(`file is not owned by current user: ${relative}`);
        if (value.size > options.maxFileBytes) throw new Error(`file exceeds byte limit: ${relative}`);
        files.push(relative);
        bytes += value.size;
        if (files.length > options.maxFiles || bytes > options.maxBytes) {
          throw new Error("directory manifest exceeds configured limits");
        }
      } else {
        throw new Error(`special file is not allowed: ${relative}`);
      }
    }
  };
  await visit(root, "");
  return files;
}
