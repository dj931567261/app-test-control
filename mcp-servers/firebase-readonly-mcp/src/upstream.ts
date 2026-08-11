import { constants, type BigIntStats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { ProcessGroupStdioTransport } from "./process-group-transport.js";
import {
  UPSTREAM_FIREBASE_READ_TOOLS,
  sanitizeUpstreamToolResult,
  type UpstreamFirebaseToolName,
} from "./schemas.js";

export const FIREBASE_TOOLS_VERSION = "15.24.0";
export const FIREBASE_READONLY_PRELOAD_MARKER = "official-v1";
export const FIREBASE_READONLY_PACKAGE_ROOT_ENV =
  "APP_TEST_CTRL_FIREBASE_READONLY_PACKAGE_ROOT";
// Firebase CLI performs its first authenticated discovery lazily.  On a cold
// machine (or after an auth/token refresh) that handshake can legitimately
// take longer than ten seconds, which used to surface as a misleading
// `startup_list_tools` rejection even though the official MCP was healthy.
// Keep this bounded, but align the gateway's internal budget with the
// project-local MCP startup_timeout_sec=60 contract.
const STARTUP_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_FIREBASE_PACKAGE_MANIFEST_BYTES = 64 * 1024;
const MAX_FIREBASE_PROJECT_BINDING_BYTES = 64 * 1024;
const MAX_FIREBASE_CLI_AUTH_BYTES = 1024 * 1024;
const MAX_FIREBASE_LOGIN_ACCOUNTS = 16;
const MAX_FIREBASE_TOKEN_BYTES = 16 * 1024;
const MAX_FIREBASE_PRIVATE_LEASE_BYTES = 1024;
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const FIREBASE_PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;

export const FIREBASE_PRIVATE_ROOT_PREFIX = "app-test-ctrl-firebase-";
export const FIREBASE_PRIVATE_ROOT_LEASE_FILE = ".app-test-ctrl-owner.json";
export const FIREBASE_PRIVATE_ROOT_STALE_AFTER_MS = 5 * 60 * 1000;
export const FIREBASE_PRIVATE_ROOT_MAX_SCAN_ENTRIES = 4096;
export const FIREBASE_PRIVATE_ROOT_MAX_CANDIDATES = 32;
const FIREBASE_PRIVATE_ROOT_NAME_RE = /^app-test-ctrl-firebase-[A-Za-z0-9]{6}$/u;
const FIREBASE_PRIVATE_ROOT_LEASE_SCHEMA = "app-test-ctrl/firebase-private-root/v1";
const FIREBASE_PRIVATE_PROJECT_DIRECTORY = "project";
const MAX_POSIX_PID = 2_147_483_647;

export type FirebaseProjectSource = "service-account" | "firebaserc";

export interface FirebaseUpstream {
  callTool(name: UpstreamFirebaseToolName, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export const FIREBASE_UPSTREAM_FAILURE_STAGES = Object.freeze([
  "preflight",
  "startup_private_context",
  "startup_connect",
  "startup_list_tools",
  "startup_tool_contract",
  "tool_call",
  "identity_validation",
  "cleanup",
] as const);

export type FirebaseUpstreamFailureStage =
  (typeof FIREBASE_UPSTREAM_FAILURE_STAGES)[number];

const FIREBASE_UPSTREAM_FAILURE_STAGE_SET = new Set<unknown>(
  FIREBASE_UPSTREAM_FAILURE_STAGES,
);

export function isFirebaseUpstreamFailureStage(
  value: unknown,
): value is FirebaseUpstreamFailureStage {
  return FIREBASE_UPSTREAM_FAILURE_STAGE_SET.has(value);
}

/**
 * Carries only a fixed diagnostic stage across the private upstream boundary.
 * The original error is intentionally not retained: callers must never expose
 * credential paths, account data, provider payloads, or transport output.
 */
export class FirebaseUpstreamStageError extends Error {
  readonly stage: FirebaseUpstreamFailureStage;

  constructor(stage: FirebaseUpstreamFailureStage) {
    const safeStage = isFirebaseUpstreamFailureStage(stage) ? stage : "preflight";
    super(`official Firebase MCP failed at fixed stage: ${safeStage}`);
    this.name = "FirebaseUpstreamStageError";
    this.stage = safeStage;
  }
}

export class FirebaseUpstreamCleanupError extends FirebaseUpstreamStageError {
  constructor() {
    super("cleanup");
    this.name = "FirebaseUpstreamCleanupError";
  }
}

export interface FirebaseRuntimeOptions {
  projectRoot?: string;
  firebaseDir?: string;
  projectSource?: FirebaseProjectSource;
  firebaseProjectId?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
}

interface VerifiedRuntime {
  projectRoot: string;
  firebaseDir: string;
  projectSource: FirebaseProjectSource;
  firebaseProjectId: string;
  firebaseToolsPackageRoot: string;
  cliEntry: string;
  readonlyPreloadEntry: string;
  node: string;
  serviceAccountCredential?: VerifiedFileIdentity;
}

interface FirebaseProcessProfileLock {
  projectSource: FirebaseProjectSource;
  firebaseDir: string;
  firebaseProjectId: string;
  serviceAccountCredential?: VerifiedFileIdentity;
  firebaseCliAccountEmail?: string;
  projectNumber?: string;
}

const FIREBASE_PROCESS_PROFILE_LOCKS = new WeakMap<
  FirebaseRuntimeOptions,
  FirebaseProcessProfileLock
>();

export interface VerifiedFileIdentity {
  canonicalPath: string;
  metadata: BigIntStats;
}

function projectRootFromModule(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function requireSingleLinkRegularFile(metadata: BigIntStats, label: string): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw new Error(`${label} must be a canonical regular file with one link`);
  }
}

function readOnlyNoFollowFlags(): number {
  // O_NOFOLLOW is not consistently available on Windows. The before/after
  // canonical path and file-identity checks remain active on every platform.
  return constants.O_RDONLY
    | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
}

async function requireRegularCanonicalFile(
  candidate: string,
  label: string,
  validateMetadata: (metadata: BigIntStats) => void = () => undefined,
): Promise<string> {
  if (!path.isAbsolute(candidate) || candidate.includes("\0")) {
    throw new Error(`${label} must be an absolute path`);
  }
  const beforePath = await lstat(candidate, { bigint: true });
  requireSingleLinkRegularFile(beforePath, label);
  validateMetadata(beforePath);
  const canonical = await realpath(candidate);
  if (canonical !== candidate) {
    throw new Error(`${label} must be a canonical regular file`);
  }

  const handle = await open(candidate, readOnlyNoFollowFlags());
  try {
    const descriptor = await handle.stat({ bigint: true });
    const [afterPath, canonicalAfter] = await Promise.all([
      lstat(candidate, { bigint: true }),
      realpath(candidate),
    ]);
    requireSingleLinkRegularFile(descriptor, label);
    requireSingleLinkRegularFile(afterPath, label);
    validateMetadata(descriptor);
    validateMetadata(afterPath);
    if (
      canonicalAfter !== candidate
      || !sameFileIdentity(beforePath, descriptor)
      || !sameFileIdentity(descriptor, afterPath)
    ) {
      throw new Error(`${label} changed while it was being verified`);
    }
  } finally {
    await handle.close();
  }
  return canonical;
}

async function readBoundedCanonicalUtf8File(
  candidate: string,
  label: string,
  maximumBytes: number,
  validateMetadata: (metadata: BigIntStats) => void = () => undefined,
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("invalid bounded file-read limit");
  }
  if (!path.isAbsolute(candidate) || candidate.includes("\0")) {
    throw new Error(`${label} must be an absolute path`);
  }

  const beforePath = await lstat(candidate, { bigint: true });
  requireSingleLinkRegularFile(beforePath, label);
  validateMetadata(beforePath);
  const canonical = await realpath(candidate);
  if (canonical !== candidate) {
    throw new Error(`${label} must be a canonical regular file`);
  }

  const handle = await open(candidate, readOnlyNoFollowFlags());
  try {
    const beforeDescriptor = await handle.stat({ bigint: true });
    requireSingleLinkRegularFile(beforeDescriptor, label);
    validateMetadata(beforeDescriptor);
    if (!sameFileIdentity(beforePath, beforeDescriptor)) {
      throw new Error(`${label} changed before it could be read`);
    }
    if (beforeDescriptor.size > BigInt(maximumBytes)) {
      throw new Error(`${label} exceeded the byte limit`);
    }

    // Allocate one sentinel byte beyond the public limit so growth during the
    // read is rejected without ever asking fs.readFile to allocate unboundedly.
    const bytes = Buffer.allocUnsafe(maximumBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) {
      throw new Error(`${label} exceeded the byte limit`);
    }

    const afterDescriptor = await handle.stat({ bigint: true });
    const [afterPath, canonicalAfter] = await Promise.all([
      lstat(candidate, { bigint: true }),
      realpath(candidate),
    ]);
    requireSingleLinkRegularFile(afterDescriptor, label);
    requireSingleLinkRegularFile(afterPath, label);
    validateMetadata(afterDescriptor);
    validateMetadata(afterPath);
    if (
      canonicalAfter !== candidate
      || !sameFileIdentity(beforeDescriptor, afterDescriptor)
      || !sameFileIdentity(afterDescriptor, afterPath)
    ) {
      throw new Error(`${label} changed while it was being read`);
    }
    try {
      return FATAL_UTF8_DECODER.decode(bytes.subarray(0, offset));
    } catch {
      throw new Error(`${label} must contain valid UTF-8`);
    }
  } finally {
    await handle.close();
  }
}

interface FirebasePrivateRootLease {
  schema: typeof FIREBASE_PRIVATE_ROOT_LEASE_SCHEMA;
  pid: number;
  created_at_ms: number;
}

function parseFirebasePrivateRootLease(text: string): FirebasePrivateRootLease {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Firebase private root lease is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Firebase private root lease is invalid");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3
    || keys[0] !== "created_at_ms"
    || keys[1] !== "pid"
    || keys[2] !== "schema"
    || record.schema !== FIREBASE_PRIVATE_ROOT_LEASE_SCHEMA
    || !Number.isSafeInteger(record.pid)
    || Number(record.pid) < 1
    || Number(record.pid) > MAX_POSIX_PID
    || !Number.isSafeInteger(record.created_at_ms)
    || Number(record.created_at_ms) < 0
  ) {
    throw new Error("Firebase private root lease is invalid");
  }
  return {
    schema: FIREBASE_PRIVATE_ROOT_LEASE_SCHEMA,
    pid: Number(record.pid),
    created_at_ms: Number(record.created_at_ms),
  };
}

function isStrictPrivateRootDirectory(metadata: BigIntStats): boolean {
  if (process.platform === "win32" || typeof process.getuid !== "function") return false;
  return metadata.isDirectory()
    && !metadata.isSymbolicLink()
    && metadata.uid === BigInt(process.getuid())
    && (metadata.mode & 0o777n) === 0o700n;
}

function isStrictPrivateLeaseFile(metadata: BigIntStats): boolean {
  if (process.platform === "win32" || typeof process.getuid !== "function") return false;
  return metadata.isFile()
    && !metadata.isSymbolicLink()
    && metadata.nlink === 1n
    && metadata.uid === BigInt(process.getuid())
    && (metadata.mode & 0o777n) === 0o600n;
}

function processIsStillAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

async function writeFirebasePrivateRootLease(
  privateRoot: string,
  createdAtMs = Date.now(),
): Promise<void> {
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
    throw new Error("invalid Firebase private root lease timestamp");
  }
  const lease: FirebasePrivateRootLease = {
    schema: FIREBASE_PRIVATE_ROOT_LEASE_SCHEMA,
    pid: process.pid,
    created_at_ms: createdAtMs,
  };
  const leasePath = path.join(privateRoot, FIREBASE_PRIVATE_ROOT_LEASE_FILE);
  await writeFile(leasePath, `${JSON.stringify(lease)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(leasePath, 0o600);
}

/**
 * Removes only old, dead, verifiably managed private roots. Ambiguous entries
 * are deliberately retained: cleanup must never turn a broad tmp prefix into
 * authority to delete an unrelated directory. Windows is skipped because the
 * required POSIX owner/mode proof is unavailable there.
 */
export async function sweepStaleOfficialFirebasePrivateRoots(
  tempRoot: string,
  nowMs = Date.now(),
  limits: { maxScanEntries?: number; maxCandidates?: number } = {},
): Promise<number> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("invalid Firebase private root sweep timestamp");
  }
  if (process.platform === "win32" || typeof process.getuid !== "function") return 0;
  const maxScanEntries = Math.min(
    limits.maxScanEntries ?? FIREBASE_PRIVATE_ROOT_MAX_SCAN_ENTRIES,
    FIREBASE_PRIVATE_ROOT_MAX_SCAN_ENTRIES,
  );
  const maxCandidates = Math.min(
    limits.maxCandidates ?? FIREBASE_PRIVATE_ROOT_MAX_CANDIDATES,
    FIREBASE_PRIVATE_ROOT_MAX_CANDIDATES,
  );
  if (
    !Number.isSafeInteger(maxScanEntries)
    || maxScanEntries < 1
    || !Number.isSafeInteger(maxCandidates)
    || maxCandidates < 1
  ) {
    throw new Error("invalid Firebase private root sweep limits");
  }
  if (!path.isAbsolute(tempRoot) || tempRoot.includes("\0")) {
    throw new Error("Firebase private root sweep requires an absolute temp directory");
  }
  const canonicalTempRoot = await realpath(tempRoot);
  if (!(await stat(canonicalTempRoot)).isDirectory()) {
    throw new Error("Firebase private root sweep temp path is not a directory");
  }

  let removed = 0;
  let scannedEntries = 0;
  let managedCandidates = 0;
  // opendir keeps memory bounded even when a shared /tmp contains a very large
  // number of unrelated entries. Reaching either cap stops cleanup safely; it
  // never broadens the deletion predicate or turns truncation into an error.
  for await (const entry of await opendir(canonicalTempRoot)) {
    if (scannedEntries >= maxScanEntries) break;
    scannedEntries += 1;
    if (!FIREBASE_PRIVATE_ROOT_NAME_RE.test(entry.name)) continue;
    if (!entry.isDirectory()) continue;
    const candidate = path.join(canonicalTempRoot, entry.name);
    const leasePath = path.join(candidate, FIREBASE_PRIVATE_ROOT_LEASE_FILE);
    let removalAuthorized = false;
    try {
      const directoryBefore = await lstat(candidate, { bigint: true });
      // Entries owned by another user or without the exact managed mode do not
      // consume the candidate budget, preventing cross-user /tmp clutter from
      // crowding out this user's own stale roots.
      if (!isStrictPrivateRootDirectory(directoryBefore)) continue;
      if (managedCandidates >= maxCandidates) break;
      managedCandidates += 1;
      const [leaseBefore, canonicalCandidate] = await Promise.all([
        lstat(leasePath, { bigint: true }),
        realpath(candidate),
      ]);
      if (
        canonicalCandidate !== candidate
        || !isStrictPrivateLeaseFile(leaseBefore)
      ) {
        continue;
      }
      const lease = parseFirebasePrivateRootLease(await readBoundedCanonicalUtf8File(
        leasePath,
        "Firebase private root lease",
        MAX_FIREBASE_PRIVATE_LEASE_BYTES,
        (metadata) => {
          if (!isStrictPrivateLeaseFile(metadata)) {
            throw new Error("Firebase private root lease is not private");
          }
        },
      ));
      const cutoff = nowMs - FIREBASE_PRIVATE_ROOT_STALE_AFTER_MS;
      if (
        cutoff < 0
        || lease.created_at_ms > cutoff
        || Number(directoryBefore.mtimeMs) > cutoff
        || Number(leaseBefore.mtimeMs) > cutoff
        || processIsStillAlive(lease.pid)
      ) {
        continue;
      }

      const [directoryAfter, leaseAfter, canonicalAfter] = await Promise.all([
        lstat(candidate, { bigint: true }),
        lstat(leasePath, { bigint: true }),
        realpath(candidate),
      ]);
      if (
        canonicalAfter !== candidate
        || !isStrictPrivateRootDirectory(directoryAfter)
        || !isStrictPrivateLeaseFile(leaseAfter)
        || !sameFileIdentity(directoryBefore, directoryAfter)
        || !sameFileIdentity(leaseBefore, leaseAfter)
      ) {
        continue;
      }
      removalAuthorized = true;
      await rm(candidate, { recursive: true, force: false });
      removed += 1;
    } catch (error) {
      // Invalid, raced, or otherwise unverifiable entries are not ours to
      // delete. Once every proof passed, however, a failed removal is surfaced
      // and poisons startup rather than silently leaving a known credential root.
      if (!removalAuthorized || (error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw new FirebaseUpstreamCleanupError();
    }
  }
  return removed;
}

function parseProjectId(value: unknown, label: string): string {
  if (typeof value !== "string" || !FIREBASE_PROJECT_ID_RE.test(value)) {
    throw new Error(`${label} does not contain a valid Firebase project id`);
  }
  return value;
}

function requireCurrentUserPrivateFile(metadata: BigIntStats, label: string): void {
  if (process.platform === "win32") return;
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  if (currentUid === null || metadata.uid !== currentUid) {
    throw new Error(`${label} must belong to the current user`);
  }
  if ((metadata.mode & 0o077n) !== 0n) {
    throw new Error(`${label} must not be accessible by group or other`);
  }
}

function requireCurrentUserIntegrityFile(metadata: BigIntStats, label: string): void {
  if (process.platform === "win32") return;
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  if (currentUid === null || metadata.uid !== currentUid) {
    throw new Error(`${label} must belong to the current user`);
  }
  if ((metadata.mode & 0o022n) !== 0n) {
    throw new Error(`${label} must not be writable by group or other`);
  }
}

async function verifyServiceAccountCredential(
  env: NodeJS.ProcessEnv,
): Promise<VerifiedFileIdentity> {
  const credentialPath = inheritedValue(env, "GOOGLE_APPLICATION_CREDENTIALS");
  if (!credentialPath || !path.isAbsolute(credentialPath) || credentialPath.length > 4096) {
    throw new Error(
      "service-account project source requires an absolute GOOGLE_APPLICATION_CREDENTIALS path",
    );
  }
  try {
    const beforePath = await lstat(credentialPath, { bigint: true });
    requireSingleLinkRegularFile(beforePath, "service account credential file");
    requireCurrentUserPrivateFile(beforePath, "service account credential file");
    const canonical = await realpath(credentialPath);
    if (canonical !== credentialPath) {
      throw new Error("service account credential file must use its canonical path");
    }
    const handle = await open(credentialPath, readOnlyNoFollowFlags());
    let descriptor: BigIntStats;
    try {
      descriptor = await handle.stat({ bigint: true });
    } finally {
      await handle.close();
    }
    const [afterPath, canonicalAfter] = await Promise.all([
      lstat(credentialPath, { bigint: true }),
      realpath(credentialPath),
    ]);
    requireSingleLinkRegularFile(descriptor, "service account credential file");
    requireSingleLinkRegularFile(afterPath, "service account credential file");
    requireCurrentUserPrivateFile(descriptor, "service account credential file");
    requireCurrentUserPrivateFile(afterPath, "service account credential file");
    if (
      canonicalAfter !== credentialPath
      || !sameFileIdentity(beforePath, descriptor)
      || !sameFileIdentity(descriptor, afterPath)
    ) {
      throw new Error("service account credential file changed while it was being verified");
    }
    if (descriptor.size < 1n || descriptor.size > BigInt(MAX_FIREBASE_PROJECT_BINDING_BYTES)) {
      throw new Error("service account credential file has an invalid size");
    }
    return { canonicalPath: canonical, metadata: descriptor };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("service account credential file")) {
      throw error;
    }
    throw new Error("service account credential file is invalid or unreadable");
  }
}

async function projectIdFromFirebaserc(firebaseDir: string): Promise<string> {
  try {
    const text = await readBoundedCanonicalUtf8File(
      path.join(firebaseDir, ".firebaserc"),
      ".firebaserc",
      MAX_FIREBASE_PROJECT_BINDING_BYTES,
      (metadata) => requireCurrentUserIntegrityFile(metadata, ".firebaserc"),
    );
    const parsed = JSON.parse(text) as { projects?: { default?: unknown } };
    return parseProjectId(parsed?.projects?.default, ".firebaserc");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(".firebaserc")) throw error;
    throw new Error(".firebaserc is invalid or unreadable");
  }
}

async function assertExplicitProjectIsNotAliased(
  firebaseDir: string,
  firebaseProjectId: string,
): Promise<void> {
  const rcPath = path.join(firebaseDir, ".firebaserc");
  let text: string;
  try {
    text = await readBoundedCanonicalUtf8File(
      rcPath,
      ".firebaserc",
      MAX_FIREBASE_PROJECT_BINDING_BYTES,
      (metadata) => requireCurrentUserIntegrityFile(metadata, ".firebaserc"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(".firebaserc is invalid or unreadable");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(".firebaserc is invalid or unreadable");
  }
  const projects = (parsed as { projects?: unknown }).projects;
  if (projects === undefined) return;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) {
    throw new Error(".firebaserc projects must be an object");
  }
  const remapped = (projects as Record<string, unknown>)[firebaseProjectId];
  if (remapped !== undefined && remapped !== firebaseProjectId) {
    throw new Error(".firebaserc would remap the explicit Firebase project id");
  }
}

export async function verifyFirebaseRuntime(
  options: FirebaseRuntimeOptions = {},
): Promise<VerifiedRuntime> {
  if (options.projectSource !== "service-account" && options.projectSource !== "firebaserc") {
    throw new Error(
      "an explicit Firebase connection profile is required before remote access",
    );
  }
  if (options.firebaseDir === undefined) {
    throw new Error("an explicit Firebase connection profile requires --dir");
  }
  const projectRoot = await realpath(options.projectRoot ?? projectRootFromModule());
  if (!(await stat(projectRoot)).isDirectory()) throw new Error("project root must be a directory");

  const packageRoot = path.join(projectRoot, "node_modules", "firebase-tools");
  const packageMetadata = await lstat(packageRoot);
  if (!packageMetadata.isDirectory() || packageMetadata.isSymbolicLink()) {
    throw new Error("the pinned project-local firebase-tools package is unavailable");
  }
  if (await realpath(packageRoot) !== packageRoot) {
    throw new Error("the pinned project-local firebase-tools package is not canonical");
  }
  const packageJsonPath = path.join(packageRoot, "package.json");
  const manifestText = await readBoundedCanonicalUtf8File(
    packageJsonPath,
    "firebase-tools package manifest",
    MAX_FIREBASE_PACKAGE_MANIFEST_BYTES,
  );
  const manifest = JSON.parse(manifestText) as { version?: unknown };
  if (manifest.version !== FIREBASE_TOOLS_VERSION) {
    throw new Error(`firebase-tools must be exactly ${FIREBASE_TOOLS_VERSION}`);
  }
  const cliEntry = await requireRegularCanonicalFile(
    path.join(packageRoot, "lib", "bin", "firebase.js"),
    "firebase-tools CLI entry",
  );
  if (!cliEntry.startsWith(`${packageRoot}${path.sep}`)) {
    throw new Error("firebase-tools CLI entry escaped its package root");
  }
  const expectedReadonlyPreloadEntry = path.join(
    projectRoot,
    "mcp-servers",
    "firebase-readonly-mcp",
    "dist",
    "readonly-preload.js",
  );
  const readonlyPreloadEntry = await requireRegularCanonicalFile(
    expectedReadonlyPreloadEntry,
    "Firebase read-only preload entry",
    (metadata) => requireCurrentUserIntegrityFile(
      metadata,
      "Firebase read-only preload entry",
    ),
  );
  if (
    readonlyPreloadEntry !== expectedReadonlyPreloadEntry
    || !readonlyPreloadEntry.startsWith(`${projectRoot}${path.sep}`)
  ) {
    throw new Error("Firebase read-only preload entry escaped the project root");
  }
  const node = await requireRegularCanonicalFile(
    await realpath(options.execPath ?? process.execPath),
    "Node executable",
  );

  if (
    !path.isAbsolute(options.firebaseDir)
    || options.firebaseDir.includes("\0")
    || options.firebaseDir.length > 4096
  ) {
    throw new Error("--dir must be an absolute directory without NUL");
  }
  const firebaseDir = await realpath(options.firebaseDir);
  if (!(await stat(firebaseDir)).isDirectory()) throw new Error("--dir must identify a directory");

  let firebaseProjectId: string;
  let serviceAccountCredential: VerifiedFileIdentity | undefined;
  if (options.projectSource === "service-account") {
    firebaseProjectId = parseProjectId(
      options.firebaseProjectId,
      "explicit service-account binding",
    );
    // An existing App project's .firebaserc is only inspected at startup for
    // alias contradictions.  The private upstream context still receives the
    // explicit project id and never receives the real rc file.
    await assertExplicitProjectIsNotAliased(firebaseDir, firebaseProjectId);
    serviceAccountCredential = await verifyServiceAccountCredential(options.env ?? process.env);
  } else {
    if (options.firebaseProjectId !== undefined) {
      throw new Error("firebaserc project source must not supply an explicit project id");
    }
    firebaseProjectId = await projectIdFromFirebaserc(firebaseDir);
    // Refuse an internally contradictory binding before sealing the literal
    // project id. The real rc file is never passed to the upstream process.
    await assertExplicitProjectIsNotAliased(firebaseDir, firebaseProjectId);
  }
  return {
    projectRoot,
    firebaseDir,
    projectSource: options.projectSource,
    firebaseProjectId,
    firebaseToolsPackageRoot: packageRoot,
    cliEntry,
    readonlyPreloadEntry,
    node,
    serviceAccountCredential,
  };
}

/** @internal Exported only so the process-lifetime fail-closed rule is testable. */
export function lockVerifiedRuntimeForProcess(
  options: FirebaseRuntimeOptions,
  runtime: VerifiedRuntime,
): FirebaseProcessProfileLock {
  const existing = FIREBASE_PROCESS_PROFILE_LOCKS.get(options);
  if (!existing) {
    const created: FirebaseProcessProfileLock = {
      projectSource: runtime.projectSource,
      firebaseDir: runtime.firebaseDir,
      firebaseProjectId: runtime.firebaseProjectId,
      serviceAccountCredential: runtime.serviceAccountCredential,
    };
    FIREBASE_PROCESS_PROFILE_LOCKS.set(options, created);
    return created;
  }
  if (
    existing.projectSource !== runtime.projectSource
    || existing.firebaseDir !== runtime.firebaseDir
    || existing.firebaseProjectId !== runtime.firebaseProjectId
    || Boolean(existing.serviceAccountCredential) !== Boolean(runtime.serviceAccountCredential)
    || (
      existing.serviceAccountCredential !== undefined
      && runtime.serviceAccountCredential !== undefined
      && (
        existing.serviceAccountCredential.canonicalPath
          !== runtime.serviceAccountCredential.canonicalPath
        || !sameFileIdentity(
          existing.serviceAccountCredential.metadata,
          runtime.serviceAccountCredential.metadata,
        )
      )
    )
  ) {
    throw new Error("Firebase connection profile changed during the gateway process");
  }
  return existing;
}

export async function preparePrivateFirebaseProjectDirectory(
  privateRoot: string,
): Promise<string> {
  const canonicalRoot = await realpath(privateRoot);
  const rootMetadata = await lstat(canonicalRoot, { bigint: true });
  if (
    !rootMetadata.isDirectory()
    || rootMetadata.isSymbolicLink()
    || (process.platform !== "win32" && !isStrictPrivateRootDirectory(rootMetadata))
  ) {
    throw new Error("Firebase private root is not a strict managed directory");
  }
  const privateProjectDir = path.join(canonicalRoot, FIREBASE_PRIVATE_PROJECT_DIRECTORY);
  await mkdir(privateProjectDir, { mode: 0o700 });
  await chmod(privateProjectDir, 0o700);
  const configPath = path.join(privateProjectDir, "firebase.json");
  await writeFile(configPath, "{}\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(configPath, 0o400);
  // A controlled firebase.json pins firebase-tools' detectProjectRoot() here;
  // it can no longer walk into the real App directory or an ancestor and load
  // a mutable .firebaserc after gateway verification.
  return realpath(privateProjectDir);
}

function requireIsolatedProjectDirectory(
  runtime: VerifiedRuntime,
  privateProjectDir: string,
): string {
  if (
    !path.isAbsolute(privateProjectDir)
    || privateProjectDir.includes("\0")
    || path.normalize(privateProjectDir) !== privateProjectDir
    || privateProjectDir === runtime.firebaseDir
  ) {
    throw new Error("an isolated Firebase upstream project directory is required");
  }
  return privateProjectDir;
}

export function buildOfficialFirebaseCliArgs(
  runtime: VerifiedRuntime,
  privateProjectDir: string,
): string[] {
  const upstreamProjectDir = requireIsolatedProjectDirectory(runtime, privateProjectDir);
  const args = [
    "--import",
    runtime.readonlyPreloadEntry,
    runtime.cliEntry,
    "mcp",
    "--only",
    "crashlytics",
  ];
  args.push("--dir", upstreamProjectDir);
  return args;
}

function originalConfigHome(env: NodeJS.ProcessEnv): string {
  const configured = env.XDG_CONFIG_HOME;
  if (configured !== undefined) {
    if (configured && path.isAbsolute(configured) && !configured.includes("\0")) {
      return path.normalize(configured);
    }
    throw new Error("Firebase CLI authentication config home is invalid");
  }
  const home = process.platform === "win32"
    ? env.USERPROFILE ?? env.HOME
    : env.HOME;
  if (home && path.isAbsolute(home) && !home.includes("\0")) {
    return path.join(path.normalize(home), ".config");
  }
  throw new Error("Firebase CLI authentication home is unavailable");
}

function inheritedValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value.length === 0) return undefined;
  if (value.includes("\0")) throw new Error(`unsafe inherited environment variable: ${name}`);
  return value;
}

function safePrivateScalar(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || Buffer.byteLength(value, "utf8") > MAX_FIREBASE_TOKEN_BYTES
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

interface FirebaseCliAccount {
  user: { email: string };
  tokens: Record<string, string | number | string[]>;
}

function parseFirebaseCliAccount(user: unknown, tokens: unknown): FirebaseCliAccount {
  if (!user || typeof user !== "object" || Array.isArray(user)) {
    throw new Error("Firebase CLI login account is invalid");
  }
  const email = (user as { email?: unknown }).email;
  if (
    typeof email !== "string"
    || email.length > 320
    || !/^[^\s@]+@[^\s@]+$/u.test(email)
    || /[\u0000-\u001f\u007f]/u.test(email)
  ) {
    throw new Error("Firebase CLI login account is invalid");
  }
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    throw new Error("Firebase CLI login tokens are invalid");
  }
  const source = tokens as Record<string, unknown>;
  const sanitized: Record<string, string | number | string[]> = {
    refresh_token: safePrivateScalar(
      source.refresh_token,
      "Firebase CLI refresh token",
    ),
  };
  for (const name of ["access_token", "id_token", "token_type"] as const) {
    if (source[name] !== undefined) {
      sanitized[name] = safePrivateScalar(
        source[name],
        `Firebase CLI ${name}`,
      );
    }
  }
  if (source.expires_at !== undefined) {
    if (!Number.isSafeInteger(source.expires_at) || Number(source.expires_at) < 0) {
      throw new Error("Firebase CLI token expiry is invalid");
    }
    sanitized.expires_at = Number(source.expires_at);
  }
  if (source.scopes !== undefined) {
    if (
      !Array.isArray(source.scopes)
      || source.scopes.length > 64
      || source.scopes.some((scope) => (
        typeof scope !== "string"
        || scope.length < 1
        || scope.length > 512
        || /[\u0000-\u001f\u007f]/u.test(scope)
      ))
    ) {
      throw new Error("Firebase CLI token scopes are invalid");
    }
    sanitized.scopes = [...source.scopes] as string[];
  }
  return { user: { email }, tokens: sanitized };
}

function selectFirebaseCliAccount(
  config: unknown,
  firebaseDir: string,
): FirebaseCliAccount {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Firebase CLI authentication store is invalid");
  }
  const record = config as Record<string, unknown>;
  const accounts: FirebaseCliAccount[] = [];
  const hasDefaultUser = record.user !== undefined;
  const hasDefaultTokens = record.tokens !== undefined;
  if (hasDefaultUser !== hasDefaultTokens) {
    throw new Error("Firebase CLI default account is incomplete");
  }
  if (hasDefaultUser) {
    accounts.push(parseFirebaseCliAccount(record.user, record.tokens));
  }
  if (record.additionalAccounts !== undefined) {
    if (!Array.isArray(record.additionalAccounts)) {
      throw new Error("Firebase CLI account list is invalid");
    }
    if (
      record.additionalAccounts.length
        > MAX_FIREBASE_LOGIN_ACCOUNTS - (hasDefaultUser ? 1 : 0)
    ) {
      throw new Error("Firebase CLI account list exceeded the limit");
    }
    for (const candidate of record.additionalAccounts) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("Firebase CLI additional account is invalid");
      }
      accounts.push(parseFirebaseCliAccount(
        (candidate as Record<string, unknown>).user,
        (candidate as Record<string, unknown>).tokens,
      ));
    }
  }
  const byEmail = new Map<string, FirebaseCliAccount>();
  for (const account of accounts) {
    if (byEmail.has(account.user.email)) {
      throw new Error("Firebase CLI account list contains duplicate identities");
    }
    byEmail.set(account.user.email, account);
  }
  const activeAccounts = record.activeAccounts;
  let selectedEmail: string | undefined;
  if (activeAccounts !== undefined) {
    if (!activeAccounts || typeof activeAccounts !== "object" || Array.isArray(activeAccounts)) {
      throw new Error("Firebase CLI active account map is invalid");
    }
    const selected = (activeAccounts as Record<string, unknown>)[firebaseDir];
    if (selected !== undefined) {
      if (typeof selected !== "string" || selected.length > 320) {
        throw new Error("Firebase CLI active account is invalid");
      }
      selectedEmail = selected;
    }
  }
  if (selectedEmail === undefined) {
    // A directory-less fallback is unambiguous only when the login store has
    // exactly one usable account. Multi-account stores must explicitly bind the
    // canonical App directory through activeAccounts.
    if (accounts.length !== 1) {
      throw new Error("Firebase CLI active account binding is required");
    }
    return accounts[0]!;
  }
  const selected = byEmail.get(selectedEmail);
  if (!selected) throw new Error("Firebase CLI selected account is unavailable");
  return selected;
}

async function writePrivateFirebaseConfig(
  configHome: string,
  config: Record<string, unknown>,
): Promise<void> {
  const configstoreDir = path.join(configHome, "configstore");
  await mkdir(configstoreDir, { recursive: true, mode: 0o700 });
  await chmod(configstoreDir, 0o700);
  const configPath = path.join(configstoreDir, "firebase-tools.json");
  await writeFile(
    configPath,
    `${JSON.stringify(config)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  await chmod(configPath, 0o600);
}

export async function writePrivateFirebaseCliProfile(
  sourceConfigHome: string,
  privateConfigHome: string,
  accountScopeDir: string,
  privateProjectDir: string,
  firebaseProjectId: string,
  expectedAccountEmail?: string,
): Promise<string> {
  let text: string;
  try {
    text = await readBoundedCanonicalUtf8File(
      path.join(sourceConfigHome, "configstore", "firebase-tools.json"),
      "Firebase CLI authentication store",
      MAX_FIREBASE_CLI_AUTH_BYTES,
      (metadata) => requireCurrentUserPrivateFile(
        metadata,
        "Firebase CLI authentication store",
      ),
    );
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith("Firebase CLI authentication store")
    ) {
      throw error;
    }
    throw new Error("Firebase CLI authentication store is invalid or unavailable");
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error("Firebase CLI authentication store is invalid or unavailable");
  }
  const account = selectFirebaseCliAccount(config, accountScopeDir);
  if (expectedAccountEmail !== undefined && account.user.email !== expectedAccountEmail) {
    throw new Error("Firebase CLI selected account changed during the gateway process");
  }
  await writePrivateFirebaseConfig(privateConfigHome, {
    user: account.user,
    tokens: account.tokens,
    activeProjects: { [privateProjectDir]: firebaseProjectId },
  });
  return account.user.email;
}

export async function copyPrivateServiceAccountCredential(
  verified: VerifiedFileIdentity,
  privateRoot: string,
): Promise<string> {
  const credentialDir = path.join(privateRoot, "credentials");
  await mkdir(credentialDir, { mode: 0o700 });
  await chmod(credentialDir, 0o700);
  const destination = path.join(credentialDir, "service-account.json");
  const handle = await open(verified.canonicalPath, readOnlyNoFollowFlags());
  const bytes = Buffer.allocUnsafe(MAX_FIREBASE_PROJECT_BINDING_BYTES + 1);
  let offset = 0;
  try {
    const beforeDescriptor = await handle.stat({ bigint: true });
    requireSingleLinkRegularFile(beforeDescriptor, "service account credential file");
    requireCurrentUserPrivateFile(beforeDescriptor, "service account credential file");
    if (
      !sameFileIdentity(verified.metadata, beforeDescriptor)
      || beforeDescriptor.size < 1n
      || beforeDescriptor.size > BigInt(MAX_FIREBASE_PROJECT_BINDING_BYTES)
    ) {
      throw new Error("service account credential file changed before private copy");
    }
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_FIREBASE_PROJECT_BINDING_BYTES) {
      throw new Error("service account credential file exceeded the byte limit");
    }
    const afterDescriptor = await handle.stat({ bigint: true });
    const [afterPath, canonicalAfter] = await Promise.all([
      lstat(verified.canonicalPath, { bigint: true }),
      realpath(verified.canonicalPath),
    ]);
    requireSingleLinkRegularFile(afterDescriptor, "service account credential file");
    requireSingleLinkRegularFile(afterPath, "service account credential file");
    requireCurrentUserPrivateFile(afterDescriptor, "service account credential file");
    requireCurrentUserPrivateFile(afterPath, "service account credential file");
    if (
      canonicalAfter !== verified.canonicalPath
      || !sameFileIdentity(beforeDescriptor, afterDescriptor)
      || !sameFileIdentity(afterDescriptor, afterPath)
      || !sameFileIdentity(verified.metadata, afterDescriptor)
    ) {
      throw new Error("service account credential file changed during private copy");
    }
    await writeFile(destination, bytes.subarray(0, offset), {
      flag: "wx",
      mode: 0o600,
    });
    await chmod(destination, 0o600);
  } finally {
    bytes.fill(0);
    await handle.close();
  }
  const copied = await lstat(destination, { bigint: true });
  requireSingleLinkRegularFile(copied, "private service account credential file");
  requireCurrentUserPrivateFile(copied, "private service account credential file");
  if (copied.size !== BigInt(offset)) {
    throw new Error("private service account credential copy is incomplete");
  }
  return destination;
}

export function buildFirebaseUpstreamEnvironment(
  env: NodeJS.ProcessEnv,
  home: string,
  temp: string,
  projectSource: FirebaseProjectSource,
  firebaseToolsPackageRoot: string,
  privateServiceAccountCredential?: string,
): Record<string, string> {
  if (
    !path.isAbsolute(firebaseToolsPackageRoot)
    || firebaseToolsPackageRoot.includes("\0")
    || path.normalize(firebaseToolsPackageRoot) !== firebaseToolsPackageRoot
  ) {
    throw new Error("canonical Firebase Tools package root is required");
  }
  const result: Record<string, string> = {
    HOME: home,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    // Both profiles use a private configstore. The service-account profile
    // stores only the explicit project binding; firebaserc stores one selected
    // login account plus that same exact binding. Host activeProjects never
    // reaches the child.
    XDG_CONFIG_HOME: path.join(home, ".config"),
    // 两种 Profile 都不能静默回退到宿主计算元数据身份：服务账号只用显式文件，
    // firebaserc 只用用户选择的 Firebase CLI 登录态。
    METADATA_SERVER_DETECTION: "none",
    NO_UPDATE_NOTIFIER: "1",
    TERM: "dumb",
    // 固定值由网关生成，绝不继承宿主同名变量。preload 缺少此标记会
    // fail-closed，避免被脱离受管启动链路单独复用。
    APP_TEST_CTRL_FIREBASE_READONLY_PRELOAD: FIREBASE_READONLY_PRELOAD_MARKER,
    // preload 只从这个已验证的精确 package root 相对加载官方内部模块，
    // 禁止 Node bare resolution 误命中嵌套或宿主注入的同版本副本。
    [FIREBASE_READONLY_PACKAGE_ROOT_ENV]: firebaseToolsPackageRoot,
  };
  for (const name of [
    "PATH",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]) {
    const value = inheritedValue(env, name);
    if (value !== undefined) result[name] = value;
  }
  if (projectSource === "service-account") {
    if (
      !privateServiceAccountCredential
      || !path.isAbsolute(privateServiceAccountCredential)
      || privateServiceAccountCredential.includes("\0")
    ) {
      throw new Error("private service account credential copy is required");
    }
    result.GOOGLE_APPLICATION_CREDENTIALS = privateServiceAccountCredential;
  } else if (privateServiceAccountCredential !== undefined) {
    throw new Error("firebaserc profile must not receive a service account credential");
  }
  return result;
}

export function buildOfficialFirebaseSpawnOptions(
  runtime: VerifiedRuntime,
  env: NodeJS.ProcessEnv,
  home: string,
  temp: string,
  privateProjectDir: string,
  privateServiceAccountCredential?: string,
): {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
} {
  const upstreamProjectDir = requireIsolatedProjectDirectory(runtime, privateProjectDir);
  return {
    command: runtime.node,
    args: buildOfficialFirebaseCliArgs(runtime, upstreamProjectDir),
    // cwd、--dir 和私有 activeProjects 只指向受控 project 目录。真实 App
    // 目录仅用于启动前选择 Profile，绝不暴露给固定版 firebase-tools 重读。
    cwd: upstreamProjectDir,
    env: buildFirebaseUpstreamEnvironment(
      env,
      home,
      temp,
      runtime.projectSource,
      runtime.firebaseToolsPackageRoot,
      privateServiceAccountCredential,
    ),
  };
}

export async function writePrivateProjectBinding(
  configHome: string,
  firebaseDir: string,
  firebaseProjectId: string,
): Promise<void> {
  await writePrivateFirebaseConfig(configHome, {
    activeProjects: { [firebaseDir]: firebaseProjectId },
  });
}

interface LockedFirebaseProjectIdentity {
  projectId: string;
  projectNumber: string;
}

function validateLockedFirebaseProjectResult(
  value: unknown,
  expectedProjectId: string,
): LockedFirebaseProjectIdentity {
  // Reuse the public response boundary before consuming structuredContent for
  // security decisions. Identity is never inferred from provider-rendered YAML.
  sanitizeUpstreamToolResult(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("official Firebase project identity response is invalid");
  }
  const structured = (value as { structuredContent?: unknown }).structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
    throw new Error("official Firebase project identity response is invalid");
  }
  const projectId = (structured as Record<string, unknown>).projectId;
  const projectNumber = (structured as Record<string, unknown>).projectNumber;
  if (
    projectId !== expectedProjectId
    || typeof projectNumber !== "string"
    || !/^[1-9][0-9]{0,19}$/u.test(projectNumber)
  ) {
    throw new Error("official Firebase project identity did not match the locked project");
  }
  return { projectId, projectNumber };
}

function projectNumberFromFirebaseAppId(appId: unknown): string {
  if (typeof appId !== "string") {
    throw new Error("Crashlytics request is missing a Firebase App ID");
  }
  const match = /^1:([1-9][0-9]{0,19}):(android|ios|web):([A-Fa-f0-9]{6,128})$/u.exec(appId);
  if (!match) throw new Error("Crashlytics Firebase App ID is not canonical");
  return match[1]!;
}

function validateCrashlyticsProjectScope(
  name: UpstreamFirebaseToolName,
  args: Record<string, unknown>,
  identity: LockedFirebaseProjectIdentity,
): void {
  if (!name.startsWith("crashlytics_")) return;
  const appId = args.appId;
  if (projectNumberFromFirebaseAppId(appId) !== identity.projectNumber) {
    throw new Error("Crashlytics Firebase App ID escaped the locked project");
  }
  if (name !== "crashlytics_batch_get_events") return;
  if (!Array.isArray(args.names) || typeof appId !== "string") {
    throw new Error("Crashlytics event resource scope is invalid");
  }
  const expectedPrefix = `projects/${identity.projectNumber}/apps/${appId}/events/`;
  for (const eventName of args.names) {
    if (
      typeof eventName !== "string"
      || !eventName.startsWith(expectedPrefix)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(eventName.slice(expectedPrefix.length))
    ) {
      throw new Error("Crashlytics event resource escaped the locked app");
    }
  }
}

export function createProjectLockedFirebaseToolCaller(
  callUpstream: (
    name: UpstreamFirebaseToolName,
    args: Record<string, unknown>,
  ) => Promise<unknown>,
  expectedProjectId: string,
  processIdentityLock: { projectNumber?: string } = {},
): (
  name: UpstreamFirebaseToolName,
  args: Record<string, unknown>,
) => Promise<unknown> {
  let sessionIdentity: LockedFirebaseProjectIdentity | undefined;
  let identityPromise: Promise<LockedFirebaseProjectIdentity> | undefined;

  const acceptIdentity = (value: unknown): LockedFirebaseProjectIdentity => {
    try {
      const identity = validateLockedFirebaseProjectResult(value, expectedProjectId);
      if (
        sessionIdentity
        && (
          sessionIdentity.projectId !== identity.projectId
          || sessionIdentity.projectNumber !== identity.projectNumber
        )
      ) {
        throw new Error("official Firebase project identity changed during the session");
      }
      if (
        processIdentityLock.projectNumber !== undefined
        && processIdentityLock.projectNumber !== identity.projectNumber
      ) {
        throw new Error("official Firebase project identity changed during the gateway process");
      }
      processIdentityLock.projectNumber ??= identity.projectNumber;
      sessionIdentity = identity;
      return identity;
    } catch (error) {
      if (error instanceof FirebaseUpstreamStageError) throw error;
      throw new FirebaseUpstreamStageError("identity_validation");
    }
  };

  const ensureIdentity = (): Promise<LockedFirebaseProjectIdentity> => {
    if (sessionIdentity) return Promise.resolve(sessionIdentity);
    identityPromise ??= callUpstream("firebase_get_project", {})
      .then(acceptIdentity)
      .catch((error) => {
        identityPromise = undefined;
        throw error;
      });
    return identityPromise;
  };

  return async (name, args) => {
    if (name === "firebase_get_project") {
      const result = await callUpstream(name, args);
      acceptIdentity(result);
      return result;
    }
    if (name === "firebase_list_apps") await ensureIdentity();
    if (name.startsWith("crashlytics_")) {
      validateCrashlyticsProjectScope(name, args, await ensureIdentity());
    }
    return callUpstream(name, args);
  };
}

export async function createOfficialFirebaseUpstream(
  options: FirebaseRuntimeOptions = {},
): Promise<FirebaseUpstream> {
  let managedTempRoot: string;
  try {
    managedTempRoot = await realpath(os.tmpdir());
  } catch {
    throw new FirebaseUpstreamStageError("preflight");
  }
  try {
    await sweepStaleOfficialFirebasePrivateRoots(managedTempRoot);
  } catch {
    throw new FirebaseUpstreamCleanupError();
  }
  let runtime: VerifiedRuntime;
  let processProfileLock: FirebaseProcessProfileLock;
  try {
    runtime = await verifyFirebaseRuntime(options);
    processProfileLock = lockVerifiedRuntimeForProcess(options, runtime);
  } catch {
    throw new FirebaseUpstreamStageError("preflight");
  }
  let privateRoot: string | undefined;
  let transport: ProcessGroupStdioTransport | undefined;
  let client: Client | undefined;
  let startupStage: FirebaseUpstreamFailureStage = "startup_private_context";
  try {
    privateRoot = await mkdtemp(path.join(managedTempRoot, FIREBASE_PRIVATE_ROOT_PREFIX));
    await chmod(privateRoot, 0o700);
    await writeFirebasePrivateRootLease(privateRoot);
    await Promise.all([
      mkdir(path.join(privateRoot, "home"), { mode: 0o700 }),
      mkdir(path.join(privateRoot, "tmp"), { mode: 0o700 }),
    ]);
    const privateHome = path.join(privateRoot, "home");
    const privateConfigHome = path.join(privateHome, ".config");
    const privateProjectDir = await preparePrivateFirebaseProjectDirectory(privateRoot);
    let privateServiceAccountCredential: string | undefined;
    if (runtime.projectSource === "service-account") {
      if (
        !runtime.firebaseDir
        || !runtime.firebaseProjectId
        || !runtime.serviceAccountCredential
      ) {
        throw new Error("service-account project binding is incomplete");
      }
      privateServiceAccountCredential = await copyPrivateServiceAccountCredential(
        runtime.serviceAccountCredential,
        privateRoot,
      );
      await writePrivateProjectBinding(
        privateConfigHome,
        privateProjectDir,
        runtime.firebaseProjectId,
      );
    } else {
      const selectedAccountEmail = await writePrivateFirebaseCliProfile(
        originalConfigHome(options.env ?? process.env),
        privateConfigHome,
        runtime.firebaseDir,
        privateProjectDir,
        runtime.firebaseProjectId,
        processProfileLock.firebaseCliAccountEmail,
      );
      processProfileLock.firebaseCliAccountEmail ??= selectedAccountEmail;
    }
    const spawnOptions = buildOfficialFirebaseSpawnOptions(
      runtime,
      options.env ?? process.env,
      privateHome,
      path.join(privateRoot, "tmp"),
      privateProjectDir,
      privateServiceAccountCredential,
    );
    startupStage = "startup_connect";
    transport = new ProcessGroupStdioTransport(spawnOptions);
    client = new Client(
      { name: "app-test-ctrl-firebase-readonly-gateway", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(transport, {
      timeout: STARTUP_TIMEOUT_MS,
      maxTotalTimeout: STARTUP_TIMEOUT_MS,
    });
    startupStage = "startup_list_tools";
    const listed = await client.listTools(
      {},
      { timeout: STARTUP_TIMEOUT_MS, maxTotalTimeout: STARTUP_TIMEOUT_MS },
    );
    startupStage = "startup_tool_contract";
    const available = new Map(listed.tools.map((tool) => [tool.name, tool]));
    for (const name of UPSTREAM_FIREBASE_READ_TOOLS) {
      const tool = available.get(name);
      if (
        !tool
        || tool.inputSchema?.type !== "object"
        || tool.annotations?.readOnlyHint !== true
        || tool.annotations?.destructiveHint === true
      ) {
        throw new Error("the pinned official Firebase MCP read-only tool contract drifted");
      }
    }
  } catch (error) {
    let cleanupFailed = false;
    await client?.close().catch(() => {
      cleanupFailed = true;
    });
    await transport?.close().catch(() => {
      cleanupFailed = true;
    });
    if (privateRoot) {
      await rm(privateRoot, { recursive: true, force: true }).catch(() => {
        cleanupFailed = true;
      });
    }
    if (cleanupFailed) throw new FirebaseUpstreamCleanupError();
    if (error instanceof FirebaseUpstreamStageError) throw error;
    throw new FirebaseUpstreamStageError(startupStage);
  }

  if (!privateRoot || !transport || !client) {
    throw new FirebaseUpstreamStageError("startup_tool_contract");
  }
  let closed = false;
  const activeClient = client;
  const activeTransport = transport;
  const activePrivateRoot = privateRoot;

  const callActiveClient = (
    name: UpstreamFirebaseToolName,
    toolArgs: Record<string, unknown>,
  ): Promise<unknown> => activeClient.callTool(
    { name, arguments: toolArgs },
    undefined,
    { timeout: CALL_TIMEOUT_MS, maxTotalTimeout: CALL_TIMEOUT_MS },
  );
  const callProjectLockedTool = createProjectLockedFirebaseToolCaller(
    callActiveClient,
    runtime.firebaseProjectId,
    processProfileLock,
  );

  return {
    async callTool(name, toolArgs) {
      if (closed) throw new Error("official Firebase MCP upstream is closed");
      try {
        return await callProjectLockedTool(name, toolArgs);
      } catch (error) {
        if (error instanceof FirebaseUpstreamStageError) throw error;
        throw new FirebaseUpstreamStageError("tool_call");
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      let failure: unknown;
      try {
        await activeClient.close();
      } catch (error) {
        failure = error;
      }
      try {
        await activeTransport.close();
      } catch (error) {
        failure ??= error;
      }
      try {
        await rm(activePrivateRoot, { recursive: true, force: true });
      } catch (error) {
        failure ??= error;
      }
      if (failure) throw failure;
    },
  };
}
