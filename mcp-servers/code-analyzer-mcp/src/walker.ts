// Lightweight recursive walker, no glob dep.
// Skips build / vcs / dependency dirs. Caps total files to avoid runaway scans
// on monorepos.

import { lstat, readdir, realpath, stat, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

const SKIP_DIR_NAMES = new Set([
  ".git",
  ".idea",
  ".gradle",
  ".cxx",
  ".dart_tool",
  ".vscode",
  ".codex-temp",
  ".claude",
  ".worktrees",
  "node_modules",
  "build",
  "dist",
  "out",
  "Pods",
  "DerivedData",
  ".pub-cache",
  "target",
  "vendor",
  "third_party",
]);

// Hard cap so a huge repo can't OOM us.
export const DEFAULT_MAX_FILES = 4000;

export interface WalkResult {
  files: string[];          // absolute paths
  skipped_dirs: string[];   // first ~20, for debugging
  truncated: boolean;
}

interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function directoryIdentity(metadata: Awaited<ReturnType<typeof lstat>>): DirectoryIdentity {
  const value = metadata as unknown as {
    dev: bigint;
    ino: bigint;
    mode: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  };
  return {
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  };
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (
    child !== ".."
    && !child.startsWith(`..${sep}`)
    && !isAbsolute(child)
  );
}

export async function walk(
  root: string,
  options: { extensions?: string[]; maxFiles?: number } = {},
): Promise<WalkResult> {
  const exts = options.extensions?.map((e) => (e.startsWith(".") ? e : "." + e));
  const max = options.maxFiles ?? DEFAULT_MAX_FILES;
  const files: string[] = [];
  const skipped: string[] = [];
  let truncated = false;
  const canonicalRoot = await realpath(root);

  async function visit(dir: string): Promise<void> {
    if (truncated) return;
    let before: DirectoryIdentity;
    try {
      const [metadata, canonical] = await Promise.all([
        lstat(dir, { bigint: true }),
        realpath(dir),
      ]);
      if (
        !metadata.isDirectory()
        || metadata.isSymbolicLink()
        || !isContained(canonicalRoot, canonical)
      ) {
        truncated = true;
        return;
      }
      before = directoryIdentity(metadata);
    } catch {
      truncated = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
    } catch {
      truncated = true;
      return;
    }
    // Directory enumeration order is filesystem-dependent. A stable bytewise
    // order keeps truncation and locator results reproducible across hosts.
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const ent of entries) {
      if (truncated) return;
      if (ent.name.startsWith(".") && SKIP_DIR_NAMES.has(ent.name)) {
        skipped.length < 20 && skipped.push(join(dir, ent.name));
        continue;
      }
      if (SKIP_DIR_NAMES.has(ent.name)) {
        skipped.length < 20 && skipped.push(join(dir, ent.name));
        continue;
      }
      const full = join(dir, ent.name);
      let metadata;
      try {
        const current = await lstat(full, { bigint: true });
        // A stable symlink is outside the scanner's source policy. Check this
        // before realpath so an intentionally present link does not make an
        // otherwise complete regular-file scan look truncated.
        if (current.isSymbolicLink()) continue;
        const canonical = await realpath(full);
        if (!isContained(canonicalRoot, canonical)) {
          truncated = true;
          return;
        }
        metadata = current;
      } catch {
        truncated = true;
        return;
      }
      // Never follow a path that changed from the enumerated entry into a
      // symlink or another special file before it is visited/read.
      if (metadata.isDirectory() && ent.isDirectory()) {
        await visit(full);
      } else if (metadata.isFile() && ent.isFile()) {
        if (!exts || exts.some((e) => ent.name.toLowerCase().endsWith(e))) {
          if (metadata.nlink !== 1n) {
            truncated = true;
            return;
          }
          if (files.length >= max) {
            truncated = true;
            return;
          }
          files.push(full);
        }
      } else {
        // Dirent and lstat disagree, so the tree changed during enumeration.
        truncated = true;
        return;
      }
    }

    try {
      const [metadata, canonical] = await Promise.all([
        lstat(dir, { bigint: true }),
        realpath(dir),
      ]);
      if (
        !metadata.isDirectory()
        || metadata.isSymbolicLink()
        || !isContained(canonicalRoot, canonical)
        || !sameDirectoryIdentity(before, directoryIdentity(metadata))
      ) {
        truncated = true;
      }
    } catch {
      truncated = true;
    }
  }

  await visit(root);
  return { files, skipped_dirs: skipped, truncated };
}

export function rel(from: string, abs: string): string {
  // Always forward-slashed for stable JSON.
  return relative(from, abs).split(sep).join("/");
}

export async function readUtf8(abs: string): Promise<string> {
  try {
    return await readFile(abs, "utf8");
  } catch {
    return "";
  }
}

export async function fileSize(abs: string): Promise<number> {
  try {
    return (await stat(abs)).size;
  } catch {
    return 0;
  }
}

// Compress whitespace runs to single spaces, trim, cap length.
export function snippet(s: string, max = 120): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

// Convert absolute byte offset (or line) into 1-based line number for reporting.
export function lineOf(content: string, index: number): number {
  if (index <= 0) return 1;
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}
