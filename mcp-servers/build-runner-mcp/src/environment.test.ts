import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sealGradleCache } from "./cache-seed.js";
import type { RunnerConfig } from "./config.js";
import type {
  BuildBackend,
  CapabilityResult,
  DockerIdentity,
  LocalTrustedIdentity,
} from "./backend.js";
import {
  assertApprovedTestFixtureExecutionProfile,
  createEnvironment,
  DirectoryAncestorIndex,
  discoverBuildInputPaths,
  normalizeTasks,
  validateRuntimeLaunchConfiguration,
} from "./environment.js";
import { ProcessRunner, type ProcessResult } from "./process-runner.js";
import { TrustedBuildRunner } from "./runner.js";

const HASH = "a".repeat(64);
const IMAGE = `example/android@sha256:${HASH}`;

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
  dockerCliSha256: "d".repeat(64),
  dockerSocketIdentitySha256: "e".repeat(64),
  ociRuntime: "runc",
  ociRuntimeDescriptorSha256: "9".repeat(64),
  toolchainProbeSha256: "f".repeat(64),
  dockerImageId: "b".repeat(64),
  dockerImageDigest: HASH,
  platform: "linux",
  securityOptionsSha256: "c".repeat(64),
};

async function removeRetained(root: string): Promise<void> {
  const makeWritable = async (entry: string): Promise<void> => {
    const value = await lstat(entry);
    if (value.isDirectory()) {
      await chmod(entry, 0o700);
      for (const child of await readdir(entry)) await makeWritable(path.join(entry, child));
    } else if (!value.isSymbolicLink()) {
      await chmod(entry, 0o600);
    }
  };
  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
}

class FakeBackend implements BuildBackend {
  readonly backend = "docker" as const;
  readonly config: RunnerConfig = {
    backend: "docker",
    dockerBin: "/fake/docker",
    dockerHost: "unix:///fake/docker.sock",
    ociRuntime: "runc",
    image: IMAGE,
    javaHome: "/opt/java/openjdk",
    androidSdkRoot: "/opt/android-sdk",
    apkAnalyzer: "/opt/android-sdk/apkanalyzer",
    apkSigner: "/opt/android-sdk/apksigner",
    maxMemoryMb: 1024,
    maxCpus: 2,
    maxPids: 128,
    gradleHomeMb: 1024,
    tmpMb: 128,
    maxOutputBytes: 4096,
  };
  async initialize(): Promise<void> {}
  async close(): Promise<void> {}
  async probe(): Promise<CapabilityResult> {
    return { available: true, backend: "docker", reasons: [], identity };
  }
  executionProfile(): Record<string, unknown> {
    return { backend: "docker", workspace: "<WORKSPACE>", network: "none" };
  }
  async runBuildCommand(
    _options: Parameters<BuildBackend["runBuildCommand"]>[0],
  ): Promise<ProcessResult> {
    return processResult();
  }
  async runReadOnlyArtifactCommand(): Promise<ProcessResult> {
    return processResult();
  }
}

const localIdentity: LocalTrustedIdentity = {
  backend: "local_trusted",
  platform: "darwin",
  architecture: "arm64",
  javaExecutableSha256: "1".repeat(64),
  javaReleaseSha256: "2".repeat(64),
  javaRuntimeSha256: "3".repeat(64),
  javaVersionSha256: "4".repeat(64),
  apkAnalyzerSha256: "5".repeat(64),
  apkAnalyzerPackageSha256: "6".repeat(64),
  apkAnalyzerImplementationSha256: "7".repeat(64),
  apkAnalyzerVersionSha256: "8".repeat(64),
  apkSignerSha256: "9".repeat(64),
  apkSignerPackageSha256: "a".repeat(64),
  apkSignerImplementationSha256: "b".repeat(64),
  apkSignerVersionSha256: "c".repeat(64),
  executionProfileSha256: "d".repeat(64),
};

class LocalFakeBackend implements BuildBackend {
  readonly backend = "local_trusted" as const;
  readonly config: RunnerConfig = {
    backend: "local_trusted",
    javaHome: "/trusted/java",
    androidSdkRoot: "/trusted/android-sdk",
    apkAnalyzer: "/trusted/android-sdk/cmdline-tools/13.0/bin/apkanalyzer",
    apkSigner: "/trusted/android-sdk/build-tools/36.0.0/apksigner",
    maxOutputBytes: 4096,
  };
  async initialize(): Promise<void> {}
  async close(): Promise<void> {}
  async probe(): Promise<CapabilityResult> {
    return { available: true, backend: "local_trusted", reasons: [], identity: localIdentity };
  }
  executionProfile(): Record<string, unknown> { return { backend: "local_trusted" }; }
  async runBuildCommand(): Promise<ProcessResult> {
    return processResult();
  }
  async runReadOnlyArtifactCommand(): Promise<ProcessResult> {
    return processResult();
  }
}

test("approved fixture context is local_trusted-only and rejects cross-profile laundering", () => {
  const enabled = {
    approvedTestFixtureCount: 1,
    approvedTestFixtureContext: {
      schema_version: "crashfix-test-fixture-context/v1" as const,
      enabled: true,
      execution_profile: "local_trusted" as const,
      project_classification: "test" as const,
    },
  };
  assert.doesNotThrow(() => assertApprovedTestFixtureExecutionProfile(enabled, "local_trusted"));
  assert.throws(
    () => assertApprovedTestFixtureExecutionProfile(enabled, "docker"),
    /forbidden for docker_strict/u,
  );
  assert.throws(
    () => assertApprovedTestFixtureExecutionProfile({
      ...enabled,
      approvedTestFixtureContext: {
        ...enabled.approvedTestFixtureContext,
        project_classification: "none" as const,
      },
    }, "local_trusted"),
    /execution context is invalid/u,
  );
});

async function helper(
  processRunner: ProcessRunner,
  args: string[],
): Promise<Record<string, unknown>> {
  const script = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../skills/crashfix/scripts/materialize-workspace-snapshot.mjs",
  );
  const result = await processRunner.run(process.execPath, [script, ...args], {
    timeoutMs: 60_000,
    maxOutputBytes: 2 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: "/var/empty", LANG: "C", LC_ALL: "C" },
  });
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function expectedWorkspaceIdentity(audit: Record<string, unknown>): {
  expectedWorkspaceManifestSha256: string;
  expectedWorkspaceCanonicalDiffSha256: string;
} {
  assert.match(String(audit.current_manifest_sha256), /^[a-f0-9]{64}$/);
  assert.match(String(audit.canonical_diff_sha256), /^[a-f0-9]{64}$/);
  return {
    expectedWorkspaceManifestSha256: audit.current_manifest_sha256 as string,
    expectedWorkspaceCanonicalDiffSha256: audit.canonical_diff_sha256 as string,
  };
}

async function projectFixture(root: string): Promise<void> {
  await mkdir(path.join(root, "app/src/main/java/com/example"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, "buildSrc/src/main/kotlin"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, "gradle/wrapper"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, "gradlew"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(path.join(root, "settings.gradle.kts"), 'rootProject.name="demo"\n', { mode: 0o600 });
  await writeFile(path.join(root, "build.gradle.kts"), "plugins {}\n", { mode: 0o600 });
  await writeFile(path.join(root, "gradle/wrapper/gradle-wrapper.properties"), "distributionUrl=file:test\n", { mode: 0o600 });
  await writeFile(path.join(root, "gradle/wrapper/gradle-wrapper.jar"), "jar", { mode: 0o600 });
  await writeFile(path.join(root, "app/src/main/java/com/example/Main.kt"), "class Main\n", { mode: 0o600 });
  await writeFile(path.join(root, "buildSrc/src/main/kotlin/Convention.kt"), "class Convention\n", { mode: 0o600 });
}

async function cacheFixture(root: string): Promise<void> {
  const module = path.join(root, "caches/modules-2/files-2.1/com.example/demo/1.0");
  const wrapper = path.join(root, "wrapper/dists/gradle-8.8-bin/fixture");
  const wrapperBin = path.join(wrapper, "gradle-8.8/bin");
  await mkdir(module, { recursive: true, mode: 0o700 });
  await mkdir(wrapperBin, { recursive: true, mode: 0o700 });
  await writeFile(path.join(module, "demo.jar"), "dependency", { mode: 0o600 });
  await writeFile(path.join(wrapper, "gradle-8.8-bin.zip.ok"), "", { mode: 0o600 });
  await writeFile(path.join(wrapperBin, "gradle"), "wrapper", { mode: 0o700 });
}

test("baseline and candidate bind equal semantic build environments, not absolute paths", async (t) => {
  const helperProcessRunner = new ProcessRunner();
  t.after(async () => helperProcessRunner.close());
  const source = await realpath(await mkdtemp(path.join(os.tmpdir(), "build-runner-source-")));
  const report = await realpath(await mkdtemp(path.join(os.tmpdir(), "build-runner-report-")));
  const cacheSource = await realpath(await mkdtemp(path.join(os.tmpdir(), "build-runner-cache-source-")));
  t.after(async () => Promise.all([
    rm(source, { recursive: true, force: true }),
    rm(report, { recursive: true, force: true }),
    rm(cacheSource, { recursive: true, force: true }),
  ]));
  await projectFixture(source);
  await cacheFixture(cacheSource);
  const sealedCache = await sealGradleCache(cacheSource);
  t.after(async () => removeRetained(sealedCache.root));

  const snapshot = await helper(helperProcessRunner, [
    "create", "--workspace", source, "--forbid-root", report,
  ]);
  const snapshotRoot = snapshot.snapshot_root as string;
  const sourceRef = snapshot.source_ref_sha256 as string;
  const sourceHash = snapshot.source_snapshot_sha256 as string;
  t.after(async () => removeRetained(snapshotRoot));
  const baseline = await helper(helperProcessRunner, [
    "clone",
    "--snapshot-root", snapshotRoot,
    "--role", "baseline",
    "--expected-source-ref-sha256", sourceRef,
    "--expected-source-sha256", sourceHash,
    "--forbid-root", source,
    "--forbid-root", report,
  ]);
  const candidate = await helper(helperProcessRunner, [
    "clone",
    "--snapshot-root", snapshotRoot,
    "--role", "candidate",
    "--expected-source-ref-sha256", sourceRef,
    "--expected-source-sha256", sourceHash,
    "--forbid-root", source,
    "--forbid-root", report,
  ]);
  t.after(async () => Promise.all([
    removeRetained(baseline.workspace_root as string),
    removeRetained(candidate.workspace_root as string),
  ]));
  const baselineAudit = await helper(helperProcessRunner, [
    "audit",
    "--workspace-root", baseline.workspace_root as string,
    "--snapshot-root", snapshotRoot,
    "--expected-source-sha256", sourceHash,
    "--role", "baseline",
  ]);
  const candidateAudit = await helper(helperProcessRunner, [
    "audit",
    "--workspace-root", candidate.workspace_root as string,
    "--snapshot-root", snapshotRoot,
    "--expected-source-sha256", sourceHash,
    "--role", "candidate",
  ]);

  const backend = new FakeBackend();
  const common = {
    backend,
    helperProcessRunner,
    expectedBackend: "docker" as const,
    phase: "build" as const,
    snapshotRoot,
    expectedSourceSnapshotSha256: sourceHash,
    cacheSeedRoot: sealedCache.root,
    expectedCacheSeedManifestSha256: sealedCache.manifestSha256,
    projectRelativeDir: ".",
    artifactRelativePath: "app/build/outputs/apk/debug/app-debug.apk",
    expectedSignerCertificateSha256: "d".repeat(64),
    tasks: ["assembleDebug"],
  };
  const baselineEnvironment = await createEnvironment({
    ...common,
    role: "baseline",
    workspaceRoot: baseline.workspace_root as string,
    ...expectedWorkspaceIdentity(baselineAudit),
  });
  const candidateEnvironment = await createEnvironment({
    ...common,
    role: "candidate",
    workspaceRoot: candidate.workspace_root as string,
    ...expectedWorkspaceIdentity(candidateAudit),
  });
  assert.equal(
    baselineEnvironment.lease.buildEnvironmentSha256,
    candidateEnvironment.lease.buildEnvironmentSha256,
  );
  assert.equal(baselineEnvironment.public.workspace_role, "baseline");
  assert.equal(candidateEnvironment.public.workspace_role, "candidate");
  assert.equal(
    baselineEnvironment.public.workspace_manifest_sha256,
    baselineAudit.current_manifest_sha256,
  );
  assert.equal(
    candidateEnvironment.public.workspace_canonical_diff_sha256,
    candidateAudit.canonical_diff_sha256,
  );
  await assert.rejects(
    createEnvironment({
      ...common,
      role: "candidate",
      workspaceRoot: candidate.workspace_root as string,
      ...expectedWorkspaceIdentity(candidateAudit),
      expectedWorkspaceManifestSha256: "f".repeat(64),
    }),
    /workspace manifest identity/i,
  );
  await assert.rejects(
    createEnvironment({
      ...common,
      role: "candidate",
      workspaceRoot: candidate.workspace_root as string,
      ...expectedWorkspaceIdentity(candidateAudit),
      expectedWorkspaceCanonicalDiffSha256: "f".repeat(64),
    }),
    /workspace canonical diff identity/i,
  );

  const localCommon = {
    ...common,
    backend: new LocalFakeBackend(),
    expectedBackend: "local_trusted" as const,
  };
  const localBaseline = await createEnvironment({
    ...localCommon,
    role: "baseline",
    workspaceRoot: baseline.workspace_root as string,
    ...expectedWorkspaceIdentity(baselineAudit),
  });
  const localCandidate = await createEnvironment({
    ...localCommon,
    role: "candidate",
    workspaceRoot: candidate.workspace_root as string,
    ...expectedWorkspaceIdentity(candidateAudit),
  });
  assert.equal(localBaseline.public.schema_version, "build-environment-created/v2");
  assert.equal(localBaseline.public.execution_profile, "local_trusted");
  assert.equal(localBaseline.public.network_policy, "not_enforced");
  assert.equal(localBaseline.public.strong_isolation, false);
  assert.equal(localBaseline.public.filesystem_write_isolation, "not_enforced");
  assert.equal(localBaseline.public.secret_filesystem_isolation, "not_enforced");
  assert.equal(localBaseline.public.process_containment, "process_group_best_effort");
  assert.deepEqual(localBaseline.public.workspace_disk_quota, {
    enforced: false,
    mechanism: "none",
  });
  assert.equal(localBaseline.public.cache_mode, "sealed_seed_disposable_copy");
  assert.equal(
    localBaseline.lease.buildEnvironmentSha256,
    localCandidate.lease.buildEnvironmentSha256,
  );
  assert.notEqual(
    localBaseline.lease.buildEnvironmentSha256,
    baselineEnvironment.lease.buildEnvironmentSha256,
  );

  const candidateSourceFile = path.join(
    candidate.workspace_dir as string,
    "app/src/main/java/com/example/Main.kt",
  );
  await chmod(candidateSourceFile, 0o600);
  await writeFile(candidateSourceFile, "class ChangedMain\n");
  const sourceChangedAudit = await helper(helperProcessRunner, [
    "audit",
    "--workspace-root", candidate.workspace_root as string,
    "--snapshot-root", snapshotRoot,
    "--expected-source-sha256", sourceHash,
    "--role", "candidate",
  ]);
  const sourceChanged = await createEnvironment({
    ...common,
    role: "candidate",
    workspaceRoot: candidate.workspace_root as string,
    ...expectedWorkspaceIdentity(sourceChangedAudit),
  });
  assert.equal(
    sourceChanged.lease.buildEnvironmentSha256,
    baselineEnvironment.lease.buildEnvironmentSha256,
  );
  assert.notEqual(
    sourceChanged.public.workspace_manifest_sha256,
    baselineEnvironment.public.workspace_manifest_sha256,
  );
  assert.notEqual(
    sourceChanged.public.workspace_canonical_diff_sha256,
    baselineEnvironment.public.workspace_canonical_diff_sha256,
  );

  const candidateBuildFile = path.join(
    candidate.workspace_dir as string,
    "buildSrc/src/main/kotlin/Convention.kt",
  );
  await chmod(candidateBuildFile, 0o600);
  await writeFile(candidateBuildFile, "class ChangedConvention\n");
  const buildChangedAudit = await helper(helperProcessRunner, [
    "audit",
    "--workspace-root", candidate.workspace_root as string,
    "--snapshot-root", snapshotRoot,
    "--expected-source-sha256", sourceHash,
    "--role", "candidate",
  ]);
  const drifted = await createEnvironment({
    ...common,
    role: "candidate",
    workspaceRoot: candidate.workspace_root as string,
    ...expectedWorkspaceIdentity(buildChangedAudit),
  });
  assert.notEqual(
    drifted.lease.buildEnvironmentSha256,
    baselineEnvironment.lease.buildEnvironmentSha256,
  );
});

test("Gradle task policy rejects arguments and phase mismatches", () => {
  assert.deepEqual(normalizeTasks("build", [":app:assembleDebug"]), [":app:assembleDebug"]);
  assert.throws(() => normalizeTasks("build", [":app:bundleDebug"]), /phase/i);
  assert.throws(() => normalizeTasks("build", ["--init-script"]), /unsafe|allowed/i);
  assert.throws(() => normalizeTasks("build", ["testDebugUnitTest"]), /phase/i);
  assert.throws(() => normalizeTasks("regression", ["assembleDebug"]), /phase/i);
});

test("runtime launch policy binds production argv and rejects Node injection flags", () => {
  assert.deepEqual(validateRuntimeLaunchConfiguration({
    runtimeDirectory: "/trusted/runner/dist",
    execArgv: [],
    argv: ["/trusted/node", "/trusted/runner/dist/index.js"],
  }), {
    mode: "production",
    startup_argv: ["node", "dist/index.js"],
    exec_argv: [],
    node_options: "absent",
  });
  assert.deepEqual(validateRuntimeLaunchConfiguration({
    runtimeDirectory: "/trusted/runner/src",
    execArgv: ["--import", "tsx", "--test-timeout=60000"],
    argv: ["/trusted/node", "/trusted/runner/src/environment.test.ts"],
  }).mode, "tsx-test");

  assert.throws(() => validateRuntimeLaunchConfiguration({
    runtimeDirectory: "/trusted/runner/dist",
    execArgv: ["--inspect"],
    argv: ["/trusted/node", "/trusted/runner/dist/index.js"],
  }), /exec arguments/i);
  assert.throws(() => validateRuntimeLaunchConfiguration({
    runtimeDirectory: "/trusted/runner/dist",
    execArgv: [],
    argv: ["/trusted/node", "/trusted/runner/dist/index.js"],
    nodeOptions: "--require=/tmp/preload.cjs",
  }), /NODE_OPTIONS/i);
  assert.throws(() => validateRuntimeLaunchConfiguration({
    runtimeDirectory: "/trusted/runner/src",
    execArgv: ["--import", "/tmp/untrusted-loader.mjs"],
    argv: ["/trusted/node", "/trusted/runner/src/environment.test.ts"],
  }), /tsx import hook/i);
  assert.throws(() => validateRuntimeLaunchConfiguration({
    runtimeDirectory: "/trusted/runner/src",
    execArgv: ["--import", "tsx", "--inspect"],
    argv: ["/trusted/node", "/trusted/runner/src/environment.test.ts"],
  }), /unsafe Node exec argument/i);
});

async function buildInputFixture(root: string): Promise<void> {
  await mkdir(path.join(root, "logic"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, "plugins"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, "src/main/kotlin"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, "gradlew"), "#!/bin/sh\n", { mode: 0o700 });
  await writeFile(path.join(root, "settings.gradle.kts"), 'rootProject.name = "demo"\n', { mode: 0o600 });
  await writeFile(path.join(root, "build.gradle.kts"), "plugins {}\n", { mode: 0o600 });
  await writeFile(path.join(root, "logic/convention.groovy"), "class Convention {}\n", { mode: 0o600 });
  await writeFile(path.join(root, "plugins/local-plugin.jar"), "local plugin\n", { mode: 0o600 });
  await writeFile(
    path.join(root, "src/main/kotlin/Business.kts"),
    'val documentation = "includeFlat(\\"../not-build-logic\\")"\n',
    { mode: 0o600 },
  );
}

test("Gradle input manifest binds Groovy, JAR, and statically applied build logic", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "build-inputs-")));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await buildInputFixture(root);
  await writeFile(
    path.join(root, "build.gradle.kts"),
    'apply(from = "logic/convention.groovy")\n',
    { mode: 0o600 },
  );

  const inputs = await discoverBuildInputPaths(root);
  assert.equal(inputs.includes("logic/convention.groovy"), true);
  assert.equal(inputs.includes("plugins/local-plugin.jar"), true);
  assert.equal(inputs.includes("src/main/kotlin/Business.kts"), true);
});

test("nested Gradle settings include descendants without matching sibling prefixes", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "nested-build-inputs-")));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await buildInputFixture(root);
  await mkdir(path.join(root, "composite/src"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, "composite-shadow/src"), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(root, "settings.gradle.kts"),
    'rootProject.name = "demo"\nincludeBuild("composite")\n',
    { mode: 0o600 },
  );
  await writeFile(
    path.join(root, "composite/settings.gradle.kts"),
    'rootProject.name = "composite"\n',
    { mode: 0o600 },
  );
  await writeFile(path.join(root, "composite/src/input.txt"), "nested input\n", { mode: 0o600 });
  await writeFile(
    path.join(root, "composite-shadow/src/input.txt"),
    "sibling input\n",
    { mode: 0o600 },
  );

  const inputs = await discoverBuildInputPaths(root);
  assert.equal(inputs.includes("composite/src/input.txt"), true);
  assert.equal(inputs.includes("composite-shadow/src/input.txt"), false);
});

test("nested build ancestor index scales by path depth and consumes roots once", () => {
  const rootCount = 10_000;
  const roots = Array.from({ length: rootCount }, (_, index) => `composites/build-${index}`);
  let iterations = 0;
  const oneShotRoots: Iterable<string> = {
    *[Symbol.iterator]() {
      iterations += 1;
      assert.equal(iterations, 1, "directory roots must be indexed only once");
      yield* roots;
    },
  };
  const index = new DirectoryAncestorIndex(oneShotRoots);

  for (let item = 0; item < rootCount; item += 1) {
    assert.equal(index.hasAncestor(`composites/build-${item}/src/input.txt`), true);
    assert.equal(index.hasAncestor(`composites/build-${item}-shadow/src/input.txt`), false);
  }
  assert.equal(iterations, 1);
});

test("Gradle input discovery rejects external and dynamic apply/include paths", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "build-input-policy-")));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await buildInputFixture(root);

  await writeFile(
    path.join(root, "build.gradle.kts"),
    'apply(from = "../outside.gradle.kts")\n',
    { mode: 0o600 },
  );
  await assert.rejects(discoverBuildInputPaths(root), /project_dir|escaped/i);

  await writeFile(
    path.join(root, "build.gradle.kts"),
    'apply(from = providers.gradleProperty("script").get())\n',
    { mode: 0o600 },
  );
  await assert.rejects(discoverBuildInputPaths(root), /dynamic path/i);

  await writeFile(path.join(root, "build.gradle.kts"), "plugins {}\n", { mode: 0o600 });
  await writeFile(
    path.join(root, "settings.gradle.kts"),
    'includeBuild(rootProject.file("../external-build"))\n',
    { mode: 0o600 },
  );
  await assert.rejects(discoverBuildInputPaths(root), /project_dir|escaped/i);

  await writeFile(
    path.join(root, "settings.gradle.kts"),
    'includeFlat("external-project")\n',
    { mode: 0o600 },
  );
  await assert.rejects(discoverBuildInputPaths(root), /includeFlat/i);

  await writeFile(
    path.join(root, "settings.gradle.kts"),
    'includeBuild("plugins")\n',
    { mode: 0o600 },
  );
  await assert.rejects(discoverBuildInputPaths(root), /no settings file/i);
});

test("runner always audits source after a containment failure", async (t) => {
  const fixtureHelperRunner = new ProcessRunner();
  t.after(async () => fixtureHelperRunner.close());
  const source = await realpath(await mkdtemp(path.join(os.tmpdir(), "build-runner-failure-source-")));
  const report = await realpath(await mkdtemp(path.join(os.tmpdir(), "build-runner-failure-report-")));
  const cacheSource = await realpath(await mkdtemp(path.join(os.tmpdir(), "build-runner-failure-cache-")));
  t.after(async () => Promise.all([
    rm(source, { recursive: true, force: true }),
    rm(report, { recursive: true, force: true }),
    rm(cacheSource, { recursive: true, force: true }),
  ]));
  await projectFixture(source);
  await cacheFixture(cacheSource);
  class MutatingFailureBackend extends FakeBackend {
    fail = false;

    override async runBuildCommand(
      options: Parameters<BuildBackend["runBuildCommand"]>[0],
    ): Promise<ProcessResult> {
      if (!this.fail) {
        return processResult("CUSTOM_UNRECOGNIZED_SECRET_VALUE");
      }
      await writeFile(
        path.join(options.workspace, "app/src/main/java/com/example/Main.kt"),
        "class Mutated\n",
      );
      throw new Error("simulated containment cleanup failure");
    }
  }
  const backend = new MutatingFailureBackend();
  const runner = new TrustedBuildRunner({ backend });
  const cacheResult = await runner.sealGradleCache(cacheSource);
  const cacheSeedId = cacheResult.cache_seed_id as string;
  const snapshot = await helper(
    fixtureHelperRunner,
    ["create", "--workspace", source, "--forbid-root", report],
  );
  const snapshotRoot = snapshot.snapshot_root as string;
  const sourceRef = snapshot.source_ref_sha256 as string;
  const sourceHash = snapshot.source_snapshot_sha256 as string;
  t.after(async () => removeRetained(snapshotRoot));
  const candidate = await helper(fixtureHelperRunner, [
    "clone",
    "--snapshot-root", snapshotRoot,
    "--role", "candidate",
    "--expected-source-ref-sha256", sourceRef,
    "--expected-source-sha256", sourceHash,
    "--forbid-root", source,
    "--forbid-root", report,
  ]);
  t.after(async () => removeRetained(candidate.workspace_root as string));
  const candidateAudit = await helper(fixtureHelperRunner, [
    "audit",
    "--workspace-root", candidate.workspace_root as string,
    "--snapshot-root", snapshotRoot,
    "--expected-source-sha256", sourceHash,
    "--role", "candidate",
  ]);
  const expectedCandidateIdentity = expectedWorkspaceIdentity(candidateAudit);

  let disposed = false;
  try {
    const successfulEnvironment = await runner.createBuildEnvironment({
      expectedBackend: "docker",
      role: "candidate",
      phase: "regression",
      workspaceRoot: candidate.workspace_root as string,
      snapshotRoot,
      expectedSourceSnapshotSha256: sourceHash,
      ...expectedCandidateIdentity,
      cacheSeedId,
      projectRelativeDir: ".",
      tasks: ["testDebugUnitTest"],
    });
    const successfulRun = await runner.runGradle(successfulEnvironment.environment_id);
    assert.equal("stdout_tail" in successfulRun, false);
    assert.equal("stderr_tail" in successfulRun, false);
    assert.equal(JSON.stringify(successfulRun).includes("CUSTOM_UNRECOGNIZED_SECRET_VALUE"), false);

    backend.fail = true;
    const environment = await runner.createBuildEnvironment({
      expectedBackend: "docker",
      role: "candidate",
      phase: "regression",
      workspaceRoot: candidate.workspace_root as string,
      snapshotRoot,
      expectedSourceSnapshotSha256: sourceHash,
      ...expectedCandidateIdentity,
      cacheSeedId,
      projectRelativeDir: ".",
      tasks: ["testDebugUnitTest"],
    });
    await assert.rejects(
      runner.runGradle(environment.environment_id),
      /containment and mandatory post-run attestation both failed/i,
    );
    await runner.disposeGradleCache(cacheSeedId);
    disposed = true;
  } finally {
    if (!disposed) await runner.disposeGradleCache(cacheSeedId).catch(() => undefined);
    await runner.close();
  }
});

test("runner close stops admission, waits for an admitted operation, and is idempotent", async () => {
  let announceProbe!: () => void;
  const probeStarted = new Promise<void>((resolve) => {
    announceProbe = resolve;
  });
  let releaseProbe!: () => void;
  const probeGate = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  class BlockingBackend extends FakeBackend {
    closeCalls = 0;

    override async probe(): Promise<CapabilityResult> {
      announceProbe();
      await probeGate;
      return super.probe();
    }

    override async close(): Promise<void> {
      this.closeCalls += 1;
    }
  }

  const backend = new BlockingBackend();
  const runner = new TrustedBuildRunner({ backend });
  const admitted = runner.probeCapabilities();
  await probeStarted;
  const closing = runner.close();

  const rejectedDuringClose = await runner.probeCapabilities();
  assert.equal(rejectedDuringClose.available, false);
  assert.deepEqual(rejectedDuringClose.reasons, ["RUNNER_CLOSING_OR_CLOSED"]);
  await assert.rejects(
    runner.sealGradleCache("/must-not-be-read"),
    /closing or closed/i,
  );

  releaseProbe();
  assert.equal((await admitted).available, true);
  await closing;
  await runner.close();
  assert.equal(backend.closeCalls, 2);

  const rejectedAfterClose = await runner.probeCapabilities();
  assert.equal(rejectedAfterClose.available, false);
  assert.deepEqual(rejectedAfterClose.reasons, ["RUNNER_CLOSING_OR_CLOSED"]);
});

test("cache disposal removes its opaque id before concurrent environment admission", async (t) => {
  const cacheSource = await realpath(await mkdtemp(path.join(os.tmpdir(), "build-runner-dispose-race-")));
  t.after(async () => rm(cacheSource, { recursive: true, force: true }));
  await cacheFixture(cacheSource);
  const runner = new TrustedBuildRunner({ backend: new FakeBackend() });
  t.after(async () => runner.close());
  const sealed = await runner.sealGradleCache(cacheSource);
  const cacheSeedId = sealed.cache_seed_id as string;

  const disposing = runner.disposeGradleCache(cacheSeedId);
  await assert.rejects(
    runner.createBuildEnvironment({
      expectedBackend: "docker",
      role: "baseline",
      phase: "regression",
      workspaceRoot: "/must-not-be-read/workspace",
      snapshotRoot: "/must-not-be-read/snapshot",
      expectedSourceSnapshotSha256: HASH,
      expectedWorkspaceManifestSha256: "8".repeat(64),
      expectedWorkspaceCanonicalDiffSha256: "9".repeat(64),
      cacheSeedId,
      projectRelativeDir: ".",
      tasks: ["testDebugUnitTest"],
    }),
    /unknown cache seed id/i,
  );
  const disposed = await disposing;
  assert.equal(disposed.disposed, true);
});
