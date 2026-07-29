// Lightweight recursive walker, no glob dep.
// Skips build / vcs / dependency dirs. Caps total files to avoid runaway scans
// on monorepos.

import { readdir, stat, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, relative, sep } from "node:path";

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

export async function walk(
  root: string,
  options: { extensions?: string[]; maxFiles?: number } = {},
): Promise<WalkResult> {
  const exts = options.extensions?.map((e) => (e.startsWith(".") ? e : "." + e));
  const max = options.maxFiles ?? DEFAULT_MAX_FILES;
  const files: string[] = [];
  const skipped: string[] = [];
  let truncated = false;

  async function visit(dir: string): Promise<void> {
    if (truncated) return;
    let entries: Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
    } catch {
      return;
    }
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
      if (ent.isDirectory()) {
        await visit(full);
      } else if (ent.isFile()) {
        if (!exts || exts.some((e) => ent.name.toLowerCase().endsWith(e))) {
          files.push(full);
          if (files.length >= max) {
            truncated = true;
            return;
          }
        }
      }
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
