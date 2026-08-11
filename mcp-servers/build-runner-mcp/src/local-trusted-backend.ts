import { randomBytes, createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  ArtifactTool,
  BackendIdentity,
  BuildBackend,
  BuildCommandOptions,
  CapabilityResult,
  LocalTrustedIdentity,
} from "./backend.js";
import { canonicalJson, domainHash, domainHashJson } from "./canonical.js";
import type { LocalTrustedRunnerConfig } from "./config.js";
import { cleanDiagnostic } from "./diagnostic.js";
import { ProcessRunner, type ProcessResult } from "./process-runner.js";
import {
  canonicalOwnedDirectory,
  canonicalTrustedDirectory,
  canonicalTrustedExecutable,
  copyStableRegularFile,
  assertSafeAncestorChain,
  existingDirectoryInside,
  existingRegularFileInside,
  listFilesRecursively,
  normalizeRelativePath,
} from "./safe-fs.js";

const INTERNAL_OUTPUT_BYTES = 256 * 1024;
const MAX_CACHE_FILES = 250_000;
const MAX_CACHE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_CACHE_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const TASK_RE = /^(?::?[A-Za-z][A-Za-z0-9_-]*)(?::[A-Za-z][A-Za-z0-9_-]*)*$/;
const LOCAL_ROOT_PREFIX = "app-test-ctrl-local-";
const OWNER_FILE = ".app-test-ctrl-owner.json";
const LOCAL_TOOLCHAIN_ANCESTOR_POLICY = Object.freeze({
  allowTrustedGroupWritable: true,
});

interface StableExecutable {
  path: string;
  sha256: string;
}

interface InitializedToolchain {
  javaHome: string;
  androidSdkRoot: string;
  java: StableExecutable;
  javaRelease: StableExecutable;
  javaRuntime: StableExecutable;
  apkAnalyzer: StableExecutable;
  apkAnalyzerPackageRoot: string;
  apkAnalyzerExpectedVersion?: string;
  apkAnalyzerPackageSha256: string;
  apkAnalyzerImplementationSha256: string;
  apkSigner: StableExecutable;
  apkSignerPackageRoot: string;
  apkSignerPackageSha256: string;
  apkSignerImplementationSha256: string;
}

interface OwnedRoot {
  owner: string;
  purpose: "probe" | "gradle" | "artifact";
  rootIdentity: PinnedFilesystemIdentity;
  ownerIdentity: PinnedFilesystemIdentity;
}

interface PinnedFilesystemIdentity {
  dev: number;
  ino: number;
  uid: number;
  gid: number;
  mode: number;
  nlink: number;
  size: number;
}

export interface LocalTrustedBackendDependencies {
  /** Test-only lifecycle seam. Production always owns a private ProcessRunner. */
  testOnlyProcessRunner?: Pick<ProcessRunner, "run" | "close">;
  /** Test-only host identity seam; production uses the actual process host. */
  testOnlyPlatform?: NodeJS.Platform;
  testOnlyUid?: number;
  testOnlyArchitecture?: string;
}

function localExecutionProfileBase(): Record<string, unknown> {
  return {
    schema_version: "crashfix-local-trusted-execution-profile/v1",
    backend: "local_trusted",
    verification_level: "trusted_local",
    strong_isolation: false,
    network_policy: "not_enforced",
    filesystem_write_isolation: "not_enforced",
    secret_filesystem_isolation: "not_enforced",
    process_containment: "process_group_best_effort",
    resource_limits: {
      memory: "not_enforced",
      cpu: "not_enforced",
      pids: "not_enforced",
      workspace_disk_quota: "not_enforced",
    },
    command: "project-gradlew-only",
    fixed_gradle_flags: ["--offline", "--no-daemon", "--console=plain"],
    environment: "fixed-minimal-allowlist",
    dependency_cache: "sealed-seed+disposable-private-copy",
    project_trust_required: true,
    requires_per_run_approval: true,
  };
}

async function hashStableExecutable(input: string, label: string): Promise<StableExecutable> {
  const executable = await canonicalTrustedExecutable(
    input,
    label,
    LOCAL_TOOLCHAIN_ANCESTOR_POLICY,
  );
  const beforePath = await lstat(executable);
  if (
    !beforePath.isFile()
    || beforePath.isSymbolicLink()
    || beforePath.nlink !== 1
    || beforePath.size < 1
  ) {
    throw new Error(`${label} must be a non-empty regular file`);
  }
  const handle = await open(executable, "r");
  try {
    const before = await handle.stat();
    if (
      before.dev !== beforePath.dev
      || before.ino !== beforePath.ino
      || before.size !== beforePath.size
      || before.size > 512 * 1024 * 1024
    ) {
      throw new Error(`${label} changed before hashing or exceeds its byte limit`);
    }
    const digest = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) digest.update(chunk as Buffer);
    const after = await handle.stat();
    const afterPath = await lstat(executable);
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || afterPath.dev !== after.dev
      || afterPath.ino !== after.ino
      || afterPath.mode !== beforePath.mode
      || afterPath.nlink !== beforePath.nlink
      || afterPath.uid !== beforePath.uid
      || afterPath.gid !== beforePath.gid
      || afterPath.ctimeMs !== beforePath.ctimeMs
    ) {
      throw new Error(`${label} changed while hashing`);
    }
    return { path: executable, sha256: digest.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function hashStableTrustedFile(
  input: string,
  label: string,
  maxBytes: number,
  captureContent = false,
): Promise<StableExecutable & { bytes: number; content?: Buffer }> {
  const canonical = await realpath(input);
  await assertSafeAncestorChain(
    path.dirname(canonical),
    label,
    LOCAL_TOOLCHAIN_ANCESTOR_POLICY,
  );
  const pathBefore = await lstat(canonical);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("local_trusted requires numeric filesystem ownership");
  if (
    !pathBefore.isFile()
    || pathBefore.isSymbolicLink()
    || pathBefore.nlink !== 1
    || pathBefore.size < 1
    || pathBefore.size > maxBytes
    || (pathBefore.uid !== 0 && pathBefore.uid !== uid)
    || (pathBefore.mode & 0o022) !== 0
  ) {
    throw new Error(`${label} is not a bounded trusted regular file`);
  }
  const handle = await open(canonical, "r");
  try {
    const before = await handle.stat();
    if (
      before.dev !== pathBefore.dev
      || before.ino !== pathBefore.ino
      || before.size !== pathBefore.size
    ) {
      throw new Error(`${label} changed before hashing`);
    }
    const digest = createHash("sha256");
    let content: Buffer | undefined;
    if (captureContent) {
      content = await handle.readFile();
      digest.update(content);
    } else {
      const stream = handle.createReadStream({ autoClose: false });
      for await (const chunk of stream) digest.update(chunk as Buffer);
    }
    const after = await handle.stat();
    const pathAfter = await lstat(canonical);
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || pathAfter.dev !== after.dev
      || pathAfter.ino !== after.ino
      || pathAfter.mode !== pathBefore.mode
      || pathAfter.nlink !== pathBefore.nlink
      || pathAfter.uid !== pathBefore.uid
      || pathAfter.gid !== pathBefore.gid
      || pathAfter.ctimeMs !== pathBefore.ctimeMs
    ) {
      throw new Error(`${label} changed while hashing`);
    }
    return {
      path: canonical,
      bytes: before.size,
      sha256: digest.digest("hex"),
      ...(content ? { content } : {}),
    };
  } finally {
    await handle.close();
  }
}

async function hashTrustedTree(
  input: string,
  label: string,
): Promise<string> {
  const root = await canonicalTrustedDirectory(
    input,
    label,
    LOCAL_TOOLCHAIN_ANCESTOR_POLICY,
  );
  const entries: Array<{ path: string; bytes: number; sha256: string }> = [];
  let totalBytes = 0;
  let totalDirectories = 0;
  let totalDirectoryEntries = 0;
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 32) throw new Error(`${label} exceeds its directory-depth limit`);
    totalDirectories += 1;
    if (totalDirectories > 1_024) throw new Error(`${label} exceeds its directory-count limit`);
    const directoryBefore = await lstat(directory);
    const children = [];
    const handle = await opendir(directory);
    for await (const child of handle) {
      totalDirectoryEntries += 1;
      if (totalDirectoryEntries > 8_192) {
        throw new Error(`${label} exceeds its directory-entry limit`);
      }
      children.push(child);
    }
    children.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const child of children) {
      if (!child.name || /[\u0000-\u001f\u007f]/.test(child.name)) {
        throw new Error(`${label} contains an unsafe entry name`);
      }
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      const absolute = path.join(directory, child.name);
      const value = await lstat(absolute);
      if (value.isSymbolicLink()) throw new Error(`${label} contains a symlink`);
      const uid = process.getuid?.();
      if (
        uid === undefined
        || (value.uid !== 0 && value.uid !== uid)
        || (value.mode & 0o022) !== 0
      ) {
        throw new Error(`${label} contains an untrusted entry`);
      }
      if (value.isDirectory()) {
        await visit(absolute, relative, depth + 1);
      } else if (value.isFile()) {
        if (entries.length >= 4_096) throw new Error(`${label} exceeds its file-count limit`);
        const hashed = await hashStableTrustedFile(
          absolute,
          `${label} entry`,
          256 * 1024 * 1024,
        );
        totalBytes += hashed.bytes;
        if (totalBytes > 1024 * 1024 * 1024) {
          throw new Error(`${label} exceeds its total byte limit`);
        }
        entries.push({ path: relative, bytes: hashed.bytes, sha256: hashed.sha256 });
      } else {
        throw new Error(`${label} contains a special file`);
      }
    }
    const directoryAfter = await lstat(directory);
    if (
      directoryAfter.dev !== directoryBefore.dev
      || directoryAfter.ino !== directoryBefore.ino
      || directoryAfter.mode !== directoryBefore.mode
      || directoryAfter.uid !== directoryBefore.uid
      || directoryAfter.gid !== directoryBefore.gid
      || directoryAfter.mtimeMs !== directoryBefore.mtimeMs
      || directoryAfter.ctimeMs !== directoryBefore.ctimeMs
    ) {
      throw new Error(`${label} directory changed while hashing`);
    }
  };
  await visit(root, "", 0);
  if (entries.length === 0) throw new Error(`${label} contains no implementation files`);
  return domainHashJson("crashfix-local-trusted-tree/v1", entries);
}

async function packageIdentity(
  packageRoot: string,
  expectedVersion: string | undefined,
  label: string,
): Promise<string> {
  const source = await hashStableTrustedFile(
    path.join(packageRoot, "source.properties"),
    `${label} source.properties`,
    64 * 1024,
    true,
  );
  if (!source.content) throw new Error(`${label} source.properties content is unavailable`);
  const content = source.content.toString("utf8");
  const activeRevisionLines = content
    .split(/\r?\n/)
    .filter((line) => /^\s*Pkg\.Revision\s*=/.test(line));
  if (activeRevisionLines.length !== 1) {
    throw new Error(`${label} must contain exactly one Pkg.Revision`);
  }
  const match = /^\s*Pkg\.Revision\s*=\s*([0-9]+(?:\.[0-9]+)*)\s*$/.exec(
    activeRevisionLines[0]!,
  );
  if (!match?.[1] || (expectedVersion !== undefined && match[1] !== expectedVersion)) {
    throw new Error(`${label} has an invalid or mismatched stable package revision`);
  }
  return domainHashJson("crashfix-local-sdk-package/v1", {
    revision: match[1],
    source_properties_sha256: source.sha256,
  });
}

function analyzerPackage(
  sdkRoot: string,
  launcher: string,
): { root: string; expectedVersion?: string } {
  const relative = path.relative(sdkRoot, launcher).split(path.sep).join("/");
  let match = /^cmdline-tools\/([0-9]+(?:\.[0-9]+)*)\/bin\/apkanalyzer$/.exec(relative);
  if (match?.[1]) {
    return { root: path.join(sdkRoot, "cmdline-tools", match[1]), expectedVersion: match[1] };
  }
  match = /^cmdline-tools\/latest\/bin\/apkanalyzer$/.exec(relative);
  if (match) return { root: path.join(sdkRoot, "cmdline-tools", "latest") };
  match = /^tools\/bin\/apkanalyzer$/.exec(relative);
  if (match) return { root: path.join(sdkRoot, "tools") };
  throw new Error("local apkanalyzer must belong to one stable SDK command-line tools package");
}

function signerPackage(
  sdkRoot: string,
  launcher: string,
): { root: string; expectedVersion: string } {
  const relative = path.relative(sdkRoot, launcher).split(path.sep).join("/");
  const match = /^build-tools\/([0-9]+(?:\.[0-9]+)*)\/apksigner$/.exec(relative);
  if (!match?.[1]) {
    throw new Error("local apksigner must belong to one stable SDK build-tools package");
  }
  return {
    root: path.join(sdkRoot, "build-tools", match[1]),
    expectedVersion: match[1],
  };
}

function sameExecutable(left: StableExecutable, right: StableExecutable): boolean {
  return left.path === right.path && left.sha256 === right.sha256;
}

async function existingPaths(candidates: readonly string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const candidate of candidates) {
    try {
      const value = await lstat(candidate);
      if (value.isFile() && !value.isSymbolicLink()) existing.push(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return existing;
}

function validateTasks(tasks: readonly string[]): string[] {
  if (tasks.length < 1 || tasks.length > 16) {
    throw new Error("local_trusted requires between 1 and 16 Gradle tasks");
  }
  const normalized = [...tasks];
  if (new Set(normalized).size !== tasks.length || normalized.some((task) => !TASK_RE.test(task))) {
    throw new Error("local_trusted rejected an invalid or duplicate Gradle task");
  }
  return normalized;
}

function toolVersionArgs(tool: "java" | ArtifactTool): readonly string[] {
  if (tool === "java") return ["--version"];
  if (tool === "apkanalyzer") return ["--help"];
  return ["version"];
}

function validateArtifactArgs(tool: ArtifactTool, args: readonly string[]): void {
  const allowed = tool === "apkanalyzer"
    ? new Set([
        "manifest\u0000application-id",
        "manifest\u0000version-name",
        "manifest\u0000version-code",
        "manifest\u0000debuggable",
      ])
    : new Set(["verify\u0000--print-certs"]);
  if (args.length !== 2 || !allowed.has(args.join("\u0000"))) {
    throw new Error(`local_trusted rejected unsupported ${tool} arguments`);
  }
}

function pinFilesystemIdentity(value: Stats): PinnedFilesystemIdentity {
  return {
    dev: value.dev,
    ino: value.ino,
    uid: value.uid,
    gid: value.gid,
    mode: value.mode,
    nlink: value.nlink,
    size: value.size,
  };
}

function samePinnedIdentity(
  value: Stats,
  expected: PinnedFilesystemIdentity,
  options: { mutableDirectoryEntries?: boolean } = {},
): boolean {
  return value.dev === expected.dev
    && value.ino === expected.ino
    && value.uid === expected.uid
    && value.gid === expected.gid
    && value.mode === expected.mode
    && (options.mutableDirectoryEntries || value.nlink === expected.nlink)
    && (options.mutableDirectoryEntries || value.size === expected.size);
}

function mergeOperationCleanupError(primary: unknown, cleanup: unknown): unknown {
  if (primary === undefined) return cleanup;
  return new AggregateError(
    [primary, cleanup],
    "local_trusted operation failed and private-root cleanup could not be proven",
  );
}

export class LocalTrustedBackend implements BuildBackend {
  readonly backend = "local_trusted" as const;
  readonly config: LocalTrustedRunnerConfig;
  readonly #processRunner: Pick<ProcessRunner, "run" | "close">;
  readonly #platform: NodeJS.Platform;
  readonly #uid: number | undefined;
  readonly #architecture: string;
  readonly #ownedRoots = new Map<string, OwnedRoot>();
  readonly #cleanupPromises = new Map<string, Promise<void>>();
  readonly #idleWaiters = new Set<() => void>();
  #toolchain?: InitializedToolchain;
  #initialization?: Promise<void>;
  #activeOperations = 0;
  #poisoned = false;
  #state: "open" | "closing" | "closed" = "open";
  #closePromise?: Promise<void>;

  constructor(
    config: LocalTrustedRunnerConfig,
    dependencies: LocalTrustedBackendDependencies = {},
  ) {
    this.config = Object.freeze({ ...config });
    this.#processRunner = dependencies.testOnlyProcessRunner ?? new ProcessRunner();
    this.#platform = dependencies.testOnlyPlatform ?? process.platform;
    this.#uid = dependencies.testOnlyUid ?? process.getuid?.();
    this.#architecture = dependencies.testOnlyArchitecture ?? process.arch;
  }

  #assertSupportedHost(): void {
    if (this.#platform !== "darwin" && this.#platform !== "linux") {
      throw new Error(`local_trusted is unsupported on ${this.#platform}`);
    }
    if (!Number.isSafeInteger(this.#uid) || this.#uid === undefined || this.#uid <= 0) {
      throw new Error("local_trusted requires a non-root numeric uid");
    }
    if (!this.#architecture || /[\u0000-\u001f\u007f]/.test(this.#architecture)) {
      throw new Error("local_trusted requires a stable host architecture identity");
    }
  }

  #beginOperation(): void {
    if (this.#state !== "open") throw new Error("local_trusted backend is closing or closed");
    if (this.#poisoned) {
      throw new Error("local_trusted backend cleanup is unresolved and the backend is poisoned");
    }
    this.#activeOperations += 1;
  }

  #endOperation(): void {
    this.#activeOperations -= 1;
    if (this.#activeOperations < 0) throw new Error("local backend operation accounting underflow");
    if (this.#activeOperations !== 0) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }

  async #waitUntilIdle(): Promise<void> {
    if (this.#activeOperations === 0) return;
    await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
  }

  async initialize(): Promise<void> {
    if (this.#state !== "open") throw new Error("local_trusted backend is closing or closed");
    if (this.#poisoned) {
      throw new Error("local_trusted backend cleanup is unresolved and the backend is poisoned");
    }
    if (this.#toolchain) return;
    if (this.#initialization) return this.#initialization;
    this.#beginOperation();
    const initialization = this.#initializeInternal();
    this.#initialization = initialization;
    try {
      await initialization;
    } finally {
      if (this.#initialization === initialization) this.#initialization = undefined;
      this.#endOperation();
    }
  }

  async #initializeInternal(): Promise<void> {
    this.#assertSupportedHost();
    const javaHome = await canonicalTrustedDirectory(
      this.config.javaHome,
      "local Java home",
      LOCAL_TOOLCHAIN_ANCESTOR_POLICY,
    );
    const androidSdkRoot = await canonicalTrustedDirectory(
      this.config.androidSdkRoot,
      "local Android SDK root",
      LOCAL_TOOLCHAIN_ANCESTOR_POLICY,
    );
    const java = await hashStableExecutable(path.join(javaHome, "bin", "java"), "local Java executable");
    const apkAnalyzer = await hashStableExecutable(this.config.apkAnalyzer, "local apkanalyzer");
    const apkSigner = await hashStableExecutable(this.config.apkSigner, "local apksigner");
    if (!java.path.startsWith(`${javaHome}${path.sep}`)) {
      throw new Error("local Java executable escaped JAVA_HOME");
    }
    if (
      !apkAnalyzer.path.startsWith(`${androidSdkRoot}${path.sep}`)
      || !apkSigner.path.startsWith(`${androidSdkRoot}${path.sep}`)
    ) {
      throw new Error("local Android inspection tools must stay inside the configured SDK root");
    }
    const javaRelease = await hashStableTrustedFile(
      path.join(javaHome, "release"),
      "local Java release metadata",
      1024 * 1024,
    );
    const javaRuntimeCandidates = await existingPaths([
      path.join(javaHome, "lib", "modules"),
      path.join(javaHome, "jre", "lib", "rt.jar"),
    ]);
    if (javaRuntimeCandidates.length !== 1) {
      throw new Error("local Java home must expose exactly one supported core runtime identity");
    }
    const javaRuntime = await hashStableTrustedFile(
      javaRuntimeCandidates[0]!,
      "local Java core runtime",
      512 * 1024 * 1024,
    );
    const analyzer = analyzerPackage(androidSdkRoot, apkAnalyzer.path);
    const apkAnalyzerPackageRoot = await canonicalTrustedDirectory(
      analyzer.root,
      "local apkanalyzer package",
      LOCAL_TOOLCHAIN_ANCESTOR_POLICY,
    );
    const apkAnalyzerPackageSha256 = await packageIdentity(
      apkAnalyzerPackageRoot,
      analyzer.expectedVersion,
      "local apkanalyzer package",
    );
    await hashStableTrustedFile(
      path.join(apkAnalyzerPackageRoot, "lib", "apkanalyzer-classpath.jar"),
      "local apkanalyzer classpath manifest",
      256 * 1024 * 1024,
    );
    const apkAnalyzerImplementationSha256 = await hashTrustedTree(
      path.join(apkAnalyzerPackageRoot, "lib"),
      "local apkanalyzer implementation",
    );
    const signer = signerPackage(androidSdkRoot, apkSigner.path);
    const apkSignerPackageRoot = await canonicalTrustedDirectory(
      signer.root,
      "local apksigner package",
      LOCAL_TOOLCHAIN_ANCESTOR_POLICY,
    );
    const apkSignerPackageSha256 = await packageIdentity(
      apkSignerPackageRoot,
      signer.expectedVersion,
      "local apksigner package",
    );
    const apkSignerImplementation = await hashStableTrustedFile(
      path.join(apkSignerPackageRoot, "lib", "apksigner.jar"),
      "local apksigner implementation",
      256 * 1024 * 1024,
    );
    if (this.#state !== "open") throw new Error("local_trusted backend closed during initialization");
    this.#toolchain = Object.freeze({
      javaHome,
      androidSdkRoot,
      java,
      javaRelease,
      javaRuntime,
      apkAnalyzer,
      apkAnalyzerPackageRoot,
      ...(analyzer.expectedVersion
        ? { apkAnalyzerExpectedVersion: analyzer.expectedVersion }
        : {}),
      apkAnalyzerPackageSha256,
      apkAnalyzerImplementationSha256,
      apkSigner,
      apkSignerPackageRoot,
      apkSignerPackageSha256,
      apkSignerImplementationSha256: apkSignerImplementation.sha256,
    });
  }

  async close(): Promise<void> {
    if (this.#state === "closed") return;
    if (this.#closePromise) return this.#closePromise;
    this.#state = "closing";
    const closing = this.#closeInternal();
    this.#closePromise = closing;
    try {
      await closing;
      this.#state = "closed";
    } finally {
      if (this.#closePromise === closing) this.#closePromise = undefined;
    }
  }

  async #closeInternal(): Promise<void> {
    await this.#processRunner.close().catch(() => undefined);
    await this.#waitUntilIdle();
    const errors: unknown[] = [];
    try {
      await this.#processRunner.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 0) {
      for (const root of [...this.#ownedRoots.keys()]) {
        try {
          await this.#cleanupOwnedRoot(root);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (this.#ownedRoots.size !== 0) {
      errors.push(new Error("local_trusted retained private roots after shutdown"));
    }
    if (errors.length > 0) throw new AggregateError(errors, "local_trusted cleanup failed");
    this.#poisoned = false;
  }

  async probe(): Promise<CapabilityResult> {
    try {
      await this.initialize();
      this.#beginOperation();
    } catch (error) {
      return {
        available: false,
        backend: "local_trusted",
        reasons: [`LOCAL_TRUSTED_PROBE_FAILED:${cleanDiagnostic(error)}`],
      };
    }
    try {
      const identity = await this.#attestIdentity();
      return {
        available: true,
        backend: "local_trusted",
        reasons: [
          "PROJECT_TRUST_REQUIRED",
          "NETWORK_POLICY_NOT_ENFORCED",
          "FILESYSTEM_WRITE_ISOLATION_NOT_ENFORCED",
          "RESOURCE_LIMITS_NOT_ENFORCED",
        ],
        identity,
      };
    } catch (error) {
      return {
        available: false,
        backend: "local_trusted",
        reasons: [`LOCAL_TRUSTED_PROBE_FAILED:${cleanDiagnostic(error)}`],
      };
    } finally {
      this.#endOperation();
    }
  }

  executionProfile(identity: BackendIdentity): Record<string, unknown> {
    if (identity.backend !== "local_trusted") {
      throw new Error("local_trusted execution profile requires a local identity");
    }
    return {
      ...localExecutionProfileBase(),
      platform: identity.platform,
      architecture: identity.architecture,
      java_ref: identity.javaExecutableSha256,
      java_release_ref: identity.javaReleaseSha256,
      java_runtime_ref: identity.javaRuntimeSha256,
      apkanalyzer_ref: identity.apkAnalyzerSha256,
      apkanalyzer_package_ref: identity.apkAnalyzerPackageSha256,
      apkanalyzer_implementation_ref: identity.apkAnalyzerImplementationSha256,
      apksigner_ref: identity.apkSignerSha256,
      apksigner_package_ref: identity.apkSignerPackageSha256,
      apksigner_implementation_ref: identity.apkSignerImplementationSha256,
      execution_profile_ref: identity.executionProfileSha256,
    };
  }

  async #attestIdentity(): Promise<LocalTrustedIdentity> {
    const toolchain = this.#toolchain;
    if (!toolchain) throw new Error("local_trusted backend is not initialized");
    const java = await hashStableExecutable(toolchain.java.path, "local Java executable");
    const javaRelease = await hashStableTrustedFile(
      toolchain.javaRelease.path,
      "local Java release metadata",
      1024 * 1024,
    );
    const javaRuntime = await hashStableTrustedFile(
      toolchain.javaRuntime.path,
      "local Java core runtime",
      512 * 1024 * 1024,
    );
    const apkAnalyzer = await hashStableExecutable(toolchain.apkAnalyzer.path, "local apkanalyzer");
    const apkSigner = await hashStableExecutable(toolchain.apkSigner.path, "local apksigner");
    const apkAnalyzerPackageSha256 = await packageIdentity(
      toolchain.apkAnalyzerPackageRoot,
      toolchain.apkAnalyzerExpectedVersion,
      "local apkanalyzer package",
    );
    const apkAnalyzerImplementationSha256 = await hashTrustedTree(
      path.join(toolchain.apkAnalyzerPackageRoot, "lib"),
      "local apkanalyzer implementation",
    );
    const apkSignerPackageSha256 = await packageIdentity(
      toolchain.apkSignerPackageRoot,
      path.basename(toolchain.apkSignerPackageRoot),
      "local apksigner package",
    );
    const apkSignerImplementation = await hashStableTrustedFile(
      path.join(toolchain.apkSignerPackageRoot, "lib", "apksigner.jar"),
      "local apksigner implementation",
      256 * 1024 * 1024,
    );
    if (
      !sameExecutable(java, toolchain.java)
      || !sameExecutable(javaRelease, toolchain.javaRelease)
      || !sameExecutable(javaRuntime, toolchain.javaRuntime)
      || !sameExecutable(apkAnalyzer, toolchain.apkAnalyzer)
      || !sameExecutable(apkSigner, toolchain.apkSigner)
      || apkAnalyzerPackageSha256 !== toolchain.apkAnalyzerPackageSha256
      || apkAnalyzerImplementationSha256 !== toolchain.apkAnalyzerImplementationSha256
      || apkSignerPackageSha256 !== toolchain.apkSignerPackageSha256
      || apkSignerImplementation.sha256 !== toolchain.apkSignerImplementationSha256
    ) {
      throw new Error("local trusted toolchain identity drifted after initialization");
    }

    const root = await this.#createOwnedRoot("probe");
    try {
      const environment = await this.#minimalEnvironment(root);
      const javaVersion = await this.#runVersion(java.path, "java", environment);
      const analyzerContract = await this.#runVersion(
        apkAnalyzer.path,
        "apkanalyzer",
        environment,
      );
      const analyzerVersion = domainHashJson(
        "crashfix-local-apkanalyzer-version-contract/v1",
        {
          package_sha256: apkAnalyzerPackageSha256,
          launcher_contract_sha256: analyzerContract,
        },
      );
      const signerVersion = await this.#runVersion(apkSigner.path, "apksigner", environment);
      return {
        backend: "local_trusted",
        platform: this.#platform as "darwin" | "linux",
        architecture: this.#architecture,
        javaExecutableSha256: java.sha256,
        javaReleaseSha256: javaRelease.sha256,
        javaRuntimeSha256: javaRuntime.sha256,
        javaVersionSha256: javaVersion,
        apkAnalyzerSha256: apkAnalyzer.sha256,
        apkAnalyzerPackageSha256,
        apkAnalyzerImplementationSha256,
        apkAnalyzerVersionSha256: analyzerVersion,
        apkSignerSha256: apkSigner.sha256,
        apkSignerPackageSha256,
        apkSignerImplementationSha256: apkSignerImplementation.sha256,
        apkSignerVersionSha256: signerVersion,
        executionProfileSha256: domainHashJson(
          "crashfix-local-trusted-execution-profile/v1",
          localExecutionProfileBase(),
        ),
      };
    } finally {
      await this.#cleanupOwnedRoot(root);
    }
  }

  async #runVersion(
    executable: string,
    tool: "java" | ArtifactTool,
    environment: NodeJS.ProcessEnv,
  ): Promise<string> {
    const result = await this.#processRunner.run(executable, toolVersionArgs(tool), {
      timeoutMs: 10_000,
      maxOutputBytes: INTERNAL_OUTPUT_BYTES,
      env: environment,
    });
    if (result.exitCode !== 0) throw new Error(`${tool} version probe failed`);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (!output) throw new Error(`${tool} version probe returned no identity`);
    if (
      tool === "apkanalyzer"
      && (!output.includes("Usage:") || !output.includes("apkanalyzer"))
    ) {
      throw new Error("apkanalyzer help probe returned an unexpected contract");
    }
    return domainHash(`crashfix-local-${tool}-version/v1`, output);
  }

  async #minimalEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
    const toolchain = this.#toolchain;
    if (!toolchain) throw new Error("local_trusted backend is not initialized");
    const home = path.join(root, "home");
    const temporary = path.join(root, "tmp");
    await mkdir(home, { mode: 0o700 });
    await mkdir(temporary, { mode: 0o700 });
    return {
      HOME: home,
      TMPDIR: temporary,
      JAVA_HOME: toolchain.javaHome,
      ANDROID_HOME: toolchain.androidSdkRoot,
      ANDROID_SDK_ROOT: toolchain.androidSdkRoot,
      PATH: `${path.join(toolchain.javaHome, "bin")}:/usr/bin:/bin`,
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      CI: "true",
    };
  }

  async runBuildCommand(options: BuildCommandOptions): Promise<ProcessResult> {
    await this.initialize();
    this.#beginOperation();
    let root: string | undefined;
    let primaryError: unknown;
    let result: ProcessResult | undefined;
    try {
      const beforeIdentity = await this.#attestIdentity();
      const workspace = await canonicalOwnedDirectory(
        options.workspace,
        "local build workspace",
        { exactMode: 0o700 },
      );
      const projectRelativeDir = options.projectRelativeDir === "."
        ? "."
        : normalizeRelativePath(options.projectRelativeDir, "project_relative_dir");
      const project = await existingDirectoryInside(
        workspace,
        projectRelativeDir,
        "local Gradle project directory",
      );
      const gradlew = await existingRegularFileInside(
        project,
        "gradlew",
        "local Gradle wrapper",
        1024 * 1024,
      );
      await access(gradlew.path, fsConstants.X_OK);
      const tasks = validateTasks(options.tasks);
      root = await this.#createOwnedRoot("gradle");
      const gradleHome = path.join(root, "gradle-home");
      await mkdir(gradleHome, { mode: 0o700 });
      await this.#copyCacheSeed(options.cacheSeed, gradleHome);
      const environment = await this.#minimalEnvironment(root);
      environment.GRADLE_USER_HOME = gradleHome;
      result = await this.#processRunner.run(
        gradlew.path,
        ["--offline", "--no-daemon", "--console=plain", ...tasks],
        {
          cwd: project,
          env: environment,
          timeoutMs: options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes,
        },
      );
      const gradlewAfter = await existingRegularFileInside(
        project,
        "gradlew",
        "local Gradle wrapper",
        1024 * 1024,
      );
      if (gradlewAfter.sha256 !== gradlew.sha256 || gradlewAfter.size !== gradlew.size) {
        throw new Error("local Gradle wrapper changed during execution");
      }
      const afterIdentity = await this.#attestIdentity();
      if (canonicalJson(beforeIdentity) !== canonicalJson(afterIdentity)) {
        throw new Error("local trusted toolchain identity drifted during execution");
      }
    } catch (error) {
      primaryError = error;
    } finally {
      if (root) {
        try {
          await this.#cleanupOwnedRoot(root);
        } catch (error) {
          primaryError = mergeOperationCleanupError(primaryError, error);
        }
      }
      this.#endOperation();
    }
    if (primaryError) throw primaryError;
    if (!result) throw new Error("local Gradle process did not produce a result");
    return result;
  }

  async runReadOnlyArtifactCommand(options: {
    artifact: string;
    tool: ArtifactTool;
    argsBeforeArtifact: readonly string[];
    timeoutMs?: number;
  }): Promise<ProcessResult> {
    await this.initialize();
    this.#beginOperation();
    let root: string | undefined;
    let primaryError: unknown;
    let result: ProcessResult | undefined;
    try {
      validateArtifactArgs(options.tool, options.argsBeforeArtifact);
      const identityBefore = await this.#attestIdentity();
      const artifactRoot = await canonicalOwnedDirectory(
        path.dirname(options.artifact),
        "local APK staging root",
        { exactMode: 0o700 },
      );
      if (path.basename(options.artifact) !== "artifact.apk") {
        throw new Error("local APK inspector only accepts the private staged artifact name");
      }
      const artifact = await existingRegularFileInside(
        artifactRoot,
        "artifact.apk",
        "local staged APK artifact",
        2 * 1024 * 1024 * 1024,
      );
      root = await this.#createOwnedRoot("artifact");
      const environment = await this.#minimalEnvironment(root);
      const toolchain = this.#toolchain!;
      const executable = options.tool === "apkanalyzer"
        ? toolchain.apkAnalyzer.path
        : toolchain.apkSigner.path;
      result = await this.#processRunner.run(
        executable,
        [...options.argsBeforeArtifact, artifact.path],
        {
          env: environment,
          timeoutMs: options.timeoutMs ?? 30_000,
          maxOutputBytes: INTERNAL_OUTPUT_BYTES,
        },
      );
      const artifactAfter = await existingRegularFileInside(
        artifactRoot,
        "artifact.apk",
        "local staged APK artifact",
        2 * 1024 * 1024 * 1024,
      );
      if (artifactAfter.sha256 !== artifact.sha256 || artifactAfter.size !== artifact.size) {
        throw new Error("local APK artifact changed during inspection");
      }
      const identityAfter = await this.#attestIdentity();
      if (canonicalJson(identityBefore) !== canonicalJson(identityAfter)) {
        throw new Error("local trusted toolchain identity drifted during APK inspection");
      }
    } catch (error) {
      primaryError = error;
    } finally {
      if (root) {
        try {
          await this.#cleanupOwnedRoot(root);
        } catch (error) {
          primaryError = mergeOperationCleanupError(primaryError, error);
        }
      }
      this.#endOperation();
    }
    if (primaryError) throw primaryError;
    if (!result) throw new Error("local APK inspector did not produce a result");
    return result;
  }

  async #copyCacheSeed(cacheSeedInput: string, destination: string): Promise<void> {
    const cacheSeed = await canonicalOwnedDirectory(
      cacheSeedInput,
      "sealed Gradle cache directory",
      { exactMode: 0o500 },
    );
    const files = await listFilesRecursively(cacheSeed, {
      maxFiles: MAX_CACHE_FILES,
      maxBytes: MAX_CACHE_BYTES,
      maxFileBytes: MAX_CACHE_FILE_BYTES,
    });
    for (const relative of files) {
      const source = await existingRegularFileInside(
        cacheSeed,
        relative,
        "sealed Gradle cache entry",
        MAX_CACHE_FILE_BYTES,
        { allowEmpty: true },
      );
      const target = path.join(destination, ...relative.split("/"));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await copyStableRegularFile({
        source: source.path,
        destination: target,
        label: `sealed Gradle cache entry ${relative}`,
        maxBytes: MAX_CACHE_FILE_BYTES,
        expectedSize: source.size,
        expectedSha256: source.sha256,
        expectedSourceMode: source.mode,
        destinationMode: (source.mode & 0o100) !== 0 ? 0o700 : 0o600,
        allowEmpty: true,
      });
      const copied = await existingRegularFileInside(
        destination,
        relative,
        "local Gradle cache overlay entry",
        MAX_CACHE_FILE_BYTES,
        { allowEmpty: true },
      );
      const sourceAfter = await existingRegularFileInside(
        cacheSeed,
        relative,
        "sealed Gradle cache entry",
        MAX_CACHE_FILE_BYTES,
        { allowEmpty: true },
      );
      if (
        copied.sha256 !== source.sha256
        || copied.size !== source.size
        || sourceAfter.sha256 !== source.sha256
        || sourceAfter.size !== source.size
      ) {
        throw new Error("sealed Gradle cache changed while creating its private overlay");
      }
    }
  }

  async #createOwnedRoot(purpose: OwnedRoot["purpose"]): Promise<string> {
    const root = await realpath(await mkdtemp(path.join(
      os.tmpdir(),
      `${LOCAL_ROOT_PREFIX}${purpose}-`,
    )));
    await chmod(root, 0o700);
    const owner = randomBytes(32).toString("hex");
    const descriptor = {
      schema_version: "crashfix-local-private-root/v1",
      kind: "local-trusted-private-root",
      owner,
      purpose,
    };
    try {
      const ownerPath = path.join(root, OWNER_FILE);
      await writeFile(ownerPath, `${canonicalJson(descriptor)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      const rootStat = await lstat(root);
      const ownerStat = await lstat(ownerPath);
      if (
        !rootStat.isDirectory()
        || rootStat.isSymbolicLink()
        || rootStat.uid !== this.#uid
        || (rootStat.mode & 0o7777) !== 0o700
        || !ownerStat.isFile()
        || ownerStat.isSymbolicLink()
        || ownerStat.nlink !== 1
        || ownerStat.uid !== this.#uid
        || (ownerStat.mode & 0o7777) !== 0o600
      ) {
        throw new Error("local_trusted could not pin its private-root identity");
      }
      this.#ownedRoots.set(root, {
        owner,
        purpose,
        rootIdentity: pinFilesystemIdentity(rootStat),
        ownerIdentity: pinFilesystemIdentity(ownerStat),
      });
      return root;
    } catch (error) {
      await rm(root, { recursive: true, force: false }).catch(() => undefined);
      throw error;
    }
  }

  async #cleanupOwnedRoot(root: string): Promise<void> {
    const existing = this.#cleanupPromises.get(root);
    if (existing) return existing;
    const cleanup = this.#cleanupOwnedRootInternal(root);
    this.#cleanupPromises.set(root, cleanup);
    try {
      await cleanup;
    } finally {
      if (this.#cleanupPromises.get(root) === cleanup) this.#cleanupPromises.delete(root);
    }
  }

  async #cleanupOwnedRootInternal(root: string): Promise<void> {
    const expected = this.#ownedRoots.get(root);
    if (!expected) return;
    try {
      const temporaryRoot = await realpath(os.tmpdir());
      if (
        path.dirname(root) !== temporaryRoot
        || !path.basename(root).startsWith(`${LOCAL_ROOT_PREFIX}${expected.purpose}-`)
      ) {
        throw new Error("refusing to clean an unowned local_trusted root");
      }
      const rootStat = await lstat(root);
      if (
        !rootStat.isDirectory()
        || rootStat.isSymbolicLink()
        || !samePinnedIdentity(rootStat, expected.rootIdentity, {
          mutableDirectoryEntries: true,
        })
      ) {
        throw new Error("local_trusted cleanup root identity is invalid");
      }
      if (await realpath(root) !== root) {
        throw new Error("local_trusted cleanup root traversed a link");
      }
      const ownerPath = path.join(root, OWNER_FILE);
      const ownerStat = await lstat(ownerPath);
      if (
        !ownerStat.isFile()
        || ownerStat.isSymbolicLink()
        || !samePinnedIdentity(ownerStat, expected.ownerIdentity)
      ) {
        throw new Error("local_trusted cleanup owner marker drifted");
      }
      const expectedDescriptor = `${canonicalJson({
        schema_version: "crashfix-local-private-root/v1",
        kind: "local-trusted-private-root",
        owner: expected.owner,
        purpose: expected.purpose,
      })}\n`;
      if (await readFile(ownerPath, "utf8") !== expectedDescriptor) {
        throw new Error("local_trusted cleanup owner marker drifted");
      }
      const rootBeforeRemoval = await lstat(root);
      const ownerBeforeRemoval = await lstat(ownerPath);
      if (
        !samePinnedIdentity(rootBeforeRemoval, expected.rootIdentity, {
          mutableDirectoryEntries: true,
        })
        || !samePinnedIdentity(ownerBeforeRemoval, expected.ownerIdentity)
      ) {
        throw new Error("local_trusted cleanup identity drifted before removal");
      }
      await chmod(root, 0o700);
      await rm(root, { recursive: true, force: false });
      try {
        await lstat(root);
        throw new Error("local_trusted cleanup could not prove root absence");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      this.#ownedRoots.delete(root);
      if (this.#ownedRoots.size === 0) this.#poisoned = false;
    } catch (error) {
      this.#poisoned = true;
      throw error;
    }
  }
}
