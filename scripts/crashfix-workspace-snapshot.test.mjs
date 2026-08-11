import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";

import {
  EMPTY_APPROVED_TEST_FIXTURES_SHA256,
  EXCLUSION_POLICY_SHA256,
  MAX_APPROVED_TEST_FIXTURES,
  WORKSPACE_CREDENTIAL_REASON_CODES,
  WorkspaceCredentialError,
  auditSnapshotWorkspace,
  cloneSnapshotWorkspace,
  exportCandidateWorkspace,
  materializeWorkspaceSnapshot,
  probeTestFixture,
  validateWorkspaceRelativePath,
  verifyWorkspaceSource,
} from "../skills/crashfix/scripts/materialize-workspace-snapshot.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(
  "skills/crashfix/scripts/materialize-workspace-snapshot.mjs",
);
const sharedReportRoot = await mkdtemp(path.join(os.tmpdir(), "crashfix-shared-report-root-"));
after(async () => rm(sharedReportRoot, { recursive: true, force: true }));

async function materializeForTest(options, lifecycle = undefined) {
  return materializeWorkspaceSnapshot({
    ...options,
    forbidRoots: [sharedReportRoot, ...(options.forbidRoots ?? [])],
  }, lifecycle);
}

async function cloneForTest(options, originalWorkspace, sourceSnapshot, lifecycle = undefined) {
  return cloneSnapshotWorkspace({
    ...options,
    expectedSourceRefSha256: sourceSnapshot.source_ref_sha256,
    expectedSourceSnapshotSha256: sourceSnapshot.source_snapshot_sha256,
    forbidRoots: [originalWorkspace, sharedReportRoot, ...(options.forbidRoots ?? [])],
  }, lifecycle);
}

async function verifySourceForTest(options) {
  return verifyWorkspaceSource({
    ...options,
    forbidRoots: [sharedReportRoot, ...(options.forbidRoots ?? [])],
  });
}

async function createWorkspace(prefix = "crashfix-workspace-source-") {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function unlockTree(root) {
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch {
    return;
  }
  if (rootStat.isSymbolicLink()) return;
  if (rootStat.isDirectory()) {
    await chmod(root, 0o700).catch(() => undefined);
    for (const name of await readdir(root).catch(() => [])) {
      await unlockTree(path.join(root, name));
    }
  } else {
    await chmod(root, 0o600).catch(() => undefined);
  }
}

async function cleanupResult(result, property) {
  if (result?.[property] === undefined) return;
  const privateRoot = path.dirname(result[property]);
  await unlockTree(privateRoot);
  await rm(privateRoot, { recursive: true, force: true });
}

function permissions(value) {
  return value.mode & 0o777;
}

function assertCredentialError(error, relativePath, reasonCode) {
  assert.ok(error instanceof WorkspaceCredentialError);
  assert.equal(error.name, "WorkspaceCredentialError");
  assert.equal(Object.hasOwn(error, "cause"), false);
  assert.deepEqual(Object.keys(error), ["diagnostic"]);
  assert.equal(error.stack, `WorkspaceCredentialError: ${error.message}`);
  assert.doesNotMatch(error.stack, /(?:file:\/\/|\/Users\/|\/private\/|[A-Za-z]:\\)/u);
  assert.deepEqual(error.diagnostic, {
    schema_version: "crashfix-workspace-credential-diagnostic/v1",
    error_code: "credential_material_detected",
    reason: reasonCode,
    relative_path: relativePath,
  });
  assert.equal(Object.isFrozen(error.diagnostic), true);
  assert.equal(Object.getOwnPropertyDescriptor(error, "diagnostic")?.writable, false);
  assert.equal(Object.getOwnPropertyDescriptor(error, "diagnostic")?.configurable, false);
  assert.deepEqual(Object.keys(error.diagnostic).sort(), [
    "error_code",
    "reason",
    "relative_path",
    "schema_version",
  ]);
  return true;
}

function assertHelperCliDiagnostic(
  error,
  _stage,
  forbiddenValues = [],
  _reason = "operation_rejected",
) {
  assert.ok(error && typeof error === "object");
  assert.equal(typeof error.stderr, "string");
  const lines = error.stderr.trimEnd().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    schema_version: "crashfix-workspace-helper-diagnostic/v1",
    error_code: "operation_failed",
  });
  for (const value of forbiddenValues) assert.equal(error.stderr.includes(value), false);
  return true;
}

test("credential diagnostic and exclusion policy identities stay closed", () => {
  assert.equal(
    EXCLUSION_POLICY_SHA256,
    "866adfaf3b2b6c8e1031f1574c95c6f3816dab6e1e57bea96cd4bf95d72c9faf",
  );
  assert.equal(
    EMPTY_APPROVED_TEST_FIXTURES_SHA256,
    "bdc2f2840abddf90f142415e49414323b7fc864b8816c3a7df3c039d3f21b5ce",
  );
  assert.equal(MAX_APPROVED_TEST_FIXTURES, 8);
  assert.equal(Object.isFrozen(WORKSPACE_CREDENTIAL_REASON_CODES), true);
  assert.deepEqual(WORKSPACE_CREDENTIAL_REASON_CODES, {
    PRIVATE_KEY_BLOCK: "private_key_block",
    HIGH_CONFIDENCE_TOKEN_OR_SENSITIVE_ASSIGNMENT:
      "high_confidence_token_or_sensitive_assignment",
    STRUCTURED_SENSITIVE_VALUE: "structured_sensitive_value",
    CREDENTIAL_FILE_NAME: "credential_file_name",
    CREDENTIAL_DIRECTORY_NAME: "credential_directory_name",
  });
});

test("creates a stable sealed snapshot, excludes unsafe trees, and detaches source bytes", async (t) => {
  const workspace = await createWorkspace();
  const equivalentWorkspace = await createWorkspace("crashfix-workspace-equivalent-");
  const results = [];
  t.after(async () => {
    for (const result of results) await cleanupResult(result, "snapshot_dir");
    await rm(equivalentWorkspace, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  await mkdir(path.join(workspace, "src"));
  await writeFile(path.join(workspace, "src", "Main.kt"), "fun value() = 1\n", "utf8");
  await writeFile(path.join(workspace, "gradlew"), "#!/bin/sh\necho ok\n", "utf8");
  await chmod(path.join(workspace, "gradlew"), 0o755);
  for (const excluded of [
    ".git",
    ".worktrees",
    "build",
    ".cache",
    "node_modules",
    ".firebase",
    "secrets",
    "coverage",
  ]) {
    await mkdir(path.join(workspace, excluded));
    await writeFile(path.join(workspace, excluded, "private.txt"), "do not copy\n", "utf8");
  }
  await writeFile(path.join(workspace, ".env"), "TOKEN=secret\n", "utf8");
  await writeFile(path.join(workspace, ".envrc"), "export API_TOKEN=secret\n", "utf8");
  await writeFile(
    path.join(workspace, "google-services.json"),
    "{\"project_info\":{\"project_id\":\"safe-test-client-config\"}}\n",
    "utf8",
  );
  await writeFile(
    path.join(workspace, "firebase-service-account.json"),
    "{\"private_key\":\"secret\"}\n",
    "utf8",
  );
  for (const relativeFile of [
    "release.apk",
    "release.aab",
    "archive.ipa",
    "mapping.txt",
    "coverage.xml",
    "bundle.js.map",
    "src/nested-debug.apk",
    "src/nested.css.map",
  ]) {
    await writeFile(path.join(workspace, relativeFile), "excluded artifact\n", "utf8");
  }
  for (const relativeDirectory of [
    "Release.app",
    "Archive.xcarchive",
    "src/Symbols.dSYM",
  ]) {
    await mkdir(path.join(workspace, relativeDirectory));
    await writeFile(
      path.join(workspace, relativeDirectory, "binary"),
      "excluded artifact tree\n",
      "utf8",
    );
  }

  const first = await materializeForTest({ workspace });
  results.push(first);
  const second = await materializeForTest({ workspace });
  results.push(second);
  await mkdir(path.join(equivalentWorkspace, "src"));
  await writeFile(path.join(equivalentWorkspace, "src", "Main.kt"), "fun value() = 1\n", "utf8");
  await writeFile(path.join(equivalentWorkspace, "gradlew"), "#!/bin/sh\necho ok\n", "utf8");
  await chmod(path.join(equivalentWorkspace, "gradlew"), 0o755);
  await writeFile(
    path.join(equivalentWorkspace, "google-services.json"),
    "{\"project_info\":{\"project_id\":\"safe-test-client-config\"}}\n",
    "utf8",
  );
  const equivalent = await materializeForTest({ workspace: equivalentWorkspace });
  results.push(equivalent);

  assert.equal(first.schema_version, "crashfix-workspace-snapshot/v2");
  assert.equal(first.approved_test_fixtures_sha256, EMPTY_APPROVED_TEST_FIXTURES_SHA256);
  assert.equal(first.approved_test_fixture_count, 0);
  assert.equal(first.manifest_sha256, second.manifest_sha256);
  assert.equal(first.source_ref_sha256, second.source_ref_sha256);
  assert.equal(first.source_snapshot_sha256, second.source_snapshot_sha256);
  assert.equal(first.source_snapshot_sha256, equivalent.source_snapshot_sha256);
  assert.notEqual(first.source_ref_sha256, equivalent.source_ref_sha256);
  assert.equal(first.exclusion_policy_sha256, EXCLUSION_POLICY_SHA256);
  assert.equal(second.exclusion_policy_sha256, EXCLUSION_POLICY_SHA256);
  assert.equal(first.files, 3);
  assert.equal(first.directories, 2);
  assert.equal(await readFile(path.join(first.snapshot_dir, "src", "Main.kt"), "utf8"), "fun value() = 1\n");
  await assert.rejects(readFile(path.join(first.snapshot_dir, ".env")), /ENOENT/u);
  await assert.rejects(readFile(path.join(first.snapshot_dir, ".envrc")), /ENOENT/u);
  await assert.rejects(readFile(path.join(first.snapshot_dir, "build", "private.txt")), /ENOENT/u);
  await assert.rejects(readFile(path.join(first.snapshot_dir, ".firebase", "private.txt")), /ENOENT/u);
  await assert.rejects(readFile(path.join(first.snapshot_dir, "firebase-service-account.json")), /ENOENT/u);
  for (const relativeArtifact of [
    "release.apk",
    "mapping.txt",
    "bundle.js.map",
    "src/nested-debug.apk",
    "src/nested.css.map",
    "Release.app/binary",
    "Archive.xcarchive/binary",
    "src/Symbols.dSYM/binary",
    "coverage/private.txt",
  ]) {
    await assert.rejects(readFile(path.join(first.snapshot_dir, relativeArtifact)), /ENOENT/u);
  }
  assert.match(
    await readFile(path.join(first.snapshot_dir, "google-services.json"), "utf8"),
    /safe-test-client-config/u,
  );

  assert.equal(permissions(await stat(path.dirname(first.snapshot_dir))), 0o700);
  assert.equal(permissions(await stat(first.snapshot_dir)), 0o500);
  assert.equal(permissions(await stat(path.join(first.snapshot_dir, "src"))), 0o500);
  assert.equal(permissions(await stat(path.join(first.snapshot_dir, "src", "Main.kt"))), 0o400);
  assert.equal(permissions(await stat(path.join(first.snapshot_dir, "gradlew"))), 0o500);

  const ownerText = await readFile(path.join(path.dirname(first.snapshot_dir), ".owner.json"), "utf8");
  const manifestText = await readFile(path.join(path.dirname(first.snapshot_dir), ".manifest.json"), "utf8");
  assert.equal(ownerText.includes(workspace), false);
  assert.equal(manifestText.includes(workspace), false);
  assert.equal(JSON.parse(ownerText).source_ref_sha256, first.source_ref_sha256);
  assert.equal(JSON.parse(manifestText).source_ref_sha256, first.source_ref_sha256);
  assert.equal(JSON.parse(ownerText).exclusion_policy_sha256, EXCLUSION_POLICY_SHA256);
  assert.equal(JSON.parse(manifestText).exclusion_policy_sha256, EXCLUSION_POLICY_SHA256);
  assert.equal(JSON.parse(ownerText).dynamic_exclusions_sha256, first.dynamic_exclusions_sha256);
  assert.equal(JSON.parse(manifestText).dynamic_exclusions_sha256, first.dynamic_exclusions_sha256);

  const verified = await verifySourceForTest({
    workspace,
    snapshotRoot: first.snapshot_root,
    expectedSourceRefSha256: first.source_ref_sha256,
    expectedSourceSnapshotSha256: first.source_snapshot_sha256,
  });
  assert.equal(verified.unchanged, true);
  assert.equal(verified.source_snapshot_sha256, first.source_snapshot_sha256);
  assert.equal(JSON.stringify(verified).includes(workspace), false);
  await assert.rejects(
    verifySourceForTest({
      workspace: equivalentWorkspace,
      snapshotRoot: first.snapshot_root,
      expectedSourceRefSha256: first.source_ref_sha256,
      expectedSourceSnapshotSha256: first.source_snapshot_sha256,
    }),
    /source reference/u,
  );

  await writeFile(path.join(workspace, "src", "Main.kt"), "fun value() = 2\n", "utf8");
  assert.equal(await readFile(path.join(first.snapshot_dir, "src", "Main.kt"), "utf8"), "fun value() = 1\n");
  await assert.rejects(
    verifySourceForTest({
      workspace,
      snapshotRoot: first.snapshot_root,
      expectedSourceRefSha256: first.source_ref_sha256,
      expectedSourceSnapshotSha256: first.source_snapshot_sha256,
    }),
    /included-source manifest changed/u,
  );
});

test("explicit test fixture approvals bind exact paths and hashes through the sealed snapshot lifecycle", async (t) => {
  const workspace = await createWorkspace("crashfix-approved-fixture-source-");
  const exportParent = await createWorkspace("crashfix-approved-fixture-export-");
  const results = [];
  const exportedDestinations = [];
  t.after(async () => {
    for (const destination of exportedDestinations) {
      await unlockTree(destination);
      await rm(destination, { recursive: true, force: true });
    }
    for (const [result, property] of results.reverse()) await cleanupResult(result, property);
    await rm(exportParent, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  await mkdir(path.join(workspace, "fixtures"));
  await writeFile(path.join(workspace, "App.kt"), "class App\n", "utf8");
  const vehicleContents = `${JSON.stringify({ password: "fixture-runtime-value" })}\n`;
  const accountContents = `${JSON.stringify({ api_token: "fixture-token-value" })}\n`;
  await writeFile(path.join(workspace, "fixtures", "vehicle.json"), vehicleContents, "utf8");
  await writeFile(path.join(workspace, "fixtures", "account.json"), accountContents, "utf8");

  await assert.rejects(
    materializeForTest({ workspace }),
    (error) => assertCredentialError(
      error,
      "fixtures/account.json",
      WORKSPACE_CREDENTIAL_REASON_CODES.STRUCTURED_SENSITIVE_VALUE,
    ),
  );

  const vehicleProbe = await probeTestFixture({
    workspace,
    relativePath: "fixtures/vehicle.json",
  });
  const accountProbe = await probeTestFixture({
    workspace,
    relativePath: "fixtures/account.json",
  });
  for (const probe of [vehicleProbe, accountProbe]) {
    assert.equal(probe.schema_version, "crashfix-test-fixture-probe/v1");
    assert.equal(probe.reason, WORKSPACE_CREDENTIAL_REASON_CODES.STRUCTURED_SENSITIVE_VALUE);
    assert.equal(probe.override_eligible, true);
    assert.equal(probe.approval_requires_user_confirmation, true);
    assert.match(probe.source_ref_sha256, /^[a-f0-9]{64}$/u);
    assert.match(probe.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(probe.bytes > 0);
    assert.equal(JSON.stringify(probe).includes("fixture-runtime-value"), false);
    assert.equal(JSON.stringify(probe).includes("fixture-token-value"), false);
    assert.equal(JSON.stringify(probe).includes(workspace), false);
  }
  assert.equal(vehicleProbe.source_ref_sha256, accountProbe.source_ref_sha256);

  const approvalEntryFor = (probe) => ({
    relative_path: probe.relative_path,
    sha256: probe.sha256,
  });
  const approvalReceipt = (entries) => ({
    schema_version: "crashfix-test-fixture-approval/v1",
    execution_profile: "local_trusted",
    project_classification: "test",
    user_confirmed: true,
    source_ref_sha256: vehicleProbe.source_ref_sha256,
    entries,
  });
  const first = await materializeForTest({
    workspace,
    testFixtureApproval: approvalReceipt([
      approvalEntryFor(vehicleProbe),
      approvalEntryFor(accountProbe),
    ]),
  });
  results.push([first, "snapshot_dir"]);
  const reordered = await materializeForTest({
    workspace,
    testFixtureApproval: approvalReceipt([
      approvalEntryFor(accountProbe),
      approvalEntryFor(vehicleProbe),
    ]),
  });
  results.push([reordered, "snapshot_dir"]);

  assert.equal(first.approved_test_fixture_count, 2);
  assert.match(first.approved_test_fixtures_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(
    first.approved_test_fixtures_sha256,
    reordered.approved_test_fixtures_sha256,
  );
  assert.equal(first.source_snapshot_sha256, reordered.source_snapshot_sha256);
  assert.equal(JSON.stringify(first).includes("fixtures/vehicle.json"), false);
  assert.equal(JSON.stringify(first).includes(vehicleContents.trim()), false);
  const privateManifest = JSON.parse(
    await readFile(path.join(first.snapshot_root, ".manifest.json"), "utf8"),
  );
  const privateOwner = JSON.parse(
    await readFile(path.join(first.snapshot_root, ".owner.json"), "utf8"),
  );
  assert.deepEqual(
    privateManifest.approved_test_fixtures.map((entry) => entry.relative_path),
    ["fixtures/account.json", "fixtures/vehicle.json"],
  );
  assert.equal(
    privateManifest.approved_test_fixtures_sha256,
    first.approved_test_fixtures_sha256,
  );
  assert.equal(privateOwner.approved_test_fixture_count, 2);
  assert.deepEqual(privateOwner.approved_test_fixture_context, {
    schema_version: "crashfix-test-fixture-context/v1",
    enabled: true,
    execution_profile: "local_trusted",
    project_classification: "test",
  });
  assert.deepEqual(
    privateManifest.approved_test_fixture_context,
    privateOwner.approved_test_fixture_context,
  );
  assert.equal(Object.hasOwn(privateOwner, "approved_test_fixtures"), false);

  const verified = await verifySourceForTest({
    workspace,
    snapshotRoot: first.snapshot_root,
    expectedSourceRefSha256: first.source_ref_sha256,
    expectedSourceSnapshotSha256: first.source_snapshot_sha256,
  });
  assert.equal(verified.unchanged, true);
  assert.equal(verified.approved_test_fixtures_sha256, first.approved_test_fixtures_sha256);
  assert.equal(verified.approved_test_fixture_count, 2);

  const baseline = await cloneForTest(
    { snapshotRoot: first.snapshot_root, role: "baseline" },
    workspace,
    first,
  );
  results.push([baseline, "workspace_dir"]);
  const candidate = await cloneForTest(
    { snapshotRoot: first.snapshot_root, role: "candidate" },
    workspace,
    first,
  );
  results.push([candidate, "workspace_dir"]);
  const baselineAudit = await auditSnapshotWorkspace({
    workspaceRoot: baseline.workspace_root,
    snapshotRoot: first.snapshot_root,
    expectedSourceSnapshotSha256: first.source_snapshot_sha256,
    role: "baseline",
  });
  assert.equal(baselineAudit.clean, true);
  assert.equal(baselineAudit.approved_test_fixture_count, 2);

  await writeFile(path.join(candidate.workspace_dir, "App.kt"), "class FixedApp\n", "utf8");
  const candidateAudit = await auditSnapshotWorkspace({
    workspaceRoot: candidate.workspace_root,
    snapshotRoot: first.snapshot_root,
    expectedSourceSnapshotSha256: first.source_snapshot_sha256,
    role: "candidate",
  });
  assert.equal(candidateAudit.change_stat.modified_files, 1);
  assert.equal(candidateAudit.approved_test_fixtures_sha256, first.approved_test_fixtures_sha256);
  assert.deepEqual(candidateAudit.approved_test_fixture_context, privateOwner.approved_test_fixture_context);

  const candidateVehiclePath = path.join(candidate.workspace_dir, "fixtures", "vehicle.json");
  await chmod(candidateVehiclePath, 0o700);
  await assert.rejects(
    auditSnapshotWorkspace({
      workspaceRoot: candidate.workspace_root,
      snapshotRoot: first.snapshot_root,
      expectedSourceSnapshotSha256: first.source_snapshot_sha256,
      role: "candidate",
    }),
    /approved test fixture mutable permissions changed/u,
  );
  await chmod(candidateVehiclePath, 0o600);

  const destination = path.join(exportParent, "approved-candidate");
  const exported = await exportCandidateWorkspace({
    originalWorkspace: workspace,
    workspaceRoot: candidate.workspace_root,
    snapshotRoot: first.snapshot_root,
    expectedSourceSnapshotSha256: first.source_snapshot_sha256,
    expectedCandidateManifestSha256: candidateAudit.candidate_manifest_sha256,
    expectedCanonicalDiffSha256: candidateAudit.canonical_diff_sha256,
    destination,
    forbidRoots: [workspace, sharedReportRoot],
  });
  exportedDestinations.push(destination);
  assert.equal(exported.approved_test_fixture_count, 2);
  assert.equal(exported.approved_test_fixtures_sha256, first.approved_test_fixtures_sha256);
  assert.equal(
    await readFile(path.join(destination, "fixtures", "vehicle.json"), "utf8"),
    vehicleContents,
  );

  await writeFile(
    candidateVehiclePath,
    `${JSON.stringify({ password: "changed-fixture-value" })}\n`,
    "utf8",
  );
  await assert.rejects(
    auditSnapshotWorkspace({
      workspaceRoot: candidate.workspace_root,
      snapshotRoot: first.snapshot_root,
      expectedSourceSnapshotSha256: first.source_snapshot_sha256,
      role: "candidate",
    }),
    /exact eligible test fixture approval/u,
  );
  await writeFile(candidateVehiclePath, vehicleContents, "utf8");
  await rm(path.join(candidate.workspace_dir, "fixtures", "account.json"));
  await assert.rejects(
    auditSnapshotWorkspace({
      workspaceRoot: candidate.workspace_root,
      snapshotRoot: first.snapshot_root,
      expectedSourceSnapshotSha256: first.source_snapshot_sha256,
      role: "candidate",
    }),
    /not exactly consumed/u,
  );

  await writeFile(
    path.join(workspace, "fixtures", "vehicle.json"),
    `${JSON.stringify({ password: "source-drift" })}\n`,
    "utf8",
  );
  await assert.rejects(
    verifySourceForTest({
      workspace,
      snapshotRoot: first.snapshot_root,
      expectedSourceRefSha256: first.source_ref_sha256,
      expectedSourceSnapshotSha256: first.source_snapshot_sha256,
    }),
  );
});

test("test fixture probes accept only strict JSON data files", async (t) => {
  const workspace = await createWorkspace("crashfix-strict-json-fixture-");
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  const sensitiveJson = `${JSON.stringify({ password: "fixture-value" })}\n`;
  await writeFile(path.join(workspace, "fixture.JSON"), sensitiveJson, "utf8");
  const accepted = await probeTestFixture({
    workspace,
    relativePath: "fixture.JSON",
  });
  assert.equal(accepted.override_eligible, true);

  for (const filename of [
    "fixture.yaml",
    "fixture.yml",
    "fixture.xml",
    "fixture.properties",
    "fixture.toml",
    "fixture.ini",
  ]) {
    await writeFile(path.join(workspace, filename), "password=fixture-value\n", "utf8");
    await assert.rejects(
      probeTestFixture({ workspace, relativePath: filename }),
      /eligible strict JSON data file/u,
    );
  }
  await writeFile(path.join(workspace, "invalid.json"), "password=fixture-value\n", "utf8");
  await assert.rejects(
    probeTestFixture({ workspace, relativePath: "invalid.json" }),
    /structured JSON configuration is invalid/u,
  );
});

test("clones baseline and candidate as writable deep copies without shared inodes", async (t) => {
  const workspace = await createWorkspace();
  let snapshot;
  let baseline;
  let candidate;
  t.after(async () => {
    await cleanupResult(candidate, "workspace_dir");
    await cleanupResult(baseline, "workspace_dir");
    await cleanupResult(snapshot, "snapshot_dir");
    await rm(workspace, { recursive: true, force: true });
  });

  await mkdir(path.join(workspace, "src"));
  await writeFile(path.join(workspace, "src", "App.kt"), "fun main() = Unit\n", "utf8");
  await writeFile(path.join(workspace, "tool.sh"), "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path.join(workspace, "tool.sh"), 0o755);
  snapshot = await materializeForTest({ workspace });
  const boundCloneOptions = {
    snapshotRoot: snapshot.snapshot_root,
    role: "candidate",
    forbidRoots: [workspace, sharedReportRoot],
  };
  await assert.rejects(
    cloneSnapshotWorkspace(boundCloneOptions),
    /expected-source-ref-sha256/u,
  );
  await assert.rejects(
    cloneSnapshotWorkspace({
      ...boundCloneOptions,
      expectedSourceRefSha256: snapshot.source_ref_sha256,
    }),
    /expected-source-sha256/u,
  );
  await assert.rejects(
    cloneSnapshotWorkspace({
      ...boundCloneOptions,
      expectedSourceRefSha256: "0".repeat(64),
      expectedSourceSnapshotSha256: snapshot.source_snapshot_sha256,
    }),
    /in-memory locked source reference/u,
  );
  await assert.rejects(
    cloneSnapshotWorkspace({
      ...boundCloneOptions,
      expectedSourceRefSha256: snapshot.source_ref_sha256,
      expectedSourceSnapshotSha256: "0".repeat(64),
    }),
    /in-memory locked source hash/u,
  );
  baseline = await cloneForTest(
    { snapshotRoot: snapshot.snapshot_root, role: "baseline" },
    workspace,
    snapshot,
  );
  candidate = await cloneForTest(
    { snapshotRoot: snapshot.snapshot_root, role: "candidate" },
    workspace,
    snapshot,
  );

  const relativeFile = path.join("src", "App.kt");
  const sourceStat = await stat(path.join(snapshot.snapshot_dir, relativeFile));
  const baselineStat = await stat(path.join(baseline.workspace_dir, relativeFile));
  const candidateStat = await stat(path.join(candidate.workspace_dir, relativeFile));
  assert.notEqual(`${sourceStat.dev}:${sourceStat.ino}`, `${baselineStat.dev}:${baselineStat.ino}`);
  assert.notEqual(`${sourceStat.dev}:${sourceStat.ino}`, `${candidateStat.dev}:${candidateStat.ino}`);
  assert.notEqual(`${baselineStat.dev}:${baselineStat.ino}`, `${candidateStat.dev}:${candidateStat.ino}`);
  assert.equal(permissions(baselineStat), 0o600);
  assert.equal(permissions(await stat(path.join(candidate.workspace_dir, "tool.sh"))), 0o700);
  assert.equal(permissions(await stat(candidate.workspace_dir)), 0o700);

  await writeFile(path.join(candidate.workspace_dir, relativeFile), "fun main() = error(\"fixed\")\n", "utf8");
  assert.equal(await readFile(path.join(baseline.workspace_dir, relativeFile), "utf8"), "fun main() = Unit\n");
  assert.equal(await readFile(path.join(snapshot.snapshot_dir, relativeFile), "utf8"), "fun main() = Unit\n");

  for (const result of [baseline, candidate]) {
    const privateRoot = path.dirname(result.workspace_dir);
    const ownerText = await readFile(path.join(privateRoot, ".owner.json"), "utf8");
    const manifestText = await readFile(path.join(privateRoot, ".manifest.json"), "utf8");
    assert.equal(ownerText.includes(workspace), false);
    assert.equal(manifestText.includes(workspace), false);
    assert.equal(JSON.parse(ownerText).role, result.role);
    assert.equal(JSON.parse(ownerText).source_ref_sha256, snapshot.source_ref_sha256);
    assert.equal(JSON.parse(ownerText).exclusion_policy_sha256, EXCLUSION_POLICY_SHA256);
    assert.equal(JSON.parse(ownerText).dynamic_exclusions_sha256, snapshot.dynamic_exclusions_sha256);
    assert.equal(result.exclusion_policy_sha256, EXCLUSION_POLICY_SHA256);
    assert.equal(result.dynamic_exclusions_sha256, snapshot.dynamic_exclusions_sha256);
  }

  const snapshotOwnerPath = path.join(snapshot.snapshot_root, ".owner.json");
  const tamperedOwner = JSON.parse(await readFile(snapshotOwnerPath, "utf8"));
  tamperedOwner.exclusion_policy_sha256 = "0".repeat(64);
  await chmod(snapshotOwnerPath, 0o600);
  await writeFile(snapshotOwnerPath, `${JSON.stringify(tamperedOwner)}\n`, "utf8");
  await chmod(snapshotOwnerPath, 0o400);
  await assert.rejects(
    cloneForTest({ snapshotRoot: snapshot.snapshot_root, role: "candidate" }, workspace, snapshot),
    /identities do not match/u,
  );
});

test("rejects snapshot and clone target drift between their independent verification passes", async (t) => {
  const workspace = await createWorkspace("crashfix-workspace-copy-drift-");
  let snapshot;
  let failedSnapshotDir;
  let failedCloneDir;
  t.after(async () => {
    await cleanupResult(snapshot, "snapshot_dir");
    await rm(workspace, { recursive: true, force: true });
  });

  await writeFile(path.join(workspace, "App.kt"), "class App\n", "utf8");
  await assert.rejects(
    materializeForTest({ workspace }, {
      async betweenSnapshotVerificationPasses(snapshotDir) {
        failedSnapshotDir = snapshotDir;
        const file = path.join(snapshotDir, "App.kt");
        await chmod(file, 0o600);
        await writeFile(file, "class DriftedSnapshot\n", "utf8");
        await chmod(file, 0o400);
      },
    }),
    /changed between the two source manifest passes/u,
  );
  assert.ok(failedSnapshotDir);
  await assert.rejects(lstat(path.dirname(failedSnapshotDir)), /ENOENT/u);

  snapshot = await materializeForTest({ workspace });
  await assert.rejects(
    cloneForTest(
      { snapshotRoot: snapshot.snapshot_root, role: "candidate" },
      workspace,
      snapshot,
      {
        async betweenWorkspaceVerificationPasses(workspaceDir) {
          failedCloneDir = workspaceDir;
          await writeFile(path.join(workspaceDir, "App.kt"), "class DriftedClone\n", "utf8");
        },
      },
    ),
    /changed between the two source manifest passes/u,
  );
  assert.ok(failedCloneDir);
  await assert.rejects(lstat(path.dirname(failedCloneDir)), /ENOENT/u);
});

test("audits bound baseline/candidate manifests and produces a bounded canonical diff", async (t) => {
  const workspace = await createWorkspace("crashfix-workspace-audit-source-");
  const unboundRoot = await createWorkspace("crashfix-workspace-unbound-");
  let snapshot;
  let baseline;
  let candidate;
  t.after(async () => {
    await cleanupResult(candidate, "workspace_dir");
    await cleanupResult(baseline, "workspace_dir");
    await cleanupResult(snapshot, "snapshot_dir");
    await rm(unboundRoot, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  await writeFile(path.join(workspace, "same.txt"), "same\n", "utf8");
  await writeFile(path.join(workspace, "modify.txt"), "before\n", "utf8");
  await writeFile(path.join(workspace, "delete.txt"), "delete me\n", "utf8");
  await writeFile(path.join(workspace, "mode.txt"), "mode\n", "utf8");
  snapshot = await materializeForTest({ workspace });
  baseline = await cloneForTest(
    { snapshotRoot: snapshot.snapshot_root, role: "baseline" },
    workspace,
    snapshot,
  );
  candidate = await cloneForTest(
    { snapshotRoot: snapshot.snapshot_root, role: "candidate" },
    workspace,
    snapshot,
  );

  const auditBound = (workspaceRoot, role, extra = {}) => auditSnapshotWorkspace({
    workspaceRoot,
    snapshotRoot: snapshot.snapshot_root,
    expectedSourceSnapshotSha256: snapshot.source_snapshot_sha256,
    role,
    ...extra,
  });

  const baselineAudit = await auditBound(baseline.workspace_root, "baseline");
  const cleanCandidateAudit = await auditBound(candidate.workspace_root, "candidate");
  assert.equal(baselineAudit.clean, true);
  assert.equal(baselineAudit.current_manifest_sha256, snapshot.manifest_sha256);
  assert.equal(baselineAudit.change_stat.paths, 0);
  assert.equal(baselineAudit.truncated, false);
  assert.equal(cleanCandidateAudit.canonical_diff_sha256, baselineAudit.canonical_diff_sha256);

  await writeFile(path.join(candidate.workspace_dir, "modify.txt"), "after\n", "utf8");
  await rm(path.join(candidate.workspace_dir, "delete.txt"));
  await writeFile(path.join(candidate.workspace_dir, "added.txt"), "added\n", "utf8");
  await chmod(path.join(candidate.workspace_dir, "mode.txt"), 0o700);
  const audit = await auditBound(candidate.workspace_root, "candidate");
  const repeated = await auditBound(candidate.workspace_root, "candidate");
  assert.equal(audit.clean, false);
  assert.equal(audit.candidate_manifest_sha256, audit.current_manifest_sha256);
  assert.notEqual(audit.candidate_manifest_sha256, audit.base_manifest_sha256);
  assert.equal(audit.canonical_diff_sha256, repeated.canonical_diff_sha256);
  assert.equal(audit.change_stat.paths, 4);
  assert.equal(audit.change_stat.added_files, 1);
  assert.equal(audit.change_stat.modified_files, 1);
  assert.equal(audit.change_stat.deleted_files, 1);
  assert.equal(audit.change_stat.mode_changed_files, 1);
  assert.deepEqual(
    audit.changes.map((change) => `${change.change}:${change.path}`),
    ["added:added.txt", "deleted:delete.txt", "mode_changed:mode.txt", "modified:modify.txt"],
  );
  assert.equal(audit.truncated, false);
  assert.equal(audit.dynamic_exclusions_sha256, snapshot.dynamic_exclusions_sha256);
  assert.equal(JSON.stringify(audit).includes(candidate.workspace_dir), false);

  const manyChanges = path.join(candidate.workspace_dir, "many-source-files");
  await mkdir(manyChanges);
  await Promise.all(Array.from({ length: 201 }, (_, index) => (
    writeFile(path.join(manyChanges, `Added${String(index).padStart(3, "0")}.kt`), `class Added${index}\n`, "utf8")
  )));
  const truncatedAudit = await auditBound(candidate.workspace_root, "candidate");
  assert.equal(truncatedAudit.truncated, true);
  assert.equal(truncatedAudit.changes.length, 200);
  assert.equal(truncatedAudit.change_stat.paths, 206);
  await rm(manyChanges, { recursive: true });

  await assert.rejects(
    auditBound(candidate.workspace_root, "baseline"),
    /owner role/u,
  );
  await assert.rejects(
    auditBound(candidate.workspace_root, "candidate", { limits: { maxFiles: 1 } }),
    /workspace budgets/u,
  );
  await mkdir(path.join(unboundRoot, "workspace"), { mode: 0o700 });
  await assert.rejects(
    auditBound(unboundRoot, "candidate"),
  );

  await writeFile(path.join(baseline.workspace_dir, "same.txt"), "baseline drift\n", "utf8");
  await assert.rejects(
    auditBound(baseline.workspace_root, "baseline"),
    /baseline included-source manifest drifted/u,
  );

  await writeFile(path.join(candidate.workspace_dir, ".env"), "TOKEN=late-secret\n", "utf8");
  await assert.rejects(
    auditBound(candidate.workspace_root, "candidate"),
    (error) => assertCredentialError(
      error,
      ".env",
      WORKSPACE_CREDENTIAL_REASON_CODES.CREDENTIAL_FILE_NAME,
    ),
  );
  await rm(path.join(candidate.workspace_dir, ".env"));

  await mkdir(path.join(candidate.workspace_dir, "secrets"));
  await assert.rejects(
    auditBound(candidate.workspace_root, "candidate"),
    (error) => assertCredentialError(
      error,
      "secrets",
      WORKSPACE_CREDENTIAL_REASON_CODES.CREDENTIAL_DIRECTORY_NAME,
    ),
  );
  await rm(path.join(candidate.workspace_dir, "secrets"), { recursive: true });

  await assert.rejects(
    auditSnapshotWorkspace({
      workspaceRoot: candidate.workspace_root,
      snapshotRoot: snapshot.snapshot_root,
      expectedSourceSnapshotSha256: "0".repeat(64),
      role: "candidate",
    }),
    /in-memory locked source hash/u,
  );

  const cloneManifestPath = path.join(candidate.workspace_root, ".manifest.json");
  const cloneOwnerPath = path.join(candidate.workspace_root, ".owner.json");
  const originalCloneManifest = await readFile(cloneManifestPath, "utf8");
  const originalCloneOwner = await readFile(cloneOwnerPath, "utf8");
  const forgedRef = "a".repeat(64);
  const forgedManifest = JSON.parse(originalCloneManifest);
  const forgedOwner = JSON.parse(originalCloneOwner);
  forgedManifest.source_ref_sha256 = forgedRef;
  forgedOwner.source_ref_sha256 = forgedRef;
  // Keep the forged pair internally self-consistent; the separately locked
  // sealed snapshot must still make the audit reject it.
  const forgedSnapshotSha = createHash("sha256")
    .update("crashfix-workspace-source-snapshot/v2\0")
    .update(forgedManifest.manifest_sha256).update("\0")
    .update(EXCLUSION_POLICY_SHA256).update("\0")
    .update(forgedManifest.dynamic_exclusions_sha256).update("\0")
    .update(forgedManifest.approved_test_fixtures_sha256).update("\0")
    .digest("hex");
  forgedManifest.source_snapshot_sha256 = forgedSnapshotSha;
  forgedOwner.source_snapshot_sha256 = forgedSnapshotSha;
  await chmod(cloneManifestPath, 0o600);
  await chmod(cloneOwnerPath, 0o600);
  await writeFile(cloneManifestPath, `${JSON.stringify(forgedManifest)}\n`, "utf8");
  await writeFile(cloneOwnerPath, `${JSON.stringify(forgedOwner)}\n`, "utf8");
  await chmod(cloneManifestPath, 0o400);
  await chmod(cloneOwnerPath, 0o400);
  await assert.rejects(
    auditBound(candidate.workspace_root, "candidate"),
    /manifest identity|trusted sealed snapshot|provenance/u,
  );
  await chmod(cloneManifestPath, 0o600);
  await chmod(cloneOwnerPath, 0o600);
  await writeFile(cloneManifestPath, originalCloneManifest, "utf8");
  await writeFile(cloneOwnerPath, originalCloneOwner, "utf8");
  await chmod(cloneManifestPath, 0o400);
  await chmod(cloneOwnerPath, 0o400);

  const ownerPath = path.join(candidate.workspace_root, ".owner.json");
  const owner = JSON.parse(await readFile(ownerPath, "utf8"));
  owner.exclusion_policy_sha256 = "f".repeat(64);
  await chmod(ownerPath, 0o600);
  await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, "utf8");
  await chmod(ownerPath, 0o400);
  await assert.rejects(
    auditBound(candidate.workspace_root, "candidate"),
    /identities do not match/u,
  );
});

test("exports only an approved audited candidate to a new disjoint private destination", async (t) => {
  const workspace = await createWorkspace("crashfix-export-source-");
  const reportRoot = await createWorkspace("crashfix-export-report-");
  const exportParent = await createWorkspace("crashfix-export-parent-");
  let snapshot;
  let candidate;
  const successfulDestinations = [];
  t.after(async () => {
    for (const destination of successfulDestinations) {
      await unlockTree(destination);
      await rm(destination, { recursive: true, force: true });
    }
    await cleanupResult(candidate, "workspace_dir");
    await cleanupResult(snapshot, "snapshot_dir");
    await rm(exportParent, { recursive: true, force: true });
    await rm(reportRoot, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  await writeFile(path.join(workspace, "keep.txt"), "keep\n", "utf8");
  await writeFile(path.join(workspace, "modify.txt"), "before\n", "utf8");
  snapshot = await materializeWorkspaceSnapshot({ workspace, forbidRoots: [reportRoot] });
  candidate = await cloneSnapshotWorkspace({
    snapshotRoot: snapshot.snapshot_root,
    role: "candidate",
    expectedSourceRefSha256: snapshot.source_ref_sha256,
    expectedSourceSnapshotSha256: snapshot.source_snapshot_sha256,
    forbidRoots: [workspace, reportRoot],
  });
  await writeFile(path.join(candidate.workspace_dir, "modify.txt"), "after\n", "utf8");
  await writeFile(path.join(candidate.workspace_dir, "added.txt"), "added\n", "utf8");
  await mkdir(path.join(candidate.workspace_dir, "build"));
  await writeFile(path.join(candidate.workspace_dir, "build", "artifact.bin"), "ignored\n", "utf8");
  await writeFile(path.join(candidate.workspace_dir, "candidate-release.apk"), "ignored\n", "utf8");
  await mkdir(path.join(candidate.workspace_dir, "nested"));
  await writeFile(path.join(candidate.workspace_dir, "nested", "Keep.kt"), "class Keep\n", "utf8");
  await writeFile(path.join(candidate.workspace_dir, "nested", "bundle.js.map"), "ignored\n", "utf8");
  await mkdir(path.join(candidate.workspace_dir, "nested", "Symbols.dSYM"));
  await writeFile(
    path.join(candidate.workspace_dir, "nested", "Symbols.dSYM", "binary"),
    "ignored\n",
    "utf8",
  );
  const audit = await auditSnapshotWorkspace({
    workspaceRoot: candidate.workspace_root,
    snapshotRoot: snapshot.snapshot_root,
    expectedSourceSnapshotSha256: snapshot.source_snapshot_sha256,
    role: "candidate",
  });

  const missingOriginalDestination = path.join(exportParent, "missing-original");
  await assert.rejects(
    exportCandidateWorkspace({
      workspaceRoot: candidate.workspace_root,
      snapshotRoot: snapshot.snapshot_root,
      expectedSourceSnapshotSha256: snapshot.source_snapshot_sha256,
      expectedCandidateManifestSha256: audit.candidate_manifest_sha256,
      expectedCanonicalDiffSha256: audit.canonical_diff_sha256,
      destination: missingOriginalDestination,
      forbidRoots: [workspace, reportRoot],
    }),
    (error) => {
      assert.match(error.message, /original workspace could not be validated/u);
      assert.equal(error.message.includes(workspace), false);
      return true;
    },
  );
  await assert.rejects(lstat(missingOriginalDestination), /ENOENT/u);

  const mismatchedOriginalDestination = path.join(exportParent, "mismatched-original");
  await assert.rejects(
    exportCandidateWorkspace({
      originalWorkspace: reportRoot,
      workspaceRoot: candidate.workspace_root,
      snapshotRoot: snapshot.snapshot_root,
      expectedSourceSnapshotSha256: snapshot.source_snapshot_sha256,
      expectedCandidateManifestSha256: audit.candidate_manifest_sha256,
      expectedCanonicalDiffSha256: audit.canonical_diff_sha256,
      destination: mismatchedOriginalDestination,
      forbidRoots: [workspace, exportParent],
    }),
    (error) => {
      assert.match(error.message, /does not match the trusted snapshot source reference/u);
      assert.equal(error.message.includes(workspace), false);
      assert.equal(error.message.includes(reportRoot), false);
      return true;
    },
  );
  await assert.rejects(lstat(mismatchedOriginalDestination), /ENOENT/u);

  const decoyForbiddenDestination = path.join(workspace, "must-not-export-to-source");
  await assert.rejects(
    exportCandidateWorkspace({
      originalWorkspace: workspace,
      workspaceRoot: candidate.workspace_root,
      snapshotRoot: snapshot.snapshot_root,
      expectedSourceSnapshotSha256: snapshot.source_snapshot_sha256,
      expectedCandidateManifestSha256: audit.candidate_manifest_sha256,
      expectedCanonicalDiffSha256: audit.canonical_diff_sha256,
      destination: decoyForbiddenDestination,
      forbidRoots: [reportRoot, exportParent],
    }),
    /must not overlap/u,
  );
  await assert.rejects(lstat(decoyForbiddenDestination), /ENOENT/u);

  const destination = path.join(exportParent, "approved-candidate");
  const exported = await exportCandidateWorkspace({
    originalWorkspace: workspace,
    workspaceRoot: candidate.workspace_root,
    snapshotRoot: snapshot.snapshot_root,
    expectedSourceSnapshotSha256: snapshot.source_snapshot_sha256,
    expectedCandidateManifestSha256: audit.candidate_manifest_sha256,
    expectedCanonicalDiffSha256: audit.canonical_diff_sha256,
    destination,
    forbidRoots: [workspace, reportRoot],
  });
  successfulDestinations.push(destination);
  assert.equal(exported.schema_version, "crashfix-candidate-export/v2");
  assert.match(exported.destination_ref_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(exported.candidate_manifest_sha256, audit.candidate_manifest_sha256);
  assert.equal(exported.canonical_diff_sha256, audit.canonical_diff_sha256);
  assert.equal(exported.dynamic_exclusions_sha256, snapshot.dynamic_exclusions_sha256);
  assert.equal(exported.truncated, false);
  assert.equal(permissions(await stat(destination)), 0o700);
  assert.equal(await readFile(path.join(destination, "modify.txt"), "utf8"), "after\n");
  assert.equal(await readFile(path.join(destination, "nested", "Keep.kt"), "utf8"), "class Keep\n");
  await assert.rejects(readFile(path.join(destination, "build", "artifact.bin")), /ENOENT/u);
  await assert.rejects(readFile(path.join(destination, "candidate-release.apk")), /ENOENT/u);
  await assert.rejects(readFile(path.join(destination, "nested", "bundle.js.map")), /ENOENT/u);
  await assert.rejects(readFile(path.join(destination, "nested", "Symbols.dSYM", "binary")), /ENOENT/u);
  assert.notEqual(
    (await stat(path.join(destination, "modify.txt"))).ino,
    (await stat(path.join(candidate.workspace_dir, "modify.txt"))).ino,
  );
  assert.equal(JSON.stringify(exported).includes(destination), false);

  const symlinkParent = path.join(exportParent, "parent-link");
  await symlink(".", symlinkParent);
  const symlinkRequestedDestination = path.join(symlinkParent, "symlink-parent-candidate");
  const canonicalSymlinkDestination = path.join(exportParent, "symlink-parent-candidate");
  const symlinkExport = await exportCandidateWorkspace({
    originalWorkspace: workspace,
    workspaceRoot: candidate.workspace_root,
    snapshotRoot: snapshot.snapshot_root,
    expectedSourceSnapshotSha256: snapshot.source_snapshot_sha256,
    expectedCandidateManifestSha256: audit.candidate_manifest_sha256,
    expectedCanonicalDiffSha256: audit.canonical_diff_sha256,
    destination: symlinkRequestedDestination,
    forbidRoots: [workspace, reportRoot],
  });
  successfulDestinations.push(canonicalSymlinkDestination);
  assert.equal(
    await readFile(path.join(canonicalSymlinkDestination, "added.txt"), "utf8"),
    "added\n",
  );
  assert.equal(JSON.stringify(symlinkExport).includes(symlinkRequestedDestination), false);

  const cliDestination = path.join(exportParent, "cli-candidate");
  const cli = await execFileAsync(
    process.execPath,
    [
      scriptPath, "export-candidate",
      "--workspace-root", candidate.workspace_root,
      "--snapshot-root", snapshot.snapshot_root,
      "--original-workspace", workspace,
      "--expected-source-sha256", snapshot.source_snapshot_sha256,
      "--expected-candidate-manifest-sha256", audit.candidate_manifest_sha256,
      "--expected-canonical-diff-sha256", audit.canonical_diff_sha256,
      "--destination", cliDestination,
      "--forbid-root", workspace,
      "--forbid-root", reportRoot,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  successfulDestinations.push(cliDestination);
  assert.equal(JSON.parse(cli.stdout).candidate_manifest_sha256, audit.candidate_manifest_sha256);
  assert.equal(cli.stdout.includes(cliDestination), false);

  const existingDestination = path.join(exportParent, "existing");
  await mkdir(existingDestination);
  await writeFile(path.join(existingDestination, "marker.txt"), "preserve\n", "utf8");
  await assert.rejects(
    exportCandidateWorkspace({
      originalWorkspace: workspace,
      workspaceRoot: candidate.workspace_root,
      snapshotRoot: snapshot.snapshot_root,
      expectedSourceSnapshotSha256: snapshot.source_snapshot_sha256,
      expectedCandidateManifestSha256: audit.candidate_manifest_sha256,
      expectedCanonicalDiffSha256: audit.canonical_diff_sha256,
      destination: existingDestination,
      forbidRoots: [workspace, reportRoot],
    }),
    /must not already exist/u,
  );
  assert.equal(await readFile(path.join(existingDestination, "marker.txt"), "utf8"), "preserve\n");

  const overlappingDestination = path.join(candidate.workspace_root, "must-not-export-here");
  await assert.rejects(
    exportCandidateWorkspace({
      originalWorkspace: workspace,
      workspaceRoot: candidate.workspace_root,
      snapshotRoot: snapshot.snapshot_root,
      expectedSourceSnapshotSha256: snapshot.source_snapshot_sha256,
      expectedCandidateManifestSha256: audit.candidate_manifest_sha256,
      expectedCanonicalDiffSha256: audit.canonical_diff_sha256,
      destination: overlappingDestination,
      forbidRoots: [workspace, reportRoot],
    }),
    /must not overlap/u,
  );
  await assert.rejects(lstat(overlappingDestination), /ENOENT/u);

  const driftDestination = path.join(exportParent, "hash-drift");
  await assert.rejects(
    exportCandidateWorkspace({
      originalWorkspace: workspace,
      workspaceRoot: candidate.workspace_root,
      snapshotRoot: snapshot.snapshot_root,
      expectedSourceSnapshotSha256: snapshot.source_snapshot_sha256,
      expectedCandidateManifestSha256: "0".repeat(64),
      expectedCanonicalDiffSha256: audit.canonical_diff_sha256,
      destination: driftDestination,
      forbidRoots: [workspace, reportRoot],
    }),
    /manifest hash does not match/u,
  );
  await assert.rejects(lstat(driftDestination), /ENOENT/u);

  const cleanupDestination = path.join(exportParent, "post-create-failure");
  await assert.rejects(
    exportCandidateWorkspace({
      originalWorkspace: workspace,
      workspaceRoot: candidate.workspace_root,
      snapshotRoot: snapshot.snapshot_root,
      expectedSourceSnapshotSha256: snapshot.source_snapshot_sha256,
      expectedCandidateManifestSha256: audit.candidate_manifest_sha256,
      expectedCanonicalDiffSha256: audit.canonical_diff_sha256,
      destination: cleanupDestination,
      forbidRoots: [workspace, reportRoot],
    }, {
      afterDestinationCreated() {
        throw new Error("injected failure after atomic destination creation");
      },
    }),
    /destination was retained and cleanup is unconfirmed/u,
  );
  successfulDestinations.push(cleanupDestination);
  assert.equal(await readFile(path.join(cleanupDestination, "modify.txt"), "utf8"), "after\n");

  const replacedDestination = path.join(exportParent, "identity-replaced");
  await assert.rejects(
    exportCandidateWorkspace({
      originalWorkspace: workspace,
      workspaceRoot: candidate.workspace_root,
      snapshotRoot: snapshot.snapshot_root,
      expectedSourceSnapshotSha256: snapshot.source_snapshot_sha256,
      expectedCandidateManifestSha256: audit.candidate_manifest_sha256,
      expectedCanonicalDiffSha256: audit.canonical_diff_sha256,
      destination: replacedDestination,
      forbidRoots: [workspace, reportRoot],
    }, {
      async afterDestinationCreated() {
        await rm(replacedDestination, { recursive: true });
        await mkdir(replacedDestination, { mode: 0o700 });
        await writeFile(path.join(replacedDestination, "foreign-marker.txt"), "must survive\n", "utf8");
      },
    }),
    /destination was retained and cleanup is unconfirmed/u,
  );
  assert.equal(
    await readFile(path.join(replacedDestination, "foreign-marker.txt"), "utf8"),
    "must survive\n",
  );
  await rm(replacedDestination, { recursive: true, force: true });

  const finalPinReplacement = path.join(exportParent, "post-final-pin-replaced");
  await assert.rejects(
    exportCandidateWorkspace({
      originalWorkspace: workspace,
      workspaceRoot: candidate.workspace_root,
      snapshotRoot: snapshot.snapshot_root,
      expectedSourceSnapshotSha256: snapshot.source_snapshot_sha256,
      expectedCandidateManifestSha256: audit.candidate_manifest_sha256,
      expectedCanonicalDiffSha256: audit.canonical_diff_sha256,
      destination: finalPinReplacement,
      forbidRoots: [workspace, reportRoot],
    }, {
      async afterFinalVerification() {
        await rm(finalPinReplacement, { recursive: true });
        await mkdir(finalPinReplacement, { mode: 0o700 });
        await writeFile(
          path.join(finalPinReplacement, "foreign-after-final-pin.txt"),
          "must survive final-pin failure\n",
          "utf8",
        );
      },
    }),
    /destination was retained and cleanup is unconfirmed/u,
  );
  assert.equal(
    await readFile(path.join(finalPinReplacement, "foreign-after-final-pin.txt"), "utf8"),
    "must survive final-pin failure\n",
  );
  await rm(finalPinReplacement, { recursive: true, force: true });

  await writeFile(path.join(candidate.workspace_dir, ".env"), "TOKEN=late\n", "utf8");
  const credentialDestination = path.join(exportParent, "credential-rejected");
  await assert.rejects(
    exportCandidateWorkspace({
      originalWorkspace: workspace,
      workspaceRoot: candidate.workspace_root,
      snapshotRoot: snapshot.snapshot_root,
      expectedSourceSnapshotSha256: snapshot.source_snapshot_sha256,
      expectedCandidateManifestSha256: audit.candidate_manifest_sha256,
      expectedCanonicalDiffSha256: audit.canonical_diff_sha256,
      destination: credentialDestination,
      forbidRoots: [workspace, reportRoot],
    }),
    (error) => assertCredentialError(
      error,
      ".env",
      WORKSPACE_CREDENTIAL_REASON_CODES.CREDENTIAL_FILE_NAME,
    ),
  );
  await rm(path.join(candidate.workspace_dir, ".env"));
  await assert.rejects(lstat(credentialDestination), /ENOENT/u);

  await writeFile(path.join(candidate.workspace_dir, "deploy-token.txt"), "late credential\n", "utf8");
  const namedCredentialDestination = path.join(exportParent, "named-credential-rejected");
  await assert.rejects(
    exportCandidateWorkspace({
      originalWorkspace: workspace,
      workspaceRoot: candidate.workspace_root,
      snapshotRoot: snapshot.snapshot_root,
      expectedSourceSnapshotSha256: snapshot.source_snapshot_sha256,
      expectedCandidateManifestSha256: audit.candidate_manifest_sha256,
      expectedCanonicalDiffSha256: audit.canonical_diff_sha256,
      destination: namedCredentialDestination,
      forbidRoots: [workspace, reportRoot],
    }),
    (error) => assertCredentialError(
      error,
      "deploy-token.txt",
      WORKSPACE_CREDENTIAL_REASON_CODES.CREDENTIAL_FILE_NAME,
    ),
  );
  await rm(path.join(candidate.workspace_dir, "deploy-token.txt"));
  await assert.rejects(lstat(namedCredentialDestination), /ENOENT/u);

  const many = path.join(candidate.workspace_dir, "many");
  await mkdir(many);
  await Promise.all(Array.from({ length: 201 }, (_, index) => (
    writeFile(path.join(many, `File${String(index).padStart(3, "0")}.kt`), `class File${index}\n`, "utf8")
  )));
  const truncatedAudit = await auditSnapshotWorkspace({
    workspaceRoot: candidate.workspace_root,
    snapshotRoot: snapshot.snapshot_root,
    expectedSourceSnapshotSha256: snapshot.source_snapshot_sha256,
    role: "candidate",
  });
  const truncatedDestination = path.join(exportParent, "truncated-rejected");
  await assert.rejects(
    exportCandidateWorkspace({
      originalWorkspace: workspace,
      workspaceRoot: candidate.workspace_root,
      snapshotRoot: snapshot.snapshot_root,
      expectedSourceSnapshotSha256: snapshot.source_snapshot_sha256,
      expectedCandidateManifestSha256: truncatedAudit.candidate_manifest_sha256,
      expectedCanonicalDiffSha256: truncatedAudit.canonical_diff_sha256,
      destination: truncatedDestination,
      forbidRoots: [workspace, reportRoot],
    }),
    /truncated change audit/u,
  );
  await rm(many, { recursive: true });
  await assert.rejects(lstat(truncatedDestination), /ENOENT/u);

  const ownerPath = path.join(candidate.workspace_root, ".owner.json");
  const owner = JSON.parse(await readFile(ownerPath, "utf8"));
  owner.exclusion_policy_sha256 = "f".repeat(64);
  await chmod(ownerPath, 0o600);
  await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, "utf8");
  await chmod(ownerPath, 0o400);
  const tamperedDestination = path.join(exportParent, "tampered-rejected");
  await assert.rejects(
    exportCandidateWorkspace({
      originalWorkspace: workspace,
      workspaceRoot: candidate.workspace_root,
      snapshotRoot: snapshot.snapshot_root,
      expectedSourceSnapshotSha256: snapshot.source_snapshot_sha256,
      expectedCandidateManifestSha256: audit.candidate_manifest_sha256,
      expectedCanonicalDiffSha256: audit.canonical_diff_sha256,
      destination: tamperedDestination,
      forbidRoots: [workspace, reportRoot],
    }),
    /audit failed closed/u,
  );
  await assert.rejects(lstat(tamperedDestination), /ENOENT/u);
});

test("rejects symlinks, hardlinks, Git LFS pointers, and non-absolute workspaces", async (t) => {
  const symlinkWorkspace = await createWorkspace("crashfix-workspace-symlink-");
  const hardlinkWorkspace = await createWorkspace("crashfix-workspace-hardlink-");
  const lfsWorkspace = await createWorkspace("crashfix-workspace-lfs-");
  const disguisedCredentialWorkspace = await createWorkspace("crashfix-workspace-credential-");
  const fifoWorkspace = await createWorkspace("crashfix-workspace-fifo-");
  const writableRootWorkspace = await createWorkspace("crashfix-workspace-writable-root-");
  const writableFileWorkspace = await createWorkspace("crashfix-workspace-writable-file-");
  t.after(async () => {
    await rm(symlinkWorkspace, { recursive: true, force: true });
    await rm(hardlinkWorkspace, { recursive: true, force: true });
    await rm(lfsWorkspace, { recursive: true, force: true });
    await rm(disguisedCredentialWorkspace, { recursive: true, force: true });
    await rm(fifoWorkspace, { recursive: true, force: true });
    await rm(writableRootWorkspace, { recursive: true, force: true });
    await rm(writableFileWorkspace, { recursive: true, force: true });
  });

  await writeFile(path.join(symlinkWorkspace, "target.txt"), "safe\n", "utf8");
  await symlink("target.txt", path.join(symlinkWorkspace, "link.txt"));
  await assert.rejects(materializeForTest({ workspace: symlinkWorkspace }), /symbolic link/u);

  await writeFile(path.join(hardlinkWorkspace, "one.txt"), "same inode\n", "utf8");
  await link(path.join(hardlinkWorkspace, "one.txt"), path.join(hardlinkWorkspace, "two.txt"));
  await assert.rejects(materializeForTest({ workspace: hardlinkWorkspace }), /hard-linked/u);

  await writeFile(
    path.join(lfsWorkspace, "pointer.bin"),
    "version https://git-lfs.github.com/spec/v1\n"
      + `oid sha256:${"0".repeat(64)}\nsize 123\n`,
    "utf8",
  );
  await assert.rejects(materializeForTest({ workspace: lfsWorkspace }), /Git LFS pointer/u);
  await writeFile(
    path.join(disguisedCredentialWorkspace, "innocent-looking.json"),
    JSON.stringify({
      type: "service_account",
      private_key: "-----BEGIN PRIVATE KEY-----fake-----END PRIVATE KEY-----",
      client_email: "fixture@example.invalid",
    }),
    "utf8",
  );
  await assert.rejects(
    materializeForTest({ workspace: disguisedCredentialWorkspace }),
    (error) => assertCredentialError(
      error,
      "innocent-looking.json",
      WORKSPACE_CREDENTIAL_REASON_CODES.PRIVATE_KEY_BLOCK,
    ),
  );
  await execFileAsync("mkfifo", [path.join(fifoWorkspace, "blocked.pipe")]);
  await assert.rejects(
    materializeForTest({ workspace: fifoWorkspace }),
    /FIFO/u,
  );
  await chmod(writableRootWorkspace, 0o777);
  await assert.rejects(
    materializeForTest({ workspace: writableRootWorkspace }),
    /group\/other writable/u,
  );
  await writeFile(path.join(writableFileWorkspace, "unsafe.kt"), "class Unsafe\n", "utf8");
  await chmod(path.join(writableFileWorkspace, "unsafe.kt"), 0o666);
  await assert.rejects(
    materializeForTest({ workspace: writableFileWorkspace }),
    /group\/other writable/u,
  );
  await assert.rejects(materializeForTest({ workspace: "relative/path" }), /absolute path/u);
});

test("exact fixture hashes never override private keys, high-confidence tokens, or credential bundles", async (t) => {
  const workspaces = [];
  t.after(async () => {
    for (const workspace of workspaces) await rm(workspace, { recursive: true, force: true });
  });

  const hardCases = [
    {
      contents: `${JSON.stringify({
        type: "service_account",
        private_key: "not-a-production-key-but-still-a-credential-bundle",
        client_email: "fixture@example.invalid",
      })}\n`,
      reason: WORKSPACE_CREDENTIAL_REASON_CODES.STRUCTURED_SENSITIVE_VALUE,
    },
    {
      contents: `${JSON.stringify({
        type: "authorized_user",
        client_secret: "fixture-client-secret",
        refresh_token: "fixture-refresh-token",
      })}\n`,
      reason: WORKSPACE_CREDENTIAL_REASON_CODES.STRUCTURED_SENSITIVE_VALUE,
    },
    {
      contents: `${JSON.stringify({ api_token: "Zk8vQ2mR7pL9xN4cT6wY1aB3dE5fG0hJ" })}\n`,
      reason: WORKSPACE_CREDENTIAL_REASON_CODES.STRUCTURED_SENSITIVE_VALUE,
    },
    {
      contents: `${JSON.stringify({ note: `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}` })}\n`,
      reason: WORKSPACE_CREDENTIAL_REASON_CODES.HIGH_CONFIDENCE_TOKEN_OR_SENSITIVE_ASSIGNMENT,
    },
    {
      contents: "-----BEGIN PRIVATE KEY-----\nfixture-body\n-----END PRIVATE KEY-----\n",
      reason: WORKSPACE_CREDENTIAL_REASON_CODES.PRIVATE_KEY_BLOCK,
    },
  ];

  for (const hardCase of hardCases) {
    const workspace = await createWorkspace("crashfix-hard-fixture-");
    workspaces.push(workspace);
    const hardRelativePath = "a.json";
    await writeFile(path.join(workspace, hardRelativePath), hardCase.contents, "utf8");
    await writeFile(
      path.join(workspace, "z-probe.json"),
      `${JSON.stringify({ password: "fixture-probe-value" })}\n`,
      "utf8",
    );
    const probe = await probeTestFixture({ workspace, relativePath: "z-probe.json" });
    const exactHardHash = createHash("sha256").update(hardCase.contents).digest("hex");
    await assert.rejects(
      materializeForTest({
        workspace,
        testFixtureApproval: {
          schema_version: "crashfix-test-fixture-approval/v1",
          execution_profile: "local_trusted",
          project_classification: "test",
          user_confirmed: true,
          source_ref_sha256: probe.source_ref_sha256,
          entries: [{ relative_path: hardRelativePath, sha256: exactHardHash }],
        },
      }),
      (error) => assertCredentialError(error, hardRelativePath, hardCase.reason),
    );
    await assert.rejects(
      probeTestFixture({ workspace, relativePath: hardRelativePath }),
      (error) => assertCredentialError(error, hardRelativePath, hardCase.reason),
    );
  }

  const namedWorkspace = await createWorkspace("crashfix-named-fixture-");
  workspaces.push(namedWorkspace);
  const namedContents = `${JSON.stringify({ password: "fixture-value" })}\n`;
  await writeFile(path.join(namedWorkspace, "credentials.json"), namedContents, "utf8");
  await writeFile(
    path.join(namedWorkspace, "z-probe.json"),
    `${JSON.stringify({ password: "fixture-probe-value" })}\n`,
    "utf8",
  );
  const namedProbe = await probeTestFixture({
    workspace: namedWorkspace,
    relativePath: "z-probe.json",
  });
  await assert.rejects(
    materializeForTest({
      workspace: namedWorkspace,
      testFixtureApproval: {
        schema_version: "crashfix-test-fixture-approval/v1",
        execution_profile: "local_trusted",
        project_classification: "test",
        user_confirmed: true,
        source_ref_sha256: namedProbe.source_ref_sha256,
        entries: [{
          relative_path: "credentials.json",
          sha256: createHash("sha256").update(namedContents).digest("hex"),
        }],
      },
    }),
    /strict JSON|excluded or credential-like/u,
  );
});

test("fixture probe hard-blocks opaque, nested, escaped-token, PEM, and ambiguous JSON payloads", async (t) => {
  const workspaces = [];
  t.after(async () => {
    for (const workspace of workspaces) await rm(workspace, { recursive: true, force: true });
  });
  const syntheticTokenTail = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  const cases = [
    {
      contents: `${JSON.stringify({ password: `${syntheticTokenTail}==` })}\n`,
      reason: WORKSPACE_CREDENTIAL_REASON_CODES.STRUCTURED_SENSITIVE_VALUE,
    },
    {
      contents: `${JSON.stringify({ api_token: "Ab3+".repeat(1_100) })}\n`,
      reason: WORKSPACE_CREDENTIAL_REASON_CODES.STRUCTURED_SENSITIVE_VALUE,
    },
    {
      contents: `${JSON.stringify({
        password: "fixture-value",
        api_token: { nested: "runtime-value" },
      })}\n`,
      reason: WORKSPACE_CREDENTIAL_REASON_CODES.STRUCTURED_SENSITIVE_VALUE,
    },
    {
      contents: `{"password":"fixture-value","note":"\\u0067hp_${syntheticTokenTail}"}\n`,
      reason: WORKSPACE_CREDENTIAL_REASON_CODES.STRUCTURED_SENSITIVE_VALUE,
    },
    ...[
      "ENCRYPTED PRIVATE KEY",
      "DSA PRIVATE KEY",
      "PGP PRIVATE KEY BLOCK",
    ].map((kind) => ({
      contents: `${JSON.stringify({ password: "fixture-value", note: `-----BEGIN ${kind}-----payload` })}\n`,
      reason: WORKSPACE_CREDENTIAL_REASON_CODES.PRIVATE_KEY_BLOCK,
    })),
  ];
  for (const testCase of cases) {
    const workspace = await createWorkspace("crashfix-fixture-hardening-");
    workspaces.push(workspace);
    await writeFile(path.join(workspace, "fixture.json"), testCase.contents, "utf8");
    await assert.rejects(
      probeTestFixture({ workspace, relativePath: "fixture.json" }),
      (error) => assertCredentialError(error, "fixture.json", testCase.reason),
    );
  }

  for (const contents of [
    `{"password":"fixture-value",}\n`,
    `// json5\n{"password":"fixture-value"}\n`,
    `{"password":"real-value","password":"fixture-value"}\n`,
    `{"password":"fixture-value"`,
  ]) {
    const workspace = await createWorkspace("crashfix-fixture-invalid-json-");
    workspaces.push(workspace);
    await writeFile(path.join(workspace, "fixture.json"), contents, "utf8");
    await assert.rejects(
      probeTestFixture({ workspace, relativePath: "fixture.json" }),
      /structured JSON configuration/u,
    );
  }
});

test("fixture approval paths reject invisible Unicode formatting characters", async (t) => {
  const workspace = await createWorkspace("crashfix-fixture-unicode-path-");
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  const confusingPath = `safe\u202ejson.txt`;
  await writeFile(path.join(workspace, confusingPath), `${JSON.stringify({ password: "fixture-value" })}\n`);
  await assert.rejects(
    probeTestFixture({ workspace, relativePath: confusingPath }),
    /unsafe or overlong relative path|unsafe or non-portable path/u,
  );
});

test("fixture approvals reject wrong hashes, wrong paths, partial control groups, and extra safe files", async (t) => {
  const workspace = await createWorkspace("crashfix-fixture-receipt-");
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  const fixtureContents = `${JSON.stringify({ password: "fixture-runtime-value" })}\n`;
  await writeFile(path.join(workspace, "fixture.json"), fixtureContents, "utf8");
  await writeFile(path.join(workspace, "safe.json"), `${JSON.stringify({ value: "safe" })}\n`, "utf8");
  const probe = await probeTestFixture({ workspace, relativePath: "fixture.json" });
  const receipt = (entries, overrides = {}) => ({
    schema_version: "crashfix-test-fixture-approval/v1",
    execution_profile: "local_trusted",
    project_classification: "test",
    user_confirmed: true,
    source_ref_sha256: probe.source_ref_sha256,
    entries,
    ...overrides,
  });

  await assert.rejects(
    materializeForTest({
      workspace,
      testFixtureApproval: receipt([{ relative_path: "fixture.json", sha256: "0".repeat(64) }]),
    }),
    /exact eligible test fixture approval/u,
  );
  await assert.rejects(
    materializeForTest({
      workspace,
      testFixtureApproval: receipt([{ relative_path: "safe.json", sha256: probe.sha256 }]),
    }),
  );
  await assert.rejects(
    materializeForTest({
      workspace,
      testFixtureApproval: receipt([
        { relative_path: "fixture.json", sha256: probe.sha256 },
        {
          relative_path: "safe.json",
          sha256: createHash("sha256")
            .update(`${JSON.stringify({ value: "safe" })}\n`)
            .digest("hex"),
        },
      ]),
    }),
    /no longer has the exact eligible/u,
  );
  for (const overrides of [
    { execution_profile: "docker_strict" },
    { project_classification: "production" },
    { user_confirmed: false },
    { source_ref_sha256: "0".repeat(64) },
  ]) {
    await assert.rejects(
      materializeForTest({
        workspace,
        testFixtureApproval: receipt(
          [{ relative_path: "fixture.json", sha256: probe.sha256 }],
          overrides,
        ),
      }),
      /not bound to this trusted local test source/u,
    );
  }
  await assert.rejects(
    materializeForTest({
      workspace,
      testFixtureApproval: {
        ...receipt([{ relative_path: "fixture.json", sha256: probe.sha256 }]),
        unexpected: true,
      },
    }),
    /unsupported or missing fields/u,
  );
  for (const relativePath of [
    "/fixture.json",
    "../fixture.json",
    "./fixture.json",
    "nested\\fixture.json",
    "fixture.json\u0000suffix",
  ]) {
    await assert.rejects(
      materializeForTest({
        workspace,
        testFixtureApproval: receipt([{ relative_path: relativePath, sha256: probe.sha256 }]),
      }),
    );
  }
});

test("credential failures expose only frozen relative-path diagnostics with fixed reasons", async (t) => {
  const tokenWorkspace = await createWorkspace("crashfix-workspace-token-diagnostic-");
  const privateKeyWorkspace = await createWorkspace("crashfix-workspace-key-diagnostic-");
  t.after(async () => {
    await rm(tokenWorkspace, { recursive: true, force: true });
    await rm(privateKeyWorkspace, { recursive: true, force: true });
  });

  await mkdir(path.join(tokenWorkspace, "nested"));
  const decomposedName = "cre\u0301dential.txt";
  const token = ["g", "hp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
  await writeFile(
    path.join(tokenWorkspace, "nested", decomposedName),
    `observed credential: ${token}\n`,
    "utf8",
  );
  await assert.rejects(
    materializeForTest({ workspace: tokenWorkspace }),
    (error) => {
      assertCredentialError(
        error,
        "nested/crédential.txt",
        WORKSPACE_CREDENTIAL_REASON_CODES.HIGH_CONFIDENCE_TOKEN_OR_SENSITIVE_ASSIGNMENT,
      );
      assert.doesNotMatch(error.message, new RegExp(token, "u"));
      assert.doesNotMatch(error.message, new RegExp(tokenWorkspace, "u"));
      assert.throws(() => {
        error.diagnostic.reason = "changed";
      }, TypeError);
      assert.throws(() => {
        error.diagnostic = {};
      }, TypeError);
      return true;
    },
  );

  await mkdir(path.join(privateKeyWorkspace, "nested"));
  await writeFile(
    path.join(privateKeyWorkspace, "nested", "material.txt"),
    "-----BEGIN PRIVATE KEY-----\nfixture-body\n-----END PRIVATE KEY-----\n",
    "utf8",
  );
  await assert.rejects(
    materializeForTest({ workspace: privateKeyWorkspace }),
    (error) => assertCredentialError(
      error,
      "nested/material.txt",
      WORKSPACE_CREDENTIAL_REASON_CODES.PRIVATE_KEY_BLOCK,
    ),
  );
});

test("credential failure after private-root creation preserves typed diagnostics and cleans staging", async (t) => {
  const workspace = await createWorkspace("crashfix-workspace-credential-cleanup-");
  let failedSnapshotDir;
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  await writeFile(path.join(workspace, "App.kt"), "class App\n", "utf8");

  await assert.rejects(
    materializeForTest({ workspace }, {
      async betweenSnapshotVerificationPasses(snapshotDir) {
        failedSnapshotDir = snapshotDir;
        const target = path.join(snapshotDir, "App.kt");
        await chmod(target, 0o600);
        await writeFile(
          target,
          "-----BEGIN PRIVATE KEY-----\nfixture-body\n-----END PRIVATE KEY-----\n",
          "utf8",
        );
        await chmod(target, 0o400);
      },
    }),
    (error) => assertCredentialError(
      error,
      "App.kt",
      WORKSPACE_CREDENTIAL_REASON_CODES.PRIVATE_KEY_BLOCK,
    ),
  );
  assert.ok(failedSnapshotDir);
  await assert.rejects(lstat(path.dirname(failedSnapshotDir)), /ENOENT/u);
});

test("credential policy preserves source markers and client Firebase config but rejects real assignments", async (t) => {
  const allowedWorkspace = await createWorkspace("crashfix-workspace-credential-safe-");
  const rejectedWorkspaces = [];
  let snapshot;
  t.after(async () => {
    await cleanupResult(snapshot, "snapshot_dir");
    for (const workspace of rejectedWorkspaces) {
      await rm(workspace, { recursive: true, force: true });
    }
    await rm(allowedWorkspace, { recursive: true, force: true });
  });

  await writeFile(
    path.join(allowedWorkspace, ".envrc"),
    "export REPOSITORY_TOKEN=must-not-be-copied\n",
    "utf8",
  );
  await writeFile(path.join(allowedWorkspace, "deploy-token.txt"), "must-not-be-copied\n", "utf8");
  await writeFile(path.join(allowedWorkspace, "auth.txt"), "must-not-be-copied\n", "utf8");
  const markerText = [
    "type",
    "service_account",
    "private_key",
    "client_email",
    "token",
    "secret",
    "-----BEGIN PRIVATE KEY-----",
    "-----END PRIVATE KEY-----",
  ].join(" | ");
  for (const [name, prefix] of [
    ["detector.mjs", "export const markers = "],
    ["Detector.kt", "const val markers = "],
    ["detector.ts", "export const markers = "],
  ]) {
    await writeFile(path.join(allowedWorkspace, name), `${prefix}${JSON.stringify(markerText)}\n`, "utf8");
  }
  await writeFile(
    path.join(allowedWorkspace, "TokenParser.kt"),
    "fun parseToken(token: String) = token.trim()\n",
    "utf8",
  );
  await writeFile(
    path.join(allowedWorkspace, "binary.dat"),
    Buffer.from([0xff, 0xfe, 0x74, 0x6f, 0x6b, 0x65, 0x6e, 0x00]),
  );
  await writeFile(
    path.join(allowedWorkspace, "google-services.json"),
    `${JSON.stringify({
      project_info: { project_id: "safe-test-client-config" },
      client: [{
        client_info: { mobilesdk_app_id: "1:123:android:abc" },
        api_key: [{ current_key: "AIza-fake-client-config-value" }],
      }],
    })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(allowedWorkspace, "package-lock.json"),
    `${JSON.stringify({
      name: "fixture-project",
      lockfileVersion: 3,
      packages: {
        "node_modules/update-notifier-cjs": {
          dependencies: { "registry-auth-token": "^5.0.1" },
        },
      },
    })}\n`,
    "utf8",
  );

  snapshot = await materializeForTest({ workspace: allowedWorkspace });
  await assert.rejects(lstat(path.join(snapshot.snapshot_dir, ".envrc")), /ENOENT/u);
  await assert.rejects(lstat(path.join(snapshot.snapshot_dir, "deploy-token.txt")), /ENOENT/u);
  await assert.rejects(lstat(path.join(snapshot.snapshot_dir, "auth.txt")), /ENOENT/u);
  for (const name of ["detector.mjs", "Detector.kt", "detector.ts"]) {
    assert.match(await readFile(path.join(snapshot.snapshot_dir, name), "utf8"), /service_account/u);
  }
  assert.match(
    await readFile(path.join(snapshot.snapshot_dir, "google-services.json"), "utf8"),
    /safe-test-client-config/u,
  );
  assert.match(
    await readFile(path.join(snapshot.snapshot_dir, "TokenParser.kt"), "utf8"),
    /parseToken/u,
  );
  assert.match(
    await readFile(path.join(snapshot.snapshot_dir, "package-lock.json"), "utf8"),
    /registry-auth-token/u,
  );
  assert.deepEqual(
    await readFile(path.join(snapshot.snapshot_dir, "binary.dat")),
    Buffer.from([0xff, 0xfe, 0x74, 0x6f, 0x6b, 0x65, 0x6e, 0x00]),
  );

  const prefixedToken = ["g", "hp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
  const opaqueToken = "Zk8vQ2mR7pL9xN4cT6wY1aB3dE5fG0hJ";
  const rejectedConfigs = [
    ["gradle.properties", "repoToken=repo-token-123456789\n"],
    ["repository.properties", "repository.password=repo-password-123456789\n"],
    ["release.conf", "api_secret = release-secret-123456789\n"],
    ["deploy.yaml", "accessToken: deploy-token-123456789\n"],
    ["leak-notes.txt", `observed credential: ${prefixedToken}\n`],
    ["opaque-notes.txt", `AUTH_TOKEN=${opaqueToken}\n`],
    ["leaky.json", `${JSON.stringify({ api_token: opaqueToken })}\n`],
    [
      "package-lock.json",
      `${JSON.stringify({
        name: "dependency-secret-fixture",
        lockfileVersion: 3,
        packages: {
          "node_modules/example": {
            dependencies: { api_token: opaqueToken },
          },
        },
      })}\n`,
    ],
    [
      "package.json",
      `${JSON.stringify({
        name: "nested-config-secret-fixture",
        version: "1.0.0",
        config: {
          dependencies: { api_token: opaqueToken },
        },
      })}\n`,
    ],
    [
      "innocent.txt",
      "-----BEGIN PRIVATE KEY-----\nnot-a-real-private-key\n-----END PRIVATE KEY-----\n",
    ],
  ];
  for (const [name, contents] of rejectedConfigs) {
    const workspace = await createWorkspace("crashfix-workspace-credential-rejected-");
    rejectedWorkspaces.push(workspace);
    await writeFile(path.join(workspace, name), contents, "utf8");
    await assert.rejects(materializeForTest({ workspace }), /credential material/u);
  }
});

test("credential CLI failure emits one strict JSON diagnostic without leaks and leaves no private root", async (t) => {
  const workspace = await createWorkspace("crashfix-workspace-cli-credential-");
  const cliTemporaryRoot = await createWorkspace("crashfix-workspace-cli-private-root-");
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(cliTemporaryRoot, { recursive: true, force: true });
  });

  await mkdir(path.join(workspace, "nested"));
  const token = ["g", "hp_", "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8"].join("");
  await writeFile(
    path.join(workspace, "nested", "leak.txt"),
    `authorization: bearer ${token}\n`,
    "utf8",
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        scriptPath,
        "create",
        "--workspace",
        workspace,
        "--forbid-root",
        sharedReportRoot,
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, TMPDIR: cliTemporaryRoot },
      },
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.equal(error.stderr.endsWith("\n"), true);
      const lines = error.stderr.split("\n");
      assert.equal(lines.length, 2);
      assert.equal(lines[1], "");
      const diagnostic = JSON.parse(lines[0]);
      assert.deepEqual(diagnostic, {
        schema_version: "crashfix-workspace-credential-diagnostic/v1",
        error_code: "credential_material_detected",
        reason: WORKSPACE_CREDENTIAL_REASON_CODES.HIGH_CONFIDENCE_TOKEN_OR_SENSITIVE_ASSIGNMENT,
        relative_path: "nested/leak.txt",
      });
      assert.deepEqual(Object.keys(diagnostic).sort(), [
        "error_code",
        "reason",
        "relative_path",
        "schema_version",
      ]);
      assert.equal(error.stderr.includes(workspace), false);
      assert.equal(error.stderr.includes(cliTemporaryRoot), false);
      assert.equal(error.stderr.includes(token), false);
      assert.equal(error.stderr.includes("authorization"), false);
      assert.equal(error.stderr.includes("bearer"), false);
      return true;
    },
  );
  assert.deepEqual(await readdir(cliTemporaryRoot), []);
});

test("test fixture CLI requires one complete strict approval group and keeps downstream commands inherited-only", async (t) => {
  const workspace = await createWorkspace("crashfix-fixture-cli-");
  let snapshot;
  t.after(async () => {
    await cleanupResult(snapshot, "snapshot_dir");
    await rm(workspace, { recursive: true, force: true });
  });
  const fixtureContents = `${JSON.stringify({ password: "fixture-cli-value" })}\n`;
  await writeFile(path.join(workspace, "fixture.json"), fixtureContents, "utf8");
  await writeFile(path.join(workspace, "App.kt"), "class App\n", "utf8");

  const probeResult = await execFileAsync(
    process.execPath,
    [
      scriptPath,
      "probe-test-fixture",
      "--workspace", workspace,
      "--relative-path", "fixture.json",
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  const probe = JSON.parse(probeResult.stdout);
  assert.equal(probe.schema_version, "crashfix-test-fixture-probe/v1");
  assert.equal(probe.override_eligible, true);
  assert.equal(probeResult.stdout.includes(fixtureContents.trim()), false);
  assert.equal(probeResult.stdout.includes(workspace), false);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        scriptPath,
        "probe-test-fixture",
        "--workspace", workspace,
        "--relative-path", "missing-fixture.json",
      ],
      { encoding: "utf8", timeout: 10_000 },
    ),
    (error) => assertHelperCliDiagnostic(
      error,
      "probe_test_fixture",
      [workspace, "missing-fixture.json", os.tmpdir()],
      "filesystem_error",
    ),
  );
  const approvalJson = JSON.stringify({
    relative_path: probe.relative_path,
    sha256: probe.sha256,
  });

  const createResult = await execFileAsync(
    process.execPath,
    [
      scriptPath,
      "create",
      "--workspace", workspace,
      "--forbid-root", sharedReportRoot,
      "--execution-profile", "local_trusted",
      "--project-classification", "test",
      "--fixture-approval-confirmed", "true",
      "--expected-source-ref-sha256", probe.source_ref_sha256,
      "--approved-test-fixture", approvalJson,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  snapshot = JSON.parse(createResult.stdout);
  assert.equal(snapshot.approved_test_fixture_count, 1);
  assert.equal(createResult.stdout.includes("fixture.json"), false);
  assert.equal(createResult.stdout.includes(fixtureContents.trim()), false);

  const verified = await execFileAsync(
    process.execPath,
    [
      scriptPath,
      "verify-source",
      "--workspace", workspace,
      "--snapshot-root", snapshot.snapshot_root,
      "--expected-source-ref-sha256", snapshot.source_ref_sha256,
      "--expected-source-sha256", snapshot.source_snapshot_sha256,
      "--forbid-root", sharedReportRoot,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(JSON.parse(verified.stdout).approved_test_fixture_count, 1);

  const baseCreateArgs = [
    scriptPath,
    "create",
    "--workspace", workspace,
    "--forbid-root", sharedReportRoot,
  ];
  for (const extraArgs of [
    ["--approved-test-fixture", approvalJson],
    [
      "--execution-profile", "local_trusted",
      "--project-classification", "test",
      "--fixture-approval-confirmed", "true",
      "--expected-source-ref-sha256", probe.source_ref_sha256,
      "--approved-test-fixture", "not-json",
    ],
    [
      "--execution-profile", "local_trusted",
      "--project-classification", "test",
      "--fixture-approval-confirmed", "true",
      "--expected-source-ref-sha256", probe.source_ref_sha256,
      "--approved-test-fixture", JSON.stringify({
        relative_path: probe.relative_path,
        sha256: probe.sha256,
        unexpected: true,
      }),
    ],
    [
      "--execution-profile", "local_trusted",
      "--project-classification", "test",
      "--fixture-approval-confirmed", "true",
      "--expected-source-ref-sha256", probe.source_ref_sha256,
      "--approved-test-fixture",
      `{"relative_path":"fixture.json","relative_path":"shadow.json","sha256":"${probe.sha256}"}`,
    ],
    [
      "--execution-profile", "local_trusted",
      "--project-classification", "test",
      "--fixture-approval-confirmed", "true",
      "--expected-source-ref-sha256", probe.source_ref_sha256,
      "--approved-test-fixture", `{ "relative_path":"fixture.json","sha256":"${probe.sha256}" }`,
    ],
  ]) {
    await assert.rejects(
      execFileAsync(process.execPath, [...baseCreateArgs, ...extraArgs], {
        encoding: "utf8",
        timeout: 10_000,
      }),
    );
  }

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        scriptPath,
        "clone",
        "--snapshot-root", snapshot.snapshot_root,
        "--role", "candidate",
        "--expected-source-ref-sha256", snapshot.source_ref_sha256,
        "--expected-source-sha256", snapshot.source_snapshot_sha256,
        "--forbid-root", workspace,
        "--forbid-root", sharedReportRoot,
        "--approved-test-fixture", approvalJson,
      ],
      { encoding: "utf8", timeout: 10_000 },
    ),
    (error) => assertHelperCliDiagnostic(error, "clone", [workspace, "fixture.json"]),
  );
});

test("enforces file, byte, directory, depth, path, and portable-collision budgets", async (t) => {
  const workspace = await createWorkspace("crashfix-workspace-budget-");
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  await writeFile(path.join(workspace, "a.txt"), "12345", "utf8");
  await writeFile(path.join(workspace, "b.txt"), "67890", "utf8");
  await mkdir(path.join(workspace, "one"));
  await mkdir(path.join(workspace, "one", "two"));
  await writeFile(path.join(workspace, "one", "two", "c.txt"), "x", "utf8");

  await assert.rejects(
    materializeForTest({ workspace, limits: { maxFiles: 2 } }),
    /file-count limit/u,
  );
  await assert.rejects(
    materializeForTest({ workspace, limits: { maxFileBytes: 4 } }),
    /per-file byte limit/u,
  );
  await assert.rejects(
    materializeForTest({ workspace, limits: { maxTotalBytes: 9 } }),
    /aggregate byte limit/u,
  );
  await assert.rejects(
    materializeForTest({ workspace, limits: { maxDirectories: 2 } }),
    /directory-count limit/u,
  );
  await assert.rejects(
    materializeForTest({ workspace, limits: { maxDepth: 1 } }),
    /directory-depth limit/u,
  );
  await assert.rejects(
    materializeForTest({ workspace, limits: { maxPathChars: 4 } }),
    /overlong relative path/u,
  );

  const seen = new Set();
  validateWorkspaceRelativePath("src/Foo.kt", seen);
  assert.throws(
    () => validateWorkspaceRelativePath("src/foo.kt", seen),
    /collision/u,
  );
  assert.throws(
    () => validateWorkspaceRelativePath("src/bad\nname.kt", new Set()),
    /unsafe/u,
  );
});

test("forbid roots protect external and nested report trees and CLI contracts stay bounded", async (t) => {
  const workspace = await createWorkspace("crashfix-workspace-cli-");
  const separateForbidden = await createWorkspace("crashfix-workspace-session-");
  const secondForbidden = await createWorkspace("crashfix-workspace-viewer-");
  let cliSnapshot;
  let cliClone;
  let nestedSnapshot;
  let redundantNestedSnapshot;
  t.after(async () => {
    await cleanupResult(cliClone, "workspace_dir");
    await cleanupResult(cliSnapshot, "snapshot_dir");
    await cleanupResult(nestedSnapshot, "snapshot_dir");
    await cleanupResult(redundantNestedSnapshot, "snapshot_dir");
    await rm(separateForbidden, { recursive: true, force: true });
    await rm(secondForbidden, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });
  await writeFile(path.join(workspace, "App.kt"), "class App\n", "utf8");
  const nestedForbidden = path.join(workspace, "report-session");
  await mkdir(nestedForbidden);
  await writeFile(path.join(nestedForbidden, "report.md"), "must be dynamically excluded\n", "utf8");
  const nestedSession = path.join(nestedForbidden, "session");
  await mkdir(nestedSession);
  await writeFile(path.join(nestedSession, "private.json"), "{\"private\":true}\n", "utf8");

  await assert.rejects(
    materializeWorkspaceSnapshot({ workspace }),
    /requires a report\/viewer forbidden root/u,
  );

  await assert.rejects(
    materializeWorkspaceSnapshot({ workspace, forbidRoot: await realpath(os.tmpdir()) }),
    /nested below a forbidden root/u,
  );
  nestedSnapshot = await materializeWorkspaceSnapshot({ workspace, forbidRoot: nestedForbidden });
  await assert.rejects(
    readFile(path.join(nestedSnapshot.snapshot_dir, "report-session", "report.md")),
    /ENOENT/u,
  );
  assert.match(nestedSnapshot.dynamic_exclusions_sha256, /^[a-f0-9]{64}$/u);
  redundantNestedSnapshot = await materializeWorkspaceSnapshot({
    workspace,
    forbidRoots: [nestedForbidden, nestedSession],
  });
  assert.equal(
    redundantNestedSnapshot.dynamic_exclusions_sha256,
    nestedSnapshot.dynamic_exclusions_sha256,
  );
  assert.equal(
    redundantNestedSnapshot.source_snapshot_sha256,
    nestedSnapshot.source_snapshot_sha256,
  );
  const redundantVerification = await verifyWorkspaceSource({
    workspace,
    snapshotRoot: redundantNestedSnapshot.snapshot_root,
    expectedSourceRefSha256: redundantNestedSnapshot.source_ref_sha256,
    expectedSourceSnapshotSha256: redundantNestedSnapshot.source_snapshot_sha256,
    forbidRoots: [nestedForbidden],
  });
  assert.equal(redundantVerification.unchanged, true);
  await assert.rejects(
    verifyWorkspaceSource({
      workspace,
      snapshotRoot: redundantNestedSnapshot.snapshot_root,
      expectedSourceRefSha256: redundantNestedSnapshot.source_ref_sha256,
      expectedSourceSnapshotSha256: redundantNestedSnapshot.source_snapshot_sha256,
      forbidRoots: [nestedSession],
    }),
    /included-source manifest changed/u,
  );

  const create = await execFileAsync(
    process.execPath,
    [
      scriptPath, "create", "--workspace", workspace,
      "--forbid-root", separateForbidden,
      "--forbid-root", secondForbidden,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  cliSnapshot = JSON.parse(create.stdout);
  assert.equal(cliSnapshot.schema_version, "crashfix-workspace-snapshot/v2");

  const sourceVerification = await execFileAsync(
    process.execPath,
    [
      scriptPath, "verify-source", "--workspace", workspace,
      "--snapshot-root", cliSnapshot.snapshot_root,
      "--expected-source-ref-sha256", cliSnapshot.source_ref_sha256,
      "--expected-source-sha256", cliSnapshot.source_snapshot_sha256,
      "--forbid-root", separateForbidden,
      "--forbid-root", secondForbidden,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(JSON.parse(sourceVerification.stdout).unchanged, true);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        scriptPath, "clone", "--snapshot-root", cliSnapshot.snapshot_root,
        "--role", "candidate", "--forbid-root", workspace,
        "--forbid-root", separateForbidden,
      ],
      { encoding: "utf8", timeout: 10_000 },
    ),
    (error) => assertHelperCliDiagnostic(error, "clone", [workspace, cliSnapshot.snapshot_root]),
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        scriptPath, "clone", "--snapshot-root", cliSnapshot.snapshot_root,
        "--role", "candidate",
        "--expected-source-ref-sha256", "0".repeat(64),
        "--expected-source-sha256", cliSnapshot.source_snapshot_sha256,
        "--forbid-root", workspace,
        "--forbid-root", separateForbidden,
      ],
      { encoding: "utf8", timeout: 10_000 },
    ),
    (error) => assertHelperCliDiagnostic(error, "clone", [workspace, cliSnapshot.snapshot_root]),
  );
  await assert.rejects(
    cloneSnapshotWorkspace({
      snapshotRoot: cliSnapshot.snapshot_root,
      role: "candidate",
      expectedSourceRefSha256: cliSnapshot.source_ref_sha256,
      expectedSourceSnapshotSha256: cliSnapshot.source_snapshot_sha256,
    }),
    /requires distinct original-project/u,
  );

  const clone = await execFileAsync(
    process.execPath,
    [
      scriptPath, "clone", "--snapshot-root", cliSnapshot.snapshot_root,
      "--role", "candidate",
      "--expected-source-ref-sha256", cliSnapshot.source_ref_sha256,
      "--expected-source-sha256", cliSnapshot.source_snapshot_sha256,
      "--forbid-root", workspace,
      "--forbid-root", separateForbidden,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  cliClone = JSON.parse(clone.stdout);
  assert.equal(cliClone.role, "candidate");
  assert.equal(await readFile(path.join(cliClone.workspace_dir, "App.kt"), "utf8"), "class App\n");

  const audit = await execFileAsync(
    process.execPath,
    [
      scriptPath, "audit", "--workspace-root", cliClone.workspace_root,
      "--snapshot-root", cliSnapshot.snapshot_root,
      "--expected-source-sha256", cliSnapshot.source_snapshot_sha256,
      "--role", "candidate",
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  const cliAudit = JSON.parse(audit.stdout);
  assert.equal(cliAudit.clean, true);
  assert.equal(cliAudit.candidate_manifest_sha256, cliSnapshot.manifest_sha256);
});

test("self-materializes the current repository while excluding AI runtime and nested report trees", async (t) => {
  const repository = path.resolve(".");
  const nestedReport = await mkdtemp(path.join(repository, ".crashfix-self-report-"));
  const reportWorkspace = path.join(repository, "workspace");
  let snapshot;
  t.after(async () => {
    await cleanupResult(snapshot, "snapshot_dir");
    await rm(nestedReport, { recursive: true, force: true });
  });
  await writeFile(path.join(nestedReport, "session-private.json"), "{\"private\":true}\n", "utf8");

  snapshot = await materializeWorkspaceSnapshot({
    workspace: repository,
    forbidRoots: [nestedReport, reportWorkspace],
  });
  assert.ok(snapshot.files > 0);
  assert.match(
    await readFile(
      path.join(snapshot.snapshot_dir, "skills", "crashfix", "scripts", "materialize-workspace-snapshot.mjs"),
      "utf8",
    ),
    /materializeWorkspaceSnapshot/u,
  );
  for (const excluded of [
    ".codex",
    ".claude",
    ".cursor",
    ".agents",
    ".worktrees",
    "workspace",
    path.basename(nestedReport),
  ]) {
    await assert.rejects(lstat(path.join(snapshot.snapshot_dir, excluded)), /ENOENT/u);
  }
});
