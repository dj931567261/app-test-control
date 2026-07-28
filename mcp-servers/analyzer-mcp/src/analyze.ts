// Session-level analysis: read crashes.jsonl + steps.jsonl from a session
// directory, run dedup, and produce summary structures.

import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  MAX_CRASH_STACK_BYTES,
  MAX_DEDUP_CRASHES,
  MAX_DEDUP_TOTAL_STACK_BYTES,
  dedupCrashes,
  type CrashGroup,
  type CrashInput,
  type DedupResult,
} from "./dedup.js";

/** Session metadata and individual stacks are intentionally bounded. */
export const MAX_SESSION_JSONL_BYTES = 16 * 1024 * 1024;
export const MAX_SESSION_RECORDS = 10_000;
export const MAX_SESSION_CRASHES = MAX_DEDUP_CRASHES;
export const MAX_SESSION_STACK_BYTES = MAX_CRASH_STACK_BYTES;
export const MAX_SESSION_TOTAL_STACK_BYTES = MAX_DEDUP_TOTAL_STACK_BYTES;
const FILE_READ_CHUNK_BYTES = 64 * 1024;
const MAX_SESSION_PATH_CHARS = 4096;
const MAX_ID_CHARS = 1024;
const MAX_TIMESTAMP_CHARS = 1024;
const MAX_SIGNATURE_CHARS = 4096;
const MAX_KIND_CHARS = 128;
const MAX_ACTION_CHARS = 16 * 1024;
const MAX_NOTES_CHARS = 64 * 1024;
const MAX_REPRO_PATH_ENTRIES = 10_000;
const MAX_JSONL_PHYSICAL_LINES = 20_000;

interface StoredCrash {
  id: string;
  ts: string;
  step_index?: number;
  signature: string;
  kind?: string;
  stack_path: string;
  log_path?: string;
  repro_path: number[];
  minimized_repro_path?: number[];
  minimized_attempts?: number;
  minimized_confidence?: "low" | "medium" | "high";
  minimized_complete?: boolean;
}

interface StoredStep {
  index: number;
  ts: string;
  action: string;
  result?: "ok" | "fail" | "skip";
  screenshot?: string;
  log_excerpt?: string;
  notes?: string;
}

async function canonicalSessionRoot(sessionDir: string): Promise<string> {
  if (
    typeof sessionDir !== "string" ||
    sessionDir.length === 0 ||
    sessionDir.length > MAX_SESSION_PATH_CHARS ||
    !path.isAbsolute(sessionDir)
  ) {
    throw new Error("session_dir must be absolute");
  }
  const root = await realpath(sessionDir);
  if (!(await stat(root)).isDirectory()) {
    throw new Error("session_dir must resolve to a directory");
  }
  return root;
}

function errnoIs(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

/**
 * Distinguish a genuinely absent file from an ENOENT caused by a broken
 * symlink. Every existing component is checked without following it.
 */
async function pathIsMissingWithoutSymlink(
  root: string,
  candidate: string,
  label: string,
): Promise<boolean> {
  const relative = path.relative(root, candidate);
  const parts = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw new Error(`${label} must not contain symbolic links`);
      }
    } catch (error) {
      if (errnoIs(error, "ENOENT")) return true;
      throw error;
    }
  }
  return false;
}

function assertContained(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must stay inside session_dir`);
  }
}

/**
 * Read one regular file without following a final symlink and without letting a
 * FIFO block open(). realpath equality also rejects symlinks in intermediate
 * components; containment is checked both before and after canonicalization.
 */
async function readBoundedSessionFile(
  root: string,
  relativePath: string,
  maxBytes: number,
  label: string,
  allowMissing = false,
): Promise<{ text: string; bytes: number } | undefined> {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.length > MAX_SESSION_PATH_CHARS ||
    relativePath.includes("\0") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`${label} must be a non-empty relative path`);
  }

  const lexicalPath = path.resolve(root, relativePath);
  assertContained(root, lexicalPath, label);

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(lexicalPath);
  } catch (error) {
    if (
      allowMissing &&
      errnoIs(error, "ENOENT") &&
      await pathIsMissingWithoutSymlink(root, lexicalPath, label)
    ) {
      return undefined;
    }
    throw error;
  }
  assertContained(root, canonicalPath, label);
  if (canonicalPath !== lexicalPath) {
    throw new Error(`${label} must not contain symbolic links`);
  }

  const flags = fsConstants.O_RDONLY |
    (fsConstants.O_NONBLOCK ?? 0) |
    (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(lexicalPath, flags);
  } catch (error) {
    if (
      allowMissing &&
      errnoIs(error, "ENOENT") &&
      await pathIsMissingWithoutSymlink(root, lexicalPath, label)
    ) {
      return undefined;
    }
    throw error;
  }
  try {
    const fileStat = await handle.stat({ bigint: true });
    if (!fileStat.isFile()) {
      throw new Error(`${label} must resolve to a regular file`);
    }
    if (fileStat.size > BigInt(maxBytes)) {
      throw new Error(`${label} exceeds ${maxBytes} byte size limit`);
    }

    // realpath() before open is not sufficient: an intermediate component can
    // be exchanged between those calls. Re-resolve the opened path and compare
    // its current inode with fstat() before reading from the descriptor.
    const postOpenCanonical = await realpath(lexicalPath);
    assertContained(root, postOpenCanonical, label);
    if (postOpenCanonical !== lexicalPath) {
      throw new Error(`${label} must not contain symbolic links`);
    }
    const pathStat = await stat(lexicalPath, { bigint: true });
    const confirmedCanonical = await realpath(lexicalPath);
    assertContained(root, confirmedCanonical, label);
    if (confirmedCanonical !== lexicalPath) {
      throw new Error(`${label} must not contain symbolic links`);
    }
    if (fileStat.dev !== pathStat.dev || fileStat.ino !== pathStat.ino) {
      throw new Error(`${label} changed while it was being opened`);
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const remaining = maxBytes + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(FILE_READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) {
        throw new Error(`${label} exceeds ${maxBytes} byte size limit`);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return {
      text: Buffer.concat(chunks, totalBytes).toString("utf8"),
      bytes: totalBytes,
    };
  } finally {
    await handle.close();
  }
}

type RecordValidator<T> = (value: unknown, line: number) => T;

async function readJsonl<T>(
  sessionRoot: string,
  fileName: "crashes.jsonl" | "steps.jsonl",
  maxRecords: number,
  validate: RecordValidator<T>,
): Promise<T[]> {
  const file = await readBoundedSessionFile(
    sessionRoot,
    fileName,
    MAX_SESSION_JSONL_BYTES,
    fileName,
    true,
  );
  if (file === undefined) return [];

  const records: T[] = [];
  let offset = 0;
  let lineNumber = 1;
  while (offset <= file.text.length) {
    if (lineNumber > MAX_JSONL_PHYSICAL_LINES) {
      throw new Error(`${fileName} exceeds ${MAX_JSONL_PHYSICAL_LINES} physical line limit`);
    }
    const newline = file.text.indexOf("\n", offset);
    const end = newline === -1 ? file.text.length : newline;
    const line = file.text.slice(offset, end).trim();
    if (line.length > 0) {
      // Enforce before JSON.parse so an over-limit line never becomes another
      // attacker-controlled object in memory.
      if (records.length >= maxRecords) {
        throw new Error(`${fileName} exceeds ${maxRecords} record limit`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        // JSON.parse diagnostics may echo attacker-controlled line fragments.
        throw new Error(`${fileName} line ${lineNumber} is invalid JSON`);
      }
      records.push(validate(parsed, lineNumber));
    }
    if (newline === -1) break;
    offset = newline + 1;
    lineNumber++;
  }
  return records;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      const displayKey = key.length <= 128 ? key : `${key.slice(0, 128)}…`;
      throw new TypeError(`${label}.${displayKey} is not supported`);
    }
  }
}

function requireString(
  value: unknown,
  label: string,
  maxChars: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TypeError(
      `${label} must be ${allowEmpty ? "a string" : "a non-empty string"}`,
    );
  }
  if (value.length > maxChars) {
    throw new RangeError(`${label} exceeds ${maxChars} character limit`);
  }
  return value;
}

function optionalString(
  value: unknown,
  label: string,
  maxChars: number,
  allowEmpty = false,
): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, label, maxChars, allowEmpty);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : nonNegativeInteger(value, label);
}

function indexArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (value.length > MAX_REPRO_PATH_ENTRIES) {
    throw new RangeError(`${label} exceeds ${MAX_REPRO_PATH_ENTRIES} entry limit`);
  }
  return value.map((entry, index) => nonNegativeInteger(entry, `${label}[${index}]`));
}

const STORED_CRASH_FIELDS = new Set([
  "id", "ts", "step_index", "signature", "kind", "stack_path", "log_path",
  "repro_path", "minimized_repro_path", "minimized_attempts",
  "minimized_confidence", "minimized_complete",
]);

function validateStoredCrash(value: unknown, line: number): StoredCrash {
  const label = `crashes.jsonl line ${line}`;
  const record = requireRecord(value, label);
  rejectUnknownFields(record, STORED_CRASH_FIELDS, label);
  const stepIndex = optionalNonNegativeInteger(record["step_index"], `${label}.step_index`);
  const kind = optionalString(record["kind"], `${label}.kind`, MAX_KIND_CHARS, true);
  const logPath = optionalString(record["log_path"], `${label}.log_path`, MAX_SESSION_PATH_CHARS);
  const minimizedPath = record["minimized_repro_path"] === undefined
    ? undefined
    : indexArray(record["minimized_repro_path"], `${label}.minimized_repro_path`);
  const minimizedAttempts = optionalNonNegativeInteger(
    record["minimized_attempts"],
    `${label}.minimized_attempts`,
  );
  const minimizedConfidence = record["minimized_confidence"];
  if (
    minimizedConfidence !== undefined &&
    minimizedConfidence !== "low" &&
    minimizedConfidence !== "medium" &&
    minimizedConfidence !== "high"
  ) {
    throw new TypeError(`${label}.minimized_confidence is invalid`);
  }
  const minimizedComplete = record["minimized_complete"];
  if (minimizedComplete !== undefined && typeof minimizedComplete !== "boolean") {
    throw new TypeError(`${label}.minimized_complete must be a boolean`);
  }

  return {
    id: requireString(record["id"], `${label}.id`, MAX_ID_CHARS),
    ts: requireString(record["ts"], `${label}.ts`, MAX_TIMESTAMP_CHARS),
    ...(stepIndex !== undefined ? { step_index: stepIndex } : {}),
    signature: requireString(
      record["signature"],
      `${label}.signature`,
      MAX_SIGNATURE_CHARS,
      true,
    ),
    ...(kind !== undefined ? { kind } : {}),
    stack_path: requireString(
      record["stack_path"],
      `${label}.stack_path`,
      MAX_SESSION_PATH_CHARS,
    ),
    ...(logPath !== undefined ? { log_path: logPath } : {}),
    repro_path: indexArray(record["repro_path"], `${label}.repro_path`),
    ...(minimizedPath !== undefined ? { minimized_repro_path: minimizedPath } : {}),
    ...(minimizedAttempts !== undefined ? { minimized_attempts: minimizedAttempts } : {}),
    ...(minimizedConfidence !== undefined
      ? { minimized_confidence: minimizedConfidence }
      : {}),
    ...(minimizedComplete !== undefined ? { minimized_complete: minimizedComplete } : {}),
  };
}

const STORED_STEP_FIELDS = new Set([
  "index", "ts", "action", "result", "screenshot", "log_excerpt", "notes",
]);

function validateStoredStep(value: unknown, line: number): StoredStep {
  const label = `steps.jsonl line ${line}`;
  const record = requireRecord(value, label);
  rejectUnknownFields(record, STORED_STEP_FIELDS, label);
  const result = record["result"];
  if (result !== undefined && result !== "ok" && result !== "fail" && result !== "skip") {
    throw new TypeError(`${label}.result is invalid`);
  }
  const screenshot = optionalString(
    record["screenshot"],
    `${label}.screenshot`,
    MAX_SESSION_PATH_CHARS,
  );
  const logExcerpt = optionalString(
    record["log_excerpt"],
    `${label}.log_excerpt`,
    MAX_SESSION_PATH_CHARS,
  );
  const notes = optionalString(record["notes"], `${label}.notes`, MAX_NOTES_CHARS, true);
  return {
    index: nonNegativeInteger(record["index"], `${label}.index`),
    ts: requireString(record["ts"], `${label}.ts`, MAX_TIMESTAMP_CHARS),
    action: requireString(record["action"], `${label}.action`, MAX_ACTION_CHARS, true),
    ...(result !== undefined ? { result } : {}),
    ...(screenshot !== undefined ? { screenshot } : {}),
    ...(logExcerpt !== undefined ? { log_excerpt: logExcerpt } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

/**
 * Hydrate StoredCrash records with their on-disk stack text and re-run dedup.
 * Each group additionally carries `repro_paths` (one per instance) for downstream
 * minimization workflows.
 */
export interface SessionAnalysis extends DedupResult {
  groups: SessionCrashGroup[];
}

export interface SessionCrashGroup extends CrashGroup {
  repro_paths: number[][];
  instance_step_indices: number[];
}

export async function analyzeSession(sessionDir: string): Promise<SessionAnalysis> {
  const sessionRoot = await canonicalSessionRoot(sessionDir);
  const crashes = await readJsonl<StoredCrash>(
    sessionRoot,
    "crashes.jsonl",
    MAX_SESSION_CRASHES,
    validateStoredCrash,
  );

  // Build CrashInput[] with stack text loaded
  const inputs: CrashInput[] = [];
  const byId = new Map<string, StoredCrash>();
  const stackCache = new Map<string, { text: string; bytes: number }>();
  let totalStackBytes = 0;
  for (const c of crashes) {
    if (byId.has(c.id)) {
      throw new Error(`crashes.jsonl contains duplicate id ${JSON.stringify(c.id)}`);
    }
    let stackFile = stackCache.get(c.stack_path);
    if (stackFile === undefined) {
      stackFile = await readBoundedSessionFile(
        sessionRoot,
        c.stack_path,
        MAX_SESSION_STACK_BYTES,
        "crash stack_path",
      );
      if (stackFile !== undefined) stackCache.set(c.stack_path, stackFile);
    }
    if (stackFile === undefined) {
      throw new Error("crash stack_path is missing");
    }
    totalStackBytes += stackFile.bytes;
    if (totalStackBytes > MAX_SESSION_TOTAL_STACK_BYTES) {
      throw new Error(
        `session stack input exceeds ${MAX_SESSION_TOTAL_STACK_BYTES} total byte limit`,
      );
    }
    const input: CrashInput = {
      id: c.id,
      signature: c.signature,
      stack: stackFile.text,
    };
    if (c.kind !== undefined) input.kind = c.kind;
    if (c.step_index !== undefined) input.step_index = c.step_index;
    inputs.push(input);
    byId.set(c.id, c);
  }

  const dedup = dedupCrashes(inputs);

  // Attach repro_paths per group
  const enriched: SessionCrashGroup[] = dedup.groups.map((g) => {
    const repro_paths: number[][] = [];
    const instance_step_indices: number[] = [];
    for (const id of g.instance_ids) {
      const c = byId.get(id);
      if (!c) continue;
      repro_paths.push(c.repro_path ?? []);
      if (c.step_index !== undefined) instance_step_indices.push(c.step_index);
    }
    return { ...g, repro_paths, instance_step_indices };
  });

  return {
    total: dedup.total,
    unique: dedup.unique,
    groups: enriched,
  };
}

/**
 * Lightweight static minimization. Given the full step sequence and a target crash step,
 * keep steps that look likely to be required:
 *   - last step (the trigger)
 *   - any step whose `notes` indicates a page transition (e.g. "page X → Y" with X != Y)
 *   - any step with result === "fail"
 * Drop steps with result === "skip" (recovery / no-op marker).
 *
 * This is a heuristic — for true minimal repro the user should run the minimize skill,
 * which performs live replay-based delta-debug.
 */
export interface SuggestedMinimalPath {
  original_path: number[];
  suggested_path: number[];
  reasoning: Record<number, string>; // step_index → why kept
  confidence: "low" | "medium";      // never "high" without replay
}

const TRANSITION_RE = /page\s+([0-9a-f]{6,})\s*→\s*([0-9a-f]{6,})/i;

interface StructuredStepNotes {
  page_from?: unknown;
  page_to?: unknown;
  replay?: {
    action_type?: unknown;
  };
}

function parseStructuredNotes(notes: string | undefined): StructuredStepNotes | null {
  if (!notes) return null;
  try {
    const parsed: unknown = JSON.parse(notes);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as StructuredStepNotes)
      : null;
  } catch {
    return null;
  }
}

function pageTransition(notes: string | undefined): [string, string] | null {
  if (!notes) return null;

  const structured = parseStructuredNotes(notes);
  if (
    typeof structured?.page_from === "string" &&
    typeof structured.page_to === "string" &&
    structured.page_from.length > 0 &&
    structured.page_to.length > 0
  ) {
    return [structured.page_from, structured.page_to];
  }

  // Backward compatibility for sessions produced before notes became JSON.
  const legacy = TRANSITION_RE.exec(notes);
  return legacy?.[1] && legacy[2] ? [legacy[1], legacy[2]] : null;
}

export async function suggestMinimalPath(
  sessionDir: string,
  reproPath: number[],
  targetStepIndex: number,
): Promise<SuggestedMinimalPath> {
  const sessionRoot = await canonicalSessionRoot(sessionDir);
  const steps = await readJsonl<StoredStep>(
    sessionRoot,
    "steps.jsonl",
    MAX_SESSION_RECORDS,
    validateStoredStep,
  );
  const validatedReproPath = indexArray(reproPath, "repro_path");
  const validatedTargetStepIndex = nonNegativeInteger(
    targetStepIndex,
    "target_step_index",
  );
  const byIndex = new Map<number, StoredStep>();
  for (const step of steps) {
    if (byIndex.has(step.index)) {
      throw new Error(`steps.jsonl contains duplicate index ${step.index}`);
    }
    byIndex.set(step.index, step);
  }

  const reasoning: Record<number, string> = {};
  const kept: number[] = [];

  for (const idx of validatedReproPath) {
    const s = byIndex.get(idx);
    if (!s) continue;

    if (idx === validatedTargetStepIndex) {
      kept.push(idx);
      reasoning[idx] = "trigger (crash detected after this step)";
      continue;
    }
    const structuredNotes = parseStructuredNotes(s.notes);
    if (structuredNotes?.replay?.action_type === "launch") {
      kept.push(idx);
      reasoning[idx] = "launch setup";
      continue;
    }
    if (s.result === "skip") {
      // skipped: usually recovery / out-of-scope navigation
      continue;
    }
    if (s.result === "fail") {
      kept.push(idx);
      reasoning[idx] = "explicit failure";
      continue;
    }
    const transition = pageTransition(s.notes);
    if (transition) {
      const [from, to] = transition;
      if (from !== to) {
        kept.push(idx);
        reasoning[idx] = `page transition ${from.slice(0, 6)} → ${to.slice(0, 6)}`;
        continue;
      }
    }
    // otherwise: candidate for removal
  }

  // Ensure target is included even if it wasn't in repro_path
  if (!kept.includes(validatedTargetStepIndex)) {
    kept.push(validatedTargetStepIndex);
    reasoning[validatedTargetStepIndex] = "trigger";
  }
  kept.sort((a, b) => a - b);

  return {
    original_path: validatedReproPath,
    suggested_path: kept,
    reasoning,
    confidence: kept.length < validatedReproPath.length ? "medium" : "low",
  };
}
