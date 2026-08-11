import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { runProcess, type ProcessResult } from "./process-runner.js";
import {
  TOOLCHAIN_PROBE,
  TOOLCHAIN_PROBE_SCHEMA_VERSION,
  verifyToolchainProbeOutput,
} from "./toolchain-probe.js";

const PROBE_TEST_TIMEOUT_MS = 10_000;

interface ProbeFixture {
  root: string;
  probe: string;
  java: string;
  apkAnalyzer: string;
  apkSigner: string;
  sourceProperties: string;
}

async function executable(file: string, source: string): Promise<void> {
  await writeFile(file, `#!/bin/sh\nset -eu\n${source}`, { mode: 0o700 });
  await chmod(file, 0o700);
}

async function fixture(t: TestContext): Promise<ProbeFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "toolchain-probe-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const java = path.join(root, "java");
  const cmdlineTools = path.join(root, "android-sdk", "cmdline-tools", "19.0");
  const bin = path.join(cmdlineTools, "bin");
  const apkAnalyzer = path.join(bin, "apkanalyzer");
  const apkSigner = path.join(root, "apksigner");
  const sourceProperties = path.join(cmdlineTools, "source.properties");
  const probe = path.join(root, "probe.sh");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await writeFile(probe, TOOLCHAIN_PROBE, { mode: 0o700 });
  await executable(java, `
test "$#" -eq 1
test "$1" = "-version"
printf '%s\\n' 'openjdk version "17.0.12"' 'OpenJDK Runtime Environment'
`);
  await executable(apkAnalyzer, `
# 任何 --version 调用都会令测试失败，确保 usage 不再被冒充成版本。
test "$#" -eq 1
test "$1" = "--help"
printf '%s\\n' 'Usage: apkanalyzer <subject> <verb> <apk>' 'manifest print application manifest'
`);
  await executable(apkSigner, `
test "$#" -eq 1
test "$1" = "version"
printf '%s\\n' '0.9'
`);
  await writeFile(
    sourceProperties,
    "Pkg.Desc=Android SDK Command-line Tools\nPkg.Revision=19.0\n",
    { mode: 0o600 },
  );
  return { root, probe, java, apkAnalyzer, apkSigner, sourceProperties };
}

async function runProbe(value: ProbeFixture): Promise<ProcessResult> {
  return runProcess("/bin/sh", [
    value.probe,
    value.java,
    value.apkAnalyzer,
    value.apkSigner,
  ], {
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    timeoutMs: PROBE_TEST_TIMEOUT_MS,
    maxOutputBytes: 32 * 1024,
  });
}

function executables(value: ProbeFixture) {
  return {
    java: value.java,
    apkAnalyzer: value.apkAnalyzer,
    apkSigner: value.apkSigner,
  };
}

test("probe derives the cmdline-tools identity from its exact source.properties", async (t) => {
  const value = await fixture(t);
  const result = await runProbe(value);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, new RegExp(`^${TOOLCHAIN_PROBE_SCHEMA_VERSION}`));
  assert.equal(result.stdout.includes("Usage: apkanalyzer"), false);

  const verified = verifyToolchainProbeOutput(result.stdout, executables(value));
  assert.equal(verified.identity.cmdline_tools.pkg_revision, "19.0");
  assert.equal(verified.identity.cmdline_tools.help_option, "--help");
  assert.deepEqual(
    verified.identity.cmdline_tools.required_help_terms,
    ["apkanalyzer", "manifest"],
  );
  assert.equal(verified.identity.java.version_output.includes("17.0.12"), true);
  assert.equal(verified.identity.apksigner.version_output, "0.9");
  assert.match(verified.sha256, /^[a-f0-9]{64}$/);

  const crlf = verifyToolchainProbeOutput(
    result.stdout.replace(/\n/g, "\r\n"),
    executables(value),
  );
  assert.equal(crlf.sha256, verified.sha256);

  const otherRevision = verifyToolchainProbeOutput(
    result.stdout.replace(
      "app-test-ctrl:cmdline-tools-pkg-revision:begin\n19.0\n",
      "app-test-ctrl:cmdline-tools-pkg-revision:begin\n20.0\n",
    ),
    executables(value),
  );
  assert.notEqual(otherRevision.sha256, verified.sha256);
});

test("probe rejects duplicate or malformed Pkg.Revision entries", async (t) => {
  const value = await fixture(t);
  await writeFile(
    value.sourceProperties,
    "Pkg.Revision=19.0\n  Pkg.Revision = 20.0\n",
    { mode: 0o600 },
  );
  const duplicate = await runProbe(value);
  assert.notEqual(duplicate.exitCode, 0);
  assert.equal(duplicate.stdout, "");

  await writeFile(value.sourceProperties, "Pkg.Revision=usage output\n", { mode: 0o600 });
  const malformed = await runProbe(value);
  assert.notEqual(malformed.exitCode, 0);
  assert.equal(malformed.stdout, "");
});

test("probe never searches an adjacent source.properties fallback", async (t) => {
  const value = await fixture(t);
  const otherPackage = path.join(value.root, "other", "bin");
  await mkdir(otherPackage, { recursive: true, mode: 0o700 });
  const otherAnalyzer = path.join(otherPackage, "apkanalyzer");
  await executable(otherAnalyzer, `
test "$#" -eq 1
test "$1" = "--help"
printf '%s\\n' 'Usage: apkanalyzer' 'manifest'
`);
  await writeFile(
    path.join(value.root, "source.properties"),
    "Pkg.Revision=99.0\n",
    { mode: 0o600 },
  );
  const result = await runProcess("/bin/sh", [
    value.probe,
    value.java,
    otherAnalyzer,
    value.apkSigner,
  ], {
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    timeoutMs: PROBE_TEST_TIMEOUT_MS,
    maxOutputBytes: 32 * 1024,
  });
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stdout, "");
});

test("probe derives package metadata from the canonical analyzer behind a bin alias", async (t) => {
  const value = await fixture(t);
  const aliasPackage = path.join(value.root, "android-sdk", "cmdline-tools", "latest");
  await mkdir(aliasPackage, { recursive: true, mode: 0o700 });
  await symlink("../19.0/bin", path.join(aliasPackage, "bin"), "dir");
  await writeFile(
    path.join(aliasPackage, "source.properties"),
    "Pkg.Revision=99.0\n",
    { mode: 0o600 },
  );
  const aliasedAnalyzer = path.join(aliasPackage, "bin", "apkanalyzer");
  const result = await runProcess("/bin/sh", [
    value.probe,
    value.java,
    aliasedAnalyzer,
    value.apkSigner,
  ], {
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    timeoutMs: PROBE_TEST_TIMEOUT_MS,
    maxOutputBytes: 32 * 1024,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const verified = verifyToolchainProbeOutput(result.stdout, {
    java: value.java,
    apkAnalyzer: aliasedAnalyzer,
    apkSigner: value.apkSigner,
  });
  assert.equal(verified.identity.cmdline_tools.pkg_revision, "19.0");
});

test("probe requires both apkanalyzer and manifest in --help", async (t) => {
  const value = await fixture(t);
  await executable(value.apkAnalyzer, `
test "$#" -eq 1
test "$1" = "--help"
printf '%s\\n' 'Usage: apkanalyzer <subject>' 'files list'
`);
  const missingManifest = await runProbe(value);
  assert.equal(missingManifest.exitCode, 67);
  assert.equal(missingManifest.stdout, "");

  await executable(value.apkAnalyzer, `
test "$#" -eq 1
test "$1" = "--help"
printf '%s\\n' 'Usage: package-inspector <subject>' 'manifest print'
`);
  const missingCommand = await runProbe(value);
  assert.equal(missingCommand.exitCode, 66);
  assert.equal(missingCommand.stdout, "");
});

test("host verifier rejects reordered, injected, or malformed protocol records", async (t) => {
  const value = await fixture(t);
  const result = await runProbe(value);
  assert.equal(result.exitCode, 0, result.stderr);
  const expected = executables(value);

  assert.throws(
    () => verifyToolchainProbeOutput(
      result.stdout.replace(
        "app-test-ctrl:apkanalyzer-help-contract:begin\n",
        "app-test-ctrl:apkanalyzer-help-contract:begin\nunexpected\n",
      ),
      expected,
    ),
    /sections|contract/,
  );
  assert.throws(
    () => verifyToolchainProbeOutput(
      result.stdout.replace("\n19.0\n", "\n19.0-preview\n"),
      expected,
    ),
    /Pkg\.Revision/,
  );
  assert.throws(
    () => verifyToolchainProbeOutput(
      result.stdout.replace(
        "app-test-ctrl:java-version:end\n",
        "app-test-ctrl:java-version:end\napp-test-ctrl:java-version:end\n",
      ),
      expected,
    ),
    /duplicated/,
  );
  assert.throws(
    () => verifyToolchainProbeOutput(result.stdout, {
      ...expected,
      java: `${value.root}/./java`,
    }),
    /normalized/,
  );
  assert.throws(
    () => verifyToolchainProbeOutput(`${result.stdout}\u0000`, expected),
    /control/,
  );
  assert.throws(
    () => verifyToolchainProbeOutput("x".repeat(16 * 1024 + 1), expected),
    /exceeds/,
  );

  const changedExecutable = verifyToolchainProbeOutput(result.stdout, {
    ...expected,
    java: `${value.root}/other-java`,
  });
  assert.notEqual(
    changedExecutable.sha256,
    verifyToolchainProbeOutput(result.stdout, expected).sha256,
  );
});
