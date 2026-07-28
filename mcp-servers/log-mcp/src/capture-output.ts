import { constants as fsConstants, type WriteStream } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * 已经原子打开并校验过的 capture 输出。
 *
 * 调用方必须在两种所有权路径中二选一：
 * - spawn 前失败：调用 `close()`；
 * - spawn 成功：调用 `createWriteStream()`，之后由 file-capture lifecycle
 *   负责关闭 stream/file descriptor。
 */
export interface OpenedCaptureOutput {
  requestedPath: string;
  canonicalPath: string;
  inodeKey: string;
  existingBytes: number;
  createWriteStream: () => WriteStream;
  /** Reopen the published name and verify it still identifies this inode. */
  assertPathUnchanged: () => Promise<void>;
  close: () => Promise<void>;
}

/** 单个 capture 输出文件的默认总大小上限。 */
export const DEFAULT_CAPTURE_MAX_BYTES = 256 * 1024 * 1024;
/** 所有平台统一保留 2 GiB 硬上限。 */
export const MAX_CAPTURE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export function validateCaptureMaxBytes(value: number | undefined): number {
  const maxBytes = value ?? DEFAULT_CAPTURE_MAX_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > MAX_CAPTURE_MAX_BYTES
  ) {
    throw new RangeError(
      `maxBytes must be a positive safe integer no greater than ${MAX_CAPTURE_MAX_BYTES}`,
    );
  }
  return maxBytes;
}

export function remainingCaptureBytes(
  output: OpenedCaptureOutput,
  maxBytes: number,
): number {
  if (output.existingBytes >= maxBytes) {
    throw new Error(
      `Capture output already contains ${output.existingBytes} bytes, which meets or exceeds maxBytes=${maxBytes}`,
    );
  }
  return maxBytes - output.existingBytes;
}

function sameInode(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Open an append-only capture destination without ever following a final-path
 * symlink or blocking on a FIFO. Validation is performed against the opened
 * descriptor, not against a racy pre-open lstat result.
 */
export async function openCaptureOutput(filePath: string): Promise<OpenedCaptureOutput> {
  const requestedPath = path.resolve(filePath);
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error("This platform cannot safely open capture outputs without following symlinks");
  }

  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_APPEND |
    fsConstants.O_CREAT |
    fsConstants.O_NONBLOCK |
    fsConstants.O_NOFOLLOW;
  const handle = await open(requestedPath, flags, 0o600);
  let handedToStream = false;

  try {
    const openedStat = await handle.stat({ bigint: true });
    if (!openedStat.isFile()) {
      throw new Error(
        `Capture output must resolve to a regular file: "${requestedPath}"`,
      );
    }
    if (openedStat.nlink !== 1n) {
      throw new Error(
        `Capture output must not have multiple hard links: "${requestedPath}"`,
      );
    }
    if (
      typeof process.geteuid === "function" &&
      openedStat.uid !== BigInt(process.geteuid())
    ) {
      throw new Error(
        `Capture output must be owned by the current user: "${requestedPath}"`,
      );
    }
    if (openedStat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `Capture output is too large to account for safely: "${requestedPath}"`,
      );
    }

    // Older releases created append targets using the caller's umask and may
    // therefore have left sensitive device logs group/world-readable. Tighten
    // the already-open inode rather than rejecting a safe legacy file.
    await handle.chmod(0o600);
    const securedStat = await handle.stat({ bigint: true });
    if (
      !sameInode(openedStat, securedStat) ||
      (securedStat.mode & 0o777n) !== 0o600n
    ) {
      throw new Error(
        `Capture output permissions could not be secured: "${requestedPath}"`,
      );
    }

    // Resolve parent-directory aliases only after opening, then verify that the
    // name still identifies the same inode. A rename/symlink swap between open
    // and realpath is rejected rather than silently changing the destination.
    const canonicalPath = await realpath(requestedPath);
    const canonicalStat = await stat(canonicalPath, { bigint: true });
    if (!canonicalStat.isFile() || !sameInode(securedStat, canonicalStat)) {
      throw new Error(
        `Capture output changed while it was being opened: "${requestedPath}"`,
      );
    }

    let closed = false;
    return {
      requestedPath,
      canonicalPath,
      inodeKey: `${securedStat.dev}:${securedStat.ino}`,
      existingBytes: Number(securedStat.size),
      createWriteStream: () => {
        if (closed || handedToStream) {
          throw new Error(`Capture output is no longer available: "${requestedPath}"`);
        }
        // FileHandle.createWriteStream keeps the validated descriptor; it does
        // not reopen the caller-controlled path. autoClose transfers ownership
        // to the stream/file-capture lifecycle.
        const stream = handle.createWriteStream({ autoClose: true, emitClose: true });
        handedToStream = true;
        return stream;
      },
      assertPathUnchanged: async () => {
        const verifier = await open(
          canonicalPath,
          fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
        );
        try {
          const current = await verifier.stat({ bigint: true });
          if (
            !current.isFile() ||
            current.nlink !== 1n ||
            !sameInode(securedStat, current) ||
            (current.mode & 0o777n) !== 0o600n
          ) {
            throw new Error(
              `Capture output path changed during capture: "${canonicalPath}"`,
            );
          }
        } finally {
          await verifier.close();
        }
      },
      close: async () => {
        if (closed || handedToStream) return;
        closed = true;
        await handle.close();
      },
    };
  } catch (error) {
    if (!handedToStream) await handle.close().catch(() => undefined);
    throw error;
  }
}
