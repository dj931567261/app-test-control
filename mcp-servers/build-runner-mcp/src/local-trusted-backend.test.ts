import assert from "node:assert/strict";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { inspectApk } from "./apk.js";
import type { LocalTrustedRunnerConfig } from "./config.js";
import { LocalTrustedBackend } from "./local-trusted-backend.js";
import { TrustedBuildRunner } from "./runner.js";

interface LocalFixture {
  root: string;
  config: LocalTrustedRunnerConfig;
  workspace: string;
  cacheSeed: string;
  analyzerJar: string;
  javaRelease: string;
}

async function executable(file: string, body: string): Promise<void> {
  await writeFile(file, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o700 });
}

async function fixture(t: TestContext, gradleBody?: string): Promise<LocalFixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "local-trusted-backend-test-")));
  await chmod(root, 0o700);
  t.after(async () => {
    for (const directory of [
      path.join(root, "cache-seed", "caches", "modules-2"),
      path.join(root, "cache-seed", "caches"),
      path.join(root, "cache-seed", "wrapper", "dists"),
      path.join(root, "cache-seed", "wrapper"),
      path.join(root, "cache-seed"),
    ]) {
      await chmod(directory, 0o700).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  });

  const javaHome = path.join(root, "java");
  const sdk = path.join(root, "sdk");
  const analyzerPackage = path.join(sdk, "cmdline-tools", "13.0");
  const signerPackage = path.join(sdk, "build-tools", "36.0.0");
  const workspace = path.join(root, "workspace");
  const cacheSeed = path.join(root, "cache-seed");
  for (const directory of [
    path.join(javaHome, "bin"),
    path.join(javaHome, "lib"),
    path.join(analyzerPackage, "bin"),
    path.join(analyzerPackage, "lib"),
    path.join(signerPackage, "lib"),
    workspace,
    path.join(cacheSeed, "caches", "modules-2"),
    path.join(cacheSeed, "wrapper", "dists"),
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }

  await executable(path.join(javaHome, "bin", "java"), 'printf "openjdk 17 test\\n" >&2');
  const javaRelease = path.join(javaHome, "release");
  await writeFile(javaRelease, 'JAVA_VERSION="17-test"\n', { mode: 0o600 });
  await writeFile(path.join(javaHome, "lib", "modules"), "java-runtime\n", { mode: 0o600 });

  const analyzer = path.join(analyzerPackage, "bin", "apkanalyzer");
  await executable(analyzer, `
if [ "\${1-}" = "--help" ]; then
  printf "Usage: apkanalyzer <subject> <verb> <apk>\\n" >&2
  exit 0
fi
test "\${1-}" = manifest
test -f "\${3-}"
case "\${2-}" in
  application-id) printf "com.example.local\\n" ;;
  version-name) printf "1.0\\n" ;;
  version-code) printf "7\\n" ;;
  debuggable) printf "true\\n" ;;
  *) exit 64 ;;
esac`);
  await writeFile(path.join(analyzerPackage, "source.properties"), "Pkg.Revision=13.0\n", {
    mode: 0o600,
  });
  const analyzerJar = path.join(analyzerPackage, "lib", "apkanalyzer-classpath.jar");
  await writeFile(analyzerJar, "analyzer-implementation\n", { mode: 0o600 });

  const signer = path.join(signerPackage, "apksigner");
  await executable(signer, `
if [ "\${1-}" = version ]; then printf "0.9\\n"; exit 0; fi
test "\${1-}" = verify
test "\${2-}" = --print-certs
test -f "\${3-}"
printf "Signer #1 certificate SHA-256 digest: %s\\n" "${"AB:".repeat(31)}AB"`);
  await writeFile(path.join(signerPackage, "source.properties"), "Pkg.Revision=36.0.0\n", {
    mode: 0o600,
  });
  await writeFile(path.join(signerPackage, "lib", "apksigner.jar"), "signer-implementation\n", {
    mode: 0o600,
  });

  await executable(path.join(workspace, "gradlew"), gradleBody ?? `
test "\${FIREBASE_TOKEN-unset}" = unset
test "\${HTTPS_PROXY-unset}" = unset
test -f "$GRADLE_USER_HOME/caches/modules-2/module.bin"
printf "HOME=%s\\nTMPDIR=%s\\nGRADLE=%s\\n" "$HOME" "$TMPDIR" "$GRADLE_USER_HOME"
printf "ARG=%s\\n" "$@"`);
  await writeFile(path.join(cacheSeed, "caches", "modules-2", "module.bin"), "dependency\n", {
    mode: 0o400,
  });
  await chmod(path.join(cacheSeed, "caches", "modules-2"), 0o500);
  await chmod(path.join(cacheSeed, "caches"), 0o500);
  await chmod(path.join(cacheSeed, "wrapper", "dists"), 0o500);
  await chmod(path.join(cacheSeed, "wrapper"), 0o500);
  await chmod(cacheSeed, 0o500);

  return {
    root,
    config: {
      backend: "local_trusted",
      javaHome,
      androidSdkRoot: sdk,
      apkAnalyzer: analyzer,
      apkSigner: signer,
      maxOutputBytes: 64 * 1024,
    },
    workspace,
    cacheSeed,
    analyzerJar,
    javaRelease,
  };
}

test("local_trusted reports an explicit non-isolated v2 capability", async (t) => {
  const value = await fixture(t);
  const backend = new LocalTrustedBackend(value.config);
  const runner = new TrustedBuildRunner({ backend });
  t.after(async () => runner.close());

  const capability = await runner.probeCapabilities();
  assert.equal(capability.schema_version, "build-runner-capabilities/v2");
  assert.equal(capability.backend, "local_trusted");
  assert.equal(capability.execution_profile, "local_trusted");
  assert.equal(capability.available, true);
  assert.equal(capability.local_trusted_execution_eligible, true);
  assert.equal(capability.auto_patch_eligible, false);
  assert.equal(capability.strong_isolation, false);
  assert.equal(capability.network_policy, "not_enforced");
  assert.equal(capability.filesystem_write_isolation, "not_enforced");
  assert.equal(capability.secret_filesystem_isolation, "not_enforced");
  assert.equal(capability.process_containment, "process_group_best_effort");
  assert.deepEqual(capability.workspace_disk_quota, { enforced: false, mechanism: "none" });
});

test("local_trusted accepts trusted group-writable toolchain ancestors but rejects world-writable ones", async (t) => {
  const groupWritable = await fixture(t);
  await chmod(groupWritable.root, 0o770);
  const groupBackend = new LocalTrustedBackend(groupWritable.config);
  t.after(async () => groupBackend.close());
  assert.equal((await groupBackend.probe()).available, true);

  const worldWritable = await fixture(t);
  await chmod(worldWritable.root, 0o777);
  const worldBackend = new LocalTrustedBackend(worldWritable.config);
  t.after(async () => worldBackend.close());
  const capability = await worldBackend.probe();
  assert.equal(capability.available, false);
  assert.match(capability.reasons.join(" "), /unsafe writable ancestor/i);
});

test("local_trusted executes only fixed offline gradlew argv with a disposable minimal environment", async (t) => {
  const value = await fixture(t);
  const backend = new LocalTrustedBackend(value.config);
  t.after(async () => backend.close());
  const seedBefore = await readFile(path.join(value.cacheSeed, "caches/modules-2/module.bin"), "utf8");

  const result = await backend.runBuildCommand({
    workspace: value.workspace,
    cacheSeed: value.cacheSeed,
    projectRelativeDir: ".",
    tasks: [":app:testDebugUnitTest", ":app:checkDebug"],
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /ARG=--offline/);
  assert.match(result.stdout, /ARG=--no-daemon/);
  assert.match(result.stdout, /ARG=--console=plain/);
  assert.ok(
    result.stdout.indexOf("ARG=:app:testDebugUnitTest")
      < result.stdout.indexOf("ARG=:app:checkDebug"),
  );
  const gradleHome = /^GRADLE=(.+)$/m.exec(result.stdout)?.[1];
  assert.ok(gradleHome);
  await assert.rejects(access(gradleHome), /ENOENT/);
  assert.equal(
    await readFile(path.join(value.cacheSeed, "caches/modules-2/module.bin"), "utf8"),
    seedBefore,
  );
  await assert.rejects(
    backend.runBuildCommand({
      workspace: value.workspace,
      cacheSeed: value.cacheSeed,
      projectRelativeDir: ".",
      tasks: ["--init-script"],
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    }),
    /invalid.*Gradle task/i,
  );
});

test("local_trusted pins Java metadata and SDK implementation content, not only launchers", async (t) => {
  const value = await fixture(t);
  const backend = new LocalTrustedBackend(value.config);
  t.after(async () => backend.close());
  assert.equal((await backend.probe()).available, true);

  await writeFile(value.analyzerJar, "changed-analyzer-implementation\n", { mode: 0o600 });
  const analyzerDrift = await backend.probe();
  assert.equal(analyzerDrift.available, false);
  assert.match(analyzerDrift.reasons.join(" "), /identity drifted/i);

  const second = await fixture(t);
  const javaBackend = new LocalTrustedBackend(second.config);
  t.after(async () => javaBackend.close());
  assert.equal((await javaBackend.probe()).available, true);
  await writeFile(second.javaRelease, 'JAVA_VERSION="changed"\n', { mode: 0o600 });
  const javaDrift = await javaBackend.probe();
  assert.equal(javaDrift.available, false);
  assert.match(javaDrift.reasons.join(" "), /identity drifted/i);
});

test("local_trusted APK inspection uses the fixed host tools and reports non-isolated provenance", async (t) => {
  const value = await fixture(t);
  const backend = new LocalTrustedBackend(value.config);
  t.after(async () => backend.close());
  const stage = path.join(value.root, "apk-stage");
  await mkdir(stage, { mode: 0o700 });
  await writeFile(
    path.join(stage, "artifact.apk"),
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]),
    { mode: 0o400 },
  );
  const inspected = await inspectApk({
    backend,
    workspaceDir: stage,
    artifactRelativePath: "artifact.apk",
    tasks: [":app:assembleDebug"],
  });
  assert.equal(inspected.schema_version, "android-apk-inspection/v2");
  assert.equal(inspected.inspector_backend, "local_trusted");
  assert.equal(inspected.execution_profile, "local_trusted");
  assert.equal(inspected.inspector_isolated, false);
  assert.equal(inspected.verification_level, "trusted_local");
  assert.equal(inspected.package, "com.example.local");
  assert.deepEqual(inspected.signer_certificate_sha256, ["ab".repeat(32)]);
});

test("local_trusted rejects root and cleanup-marker drift poisons admission until close retry", async (t) => {
  const value = await fixture(t);
  const rootBackend = new LocalTrustedBackend(value.config, { testOnlyUid: 0 });
  t.after(async () => rootBackend.close());
  const unavailable = await rootBackend.probe();
  assert.equal(unavailable.available, false);
  assert.match(unavailable.reasons.join(" "), /non-root/i);

  const poisonedFixture = await fixture(t, `
root=$(dirname "$GRADLE_USER_HOME")
cp "$root/.app-test-ctrl-owner.json" "$PWD/owner-backup.json"
printf "%s\\n" "$root" > "$PWD/private-root.txt"
printf "tampered\\n" > "$root/.app-test-ctrl-owner.json"`);
  const backend = new LocalTrustedBackend(poisonedFixture.config);
  let closed = false;
  t.after(async () => {
    if (!closed) await backend.close().catch(() => undefined);
  });
  await assert.rejects(
    backend.runBuildCommand({
      workspace: poisonedFixture.workspace,
      cacheSeed: poisonedFixture.cacheSeed,
      projectRelativeDir: ".",
      tasks: ["testDebugUnitTest"],
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    }),
    /owner marker drifted/i,
  );
  assert.equal((await backend.probe()).available, false);
  await assert.rejects(backend.close(), /cleanup failed/i);

  const privateRoot = (await readFile(path.join(poisonedFixture.workspace, "private-root.txt"), "utf8")).trim();
  await copyFile(
    path.join(poisonedFixture.workspace, "owner-backup.json"),
    path.join(privateRoot, ".app-test-ctrl-owner.json"),
  );
  await chmod(path.join(privateRoot, ".app-test-ctrl-owner.json"), 0o600);
  await backend.close();
  closed = true;
});

test("local_trusted pins private-root inode identity and rejects path replacement", async (t) => {
  const value = await fixture(t, `
root=$(dirname "$GRADLE_USER_HOME")
stolen="\${root}-stolen"
cp "$root/.app-test-ctrl-owner.json" "$PWD/owner-backup.json"
mv "$root" "$stolen"
mkdir -m 700 "$root"
cp "$PWD/owner-backup.json" "$root/.app-test-ctrl-owner.json"
chmod 600 "$root/.app-test-ctrl-owner.json"
printf "%s\\n" "$root" > "$PWD/private-root.txt"
printf "%s\\n" "$stolen" > "$PWD/stolen-root.txt"`);
  const backend = new LocalTrustedBackend(value.config);
  let closed = false;
  t.after(async () => {
    if (!closed) await backend.close().catch(() => undefined);
  });

  await assert.rejects(
    backend.runBuildCommand({
      workspace: value.workspace,
      cacheSeed: value.cacheSeed,
      projectRelativeDir: ".",
      tasks: ["testDebugUnitTest"],
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    }),
    /cleanup root identity is invalid/i,
  );
  const poisoned = await backend.probe();
  assert.equal(poisoned.available, false);
  assert.match(poisoned.reasons.join(" "), /poisoned/i);

  const privateRoot = (await readFile(path.join(value.workspace, "private-root.txt"), "utf8")).trim();
  const stolenRoot = (await readFile(path.join(value.workspace, "stolen-root.txt"), "utf8")).trim();
  await rm(privateRoot, { recursive: true, force: false });
  await rename(stolenRoot, privateRoot);
  await backend.close();
  closed = true;
});

test("local_trusted preserves both operation and cleanup failures", async (t) => {
  const value = await fixture(t, `
printf "\\n# changed during run\\n" >> "$0"
root=$(dirname "$GRADLE_USER_HOME")
cp "$root/.app-test-ctrl-owner.json" "$PWD/owner-backup.json"
printf "%s\\n" "$root" > "$PWD/private-root.txt"
printf "tampered\\n" > "$root/.app-test-ctrl-owner.json"`);
  const backend = new LocalTrustedBackend(value.config);
  let closed = false;
  t.after(async () => {
    if (!closed) await backend.close().catch(() => undefined);
  });

  let observed: unknown;
  try {
    await backend.runBuildCommand({
      workspace: value.workspace,
      cacheSeed: value.cacheSeed,
      projectRelativeDir: ".",
      tasks: ["testDebugUnitTest"],
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    });
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof AggregateError);
  assert.match(observed.message, /operation failed.*cleanup could not be proven/i);
  assert.equal(observed.errors.length, 2);
  assert.match(String(observed.errors[0]), /Gradle wrapper changed/i);
  assert.match(String(observed.errors[1]), /owner marker drifted/i);

  const privateRoot = (await readFile(path.join(value.workspace, "private-root.txt"), "utf8")).trim();
  await copyFile(
    path.join(value.workspace, "owner-backup.json"),
    path.join(privateRoot, ".app-test-ctrl-owner.json"),
  );
  await chmod(path.join(privateRoot, ".app-test-ctrl-owner.json"), 0o600);
  await backend.close();
  closed = true;
});
