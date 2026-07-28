import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

export interface SecureDirectory {
  requestedPath: string;
  canonicalPath: string;
  dev: bigint;
  ino: bigint;
  handle: FileHandle;
  assertUnchanged: () => Promise<void>;
  close: () => Promise<void>;
}

function sameInode(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function trustedUid(uid: bigint): boolean {
  const current =
    typeof process.geteuid === "function" ? BigInt(process.geteuid()) : uid;
  return uid === 0n || uid === current;
}

function unsafeSharedWritable(mode: bigint): boolean {
  const sharedWritable = (mode & 0o022n) !== 0n;
  const sticky = (mode & 0o1000n) !== 0n;
  return sharedWritable && !sticky;
}

async function closestExistingPath(target: string): Promise<string> {
  let candidate = target;
  for (;;) {
    try {
      await lstat(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

/** Reject ancestor chains another local user could rename or replace. */
async function assertSafeAncestorChain(target: string): Promise<void> {
  const existing = await closestExistingPath(target);
  const root = path.parse(existing).root;
  const relativeParts = path.relative(root, existing).split(path.sep).filter(Boolean);
  const lexicalRoot = await lstat(root, { bigint: true });
  if (
    !lexicalRoot.isDirectory() ||
    !trustedUid(lexicalRoot.uid) ||
    unsafeSharedWritable(lexicalRoot.mode)
  ) {
    throw new Error(`Private output path has an unsafe filesystem root: "${root}"`);
  }
  let lexical = root;
  for (const part of relativeParts) {
    lexical = path.join(lexical, part);
    const entry = await lstat(lexical, { bigint: true });
    if (entry.isSymbolicLink()) {
      if (lexical === target) {
        throw new Error(`Private output directory must not be a symbolic link: "${target}"`);
      }
      if (!trustedUid(entry.uid)) {
        throw new Error(`Private output path contains an untrusted symbolic link: "${lexical}"`);
      }
      continue;
    }
    if (!entry.isDirectory()) {
      throw new Error(`Private output ancestor is not a directory: "${lexical}"`);
    }
    if (!trustedUid(entry.uid)) {
      throw new Error(`Private output ancestor is controlled by another user: "${lexical}"`);
    }
    const isExistingTarget = existing === target && lexical === target;
    if (!isExistingTarget && unsafeSharedWritable(entry.mode)) {
      throw new Error(
        `Private output ancestor is group/world-writable without sticky protection: "${lexical}"`,
      );
    }
  }

  const canonicalExisting = await realpath(existing);
  const canonicalRoot = path.parse(canonicalExisting).root;
  const canonicalParts = path
    .relative(canonicalRoot, canonicalExisting)
    .split(path.sep)
    .filter(Boolean);
  let current = canonicalRoot;
  const chain = [canonicalRoot];
  for (const part of canonicalParts) {
    current = path.join(current, part);
    chain.push(current);
  }
  for (const directory of chain) {
    const info = await lstat(directory, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Private output ancestor is not a stable directory: "${directory}"`);
    }
    if (!trustedUid(info.uid)) {
      throw new Error(`Private output ancestor is controlled by another user: "${directory}"`);
    }
    // An already-existing target leaf is tightened below. Every actual parent
    // must already prevent unrelated users from renaming/replacing its child.
    const isExistingTarget = existing === target && directory === canonicalExisting;
    if (!isExistingTarget && unsafeSharedWritable(info.mode)) {
      throw new Error(
        `Private output ancestor is group/world-writable without sticky protection: "${directory}"`,
      );
    }
  }
}

/**
 * Create/open a caller-selected private directory without following a final
 * symlink. Existing directories are tightened to 0700 after ownership checks.
 * The returned descriptor remains an identity anchor across multi-step writes.
 */
export async function openSecureDirectory(directory: string): Promise<SecureDirectory> {
  if (
    typeof fsConstants.O_NOFOLLOW !== "number" ||
    typeof fsConstants.O_DIRECTORY !== "number"
  ) {
    throw new Error("This platform cannot safely open private directories");
  }
  const requestedPath = path.resolve(directory);
  await assertSafeAncestorChain(requestedPath);
  await mkdir(requestedPath, { recursive: true, mode: 0o700 });
  await assertSafeAncestorChain(requestedPath);
  const handle = await open(
    requestedPath,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  let closed = false;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory()) {
      throw new Error(`Private output path is not a directory: "${requestedPath}"`);
    }
    if (
      typeof process.geteuid === "function" &&
      opened.uid !== BigInt(process.geteuid())
    ) {
      throw new Error(`Private output directory must be owned by the current user: "${requestedPath}"`);
    }
    await handle.chmod(0o700);
    const secured = await handle.stat({ bigint: true });
    if (!sameInode(opened, secured) || (secured.mode & 0o777n) !== 0o700n) {
      throw new Error(`Private output directory permissions could not be secured: "${requestedPath}"`);
    }
    const lexical = await lstat(requestedPath, { bigint: true });
    if (!lexical.isDirectory() || lexical.isSymbolicLink() || !sameInode(secured, lexical)) {
      throw new Error(`Private output directory changed while it was opened: "${requestedPath}"`);
    }
    const canonicalPath = await realpath(requestedPath);
    const canonical = await stat(canonicalPath, { bigint: true });
    if (!canonical.isDirectory() || !sameInode(secured, canonical)) {
      throw new Error(`Private output directory canonical identity mismatch: "${requestedPath}"`);
    }

    const assertUnchanged = async (): Promise<void> => {
      if (closed) throw new Error(`Private output directory is already closed: "${requestedPath}"`);
      const [descriptor, currentLexical] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(requestedPath, { bigint: true }),
      ]);
      if (
        !descriptor.isDirectory() ||
        !currentLexical.isDirectory() ||
        currentLexical.isSymbolicLink() ||
        !sameInode(secured, descriptor) ||
        !sameInode(secured, currentLexical) ||
        (descriptor.mode & 0o777n) !== 0o700n
      ) {
        throw new Error(`Private output directory changed during use: "${requestedPath}"`);
      }
      const [currentCanonicalPath, canonicalStat] = await Promise.all([
        realpath(requestedPath),
        stat(canonicalPath, { bigint: true }),
      ]);
      if (
        currentCanonicalPath !== canonicalPath ||
        !canonicalStat.isDirectory() ||
        !sameInode(secured, canonicalStat)
      ) {
        throw new Error(`Private output directory identity changed during use: "${requestedPath}"`);
      }
    };

    return {
      requestedPath,
      canonicalPath,
      dev: secured.dev,
      ino: secured.ino,
      handle,
      assertUnchanged,
      close: async () => {
        if (closed) return;
        closed = true;
        await handle.close();
      },
    };
  } catch (error) {
    closed = true;
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export function assertDirectChild(
  directory: SecureDirectory,
  childCanonicalPath: string,
): void {
  if (path.dirname(childCanonicalPath) !== directory.canonicalPath) {
    throw new Error(
      `Output escaped its private directory: "${childCanonicalPath}"`,
    );
  }
}
