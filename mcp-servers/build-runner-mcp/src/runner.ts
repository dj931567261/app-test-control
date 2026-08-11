import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, domainHash, shortHash } from "./canonical.js";
import {
  type BackendKind,
  type BuildBackend,
  type CacheMode,
  type CapabilityResult,
  type ExecutionProfileName,
  type FilesystemIsolation,
  type NetworkPolicy,
  type ProcessContainment,
  type VerificationLevel,
  type WorkspaceDiskQuota,
} from "./backend.js";
import {
  disposeStagedApk,
  inspectApk,
  stageApk,
  type ApkInspection,
  type StagedApk,
} from "./apk.js";
import {
  disposeGradleCacheSeed,
  sealGradleCache,
  verifyGradleCacheSeed,
  type CacheSeedIdentity,
} from "./cache-seed.js";
import { loadRunnerConfig } from "./config.js";
import { cleanDiagnostic } from "./diagnostic.js";
import { DockerBackend } from "./docker-backend.js";
import {
  assertLeaseFresh,
  auditWorkspace,
  createEnvironment,
  runtimeIdentity,
  type BuildPhase,
  type BuildRole,
  type EnvironmentLease,
  type EnvironmentPublic,
  type SnapshotAudit,
} from "./environment.js";
import { ProcessRunner } from "./process-runner.js";
import { LocalTrustedBackend } from "./local-trusted-backend.js";

const MAX_COMPLETED_AGE_MS = 15 * 60 * 1000;
const MAX_ENVIRONMENT_LEASES = 8;

interface CompletedRun {
  completedAt: number;
  lease: EnvironmentLease;
  artifact: StagedApk;
}

interface CacheSeedLease extends CacheSeedIdentity {
  id: string;
}

interface RunnerOperations {
  now(): number;
  sealGradleCache: typeof sealGradleCache;
  disposeGradleCacheSeed: typeof disposeGradleCacheSeed;
  createEnvironment: typeof createEnvironment;
  auditWorkspace: typeof auditWorkspace;
  runtimeIdentity: typeof runtimeIdentity;
  verifyGradleCacheSeed: typeof verifyGradleCacheSeed;
  stageApk: typeof stageApk;
  disposeStagedApk: typeof disposeStagedApk;
  inspectApk: typeof inspectApk;
}

const DEFAULT_OPERATIONS: RunnerOperations = {
  now: Date.now,
  sealGradleCache,
  disposeGradleCacheSeed,
  createEnvironment,
  auditWorkspace,
  runtimeIdentity,
  verifyGradleCacheSeed,
  stageApk,
  disposeStagedApk,
  inspectApk,
};

/**
 * Deterministic unit-test seam. The production MCP entry point never accepts or
 * forwards these dependencies; it always constructs the runner with defaults.
 */
export type TrustedBuildRunnerTestDependencies = Partial<RunnerOperations>;

export interface BuildRunResult {
  schema_version: "gradle-build-run/v2";
  environment_id: string;
  backend: BackendKind;
  execution_profile: ExecutionProfileName;
  verification_level: VerificationLevel;
  workspace_role: BuildRole;
  workspace_manifest_sha256: string;
  workspace_canonical_diff_sha256: string;
  status: "passed" | "failed";
  exit_code: number;
  duration_ms: number;
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
  included_source_audit_unchanged: true;
  stdout_sha256: string;
  stderr_sha256: string;
}

function safeError(error: unknown): string {
  return cleanDiagnostic(error);
}

function auditsMatch(left: SnapshotAudit, right: SnapshotAudit): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export class TrustedBuildRunner {
  readonly #backend?: BuildBackend;
  readonly #configuredBackend: BackendKind | "invalid";
  readonly #helperProcessRunner: Pick<ProcessRunner, "run" | "close">;
  readonly #configurationErrors: string[];
  readonly #operations: RunnerOperations;
  readonly #leases = new Map<string, EnvironmentLease>();
  readonly #completed = new Map<string, CompletedRun>();
  readonly #cacheSeeds = new Map<string, CacheSeedLease>();
  readonly #disposingCacheSeedIds = new Set<string>();
  readonly #activeCacheSeedRoots = new Map<string, number>();
  readonly #stagedArtifacts = new Map<string, StagedApk>();
  readonly #idleWaiters = new Set<() => void>();
  #initialization?: Promise<void>;
  #expiry?: Promise<void>;
  #activeOperations = 0;
  #pendingEnvironmentCreations = 0;
  #backendWorkflowActive = false;
  #cacheSealActive = false;
  #state: "open" | "closing" | "closed" = "open";
  #closePromise?: Promise<void>;

  constructor(options: {
    env?: NodeJS.ProcessEnv;
    backend?: BuildBackend;
    testOnlyDependencies?: TrustedBuildRunnerTestDependencies;
    testOnlyHelperProcessRunner?: Pick<ProcessRunner, "run" | "close">;
  } = {}) {
    if ((options.testOnlyDependencies || options.testOnlyHelperProcessRunner) && !options.backend) {
      throw new Error("test-only runner dependencies require an injected backend");
    }
    this.#helperProcessRunner = options.testOnlyHelperProcessRunner ?? new ProcessRunner();
    this.#operations = { ...DEFAULT_OPERATIONS, ...options.testOnlyDependencies };
    if (options.backend) {
      this.#backend = options.backend;
      this.#configuredBackend = options.backend.backend;
      this.#configurationErrors = [];
      return;
    }
    const loaded = loadRunnerConfig(options.env);
    this.#configuredBackend = loaded.requestedBackend;
    this.#configurationErrors = loaded.errors;
    if (loaded.config?.backend === "docker") this.#backend = new DockerBackend(loaded.config);
    if (loaded.config?.backend === "local_trusted") {
      this.#backend = new LocalTrustedBackend(loaded.config);
    }
  }

  async #ready(): Promise<BuildBackend> {
    if (!this.#backend) {
      throw new Error(`build runner configuration unavailable: ${this.#configurationErrors.join(",")}`);
    }
    this.#initialization ??= this.#backend.initialize();
    await this.#initialization;
    return this.#backend;
  }

  #beginOperation(): void {
    if (this.#state !== "open") throw new Error("build runner is closing or closed");
    this.#activeOperations += 1;
  }

  #endOperation(): void {
    this.#activeOperations -= 1;
    if (this.#activeOperations < 0) throw new Error("build runner operation accounting underflow");
    if (this.#activeOperations !== 0) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }

  async #waitUntilIdle(): Promise<void> {
    if (this.#activeOperations === 0) return;
    await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
  }

  async #disposeStagedArtifact(artifact: StagedApk): Promise<void> {
    await this.#operations.disposeStagedApk(artifact);
    this.#stagedArtifacts.delete(artifact.root);
  }

  async #expire(): Promise<void> {
    if (this.#expiry) return this.#expiry;
    const expiry = this.#expireInternal();
    this.#expiry = expiry;
    try {
      await expiry;
    } finally {
      if (this.#expiry === expiry) this.#expiry = undefined;
    }
  }

  async #expireInternal(): Promise<void> {
    const now = this.#operations.now();
    for (const [id, lease] of this.#leases) {
      if (now - lease.createdAt > MAX_COMPLETED_AGE_MS) this.#leases.delete(id);
    }
    for (const [id, run] of this.#completed) {
      if (now - run.completedAt > MAX_COMPLETED_AGE_MS) {
        await this.#disposeStagedArtifact(run.artifact);
        if (this.#completed.get(id) === run) this.#completed.delete(id);
      }
    }
  }

  #beginBackendWorkflow(): void {
    if (this.#backendWorkflowActive) {
      throw new Error("another trusted build-backend workflow is already active");
    }
    this.#backendWorkflowActive = true;
  }

  #endBackendWorkflow(): void {
    if (!this.#backendWorkflowActive) {
      throw new Error("build-backend workflow accounting underflow");
    }
    this.#backendWorkflowActive = false;
  }

  #reserveEnvironmentCreation(): void {
    if (this.#leases.size + this.#pendingEnvironmentCreations >= MAX_ENVIRONMENT_LEASES) {
      throw new Error(`build environment lease limit reached (${MAX_ENVIRONMENT_LEASES})`);
    }
    this.#pendingEnvironmentCreations += 1;
  }

  #releaseEnvironmentCreation(): void {
    this.#pendingEnvironmentCreations -= 1;
    if (this.#pendingEnvironmentCreations < 0) {
      throw new Error("build environment creation accounting underflow");
    }
  }

  #beginCacheUse(root: string): void {
    this.#activeCacheSeedRoots.set(root, (this.#activeCacheSeedRoots.get(root) ?? 0) + 1);
  }

  #endCacheUse(root: string): void {
    const current = this.#activeCacheSeedRoots.get(root);
    if (current === undefined) throw new Error("cache seed use accounting underflow");
    if (current === 1) this.#activeCacheSeedRoots.delete(root);
    else this.#activeCacheSeedRoots.set(root, current - 1);
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
    const errors: unknown[] = [];
    let backendError: unknown;
    let helperError: unknown;
    // Start both containment shutdowns before waiting for admitted work. This
    // aborts a snapshot audit and a Docker create/start concurrently, and also
    // closes admission for an operation which yielded before reaching either.
    const initialClosures = await Promise.allSettled([
      this.#helperProcessRunner.close(),
      ...(this.#backend ? [this.#backend.close()] : []),
    ]);
    if (initialClosures[0]?.status === "rejected") {
      helperError = initialClosures[0].reason;
    }
    if (this.#backend && initialClosures[1]?.status === "rejected") {
      backendError = initialClosures[1].reason;
    }

    await this.#waitUntilIdle();

    // An operation admitted before `closing` may have reached backend code or
    // the local helper after the first close pass began. Re-run both retained
    // lifecycle owners after all such operations have settled. Neither path
    // constructs a replacement runner or falls back to a module singleton.
    const finalClosures = await Promise.allSettled([
      this.#helperProcessRunner.close(),
      ...(this.#backend ? [this.#backend.close()] : []),
    ]);
    helperError = finalClosures[0]?.status === "rejected"
      ? finalClosures[0].reason
      : undefined;
    if (this.#backend) {
      backendError = finalClosures[1]?.status === "rejected"
        ? finalClosures[1].reason
        : undefined;
    }
    if (helperError) errors.push(helperError);
    if (backendError) errors.push(backendError);

    this.#leases.clear();
    this.#cacheSeeds.clear();
    this.#completed.clear();
    for (const artifact of [...this.#stagedArtifacts.values()]) {
      try {
        await this.#disposeStagedArtifact(artifact);
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.#activeCacheSeedRoots.size > 0) {
      errors.push(new Error("cache seed use remained active after runner shutdown"));
    }
    if (this.#disposingCacheSeedIds.size > 0) {
      errors.push(new Error("cache seed disposal remained active after runner shutdown"));
    }
    if (this.#pendingEnvironmentCreations !== 0) {
      errors.push(new Error("environment creation remained active after runner shutdown"));
    }
    if (this.#backendWorkflowActive) {
      errors.push(new Error("build-backend workflow remained active after runner shutdown"));
    }
    if (this.#cacheSealActive) {
      errors.push(new Error("cache sealing remained active after runner shutdown"));
    }
    if (this.#expiry) {
      errors.push(new Error("resource expiry remained active after runner shutdown"));
    }
    if (errors.length > 0) throw new AggregateError(errors, "build runner cleanup failed");
  }

  async probeCapabilities(): Promise<Record<string, unknown>> {
    if (this.#state !== "open") {
      return this.#unavailableCapability(
        this.#configuredBackend,
        ["RUNNER_CLOSING_OR_CLOSED"],
      );
    }
    this.#beginOperation();
    let workflowAdmitted = false;
    try {
    if (!this.#backend) {
      return this.#unavailableCapability(
        this.#configuredBackend,
        this.#configurationErrors.map((error) => `CONFIG_INVALID:${safeError(error)}`),
      );
    }
    try {
      this.#beginBackendWorkflow();
      workflowAdmitted = true;
      const backend = await this.#ready();
      const result = await backend.probe();
      return this.#publicCapability(result);
    } catch (error) {
      return this.#unavailableCapability(
        this.#configuredBackend,
        [`PROBE_FAILED:${safeError(error)}`],
      );
    }
    } finally {
      try {
        if (workflowAdmitted) this.#endBackendWorkflow();
      } finally {
        this.#endOperation();
      }
    }
  }

  #unavailableCapability(
    backend: BackendKind | "invalid",
    reasons: string[],
  ): Record<string, unknown> {
    const docker = backend === "docker";
    const invalid = backend === "invalid";
    return {
      schema_version: "build-runner-capabilities/v2",
      available: false,
      backend,
      execution_profile: backend === "docker"
        ? "docker_strict"
        : backend === "local_trusted"
          ? "local_trusted"
          : "invalid",
      local_trusted_execution_eligible: false,
      auto_patch_eligible: false,
      strong_isolation: false,
      network_policy: invalid || docker ? "unavailable" : "not_enforced",
      workspace_disk_quota: { enforced: false, mechanism: "none" },
      filesystem_write_isolation: invalid || docker ? "unavailable" : "not_enforced",
      secret_environment_isolation: "unavailable",
      secret_filesystem_isolation: invalid || docker ? "unavailable" : "not_enforced",
      process_containment: invalid || docker ? "unavailable" : "process_group_best_effort",
      project_trust_required: backend === "local_trusted",
      requires_explicit_trust: backend === "local_trusted",
      requires_per_run_approval: true,
      cache_mode: "unavailable",
      verification_level: "unavailable",
      reasons,
      max_command_seconds: 60,
    };
  }

  #publicCapability(result: CapabilityResult): Record<string, unknown> {
    if (!result.available) return this.#unavailableCapability(result.backend, result.reasons);
    if (result.backend === "docker") {
      return {
        schema_version: "build-runner-capabilities/v2",
        available: true,
        backend: "docker",
        execution_profile: "docker_strict",
        local_trusted_execution_eligible: false,
        auto_patch_eligible: true,
        strong_isolation: true,
        network_policy: "denied",
        workspace_disk_quota: { enforced: true, mechanism: "attested" },
        filesystem_write_isolation: "enforced",
        secret_environment_isolation: "allowlist",
        secret_filesystem_isolation: "enforced",
        process_containment: "container+process_group",
        project_trust_required: false,
        requires_explicit_trust: false,
        requires_per_run_approval: true,
        cache_mode: "sealed_seed_readonly_overlay",
        verification_level: "strong_isolation",
        reasons: result.reasons,
        max_command_seconds: 60,
        image_ref: shortHash(result.identity.dockerImageDigest),
        runner_platform: result.identity.platform,
        security_options_ref: shortHash(result.identity.securityOptionsSha256),
        oci_runtime: result.identity.ociRuntime,
        oci_runtime_ref: shortHash(result.identity.ociRuntimeDescriptorSha256),
      };
    }
    return {
      schema_version: "build-runner-capabilities/v2",
      available: true,
      backend: "local_trusted",
      execution_profile: "local_trusted",
      local_trusted_execution_eligible: true,
      auto_patch_eligible: false,
      strong_isolation: false,
      network_policy: "not_enforced",
      workspace_disk_quota: { enforced: false, mechanism: "none" },
      filesystem_write_isolation: "not_enforced",
      secret_environment_isolation: "allowlist",
      secret_filesystem_isolation: "not_enforced",
      process_containment: "process_group_best_effort",
      project_trust_required: true,
      requires_explicit_trust: true,
      requires_per_run_approval: true,
      cache_mode: "sealed_seed_disposable_copy",
      verification_level: "trusted_local",
      reasons: result.reasons,
      max_command_seconds: 60,
      runner_platform: result.identity.platform,
      runner_architecture: result.identity.architecture,
      java_ref: shortHash(result.identity.javaExecutableSha256),
      java_release_ref: shortHash(result.identity.javaReleaseSha256),
      java_runtime_ref: shortHash(result.identity.javaRuntimeSha256),
      apkanalyzer_ref: shortHash(result.identity.apkAnalyzerSha256),
      apkanalyzer_package_ref: shortHash(result.identity.apkAnalyzerPackageSha256),
      apkanalyzer_implementation_ref:
        shortHash(result.identity.apkAnalyzerImplementationSha256),
      apksigner_ref: shortHash(result.identity.apkSignerSha256),
      apksigner_package_ref: shortHash(result.identity.apkSignerPackageSha256),
      apksigner_implementation_ref: shortHash(result.identity.apkSignerImplementationSha256),
      execution_profile_ref: shortHash(result.identity.executionProfileSha256),
    };
  }

  async sealGradleCache(sourceGradleHome: string): Promise<Record<string, unknown>> {
    this.#beginOperation();
    let workflowAdmitted = false;
    let sealAdmitted = false;
    try {
      this.#beginBackendWorkflow();
      workflowAdmitted = true;
      if (this.#cacheSealActive) {
        throw new Error("Gradle cache sealing is already in progress");
      }
      if (this.#cacheSeeds.size > 0) {
        throw new Error("this runner process already retains a Gradle cache seed");
      }
      if (this.#disposingCacheSeedIds.size > 0) {
        throw new Error("Gradle cache seed cleanup is still in progress");
      }
      this.#cacheSealActive = true;
      sealAdmitted = true;

      const backend = await this.#ready();
      const capability = await backend.probe();
      if (
        !capability.available
        || capability.backend !== backend.backend
        || capability.identity.backend !== backend.backend
      ) {
        throw new Error("configured build backend must pass before sealing a dependency cache");
      }
      const sealed = await this.#operations.sealGradleCache(sourceGradleHome);
      if (this.#cacheSeeds.size > 0 || this.#disposingCacheSeedIds.size > 0) {
        throw new Error("Gradle cache seed capacity changed while sealing");
      }
      let id: string;
      do id = randomUUID(); while (this.#cacheSeeds.has(id));
      this.#cacheSeeds.set(id, { ...sealed, id });
      return {
        schema_version: "gradle-cache-seed-created/v1",
        cache_seed_id: id,
        cache_seed_ref: shortHash(sealed.manifestSha256),
        files: sealed.files,
        bytes: sealed.bytes,
        included_roots: ["caches/modules-2", "wrapper/dists"],
        excluded_sensitive_config: true,
        cleanup_requires_confirmation: true,
      };
    } finally {
      if (sealAdmitted) this.#cacheSealActive = false;
      try {
        if (workflowAdmitted) this.#endBackendWorkflow();
      } finally {
        this.#endOperation();
      }
    }
  }

  async disposeGradleCache(cacheSeedId: string): Promise<Record<string, unknown>> {
    this.#beginOperation();
    try {
      if (this.#disposingCacheSeedIds.has(cacheSeedId)) {
        throw new Error("cache seed disposal is already in progress");
      }
      const cacheSeed = this.#cacheSeeds.get(cacheSeedId);
      if (!cacheSeed) throw new Error("unknown cache seed id for this runner process");
      if ([...this.#leases.values()].some((lease) => lease.cacheSeed.root === cacheSeed.root)) {
        throw new Error("cache seed is still bound to an unconsumed build environment");
      }
      if (this.#activeCacheSeedRoots.has(cacheSeed.root)) {
        throw new Error("cache seed is still used by an active build run");
      }

      // Remove the opaque id from admission synchronously before the first
      // filesystem await. A concurrent create can therefore either acquire the
      // cache-use reference first (and block disposal above) or fail lookup;
      // it can never bind a seed while that seed is being deleted.
      this.#disposingCacheSeedIds.add(cacheSeedId);
      this.#cacheSeeds.delete(cacheSeedId);
      try {
        await this.#operations.disposeGradleCacheSeed(
          cacheSeed.root,
          cacheSeed.manifestSha256,
        );
        return {
          schema_version: "gradle-cache-seed-disposed/v1",
          cache_seed_id: cacheSeedId,
          cache_seed_ref: shortHash(cacheSeed.manifestSha256),
          disposed: true,
        };
      } catch (error) {
        // Verification/removal failed, so retain the opaque binding for an
        // explicit retry. Runner close waits for this operation before clearing
        // published ids.
        this.#cacheSeeds.set(cacheSeedId, cacheSeed);
        throw error;
      } finally {
        this.#disposingCacheSeedIds.delete(cacheSeedId);
      }
    } finally {
      this.#endOperation();
    }
  }

  async createBuildEnvironment(options: {
    expectedBackend: BackendKind;
    role: BuildRole;
    phase: BuildPhase;
    workspaceRoot: string;
    snapshotRoot: string;
    expectedSourceSnapshotSha256: string;
    expectedWorkspaceManifestSha256: string;
    expectedWorkspaceCanonicalDiffSha256: string;
    cacheSeedId: string;
    projectRelativeDir: string;
    artifactRelativePath?: string;
    expectedSignerCertificateSha256?: string;
    tasks: readonly string[];
  }): Promise<EnvironmentPublic> {
    this.#beginOperation();
    let workflowAdmitted = false;
    let creationReserved = false;
    let cacheUseStarted = false;
    let cacheSeed: CacheSeedLease | undefined;
    try {
      this.#beginBackendWorkflow();
      workflowAdmitted = true;
      await this.#expire();
      cacheSeed = this.#cacheSeeds.get(options.cacheSeedId);
      if (!cacheSeed) throw new Error("unknown cache seed id for this runner process");
      this.#reserveEnvironmentCreation();
      creationReserved = true;
      this.#beginCacheUse(cacheSeed.root);
      cacheUseStarted = true;

      const backend = await this.#ready();
      const {
        cacheSeedId: _cacheSeedId,
        ...environmentOptions
      } = options;
      const created = await this.#operations.createEnvironment({
        backend,
        helperProcessRunner: this.#helperProcessRunner,
        ...environmentOptions,
        cacheSeedRoot: cacheSeed.root,
        expectedCacheSeedManifestSha256: cacheSeed.manifestSha256,
      });
      if (this.#leases.has(created.lease.id) || this.#completed.has(created.lease.id)) {
        throw new Error("opaque build environment id collision");
      }
      this.#leases.set(created.lease.id, created.lease);
      return created.public;
    } finally {
      try {
        if (cacheUseStarted && cacheSeed) this.#endCacheUse(cacheSeed.root);
      } finally {
        try {
          if (creationReserved) this.#releaseEnvironmentCreation();
        } finally {
          try {
            if (workflowAdmitted) this.#endBackendWorkflow();
          } finally {
            this.#endOperation();
          }
        }
      }
    }
  }

  async runGradle(environmentId: string): Promise<BuildRunResult> {
    this.#beginOperation();
    let workflowAdmitted = false;
    try {
      this.#beginBackendWorkflow();
      workflowAdmitted = true;
      await this.#expire();
      const lease = this.#leases.get(environmentId);
      if (!lease) throw new Error("unknown, expired, or already consumed build environment");
      if (
        lease.phase === "build"
        && (this.#completed.size > 0 || this.#stagedArtifacts.size > 0)
      ) {
        throw new Error("a completed APK is pending inspection or cleanup");
      }
      assertLeaseFresh(lease, this.#operations.now());
      this.#leases.delete(environmentId);
      this.#beginCacheUse(lease.cacheSeed.root);
      try {
        return await this.#runGradleLease(environmentId, lease);
      } finally {
        this.#endCacheUse(lease.cacheSeed.root);
      }
    } finally {
      try {
        if (workflowAdmitted) this.#endBackendWorkflow();
      } finally {
        this.#endOperation();
      }
    }
  }

  async #runGradleLease(
    environmentId: string,
    lease: EnvironmentLease,
  ): Promise<BuildRunResult> {
    const backend = await this.#ready();
    const capability = await backend.probe();
    if (
      !capability.available
      || capability.backend !== backend.backend
      || capability.identity.backend !== backend.backend
    ) {
      throw new Error("configured build backend became unavailable");
    }
    if (canonicalJson(capability.identity) !== canonicalJson(lease.backendIdentity)) {
      throw new Error("configured build backend identity drifted after environment creation");
    }
    if (await this.#operations.runtimeIdentity() !== lease.environment.runner_identity_sha256) {
      throw new Error("build runner runtime identity drifted after environment creation");
    }
    const immediateAudit = await this.#operations.auditWorkspace({
      helperProcessRunner: this.#helperProcessRunner,
      workspaceRoot: lease.workspaceRoot,
      snapshotRoot: lease.snapshotRoot,
      expectedSourceSnapshotSha256: lease.expectedSourceSnapshotSha256,
      role: lease.role,
    });
    if (!auditsMatch(lease.preAudit, immediateAudit)) {
      throw new Error("build workspace drifted after environment creation");
    }
    if (lease.artifactRelativePath) {
      try {
        await lstat(path.join(lease.workspaceDir, ...lease.artifactRelativePath.split("/")));
        throw new Error("bound APK artifact appeared before its build environment was consumed");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const cacheBefore = await this.#operations.verifyGradleCacheSeed(
      lease.cacheSeed.root,
      lease.cacheSeed.manifestSha256,
    );
    if (cacheBefore.cacheDir !== lease.cacheSeed.cacheDir) {
      throw new Error("sealed cache seed path identity drifted after environment creation");
    }
    let result: Awaited<ReturnType<BuildBackend["runBuildCommand"]>> | undefined;
    let executionError: unknown;
    try {
      result = await backend.runBuildCommand({
        workspace: lease.workspaceDir,
        cacheSeed: lease.cacheSeed.cacheDir,
        projectRelativeDir: lease.projectRelativeDir,
        tasks: lease.tasks,
        timeoutMs: 60_000,
        maxOutputBytes: backend.config.maxOutputBytes,
      });
    } catch (error) {
      executionError = error;
    }

    // A timeout or containment-cleanup failure can happen after the project has
    // already executed. Always re-attest both writable source and the read-only
    // cache before returning or propagating the primary failure.
    let attestationError: unknown;
    try {
      const postAudit = await this.#operations.auditWorkspace({
        helperProcessRunner: this.#helperProcessRunner,
        workspaceRoot: lease.workspaceRoot,
        snapshotRoot: lease.snapshotRoot,
        expectedSourceSnapshotSha256: lease.expectedSourceSnapshotSha256,
        role: lease.role,
      });
      if (!auditsMatch(immediateAudit, postAudit)) {
        throw new Error("project command modified included source outside its approved diff");
      }
      const cacheAfter = await this.#operations.verifyGradleCacheSeed(
        lease.cacheSeed.root,
        lease.cacheSeed.manifestSha256,
      );
      if (cacheAfter.cacheDir !== cacheBefore.cacheDir) {
        throw new Error("sealed cache seed path identity drifted during the build");
      }
    } catch (error) {
      attestationError = error;
    }
    if (executionError || attestationError) {
      throw new Error(
        executionError && attestationError
          ? "Gradle containment and mandatory post-run attestation both failed"
          : executionError
            ? "Gradle containment failed; mandatory post-run attestation completed"
            : "mandatory post-run attestation failed",
        { cause: attestationError ?? executionError },
      );
    }
    if (!result) throw new Error("Gradle process did not produce a result");
    if (result.exitCode === null) throw new Error("Gradle process ended without an exit code");
    if (result.exitCode === 0 && lease.phase === "build") {
      if (!lease.artifactRelativePath) throw new Error("build lease omitted its bound APK artifact");
      const artifact = await this.#operations.stageApk({
        workspaceDir: lease.workspaceDir,
        artifactRelativePath: lease.artifactRelativePath,
      });
      if (this.#stagedArtifacts.has(artifact.root)) {
        await this.#operations.disposeStagedApk(artifact);
        throw new Error("private APK staging identity collision");
      }
      this.#stagedArtifacts.set(artifact.root, artifact);
      this.#completed.set(environmentId, {
        completedAt: this.#operations.now(),
        lease,
        artifact,
      });
    }
    return {
      schema_version: "gradle-build-run/v2",
      environment_id: environmentId,
      backend: lease.environment.backend,
      execution_profile: lease.environment.execution_profile,
      verification_level: lease.environment.verification_level,
      workspace_role: lease.preAudit.role,
      workspace_manifest_sha256: lease.preAudit.currentManifestSha256,
      workspace_canonical_diff_sha256: lease.preAudit.canonicalDiffSha256,
      status: result.exitCode === 0 ? "passed" : "failed",
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
      build_environment_sha256: lease.buildEnvironmentSha256,
      command_argv_sha256: lease.environment.command_argv_sha256,
      network_policy: lease.environment.network_policy,
      strong_isolation: lease.environment.strong_isolation,
      filesystem_write_isolation: lease.environment.filesystem_write_isolation,
      secret_filesystem_isolation: lease.environment.secret_filesystem_isolation,
      process_containment: lease.environment.process_containment,
      workspace_disk_quota: lease.environment.workspace_disk_quota,
      cache_mode: lease.environment.cache_mode,
      environment_allowlist_sha256: lease.environment.environment_allowlist_sha256,
      requires_explicit_trust: lease.environment.requires_explicit_trust,
      included_source_audit_unchanged: true,
      stdout_sha256: domainHash(
        "crashfix-build-stdout-raw-sha256/v2",
        result.stdoutRawSha256,
      ),
      stderr_sha256: domainHash(
        "crashfix-build-stderr-raw-sha256/v2",
        result.stderrRawSha256,
      ),
    };
  }

  async inspectApk(environmentId: string): Promise<ApkInspection & {
    environment_id: string;
    build_environment_sha256: string;
    inspector_backend: BackendKind;
    inspector_isolated: boolean;
    verification_level: VerificationLevel;
    signer_identity_binding: "approved-non-production";
  }> {
    this.#beginOperation();
    let workflowAdmitted = false;
    try {
      this.#beginBackendWorkflow();
      workflowAdmitted = true;
      await this.#expire();
      const completed = this.#completed.get(environmentId);
      if (!completed) throw new Error("APK inspection requires a recent completed build run");
      this.#completed.delete(environmentId);
      try {
        const backend = await this.#ready();
        const capability = await backend.probe();
        if (
          !capability.available
          || capability.backend !== backend.backend
          || capability.identity.backend !== backend.backend
          || canonicalJson(capability.identity) !== canonicalJson(completed.lease.backendIdentity)
        ) {
          throw new Error("configured build backend identity drifted before APK inspection");
        }
        if (
          await this.#operations.runtimeIdentity()
          !== completed.lease.environment.runner_identity_sha256
        ) {
          throw new Error("build runner runtime identity drifted before APK inspection");
        }
        const inspected = await this.#operations.inspectApk({
          backend,
          workspaceDir: completed.artifact.root,
          artifactRelativePath: completed.artifact.relativePath,
          tasks: completed.lease.tasks,
        });
        if (
          inspected.artifact_sha256 !== completed.artifact.sha256
          || inspected.bytes !== completed.artifact.bytes
        ) {
          throw new Error("staged APK identity drifted before inspection");
        }
        if (
          !completed.lease.expectedSignerCertificateSha256
          || inspected.signer_certificate_sha256.length !== 1
          || inspected.signer_certificate_sha256[0]
            !== completed.lease.expectedSignerCertificateSha256
        ) {
          throw new Error("APK signer does not match the approved non-production test identity");
        }
        return {
          ...inspected,
          environment_id: environmentId,
          build_environment_sha256: completed.lease.buildEnvironmentSha256,
          inspector_backend: completed.lease.environment.backend,
          inspector_isolated: completed.lease.environment.strong_isolation,
          verification_level: completed.lease.environment.verification_level,
          signer_identity_binding: "approved-non-production",
        };
      } finally {
        await this.#disposeStagedArtifact(completed.artifact);
      }
    } finally {
      try {
        if (workflowAdmitted) this.#endBackendWorkflow();
      } finally {
        this.#endOperation();
      }
    }
  }
}
