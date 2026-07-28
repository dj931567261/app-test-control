import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import { MAX_CAPTURE_MAX_BYTES } from "./capture-output.js";
import { assertDirectChild, openSecureDirectory } from "./secure-directory.js";

export const MAX_SNIPPET_SOURCE_BYTES = MAX_CAPTURE_MAX_BYTES;
export const MAX_SNIPPET_TEXT_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_SNIPPET_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MAX_SNIPPET_LINE_BYTES = 1024 * 1024;
export const MAX_SNIPPET_SCANNED_LINES = 1_000_000;
export const MAX_SNIPPET_LAST_LINES = 10_000;
export const MAX_SNIPPET_FILTER_LENGTH = 512;
export const MAX_SNIPPET_PATH_LENGTH = 4_096;

export interface SnippetSelectionOptions {
  grep?: string;
  lastLines?: number;
}

export interface SavedSnippet {
  outPath: string;
  bytes: number;
  sourceBytes: number;
  selectedLines: number;
  truncated: boolean;
}

interface SelectionResult {
  content: Buffer;
  sourceBytes: number;
  selectedLines: number;
  truncated: boolean;
}

interface FileIdentity {
  canonicalPath: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

function sameInode(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function validateAbsolutePath(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.length > MAX_SNIPPET_PATH_LENGTH ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    throw new Error(
      `${label} must be a non-empty absolute path no longer than ${MAX_SNIPPET_PATH_LENGTH} characters`,
    );
  }
  return path.resolve(value);
}

function validateSelection(options: SnippetSelectionOptions): {
  needle?: Buffer;
  lastLines?: number;
} {
  let needle: Buffer | undefined;
  if (options.grep !== undefined) {
    if (
      options.grep.length === 0 ||
      options.grep.length > MAX_SNIPPET_FILTER_LENGTH
    ) {
      throw new RangeError(
        `grep must contain 1-${MAX_SNIPPET_FILTER_LENGTH} characters`,
      );
    }
    needle = Buffer.from(options.grep, "utf8");
  }
  if (
    options.lastLines !== undefined &&
    (!Number.isSafeInteger(options.lastLines) ||
      options.lastLines <= 0 ||
      options.lastLines > MAX_SNIPPET_LAST_LINES)
  ) {
    throw new RangeError(
      `lastLines must be an integer between 1 and ${MAX_SNIPPET_LAST_LINES}`,
    );
  }
  return {
    ...(needle !== undefined ? { needle } : {}),
    ...(options.lastLines !== undefined ? { lastLines: options.lastLines } : {}),
  };
}

class LineCollector {
  private readonly needle: Buffer | undefined;
  private readonly lastLines: number | undefined;
  private pending = Buffer.alloc(0);
  private readonly selected: Buffer[] = [];
  private selectedBytes = 0;
  private scannedLines = 0;
  private matchedLines = 0;
  private byteTruncated = false;

  constructor(options: SnippetSelectionOptions) {
    const validated = validateSelection(options);
    this.needle = validated.needle;
    this.lastLines = validated.lastLines;
  }

  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline + 1;
      const fragment = chunk.subarray(offset, end);
      if (this.pending.length + fragment.length > MAX_SNIPPET_LINE_BYTES) {
        throw new Error(
          `Log line exceeds ${MAX_SNIPPET_LINE_BYTES} byte safety limit`,
        );
      }
      this.pending = Buffer.concat([this.pending, fragment]);
      offset = end;
      if (newline !== -1) this.finishPendingLine();
    }
  }

  finish(): Omit<SelectionResult, "sourceBytes"> {
    if (this.pending.length > 0) this.finishPendingLine();
    return {
      content: Buffer.concat(this.selected, this.selectedBytes),
      selectedLines: this.selected.length,
      truncated: this.byteTruncated,
    };
  }

  private finishPendingLine(): void {
    const line = this.pending;
    this.pending = Buffer.alloc(0);
    this.scannedLines += 1;
    if (this.scannedLines > MAX_SNIPPET_SCANNED_LINES) {
      throw new Error(
        `Log source exceeds ${MAX_SNIPPET_SCANNED_LINES} line safety limit`,
      );
    }
    if (this.needle && !line.includes(this.needle)) return;
    this.matchedLines += 1;

    if (this.lastLines === undefined) {
      if (this.selectedBytes + line.length > MAX_SNIPPET_OUTPUT_BYTES) {
        throw new Error(
          `Selected log snippet exceeds ${MAX_SNIPPET_OUTPUT_BYTES} bytes; narrow it with grep or last_lines`,
        );
      }
      this.selected.push(line);
      this.selectedBytes += line.length;
      return;
    }

    this.selected.push(line);
    this.selectedBytes += line.length;
    while (
      this.selected.length > this.lastLines ||
      this.selectedBytes > MAX_SNIPPET_OUTPUT_BYTES
    ) {
      const removed = this.selected.shift();
      if (!removed) break;
      this.selectedBytes -= removed.length;
    }
    this.byteTruncated ||=
      this.selected.length < Math.min(this.matchedLines, this.lastLines);
  }
}

function selectFromBuffer(
  input: Buffer,
  options: SnippetSelectionOptions,
): SelectionResult {
  if (input.length > MAX_SNIPPET_TEXT_SOURCE_BYTES) {
    throw new RangeError(
      `In-memory log source exceeds ${MAX_SNIPPET_TEXT_SOURCE_BYTES} bytes`,
    );
  }
  const collector = new LineCollector(options);
  const chunkSize = 64 * 1024;
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    collector.push(input.subarray(offset, Math.min(input.length, offset + chunkSize)));
  }
  return { ...collector.finish(), sourceBytes: input.length };
}

async function openVerifiedSource(filePath: string): Promise<{
  handle: FileHandle;
  identity: FileIdentity;
}> {
  const requestedPath = validateAbsolutePath(filePath, "capture_file");
  if (
    typeof fsConstants.O_NOFOLLOW !== "number" ||
    typeof fsConstants.O_NONBLOCK !== "number"
  ) {
    throw new Error("This platform cannot safely read capture files");
  }
  const handle = await open(
    requestedPath,
    fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
  );
  try {
    const openedStat = await handle.stat({ bigint: true });
    if (!openedStat.isFile() || openedStat.nlink !== 1n) {
      throw new Error(`capture_file must be a single-link regular file: "${requestedPath}"`);
    }
    if (
      typeof process.geteuid === "function" &&
      openedStat.uid !== BigInt(process.geteuid())
    ) {
      throw new Error(`capture_file must be owned by the current user: "${requestedPath}"`);
    }
    if (
      openedStat.size > BigInt(MAX_SNIPPET_SOURCE_BYTES) ||
      openedStat.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new RangeError(
        `capture_file exceeds ${MAX_SNIPPET_SOURCE_BYTES} byte safety limit`,
      );
    }
    const canonicalPath = await realpath(requestedPath);
    const pathStat = await stat(canonicalPath, { bigint: true });
    if (!pathStat.isFile() || !sameInode(openedStat, pathStat)) {
      throw new Error(`capture_file changed while it was being opened: "${requestedPath}"`);
    }
    return {
      handle,
      identity: {
        canonicalPath,
        dev: openedStat.dev,
        ino: openedStat.ino,
        size: openedStat.size,
        mtimeNs: openedStat.mtimeNs,
      },
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function selectFromFile(
  filePath: string,
  options: SnippetSelectionOptions,
): Promise<{ selection: SelectionResult; identity: FileIdentity }> {
  const { handle, identity } = await openVerifiedSource(filePath);
  const collector = new LineCollector(options);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0n;
  try {
    while (position < identity.size) {
      const remaining = identity.size - position;
      const requested = Number(
        remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length),
      );
      const { bytesRead } = await handle.read(
        buffer,
        0,
        requested,
        Number(position),
      );
      if (bytesRead === 0) throw new Error("capture_file ended while it was being read");
      collector.push(buffer.subarray(0, bytesRead));
      position += BigInt(bytesRead);
    }
    const current = await handle.stat({ bigint: true });
    if (
      !sameInode(identity, current) ||
      current.size !== identity.size ||
      current.mtimeNs !== identity.mtimeNs
    ) {
      throw new Error("capture_file changed while the snippet was being selected");
    }
    return {
      selection: {
        ...collector.finish(),
        sourceBytes: Number(identity.size),
      },
      identity,
    };
  } finally {
    await handle.close();
  }
}

async function rejectUnsafeExistingOutput(
  destination: string,
  forbiddenSource: FileIdentity | undefined,
): Promise<void> {
  let existing;
  try {
    existing = await lstat(destination, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1n) {
    throw new Error(`Refusing unsafe existing snippet output: "${destination}"`);
  }
  if (
    typeof process.geteuid === "function" &&
    existing.uid !== BigInt(process.geteuid())
  ) {
    throw new Error(`Snippet output must be owned by the current user: "${destination}"`);
  }
  if (forbiddenSource && sameInode(forbiddenSource, existing)) {
    throw new Error("out_path must not alias capture_file");
  }
}

async function writePrivateOutput(
  outPath: string,
  content: Buffer,
  forbiddenSource?: FileIdentity,
): Promise<string> {
  const requestedPath = validateAbsolutePath(outPath, "out_path");
  const filename = path.basename(requestedPath);
  if (
    filename.length === 0 ||
    filename === "." ||
    filename === ".." ||
    Buffer.byteLength(filename, "utf8") > 255
  ) {
    throw new Error(`Unsafe snippet output filename: "${filename}"`);
  }
  const requestedParent = path.dirname(requestedPath);
  const directory = await openSecureDirectory(requestedParent);
  const canonicalParent = directory.canonicalPath;
  const destination = path.join(canonicalParent, filename);

  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    fsConstants.O_NOFOLLOW;
  let tempPath: string | undefined;
  let tempIdentity: { dev: bigint; ino: bigint; size: bigint } | undefined;
  try {
    await directory.assertUnchanged();
    await rejectUnsafeExistingOutput(destination, forbiddenSource);
    let tempHandle: FileHandle | undefined;
    for (let attempt = 0; attempt < 8 && !tempHandle; attempt += 1) {
      tempPath = path.join(
        canonicalParent,
        `.${filename}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
      );
      try {
        tempHandle = await open(tempPath, flags, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (!tempHandle || !tempPath) {
      throw new Error("Could not allocate private snippet temporary file");
    }
    try {
      await tempHandle.writeFile(content);
      await tempHandle.chmod(0o600);
      await tempHandle.sync();
      const written = await tempHandle.stat({ bigint: true });
      if (
        !written.isFile() ||
        written.nlink !== 1n ||
        written.size !== BigInt(content.length)
      ) {
        throw new Error("Snippet temporary output failed verification");
      }
      tempIdentity = { dev: written.dev, ino: written.ino, size: written.size };
    } finally {
      await tempHandle.close();
    }

    await directory.assertUnchanged();
    await rename(tempPath, destination);
    tempPath = undefined;
    await directory.assertUnchanged();

    const verified = await open(
      destination,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
    try {
      const finalStat = await verified.stat({ bigint: true });
      if (
        !tempIdentity ||
        !finalStat.isFile() ||
        finalStat.nlink !== 1n ||
        !sameInode(tempIdentity, finalStat) ||
        finalStat.size !== tempIdentity.size ||
        (finalStat.mode & 0o777n) !== 0o600n
      ) {
        throw new Error("Snippet output failed final verification");
      }
      const canonicalDestination = await realpath(destination);
      const pathStat = await stat(canonicalDestination, { bigint: true });
      if (!pathStat.isFile() || !sameInode(finalStat, pathStat)) {
        throw new Error("Snippet output path changed during final verification");
      }
      assertDirectChild(directory, canonicalDestination);
      await directory.assertUnchanged();
      return canonicalDestination;
    } finally {
      await verified.close();
    }
  } finally {
    if (tempPath) await unlink(tempPath).catch(() => undefined);
    await directory.close().catch(() => undefined);
  }
}

export async function saveSnippetFromFile(opts: {
  captureFile: string;
  outPath: string;
  grep?: string;
  lastLines?: number;
}): Promise<SavedSnippet> {
  const selectionOpts: SnippetSelectionOptions = {
    ...(opts.grep !== undefined ? { grep: opts.grep } : {}),
    ...(opts.lastLines !== undefined ? { lastLines: opts.lastLines } : {}),
  };
  const { selection, identity } = await selectFromFile(
    opts.captureFile,
    selectionOpts,
  );
  const outPath = await writePrivateOutput(
    opts.outPath,
    selection.content,
    identity,
  );
  return {
    outPath,
    bytes: selection.content.length,
    sourceBytes: selection.sourceBytes,
    selectedLines: selection.selectedLines,
    truncated: selection.truncated,
  };
}

export async function saveSnippetFromText(opts: {
  content: string;
  outPath: string;
  grep?: string;
  lastLines?: number;
}): Promise<SavedSnippet> {
  const selectionOpts: SnippetSelectionOptions = {
    ...(opts.grep !== undefined ? { grep: opts.grep } : {}),
    ...(opts.lastLines !== undefined ? { lastLines: opts.lastLines } : {}),
  };
  const selection = selectFromBuffer(Buffer.from(opts.content, "utf8"), selectionOpts);
  const outPath = await writePrivateOutput(opts.outPath, selection.content);
  return {
    outPath,
    bytes: selection.content.length,
    sourceBytes: selection.sourceBytes,
    selectedLines: selection.selectedLines,
    truncated: selection.truncated,
  };
}
