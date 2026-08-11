import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  networkPolicyForBackend,
  verificationLevelForBackend,
  type BackendIdentity,
  type BuildBackend,
  type CacheMode,
  type ExecutionProfileName,
  type FilesystemIsolation,
  type NetworkPolicy,
  type ProcessContainment,
  type VerificationLevel,
  type WorkspaceDiskQuota,
} from "./backend.js";
import { assertSha256, domainHash, domainHashJson } from "./canonical.js";
import { verifyGradleCacheSeed, type CacheSeedIdentity } from "./cache-seed.js";
import { GRADLE_ENTRYPOINT } from "./docker-backend.js";
import type { ProcessRunner } from "./process-runner.js";
import {
  assertDisjointRoots,
  canonicalOwnedDirectory,
  existingDirectoryInside,
  existingRegularFileInside,
  hashSelectedFiles,
  normalizeRelativePath,
  type HashedEntry,
} from "./safe-fs.js";

const MAX_ENVIRONMENT_AGE_MS = 15 * 60 * 1000;
const MAX_PROJECT_FILES = 20_000;
const MAX_BUILD_INPUT_FILES = 5_000;
const MAX_BUILD_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_RUNTIME_DEPENDENCY_PACKAGES = 256;
const MAX_RUNTIME_DEPENDENCY_FILES = 8_192;
const MAX_RUNTIME_DEPENDENCY_BYTES = 96 * 1024 * 1024;
const MAX_RUNTIME_DEPENDENCY_FILE_BYTES = 16 * 1024 * 1024;
const SNAPSHOT_HELPER_TIMEOUT_MS = 60_000;
const TASK_RE = /^(?::?[A-Za-z][A-Za-z0-9_-]*)(?::[A-Za-z][A-Za-z0-9_-]*)*$/;
const BUILD_INPUT_BASENAMES = new Set([
  "build.gradle",
  "build.gradle.kts",
  "gradle.lockfile",
  "gradle.properties",
  "gradle-wrapper.jar",
  "gradle-wrapper.properties",
  "libs.versions.toml",
  "settings.gradle",
  "settings.gradle.kts",
  "verification-metadata.xml",
]);
const SKIP_DIRECTORIES = new Set([
  ".git", ".gradle", ".idea", ".svn", "build", "dist", "node_modules", "out",
]);
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const TEST_EXEC_ARGV = new Set([
  "--test-concurrency=4",
  "--test-timeout=60000",
]);
const EMPTY_APPROVED_TEST_FIXTURES_SHA256 =
  "bdc2f2840abddf90f142415e49414323b7fc864b8816c3a7df3c039d3f21b5ce";

export type BuildRole = "baseline" | "candidate";
export type BuildPhase = "regression" | "affected" | "static_analysis" | "build";

export interface SnapshotAudit {
  role: BuildRole;
  sourceRefSha256: string;
  sourceSnapshotSha256: string;
  currentManifestSha256: string;
  canonicalDiffSha256: string;
  approvedTestFixturesSha256: string;
  approvedTestFixtureCount: number;
  approvedTestFixtureContext: {
    schema_version: "crashfix-test-fixture-context/v1";
    enabled: boolean;
    execution_profile: "none" | "local_trusted";
    project_classification: "none" | "test";
  };
  clean: boolean;
  truncated: boolean;
}

export interface BuildEnvironmentDocument {
  schema_version: "build_environment/v2";
  backend: "docker" | "local_trusted";
  execution_profile: ExecutionProfileName;
  verification_level: VerificationLevel;
  environment_allowlist: readonly string[];
  environment_allowlist_sha256: string;
  runner_identity_sha256: string;
  execution_profile_sha256: string;
  command_argv_sha256: string;
  toolchain_manifest_sha256: string;
  sdk_manifest_sha256: string;
  dependency_lock_manifest_sha256: string;
  cache_seed_manifest_sha256: string;
  source_identity_sha256: string;
  signing_adapter_sha256: string;
  test_signing_identity_ref_sha256: string;
  network_policy: NetworkPolicy;
  strong_isolation: boolean;
  filesystem_write_isolation: FilesystemIsolation;
  secret_filesystem_isolation: FilesystemIsolation;
  process_containment: ProcessContainment;
  workspace_disk_quota: WorkspaceDiskQuota;
  cache_mode: CacheMode;
  requires_explicit_trust: boolean;
}

export interface EnvironmentLease {
  id: string;
  createdAt: number;
  role: BuildRole;
  phase: BuildPhase;
  workspaceRoot: string;
  workspaceDir: string;
  projectDir: string;
  projectRelativeDir: string;
  artifactRelativePath?: string;
  expectedSignerCertificateSha256?: string;
  snapshotRoot: string;
  expectedSourceSnapshotSha256: string;
  cacheSeed: CacheSeedIdentity;
  backendIdentity: BackendIdentity;
  tasks: string[];
  logicalArgv: string[];
  environment: BuildEnvironmentDocument;
  buildEnvironmentSha256: string;
  preAudit: SnapshotAudit;
}

export interface EnvironmentPublic {
  schema_version: "build-environment-created/v2";
  environment_id: string;
  backend: "docker" | "local_trusted";
  execution_profile: ExecutionProfileName;
  verification_level: VerificationLevel;
  role: BuildRole;
  workspace_role: BuildRole;
  workspace_manifest_sha256: string;
  workspace_canonical_diff_sha256: string;
  phase: BuildPhase;
  build_environment_sha256: string;
  command_argv_sha256: string;
  network_policy: NetworkPolicy;
  strong_isolation: boolean;
  filesystem_write_isolation: FilesystemIsolation;
  secret_filesystem_isolation: FilesystemIsolation;
  process_containment: ProcessContainment;
  workspace_disk_quota: WorkspaceDiskQuota;
  cache_mode: CacheMode;
  environment_allowlist_sha256: string;
  requires_explicit_trust: boolean;
  requires_per_run_approval: true;
  source_identity_ref: string;
  cache_seed_ref: string;
  expires_in_seconds: number;
  single_use: true;
}

export type SnapshotHelperProcessRunner = Pick<ProcessRunner, "run">;

function snapshotHelperPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../skills/crashfix/scripts/materialize-workspace-snapshot.mjs",
  );
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/var/empty",
    LANG: "C",
    LC_ALL: "C",
  };
}

function parseAudit(raw: string, role: BuildRole, expectedSource: string): SnapshotAudit {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("snapshot audit returned invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("snapshot audit returned an invalid object");
  }
  const record = value as Record<string, unknown>;
  const stringHash = (name: string): string => {
    const item = record[name];
    if (typeof item !== "string") throw new Error(`snapshot audit omitted ${name}`);
    return assertSha256(item, name);
  };
  if (record.schema_version !== "crashfix-workspace-audit/v2" || record.role !== role) {
    throw new Error("snapshot audit identity mismatch");
  }
  const sourceSnapshotSha256 = stringHash("source_snapshot_sha256");
  if (sourceSnapshotSha256 !== expectedSource) throw new Error("snapshot source identity mismatch");
  if (typeof record.clean !== "boolean" || typeof record.truncated !== "boolean") {
    throw new Error("snapshot audit omitted bounded status");
  }
  if (record.truncated) throw new Error("snapshot audit was truncated");
  if (role === "baseline" && !record.clean) throw new Error("baseline workspace is not clean");
  const approvedTestFixtureCount = record.approved_test_fixture_count;
  if (
    !Number.isSafeInteger(approvedTestFixtureCount)
    || (approvedTestFixtureCount as number) < 0
    || (approvedTestFixtureCount as number) > 8
  ) {
    throw new Error("snapshot audit approved fixture count is invalid");
  }
  const contextValue = record.approved_test_fixture_context;
  if (!contextValue || typeof contextValue !== "object" || Array.isArray(contextValue)) {
    throw new Error("snapshot audit approved fixture context is invalid");
  }
  const context = contextValue as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(context).sort())
      !== JSON.stringify(["enabled", "execution_profile", "project_classification", "schema_version"])
    || context.schema_version !== "crashfix-test-fixture-context/v1"
  ) {
    throw new Error("snapshot audit approved fixture context is invalid");
  }
  const fixturesEnabled = (approvedTestFixtureCount as number) > 0;
  const approvedTestFixturesSha256 = stringHash("approved_test_fixtures_sha256");
  if (
    context.enabled !== fixturesEnabled
    || context.execution_profile !== (fixturesEnabled ? "local_trusted" : "none")
    || context.project_classification !== (fixturesEnabled ? "test" : "none")
  ) {
    throw new Error("snapshot audit approved fixture context does not match its count");
  }
  if (fixturesEnabled === (approvedTestFixturesSha256 === EMPTY_APPROVED_TEST_FIXTURES_SHA256)) {
    throw new Error("snapshot audit approved fixture digest does not match its count");
  }
  return {
    role,
    sourceRefSha256: stringHash("source_ref_sha256"),
    sourceSnapshotSha256,
    currentManifestSha256: stringHash("current_manifest_sha256"),
    canonicalDiffSha256: stringHash("canonical_diff_sha256"),
    approvedTestFixturesSha256,
    approvedTestFixtureCount: approvedTestFixtureCount as number,
    approvedTestFixtureContext: context as SnapshotAudit["approvedTestFixtureContext"],
    clean: record.clean,
    truncated: record.truncated,
  };
}

export async function auditWorkspace(options: {
  helperProcessRunner: SnapshotHelperProcessRunner;
  workspaceRoot: string;
  snapshotRoot: string;
  expectedSourceSnapshotSha256: string;
  role: BuildRole;
}): Promise<SnapshotAudit> {
  const result = await options.helperProcessRunner.run(process.execPath, [
    snapshotHelperPath(),
    "audit",
    "--workspace-root", options.workspaceRoot,
    "--snapshot-root", options.snapshotRoot,
    "--expected-source-sha256", options.expectedSourceSnapshotSha256,
    "--role", options.role,
  ], {
    env: minimalEnvironment(),
    timeoutMs: SNAPSHOT_HELPER_TIMEOUT_MS,
    maxOutputBytes: 2 * 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error("snapshot workspace audit failed");
  }
  return parseAudit(result.stdout, options.role, options.expectedSourceSnapshotSha256);
}

export function assertApprovedTestFixtureExecutionProfile(
  audit: Pick<SnapshotAudit, "approvedTestFixtureCount" | "approvedTestFixtureContext">,
  expectedBackend: "docker" | "local_trusted",
): void {
  if (audit.approvedTestFixtureCount > 0 && expectedBackend !== "local_trusted") {
    throw new Error("approved test fixtures are forbidden for docker_strict execution");
  }
  const expectedEnabled = audit.approvedTestFixtureCount > 0;
  if (
    audit.approvedTestFixtureContext.schema_version !== "crashfix-test-fixture-context/v1"
    || audit.approvedTestFixtureContext.enabled !== expectedEnabled
    || audit.approvedTestFixtureContext.execution_profile
      !== (expectedEnabled ? "local_trusted" : "none")
    || audit.approvedTestFixtureContext.project_classification
      !== (expectedEnabled ? "test" : "none")
  ) {
    throw new Error("approved test fixture execution context is invalid");
  }
}

function taskLeaf(task: string): string {
  const parts = task.split(":").filter(Boolean);
  return parts.at(-1) ?? "";
}

export function normalizeTasks(phase: BuildPhase, tasks: readonly string[]): string[] {
  if (tasks.length < 1 || tasks.length > 16) throw new Error("tasks must contain 1-16 entries");
  const unique = [...new Set(tasks)];
  if (unique.length !== tasks.length) throw new Error("tasks must be unique");
  const allowed = phase === "build"
    ? /^assemble[A-Za-z0-9_-]*$/
    : phase === "static_analysis"
      ? /^(?:lint|check)[A-Za-z0-9_-]*$/
      : /^(?:test|check)[A-Za-z0-9_-]*$/;
  for (const task of unique) {
    if (!TASK_RE.test(task) || task.startsWith("-")) throw new Error(`unsafe Gradle task: ${task}`);
    if (!allowed.test(taskLeaf(task))) throw new Error(`Gradle task is not allowed for phase ${phase}`);
  }
  return unique;
}

interface GradleToken {
  kind: "identifier" | "string" | "symbol";
  value: string;
  staticString?: boolean;
}

interface GradleReferences {
  files: Set<string>;
  includedBuildRoots: Set<string>;
}

interface DirectoryPrefixNode {
  terminal: boolean;
  children: Map<string, DirectoryPrefixNode>;
}

/**
 * Index canonical relative directories once, then match file ancestors by path
 * segment. This keeps nested-build discovery proportional to the total path
 * depth instead of rescanning every build root for every project file.
 */
export class DirectoryAncestorIndex {
  readonly #root: DirectoryPrefixNode = { terminal: false, children: new Map() };

  constructor(directories: Iterable<string>) {
    for (const directory of directories) {
      let node = this.#root;
      for (const segment of directory.split("/")) {
        let child = node.children.get(segment);
        if (!child) {
          child = { terminal: false, children: new Map() };
          node.children.set(segment, child);
        }
        node = child;
      }
      node.terminal = true;
    }
  }

  hasAncestor(relativePath: string): boolean {
    const segments = relativePath.split("/");
    let node = this.#root;
    for (let index = 0; index < segments.length; index += 1) {
      const child = node.children.get(segments[index]!);
      if (!child) return false;
      node = child;
      // Preserve the old `${root}/` boundary: equality is not a descendant.
      if (node.terminal && index + 1 < segments.length) return true;
    }
    return false;
  }
}

/**
 * Tokenize only the small Gradle DSL surface that can redirect build execution.
 * Comments and string contents never become identifiers, so an inert example in a
 * comment/string cannot accidentally authorize or reject a path.
 */
function tokenizeGradle(source: string, label: string): GradleToken[] {
  const tokens: GradleToken[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) throw new Error(`unterminated Gradle comment: ${label}`);
      index = end + 2;
      continue;
    }
    if (char === "\"" || char === "'") {
      const quote = char;
      if (source.slice(index, index + 3) === quote.repeat(3)) {
        const end = source.indexOf(quote.repeat(3), index + 3);
        if (end < 0) throw new Error(`unterminated Gradle string: ${label}`);
        tokens.push({
          kind: "string",
          value: source.slice(index + 3, end),
          staticString: false,
        });
        index = end + 3;
        continue;
      }
      index += 1;
      let value = "";
      let isStatic = true;
      let closed = false;
      while (index < source.length) {
        const item = source[index]!;
        if (item === quote) {
          index += 1;
          closed = true;
          break;
        }
        if (item === "\\") {
          // Backslash handling is platform-sensitive and can hide traversal.
          isStatic = false;
          const escaped = source[index + 1];
          if (escaped === undefined) break;
          value += `\\${escaped}`;
          index += 2;
          continue;
        }
        if (item === "\n" || item === "\r" || item === "$" || CONTROL_RE.test(item)) {
          isStatic = false;
        }
        value += item;
        index += 1;
      }
      if (!closed) throw new Error(`unterminated Gradle string: ${label}`);
      tokens.push({ kind: "string", value, staticString: isStatic });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_$-]/.test(source[end]!)) end += 1;
      tokens.push({ kind: "identifier", value: source.slice(index, end) });
      index = end;
      continue;
    }
    tokens.push({ kind: "symbol", value: char });
    index += 1;
  }
  return tokens;
}

function staticGradlePath(
  tokens: readonly GradleToken[],
  start: number,
): { value: string; next: number } | undefined {
  let index = start;
  if (
    tokens[index]?.kind === "identifier"
    && tokens[index]?.value === "rootProject"
    && tokens[index + 1]?.value === "."
  ) {
    index += 2;
  }
  if (tokens[index]?.kind === "identifier" && tokens[index]?.value === "file") {
    if (tokens[index + 1]?.value !== "(") return undefined;
    const item = tokens[index + 2];
    if (item?.kind !== "string" || item.staticString !== true || tokens[index + 3]?.value !== ")") {
      return undefined;
    }
    return { value: item.value, next: index + 4 };
  }
  const item = tokens[index];
  if (item?.kind !== "string" || item.staticString !== true) return undefined;
  return { value: item.value, next: index + 1 };
}

function normalizeGradleReference(
  raw: string,
  operation: string,
  kind: "file" | "directory",
  allFiles: ReadonlySet<string>,
  allDirectories: ReadonlySet<string>,
): string {
  if (
    !raw
    || raw.length > 1024
    || CONTROL_RE.test(raw)
    || raw.includes("\\")
    || raw.includes("$")
    || path.posix.isAbsolute(raw)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)
  ) {
    throw new Error(`${operation} must use a static path inside project_dir`);
  }
  const normalized = path.posix.normalize(raw);
  if (
    normalized !== raw
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    throw new Error(`${operation} escaped or ambiguously traversed project_dir`);
  }
  if (kind === "file" && !allFiles.has(normalized)) {
    throw new Error(`${operation} references a missing build input`);
  }
  if (kind === "directory" && !allDirectories.has(normalized)) {
    throw new Error(`${operation} references a missing included directory`);
  }
  return normalized;
}

function scanGradleReferences(
  source: string,
  label: string,
  allFiles: ReadonlySet<string>,
  allDirectories: ReadonlySet<string>,
): GradleReferences {
  const tokens = tokenizeGradle(source, label);
  const files = new Set<string>();
  const includedBuildRoots = new Set<string>();
  const parsePath = (
    start: number,
    operation: string,
    kind: "file" | "directory",
  ): string => {
    const parsed = staticGradlePath(tokens, start);
    if (!parsed) throw new Error(`${operation} uses unsupported dynamic path syntax: ${label}`);
    return normalizeGradleReference(
      parsed.value,
      operation,
      kind,
      allFiles,
      allDirectories,
    );
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "identifier") continue;
    if (token.value === "includeFlat") {
      throw new Error(`includeFlat can escape project_dir and is not allowed: ${label}`);
    }
    if (token.value === "includeBuild") {
      let argument = index + 1;
      if (tokens[argument]?.value === "(") argument += 1;
      includedBuildRoots.add(parsePath(argument, "includeBuild", "directory"));
      continue;
    }
    if (token.value === "projectDir" && tokens[index + 1]?.value === "=") {
      // Validate remapped Gradle projects even though their source files remain
      // covered separately by the sealed source identity.
      parsePath(index + 2, "projectDir assignment", "directory");
      continue;
    }
    if (token.value !== "apply") continue;

    let cursor = index + 1;
    const bareCall = tokens[index - 1]?.value !== ".";
    if (tokens[cursor]?.value === "(") cursor += 1;
    if (tokens[cursor]?.kind === "identifier" && tokens[cursor]?.value === "from") {
      cursor += 1;
      if (tokens[cursor]?.value !== ":" && tokens[cursor]?.value !== "=") {
        throw new Error(`apply from uses unsupported syntax: ${label}`);
      }
      files.add(parsePath(cursor + 1, "apply from", "file"));
      continue;
    }
    // A dotted Kotlin stdlib `value.apply { ... }` is not Gradle's project
    // redirect API. Named `.apply(from = ...)` above is still checked.
    if (!bareCall) continue;
    if (tokens[cursor]?.kind === "identifier" && tokens[cursor]?.value === "plugin") {
      continue;
    }
    if (tokens[cursor]?.value === "{") {
      let depth = 1;
      for (let nested = cursor + 1; nested < tokens.length && depth > 0; nested += 1) {
        if (tokens[nested]?.value === "{") depth += 1;
        if (tokens[nested]?.value === "}") depth -= 1;
        if (
          depth > 0
          && tokens[nested]?.kind === "identifier"
          && tokens[nested]?.value === "from"
        ) {
          if (tokens[nested + 1]?.value !== "(") {
            throw new Error(`apply from uses unsupported syntax: ${label}`);
          }
          files.add(parsePath(nested + 2, "apply from", "file"));
        }
      }
      continue;
    }
    if (tokens[index + 1]?.value === "(") {
      // Do not allow map/provider indirection to hide an apply-from path. The
      // supported plugin=/from= forms above remain available.
      throw new Error(`unsupported dynamic apply call: ${label}`);
    }
  }
  return { files, includedBuildRoots };
}

export async function discoverBuildInputPaths(projectRoot: string): Promise<string[]> {
  const allFiles: string[] = [];
  const allDirectories = new Set<string>(["."]);
  let visited = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        allDirectories.add(relative);
        await visit(path.join(directory, entry.name), relative);
        continue;
      }
      visited += 1;
      if (visited > MAX_PROJECT_FILES) throw new Error("project file scan exceeded limit");
      if (!entry.isFile()) throw new Error(`special project entry is not allowed: ${relative}`);
      allFiles.push(relative);
    }
  };
  await visit(projectRoot, "");
  const allFileSet = new Set(allFiles);
  const referencedFiles = new Set<string>();
  const includedBuildRoots = new Set<string>();
  for (const relative of allFiles) {
    // Only Gradle DSL scripts can redirect Gradle's project/apply/include
    // graph. Groovy/Kotlin business sources are still hashed below, but are
    // deliberately not interpreted as DSL to avoid false policy decisions.
    if (!/\.gradle(?:\.kts)?$/.test(relative)) continue;
    const file = await readStableRuntimeFile(
      path.join(projectRoot, ...relative.split("/")),
      4 * 1024 * 1024,
      `Gradle build input ${relative}`,
      true,
    );
    const references = scanGradleReferences(
      file.content.toString("utf8"),
      relative,
      allFileSet,
      allDirectories,
    );
    for (const item of references.files) referencedFiles.add(item);
    for (const item of references.includedBuildRoots) includedBuildRoots.add(item);
  }
  const nestedBuildRoots = new Set(allFiles
    .filter((relative) => /(?:^|\/)settings\.gradle(?:\.kts)?$/.test(relative))
    .map((relative) => path.posix.dirname(relative))
    .filter((directory) => directory !== "."));
  for (const root of includedBuildRoots) {
    const hasSettings = allFileSet.has(`${root}/settings.gradle`)
      || allFileSet.has(`${root}/settings.gradle.kts`);
    if (!hasSettings) throw new Error(`includeBuild target has no settings file: ${root}`);
    nestedBuildRoots.add(root);
  }
  const nestedBuildRootIndex = new DirectoryAncestorIndex(nestedBuildRoots);
  const paths = allFiles.filter((relative) => {
    const basename = path.posix.basename(relative);
    const segments = relative.split("/");
    return BUILD_INPUT_BASENAMES.has(basename)
      || /\.(?:gradle|gradle\.kts|kts|toml|groovy|jar)$/.test(relative)
      || relative.startsWith("gradle/")
      || segments.some((segment) => segment === "buildSrc" || segment === "build-logic")
      || nestedBuildRootIndex.hasAncestor(relative);
  });
  paths.push(...referencedFiles);
  if (!paths.includes("gradlew")) paths.push("gradlew");
  const unique = [...new Set(paths)].sort();
  if (unique.length > MAX_BUILD_INPUT_FILES) throw new Error("build input count exceeded limit");
  return unique;
}

interface StableRuntimeFile {
  content: Buffer;
  sha256: string;
  bytes: number;
}

function runtimeUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("build-runner requires numeric runtime ownership");
  return uid;
}

function assertTrustedRuntimeStat(
  value: Stats,
  label: string,
  maxBytes: number,
  allowEmpty: boolean,
): void {
  if (
    !value.isFile()
    || value.isSymbolicLink()
    || value.size > maxBytes
    || (!allowEmpty && value.size < 1)
  ) {
    throw new Error(`${label} is not a bounded regular file`);
  }
  if (value.uid !== 0 && value.uid !== runtimeUid()) {
    throw new Error(`${label} has an untrusted owner`);
  }
  if ((value.mode & 0o022) !== 0) throw new Error(`${label} is group/other writable`);
}

function sameRuntimeFile(
  left: Stats,
  right: Stats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function readStableRuntimeFile(
  file: string,
  maxBytes: number,
  label: string,
  allowEmpty = false,
): Promise<StableRuntimeFile> {
  const pathBefore = await lstat(file);
  assertTrustedRuntimeStat(pathBefore, label, maxBytes, allowEmpty);
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assertTrustedRuntimeStat(before, label, maxBytes, allowEmpty);
    if (!sameRuntimeFile(pathBefore, before)) throw new Error(`${label} changed before hashing`);
    const digest = createHash("sha256");
    const chunks: Buffer[] = [];
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk as Buffer);
      chunks.push(buffer);
      digest.update(buffer);
    }
    const after = await handle.stat();
    const pathAfter = await lstat(file);
    if (!sameRuntimeFile(before, after) || !sameRuntimeFile(after, pathAfter)) {
      throw new Error(`${label} changed while hashing`);
    }
    return { content: Buffer.concat(chunks), sha256: digest.digest("hex"), bytes: before.size };
  } finally {
    await handle.close();
  }
}

async function hashBoundedRuntimeFile(
  file: string,
  maxBytes: number,
  label: string,
  allowEmpty = false,
): Promise<{ sha256: string; bytes: number }> {
  const pathBefore = await lstat(file);
  assertTrustedRuntimeStat(pathBefore, label, maxBytes, allowEmpty);
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assertTrustedRuntimeStat(before, label, maxBytes, allowEmpty);
    if (!sameRuntimeFile(pathBefore, before)) throw new Error(`${label} changed before hashing`);
    const digest = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) digest.update(chunk as Buffer);
    const after = await handle.stat();
    const pathAfter = await lstat(file);
    if (!sameRuntimeFile(before, after) || !sameRuntimeFile(after, pathAfter)) {
      throw new Error(`${label} changed while hashing`);
    }
    return { sha256: digest.digest("hex"), bytes: before.size };
  } finally {
    await handle.close();
  }
}

export interface RuntimeLaunchDescriptor {
  mode: "production" | "tsx-test";
  startup_argv: string[];
  exec_argv: string[];
  node_options: "absent";
}

/** Reject preload/debug/eval flags before they can be treated as an attested runner. */
export function validateRuntimeLaunchConfiguration(options: {
  runtimeDirectory: string;
  execArgv: readonly string[];
  argv: readonly string[];
  nodeOptions?: string;
}): RuntimeLaunchDescriptor {
  if (options.nodeOptions?.trim()) {
    throw new Error("NODE_OPTIONS is not allowed for the trusted build runner");
  }
  if (options.argv.length !== 2 || !path.isAbsolute(options.argv[1] ?? "")) {
    throw new Error("runner startup argv does not identify exactly one absolute entrypoint");
  }
  const runtimeDirectory = path.normalize(options.runtimeDirectory);
  const entrypoint = path.normalize(options.argv[1]!);
  if (path.basename(runtimeDirectory) === "dist") {
    if (entrypoint !== path.join(runtimeDirectory, "index.js")) {
      throw new Error("production runner must start from dist/index.js");
    }
    if (options.execArgv.length !== 0) {
      throw new Error("production runner does not allow Node exec arguments");
    }
    return {
      mode: "production",
      startup_argv: ["node", "dist/index.js"],
      exec_argv: [],
      node_options: "absent",
    };
  }

  const entryDirectory = path.dirname(entrypoint);
  if (
    path.basename(runtimeDirectory) !== "src"
    || entryDirectory !== runtimeDirectory
    || !/\.test\.ts$/.test(path.basename(entrypoint))
  ) {
    throw new Error("unrecognized runner launch mode");
  }
  const execArgv = [...options.execArgv];
  if (execArgv[0] === "--import=tsx") {
    execArgv.shift();
  } else if (execArgv[0] === "--import" && execArgv[1] === "tsx") {
    execArgv.splice(0, 2);
  } else {
    throw new Error("tsx test mode requires the exact tsx import hook");
  }
  const seen = new Set<string>();
  for (const item of execArgv) {
    if (!TEST_EXEC_ARGV.has(item) || seen.has(item)) {
      throw new Error("unsafe Node exec argument in tsx test mode");
    }
    seen.add(item);
  }
  return {
    mode: "tsx-test",
    startup_argv: ["node", `src/${path.basename(entrypoint)}`],
    exec_argv: [...options.execArgv],
    node_options: "absent",
  };
}

type JsonObject = Record<string, unknown>;

function parseJsonObject(content: Buffer, label: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return value as JsonObject;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, string> = {};
  for (const [name, range] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!name || typeof range !== "string") throw new Error(`${label} contains an invalid entry`);
    out[name] = range;
  }
  return out;
}

function recordsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function dependencyCandidates(parentKey: string, dependency: string): string[] {
  if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(dependency)) {
    throw new Error("runtime dependency has an unsafe package name");
  }
  const candidates: string[] = [];
  let current = parentKey;
  for (;;) {
    const candidate = current
      ? `${current}/node_modules/${dependency}`
      : `node_modules/${dependency}`;
    candidates.push(candidate);
    if (!current) break;
    const parent = path.posix.dirname(current);
    current = parent === "." ? "" : parent;
  }
  return [...new Set(candidates)];
}

async function resolveInstalledDependency(options: {
  repoRoot: string;
  packages: JsonObject;
  parentKey: string;
  dependency: string;
  optional: boolean;
}): Promise<string | undefined> {
  for (const candidate of dependencyCandidates(options.parentKey, options.dependency)) {
    if (!(candidate in options.packages)) continue;
    try {
      const value = await lstat(path.join(options.repoRoot, ...candidate.split("/")));
      if (value.isDirectory() && !value.isSymbolicLink()) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (options.optional) return undefined;
  throw new Error(`required runtime dependency is unavailable: ${options.dependency}`);
}

interface RuntimeDependencyBudget {
  files: number;
  bytes: number;
}

async function hashRuntimePackageTree(
  packageRoot: string,
  packageKey: string,
  budget: RuntimeDependencyBudget,
): Promise<HashedEntry[]> {
  const output: HashedEntry[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const directoryBefore = await lstat(directory);
    if (
      !directoryBefore.isDirectory()
      || directoryBefore.isSymbolicLink()
      || (directoryBefore.uid !== 0 && directoryBefore.uid !== runtimeUid())
      || (directoryBefore.mode & 0o022) !== 0
    ) {
      throw new Error(`runtime dependency directory is not trusted: ${packageKey}`);
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      if (!entry.name || CONTROL_RE.test(entry.name)) {
        throw new Error(`runtime dependency contains an unsafe entry: ${packageKey}`);
      }
      if (entry.name === "node_modules" && entry.isDirectory()) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`runtime dependency contains a link or special file: ${packageKey}/${relative}`);
      }
      const identity = await hashBoundedRuntimeFile(
        absolute,
        MAX_RUNTIME_DEPENDENCY_FILE_BYTES,
        `runtime dependency ${packageKey}/${relative}`,
        true,
      );
      budget.files += 1;
      budget.bytes += identity.bytes;
      if (
        budget.files > MAX_RUNTIME_DEPENDENCY_FILES
        || budget.bytes > MAX_RUNTIME_DEPENDENCY_BYTES
      ) {
        throw new Error("runtime dependency closure exceeded its bounded manifest");
      }
      output.push({ path: relative, bytes: identity.bytes, sha256: identity.sha256 });
    }
    const directoryAfter = await lstat(directory);
    if (
      directoryAfter.dev !== directoryBefore.dev
      || directoryAfter.ino !== directoryBefore.ino
      || directoryAfter.mtimeMs !== directoryBefore.mtimeMs
      || directoryAfter.ctimeMs !== directoryBefore.ctimeMs
    ) {
      throw new Error(`runtime dependency directory changed while hashing: ${packageKey}`);
    }
  };
  await visit(packageRoot, "");
  return output;
}

async function runtimeDependencyClosure(options: {
  repoRoot: string;
  runnerManifest: JsonObject;
  lock: JsonObject;
  includeTsx: boolean;
}): Promise<Array<Record<string, unknown>>> {
  const packagesValue = options.lock.packages;
  if (!packagesValue || typeof packagesValue !== "object" || Array.isArray(packagesValue)) {
    throw new Error("package lock omitted the packages map");
  }
  const packages = packagesValue as JsonObject;
  const workspaceKey = "mcp-servers/build-runner-mcp";
  const workspaceLock = packages[workspaceKey];
  if (!workspaceLock || typeof workspaceLock !== "object" || Array.isArray(workspaceLock)) {
    throw new Error("package lock omitted the build-runner workspace");
  }
  const direct = stringRecord(options.runnerManifest.dependencies, "runner dependencies");
  const lockedDirect = stringRecord(
    (workspaceLock as JsonObject).dependencies,
    "locked runner dependencies",
  );
  if (!recordsEqual(direct, lockedDirect)) {
    throw new Error("runner dependency declarations do not match package lock");
  }

  const queue: Array<{ key: string; name: string }> = [];
  for (const name of Object.keys(direct)) {
    const key = await resolveInstalledDependency({
      repoRoot: options.repoRoot,
      packages,
      parentKey: workspaceKey,
      dependency: name,
      optional: false,
    });
    queue.push({ key: key!, name });
  }
  if (options.includeTsx) {
    const rootLock = packages[""];
    if (!rootLock || typeof rootLock !== "object" || Array.isArray(rootLock)) {
      throw new Error("package lock omitted the root test runtime");
    }
    const rootDev = stringRecord((rootLock as JsonObject).devDependencies, "root dev dependencies");
    if (!("tsx" in rootDev)) throw new Error("tsx test runtime is not locked");
    const key = await resolveInstalledDependency({
      repoRoot: options.repoRoot,
      packages,
      parentKey: "",
      dependency: "tsx",
      optional: false,
    });
    queue.push({ key: key!, name: "tsx" });
  }

  const seen = new Map<string, string>();
  const budget: RuntimeDependencyBudget = { files: 0, bytes: 0 };
  const closure: Array<Record<string, unknown>> = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const priorName = seen.get(current.key);
    if (priorName !== undefined) {
      if (priorName !== current.name) throw new Error("runtime dependency resolved under two names");
      continue;
    }
    seen.set(current.key, current.name);
    if (seen.size > MAX_RUNTIME_DEPENDENCY_PACKAGES) {
      throw new Error("runtime dependency package count exceeded limit");
    }
    const lockEntry = packages[current.key];
    if (!lockEntry || typeof lockEntry !== "object" || Array.isArray(lockEntry)) {
      throw new Error(`runtime dependency is not locked: ${current.name}`);
    }
    const packageRoot = path.join(options.repoRoot, ...current.key.split("/"));
    const canonical = await realpath(packageRoot);
    if (canonical !== packageRoot) throw new Error(`runtime dependency traverses a link: ${current.name}`);
    const manifestFile = await readStableRuntimeFile(
      path.join(packageRoot, "package.json"),
      1024 * 1024,
      `runtime dependency manifest ${current.name}`,
    );
    const manifest = parseJsonObject(manifestFile.content, `runtime dependency manifest ${current.name}`);
    if (manifest.name !== current.name || typeof manifest.version !== "string") {
      throw new Error(`runtime dependency identity mismatch: ${current.name}`);
    }
    if ((lockEntry as JsonObject).version !== manifest.version) {
      throw new Error(`runtime dependency version is not the locked version: ${current.name}`);
    }
    const dependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"] as const;
    for (const field of dependencyFields) {
      if (!recordsEqual(
        stringRecord(manifest[field], `${current.name} ${field}`),
        stringRecord((lockEntry as JsonObject)[field], `locked ${current.name} ${field}`),
      )) {
        throw new Error(`runtime dependency metadata differs from lock: ${current.name}`);
      }
    }

    const required = stringRecord(manifest.dependencies, `${current.name} dependencies`);
    const optional = stringRecord(manifest.optionalDependencies, `${current.name} optional dependencies`);
    const peers = stringRecord(manifest.peerDependencies, `${current.name} peer dependencies`);
    const peerMeta = manifest.peerDependenciesMeta;
    const optionalPeers = new Set<string>();
    if (peerMeta !== undefined) {
      if (!peerMeta || typeof peerMeta !== "object" || Array.isArray(peerMeta)) {
        throw new Error(`runtime dependency peer metadata is invalid: ${current.name}`);
      }
      for (const [name, metadata] of Object.entries(peerMeta as JsonObject)) {
        if (
          metadata
          && typeof metadata === "object"
          && !Array.isArray(metadata)
          && (metadata as JsonObject).optional === true
        ) optionalPeers.add(name);
      }
    }
    const dependencyNames = new Set([
      ...Object.keys(required),
      ...Object.keys(optional),
      ...Object.keys(peers),
    ]);
    for (const name of [...dependencyNames].sort()) {
      const isOptional = name in optional || optionalPeers.has(name);
      const key = await resolveInstalledDependency({
        repoRoot: options.repoRoot,
        packages,
        parentKey: current.key,
        dependency: name,
        optional: isOptional,
      });
      if (key) queue.push({ key, name });
    }
    const files = await hashRuntimePackageTree(packageRoot, current.key, budget);
    closure.push({
      package: current.name,
      version: manifest.version,
      lock_path: current.key,
      manifest_sha256: manifestFile.sha256,
      files,
    });
  }
  closure.sort((left, right) => String(left.lock_path).localeCompare(String(right.lock_path)));
  return closure;
}

export async function runtimeIdentity(): Promise<string> {
  const unresolvedDirectory = path.dirname(fileURLToPath(import.meta.url));
  const directory = await realpath(unresolvedDirectory);
  if (directory !== unresolvedDirectory) throw new Error("runner runtime directory must not be symlinked");
  const launch = validateRuntimeLaunchConfiguration({
    runtimeDirectory: directory,
    execArgv: process.execArgv,
    argv: process.argv,
    nodeOptions: process.env.NODE_OPTIONS,
  });
  const expectedEntrypoint = launch.mode === "production"
    ? path.join(directory, "index.js")
    : path.join(directory, path.basename(process.argv[1]!));
  if (await realpath(process.argv[0]!) !== await realpath(process.execPath)) {
    throw new Error("runner startup Node binary identity changed");
  }
  if (await realpath(process.argv[1]!) !== await realpath(expectedEntrypoint)) {
    throw new Error("runner startup entrypoint identity changed");
  }
  const codeExtension = launch.mode === "production"
    ? /\.(?:js|mjs|cjs)$/
    : /\.(?:ts|mts|cts)$/;
  const names = (await readdir(directory))
    .filter((name) => codeExtension.test(name) && !name.includes(".test."))
    .sort();
  const entries: { name: string; sha256: string }[] = [];
  for (const name of names) {
    const identity = await hashBoundedRuntimeFile(
      path.join(directory, name),
      4 * 1024 * 1024,
      `runner code ${name}`,
    );
    entries.push({
      name: name.replace(/\.(?:[cm]?[jt]s)$/, ".runtime"),
      sha256: identity.sha256,
    });
  }
  const repoRoot = path.resolve(directory, "../../..");
  const packageLock = await readStableRuntimeFile(
    path.join(repoRoot, "package-lock.json"),
    32 * 1024 * 1024,
    "package lock",
  );
  const runnerManifest = await readStableRuntimeFile(
    path.resolve(directory, "../package.json"),
    1024 * 1024,
    "runner package manifest",
  );
  const parsedRunnerManifest = parseJsonObject(runnerManifest.content, "runner package manifest");
  const parsedLock = parseJsonObject(packageLock.content, "package lock");
  return domainHashJson("crashfix-build-runner-identity/v1", {
    code: entries,
    node: {
      binary_sha256: (await hashBoundedRuntimeFile(
        process.execPath,
        512 * 1024 * 1024,
        "Node executable",
      )).sha256,
      launch,
      release: process.release.name,
      version: process.version,
      versions: process.versions,
    },
    runtime_dependency_closure: await runtimeDependencyClosure({
      repoRoot,
      runnerManifest: parsedRunnerManifest,
      lock: parsedLock,
      includeTsx: launch.mode === "tsx-test",
    }),
    package_lock_sha256: packageLock.sha256,
    package_manifest_sha256: runnerManifest.sha256,
    snapshot_helper_sha256: (await hashBoundedRuntimeFile(
      snapshotHelperPath(),
      4 * 1024 * 1024,
      "snapshot helper",
    )).sha256,
  });
}

function toolchainInputs(entries: readonly HashedEntry[]): HashedEntry[] {
  return entries.filter((entry) => (
    entry.path === "gradlew"
    || entry.path.endsWith("/gradle-wrapper.jar")
    || entry.path.endsWith("/gradle-wrapper.properties")
  ));
}

export async function createEnvironment(options: {
  backend: BuildBackend;
  helperProcessRunner: SnapshotHelperProcessRunner;
  expectedBackend: "docker" | "local_trusted";
  role: BuildRole;
  phase: BuildPhase;
  workspaceRoot: string;
  snapshotRoot: string;
  expectedSourceSnapshotSha256: string;
  expectedWorkspaceManifestSha256: string;
  expectedWorkspaceCanonicalDiffSha256: string;
  cacheSeedRoot: string;
  expectedCacheSeedManifestSha256: string;
  projectRelativeDir: string;
  artifactRelativePath?: string;
  expectedSignerCertificateSha256?: string;
  tasks: readonly string[];
}): Promise<{ lease: EnvironmentLease; public: EnvironmentPublic }> {
  if (options.expectedBackend !== options.backend.backend) {
    throw new Error("expected_backend does not match the configured build backend");
  }
  const expectedSource = assertSha256(
    options.expectedSourceSnapshotSha256,
    "expected source snapshot hash",
  );
  const expectedWorkspaceManifest = assertSha256(
    options.expectedWorkspaceManifestSha256,
    "expected workspace manifest hash",
  );
  const expectedWorkspaceCanonicalDiff = assertSha256(
    options.expectedWorkspaceCanonicalDiffSha256,
    "expected workspace canonical diff hash",
  );
  const workspaceRoot = await canonicalOwnedDirectory(
    options.workspaceRoot,
    "build workspace root",
    { exactMode: 0o700 },
  );
  const snapshotRoot = await canonicalOwnedDirectory(
    options.snapshotRoot,
    "sealed snapshot root",
    { exactMode: 0o700 },
  );
  const cacheSeed = await verifyGradleCacheSeed(
    options.cacheSeedRoot,
    options.expectedCacheSeedManifestSha256,
  );
  assertDisjointRoots([workspaceRoot, snapshotRoot, cacheSeed.root]);
  const workspaceDir = await canonicalOwnedDirectory(
    path.join(workspaceRoot, "workspace"),
    "build workspace",
    { exactMode: 0o700 },
  );
  if (path.dirname(workspaceDir) !== workspaceRoot) throw new Error("build workspace escaped its private root");
  const projectRelativeDir = options.projectRelativeDir === "."
    ? "."
    : normalizeRelativePath(options.projectRelativeDir, "project_relative_dir");
  const projectDir = await existingDirectoryInside(
    workspaceDir,
    projectRelativeDir,
    "Gradle project directory",
  );
  const gradlew = await existingRegularFileInside(projectDir, "gradlew", "Gradle wrapper", 1024 * 1024);
  if (!gradlew.sha256) throw new Error("Gradle wrapper identity is unavailable");
  const tasks = normalizeTasks(options.phase, options.tasks);
  const artifactRelativePath = options.artifactRelativePath === undefined
    ? undefined
    : normalizeRelativePath(options.artifactRelativePath, "artifact_relative_path");
  if (options.phase === "build") {
    if (!artifactRelativePath?.endsWith(".apk")) {
      throw new Error("build phase requires one bound APK artifact_relative_path");
    }
    try {
      await lstat(path.join(workspaceDir, ...artifactRelativePath.split("/")));
      throw new Error("bound APK artifact must not exist before the build");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!options.expectedSignerCertificateSha256) {
      throw new Error("build phase requires an approved non-production signer certificate hash");
    }
  } else if (artifactRelativePath !== undefined) {
    throw new Error("artifact_relative_path is only allowed for build phase");
  } else if (options.expectedSignerCertificateSha256 !== undefined) {
    throw new Error("expected signer identity is only allowed for build phase");
  }
  const expectedSignerCertificateSha256 = options.expectedSignerCertificateSha256 === undefined
    ? undefined
    : assertSha256(
      options.expectedSignerCertificateSha256,
      "expected signer certificate hash",
    );
  const capability = await options.backend.probe();
  if (
    !capability.available
    || capability.backend !== options.backend.backend
    || capability.identity.backend !== options.backend.backend
  ) {
    throw new Error(`configured build backend unavailable: ${capability.reasons.join(",")}`);
  }
  const preAudit = await auditWorkspace({
    helperProcessRunner: options.helperProcessRunner,
    workspaceRoot,
    snapshotRoot,
    expectedSourceSnapshotSha256: expectedSource,
    role: options.role,
  });
  assertApprovedTestFixtureExecutionProfile(preAudit, options.expectedBackend);
  if (preAudit.currentManifestSha256 !== expectedWorkspaceManifest) {
    throw new Error("workspace manifest identity does not match the caller-approved audit");
  }
  if (preAudit.canonicalDiffSha256 !== expectedWorkspaceCanonicalDiff) {
    throw new Error("workspace canonical diff identity does not match the caller-approved audit");
  }
  const buildInputPaths = await discoverBuildInputPaths(projectDir);
  const buildInputs = await hashSelectedFiles(projectDir, buildInputPaths, {
    maxFiles: MAX_BUILD_INPUT_FILES,
    maxTotalBytes: MAX_BUILD_INPUT_BYTES,
    maxFileBytes: 32 * 1024 * 1024,
  });
  const logicalArgv = [
    "./gradlew",
    "--offline",
    "--no-daemon",
    "--console=plain",
    ...tasks,
  ];
  const commandArgvSha256 = domainHashJson("crashfix-gradle-command/v2", {
    argv: logicalArgv,
    project_relative_dir: projectRelativeDir,
    artifact_relative_path: artifactRelativePath ?? null,
    expected_signer_certificate_sha256: expectedSignerCertificateSha256 ?? null,
  });
  const executionProfileSha256 = domainHashJson(
    "crashfix-execution-profile/v2",
    options.backend.executionProfile(capability.identity),
  );
  const sourceIdentitySha256 = domainHash(
    "crashfix-source-identity/v1",
    `snapshot\0${expectedSource}`,
  );
  const backendToolchainIdentity = capability.identity.backend === "docker"
    ? {
        backend: "docker" as const,
        image_digest: capability.identity.dockerImageDigest,
        image_id: capability.identity.dockerImageId,
        entrypoint_sha256: domainHash("crashfix-gradle-entrypoint/v1", GRADLE_ENTRYPOINT),
      }
    : {
        backend: "local_trusted" as const,
        platform: capability.identity.platform,
        architecture: capability.identity.architecture,
        java_executable_sha256: capability.identity.javaExecutableSha256,
        java_release_sha256: capability.identity.javaReleaseSha256,
        java_runtime_sha256: capability.identity.javaRuntimeSha256,
        java_version_sha256: capability.identity.javaVersionSha256,
        execution_profile_sha256: capability.identity.executionProfileSha256,
      };
  const backendSdkIdentity = capability.identity.backend === "docker"
    ? {
        backend: "docker" as const,
        image_digest: capability.identity.dockerImageDigest,
        image_id: capability.identity.dockerImageId,
        android_sdk_root: options.backend.config.androidSdkRoot,
        java_home: options.backend.config.javaHome,
        apkanalyzer: options.backend.config.apkAnalyzer,
        apksigner: options.backend.config.apkSigner,
      }
    : {
        backend: "local_trusted" as const,
        apkanalyzer_sha256: capability.identity.apkAnalyzerSha256,
        apkanalyzer_package_sha256: capability.identity.apkAnalyzerPackageSha256,
        apkanalyzer_implementation_sha256:
          capability.identity.apkAnalyzerImplementationSha256,
        apkanalyzer_version_sha256: capability.identity.apkAnalyzerVersionSha256,
        apksigner_sha256: capability.identity.apkSignerSha256,
        apksigner_package_sha256: capability.identity.apkSignerPackageSha256,
        apksigner_implementation_sha256: capability.identity.apkSignerImplementationSha256,
        apksigner_version_sha256: capability.identity.apkSignerVersionSha256,
      };
  const networkPolicy = networkPolicyForBackend(capability.backend);
  const verificationLevel = verificationLevelForBackend(capability.backend);
  const executionProfile: ExecutionProfileName = capability.backend === "docker"
    ? "docker_strict"
    : "local_trusted";
  const environmentAllowlist = capability.backend === "docker"
    ? [
        "ANDROID_HOME",
        "ANDROID_SDK_ROOT",
        "GRADLE_RO_DEP_CACHE",
        "GRADLE_USER_HOME",
        "HOME",
        "JAVA_HOME",
        "LANG",
        "LC_ALL",
        "PATH",
        "TZ",
      ]
    : [
        "ANDROID_HOME",
        "ANDROID_SDK_ROOT",
        "CI",
        "GRADLE_USER_HOME",
        "HOME",
        "JAVA_HOME",
        "LANG",
        "LC_ALL",
        "PATH",
        "TMPDIR",
        "TZ",
      ];
  const environmentAllowlistSha256 = domainHashJson(
    "crashfix-build-environment-allowlist/v2",
    environmentAllowlist,
  );
  const strongIsolation = capability.backend === "docker";
  const filesystemWriteIsolation: FilesystemIsolation = strongIsolation
    ? "enforced"
    : "not_enforced";
  const processContainment: ProcessContainment = strongIsolation
    ? "container+process_group"
    : "process_group_best_effort";
  const workspaceDiskQuota: WorkspaceDiskQuota = strongIsolation
    ? { enforced: true, mechanism: "attested" }
    : { enforced: false, mechanism: "none" };
  const cacheMode: CacheMode = strongIsolation
    ? "sealed_seed_readonly_overlay"
    : "sealed_seed_disposable_copy";
  const environment: BuildEnvironmentDocument = {
    schema_version: "build_environment/v2",
    backend: capability.backend,
    execution_profile: executionProfile,
    verification_level: verificationLevel,
    environment_allowlist: environmentAllowlist,
    environment_allowlist_sha256: environmentAllowlistSha256,
    runner_identity_sha256: await runtimeIdentity(),
    execution_profile_sha256: executionProfileSha256,
    command_argv_sha256: commandArgvSha256,
    toolchain_manifest_sha256: domainHashJson("crashfix-toolchain-manifest/v2", {
      ...backendToolchainIdentity,
      gradle_wrapper: toolchainInputs(buildInputs),
    }),
    sdk_manifest_sha256: domainHashJson("crashfix-sdk-manifest/v2", {
      ...backendSdkIdentity,
    }),
    dependency_lock_manifest_sha256: domainHashJson(
      "crashfix-dependency-lock-manifest/v1",
      buildInputs,
    ),
    cache_seed_manifest_sha256: cacheSeed.manifestSha256,
    source_identity_sha256: sourceIdentitySha256,
    signing_adapter_sha256: domainHash(
      "crashfix-signing-adapter/v1",
      expectedSignerCertificateSha256
        ? "preconfigured-non-production-signer+post-build-verification"
        : "none",
    ),
    test_signing_identity_ref_sha256: domainHash(
      "crashfix-test-signing-identity/v1",
      expectedSignerCertificateSha256 ?? "none",
    ),
    network_policy: networkPolicy,
    strong_isolation: strongIsolation,
    filesystem_write_isolation: filesystemWriteIsolation,
    secret_filesystem_isolation: filesystemWriteIsolation,
    process_containment: processContainment,
    workspace_disk_quota: workspaceDiskQuota,
    cache_mode: cacheMode,
    requires_explicit_trust: !strongIsolation,
  };
  const buildEnvironmentSha256 = domainHashJson(
    "crashfix-build-environment/v2",
    environment,
  );
  const lease: EnvironmentLease = {
    id: randomUUID(),
    createdAt: Date.now(),
    role: options.role,
    phase: options.phase,
    workspaceRoot,
    workspaceDir,
    projectDir,
    projectRelativeDir,
    ...(artifactRelativePath ? { artifactRelativePath } : {}),
    ...(expectedSignerCertificateSha256 ? { expectedSignerCertificateSha256 } : {}),
    snapshotRoot,
    expectedSourceSnapshotSha256: expectedSource,
    cacheSeed,
    backendIdentity: capability.identity,
    tasks,
    logicalArgv,
    environment,
    buildEnvironmentSha256,
    preAudit,
  };
  return {
    lease,
    public: {
      schema_version: "build-environment-created/v2",
      environment_id: lease.id,
      backend: capability.backend,
      execution_profile: executionProfile,
      verification_level: verificationLevel,
      role: lease.role,
      workspace_role: preAudit.role,
      workspace_manifest_sha256: preAudit.currentManifestSha256,
      workspace_canonical_diff_sha256: preAudit.canonicalDiffSha256,
      phase: lease.phase,
      build_environment_sha256: buildEnvironmentSha256,
      command_argv_sha256: commandArgvSha256,
      network_policy: networkPolicy,
      strong_isolation: strongIsolation,
      filesystem_write_isolation: filesystemWriteIsolation,
      secret_filesystem_isolation: filesystemWriteIsolation,
      process_containment: processContainment,
      workspace_disk_quota: workspaceDiskQuota,
      cache_mode: cacheMode,
      environment_allowlist_sha256: environmentAllowlistSha256,
      requires_explicit_trust: !strongIsolation,
      requires_per_run_approval: true,
      source_identity_ref: sourceIdentitySha256.slice(0, 12),
      cache_seed_ref: cacheSeed.manifestSha256.slice(0, 12),
      expires_in_seconds: Math.floor(MAX_ENVIRONMENT_AGE_MS / 1000),
      single_use: true,
    },
  };
}

export function assertLeaseFresh(lease: EnvironmentLease, now = Date.now()): void {
  if (now - lease.createdAt > MAX_ENVIRONMENT_AGE_MS) {
    throw new Error("build environment expired");
  }
}
