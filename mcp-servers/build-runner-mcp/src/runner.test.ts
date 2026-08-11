import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type { ApkInspection } from "./apk.js";
import type { CacheSeedIdentity } from "./cache-seed.js";
import type { RunnerConfig } from "./config.js";
import type {
  BuildBackend,
  CapabilityResult,
  DockerIdentity,
} from "./docker-backend.js";
import type {
  BuildPhase,
  BuildRole,
  EnvironmentLease,
  EnvironmentPublic,
  SnapshotAudit,
} from "./environment.js";
import { ProcessRunner, type ProcessResult } from "./process-runner.js";
import {
  TrustedBuildRunner,
  type TrustedBuildRunnerTestDependencies,
} from "./runner.js";

const HASH = "a".repeat(64);
const CACHE_HASH = "b".repeat(64);
const RUNNER_HASH = "c".repeat(64);
const APK_HASH = "d".repeat(64);
const SIGNER_HASH = "e".repeat(64);

function processResult(
  stdout = "",
  stderr = "",
  exitCode = 0,
): ProcessResult {
  return {
    stdout,
    stderr,
    stdoutRawSha256: createHash("sha256").update(Buffer.from(stdout, "utf8")).digest("hex"),
    stderrRawSha256: createHash("sha256").update(Buffer.from(stderr, "utf8")).digest("hex"),
    exitCode,
    signal: null,
    durationMs: 1,
  };
}

const identity: DockerIdentity = {
  backend: "docker",
  dockerClientVersion: "27.0.0",
  dockerServerVersion: "27.0.0",
  dockerCliSha256: "1".repeat(64),
  dockerSocketIdentitySha256: "2".repeat(64),
  ociRuntime: "runc",
  ociRuntimeDescriptorSha256: "3".repeat(64),
  toolchainProbeSha256: "4".repeat(64),
  dockerImageId: "5".repeat(64),
  dockerImageDigest: HASH,
  platform: "linux",
  securityOptionsSha256: "6".repeat(64),
};

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for runner test state");
}

class FakeBackend implements BuildBackend {
  readonly backend = "docker" as const;
  readonly config: RunnerConfig = {
    backend: "docker",
    dockerBin: "/fake/docker",
    dockerHost: "unix:///fake/docker.sock",
    ociRuntime: "runc",
    image: `example/android@sha256:${HASH}`,
    javaHome: "/opt/java/openjdk",
    androidSdkRoot: "/opt/android-sdk",
    apkAnalyzer: "/opt/android-sdk/apkanalyzer",
    apkSigner: "/opt/android-sdk/apksigner",
    maxMemoryMb: 1024,
    maxCpus: 1,
    maxPids: 64,
    gradleHomeMb: 1024,
    tmpMb: 128,
    maxOutputBytes: 4096,
  };

  runStarted = 0;
  probeStarted = 0;
  activeProbes = 0;
  activeRuns = 0;
  maxActiveRuns = 0;
  closeCalls = 0;
  nextProbeGate?: Deferred;
  nextRunGate?: Deferred;

  async initialize(): Promise<void> {}

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  async probe(): Promise<CapabilityResult> {
    this.probeStarted += 1;
    this.activeProbes += 1;
    const gate = this.nextProbeGate;
    this.nextProbeGate = undefined;
    try {
      if (gate) await gate.promise;
      return { available: true, backend: "docker", reasons: [], identity };
    } finally {
      this.activeProbes -= 1;
    }
  }

  executionProfile(): Record<string, unknown> {
    return { backend: "test", network: "none" };
  }

  async runBuildCommand(): Promise<ProcessResult> {
    this.runStarted += 1;
    this.activeRuns += 1;
    this.maxActiveRuns = Math.max(this.maxActiveRuns, this.activeRuns);
    const gate = this.nextRunGate;
    this.nextRunGate = undefined;
    try {
      if (gate) await gate.promise;
      return processResult("ok");
    } finally {
      this.activeRuns -= 1;
    }
  }

  async runReadOnlyArtifactCommand(): Promise<ProcessResult> {
    throw new Error("runner tests inject APK inspection");
  }
}

function audit(role: BuildRole, sourceHash: string): SnapshotAudit {
  return {
    role,
    sourceRefSha256: "7".repeat(64),
    sourceSnapshotSha256: sourceHash,
    currentManifestSha256: "8".repeat(64),
    canonicalDiffSha256: "9".repeat(64),
    clean: true,
    truncated: false,
  };
}

class RunnerHarness {
  now = 1_000_000;
  sealCalls = 0;
  createCalls = 0;
  stageCalls = 0;
  inspectCalls = 0;
  disposeApkCalls = 0;
  disposeCacheCalls = 0;
  createFailures = 0;
  disposeApkFailures = 0;
  sealGate?: Deferred;
  createGate?: Deferred;
  inspectGate?: Deferred;

  readonly cacheSeed: CacheSeedIdentity = {
    root: "/private/test-cache-seed",
    cacheDir: "/private/test-cache-seed/cache",
    manifestSha256: CACHE_HASH,
    files: 2,
    bytes: 64,
  };

  dependencies(): TrustedBuildRunnerTestDependencies {
    return {
      now: () => this.now,
      sealGradleCache: async () => {
        this.sealCalls += 1;
        if (this.sealGate) await this.sealGate.promise;
        return this.cacheSeed;
      },
      disposeGradleCacheSeed: async () => {
        this.disposeCacheCalls += 1;
      },
      createEnvironment: async (options) => {
        this.createCalls += 1;
        if (this.createGate) await this.createGate.promise;
        if (this.createFailures > 0) {
          this.createFailures -= 1;
          throw new Error("forced build environment creation failure");
        }
        assert.equal(options.expectedWorkspaceManifestSha256, "8".repeat(64));
        assert.equal(options.expectedWorkspaceCanonicalDiffSha256, "9".repeat(64));
        return this.environment({
          role: options.role,
          phase: options.phase,
          workspaceRoot: options.workspaceRoot,
          snapshotRoot: options.snapshotRoot,
          sourceHash: options.expectedSourceSnapshotSha256,
          projectRelativeDir: options.projectRelativeDir,
          artifactRelativePath: options.artifactRelativePath,
          expectedSignerCertificateSha256: options.expectedSignerCertificateSha256,
          tasks: options.tasks,
        });
      },
      auditWorkspace: async (options) => audit(
        options.role,
        options.expectedSourceSnapshotSha256,
      ),
      runtimeIdentity: async () => RUNNER_HASH,
      verifyGradleCacheSeed: async () => this.cacheSeed,
      stageApk: async () => {
        this.stageCalls += 1;
        return {
          root: `/private/test-staged-apk-${this.stageCalls}`,
          relativePath: "artifact.apk",
          sha256: APK_HASH,
          bytes: 4,
        };
      },
      disposeStagedApk: async () => {
        this.disposeApkCalls += 1;
        if (this.disposeApkFailures > 0) {
          this.disposeApkFailures -= 1;
          throw new Error("forced staged APK cleanup failure");
        }
      },
      inspectApk: async () => {
        this.inspectCalls += 1;
        if (this.inspectGate) await this.inspectGate.promise;
        return this.inspection();
      },
    };
  }

  environment(options: {
    role: BuildRole;
    phase: BuildPhase;
    workspaceRoot: string;
    snapshotRoot: string;
    sourceHash: string;
    projectRelativeDir: string;
    artifactRelativePath?: string;
    expectedSignerCertificateSha256?: string;
    tasks: readonly string[];
  }): { lease: EnvironmentLease; public: EnvironmentPublic } {
    const id = randomUUID();
    const preAudit = audit(options.role, options.sourceHash);
    const lease: EnvironmentLease = {
      id,
      createdAt: this.now,
      role: options.role,
      phase: options.phase,
      workspaceRoot: options.workspaceRoot,
      workspaceDir: options.workspaceRoot,
      projectDir: options.workspaceRoot,
      projectRelativeDir: options.projectRelativeDir,
      ...(options.artifactRelativePath
        ? { artifactRelativePath: options.artifactRelativePath }
        : {}),
      ...(options.expectedSignerCertificateSha256
        ? { expectedSignerCertificateSha256: options.expectedSignerCertificateSha256 }
        : {}),
      snapshotRoot: options.snapshotRoot,
      expectedSourceSnapshotSha256: options.sourceHash,
      cacheSeed: this.cacheSeed,
      backendIdentity: identity,
      tasks: [...options.tasks],
      logicalArgv: ["/bin/sh", "./gradlew", ...options.tasks],
      environment: {
        schema_version: "build_environment/v2",
        backend: "docker",
        execution_profile: "docker_strict",
        verification_level: "strong_isolation",
        environment_allowlist: ["HOME"],
        environment_allowlist_sha256: "0".repeat(64),
        runner_identity_sha256: RUNNER_HASH,
        execution_profile_sha256: "1".repeat(64),
        command_argv_sha256: "2".repeat(64),
        toolchain_manifest_sha256: "3".repeat(64),
        sdk_manifest_sha256: "4".repeat(64),
        dependency_lock_manifest_sha256: "5".repeat(64),
        cache_seed_manifest_sha256: CACHE_HASH,
        source_identity_sha256: "6".repeat(64),
        signing_adapter_sha256: "7".repeat(64),
        test_signing_identity_ref_sha256: "8".repeat(64),
        network_policy: "denied",
        strong_isolation: true,
        filesystem_write_isolation: "enforced",
        secret_filesystem_isolation: "enforced",
        process_containment: "container+process_group",
        workspace_disk_quota: { enforced: true, mechanism: "attested" },
        cache_mode: "sealed_seed_readonly_overlay",
        requires_explicit_trust: false,
      },
      buildEnvironmentSha256: "9".repeat(64),
      preAudit,
    };
    return {
      lease,
      public: {
        schema_version: "build-environment-created/v2",
        environment_id: id,
        backend: "docker",
        execution_profile: "docker_strict",
        verification_level: "strong_isolation",
        role: options.role,
        workspace_role: preAudit.role,
        workspace_manifest_sha256: preAudit.currentManifestSha256,
        workspace_canonical_diff_sha256: preAudit.canonicalDiffSha256,
        phase: options.phase,
        build_environment_sha256: lease.buildEnvironmentSha256,
        command_argv_sha256: lease.environment.command_argv_sha256,
        network_policy: "denied",
        strong_isolation: true,
        filesystem_write_isolation: "enforced",
        secret_filesystem_isolation: "enforced",
        process_containment: "container+process_group",
        workspace_disk_quota: { enforced: true, mechanism: "attested" },
        cache_mode: "sealed_seed_readonly_overlay",
        environment_allowlist_sha256: "0".repeat(64),
        requires_explicit_trust: false,
        requires_per_run_approval: true,
        source_identity_ref: "6".repeat(12),
        cache_seed_ref: CACHE_HASH.slice(0, 12),
        expires_in_seconds: 900,
        single_use: true,
      },
    };
  }

  inspection(): ApkInspection {
    return {
      schema_version: "android-apk-inspection/v2",
      inspector_backend: "docker",
      execution_profile: "docker_strict",
      inspector_isolated: true,
      verification_level: "strong_isolation",
      artifact_sha256: APK_HASH,
      bytes: 4,
      package: "com.example.test",
      version_name: "1.0",
      version_code: "1",
      debuggable: true,
      signed: true,
      signature_status: "verified",
      signer_certificate_sha256: [SIGNER_HASH],
      variant: "Debug",
      variant_source: "task-bound",
      variant_artifact_derived: false,
    };
  }
}

interface RunnerFixture {
  backend: FakeBackend;
  harness: RunnerHarness;
  runner: TrustedBuildRunner;
  workspace: string;
  cacheSeedId: string;
}

async function runnerFixture(t: TestContext): Promise<RunnerFixture> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "runner-admission-test-"));
  const backend = new FakeBackend();
  const harness = new RunnerHarness();
  const runner = new TrustedBuildRunner({
    backend,
    testOnlyDependencies: harness.dependencies(),
  });
  t.after(async () => {
    await runner.close();
    await rm(workspace, { recursive: true, force: true });
  });
  const sealed = await runner.sealGradleCache("/not-read-by-test-sealer");
  return {
    backend,
    harness,
    runner,
    workspace,
    cacheSeedId: sealed.cache_seed_id as string,
  };
}

function environmentOptions(
  fixture: RunnerFixture,
  phase: BuildPhase = "regression",
): Parameters<TrustedBuildRunner["createBuildEnvironment"]>[0] {
  return {
    expectedBackend: "docker",
    role: "candidate",
    phase,
    workspaceRoot: fixture.workspace,
    snapshotRoot: "/private/test-snapshot",
    expectedSourceSnapshotSha256: HASH,
    expectedWorkspaceManifestSha256: "8".repeat(64),
    expectedWorkspaceCanonicalDiffSha256: "9".repeat(64),
    cacheSeedId: fixture.cacheSeedId,
    projectRelativeDir: ".",
    ...(phase === "build"
      ? {
          artifactRelativePath: "app/build/outputs/apk/debug/app-debug.apk",
          expectedSignerCertificateSha256: SIGNER_HASH,
          tasks: ["assembleDebug"],
        }
      : { tasks: ["testDebugUnitTest"] }),
  };
}

test("cache sealing is fail-fast single-flight and retains at most one seed", async (t) => {
  const backend = new FakeBackend();
  const harness = new RunnerHarness();
  const runner = new TrustedBuildRunner({
    backend,
    testOnlyDependencies: harness.dependencies(),
  });
  t.after(async () => runner.close());

  harness.sealGate = deferred();
  const first = runner.sealGradleCache("/first");
  await waitFor(() => harness.sealCalls === 1);
  await assert.rejects(
    runner.sealGradleCache("/second"),
    /trusted build-backend workflow is already active/i,
  );
  const busyProbe = await runner.probeCapabilities();
  assert.equal(busyProbe.available, false);
  assert.match(String((busyProbe.reasons as string[])[0]), /build-backend workflow is already active/i);
  harness.sealGate.resolve();
  harness.sealGate = undefined;
  const sealed = await first;

  await assert.rejects(runner.sealGradleCache("/third"), /already retains/i);
  await runner.disposeGradleCache(sealed.cache_seed_id as string);
  assert.equal(harness.disposeCacheCalls, 1);
  const replacement = await runner.sealGradleCache("/replacement");
  assert.equal(typeof replacement.cache_seed_id, "string");
  assert.equal(harness.sealCalls, 2);
});

test("environment creation enforces an eight-lease hard limit", async (t) => {
  const fixture = await runnerFixture(t);
  const environments = [];
  for (let index = 0; index < 8; index += 1) {
    environments.push(
      await fixture.runner.createBuildEnvironment(environmentOptions(fixture)),
    );
  }
  assert.equal(environments[0]!.workspace_role, "candidate");
  assert.equal(environments[0]!.workspace_manifest_sha256, "8".repeat(64));
  assert.equal(environments[0]!.workspace_canonical_diff_sha256, "9".repeat(64));

  await assert.rejects(
    fixture.runner.createBuildEnvironment(environmentOptions(fixture)),
    /lease limit reached \(8\)/i,
  );

  const completed = await fixture.runner.runGradle(environments[0]!.environment_id);
  assert.equal(completed.workspace_role, "candidate");
  assert.equal(completed.workspace_manifest_sha256, "8".repeat(64));
  assert.equal(completed.workspace_canonical_diff_sha256, "9".repeat(64));
  assert.equal(
    completed.build_environment_sha256,
    environments[0]!.build_environment_sha256,
  );
  const replacement = await fixture.runner.createBuildEnvironment(environmentOptions(fixture));
  assert.equal(typeof replacement.environment_id, "string");
  assert.equal(fixture.harness.createCalls, 9);
});

test("a probing workflow blocks every container-backed admission without consuming ids", async (t) => {
  const fixture = await runnerFixture(t);
  const environment = await fixture.runner.createBuildEnvironment(environmentOptions(fixture));
  const createCallsBeforeBusyAdmission = fixture.harness.createCalls;
  const probeGate = deferred();
  fixture.backend.nextProbeGate = probeGate;
  const probing = fixture.runner.probeCapabilities();
  await waitFor(() => fixture.backend.activeProbes === 1);

  await assert.rejects(
    fixture.runner.createBuildEnvironment(environmentOptions(fixture)),
    /trusted build-backend workflow is already active/i,
  );
  await assert.rejects(
    fixture.runner.runGradle(environment.environment_id),
    /trusted build-backend workflow is already active/i,
  );
  await assert.rejects(
    fixture.runner.sealGradleCache("/must-not-be-read"),
    /trusted build-backend workflow is already active/i,
  );
  assert.equal(fixture.harness.createCalls, createCallsBeforeBusyAdmission);
  assert.equal(fixture.harness.sealCalls, 1);

  probeGate.resolve();
  assert.equal((await probing).available, true);
  await fixture.runner.runGradle(environment.environment_id);
  const created = await fixture.runner.createBuildEnvironment(environmentOptions(fixture));
  assert.equal(typeof created.environment_id, "string");
});

test("a failed environment workflow releases its global and resource reservations", async (t) => {
  const fixture = await runnerFixture(t);
  const retryableLease = await fixture.runner.createBuildEnvironment(environmentOptions(fixture));
  const createGate = deferred();
  fixture.harness.createGate = createGate;
  fixture.harness.createFailures = 1;
  const failingCreation = fixture.runner.createBuildEnvironment(environmentOptions(fixture));
  await waitFor(() => fixture.harness.createCalls === 2);

  const busyProbe = await fixture.runner.probeCapabilities();
  assert.equal(busyProbe.available, false);
  assert.match(String((busyProbe.reasons as string[])[0]), /build-backend workflow is already active/i);
  await assert.rejects(
    fixture.runner.runGradle(retryableLease.environment_id),
    /trusted build-backend workflow is already active/i,
  );

  createGate.resolve();
  fixture.harness.createGate = undefined;
  await assert.rejects(failingCreation, /forced build environment creation failure/i);
  const created = await fixture.runner.createBuildEnvironment(environmentOptions(fixture));
  assert.equal(typeof created.environment_id, "string");
  await fixture.runner.runGradle(retryableLease.environment_id);
});

test("Gradle and APK workflows serialize without consuming busy or pending work", async (t) => {
  const fixture = await runnerFixture(t);
  const regressionOne = await fixture.runner.createBuildEnvironment(environmentOptions(fixture));
  const regressionTwo = await fixture.runner.createBuildEnvironment(environmentOptions(fixture));
  const buildOne = await fixture.runner.createBuildEnvironment(environmentOptions(fixture, "build"));
  const buildTwo = await fixture.runner.createBuildEnvironment(environmentOptions(fixture, "build"));

  const runGate = deferred();
  fixture.backend.nextRunGate = runGate;
  const firstRun = fixture.runner.runGradle(regressionOne.environment_id);
  await waitFor(() => fixture.backend.activeRuns === 1);
  await assert.rejects(
    fixture.runner.runGradle(regressionTwo.environment_id),
    /another trusted build-backend workflow/i,
  );
  runGate.resolve();
  await firstRun;
  await fixture.runner.runGradle(regressionTwo.environment_id);

  await fixture.runner.runGradle(buildOne.environment_id);
  await assert.rejects(
    fixture.runner.runGradle(buildTwo.environment_id),
    /pending inspection or cleanup/i,
  );

  const regressionThree = await fixture.runner.createBuildEnvironment(environmentOptions(fixture));
  const inspectionBusyGate = deferred();
  fixture.backend.nextRunGate = inspectionBusyGate;
  const thirdRun = fixture.runner.runGradle(regressionThree.environment_id);
  await waitFor(() => fixture.backend.activeRuns === 1);
  await assert.rejects(
    fixture.runner.inspectApk(buildOne.environment_id),
    /another trusted build-backend workflow/i,
  );
  inspectionBusyGate.resolve();
  await thirdRun;

  const inspectGate = deferred();
  fixture.harness.inspectGate = inspectGate;
  const inspection = fixture.runner.inspectApk(buildOne.environment_id);
  await waitFor(() => fixture.harness.inspectCalls === 1);
  await assert.rejects(
    fixture.runner.runGradle(buildTwo.environment_id),
    /another trusted build-backend workflow/i,
  );
  inspectGate.resolve();
  fixture.harness.inspectGate = undefined;
  await inspection;

  await fixture.runner.runGradle(buildTwo.environment_id);
  await fixture.runner.inspectApk(buildTwo.environment_id);
  assert.equal(fixture.backend.maxActiveRuns, 1);
  assert.equal(fixture.harness.stageCalls, 2);
  assert.equal(fixture.harness.disposeApkCalls, 2);
});

test("expired completed APK remains retryable until staged cleanup succeeds", async (t) => {
  const fixture = await runnerFixture(t);
  const build = await fixture.runner.createBuildEnvironment(environmentOptions(fixture, "build"));
  await fixture.runner.runGradle(build.environment_id);
  fixture.harness.now += 15 * 60 * 1000 + 1;
  fixture.harness.disposeApkFailures = 1;

  await assert.rejects(
    fixture.runner.createBuildEnvironment(environmentOptions(fixture)),
    /forced staged APK cleanup failure/i,
  );
  assert.equal(fixture.harness.disposeApkCalls, 1);

  const created = await fixture.runner.createBuildEnvironment(environmentOptions(fixture));
  assert.equal(typeof created.environment_id, "string");
  assert.equal(fixture.harness.disposeApkCalls, 2);
  await assert.rejects(
    fixture.runner.inspectApk(build.environment_id),
    /recent completed build run/i,
  );
});

test("close waits for a workflow and observes released admission counters", async (t) => {
  const fixture = await runnerFixture(t);
  const environment = await fixture.runner.createBuildEnvironment(environmentOptions(fixture));
  const gate = deferred();
  fixture.backend.nextRunGate = gate;
  const running = fixture.runner.runGradle(environment.environment_id);
  await waitFor(() => fixture.backend.activeRuns === 1);

  let closeSettled = false;
  const closing = fixture.runner.close().finally(() => {
    closeSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closeSettled, false);
  gate.resolve();
  await running;
  await closing;
  assert.ok(fixture.backend.closeCalls >= 2);
  await assert.rejects(
    fixture.runner.runGradle(environment.environment_id),
    /closing or closed/i,
  );
});

test("close aborts the exact helper runner used by an active workspace audit", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "runner-helper-close-test-"));
  const backend = new FakeBackend();
  const harness = new RunnerHarness();
  const helperProcessRunner = new ProcessRunner({
    testOnlyTimings: {
      terminationGraceMs: 20,
      forceCloseGraceMs: 40,
      finalSettleGraceMs: 20,
      cleanupPollMs: 5,
    },
  });
  let hangAudit = false;
  let auditStarted = 0;
  const dependencies = harness.dependencies();
  dependencies.auditWorkspace = async (options) => {
    if (!hangAudit) {
      return audit(options.role, options.expectedSourceSnapshotSha256);
    }
    auditStarted += 1;
    await options.helperProcessRunner.run(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { timeoutMs: 5_000, maxOutputBytes: 4096, env: {} },
    );
    throw new Error("unreachable helper completion");
  };
  const runner = new TrustedBuildRunner({
    backend,
    testOnlyDependencies: dependencies,
    testOnlyHelperProcessRunner: helperProcessRunner,
  });
  t.after(async () => {
    await runner.close();
    await rm(workspace, { recursive: true, force: true });
  });

  const sealed = await runner.sealGradleCache("/not-read-by-test-sealer");
  const environment = await runner.createBuildEnvironment({
    expectedBackend: "docker",
    role: "candidate",
    phase: "regression",
    workspaceRoot: workspace,
    snapshotRoot: "/private/test-snapshot",
    expectedSourceSnapshotSha256: HASH,
    expectedWorkspaceManifestSha256: "8".repeat(64),
    expectedWorkspaceCanonicalDiffSha256: "9".repeat(64),
    cacheSeedId: sealed.cache_seed_id as string,
    projectRelativeDir: ".",
    tasks: ["testDebugUnitTest"],
  });
  hangAudit = true;
  const running = runner.runGradle(environment.environment_id);
  await waitFor(() => auditStarted === 1);

  const closing = runner.close();
  await assert.rejects(running, /process runner cleanup/i);
  await closing;
  assert.equal(helperProcessRunner.status().closed, true);
  assert.equal(helperProcessRunner.status().activeProcesses, 0);
});

test("unproved helper cleanup makes runner close fail closed and retry the retained owner", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "runner-helper-poison-test-"));
  const backend = new FakeBackend();
  const harness = new RunnerHarness();
  let groupPresent = true;
  const helperProcessRunner = new ProcessRunner({
    testOnlyTimings: {
      terminationGraceMs: 20,
      forceCloseGraceMs: 40,
      finalSettleGraceMs: 20,
      cleanupPollMs: 5,
    },
    testOnlyHooks: {
      processGroupExists: () => groupPresent,
      signalProcessGroup: () => undefined,
    },
  });
  const dependencies = harness.dependencies();
  dependencies.auditWorkspace = async (options) => {
    await options.helperProcessRunner.run(
      process.execPath,
      ["-e", "process.exit(0)"],
      { timeoutMs: 2_000, maxOutputBytes: 4096, env: {} },
    );
    return audit(options.role, options.expectedSourceSnapshotSha256);
  };
  const runner = new TrustedBuildRunner({
    backend,
    testOnlyDependencies: dependencies,
    testOnlyHelperProcessRunner: helperProcessRunner,
  });
  t.after(async () => {
    groupPresent = false;
    await runner.close();
    await rm(workspace, { recursive: true, force: true });
  });

  const sealed = await runner.sealGradleCache("/not-read-by-test-sealer");
  const environment = await runner.createBuildEnvironment({
    expectedBackend: "docker",
    role: "candidate",
    phase: "regression",
    workspaceRoot: workspace,
    snapshotRoot: "/private/test-snapshot",
    expectedSourceSnapshotSha256: HASH,
    expectedWorkspaceManifestSha256: "8".repeat(64),
    expectedWorkspaceCanonicalDiffSha256: "9".repeat(64),
    cacheSeedId: sealed.cache_seed_id as string,
    projectRelativeDir: ".",
    tasks: ["testDebugUnitTest"],
  });
  await assert.rejects(runner.runGradle(environment.environment_id), /final cleanup deadline/i);
  assert.equal(helperProcessRunner.status().poisoned, true);

  await assert.rejects(runner.close(), /build runner cleanup failed/i);
  assert.equal(helperProcessRunner.status().closed, false);
  assert.equal(helperProcessRunner.status().poisoned, true);
  const unavailable = await runner.probeCapabilities();
  assert.deepEqual(unavailable.reasons, ["RUNNER_CLOSING_OR_CLOSED"]);

  groupPresent = false;
  await runner.close();
  assert.equal(helperProcessRunner.status().closed, true);
  assert.equal(helperProcessRunner.status().poisoned, false);
  assert.equal(helperProcessRunner.status().activeProcesses, 0);
});
