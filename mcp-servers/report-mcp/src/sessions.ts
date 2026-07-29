import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";

export const MAX_SESSION_PATH_CHARS = 4_096;
export const MAX_SESSION_ID_CHARS = 512;
export const MAX_CRASH_SIGNATURE_CHARS = 4_096;
export const MAX_CRASH_KIND_CHARS = 128;
export const MAX_CRASH_STACK_BYTES = 4 * 1024 * 1024;
export const MAX_CRASH_LOG_BYTES = 64 * 1024 * 1024;
export const MAX_CRASHES_PER_SESSION = 1_000;
export const MAX_REPRO_PATH_ENTRIES = 10_000;
export const MAX_CRASH_SOURCE_BYTES = 16 * 1024;
export const MAX_CRASH_SOURCE_METRICS = 32;
export const SESSION_LOCK_TIMEOUT_MS = 10_000;

const SESSION_LOCK_RETRY_MS = 25;
const SESSION_LOCK_DIRNAME = ".session-write.lock";
const SESSION_LOCK_OWNER_FILENAME = "owner.json";

const MAX_SOURCE_ID_CHARS = 512;
const MAX_SOURCE_PROVIDER_CHARS = 64;
const MAX_SOURCE_METRIC_KEY_CHARS = 64;
const SOURCE_PROVIDER_RE = /^[a-z0-9][a-z0-9._-]*$/;
const SOURCE_METRIC_KEY_RE = /^[a-zA-Z][a-zA-Z0-9._-]*$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const FIREBASE_CRASHLYTICS_PROVIDER = "firebase-crashlytics";
const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const sourceIdSchema = z
  .string()
  .min(1)
  .max(MAX_SOURCE_ID_CHARS)
  .refine((value) => value === value.trim(), "must not have surrounding whitespace")
  .refine((value) => !/[\r\n\0]/.test(value), "must be a single line");

const crashSourceMetricsSchema = z
  .record(z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER))
  .superRefine((metrics, ctx) => {
    const entries = Object.entries(metrics);
    if (entries.length > MAX_CRASH_SOURCE_METRICS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `metrics exceeds ${MAX_CRASH_SOURCE_METRICS} entry limit`,
      });
    }
    for (const [key] of entries) {
      if (
        key.length === 0 ||
        key.length > MAX_SOURCE_METRIC_KEY_CHARS ||
        !SOURCE_METRIC_KEY_RE.test(key)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key.slice(0, MAX_SOURCE_METRIC_KEY_CHARS)],
          message: "metric key is invalid or too long",
        });
      }
    }
  });

/** Provider metadata is deliberately scalar, bounded, and closed to extra keys. */
export const crashSourceSchema = z
  .object({
    provider: z
      .string()
      .min(1)
      .max(MAX_SOURCE_PROVIDER_CHARS)
      .regex(SOURCE_PROVIDER_RE),
    external_key: sourceIdSchema,
    project: sourceIdSchema.optional(),
    app: sourceIdSchema.optional(),
    issue: sourceIdSchema.optional(),
    event: sourceIdSchema.optional(),
    occurred: z
      .string()
      .min(1)
      .max(64)
      .refine(
        (value) => RFC3339_RE.test(value) && Number.isFinite(Date.parse(value)),
        "must be a valid RFC 3339 timestamp",
      )
      .optional(),
    metrics: crashSourceMetricsSchema.optional(),
  })
  .strict()
  .superRefine((source, ctx) => {
    if (source.provider === FIREBASE_CRASHLYTICS_PROVIDER) {
      for (const field of ["project", "app", "issue", "event"] as const) {
        if (source[field] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `firebase-crashlytics source requires ${field}`,
          });
        }
      }
      if (!SHA256_HEX_RE.test(source.external_key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["external_key"],
          message: "firebase-crashlytics external_key must be 64 lowercase SHA-256 hex characters",
        });
      }
    }
    if (Buffer.byteLength(JSON.stringify(source), "utf8") > MAX_CRASH_SOURCE_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `source exceeds ${MAX_CRASH_SOURCE_BYTES} byte size limit`,
      });
    }
  });

export type CrashSource = z.infer<typeof crashSourceSchema>;

export type SessionStatus = "running" | "passed" | "failed" | "aborted";
export type TerminalSessionStatus = Exclude<SessionStatus, "running">;

export interface SessionMeta {
  id: string;
  name: string;
  started_at: string; // ISO
  ended_at?: string;
  status: SessionStatus;
  /** Optional arbitrary key/value collected by the agent. */
  extra?: Record<string, unknown>;
}

export interface StepRecord {
  index: number;
  ts: string; // ISO
  action: string;
  result?: "ok" | "fail" | "skip";
  screenshot?: string; // relative path inside session dir
  log_excerpt?: string; // relative path
  notes?: string;
}

export interface CrashRecord {
  id: string;        // c1, c2, ...
  ts: string;
  step_index?: number; // step where it was detected
  signature: string;
  kind?: string;     // java | anr | native | other
  stack_path: string;  // relative
  log_path?: string;   // relative — full log archived
  repro_path: number[]; // sequence of step indices considered required
  /** Optional normalized origin for remote crash evidence. */
  source?: CrashSource;
}

const WORKSPACE_ENV = "APP_TEST_CTRL_WORKSPACE";

export function resolveWorkspaceRoot(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  const env = process.env[WORKSPACE_ENV];
  if (env) return path.resolve(env);
  // Default: cwd/workspace/sessions
  return path.resolve(process.cwd(), "workspace", "sessions");
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40) || "session";
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export interface CreatedSession {
  id: string;
  dir: string;
  meta_path: string;
}

export async function createSession(opts: {
  name: string;
  workspaceRoot?: string;
  extra?: Record<string, unknown>;
}): Promise<CreatedSession> {
  const root = resolveWorkspaceRoot(opts.workspaceRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("workspace root must be a real directory, not a symlink");
  }
  // The workspace is dedicated to report sessions. Restrict existing roots as
  // well as newly created ones so session names cannot leak to local users.
  await chmod(root, 0o700);
  const id = `${timestamp()}_${sanitizeName(opts.name)}_${randomUUID().slice(0, 8)}`;
  const dir = path.join(root, id);
  await mkdir(dir, { mode: 0o700 });
  await mkdir(path.join(dir, "steps"), { mode: 0o700 });
  await mkdir(path.join(dir, "crashes"), { mode: 0o700 });
  await mkdir(path.join(dir, "logs"), { mode: 0o700 });
  const meta: SessionMeta = {
    id,
    name: opts.name,
    started_at: new Date().toISOString(),
    status: "running",
    ...(opts.extra ? { extra: opts.extra } : {}),
  };
  const metaPath = path.join(dir, "meta.json");
  await writeFile(metaPath, JSON.stringify(meta, null, 2), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(path.join(dir, "steps.jsonl"), "", { flag: "wx", mode: 0o600 });
  await writeFile(path.join(dir, "crashes.jsonl"), "", { flag: "wx", mode: 0o600 });
  return { id, dir, meta_path: metaPath };
}

/** Copy one regular evidence file without following its final symlink. */
export async function copyRegularFilePrivate(
  source: string,
  destination: string,
  maxBytes: number,
): Promise<number> {
  if (!path.isAbsolute(source) || source.includes("\0")) {
    throw new TypeError("evidence source must be an absolute path");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("evidence byte limit must be a positive safe integer");
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const sourceHandle = await open(source, fsConstants.O_RDONLY | noFollow);
  let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
  let destinationCreated = false;
  try {
    const metadata = await sourceHandle.stat();
    if (!metadata.isFile()) throw new Error("evidence source must be a regular file");
    if (metadata.size > maxBytes) {
      throw new RangeError(`evidence source exceeds ${maxBytes} byte size limit`);
    }
    destinationHandle = await open(
      destination,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    destinationCreated = true;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new RangeError(`evidence source exceeds ${maxBytes} byte size limit`);
      }
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          null,
        );
        if (result.bytesWritten <= 0) {
          throw new Error("evidence destination write made no progress");
        }
        written += result.bytesWritten;
      }
    }
    await destinationHandle.sync();
    return total;
  } catch (error) {
    await destinationHandle?.close().catch(() => undefined);
    destinationHandle = undefined;
    if (destinationCreated) {
      await unlink(destination).catch(() => undefined);
    }
    throw error;
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle.close().catch(() => undefined);
  }
}

export async function loadMeta(sessionDir: string): Promise<SessionMeta> {
  const txt = await readFile(path.join(sessionDir, "meta.json"), "utf8");
  return JSON.parse(txt) as SessionMeta;
}

export async function writeMeta(sessionDir: string, meta: SessionMeta): Promise<void> {
  const metaPath = path.join(sessionDir, "meta.json");
  const temporaryPath = path.join(
    sessionDir,
    `.meta.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, JSON.stringify(meta, null, 2), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, metaPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function writePrivateTextFile(
  directory: string,
  filename: string,
  content: string,
): Promise<string> {
  if (path.basename(filename) !== filename || !/^[a-zA-Z0-9._-]+$/.test(filename)) {
    throw new TypeError("private text filename is invalid");
  }
  const finalPath = path.join(directory, filename);
  const temporaryPath = path.join(
    directory,
    `.${filename}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, finalPath);
    return finalPath;
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export function resolveSessionDir(opts: {
  workspaceRoot?: string;
  sessionId?: string;
  sessionDir?: string;
}): string {
  if (opts.sessionDir) return path.resolve(opts.sessionDir);
  if (!opts.sessionId) {
    throw new Error("Either session_id or session_dir is required");
  }
  return path.join(resolveWorkspaceRoot(opts.workspaceRoot), opts.sessionId);
}

export async function appendStep(
  sessionDir: string,
  step: StepRecord,
): Promise<void> {
  await appendFile(path.join(sessionDir, "steps.jsonl"), JSON.stringify(step) + "\n");
}

export async function appendCrash(
  sessionDir: string,
  crash: CrashRecord,
): Promise<void> {
  if (crash.source !== undefined) {
    validateCrashSourceExternalKey(crash.source, crash.signature);
  }
  await appendFile(
    path.join(sessionDir, "crashes.jsonl"),
    JSON.stringify(crash) + "\n",
  );
}

export async function readSteps(sessionDir: string): Promise<StepRecord[]> {
  try {
    const txt = await readFile(path.join(sessionDir, "steps.jsonl"), "utf8");
    return txt
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as StepRecord);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export async function readCrashes(sessionDir: string): Promise<CrashRecord[]> {
  try {
    const txt = await readFile(path.join(sessionDir, "crashes.jsonl"), "utf8");
    return txt
      .split("\n")
      .filter((l) => l.trim())
      .map((l, index) => {
        const parsed: unknown = JSON.parse(l);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new TypeError(`crashes.jsonl line ${index + 1} must be an object`);
        }
        const record = parsed as Record<string, unknown>;
        const source = record["source"] === undefined
          ? undefined
          : validateCrashSourceExternalKey(record["source"], record["signature"]);
        return {
          ...record,
          ...(source !== undefined ? { source } : {}),
        } as unknown as CrashRecord;
      });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export interface CrashEvidenceInput {
  signature: string;
  stack: string;
  kind?: string;
  step_index?: number;
  repro_path: number[];
  log_full_src?: string;
  source?: CrashSource;
}

export interface CrashEvidenceResult {
  crash: CrashRecord;
  /** True means the existing record with this external_key was returned. */
  deduplicated: boolean;
}

export interface SessionLockOptions {
  /** Hard upper bound for waiting on a lock owned by another process. */
  timeoutMs?: number;
  /** Poll interval. Exposed for deterministic tests; production uses 25 ms. */
  retryMs?: number;
}

export interface FinalizeSessionContext {
  meta: SessionMeta;
  steps: StepRecord[];
  crashes: CrashRecord[];
  /** True when this exact terminal status had already been persisted. */
  already_finalized: boolean;
}

interface AcquiredSessionLock {
  lockDir: string;
  ownerPath: string;
  token: string;
}

/**
 * Persist one crash under an atomic filesystem lock shared by all report-mcp
 * processes. Remote sources are idempotent by external_key, so retries cannot
 * create duplicate records or archive duplicate evidence files. The session
 * lifecycle check intentionally runs before deduplication: a finalized session
 * is immutable even when the caller retries an already archived event.
 */
export async function recordCrashEvidence(
  sessionDir: string,
  input: CrashEvidenceInput,
): Promise<CrashEvidenceResult> {
  assertCrashEvidenceInput(sessionDir, input);
  const source = input.source === undefined
    ? undefined
    : validateCrashSourceExternalKey(input.source, input.signature);

  return withSessionLock(sessionDir, async () => {
    const meta = await loadMeta(sessionDir);
    assertKnownSessionStatus(meta.status);
    if (meta.status !== "running") {
      throw new Error(
        `cannot record crash: session is not running (status=${meta.status})`,
      );
    }

    const existing = await readCrashes(sessionDir);
    if (source !== undefined) {
      const duplicate = existing.find(
        (crash) => crash.source?.external_key === source.external_key,
      );
      if (duplicate !== undefined) {
        if (
          duplicate.signature !== input.signature
          || duplicate.kind !== input.kind
          || duplicate.source === undefined
          || !sameCrashSource(duplicate.source, source)
        ) {
          throw new Error(
            "source.external_key is already archived with different crash evidence",
          );
        }
        return { crash: duplicate, deduplicated: true };
      }
    }
    if (existing.length >= MAX_CRASHES_PER_SESSION) {
      throw new RangeError(
        `session exceeds ${MAX_CRASHES_PER_SESSION} crash record limit`,
      );
    }

    const id = `c${existing.length + 1}`;
    const crashDir = path.join(sessionDir, "crashes");
    const crashDirectoryMetadata = await lstat(crashDir);
    if (!crashDirectoryMetadata.isDirectory() || crashDirectoryMetadata.isSymbolicLink()) {
      throw new Error("session crashes directory must be a real directory");
    }

    const stackPath = path.join(crashDir, `${id}.stack.txt`);
    const logDestination = input.log_full_src === undefined
      ? undefined
      : path.join(crashDir, `${id}.log`);
    let logPath: string | undefined;
    let stackHandle: Awaited<ReturnType<typeof open>> | undefined;
    let stackCreated = false;
    let logCreated = false;
    try {
      const noFollow = fsConstants.O_NOFOLLOW ?? 0;
      stackHandle = await open(
        stackPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
        0o600,
      );
      stackCreated = true;
      await stackHandle.writeFile(input.stack, { encoding: "utf8" });
      await stackHandle.close();
      stackHandle = undefined;
      if (input.log_full_src !== undefined && logDestination !== undefined) {
        await copyRegularFilePrivate(
          input.log_full_src,
          logDestination,
          MAX_CRASH_LOG_BYTES,
        );
        logCreated = true;
        logPath = path.relative(sessionDir, logDestination);
      }

      const crash: CrashRecord = {
        id,
        ts: new Date().toISOString(),
        signature: input.signature,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.step_index !== undefined ? { step_index: input.step_index } : {}),
        stack_path: path.relative(sessionDir, stackPath),
        ...(logPath !== undefined ? { log_path: logPath } : {}),
        repro_path: [...input.repro_path],
        ...(source !== undefined ? { source } : {}),
      };
      await appendCrash(sessionDir, crash);
      return { crash, deduplicated: false };
    } catch (error) {
      await stackHandle?.close().catch(() => undefined);
      if (stackCreated) {
        await unlink(stackPath).catch(() => undefined);
      }
      if (logCreated && logDestination !== undefined) {
        await unlink(logDestination).catch(() => undefined);
      }
      throw error;
    }
  });
}

/**
 * Transition a session to a terminal status and run report generation while
 * holding the same cross-process lock used by recordCrashEvidence.
 *
 * A retry with the same terminal status is safe and re-runs the callback from
 * the immutable session snapshot. A different terminal status fails closed.
 */
export async function finalizeSession<T>(
  sessionDir: string,
  status: TerminalSessionStatus,
  operation: (context: FinalizeSessionContext) => Promise<T>,
): Promise<{ context: FinalizeSessionContext; value: T }> {
  assertSessionDir(sessionDir);
  if (!isTerminalSessionStatus(status)) {
    throw new TypeError("finalize status must be passed, failed, or aborted");
  }

  return withSessionLock(sessionDir, async () => {
    const meta = await loadMeta(sessionDir);
    assertKnownSessionStatus(meta.status);

    let alreadyFinalized = false;
    if (meta.status === "running") {
      meta.status = status;
      meta.ended_at = new Date().toISOString();
      await writeMeta(sessionDir, meta);
    } else if (meta.status === status) {
      if (typeof meta.ended_at !== "string" || meta.ended_at.length === 0) {
        throw new Error("finalized session metadata is missing ended_at");
      }
      alreadyFinalized = true;
    } else {
      throw new Error(
        `cannot finalize session as ${status}: already finalized as ${meta.status}`,
      );
    }

    const context: FinalizeSessionContext = {
      meta,
      steps: await readSteps(sessionDir),
      crashes: await readCrashes(sessionDir),
      already_finalized: alreadyFinalized,
    };
    const value = await operation(context);
    return { context, value };
  });
}

function sameCrashSource(left: CrashSource, right: CrashSource): boolean {
  for (const field of [
    "provider",
    "external_key",
    "project",
    "app",
    "issue",
    "event",
    "occurred",
  ] as const) {
    if (left[field] !== right[field]) return false;
  }
  const leftMetrics = Object.entries(left.metrics ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightMetrics = Object.entries(right.metrics ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return leftMetrics.length === rightMetrics.length
    && leftMetrics.every(([key, value], index) => {
      const other = rightMetrics[index];
      return other?.[0] === key && other[1] === value;
    });
}

function validateCrashSourceExternalKey(
  rawSource: unknown,
  signature: unknown,
): CrashSource {
  const source = crashSourceSchema.parse(rawSource);
  if (source.provider !== FIREBASE_CRASHLYTICS_PROVIDER) return source;
  if (typeof signature !== "string" || signature.length === 0) {
    throw new TypeError(
      "firebase-crashlytics external_key validation requires a non-empty signature",
    );
  }

  // crashSourceSchema has already established that these four fields exist.
  const expected = createHash("sha256")
    .update(
      [
        source.provider,
        source.project,
        source.app,
        source.issue,
        source.event,
        signature,
      ].join("\0"),
      "utf8",
    )
    .digest("hex");
  if (source.external_key !== expected) {
    throw new Error(
      "firebase-crashlytics external_key does not match the normalized source identity and signature",
    );
  }
  return source;
}

function assertCrashEvidenceInput(sessionDir: string, input: CrashEvidenceInput): void {
  assertSessionDir(sessionDir);
  assertBoundedString(input.signature, "signature", MAX_CRASH_SIGNATURE_CHARS);
  if (input.kind !== undefined) {
    assertBoundedString(input.kind, "kind", MAX_CRASH_KIND_CHARS);
  }
  if (typeof input.stack !== "string" || input.stack.length === 0) {
    throw new TypeError("stack must be a non-empty string");
  }
  if (Buffer.byteLength(input.stack, "utf8") > MAX_CRASH_STACK_BYTES) {
    throw new RangeError(`stack exceeds ${MAX_CRASH_STACK_BYTES} byte size limit`);
  }
  if (
    input.step_index !== undefined &&
    (!Number.isSafeInteger(input.step_index) || input.step_index < 0)
  ) {
    throw new TypeError("step_index must be a non-negative safe integer");
  }
  if (!Array.isArray(input.repro_path)) throw new TypeError("repro_path must be an array");
  if (input.repro_path.length > MAX_REPRO_PATH_ENTRIES) {
    throw new RangeError(
      `repro_path exceeds ${MAX_REPRO_PATH_ENTRIES} entry limit`,
    );
  }
  for (const [index, step] of input.repro_path.entries()) {
    if (!Number.isSafeInteger(step) || step < 0) {
      throw new TypeError(`repro_path[${index}] must be a non-negative safe integer`);
    }
  }
  if (input.log_full_src !== undefined) {
    if (
      input.log_full_src.length === 0 ||
      input.log_full_src.length > MAX_SESSION_PATH_CHARS ||
      input.log_full_src.includes("\0") ||
      !path.isAbsolute(input.log_full_src)
    ) {
      throw new TypeError("log_full_src must be a bounded absolute path");
    }
  }
}

function assertSessionDir(sessionDir: string): void {
  if (
    typeof sessionDir !== "string" ||
    sessionDir.length === 0 ||
    sessionDir.length > MAX_SESSION_PATH_CHARS ||
    sessionDir.includes("\0")
  ) {
    throw new TypeError("session_dir is invalid or too long");
  }
}

function assertBoundedString(value: unknown, label: string, maxChars: number): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (value.length > maxChars) {
    throw new RangeError(`${label} exceeds ${maxChars} character limit`);
  }
}

/**
 * Serialize one session mutation across processes with atomic mkdir(2).
 * Unknown/stale locks are never removed automatically; callers receive a hard
 * timeout and must inspect the owner metadata before manual recovery.
 */
export async function withSessionLock<T>(
  sessionDir: string,
  operation: () => Promise<T>,
  options: SessionLockOptions = {},
): Promise<T> {
  assertSessionDir(sessionDir);
  const timeoutMs = options.timeoutMs ?? SESSION_LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? SESSION_LOCK_RETRY_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new TypeError("session lock timeoutMs must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(retryMs) || retryMs < 1) {
    throw new TypeError("session lock retryMs must be a positive safe integer");
  }

  const resolvedSessionDir = path.resolve(sessionDir);
  await assertSecureSessionLayout(resolvedSessionDir);
  const lock = await acquireSessionLock(resolvedSessionDir, timeoutMs, retryMs);
  try {
    return await operation();
  } finally {
    await releaseSessionLock(lock);
  }
}

async function assertSecureSessionLayout(sessionDir: string): Promise<void> {
  const directoryNames = ["steps", "crashes", "logs"];
  const fileNames = ["meta.json", "steps.jsonl", "crashes.jsonl"];
  const root = await lstat(sessionDir);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("session_dir must be a real directory");
  }
  for (const name of directoryNames) {
    const metadata = await lstat(path.join(sessionDir, name));
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`session ${name} must be a real directory`);
    }
  }
  for (const name of fileNames) {
    const metadata = await lstat(path.join(sessionDir, name));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error(`session ${name} must be a single-link regular file`);
    }
  }
}

async function acquireSessionLock(
  sessionDir: string,
  timeoutMs: number,
  retryMs: number,
): Promise<AcquiredSessionLock> {
  const lockDir = path.join(sessionDir, SESSION_LOCK_DIRNAME);
  const ownerPath = path.join(lockDir, SESSION_LOCK_OWNER_FILENAME);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      const token = randomUUID();
      try {
        await writeFile(
          ownerPath,
          JSON.stringify({ token, pid: process.pid, acquired_at: new Date().toISOString() }),
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        // The directory was ours, but an incomplete/altered owner file is now
        // ambiguous. Leave it in place for explicit inspection and recovery.
        throw new Error(
          `session lock owner initialization failed; lock left intact at ${lockDir}`,
          { cause: error },
        );
      }
      return { lockDir, ownerPath, token };
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for session lock; `
          + `lock was not removed automatically: ${lockDir}`,
        );
      }
      await delay(Math.min(retryMs, remainingMs));
    }
  }
}

async function releaseSessionLock(lock: AcquiredSessionLock): Promise<void> {
  let owner: unknown;
  try {
    owner = JSON.parse(await readFile(lock.ownerPath, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot verify session lock ownership; lock left intact at ${lock.lockDir}`,
      { cause: error },
    );
  }
  if (
    owner === null
    || typeof owner !== "object"
    || Array.isArray(owner)
    || (owner as Record<string, unknown>)["token"] !== lock.token
  ) {
    throw new Error(
      `session lock ownership changed; lock left intact at ${lock.lockDir}`,
    );
  }

  // Rename first so a newly acquired lock can never be removed by this owner.
  const releaseDir = `${lock.lockDir}.release-${lock.token}`;
  await rename(lock.lockDir, releaseDir);
  await unlink(path.join(releaseDir, SESSION_LOCK_OWNER_FILENAME));
  await rmdir(releaseDir);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

function isTerminalSessionStatus(status: unknown): status is TerminalSessionStatus {
  return status === "passed" || status === "failed" || status === "aborted";
}

function assertKnownSessionStatus(status: unknown): asserts status is SessionStatus {
  if (status !== "running" && !isTerminalSessionStatus(status)) {
    throw new Error("session metadata contains an invalid status");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function listSessions(workspaceRoot?: string): Promise<
  Array<{ id: string; dir: string; status: SessionStatus; started_at: string }>
> {
  const root = resolveWorkspaceRoot(workspaceRoot);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: Array<{ id: string; dir: string; status: SessionStatus; started_at: string }> = [];
  for (const name of entries) {
    const dir = path.join(root, name);
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) continue;
      const meta = await loadMeta(dir);
      out.push({ id: meta.id, dir, status: meta.status, started_at: meta.started_at });
    } catch {
      // skip unreadable
    }
  }
  out.sort((a, b) => b.started_at.localeCompare(a.started_at));
  return out;
}
