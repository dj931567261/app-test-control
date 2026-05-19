// Discover and copy Apple .ips crash files from ~/Library/Logs/DiagnosticReports/.
// Both macOS host and iOS Simulator crashes land in this directory.

import { readdir, readFile, stat, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const DIAGNOSTIC_REPORTS = path.join(
  os.homedir(),
  "Library",
  "Logs",
  "DiagnosticReports",
);

export interface IpsFileSummary {
  path: string;
  filename: string;
  proc_name: string;
  bundle_id?: string;
  timestamp: string;     // string as stored in header
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
  /** Optional override directory (testing). */
  reports_dir?: string;
}

export async function listIpsFiles(opts: ListIpsOpts = {}): Promise<IpsFileSummary[]> {
  const dir = opts.reports_dir ?? DIAGNOSTIC_REPORTS;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }

  const sinceMs = opts.since_minutes ? Date.now() - opts.since_minutes * 60_000 : 0;
  const bundleFilter = opts.bundle_id?.toLowerCase();
  const procFilter = opts.proc_name?.toLowerCase();

  const results: IpsFileSummary[] = [];
  for (const name of entries) {
    if (!name.endsWith(".ips")) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (sinceMs && st.mtimeMs < sinceMs) continue;

    const header = await readHeader(full);
    if (!header) continue;

    const procName = (header["name"] as string | undefined)
      ?? (header["procName"] as string | undefined)
      ?? (header["app_name"] as string | undefined)
      ?? "unknown";
    const bundleId = (header["bundleID"] as string | undefined)
      ?? (header["app_identifier"] as string | undefined);

    if (bundleFilter && !bundleId?.toLowerCase().includes(bundleFilter)) continue;
    if (procFilter && !procName.toLowerCase().includes(procFilter)) continue;

    results.push({
      path: full,
      filename: name,
      proc_name: procName,
      ...(bundleId !== undefined ? { bundle_id: bundleId } : {}),
      timestamp: (header["timestamp"] as string | undefined) ?? "",
      ...(header["bug_type"] !== undefined ? { bug_type: header["bug_type"] as string } : {}),
      ...(header["os_version"] !== undefined ? { os_version: header["os_version"] as string } : {}),
      size: st.size,
      mtime_ms: st.mtimeMs,
    });
  }
  results.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return results;
}

async function readHeader(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const txt = await readFile(filePath, "utf8");
    const firstLine = txt.split("\n")[0];
    if (!firstLine) return null;
    return JSON.parse(firstLine) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function copyIpsFiles(
  files: IpsFileSummary[],
  outDir: string,
): Promise<Array<{ from: string; to: string }>> {
  await mkdir(outDir, { recursive: true });
  const result: Array<{ from: string; to: string }> = [];
  for (const f of files) {
    const dest = path.join(outDir, f.filename);
    await copyFile(f.path, dest);
    result.push({ from: f.path, to: dest });
  }
  return result;
}
