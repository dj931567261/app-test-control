import { test } from "node:test";
import assert from "node:assert/strict";
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
  symlink,
  truncate,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import {
  appendStep,
  assertCrashfixAnalysisForReport,
  assertStoredCrashfixAnalysis,
  candidateProvenanceSchema,
  crashfixAnalysisSchema,
  crashSignatureVersionSchema,
  crashSourceSchema,
  copyRegularFilePrivate,
  createSession as createSessionRaw,
  finalizeSession,
  loadMeta,
  readCrashes,
  readSteps,
  recordCrashEvidence,
  recordCrashfixAnalysis,
  recordCrashfixTarget,
  recordCandidateProvenance,
  recordSnapshotProvenance,
  resolveSessionDir,
  snapshotProvenanceSchema,
  withSessionLock,
  writeMeta,
  EMPTY_APPROVED_TEST_FIXTURES_SHA256,
  MAX_CRASHES_PER_SESSION,
  MAX_SESSION_LOCK_OWNER_BYTES,
  MAX_SESSION_META_BYTES,
  MAX_STEPS_PER_SESSION,
  type CrashRecord,
  type CrashSignatureVersion,
  type CrashSource,
  type SessionMeta,
  type SnapshotProvenance,
  CRASHFIX_STEP_ACTIONS,
} from "./sessions.js";
import {
  MAX_REPORT_BYTES,
  assertCrashfixPublicProjectionOmitsSourceIdentifiers,
  publicCrashSignatureVersion,
  publicSessionExtra,
  readReport,
  renderMarkdown,
  writeReport,
} from "./report.js";
import { renderHtml, writeHtmlReport } from "./html-report.js";
import { computeCanonicalAnalyzerIdentity } from "./analyzer-identity.js";

type CreateSessionOptions = Parameters<typeof createSessionRaw>[0];

// Most CrashFix fixtures exercise contracts unrelated to Firebase setup. Keep
// them explicit at the shared fixture boundary while dedicated tests below use
// createSessionRaw to cover missing, invalid, and route-conflicting values.
function createSession(opts: CreateSessionOptions) {
  const isOfficialCrashfix =
    opts.sourceLock?.acquisition_route === "official_firebase_mcp"
    && opts.extra?.provenance_status !== undefined;
  let extra = opts.extra;
  if (isOfficialCrashfix && !("firebase_access" in (extra ?? {}))) {
    extra = { ...extra, firebase_access: "service-account" };
  }
  if (
    extra?.provenance_status !== undefined
    && extra.requested_execution_profile === "local_trusted"
    && !("workspace_project_classification" in extra)
  ) {
    extra = { ...extra, workspace_project_classification: "test" };
  }
  const name = extra?.provenance_status !== undefined
    && !opts.name.startsWith("crashfix-")
    ? `crashfix-${opts.name}`
    : opts.name;
  return createSessionRaw({
    ...opts,
    name,
    // Most legacy assertions in this file intentionally exercise the existing
    // English copy. Dedicated i18n tests below cover the product default.
    reportLanguage: opts.reportLanguage ?? "en-US",
    ...(extra === undefined ? {} : { extra }),
  });
}

test("new sessions persist a closed report language and default to Simplified Chinese", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "report-language-session-test-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));

  const defaultSession = await createSessionRaw({
    name: "language-default",
    workspaceRoot: workspace,
  });
  assert.equal((await loadMeta(defaultSession.dir)).report_language, "zh-CN");

  const englishSession = await createSessionRaw({
    name: "language-english",
    workspaceRoot: workspace,
    reportLanguage: "en-US",
  });
  assert.equal((await loadMeta(englishSession.dir)).report_language, "en-US");

  await assert.rejects(
    createSessionRaw({
      name: "language-unsupported",
      workspaceRoot: workspace,
      reportLanguage: "fr-FR" as never,
    }),
    /Invalid enum value|invalid_enum_value/i,
  );
});

test("quick_test workflow metadata is closed and never masquerades as strict provenance", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "report-quick-workflow-test-"));
  const baseExtra = {
    origin: "remote",
    provider: "firebase-crashlytics",
    acquisition_route: "official_firebase_mcp" as const,
    source_locked: true,
    raw_evidence_archived: false,
    firebase_access: "service-account" as const,
    provenance_status: "unavailable" as const,
    requested_mode: "analyze" as const,
    requested_workflow: "quick_test" as const,
    requested_execution_profile: "local_trusted" as const,
    workspace_project_classification: "test" as const,
  };
  try {
    const session = await createSessionRaw({
      name: "crashfix-quick-workflow",
      workspaceRoot: workspace,
      sourceLock: firebaseSourceLock(),
      extra: baseExtra,
    });
    const meta = await loadMeta(session.dir);
    assert.equal(meta.extra?.requested_workflow, "quick_test");
    assert.equal(meta.extra?.provenance_status, "unavailable");
    assert.equal(publicSessionExtra(meta.extra).requested_workflow, "quick_test");
    assert.equal(
      publicSessionExtra({
        ...baseExtra,
        provenance_status: "resolved",
        provenance_mode: "git_release_exact",
      }).requested_workflow,
      undefined,
    );

    await assert.rejects(
      createSessionRaw({
        name: "crashfix-quick-docker",
        workspaceRoot: workspace,
        sourceLock: firebaseSourceLock(),
        extra: { ...baseExtra, requested_execution_profile: "docker_strict" },
      }),
      /requested_workflow=quick_test requires requested_execution_profile=local_trusted/,
    );
    await assert.rejects(
      createSessionRaw({
        name: "crashfix-quick-prod",
        workspaceRoot: workspace,
        sourceLock: firebaseSourceLock(),
        extra: (({ workspace_project_classification: _classification, ...withoutClassification }) =>
          withoutClassification)(baseExtra),
      }),
      /workspace_project_classification=test/,
    );
    await assert.rejects(
      createSessionRaw({
        name: "crashfix-quick-resolved",
        workspaceRoot: workspace,
        sourceLock: firebaseSourceLock(),
        extra: {
          ...baseExtra,
          provenance_status: "resolved",
          provenance_mode: "git_release_exact",
        },
      }),
      /requested_workflow=quick_test requires provenance_status=unavailable/,
    );
    await assert.rejects(
      createSessionRaw({
        name: "crashfix-quick-patch",
        workspaceRoot: workspace,
        sourceLock: firebaseSourceLock(),
        extra: {
          ...baseExtra,
          requested_mode: "patch",
        },
      }),
      /requested_workflow=quick_test requires requested_mode=analyze/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legacy CrashFix callers default to strict and never implicitly gain quick_test", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "report-workflow-default-test-"));
  try {
    const session = await createSessionRaw({
      name: "crashfix-workflow-default",
      workspaceRoot: workspace,
      sourceLock: firebaseSourceLock(),
      extra: {
        origin: "remote",
        provider: "firebase-crashlytics",
        acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
        source_locked: true,
        raw_evidence_archived: false,
        firebase_access: "service-account",
        provenance_status: "unavailable",
        requested_mode: "analyze",
      },
    });
    const meta = await loadMeta(session.dir);
    assert.equal(meta.extra?.requested_workflow, "strict");
    assert.equal(publicSessionExtra(meta.extra).requested_workflow, "strict");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("quick_test archives at most one distinct Firebase event", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "report-quick-event-limit-test-"));
  try {
    const session = await createSessionRaw({
      name: "crashfix-quick-event-limit",
      workspaceRoot: workspace,
      sourceLock: firebaseSourceLock(),
      extra: {
        origin: "remote",
        provider: "firebase-crashlytics",
        acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
        source_locked: true,
        raw_evidence_archived: false,
        firebase_access: "service-account",
        provenance_status: "unavailable",
        requested_mode: "analyze",
        requested_workflow: "quick_test",
        requested_execution_profile: "local_trusted",
        workspace_project_classification: "test",
      },
    });
    const stack = [
      "Normalized Crash Event",
      "Kind: java",
      "Exception Class: java.lang.IllegalStateException",
      "Frame 0: app.Main.run",
    ].join("\n");
    const identity = computeCanonicalAnalyzerIdentity(stack);
    const appBuild = {
      platform: "android" as const,
      app_id: "com.example.app",
      version: "1.0",
      build: "1",
    };
    const localLog = path.join(workspace, "local.log");
    await writeFile(localLog, "local-only log", "utf8");
    await recordCrashfixTarget(session.dir, {
      project: "project",
      app: "app",
      issue: "issue",
      app_build: appBuild,
    });
    const makeEvidence = (event: string) => ({
      signature: identity.fingerprint,
      signature_version: identity.signature_version,
      signature_degraded: false,
      cross_source_comparable: true,
      stack,
      kind: "java" as const,
      repro_path: [],
      source: firebaseCrashSource(identity.fingerprint, {
        event,
        app_build: appBuild,
      }),
      acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
    });
    await assert.rejects(
      recordCrashEvidence(session.dir, {
        ...makeEvidence("event-local-log"),
        log_full_src: localLog,
      }),
      /must omit log_full_src/i,
    );
    await assert.rejects(
      recordCrashEvidence(session.dir, {
        ...makeEvidence("event-local-repro"),
        repro_path: [1],
      }),
      /empty repro_path and no local step_index/i,
    );
    await recordCrashEvidence(session.dir, makeEvidence("event-1"));
    await assert.rejects(
      recordCrashEvidence(session.dir, makeEvidence("event-2")),
      /quick_test CrashFix sessions accept at most one crash event/,
    );
    assert.equal((await readCrashes(session.dir)).length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("end-to-end: create session, add steps + crash, render report", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-mcp-test-"));
  try {
    const session = await createSession({
      name: "devtest-login",
      workspaceRoot: tmp,
      sourceLock: firebaseSourceLock(),
      extra: {
        commit: "abc1234",
        device_id: "private-device-udid",
        private_token: "must-not-render",
      },
    });
    assert.ok(session.id.includes("devtest-login"));

    // record two steps
    await appendStep(session.dir, {
      index: 1,
      ts: new Date().toISOString(),
      action: "launch app",
      result: "ok",
    });
    await appendStep(session.dir, {
      index: 2,
      ts: new Date().toISOString(),
      action: "tap login button",
      result: "fail",
      notes: "crashed here",
    });

    // record a crash
    const signature = "a1b2c3d4e5f6";
    await recordCrashEvidence(session.dir, {
      step_index: 2,
      signature,
      signature_version: JAVA_SIGNATURE_VERSION,
      kind: "java",
      stack: "java.lang.NullPointerException\n at LoginActivity.onClick(LoginActivity.kt:42)",
      repro_path: [1, 2],
      source: firebaseCrashSource(signature, {
        project: "demo-project",
        app: "app-1",
        issue: "issue-secret-1234567890",
        event: "event-secret-0987654321",
        occurred: "2026-07-29T01:02:03Z",
        metrics: { events: 7, users: 3 },
      }),
      acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
    });

    // finalize: update meta, render markdown
    const meta = await loadMeta(session.dir);
    meta.status = "failed";
    meta.ended_at = new Date(Date.now() + 5_000).toISOString();
    await writeMeta(session.dir, meta);

    const steps = await readSteps(session.dir);
    const crashes = await readCrashes(session.dir);
    assert.equal(steps.length, 2);
    assert.equal(crashes.length, 1);

    const md = renderMarkdown({ meta, steps, crashes, summary: "1 crash detected" });
    const reportPath = await writeReport(session.dir, md);
    const onDisk = await readFile(reportPath, "utf8");
    assert.match(onDisk, /Session: devtest-login/);
    assert.match(onDisk, /Steps\*\*:\s*2/);
    assert.match(onDisk, /Crashes\*\*:\s*1/);
    assert.match(onDisk, /a1b2c3d4e5f6/);
    assert.match(onDisk, /Signature version\*\*:\s*`java-v2`/);
    assert.match(onDisk, /Repro path \(steps\)\*\*:\s*#1\s*→\s*#2/);
    assert.match(onDisk, /FAILED/);
    assert.match(onDisk, /firebase-crashlytics/);
    assert.match(onDisk, /ref sha256:[a-f0-9]{10}/);
    assert.match(onDisk, /occurred 2026-07-29T01:02:03Z/);
    assert.doesNotMatch(onDisk, /demo-project|app-1|issue-secret|event-secret/);
    assert.match(onDisk, /device_ref_sha256/);
    assert.doesNotMatch(onDisk, /private-device-udid|private_token|must-not-render/);

    // session dir structure
    for (const directory of [tmp, session.dir, path.join(session.dir, "steps")]) {
      assert.equal((await stat(directory)).mode & 0o077, 0, directory);
    }
    for (const file of ["meta.json", "steps.jsonl", "crashes.jsonl", "report.md"]) {
      const filePath = path.join(session.dir, file);
      assert.equal((await stat(filePath)).mode & 0o077, 0, filePath);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("report.md reads are bounded, link-safe, strict UTF-8, and race-detecting", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "report-read-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let counter = 0;
  const nextSession = () => createSession({
    name: `report-read-${counter++}`,
    workspaceRoot: root,
  });

  const ordinary = await nextSession();
  await writeReport(ordinary.dir, "# safe report\n");
  assert.equal(await readReport(ordinary.dir), "# safe report\n");

  const symbolic = await nextSession();
  const external = path.join(root, "external-report.md");
  await writeFile(external, "external", "utf8");
  await symlink(external, path.join(symbolic.dir, "report.md"));
  await assert.rejects(readReport(symbolic.dir), /symbolic link|ELOOP/i);

  const hardLinked = await nextSession();
  const hardLinkedPath = await writeReport(hardLinked.dir, "linked");
  await link(hardLinkedPath, path.join(root, "report-hard-link.md"));
  await assert.rejects(readReport(hardLinked.dir), /single-link regular file/i);

  const invalidUtf8 = await nextSession();
  await writeFile(
    path.join(invalidUtf8.dir, "report.md"),
    Buffer.from([0xc3, 0x28]),
    { mode: 0o600 },
  );
  await assert.rejects(readReport(invalidUtf8.dir), /not valid UTF-8/i);

  const oversized = await nextSession();
  const oversizedPath = path.join(oversized.dir, "report.md");
  await writeFile(oversizedPath, "", { mode: 0o600 });
  await truncate(oversizedPath, MAX_REPORT_BYTES + 1);
  await assert.rejects(readReport(oversized.dir), /byte size limit/i);

  const changing = await nextSession();
  const changingPath = await writeReport(changing.dir, "x".repeat(128 * 1024));
  await assert.rejects(
    readReport(changing.dir, {
      onFileValidated: async () => truncate(changingPath, 1),
    }),
    /changed while it was being read/i,
  );
});

test("reports default to Simplified Chinese and support an immutable English selection", () => {
  const baseMeta = {
    id: "x",
    name: "empty",
    started_at: new Date().toISOString(),
    status: "passed" as const,
  };
  const md = renderMarkdown({
    meta: {
      ...baseMeta,
    },
    steps: [],
    crashes: [],
  });
  const html = renderHtml({ meta: baseMeta, steps: [], crashes: [] });
  assert.match(md, /会话：\s*empty/);
  assert.match(md, /暂无步骤记录/);
  assert.match(md, /步骤\*\*：\s*0/);
  assert.match(md, /崩溃\*\*：\s*0/);
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /暂无步骤记录/);

  const englishMeta = { ...baseMeta, report_language: "en-US" as const };
  const englishMarkdown = renderMarkdown({
    meta: englishMeta,
    steps: [],
    crashes: [],
  });
  const englishHtml = renderHtml({ meta: englishMeta, steps: [], crashes: [] });
  assert.match(englishMarkdown, /Session: empty/);
  assert.match(englishMarkdown, /no steps recorded/);
  assert.match(englishHtml, /<html lang="en-US">/);
  assert.match(englishHtml, /no steps recorded/);
});

test("Chinese reports localize trusted CrashFix action labels without rewriting audit codes", () => {
  const meta = {
    id: "crashfix-language",
    name: "crashfix-language",
    started_at: new Date().toISOString(),
    status: "running" as const,
    report_language: "zh-CN" as const,
    source_lock: firebaseSourceLock(),
    extra: {
      provenance_status: "unavailable",
      requested_mode: "analyze",
      requested_workflow: "quick_test",
      requested_execution_profile: "local_trusted",
      workspace_project_classification: "test",
      origin: "remote",
      provider: "firebase-crashlytics",
      acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
      source_locked: true,
      raw_evidence_archived: false,
      firebase_access: "service-account",
    },
  };
  const steps = CRASHFIX_STEP_ACTIONS.map((action, offset) => ({
    index: offset + 1,
    ts: new Date().toISOString(),
    action,
    result: "ok" as const,
    ...(action === "remote_scope_verification"
      ? {
          notes: JSON.stringify({
            provider: "firebase-crashlytics",
            acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
          }),
        }
      : {}),
  }));
  for (const report of [
    renderMarkdown({ meta, steps, crashes: [] }),
    renderHtml({ meta, steps, crashes: [] }),
  ]) {
    assert.match(report, /远程范围核验/);
    for (const action of CRASHFIX_STEP_ACTIONS) {
      assert.match(report, new RegExp(`\\(${action}\\)`));
    }
    assert.match(report, /firebase-crashlytics/);
  }
});

test("ordinary Chinese sessions preserve action text and localize missing analyzer values", () => {
  const meta = {
    id: "ordinary-language",
    name: "ordinary-language",
    started_at: new Date().toISOString(),
    status: "running" as const,
    report_language: "zh-CN" as const,
  };
  const steps = [{
    index: 1,
    ts: new Date().toISOString(),
    action: "preflight",
    result: "ok" as const,
  }];
  const crashes = [{
    id: "c1",
    ts: new Date().toISOString(),
    signature: "local-crash",
    signature_degraded: false,
    stack_path: "crashes/c1.stack.txt",
    repro_path: [],
  }];

  const markdown = renderMarkdown({ meta, steps, crashes });
  const html = renderHtml({ meta, steps, crashes });
  for (const report of [markdown, html]) {
    assert.match(report, /preflight/);
    assert.doesNotMatch(report, /预检 \(preflight\)/);
  }
  assert.match(html, /cross-source-comparable=未知/);
  assert.doesNotMatch(html, /cross-source-comparable=unknown/);
});

test("public crash signature versions use a closed, injection-safe label", () => {
  assert.deepEqual(
    ["v1", "java-v2", "ios-v2"].map((value) => crashSignatureVersionSchema.parse(value)),
    ["v1", "java-v2", "ios-v2"],
  );
  assert.throws(
    () => crashSignatureVersionSchema.parse("java-v3"),
    /Invalid enum value|invalid_enum_value/i,
  );
  assert.equal(publicCrashSignatureVersion("</code><script>secret</script>"), "unversioned");

  const taintedCrash = {
    id: "c1",
    ts: new Date().toISOString(),
    signature: "safe-signature",
    signature_version: "</code><script>secret</script>" as never,
    stack_path: "crashes/c1.stack.txt",
    repro_path: [],
  };
  for (const report of [
    renderMarkdown({
      meta: {
        id: "x",
        name: "x",
        started_at: new Date().toISOString(),
        status: "passed",
        report_language: "en-US",
      },
      steps: [],
      crashes: [taintedCrash],
    }),
    renderHtml({
      meta: {
        id: "x",
        name: "x",
        started_at: new Date().toISOString(),
        status: "passed",
        report_language: "en-US",
      },
      steps: [],
      crashes: [taintedCrash],
    }),
  ]) {
    assert.match(report, /Signature version/);
    assert.match(report, /unversioned/);
    assert.doesNotMatch(report, /secret|<script>/);
  }
});

test("public session extra validates and redacts optional source provenance", () => {
  const snapshot = snapshotProvenanceFixture({
    manifest_sha256: "0".repeat(64),
    exclusion_policy_sha256: "1".repeat(64),
    dynamic_exclusions_sha256: "6".repeat(64),
    approved_test_fixtures_sha256: "7".repeat(64),
    approved_test_fixture_count: 1,
    files: 12,
    directories: 4,
    bytes: 4096,
  });
  assert.deepEqual(
    publicSessionExtra({
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      ...snapshot,
      // A partial candidate lifecycle is intentionally hidden as one group.
      canonical_diff_sha256: "2".repeat(64),
      candidate_manifest_sha256: "3".repeat(64),
      build_environment_sha256: "4".repeat(64),
      destination_ref_sha256: "5".repeat(64),
      project_alias: "project-demo_01",
      repo_alias: "repo.demo-01",
      source_snapshot_path: "/Users/private/source-snapshot",
    }),
    {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      source_snapshot_sha256: snapshot.source_snapshot_sha256.slice(0, 12),
      exclusion_policy_sha256: "1".repeat(12),
      dynamic_exclusions_sha256: "6".repeat(12),
      approved_test_fixtures_sha256: "7".repeat(12),
      approved_test_fixture_count: 1,
      files: 12,
      directories: 4,
      bytes: 4096,
      project_alias: "project-demo_01",
      repo_alias: "repo.demo-01",
    },
  );
  assert.deepEqual(
    publicSessionExtra({
      provenance_status: "resolved",
      provenance_mode: "git_release_exact",
      commit: "a".repeat(40),
      candidate_base_sha: "b".repeat(64),
      diff_sha256: "c".repeat(64),
      artifact_sha256: "d".repeat(64),
      build_environment_sha256: "e".repeat(64),
      changed_files: ["src/Main.kt"],
    }),
    {
      provenance_status: "resolved",
      provenance_mode: "git_release_exact",
      commit: "a".repeat(12),
      candidate_base_sha: "b".repeat(12),
      diff_sha256: "c".repeat(12),
      artifact_sha256: "d".repeat(12),
      build_environment_sha256: "e".repeat(12),
      changed_files: ["src/Main.kt"],
    },
  );
});

test("resolved provenance safely renders its exact status and a valid mode", () => {
  const meta = {
    id: "provenance-resolved",
    name: "provenance-resolved",
    started_at: new Date().toISOString(),
    status: "passed" as const,
    report_language: "en-US" as const,
    extra: {
      provenance_status: "resolved",
      provenance_mode: "git_release_exact",
    },
  };

  assert.deepEqual(publicSessionExtra(meta.extra), {
    provenance_status: "resolved",
    provenance_mode: "git_release_exact",
  });
  for (const report of [
    renderMarkdown({ meta, steps: [], crashes: [] }),
    renderHtml({ meta, steps: [], crashes: [] }),
  ]) {
    assert.match(report, /provenance_status/);
    assert.match(report, /resolved/);
    assert.match(report, /provenance_mode/);
    assert.match(report, /git_release_exact/);
  }
});

test("unavailable provenance is privately preserved and rendered without a provenance mode", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-provenance-unavailable-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const fullSnapshotSha = "7".repeat(64);
  const privateDiagnosticPath = "/Users/private/project/.git";
  const session = await createSession({
    name: "provenance-unavailable",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock(),
    extra: {
      provenance_status: "unavailable",
    },
  });

  const meta = await loadMeta(session.dir);
  assert.equal(meta.extra?.provenance_status, "unavailable");
  // Simulate damaged legacy metadata. New CrashFix start_session calls reject
  // this field, while the public renderer must still fail closed on old files.
  meta.extra = { ...meta.extra, provenance_diagnostic_path: privateDiagnosticPath };
  await writeMeta(session.dir, meta);
  assert.equal(meta.extra?.provenance_diagnostic_path, privateDiagnosticPath);
  // Simulate a damaged legacy meta file. The public projection must not repeat
  // a snapshot identity that contradicts the closed unavailable state.
  meta.extra = { ...meta.extra, source_snapshot_sha256: fullSnapshotSha };
  await writeMeta(session.dir, meta);
  assert.deepEqual(publicSessionExtra(meta.extra), {
    provenance_status: "unavailable",
  });

  for (const report of [
    renderMarkdown({ meta, steps: [], crashes: [] }),
    renderHtml({ meta, steps: [], crashes: [] }),
  ]) {
    assert.match(report, /provenance_status/);
    assert.match(report, /unavailable/);
    assert.doesNotMatch(report, /777777777777/);
    assert.doesNotMatch(report, /provenance_mode/);
    assert.doesNotMatch(report, new RegExp(fullSnapshotSha));
    assert.doesNotMatch(report, /Users|private|\.git/);
  }
});

test("unavailable provenance never fabricates or repeats a contradictory mode", () => {
  assert.deepEqual(
    publicSessionExtra({
      provenance_status: "unavailable",
      provenance_mode: "git_release_exact",
    }),
    { provenance_status: "unavailable" },
  );
  assert.deepEqual(
    publicSessionExtra({
      provenance_mode: "snapshot_repro_equivalent",
      provenance_status: "unavailable",
    }),
    { provenance_status: "unavailable" },
  );
});

test("requested execution profile is publicly projected only as a valid CrashFix lock", () => {
  assert.deepEqual(
    publicSessionExtra({
      provenance_status: "resolved",
      provenance_mode: "git_release_exact",
      requested_execution_profile: "docker_strict",
    }),
    {
      provenance_status: "resolved",
      provenance_mode: "git_release_exact",
      requested_execution_profile: "docker_strict",
    },
  );
  assert.deepEqual(
    publicSessionExtra({
      provenance_status: "unavailable",
      requested_execution_profile: "local_trusted",
    }),
    {
      provenance_status: "unavailable",
      requested_execution_profile: "local_trusted",
    },
  );
  assert.deepEqual(
    publicSessionExtra({ requested_execution_profile: "local_trusted" }),
    {},
  );
  assert.deepEqual(
    publicSessionExtra({
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      requested_execution_profile: "sandbox_magic",
    }),
    {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
    },
  );
  const requestedLocalMeta = {
    id: "requested-local",
    name: "requested-local",
    started_at: new Date().toISOString(),
    status: "running" as const,
    report_language: "en-US" as const,
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      requested_mode: "patch",
      requested_execution_profile: "local_trusted",
    },
  };
  assert.match(
    renderMarkdown({ meta: requestedLocalMeta, steps: [], crashes: [] }),
    /not strongly isolated/i,
  );
  assert.match(
    renderHtml({ meta: requestedLocalMeta, steps: [], crashes: [] }),
    /not strongly isolated/i,
  );
});

test("invalid provenance status values and paths fail closed in public reports", () => {
  const invalidStatuses: unknown[] = [
    "available",
    "locked",
    "unavailable ",
    "UNAVAILABLE",
    "/Users/private/project/.git",
    "C:\\Users\\private\\project\\.git",
    "</code><script>private</script>",
    ["unavailable"],
    { status: "unavailable" },
    1,
    true,
  ];

  for (const provenanceStatus of invalidStatuses) {
    const meta = {
      id: "provenance-status",
      name: "provenance-status",
      started_at: new Date().toISOString(),
      status: "aborted" as const,
      extra: {
        provenance_status: provenanceStatus,
        provenance_mode: "git_release_exact",
      },
    };
    assert.deepEqual(publicSessionExtra(meta.extra), {});
    for (const report of [
      renderMarkdown({ meta, steps: [], crashes: [] }),
      renderHtml({ meta, steps: [], crashes: [] }),
    ]) {
      assert.doesNotMatch(
        report,
        /provenance_status|provenance_mode|git_release_exact|<script>|Users|private|\.git/,
      );
    }
  }
});

test("public reports fail closed for invalid provenance and never display absolute paths", () => {
  const absolutePaths = [
    "/Users/private/source-snapshot",
    "C:\\Users\\private\\source-snapshot",
  ];
  for (const absolutePath of absolutePaths) {
    const meta = {
      id: "provenance",
      name: "provenance",
      started_at: new Date().toISOString(),
      status: "passed" as const,
      extra: {
        provenance_mode: absolutePath,
        source_snapshot_sha256: absolutePath,
        project_alias: absolutePath,
        repo_alias: absolutePath,
        source_snapshot_path: absolutePath,
      },
    };
    assert.deepEqual(publicSessionExtra(meta.extra), {});
    assert.doesNotMatch(renderMarkdown({ meta, steps: [], crashes: [] }), /private|source-snapshot/);
    assert.doesNotMatch(renderHtml({ meta, steps: [], crashes: [] }), /private|source-snapshot/);
  }

  for (const invalidAlias of [
    "folder/name",
    "folder\\name",
    "alias\nleak",
    "alias\0leak",
    "../project",
    "project name",
    "project`name",
    "a".repeat(129),
    ["project-demo"],
  ]) {
    assert.deepEqual(
      publicSessionExtra({ project_alias: invalidAlias, repo_alias: invalidAlias }),
      {},
    );
  }

  for (const invalidMode of [
    "snapshot",
    "git_release_exact ",
    "SNAPSHOT_REPRO_EQUIVALENT",
    ["git_release_exact"],
    1,
  ]) {
    assert.deepEqual(publicSessionExtra({ provenance_mode: invalidMode }), {});
  }
  const provenanceHashKeys = [
    "source_snapshot_sha256",
    "exclusion_policy_sha256",
    "canonical_diff_sha256",
    "candidate_manifest_sha256",
    "build_environment_sha256",
    "destination_ref_sha256",
    "dynamic_exclusions_sha256",
    "approved_test_fixtures_sha256",
  ];
  for (const invalidSha of [
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    `${"a".repeat(63)}g`,
    `/${"a".repeat(63)}`,
    "C:\\private\\snapshot.sha256",
    ["a".repeat(64)],
  ]) {
    for (const key of provenanceHashKeys) {
      assert.deepEqual(publicSessionExtra({ [key]: invalidSha }), {});
    }
  }
});

test("public reports expose only 12-character lowercase provenance hash prefixes", () => {
  const snapshot = snapshotProvenanceFixture({
    manifest_sha256: "0".repeat(64),
    exclusion_policy_sha256: "1".repeat(64),
    dynamic_exclusions_sha256: "2".repeat(64),
    approved_test_fixtures_sha256: "f".repeat(64),
    approved_test_fixture_count: 1,
    files: 3,
    directories: 2,
    bytes: 42,
  });
  const provenanceHashes = {
    source_snapshot_sha256: snapshot.source_snapshot_sha256,
    exclusion_policy_sha256: snapshot.exclusion_policy_sha256,
    dynamic_exclusions_sha256: snapshot.dynamic_exclusions_sha256,
    approved_test_fixtures_sha256: snapshot.approved_test_fixtures_sha256,
    baseline_artifact_sha256: "3".repeat(64),
    artifact_sha256: "4".repeat(64),
    build_environment_sha256: "5".repeat(64),
    canonical_diff_sha256: "6".repeat(64),
    candidate_manifest_sha256: "7".repeat(64),
    workspace_canonical_diff_sha256: "6".repeat(64),
    workspace_manifest_sha256: "7".repeat(64),
    artifact_signing_identity_ref_sha256: "8".repeat(64),
    device_ref_sha256: "9".repeat(64),
    plan_sha256: "a".repeat(64),
    destination_ref_sha256: "b".repeat(64),
  };
  const meta = {
    id: "provenance",
    name: "provenance",
    started_at: new Date().toISOString(),
    status: "passed" as const,
    report_language: "en-US" as const,
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      requested_mode: "patch",
      requested_execution_profile: "local_trusted",
      workspace_project_classification: "test",
      manifest_sha256: snapshot.manifest_sha256,
      files: snapshot.files,
      directories: snapshot.directories,
      bytes: snapshot.bytes,
      approved_test_fixture_count: snapshot.approved_test_fixture_count,
      ...provenanceHashes,
      execution_profile: "local_trusted",
      strong_isolation: false,
      workspace_disk_quota_enforced: false,
      network_policy: "not_enforced",
      filesystem_write_isolation: "not_enforced",
      secret_filesystem_isolation: "not_enforced",
      process_containment: "process_group_best_effort",
      changed_files: ["app/src/Main.kt"],
      artifact_platform: "android",
      artifact_app_id: "com.example.app",
      artifact_version: "1.0",
      artifact_build: "1",
      artifact_variant: "release",
      workspace_role: "candidate",
      variant_source: "task-bound",
      variant_artifact_derived: false,
      target_signature_version: JAVA_SIGNATURE_VERSION,
      target_fingerprint: "c".repeat(12),
      verification_child_session_ref_sha256s: [
        "d".repeat(64),
        "e".repeat(64),
        "f".repeat(64),
      ],
      verification_child_evidence_sha256s: [
        "1".repeat(64),
        "2".repeat(64),
        "3".repeat(64),
      ],
      verification_runs: 3,
      verified: true,
    },
  };
  for (const report of [
    renderMarkdown({ meta, steps: [], crashes: [] }),
    renderHtml({ meta, steps: [], crashes: [] }),
  ]) {
    assert.match(report, /local_trusted/);
    assert.match(report, /not strongly isolated/i);
    assert.match(report, /secret_filesystem_isolation/);
    for (const [key, hash] of Object.entries(provenanceHashes)) {
      const prefix = hash.slice(0, 12);
      assert.match(report, new RegExp(key));
      assert.match(report, new RegExp(prefix));
      assert.doesNotMatch(report, new RegExp(hash));
      assert.doesNotMatch(report, new RegExp(hash.slice(0, 13)));
    }
    assert.doesNotMatch(report, /"manifest_sha256"/);
    assert.doesNotMatch(report, new RegExp(snapshot.manifest_sha256));
  }
  const corruptedVerification = publicSessionExtra({
    ...meta.extra,
    verification_child_session_ref_sha256s: [
      "d".repeat(64),
      "d".repeat(64),
      "d".repeat(64),
    ],
  });
  assert.equal(corruptedVerification.verified, undefined);
  assert.equal(corruptedVerification.verification_runs, undefined);
  assert.equal(corruptedVerification.device_ref_sha256, undefined);
  const corruptedExecutionProfile = publicSessionExtra({
    ...meta.extra,
    strong_isolation: true,
  });
  assert.equal(corruptedExecutionProfile.execution_profile, undefined);
  assert.equal(corruptedExecutionProfile.strong_isolation, undefined);
  assert.equal(corruptedExecutionProfile.artifact_sha256, undefined);
  const conflictingRequestedProfile = publicSessionExtra({
    ...meta.extra,
    requested_execution_profile: "docker_strict",
  });
  assert.equal(conflictingRequestedProfile.requested_execution_profile, "docker_strict");
  assert.equal(conflictingRequestedProfile.execution_profile, undefined);
  assert.equal(conflictingRequestedProfile.strong_isolation, undefined);
  assert.equal(conflictingRequestedProfile.artifact_sha256, undefined);
  const fixturePathInjection = {
    ...meta,
    extra: {
      ...meta.extra,
      changed_files: ["fixtures/private.json"],
    },
  };
  const fixturePathPublicExtra = publicSessionExtra(fixturePathInjection.extra);
  assert.equal(fixturePathPublicExtra.changed_files, undefined);
  assert.equal(fixturePathPublicExtra.artifact_sha256, undefined);
  for (const report of [
    renderMarkdown({ meta: fixturePathInjection, steps: [], crashes: [] }),
    renderHtml({ meta: fixturePathInjection, steps: [], crashes: [] }),
  ]) {
    assert.doesNotMatch(report, /fixtures\/private\.json/);
  }
});

test("createSession enforces the closed CrashFix provenance preflight states", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-provenance-preflight-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const lock = firebaseSourceLock();

  for (const [name, extra] of [
    ["git", {
      provenance_status: "resolved",
      provenance_mode: "git_release_exact",
      requested_execution_profile: "docker_strict",
      commit: "a".repeat(40),
      provider: "firebase-crashlytics",
      acquisition_route: "official_firebase_mcp",
      source_locked: true,
    }],
    ["snapshot", {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      provenance_explicit: true,
      requested_mode: "patch",
      requested_execution_profile: "local_trusted",
      origin: "remote",
      project_alias: "test-project",
      repo_alias: "local-repo",
      raw_evidence_archived: false,
    }],
    ["unavailable", {
      provenance_status: "unavailable",
      requested_execution_profile: "docker_strict",
    }],
    ["unavailable-patch-abort", {
      provenance_status: "unavailable",
      requested_mode: "patch",
      requested_workflow: "strict",
      requested_execution_profile: "docker_strict",
      preflight_abort: "provenance_unavailable",
    }],
    ["unavailable-pr-abort", {
      provenance_status: "unavailable",
      requested_mode: "pr",
      requested_workflow: "strict",
      requested_execution_profile: "docker_strict",
      preflight_abort: "capability_mismatch",
    }],
    ["snapshot-pr-abort", {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      requested_mode: "pr",
      requested_workflow: "strict",
      requested_execution_profile: "docker_strict",
      preflight_abort: "capability_mismatch",
    }],
    ["git-pr-compatible", {
      provenance_status: "resolved",
      provenance_mode: "git_release_exact",
      requested_mode: "pr",
      requested_workflow: "strict",
      requested_execution_profile: "docker_strict",
      commit: "b".repeat(40),
    }],
  ] as const) {
    await createSession({ name, workspaceRoot: tmp, sourceLock: lock, extra });
  }

  const invalidExtras: Record<string, unknown>[] = [
    { provenance_status: "resolved" },
    { provenance_mode: "snapshot_repro_equivalent" },
    { source_snapshot_sha256: "a".repeat(64) },
    { approved_test_fixtures_sha256: "a".repeat(64) },
    { approved_test_fixture_count: 1 },
    {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      source_snapshot_sha256: "a".repeat(64),
    },
    {
      provenance_status: "resolved",
      provenance_mode: "git_release_exact",
      canonical_diff_sha256: "b".repeat(64),
    },
    { provenance_status: "unavailable", provenance_mode: "git_release_exact" },
    { provenance_status: "unavailable", files: 1 },
    { provenance_status: "unavailable", commit: "a".repeat(40) },
    {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      commit: "a".repeat(40),
    },
    {
      provenance_status: "resolved",
      provenance_mode: "git_release_exact",
      artifact_sha256: "b".repeat(64),
    },
    {
      provenance_status: "resolved",
      provenance_mode: "git_release_exact",
      acquisition_route: "cloud_logging_mcp",
    },
    {
      provenance_status: "resolved",
      provenance_mode: "git_release_exact",
      source_locked: false,
    },
    { provenance_status: "unknown" },
    { requested_execution_profile: "local_trusted" },
    { workspace_project_classification: "test" },
    {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      workspace_project_classification: "production",
    },
    {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      workspace_project_classification: ["test"],
    },
    {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      requested_execution_profile: "sandbox_magic",
    },
    {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      token: "must-not-persist",
    },
    {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      credential_path: "/private/service-account.json",
    },
    {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      raw_event: { secret: "must-not-persist" },
    },
    {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      origin: "local",
    },
    {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      raw_evidence_archived: true,
    },
    {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      project_alias: "/private/project",
    },
    {
      provenance_status: "resolved",
      provenance_mode: "git_release_exact",
      commit: "abc123",
    },
    {
      provenance_status: "resolved",
      provenance_mode: "git_release_exact",
      provenance_explicit: true,
    },
    {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      provenance_explicit: false,
    },
    {
      provenance_status: "unavailable",
      provenance_explicit: true,
    },
    {
      provenance_status: "unavailable",
      requested_mode: "patch",
      requested_workflow: "strict",
      requested_execution_profile: "docker_strict",
    },
    {
      provenance_status: "unavailable",
      requested_mode: "patch",
      requested_workflow: "strict",
      requested_execution_profile: "docker_strict",
      preflight_abort: "capability_mismatch",
    },
    {
      provenance_status: "unavailable",
      requested_mode: "pr",
      requested_workflow: "strict",
      requested_execution_profile: "docker_strict",
    },
    {
      provenance_status: "unavailable",
      requested_mode: "pr",
      requested_workflow: "strict",
      requested_execution_profile: "docker_strict",
      preflight_abort: "provenance_unavailable",
    },
    {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      requested_mode: "pr",
      requested_workflow: "strict",
      requested_execution_profile: "docker_strict",
    },
    {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      requested_mode: "pr",
      requested_workflow: "strict",
      requested_execution_profile: "docker_strict",
      preflight_abort: "provenance_unavailable",
    },
    {
      provenance_status: "resolved",
      provenance_mode: "git_release_exact",
      requested_mode: "pr",
      requested_workflow: "strict",
      requested_execution_profile: "docker_strict",
      commit: "c".repeat(40),
      preflight_abort: "capability_mismatch",
    },
    {
      provenance_status: "unavailable",
      requested_mode: "analyze",
      requested_workflow: "strict",
      preflight_abort: "provenance_unavailable",
    },
    {
      provenance_status: "unavailable",
      requested_workflow: "strict",
    },
  ];
  for (const [index, extra] of invalidExtras.entries()) {
    await assert.rejects(
      createSession({ name: `invalid-${index}`, workspaceRoot: tmp, sourceLock: lock, extra }),
    );
  }
  await assert.rejects(
    createSession({
      name: "missing-source-lock",
      workspaceRoot: tmp,
      extra: { provenance_status: "unavailable" },
    }),
    /source_lock/,
  );

  for (const unsafeName of [
    "snapshot-no-crashfix-prefix",
    `crashfix-${"a".repeat(64)}`,
    "crashfix-private/fixture.json",
    "crashfix-private\\fixture.json",
    `crashfix-${"a".repeat(81)}`,
  ]) {
    await assert.rejects(
      createSessionRaw({
        name: unsafeName,
        workspaceRoot: tmp,
        sourceLock: lock,
        extra: {
          provenance_status: "unavailable",
          firebase_access: "service-account",
        },
      }),
      /CrashFix session name.*bounded safe alias/,
    );
  }
  const ordinary = await createSessionRaw({
    name: "ordinary session summary.json",
    workspaceRoot: tmp,
  });
  assert.equal((await loadMeta(ordinary.dir)).name, "ordinary session summary.json");
});

test("preflight-aborted CrashFix sessions cannot bind or archive remote evidence", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-preflight-evidence-gate-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));

  const stack = [
    "Normalized Crash Event",
    "Kind: java",
    "Exception Class: java.lang.IllegalStateException",
    "Frame 0: app.Main.run",
  ].join("\n");
  const identity = computeCanonicalAnalyzerIdentity(stack);
  const appBuild = {
    platform: "android" as const,
    app_id: "com.example.app",
    version: "1.0",
    build: "1",
  };
  const target = {
    project: "project",
    app: "app",
    issue: "issue",
    app_build: appBuild,
  };
  const crash = {
    signature: identity.fingerprint,
    signature_version: identity.signature_version,
    signature_degraded: false,
    cross_source_comparable: true,
    stack,
    kind: "java",
    repro_path: [],
    source: firebaseCrashSource(identity.fingerprint, {
      event: "event-preflight",
      app_build: appBuild,
    }, identity.signature_version),
    acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
  };
  const analysis = {
    schema_version: "crashfix-analysis/v1" as const,
    target_signature_version: identity.signature_version,
    target_fingerprint: identity.fingerprint,
    root_cause_summary: "预检已经中止，不能继续生成远端根因结论。",
    confidence: "low" as const,
    category: "other" as const,
    locations: [],
    remediation_summary: "保持中止状态并重新建立满足来源条件的会话。",
    limitations: ["没有读取远端崩溃详情。"],
  };

  async function assertAllRemoteWritesRejected(
    sessionDir: string,
    expected: RegExp,
  ): Promise<void> {
    await assert.rejects(recordCrashfixTarget(sessionDir, target), expected);
    await assert.rejects(recordCrashEvidence(sessionDir, crash), expected);
    await assert.rejects(recordCrashfixAnalysis(sessionDir, analysis), expected);
    assert.equal((await readCrashes(sessionDir)).length, 0);
    assert.equal((await loadMeta(sessionDir)).crashfix_analysis, undefined);
  }

  const correctlyAborted = await createSession({
    name: "preflight-correctly-aborted",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock(),
    extra: {
      provenance_status: "unavailable",
      requested_mode: "patch",
      requested_workflow: "strict",
      requested_execution_profile: "docker_strict",
      preflight_abort: "provenance_unavailable",
    },
  });
  await assertAllRemoteWritesRejected(correctlyAborted.dir, /forbidden after a preflight abort/);

  const missingAbortMeta = await loadMeta(correctlyAborted.dir);
  delete missingAbortMeta.extra?.preflight_abort;
  await writeMeta(correctlyAborted.dir, missingAbortMeta);
  await assertAllRemoteWritesRejected(
    correctlyAborted.dir,
    /requires preflight_abort=provenance_unavailable/,
  );

  const wrongPrAbort = await createSession({
    name: "preflight-wrong-pr-abort",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock(),
    extra: {
      provenance_status: "unavailable",
      requested_mode: "pr",
      requested_workflow: "strict",
      requested_execution_profile: "docker_strict",
      preflight_abort: "capability_mismatch",
    },
  });
  const wrongPrMeta = await loadMeta(wrongPrAbort.dir);
  wrongPrMeta.extra!.preflight_abort = "provenance_unavailable";
  await writeMeta(wrongPrAbort.dir, wrongPrMeta);
  await assertAllRemoteWritesRejected(
    wrongPrAbort.dir,
    /requires preflight_abort=capability_mismatch/,
  );
});

test("CrashFix firebase_access is required only for the official Firebase route", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-firebase-access-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));

  for (const firebaseAccess of ["service-account", "firebaserc"] as const) {
    const session = await createSessionRaw({
      name: `crashfix-official-${firebaseAccess}`,
      workspaceRoot: tmp,
      sourceLock: firebaseSourceLock("official_firebase_mcp"),
      extra: {
        provenance_status: "unavailable",
        firebase_access: firebaseAccess,
      },
    });
    assert.equal((await loadMeta(session.dir)).extra?.firebase_access, firebaseAccess);
  }

  await assert.rejects(
    createSessionRaw({
      name: "crashfix-official-missing-access",
      workspaceRoot: tmp,
      sourceLock: firebaseSourceLock("official_firebase_mcp"),
      extra: { provenance_status: "unavailable" },
    }),
    /require extra\.firebase_access/i,
  );
  await assert.rejects(
    createSessionRaw({
      name: "unscoped-firebase-access",
      workspaceRoot: tmp,
      sourceLock: firebaseSourceLock("official_firebase_mcp"),
      extra: { firebase_access: "service-account" },
    }),
    /require provenance_status/i,
  );
  for (const firebaseAccess of ["", "service_account", "cloud-logging"]) {
    await assert.rejects(
      createSessionRaw({
        name: `crashfix-official-invalid-access-${firebaseAccess || "empty"}`,
        workspaceRoot: tmp,
        sourceLock: firebaseSourceLock("official_firebase_mcp"),
        extra: {
          provenance_status: "unavailable",
          firebase_access: firebaseAccess,
        },
      }),
      /must be service-account or firebaserc/i,
    );
  }

  const cloudSession = await createSessionRaw({
    name: "crashfix-cloud-without-firebase-access",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock("cloud_logging_mcp"),
    extra: { provenance_status: "unavailable" },
  });
  assert.equal((await loadMeta(cloudSession.dir)).extra?.firebase_access, undefined);
  for (const firebaseAccess of ["service-account", "firebaserc"] as const) {
    await assert.rejects(
      createSessionRaw({
        name: `crashfix-cloud-rejects-${firebaseAccess}`,
        workspaceRoot: tmp,
        sourceLock: firebaseSourceLock("cloud_logging_mcp"),
        extra: {
          provenance_status: "unavailable",
          firebase_access: firebaseAccess,
        },
      }),
      /cloud_logging_mcp.*must omit.*firebase_access/i,
    );
  }
});

test("CrashFix firebase_access remains enforced after session creation", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-firebase-access-recheck-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));

  const targetSession = await createSessionRaw({
    name: "crashfix-tampered-before-target",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock("official_firebase_mcp"),
    extra: {
      provenance_status: "unavailable",
      firebase_access: "service-account",
    },
  });
  const targetMeta = await loadMeta(targetSession.dir);
  targetMeta.extra = { ...targetMeta.extra, firebase_access: "service_account" };
  await writeMeta(targetSession.dir, targetMeta);
  await assert.rejects(
    recordCrashfixTarget(targetSession.dir, {
      project: "project",
      app: "app",
      issue: "issue",
      app_build: {
        platform: "android",
        app_id: "com.example.app",
        version: "1.0",
        build: "1",
      },
    }),
    /firebase_access must be service-account or firebaserc/i,
  );

  const evidenceSession = await createSessionRaw({
    name: "crashfix-tampered-before-evidence",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock("official_firebase_mcp"),
    extra: {
      provenance_status: "unavailable",
      firebase_access: "service-account",
    },
  });
  const appBuild = {
    platform: "android" as const,
    app_id: "com.example.app",
    version: "1.0",
    build: "1",
  };
  await recordCrashfixTarget(evidenceSession.dir, {
    project: "project",
    app: "app",
    issue: "issue",
    app_build: appBuild,
  });
  const evidenceMeta = await loadMeta(evidenceSession.dir);
  evidenceMeta.extra = { ...evidenceMeta.extra, firebase_access: "service_account" };
  await writeMeta(evidenceSession.dir, evidenceMeta);
  const stack = [
    "Normalized Crash Event",
    "Kind: java",
    "Exception Class: java.lang.IllegalStateException",
    "Frame 0: com.example.App.run",
  ].join("\n");
  const identity = computeCanonicalAnalyzerIdentity(stack);
  await assert.rejects(
    recordCrashEvidence(evidenceSession.dir, {
      signature: identity.fingerprint,
      signature_version: identity.signature_version,
      signature_degraded: false,
      cross_source_comparable: true,
      kind: "java",
      stack,
      repro_path: [],
      source: firebaseCrashSource(identity.fingerprint, {
        project: "project",
        app: "app",
        issue: "issue",
        event: "event",
        app_build: appBuild,
      }, identity.signature_version),
      acquisition_route: "official_firebase_mcp",
    }),
    /firebase_access must be service-account or firebaserc/i,
  );

  const finalizeSessionWithMissingAccess = await createSessionRaw({
    name: "crashfix-tampered-before-finalize",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock("official_firebase_mcp"),
    extra: {
      provenance_status: "unavailable",
      firebase_access: "firebaserc",
    },
  });
  const finalizeMeta = await loadMeta(finalizeSessionWithMissingAccess.dir);
  const { firebase_access: _removed, ...extraWithoutAccess } = finalizeMeta.extra ?? {};
  finalizeMeta.extra = extraWithoutAccess;
  await writeMeta(finalizeSessionWithMissingAccess.dir, finalizeMeta);
  await assert.rejects(
    finalizeSession(
      finalizeSessionWithMissingAccess.dir,
      "aborted",
      async () => undefined,
    ),
    /require extra\.firebase_access/i,
  );
  assert.equal((await loadMeta(finalizeSessionWithMissingAccess.dir)).status, "running");
});

test("CrashFix target binding precedes evidence and locks app, issue, and build", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-crashfix-target-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const session = await createSession({
    name: "target-lock",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock(),
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      requested_mode: "analyze",
      requested_execution_profile: "local_trusted",
    },
  });
  const target = {
    project: "selected-project",
    app: "selected-app",
    issue: "selected-issue",
    app_build: {
      platform: "android" as const,
      app_id: "com.example.selected",
      version: "1.2.3",
      build: "42",
    },
  };
  const stack = [
    "Normalized Crash Event",
    "Kind: java",
    "Exception Class: java.lang.IllegalStateException",
    "Frame 0: app.Main.run",
  ].join("\n");
  const identity = computeCanonicalAnalyzerIdentity(stack);
  const source = firebaseCrashSource(identity.fingerprint, {
    ...target,
    event: "event-1",
  }, identity.signature_version);
  const evidence = {
    signature: identity.fingerprint,
    signature_version: identity.signature_version,
    signature_degraded: false,
    cross_source_comparable: true,
    stack,
    kind: "java" as const,
    repro_path: [] as number[],
    source,
    acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
  };

  await assert.rejects(
    recordCrashEvidence(session.dir, evidence),
    /target binding before crash evidence/,
  );
  const bound = await recordCrashfixTarget(session.dir, target);
  assert.equal(bound.deduplicated, false);
  assert.match(bound.target_ref_sha256_prefix, /^[a-f0-9]{12}$/);
  assert.doesNotMatch(JSON.stringify(bound), /selected-project|selected-app|selected-issue/);
  assert.deepEqual(await recordCrashfixTarget(session.dir, target), {
    ...bound,
    deduplicated: true,
  });
  await assert.rejects(
    recordCrashfixTarget(session.dir, {
      ...target,
      app_build: { ...target.app_build, build: "43" },
    }),
    /already bound to a different identity/,
  );
  await assert.rejects(
    recordCrashEvidence(session.dir, {
      ...evidence,
      source: firebaseCrashSource(identity.fingerprint, {
        ...target,
        issue: "different-issue",
        event: "event-2",
      }, identity.signature_version),
    }),
    /does not match the bound CrashFix target/,
  );
  const { signature_degraded: _degraded, ...withoutDegraded } = evidence;
  await assert.rejects(
    recordCrashEvidence(session.dir, withoutDegraded),
    /requires signature_degraded/,
  );
  const recorded = await recordCrashEvidence(session.dir, evidence);
  assert.equal(recorded.deduplicated, false);
  assert.equal(recorded.crash.signature_degraded, false);
  assert.equal(recorded.crash.cross_source_comparable, true);
  await assert.rejects(
    recordCrashEvidence(session.dir, { ...evidence, signature_degraded: true }),
    /already archived with different crash evidence/,
  );
  assert.equal((await recordCrashfixTarget(session.dir, target)).deduplicated, true);

  const persisted = JSON.stringify(await loadMeta(session.dir));
  assert.doesNotMatch(persisted, /selected-project|selected-app|selected-issue|com\.example\.selected/);
});

test("CrashFix rejects Firebase ids reused as public session aliases", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-crashfix-alias-privacy-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const appBuild = {
    platform: "android" as const,
    app_id: "com.example.aliasprivacy",
    version: "1.0",
    build: "1",
  };
  const target = {
    project: "abc123",
    app: "firebase-app-private",
    issue: "issue-private-123",
    app_build: appBuild,
  };
  const baseExtra = {
    provenance_status: "unavailable" as const,
    requested_mode: "analyze" as const,
    requested_workflow: "strict" as const,
    requested_execution_profile: "local_trusted" as const,
    workspace_project_classification: "test" as const,
    firebase_access: "service-account" as const,
  };

  const nameLeak = await createSessionRaw({
    name: "crashfix-abc123",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock(),
    extra: baseExtra,
  });
  await assert.rejects(
    recordCrashfixTarget(nameLeak.dir, target),
    /public session aliases must not repeat Firebase target or event identifiers/,
  );

  const aliasLeak = await createSessionRaw({
    name: "crashfix-safe-alias",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock(),
    extra: { ...baseExtra, project_alias: target.project },
  });
  await assert.rejects(
    recordCrashfixTarget(aliasLeak.dir, target),
    /public session aliases must not repeat Firebase target or event identifiers/,
  );

  const eventId = "event-private-456";
  const eventLeak = await createSessionRaw({
    name: `crashfix-${eventId}`,
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock(),
    extra: baseExtra,
  });
  await recordCrashfixTarget(eventLeak.dir, target);
  const stack = [
    "Normalized Crash Event",
    "Kind: java",
    "Exception Class: java.lang.IllegalStateException",
    "Frame 0: app.Main.run",
  ].join("\n");
  const identity = computeCanonicalAnalyzerIdentity(stack);
  await assert.rejects(
    recordCrashEvidence(eventLeak.dir, {
      signature: identity.fingerprint,
      signature_version: identity.signature_version,
      signature_degraded: false,
      cross_source_comparable: true,
      stack,
      kind: "java",
      repro_path: [],
      source: firebaseCrashSource(identity.fingerprint, {
        ...target,
        event: eventId,
      }, identity.signature_version),
      acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
    }),
    /public session aliases must not repeat Firebase target or event identifiers/,
  );
});

test("public Firebase id scan catches bounded short-token embeddings but ignores fixed keys", () => {
  const meta: SessionMeta = {
    id: "safe-session",
    name: "safe-session",
    started_at: new Date().toISOString(),
    status: "running",
  };
  const crashForProject = (project: string): CrashRecord => ({
    id: "c1",
    ts: new Date().toISOString(),
    signature: "0123456789ab",
    signature_version: JAVA_SIGNATURE_VERSION,
    kind: "java",
    stack_path: "crashes/c1.stack.txt",
    repro_path: [],
    source: firebaseCrashSource("0123456789ab", {
      project,
      app: "private-application",
      issue: "private-issue-value",
      event: "private-event-value",
    }),
  });

  for (const identifier of ["a", "id", "abcde"]) {
    assert.throws(
      () => assertCrashfixPublicProjectionOmitsSourceIdentifiers(
        meta,
        [crashForProject(identifier)],
        { summary: `prefix ${identifier} suffix` },
      ),
      /must not repeat Firebase target or event identifiers/,
    );
    assert.throws(
      () => assertCrashfixPublicProjectionOmitsSourceIdentifiers(
        meta,
        [crashForProject(identifier)],
        { summary: `项目${identifier}发生故障` },
      ),
      /must not repeat Firebase target or event identifiers/,
    );
  }

  const shortIdCrash = crashForProject("id");
  assert.doesNotThrow(() =>
    assertCrashfixPublicProjectionOmitsSourceIdentifiers(
      meta,
      [shortIdCrash],
      { id: "safe-public-value" },
    )
  );
  assert.doesNotThrow(() =>
    assertCrashfixPublicProjectionOmitsSourceIdentifiers(
      meta,
      [shortIdCrash],
      { summary: "candidate remains valid" },
    )
  );
});

test("public Firebase id scan accepts the maximum step and crash projection shape", () => {
  const signature = "0123456789ab";
  const crashes: CrashRecord[] = Array.from(
    { length: MAX_CRASHES_PER_SESSION },
    (_, index) => ({
      id: `c${index + 1}`,
      ts: "2026-08-11T00:00:00Z",
      signature,
      signature_version: JAVA_SIGNATURE_VERSION,
      kind: "java",
      stack_path: `crashes/c${index + 1}.stack.txt`,
      repro_path: [],
      source: firebaseCrashSource(signature, {
        project: "private-project-root",
        app: "private-application-root",
        issue: "private-issue-root",
        event: `private-event-${index + 1}`,
      }),
    }),
  );
  const projection = {
    meta: {
      id: "safe-session",
      name: "safe-session",
      status: "running",
    },
    steps: Array.from({ length: MAX_STEPS_PER_SESSION }, (_, index) => ({
      index: index + 1,
      ts: "2026-08-11T00:00:00Z",
      action: `safe-action-${index + 1}`,
      result: "ok",
    })),
    crashes: crashes.map((crash) => ({
      id: crash.id,
      ts: crash.ts,
      signature: crash.signature,
      signature_version: crash.signature_version,
      kind: crash.kind,
      stack_path: crash.stack_path,
      repro_path: crash.repro_path,
      source: {
        provider: "firebase-crashlytics",
        external_key_ref: `sha256:${createHash("sha256")
          .update(crash.source!.external_key, "utf8")
          .digest("hex")
          .slice(0, 10)}`,
      },
    })),
  };

  assert.doesNotThrow(() =>
    assertCrashfixPublicProjectionOmitsSourceIdentifiers(
      {
        id: "safe-session",
        name: "safe-session",
        started_at: "2026-08-11T00:00:00Z",
        status: "running",
      },
      crashes,
      projection,
    )
  );
});

test("renderers scan Firebase ids even when CrashFix provenance metadata is missing", () => {
  const privateProject = "private-project-render-leak";
  const crash: CrashRecord = {
    id: "c1",
    ts: "2026-08-11T00:00:00Z",
    signature: "0123456789ab",
    signature_version: JAVA_SIGNATURE_VERSION,
    kind: "java",
    stack_path: "crashes/c1.stack.txt",
    repro_path: [],
    source: firebaseCrashSource("0123456789ab", {
      project: privateProject,
      app: "private-application-render",
      issue: "private-issue-render",
      event: "private-event-render",
    }),
  };
  const malformedMeta: SessionMeta = {
    id: "safe-session",
    name: privateProject,
    started_at: "2026-08-11T00:00:00Z",
    status: "running",
  };

  for (const render of [renderMarkdown, renderHtml]) {
    assert.throws(
      () => render({ meta: malformedMeta, steps: [], crashes: [crash] }),
      /must not repeat Firebase target or event identifiers/,
    );
    assert.throws(
      () => render({
        meta: { ...malformedMeta, name: "safe-session" },
        steps: [],
        crashes: [crash],
        summary: `summary repeats ${privateProject}`,
      }),
      /must not repeat Firebase target or event identifiers/,
    );
  }
});

test("recordCrashfixAnalysis binds one immutable analysis and renders localized safe sections", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-crashfix-analysis-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const session = await createSession({
    name: "analysis-bind",
    workspaceRoot: tmp,
    reportLanguage: "zh-CN",
    sourceLock: firebaseSourceLock(),
    extra: {
      provenance_status: "resolved",
      provenance_mode: "git_release_exact",
      requested_mode: "analyze",
      requested_workflow: "strict",
      requested_execution_profile: "local_trusted",
      commit: "a".repeat(40),
    },
  });
  const appBuild = {
    platform: "android" as const,
    app_id: "com.example.analysis",
    version: "1.0",
    build: "9",
  };
  const stack = [
    "Normalized Crash Event",
    "Kind: java",
    "Exception Class: java.lang.NullPointerException",
    "Frame 0: app.Main.run",
    "Frame 1: app.Main.dispatch",
    "Frame 2: app.Main.resume",
    "Frame 3: framework.Dispatcher.loop",
  ].join("\n");
  const identity = computeCanonicalAnalyzerIdentity(stack);
  const target = {
    project: "analysis-project-123",
    app: "analysis-app-123",
    issue: "analysis-issue-123",
    app_build: appBuild,
  };
  await recordCrashfixTarget(session.dir, target);
  const recordedCrash = await recordCrashEvidence(session.dir, {
    signature: identity.fingerprint,
    signature_version: identity.signature_version,
    signature_degraded: false,
    cross_source_comparable: true,
    stack,
    kind: "java",
    repro_path: [],
    source: firebaseCrashSource(identity.fingerprint, {
      ...target,
      event: "analysis-event-123",
    }, identity.signature_version),
    acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
  });
  const analysis = crashfixAnalysisSchema.parse({
    schema_version: "crashfix-analysis/v1",
    target_signature_version: identity.signature_version,
    target_fingerprint: identity.fingerprint,
    root_cause_summary: "空对象 *值* 被 <b>提前访问</b>。",
    confidence: "high",
    category: "null_dereference",
    locations: [
      {
        path: "app/src/main/java/example/Main.kt",
        line: 42,
        symbol: "example.Main.run",
      },
    ],
    remediation_summary: "在 [入口] 增加状态校验，并保证初始化先完成。",
    limitations: ["尚未执行候选构建与真机验证。"],
  });

  const first = await recordCrashfixAnalysis(session.dir, analysis);
  assert.deepEqual(first, {
    deduplicated: false,
    analysis_recorded: true,
    schema_version: "crashfix-analysis/v1",
    target_signature_version: identity.signature_version,
    target_fingerprint: identity.fingerprint,
    confidence: "high",
    category: "null_dereference",
    location_count: 1,
    limitation_count: 1,
  });
  assert.equal((await recordCrashfixAnalysis(session.dir, analysis)).deduplicated, true);
  await assert.rejects(
    recordCrashfixAnalysis(session.dir, { ...analysis, confidence: "medium" }),
    /already bound to different content/,
  );

  const persisted = await loadMeta(session.dir);
  const {
    evidence_set_sha256: evidenceSetSha256,
    ...persistedAnalysis
  } = persisted.crashfix_analysis!;
  assert.match(evidenceSetSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(persistedAnalysis, analysis);
  assert.equal(persisted.extra?.crashfix_analysis, undefined);
  await assertStoredCrashfixAnalysis(session.dir, persisted);
  const crashes = await readCrashes(session.dir);
  const markdown = renderMarkdown({ meta: persisted, steps: [], crashes });
  const html = renderHtml({ meta: persisted, steps: [], crashes });
  assert.match(markdown, /根因分析/);
  assert.match(markdown, /修复状态/);
  assert.match(markdown, /尚未生成候选/);
  assert.match(markdown, /尚未完成 3\/3 严格验证/);
  assert.match(markdown, /尚未导出候选/);
  assert.match(markdown, /修复建议/);
  assert.match(markdown, /限制/);
  assert.match(markdown, /`null_dereference`/);
  assert.match(markdown, /app\/src\/main\/java\/example\/Main\.kt:42/);
  assert.doesNotMatch(markdown, new RegExp(evidenceSetSha256));
  assert.doesNotMatch(markdown, /<b>提前访问<\/b>/);
  assert.match(markdown, /&lt;b&gt;提前访问&lt;\/b&gt;/);
  assert.match(html, /根因分析/);
  assert.match(html, /修复状态/);
  assert.match(html, /尚未生成候选/);
  assert.doesNotMatch(html, new RegExp(evidenceSetSha256));
  assert.doesNotMatch(html, /<b>提前访问<\/b>/);
  assert.match(html, /&lt;b&gt;提前访问&lt;\/b&gt;/);

  const englishMeta = { ...persisted, report_language: "en-US" as const };
  const englishMarkdown = renderMarkdown({ meta: englishMeta, steps: [], crashes });
  const englishHtml = renderHtml({ meta: englishMeta, steps: [], crashes });
  assert.match(englishMarkdown, /Root cause analysis/);
  assert.match(englishMarkdown, /Repair status/);
  assert.match(englishMarkdown, /No candidate prepared/);
  assert.match(englishMarkdown, /Remediation/);
  assert.match(englishHtml, /Root cause analysis/);
  assert.match(englishHtml, /Repair status/);
  assert.match(englishHtml, /Limitations/);

  await assert.rejects(
    recordCrashEvidence(session.dir, {
      signature: identity.fingerprint,
      signature_version: identity.signature_version,
      signature_degraded: false,
      cross_source_comparable: true,
      stack,
      kind: "java",
      repro_path: [],
      source: firebaseCrashSource(identity.fingerprint, {
        ...target,
        event: "analysis-event-456",
      }, identity.signature_version),
      acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
    }),
    /analysis is already bound; new crash evidence would change its evidence set/,
  );
  assert.equal((await readCrashes(session.dir)).length, 1);

  const mismatchedMeta = {
    ...persisted,
    crashfix_analysis: {
      ...persisted.crashfix_analysis!,
      target_fingerprint: "f".repeat(12),
    },
  };
  assert.throws(
    () => assertCrashfixAnalysisForReport(mismatchedMeta, crashes),
    /does not match every archived analyzer identity/,
  );
  await writeMeta(session.dir, mismatchedMeta);
  await assert.rejects(
    finalizeSession(session.dir, "aborted", async () => undefined),
    /analysis identity does not match the archived analyzer identity|does not match every archived analyzer identity/,
  );
  assert.equal((await loadMeta(session.dir)).status, "running");
  await writeMeta(session.dir, persisted);

  const stackPath = path.join(session.dir, recordedCrash.crash.stack_path);
  await writeFile(stackPath, stack.replace("app.Main.run", "app.Other.run"), "utf8");
  await assert.rejects(
    assertStoredCrashfixAnalysis(session.dir, persisted),
    /canonical analyzer identity|fingerprint/i,
  );
  await writeFile(stackPath, stack, "utf8");
  await assertStoredCrashfixAnalysis(session.dir, persisted);
  await writeFile(
    stackPath,
    stack.replace("framework.Dispatcher.loop", "framework.Dispatcher.next"),
    "utf8",
  );
  await assert.rejects(
    assertStoredCrashfixAnalysis(session.dir, persisted),
    /analysis evidence set does not match/,
  );
  await writeFile(stackPath, stack, "utf8");
});

test("CrashFix analysis schema rejects unsafe prose and non-canonical locations", () => {
  const base = {
    schema_version: "crashfix-analysis/v1" as const,
    target_signature_version: JAVA_SIGNATURE_VERSION,
    target_fingerprint: "a".repeat(12),
    root_cause_summary: "空值在状态恢复前被访问。",
    confidence: "high" as const,
    category: "lifecycle" as const,
    locations: [{ path: "app/src/Main.kt", line: 12, symbol: "app.Main.run" }],
    remediation_summary: "先恢复状态，再读取对应对象。",
    limitations: ["尚未完成动态验证。"],
  };
  for (const unsafeText of [
    "详情位于 https://private.example/path",
    "详情位于 /Users/private/source/Main.kt",
    `token=${"x".repeat(24)}`,
    "联系 private@example.com 获取信息",
    `完整摘要为 ${"b".repeat(64)}`,
    "包含\n换行",
  ]) {
    assert.throws(
      () => crashfixAnalysisSchema.parse({ ...base, root_cause_summary: unsafeText }),
      /URLs|absolute paths|credential-like|personal identifiers|SHA-256|control characters/i,
    );
  }
  for (const locations of [
    [{ path: "../Main.kt" }],
    [{ path: "/private/Main.kt" }],
    [{ path: "secrets/Token.kt" }],
    [{ path: "docs/README.md" }],
    [{ path: "z/Z.kt" }, { path: "a/A.kt" }],
    [{ path: "app/Main.kt" }, { path: "app/Main.kt" }],
  ]) {
    assert.throws(
      () => crashfixAnalysisSchema.parse({ ...base, locations }),
      /relative path|credential-like|source extension|canonical bytewise order|unique/i,
    );
  }
  assert.throws(
    () => crashfixAnalysisSchema.parse({ ...base, limitations: Array(6).fill("不同限制") }),
    /at most 5|unique/i,
  );
});

test("CrashFix analysis enforces session state, evidence identity, provenance, and source privacy", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-crashfix-analysis-gates-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const stack = [
    "Normalized Crash Event",
    "Kind: java",
    "Exception Class: java.lang.IllegalStateException",
    "Frame 0: app.Main.run",
  ].join("\n");
  const identity = computeCanonicalAnalyzerIdentity(stack);
  const safeAnalysis = crashfixAnalysisSchema.parse({
    schema_version: "crashfix-analysis/v1",
    target_signature_version: identity.signature_version,
    target_fingerprint: identity.fingerprint,
    root_cause_summary: "状态恢复顺序与回调执行顺序冲突。",
    confidence: "medium",
    category: "lifecycle",
    locations: [],
    remediation_summary: "调整状态恢复顺序，并增加空值保护。",
    limitations: [],
  });

  const ordinary = await createSession({ name: "analysis-ordinary", workspaceRoot: tmp });
  await assert.rejects(
    recordCrashfixAnalysis(ordinary.dir, safeAnalysis),
    /requires a CrashFix session/,
  );

  const quick = await createSessionRaw({
    name: "crashfix-analysis-quick",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock(),
    extra: {
      provenance_status: "unavailable",
      requested_mode: "analyze",
      requested_workflow: "quick_test",
      requested_execution_profile: "local_trusted",
      workspace_project_classification: "test",
      firebase_access: "service-account",
    },
  });
  await assert.rejects(
    recordCrashfixAnalysis(quick.dir, safeAnalysis),
    /target binding before crash evidence|target binding/,
  );
  const appBuild = {
    platform: "android" as const,
    app_id: "com.example.quick",
    version: "1.0",
    build: "1",
  };
  const target = {
    project: "abc123",
    app: "private-app-123",
    issue: "private-issue-123",
    app_build: appBuild,
  };
  await recordCrashfixTarget(quick.dir, target);
  await assert.rejects(
    recordCrashfixAnalysis(quick.dir, safeAnalysis),
    /archived Firebase crash evidence first/,
  );
  await recordCrashEvidence(quick.dir, {
    signature: identity.fingerprint,
    signature_version: identity.signature_version,
    signature_degraded: false,
    cross_source_comparable: true,
    stack,
    kind: "java",
    repro_path: [],
    source: firebaseCrashSource(identity.fingerprint, {
      ...target,
      event: "private-event-123",
    }, identity.signature_version),
    acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
  });
  await assert.rejects(
    finalizeSession(quick.dir, "passed", async () => undefined),
    /requires a bound analysis before passed finalize/,
  );
  assert.equal((await loadMeta(quick.dir)).status, "running");
  await assert.rejects(
    recordCrashfixAnalysis(quick.dir, {
      ...safeAnalysis,
      locations: [{ path: "app/src/Main.kt" }],
    }),
    /unavailable CrashFix provenance requires empty analysis locations/,
  );
  await assert.rejects(
    recordCrashfixAnalysis(quick.dir, {
      ...safeAnalysis,
      root_cause_summary: "abc123 的状态恢复顺序发生冲突。",
    }),
    /must not repeat Firebase target or event identifiers/,
  );
  await assert.rejects(
    recordCrashfixAnalysis(quick.dir, {
      ...safeAnalysis,
      target_fingerprint: "f".repeat(12),
    }),
    /does not match the archived analyzer identity/,
  );
  await recordCrashfixAnalysis(quick.dir, safeAnalysis);
  await finalizeSession(quick.dir, "aborted", async () => undefined);
  await assert.rejects(
    recordCrashfixAnalysis(quick.dir, safeAnalysis),
    /session is not running/,
  );
});

test("recordSnapshotProvenance atomically binds once and returns only safe prefixes", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-snapshot-bind-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const session = await createSession({
    name: "snapshot-bind",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock(),
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      requested_mode: "patch",
      requested_execution_profile: "local_trusted",
    },
  });
  const provenance = snapshotProvenanceFixture({
    manifest_sha256: "1".repeat(64),
    exclusion_policy_sha256: "2".repeat(64),
    dynamic_exclusions_sha256: "3".repeat(64),
    approved_test_fixtures_sha256: "4".repeat(64),
    approved_test_fixture_count: 8,
    files: 20_000,
    directories: 10_000,
    bytes: 256 * 1024 * 1024,
  });

  assert.throws(
    () => snapshotProvenanceSchema.parse({ ...provenance, source_path: "/private/source" }),
    /unrecognized|key/i,
  );
  for (const forbiddenField of [
    "approved_test_fixture_paths",
    "approved_test_fixture_entries",
    "approved_test_fixture_content",
  ]) {
    assert.throws(
      () => snapshotProvenanceSchema.parse({
        ...provenance,
        [forbiddenField]: "must-not-persist",
      }),
      /unrecognized|key/i,
    );
  }
  const first = await recordSnapshotProvenance(session.dir, provenance);
  assert.deepEqual(first, {
    deduplicated: false,
    source_snapshot_sha256_prefix: provenance.source_snapshot_sha256.slice(0, 12),
    exclusion_policy_sha256_prefix: "2".repeat(12),
    dynamic_exclusions_sha256_prefix: "3".repeat(12),
    approved_test_fixtures_sha256_prefix: "4".repeat(12),
    approved_test_fixture_count: 8,
    files: 20_000,
    directories: 10_000,
    bytes: 256 * 1024 * 1024,
  });
  assert.doesNotMatch(
    JSON.stringify(first),
    new RegExp([
      provenance.manifest_sha256,
      provenance.source_snapshot_sha256,
      provenance.exclusion_policy_sha256,
      provenance.dynamic_exclusions_sha256,
      provenance.approved_test_fixtures_sha256,
      "private",
    ].join("|")),
  );
  assert.deepEqual(await recordSnapshotProvenance(session.dir, provenance), {
    ...first,
    deduplicated: true,
  });

  const afterCandidate = await loadMeta(session.dir);
  afterCandidate.extra = {
    ...afterCandidate.extra,
    canonical_diff_sha256: "c".repeat(64),
    candidate_manifest_sha256: "d".repeat(64),
    destination_ref_sha256: "e".repeat(64),
    artifact_sha256: "f".repeat(64),
    build_environment_sha256: "0".repeat(64),
    diff_sha256: "9".repeat(64),
    changed_files: ["src/Main.kt"],
  };
  await writeMeta(session.dir, afterCandidate);
  assert.deepEqual(await recordSnapshotProvenance(session.dir, provenance), {
    ...first,
    deduplicated: true,
  });

  const persisted = await loadMeta(session.dir);
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(provenance).map((key) => [key, persisted.extra?.[key]]),
    ),
    provenance,
  );
  await assert.rejects(
    recordSnapshotProvenance(session.dir, {
      ...provenance,
      source_snapshot_sha256: "4".repeat(64),
    }),
    /canonical v2 snapshot identity/,
  );
  await assert.rejects(
    recordSnapshotProvenance(session.dir, snapshotProvenanceFixture({
      ...provenance,
      approved_test_fixtures_sha256: "5".repeat(64),
    })),
    /different identity/,
  );
  await assert.rejects(
    recordSnapshotProvenance(session.dir, snapshotProvenanceFixture({
      ...provenance,
      approved_test_fixture_count: 7,
    })),
    /different identity/,
  );
  assert.equal(
    (await loadMeta(session.dir)).extra?.source_snapshot_sha256,
    provenance.source_snapshot_sha256,
  );
});

test("snapshotProvenanceSchema rejects malformed hashes and out-of-budget counts", () => {
  const valid = snapshotProvenanceFixture({
    manifest_sha256: "a".repeat(64),
    exclusion_policy_sha256: "b".repeat(64),
    dynamic_exclusions_sha256: "c".repeat(64),
    approved_test_fixtures_sha256: EMPTY_APPROVED_TEST_FIXTURES_SHA256,
    approved_test_fixture_count: 0,
    files: 1,
    directories: 1,
    bytes: 1,
  });
  for (const requiredKey of Object.keys(valid)) {
    const missing = { ...valid } as Record<string, unknown>;
    delete missing[requiredKey];
    assert.throws(() => snapshotProvenanceSchema.parse(missing));
  }
  assert.equal(
    snapshotProvenanceSchema.parse(valid).approved_test_fixture_count,
    0,
  );
  assert.equal(
    snapshotProvenanceSchema.parse(snapshotProvenanceFixture({
      ...valid,
      approved_test_fixtures_sha256: "d".repeat(64),
      approved_test_fixture_count: 8,
    })).approved_test_fixture_count,
    8,
  );
  assert.throws(() => snapshotProvenanceSchema.parse({
    ...valid,
    approved_test_fixtures_sha256: "d".repeat(64),
  }), /canonical empty-set digest/u);
  assert.throws(() => snapshotProvenanceSchema.parse({
    ...valid,
    approved_test_fixture_count: 1,
  }), /canonical empty-set digest/u);
  for (const badHash of [
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    `/${"a".repeat(63)}`,
    "C:\\private\\snapshot",
  ]) {
    for (const key of [
      "manifest_sha256",
      "source_snapshot_sha256",
      "exclusion_policy_sha256",
      "dynamic_exclusions_sha256",
      "approved_test_fixtures_sha256",
    ] as const) {
      assert.throws(() => snapshotProvenanceSchema.parse({ ...valid, [key]: badHash }));
    }
  }
  for (const [key, badValues] of [
    ["files", [0, -1, 1.5, 20_001]],
    ["directories", [0, -1, 1.5, 10_001]],
    ["bytes", [0, -1, 1.5, 256 * 1024 * 1024 + 1]],
    ["approved_test_fixture_count", [-1, 1.5, 9]],
  ] as const) {
    for (const value of badValues) {
      assert.throws(() => snapshotProvenanceSchema.parse({ ...valid, [key]: value }));
    }
  }
});

test("snapshot fixture provenance binds manifest, context, count, profile, and test classification", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-snapshot-fixture-controls-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const lock = firebaseSourceLock();
  const withFixtures = snapshotProvenanceFixture({
    manifest_sha256: "1".repeat(64),
    exclusion_policy_sha256: "2".repeat(64),
    dynamic_exclusions_sha256: "3".repeat(64),
    approved_test_fixtures_sha256: "4".repeat(64),
    approved_test_fixture_count: 2,
    files: 2,
    directories: 1,
    bytes: 10,
  });

  assert.throws(
    () => snapshotProvenanceSchema.parse({
      ...withFixtures,
      manifest_sha256: "5".repeat(64),
    }),
    /canonical v2 snapshot identity/,
  );
  assert.throws(
    () => snapshotProvenanceSchema.parse({
      ...withFixtures,
      approved_test_fixture_count: 3,
    }),
    /canonical v2 snapshot identity/,
  );
  const wrongContextSource = createHash("sha256")
    .update("crashfix-workspace-source-snapshot/v2\0", "utf8")
    .update(withFixtures.manifest_sha256, "utf8").update("\0", "utf8")
    .update(withFixtures.exclusion_policy_sha256, "utf8").update("\0", "utf8")
    .update(withFixtures.dynamic_exclusions_sha256, "utf8").update("\0", "utf8")
    .update(withFixtures.approved_test_fixtures_sha256, "utf8").update("\0", "utf8")
    .update(JSON.stringify({
      schema_version: "crashfix-test-fixture-context/v1",
      enabled: true,
      execution_profile: "docker_strict",
      project_classification: "test",
    }), "utf8").update("\0", "utf8")
    .update(String(withFixtures.approved_test_fixture_count), "utf8")
    .update("\0", "utf8")
    .digest("hex");
  assert.throws(
    () => snapshotProvenanceSchema.parse({
      ...withFixtures,
      source_snapshot_sha256: wrongContextSource,
    }),
    /canonical v2 snapshot identity/,
  );

  const startSnapshotSession = (
    name: string,
    controls: Record<string, unknown>,
  ) => createSessionRaw({
    name: name.startsWith("crashfix-") ? name : `crashfix-${name}`,
    workspaceRoot: tmp,
    sourceLock: lock,
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      firebase_access: "service-account",
      ...controls,
    },
  });

  const dockerWithFixtures = await startSnapshotSession("docker-with-fixtures", {
    requested_mode: "patch",
    requested_execution_profile: "docker_strict",
    workspace_project_classification: "test",
  });
  await assert.rejects(
    recordSnapshotProvenance(dockerWithFixtures.dir, withFixtures),
    /requested_execution_profile=local_trusted/,
  );

  const missingProfile = await startSnapshotSession("missing-fixture-profile", {
    requested_mode: "analyze",
    workspace_project_classification: "test",
  });
  await assert.rejects(
    recordSnapshotProvenance(missingProfile.dir, withFixtures),
    /requested_execution_profile=local_trusted/,
  );

  const missingClassification = await startSnapshotSession("missing-fixture-classification", {
    requested_mode: "patch",
    requested_execution_profile: "local_trusted",
  });
  await assert.rejects(
    recordSnapshotProvenance(missingClassification.dir, withFixtures),
    /workspace_project_classification=test/,
  );

  const withoutFixtures = snapshotProvenanceFixture({
    manifest_sha256: "6".repeat(64),
    exclusion_policy_sha256: "7".repeat(64),
    dynamic_exclusions_sha256: "8".repeat(64),
    files: 1,
    directories: 1,
    bytes: 1,
  });
  const noControls = await startSnapshotSession("zero-fixtures-no-controls", {});
  assert.equal(
    (await recordSnapshotProvenance(noControls.dir, withoutFixtures)).deduplicated,
    false,
  );
  const dockerWithoutFixtures = await startSnapshotSession("zero-fixtures-docker", {
    requested_mode: "patch",
    requested_execution_profile: "docker_strict",
  });
  assert.equal(
    (await recordSnapshotProvenance(dockerWithoutFixtures.dir, withoutFixtures)).deduplicated,
    false,
  );

  const tampered = await startSnapshotSession("tampered-fixture-controls", {
    requested_mode: "patch",
    requested_execution_profile: "local_trusted",
    workspace_project_classification: "test",
  });
  await recordSnapshotProvenance(tampered.dir, withFixtures);
  const tamperedMeta = await loadMeta(tampered.dir);
  tamperedMeta.extra = {
    ...tamperedMeta.extra,
    requested_execution_profile: "docker_strict",
  };
  await writeMeta(tampered.dir, tamperedMeta);
  await assert.rejects(
    recordSnapshotProvenance(tampered.dir, withFixtures),
    /requested_execution_profile=local_trusted/,
  );
  tamperedMeta.extra = {
    ...tamperedMeta.extra,
    requested_execution_profile: "local_trusted",
    workspace_project_classification: "production",
  };
  await writeMeta(tampered.dir, tamperedMeta);
  await assert.rejects(
    recordSnapshotProvenance(tampered.dir, withFixtures),
    /workspace_project_classification=test/,
  );
});

test("recordSnapshotProvenance rejects wrong modes, partial state, terminal state, and races", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-snapshot-guards-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const lock = firebaseSourceLock();
  const provenance = snapshotProvenanceFixture({
    manifest_sha256: "5".repeat(64),
    exclusion_policy_sha256: "6".repeat(64),
    dynamic_exclusions_sha256: "7".repeat(64),
    files: 1,
    directories: 1,
    bytes: 1,
  });

  const git = await createSession({
    name: "git",
    workspaceRoot: tmp,
    sourceLock: lock,
    extra: { provenance_status: "resolved", provenance_mode: "git_release_exact" },
  });
  await assert.rejects(recordSnapshotProvenance(git.dir, provenance), /snapshot_repro_equivalent/);

  const unavailable = await createSession({
    name: "unavailable",
    workspaceRoot: tmp,
    sourceLock: lock,
    extra: { provenance_status: "unavailable" },
  });
  await assert.rejects(recordSnapshotProvenance(unavailable.dir, provenance), /resolved/);

  const partial = await createSession({
    name: "partial",
    workspaceRoot: tmp,
    sourceLock: lock,
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
    },
  });
  const partialMeta = await loadMeta(partial.dir);
  partialMeta.extra = { ...partialMeta.extra, source_snapshot_sha256: "8".repeat(64) };
  await writeMeta(partial.dir, partialMeta);
  await assert.rejects(recordSnapshotProvenance(partial.dir, provenance), /partial/);

  const legacyEightField = await createSession({
    name: "legacy-eight-field",
    workspaceRoot: tmp,
    sourceLock: lock,
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
    },
  });
  const legacyEightFieldMeta = await loadMeta(legacyEightField.dir);
  const { manifest_sha256: _missingManifest, ...legacySource } = provenance;
  legacyEightFieldMeta.extra = {
    ...legacyEightFieldMeta.extra,
    ...legacySource,
  };
  await writeMeta(legacyEightField.dir, legacyEightFieldMeta);
  await assert.rejects(
    recordSnapshotProvenance(legacyEightField.dir, provenance),
    /partial/,
  );

  const damagedFixtureBinding = await createSession({
    name: "damaged-fixture-binding",
    workspaceRoot: tmp,
    sourceLock: lock,
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
    },
  });
  await recordSnapshotProvenance(damagedFixtureBinding.dir, provenance);
  const damagedFixtureMeta = await loadMeta(damagedFixtureBinding.dir);
  delete damagedFixtureMeta.extra?.approved_test_fixture_count;
  await writeMeta(damagedFixtureBinding.dir, damagedFixtureMeta);
  await assert.rejects(
    recordSnapshotProvenance(damagedFixtureBinding.dir, provenance),
    /partial/,
  );

  const injectedFixtureDetails = await createSession({
    name: "injected-fixture-details",
    workspaceRoot: tmp,
    sourceLock: lock,
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
    },
  });
  await recordSnapshotProvenance(injectedFixtureDetails.dir, provenance);
  const injectedFixtureDetailsMeta = await loadMeta(injectedFixtureDetails.dir);
  injectedFixtureDetailsMeta.extra = {
    ...injectedFixtureDetailsMeta.extra,
    approved_test_fixture_paths: ["private/test.json"],
  };
  await writeMeta(injectedFixtureDetails.dir, injectedFixtureDetailsMeta);
  await assert.rejects(
    recordSnapshotProvenance(injectedFixtureDetails.dir, provenance),
    /must not contain approved fixture paths, entries, or content/,
  );

  const noLock = await createSession({ name: "no-lock", workspaceRoot: tmp });
  const noLockMeta = await loadMeta(noLock.dir);
  noLockMeta.extra = {
    provenance_status: "resolved",
    provenance_mode: "snapshot_repro_equivalent",
  };
  await writeMeta(noLock.dir, noLockMeta);
  await assert.rejects(recordSnapshotProvenance(noLock.dir, provenance), /source_lock/);

  const driftedLock = await createSession({
    name: "drifted-lock",
    workspaceRoot: tmp,
    sourceLock: lock,
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
    },
  });
  const driftedMeta = await loadMeta(driftedLock.dir);
  driftedMeta.extra = {
    ...driftedMeta.extra,
    acquisition_route: "cloud_logging_mcp",
  };
  await writeMeta(driftedLock.dir, driftedMeta);
  await assert.rejects(
    recordSnapshotProvenance(driftedLock.dir, provenance),
    /does not match source_lock/,
  );

  const injectedFields: Array<[string, unknown]> = [
    ["commit", "a".repeat(40)],
    ["candidate_base_sha", "b".repeat(40)],
    ["source_ref_sha256", "c".repeat(64)],
    ["artifact_sha256", "d".repeat(64)],
    ["build_environment_sha256", "e".repeat(64)],
    ["diff_sha256", "f".repeat(64)],
    ["changed_files", ["src/Main.kt"]],
    ["canonical_diff_sha256", "1".repeat(64)],
    ["candidate_manifest_sha256", "2".repeat(64)],
    ["destination_ref_sha256", "3".repeat(64)],
  ];
  for (const [field, value] of injectedFields) {
    const damaged = await createSession({
      name: `damaged-${field}`,
      workspaceRoot: tmp,
      sourceLock: lock,
      extra: {
        provenance_status: "resolved",
        provenance_mode: "snapshot_repro_equivalent",
      },
    });
    const damagedMeta = await loadMeta(damaged.dir);
    damagedMeta.extra = { ...damagedMeta.extra, [field]: value };
    await writeMeta(damaged.dir, damagedMeta);
    await assert.rejects(
      recordSnapshotProvenance(damaged.dir, provenance),
      /contradictory identity|derived provenance exists before source binding/,
    );
    assert.equal((await loadMeta(damaged.dir)).extra?.source_snapshot_sha256, undefined);
  }

  // Git/source_ref identities remain contradictory even after a valid source
  // bind; candidate/build-derived fields, covered above, remain retry-safe.
  for (const [field, value] of injectedFields.slice(0, 3)) {
    const damaged = await createSession({
      name: `bound-damaged-${field}`,
      workspaceRoot: tmp,
      sourceLock: lock,
      extra: {
        provenance_status: "resolved",
        provenance_mode: "snapshot_repro_equivalent",
      },
    });
    await recordSnapshotProvenance(damaged.dir, provenance);
    const damagedMeta = await loadMeta(damaged.dir);
    damagedMeta.extra = { ...damagedMeta.extra, [field]: value };
    await writeMeta(damaged.dir, damagedMeta);
    await assert.rejects(
      recordSnapshotProvenance(damaged.dir, provenance),
      /contradictory identity/,
    );
  }

  for (const status of ["failed", "aborted"] as const) {
    const terminal = await createSession({
      name: `terminal-${status}`,
      workspaceRoot: tmp,
      sourceLock: lock,
      extra: {
        provenance_status: "resolved",
        provenance_mode: "snapshot_repro_equivalent",
      },
    });
    await finalizeSession(terminal.dir, status, async () => undefined);
    await assert.rejects(recordSnapshotProvenance(terminal.dir, provenance), /not running/);
  }

  const legacyPassed = await createSession({
    name: "terminal-passed-legacy",
    workspaceRoot: tmp,
    sourceLock: lock,
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
    },
  });
  await assert.rejects(
    finalizeSession(legacyPassed.dir, "passed", async () => undefined),
    /without requested_mode cannot finalize as passed/,
  );

  const racing = await createSession({
    name: "racing",
    workspaceRoot: tmp,
    sourceLock: lock,
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
    },
  });
  const outcomes = await Promise.allSettled([
    recordSnapshotProvenance(racing.dir, provenance),
    recordSnapshotProvenance(racing.dir, snapshotProvenanceFixture({
      ...provenance,
      dynamic_exclusions_sha256: "9".repeat(64),
    })),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
});

test("recordCandidateProvenance advances a snapshot candidate atomically and idempotently", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-candidate-lifecycle-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const session = await createSession({
    name: "snapshot-candidate",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock(),
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      requested_mode: "patch",
      requested_execution_profile: "local_trusted",
    },
  });
  const source = snapshotProvenanceFixture({
    manifest_sha256: "1".repeat(64),
    exclusion_policy_sha256: "2".repeat(64),
    dynamic_exclusions_sha256: "3".repeat(64),
    approved_test_fixtures_sha256: "4".repeat(64),
    approved_test_fixture_count: 1,
    files: 12,
    directories: 4,
    bytes: 4096,
  });
  await recordSnapshotProvenance(session.dir, source);

  const candidate = {
    stage: "candidate" as const,
    baseline_artifact_sha256: "4".repeat(64),
    artifact_sha256: "5".repeat(64),
    build_environment_sha256: "6".repeat(64),
    execution_profile: "local_trusted" as const,
    strong_isolation: false,
    workspace_disk_quota_enforced: false,
    network_policy: "not_enforced" as const,
    filesystem_write_isolation: "not_enforced" as const,
    secret_filesystem_isolation: "not_enforced" as const,
    process_containment: "process_group_best_effort" as const,
    canonical_diff_sha256: "7".repeat(64),
    candidate_manifest_sha256: "8".repeat(64),
    workspace_canonical_diff_sha256: "7".repeat(64),
    workspace_manifest_sha256: "8".repeat(64),
    workspace_role: "candidate" as const,
    changed_files: ["app/src/Main.kt", "app/src/MainTest.kt"],
    artifact_platform: "android" as const,
    artifact_app_id: "com.example.integrity",
    artifact_version: "1.2.3",
    artifact_build: "42",
    artifact_variant: "debug",
    variant_source: "task-bound" as const,
    variant_artifact_derived: false as const,
    artifact_signing_identity_ref_sha256: "9".repeat(64),
  };
  const targetStack = [
    "Normalized Crash Event",
    "Kind: java",
    "Exception Class: java.lang.IllegalStateException",
    "Frame 0: app.Main.run",
  ].join("\n");
  const targetIdentity = computeCanonicalAnalyzerIdentity(targetStack);
  const targetFingerprint = targetIdentity.fingerprint;
  await recordCrashfixTarget(session.dir, {
    project: "project",
    app: "app",
    issue: "issue",
    app_build: {
      platform: candidate.artifact_platform,
      app_id: candidate.artifact_app_id,
      version: candidate.artifact_version,
      build: candidate.artifact_build,
    },
  });
  await recordCrashEvidence(session.dir, {
    signature: targetFingerprint,
    signature_version: targetIdentity.signature_version,
    signature_degraded: false,
    cross_source_comparable: true,
    stack: targetStack,
    kind: "java",
    repro_path: [],
    source: firebaseCrashSource(targetFingerprint, {
      event: "candidate-target",
      app_build: {
        platform: "android",
        app_id: candidate.artifact_app_id,
        version: candidate.artifact_version,
        build: candidate.artifact_build,
      },
    }),
    acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
  });
  await assert.rejects(
    recordCandidateProvenance(session.dir, candidate),
    /requires a bound CrashFix analysis/,
  );
  await recordHighConfidenceAnalysis(session.dir, targetIdentity);
  const classificationDrift = await loadMeta(session.dir);
  classificationDrift.extra = {
    ...classificationDrift.extra,
    workspace_project_classification: "production",
  };
  await writeMeta(session.dir, classificationDrift);
  await assert.rejects(
    recordCandidateProvenance(session.dir, candidate),
    /workspace_project_classification=test/,
  );
  classificationDrift.extra = {
    ...classificationDrift.extra,
    workspace_project_classification: "test",
  };
  await writeMeta(session.dir, classificationDrift);
  for (const fixturePath of [
    "fixtures/a.json",
    "fixtures/a.properties",
    "fixtures/a.conf",
    "fixtures/a.config",
    "fixtures/a.cfg",
    "fixtures/a.ini",
    "fixtures/a.toml",
    "fixtures/a.yaml",
    "fixtures/a.yml",
    "fixtures/a.xml",
    "fixtures/a.auth",
    "gradle.properties",
    "fixtures/UPPER.JSON",
  ]) {
    await assert.rejects(
      recordCandidateProvenance(session.dir, {
        ...candidate,
        changed_files: [fixturePath],
      }),
      /changed_files must omit approvable test fixture paths/,
    );
  }
  const candidateResult = await recordCandidateProvenance(session.dir, candidate);
  assert.equal(candidateResult.stage, "candidate");
  assert.equal(candidateResult.deduplicated, false);
  assert.equal(candidateResult.artifact_sha256_prefix, "5".repeat(12));
  assert.equal(candidateResult.execution_profile, "local_trusted");
  assert.equal(candidateResult.strong_isolation, false);
  assert.equal(candidateResult.workspace_disk_quota_enforced, false);
  assert.equal(candidateResult.network_policy, "not_enforced");
  assert.equal(candidateResult.process_containment, "process_group_best_effort");
  for (const hash of Object.values(candidate).filter(
    (value): value is string => typeof value === "string" && value.length === 64,
  )) {
    assert.doesNotMatch(JSON.stringify(candidateResult), new RegExp(hash));
  }
  assert.deepEqual(await recordCandidateProvenance(session.dir, candidate), {
    ...candidateResult,
    deduplicated: true,
  });

  let persisted = await loadMeta(session.dir);
  assert.equal(persisted.extra?.artifact_sha256, candidate.artifact_sha256);
  assert.deepEqual(persisted.extra?.changed_files, candidate.changed_files);
  assert.equal(persisted.extra?.execution_profile, candidate.execution_profile);
  assert.equal(persisted.extra?.requested_execution_profile, "local_trusted");
  assert.equal(
    persisted.extra?.secret_filesystem_isolation,
    candidate.secret_filesystem_isolation,
  );
  let publicExtra = publicSessionExtra(persisted.extra);
  assert.equal(
    publicExtra.source_snapshot_sha256,
    source.source_snapshot_sha256.slice(0, 12),
  );
  assert.equal(publicExtra.baseline_artifact_sha256, "4".repeat(12));
  assert.equal(publicExtra.artifact_sha256, "5".repeat(12));
  assert.equal(publicExtra.execution_profile, "local_trusted");
  assert.equal(publicExtra.requested_execution_profile, "local_trusted");
  assert.equal(publicExtra.strong_isolation, false);
  assert.equal(publicExtra.workspace_disk_quota_enforced, false);
  assert.equal(publicExtra.network_policy, "not_enforced");
  assert.equal(publicExtra.filesystem_write_isolation, "not_enforced");
  assert.equal(publicExtra.secret_filesystem_isolation, "not_enforced");
  assert.equal(publicExtra.process_containment, "process_group_best_effort");
  assert.equal(publicExtra.device_ref_sha256, undefined);
  assert.equal(publicExtra.destination_ref_sha256, undefined);

  const childSessionIds = await createPassedVerificationChildren({
    workspaceRoot: tmp,
    parentSessionId: session.id,
    artifactSha256: candidate.artifact_sha256,
    deviceRefSha256: "a".repeat(64),
    planSha256: "b".repeat(64),
    targetSignatureVersion: JAVA_SIGNATURE_VERSION,
    targetFingerprint,
  });

  const verification = {
    stage: "verification" as const,
    artifact_sha256: candidate.artifact_sha256,
    device_ref_sha256: "a".repeat(64),
    plan_sha256: "b".repeat(64),
    target_signature_version: JAVA_SIGNATURE_VERSION,
    target_fingerprint: targetFingerprint,
    child_session_ids: childSessionIds,
  };
  const mismatchedLanguageChild = await loadMeta(path.join(tmp, childSessionIds[0]));
  assert.equal(mismatchedLanguageChild.report_language, "en-US");
  mismatchedLanguageChild.report_language = "zh-CN";
  await writeMeta(path.join(tmp, childSessionIds[0]), mismatchedLanguageChild);
  await assert.rejects(
    recordCandidateProvenance(session.dir, verification),
    /report language must match its parent/i,
  );
  mismatchedLanguageChild.report_language = "en-US";
  await writeMeta(path.join(tmp, childSessionIds[0]), mismatchedLanguageChild);
  let driftedMeta = await loadMeta(session.dir);
  driftedMeta.extra = {
    ...driftedMeta.extra,
    requested_execution_profile: "docker_strict",
  };
  await writeMeta(session.dir, driftedMeta);
  await assert.rejects(
    recordCandidateProvenance(session.dir, verification),
    /does not match requested_execution_profile|requested_execution_profile=local_trusted/,
  );
  driftedMeta.extra = {
    ...driftedMeta.extra,
    requested_execution_profile: "local_trusted",
  };
  await writeMeta(session.dir, driftedMeta);
  const verificationResult = await recordCandidateProvenance(session.dir, verification);
  assert.equal(verificationResult.stage, "verification");
  assert.equal(verificationResult.deduplicated, false);
  assert.equal(verificationResult.verified, true);
  assert.equal(verificationResult.verification_runs, 3);
  assert.equal(verificationResult.device_ref_sha256_prefix, "a".repeat(12));
  assert.equal(verificationResult.target_signature_version, JAVA_SIGNATURE_VERSION);
  assert.equal(verificationResult.target_fingerprint, targetFingerprint);
  assert.equal(verificationResult.child_session_ref_sha256_prefixes.length, 3);
  assert.doesNotMatch(JSON.stringify(verificationResult), /a{64}|b{64}/);
  assert.deepEqual(await recordCandidateProvenance(session.dir, verification), {
    ...verificationResult,
    deduplicated: true,
  });

  persisted = await loadMeta(session.dir);
  publicExtra = publicSessionExtra(persisted.extra);
  assert.equal(publicExtra.device_ref_sha256, "a".repeat(12));
  assert.equal(publicExtra.plan_sha256, "b".repeat(12));
  assert.equal(publicExtra.verification_runs, 3);
  assert.equal(publicExtra.verified, true);
  assert.equal(publicExtra.target_signature_version, JAVA_SIGNATURE_VERSION);
  assert.equal(publicExtra.target_fingerprint, targetFingerprint);

  const exported = {
    stage: "export" as const,
    canonical_diff_sha256: candidate.canonical_diff_sha256,
    candidate_manifest_sha256: candidate.candidate_manifest_sha256,
    destination_ref_sha256: "c".repeat(64),
  };
  driftedMeta = await loadMeta(session.dir);
  driftedMeta.extra = {
    ...driftedMeta.extra,
    requested_execution_profile: "docker_strict",
  };
  await writeMeta(session.dir, driftedMeta);
  await assert.rejects(
    recordCandidateProvenance(session.dir, exported),
    /does not match requested_execution_profile|requested_execution_profile=local_trusted/,
  );
  driftedMeta.extra = {
    ...driftedMeta.extra,
    requested_execution_profile: "local_trusted",
  };
  await writeMeta(session.dir, driftedMeta);
  const childStepsPath = path.join(tmp, childSessionIds[0], "steps.jsonl");
  const originalChildSteps = await readFile(childStepsPath, "utf8");
  await writeFile(
    childStepsPath,
    originalChildSteps.replace("replay verified crash path", "tampered replay path"),
    "utf8",
  );
  await assert.rejects(
    recordCandidateProvenance(session.dir, exported),
    /evidence changed after it was bound/,
  );
  await writeFile(childStepsPath, originalChildSteps, "utf8");
  const exportResult = await recordCandidateProvenance(session.dir, exported);
  assert.equal(exportResult.stage, "export");
  assert.equal(exportResult.deduplicated, false);
  assert.equal(exportResult.destination_ref_sha256_prefix, "c".repeat(12));
  assert.doesNotMatch(JSON.stringify(exportResult), /c{64}/);
  assert.deepEqual(await recordCandidateProvenance(session.dir, exported), {
    ...exportResult,
    deduplicated: true,
  });

  persisted = await loadMeta(session.dir);
  publicExtra = publicSessionExtra(persisted.extra);
  assert.equal(publicExtra.destination_ref_sha256, "c".repeat(12));
  assert.equal(JSON.stringify(publicExtra).includes("4".repeat(64)), false);
  assert.equal(JSON.stringify(publicExtra).includes("a".repeat(64)), false);
  assert.deepEqual(await recordSnapshotProvenance(session.dir, source), {
    deduplicated: true,
    source_snapshot_sha256_prefix: source.source_snapshot_sha256.slice(0, 12),
    exclusion_policy_sha256_prefix: "2".repeat(12),
    dynamic_exclusions_sha256_prefix: "3".repeat(12),
    approved_test_fixtures_sha256_prefix: "4".repeat(12),
    approved_test_fixture_count: 1,
    files: 12,
    directories: 4,
    bytes: 4096,
  });

  await assert.rejects(
    recordCandidateProvenance(session.dir, {
      ...candidate,
      artifact_sha256: "d".repeat(64),
    }),
    /different identity/,
  );
  await assert.rejects(
    recordCandidateProvenance(session.dir, {
      ...candidate,
      execution_profile: "docker_strict",
      strong_isolation: true,
      workspace_disk_quota_enforced: true,
      network_policy: "denied",
      filesystem_write_isolation: "enforced",
      secret_filesystem_isolation: "enforced",
      process_containment: "container+process_group",
    }),
    /does not match requested_execution_profile|requested_execution_profile=local_trusted/,
  );
  await assert.rejects(
    recordCandidateProvenance(session.dir, {
      ...verification,
      artifact_sha256: "d".repeat(64),
    }),
    /does not match/,
  );
  await assert.rejects(
    recordCandidateProvenance(session.dir, {
      ...verification,
      device_ref_sha256: "e".repeat(64),
    }),
    /do not share the bound artifact\/device\/plan\/platform identity/,
  );
  await assert.rejects(
    recordCandidateProvenance(session.dir, {
      ...verification,
      target_fingerprint: "f".repeat(12),
    }),
    /target signature identity is not archived in the parent session/,
  );
  await assert.rejects(
    recordCandidateProvenance(session.dir, {
      ...exported,
      canonical_diff_sha256: "d".repeat(64),
    }),
    /does not match/,
  );
  const finalizationDrift = await loadMeta(session.dir);
  finalizationDrift.extra = {
    ...finalizationDrift.extra,
    workspace_project_classification: "production",
  };
  await writeMeta(session.dir, finalizationDrift);
  await assert.rejects(
    finalizeSession(session.dir, "passed", async () => undefined),
    /workspace_project_classification=test/,
  );
  finalizationDrift.extra = {
    ...finalizationDrift.extra,
    workspace_project_classification: "test",
  };
  await writeMeta(session.dir, finalizationDrift);
  const finalized = await finalizeSession(
    session.dir,
    "passed",
    async ({ meta }) => meta.status,
  );
  assert.equal(finalized.value, "passed");
});

test("candidate provenance rejects degraded or non-comparable analyzer evidence", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-candidate-analyzer-gate-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const snapshot = snapshotProvenanceFixture({
    manifest_sha256: "1".repeat(64),
    exclusion_policy_sha256: "2".repeat(64),
    dynamic_exclusions_sha256: "3".repeat(64),
    approved_test_fixtures_sha256: "4".repeat(64),
    approved_test_fixture_count: 1,
    files: 2,
    directories: 1,
    bytes: 10,
  });
  const candidate = {
    stage: "candidate" as const,
    baseline_artifact_sha256: "4".repeat(64),
    artifact_sha256: "5".repeat(64),
    build_environment_sha256: "6".repeat(64),
    execution_profile: "local_trusted" as const,
    strong_isolation: false,
    workspace_disk_quota_enforced: false,
    network_policy: "not_enforced" as const,
    filesystem_write_isolation: "not_enforced" as const,
    secret_filesystem_isolation: "not_enforced" as const,
    process_containment: "process_group_best_effort" as const,
    canonical_diff_sha256: "7".repeat(64),
    candidate_manifest_sha256: "8".repeat(64),
    workspace_canonical_diff_sha256: "7".repeat(64),
    workspace_manifest_sha256: "8".repeat(64),
    workspace_role: "candidate" as const,
    changed_files: ["app/src/Main.kt"],
    artifact_platform: "android" as const,
    artifact_app_id: "com.example.app",
    artifact_version: "1.0",
    artifact_build: "1",
    artifact_variant: "debug",
    variant_source: "task-bound" as const,
    variant_artifact_derived: false as const,
    artifact_signing_identity_ref_sha256: "9".repeat(64),
  };
  const cases = [
    {
      kind: "anr",
      signatureDegraded: true,
      crossSourceComparable: true,
      stack: [
        "Normalized Crash Event",
        "Kind: anr",
        "Process: com.example.app",
        "Frame 0: anr:com.example.app",
      ].join("\n"),
    },
    {
      kind: "native",
      signatureDegraded: true,
      crossSourceComparable: true,
      stack: [
        "Normalized Crash Event",
        "Kind: native",
        "Signal: SIGSEGV",
        "Frame 0: SIGSEGV",
      ].join("\n"),
    },
    {
      kind: "unknown",
      signatureDegraded: true,
      crossSourceComparable: false,
      stack: [
        "Normalized Crash Event",
        "Kind: unknown",
        "Frame 0: unknown.frame",
      ].join("\n"),
    },
  ] as const;

  for (const item of cases) {
    const session = await createSession({
      name: `analyzer-gate-${item.kind}`,
      workspaceRoot: tmp,
      sourceLock: firebaseSourceLock(),
      extra: {
        provenance_status: "resolved",
        provenance_mode: "snapshot_repro_equivalent",
        requested_mode: "patch",
        requested_execution_profile: "local_trusted",
      },
    });
    await recordCrashfixTarget(session.dir, {
      project: "project",
      app: "app",
      issue: "issue",
      app_build: {
        platform: candidate.artifact_platform,
        app_id: candidate.artifact_app_id,
        version: candidate.artifact_version,
        build: candidate.artifact_build,
      },
    });
    await recordSnapshotProvenance(session.dir, snapshot);
    const identity = computeCanonicalAnalyzerIdentity(item.stack);
    await recordCrashEvidence(session.dir, {
      signature: identity.fingerprint,
      signature_version: identity.signature_version,
      signature_degraded: item.signatureDegraded,
      cross_source_comparable: item.crossSourceComparable,
      stack: item.stack,
      kind: item.kind,
      repro_path: [],
      source: firebaseCrashSource(identity.fingerprint, {
        event: `event-${item.kind}`,
        app_build: {
          platform: candidate.artifact_platform,
          app_id: candidate.artifact_app_id,
          version: candidate.artifact_version,
          build: candidate.artifact_build,
        },
      }, identity.signature_version),
      acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
    });
    await recordHighConfidenceAnalysis(session.dir, identity);
    await assert.rejects(
      recordCandidateProvenance(session.dir, candidate),
      /non-degraded, cross-source-comparable analyzer evidence/,
    );
  }

  const mediumSession = await createSession({
    name: "analysis-confidence-gate",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock(),
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      requested_mode: "patch",
      requested_execution_profile: "local_trusted",
    },
  });
  await recordSnapshotProvenance(mediumSession.dir, snapshot);
  const mediumStack = [
    "Normalized Crash Event",
    "Kind: java",
    "Exception Class: java.lang.IllegalStateException",
    "Frame 0: app.Main.run",
  ].join("\n");
  const mediumIdentity = computeCanonicalAnalyzerIdentity(mediumStack);
  await recordCrashfixTarget(mediumSession.dir, {
    project: "project",
    app: "app",
    issue: "issue",
    app_build: {
      platform: candidate.artifact_platform,
      app_id: candidate.artifact_app_id,
      version: candidate.artifact_version,
      build: candidate.artifact_build,
    },
  });
  await recordCrashEvidence(mediumSession.dir, {
    signature: mediumIdentity.fingerprint,
    signature_version: mediumIdentity.signature_version,
    signature_degraded: false,
    cross_source_comparable: true,
    stack: mediumStack,
    kind: "java",
    repro_path: [],
    source: firebaseCrashSource(mediumIdentity.fingerprint, {
      event: "event-medium-confidence",
      app_build: {
        platform: candidate.artifact_platform,
        app_id: candidate.artifact_app_id,
        version: candidate.artifact_version,
        build: candidate.artifact_build,
      },
    }, mediumIdentity.signature_version),
    acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
  });
  await recordCrashfixAnalysis(mediumSession.dir, {
    schema_version: "crashfix-analysis/v1",
    target_signature_version: mediumIdentity.signature_version,
    target_fingerprint: mediumIdentity.fingerprint,
    root_cause_summary: "现有证据支持一个可能的状态处理故障点。",
    confidence: "medium",
    category: "lifecycle",
    locations: [],
    remediation_summary: "先补充证据，再决定是否生成候选修复。",
    limitations: ["根因置信度尚未达到自动候选门槛。"],
  });
  await assert.rejects(
    recordCandidateProvenance(mediumSession.dir, candidate),
    /requires confidence=high CrashFix analysis/,
  );
});

test("candidate provenance rejects invalid, partial, out-of-order, wrong-mode, terminal, and racing writes", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-candidate-guards-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const lock = firebaseSourceLock();
  const source = snapshotProvenanceFixture({
    manifest_sha256: "1".repeat(64),
    exclusion_policy_sha256: "2".repeat(64),
    dynamic_exclusions_sha256: "3".repeat(64),
    files: 2,
    directories: 2,
    bytes: 200,
  });
  const candidate = {
    stage: "candidate" as const,
    baseline_artifact_sha256: "4".repeat(64),
    artifact_sha256: "5".repeat(64),
    build_environment_sha256: "6".repeat(64),
    execution_profile: "docker_strict" as const,
    strong_isolation: true,
    workspace_disk_quota_enforced: true,
    network_policy: "denied" as const,
    filesystem_write_isolation: "enforced" as const,
    secret_filesystem_isolation: "enforced" as const,
    process_containment: "container+process_group" as const,
    canonical_diff_sha256: "7".repeat(64),
    candidate_manifest_sha256: "8".repeat(64),
    workspace_canonical_diff_sha256: "7".repeat(64),
    workspace_manifest_sha256: "8".repeat(64),
    workspace_role: "candidate" as const,
    changed_files: ["app/src/Main.kt"],
    artifact_platform: "android" as const,
    artifact_app_id: "com.example.app",
    artifact_version: "1.0",
    artifact_build: "1",
    artifact_variant: "release",
    variant_source: "task-bound" as const,
    variant_artifact_derived: false as const,
    artifact_signing_identity_ref_sha256: "9".repeat(64),
  };

  const quickSession = await createSession({
    name: "quick-candidate-forbidden",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock(),
    extra: {
      provenance_status: "unavailable",
      requested_mode: "analyze",
      requested_workflow: "quick_test",
      requested_execution_profile: "local_trusted",
      workspace_project_classification: "test",
    },
  });
  const quickMeta = await loadMeta(quickSession.dir);
  quickMeta.extra = {
    ...quickMeta.extra,
    provenance_status: "resolved",
    provenance_mode: "snapshot_repro_equivalent",
  };
  await writeMeta(quickSession.dir, quickMeta);
  await assert.rejects(
    recordCandidateProvenance(quickSession.dir, candidate),
    /quick_test never uses snapshot candidate provenance/,
  );

  const profileLocked = await createSession({
    name: "profile-locked",
    workspaceRoot: tmp,
    sourceLock: lock,
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      requested_mode: "patch",
      requested_execution_profile: "local_trusted",
    },
  });
  await recordSnapshotProvenance(profileLocked.dir, source);
  await assert.rejects(
    recordCandidateProvenance(profileLocked.dir, candidate),
    /does not match requested_execution_profile|requested_execution_profile=local_trusted/,
  );

  // Legacy sessions remain readable/analyzable, but cannot enter mutation.
  const legacyUnlocked = await createSession({
    name: "legacy-unlocked-profile",
    workspaceRoot: tmp,
    sourceLock: lock,
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
    },
  });
  await recordSnapshotProvenance(legacyUnlocked.dir, source);
  await assert.rejects(
    recordCandidateProvenance(legacyUnlocked.dir, candidate),
    /without requested_mode|requested_execution_profile/,
  );

  assert.throws(
    () => candidateProvenanceSchema.parse({ ...candidate, workspace_path: "/private/app" }),
    /unrecognized|key/i,
  );
  assert.throws(
    () => candidateProvenanceSchema.parse({
      ...candidate,
      changed_files: ["app/src/Z.kt", "app/src/A.kt"],
    }),
    /sorted/,
  );
  assert.throws(
    () => candidateProvenanceSchema.parse({
      ...candidate,
      changed_files: ["../secret.json"],
    }),
    /relative path|clean POSIX path/,
  );
  for (const field of [
    "execution_profile",
    "strong_isolation",
    "workspace_disk_quota_enforced",
    "network_policy",
    "filesystem_write_isolation",
    "secret_filesystem_isolation",
    "process_containment",
  ] as const) {
    const partialProfile = Object.fromEntries(
      Object.entries(candidate).filter(([key]) => key !== field),
    );
    assert.throws(
      () => candidateProvenanceSchema.parse(partialProfile),
      /required|invalid/i,
      `missing ${field} must reject the whole candidate profile`,
    );
  }
  for (const invalidProfile of [
    { ...candidate, strong_isolation: false },
    { ...candidate, workspace_disk_quota_enforced: false },
    { ...candidate, network_policy: "not_enforced" },
    { ...candidate, filesystem_write_isolation: "not_enforced" },
    { ...candidate, secret_filesystem_isolation: "not_enforced" },
    { ...candidate, process_containment: "process_group_best_effort" },
    {
      ...candidate,
      execution_profile: "local_trusted",
      strong_isolation: true,
      workspace_disk_quota_enforced: true,
      network_policy: "denied",
      filesystem_write_isolation: "enforced",
      secret_filesystem_isolation: "enforced",
      process_containment: "container+process_group",
    },
  ]) {
    assert.throws(
      () => candidateProvenanceSchema.parse(invalidProfile),
      /execution_profile=.*requires/i,
    );
  }
  assert.doesNotThrow(() => candidateProvenanceSchema.parse({
    ...candidate,
    execution_profile: "local_trusted",
    strong_isolation: false,
    workspace_disk_quota_enforced: false,
    network_policy: "not_enforced",
    filesystem_write_isolation: "not_enforced",
    secret_filesystem_isolation: "not_enforced",
    process_containment: "process_group_best_effort",
  }));
  assert.doesNotThrow(() => candidateProvenanceSchema.parse({
    ...candidate,
    // The snapshot helper canonicalizes with UTF-8 byte order, not UTF-16.
    changed_files: ["\ue000.kt", "😀.kt"],
  }));

  const missingSource = await createSession({
    name: "missing-source",
    workspaceRoot: tmp,
    sourceLock: lock,
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      requested_mode: "patch",
      requested_execution_profile: "docker_strict",
    },
  });
  await assert.rejects(
    recordCandidateProvenance(missingSource.dir, candidate),
    /source snapshot provenance first/,
  );

  const git = await createSession({
    name: "git-candidate",
    workspaceRoot: tmp,
    sourceLock: lock,
    extra: {
      provenance_status: "resolved",
      provenance_mode: "git_release_exact",
      requested_mode: "patch",
      requested_execution_profile: "docker_strict",
    },
  });
  await assert.rejects(recordCandidateProvenance(git.dir, candidate), /snapshot_repro_equivalent/);

  const unavailable = await createSession({
    name: "unavailable-candidate",
    workspaceRoot: tmp,
    sourceLock: lock,
    extra: {
      provenance_status: "unavailable",
      requested_mode: "patch",
      requested_execution_profile: "docker_strict",
      preflight_abort: "provenance_unavailable",
    },
  });
  await assert.rejects(recordCandidateProvenance(unavailable.dir, candidate), /resolved/);

  const ordered = await createSession({
    name: "ordered-candidate",
    workspaceRoot: tmp,
    sourceLock: lock,
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      requested_mode: "patch",
      requested_execution_profile: "docker_strict",
    },
  });
  await recordSnapshotProvenance(ordered.dir, source);
  await assert.rejects(
    recordCandidateProvenance(ordered.dir, {
      stage: "verification",
      artifact_sha256: candidate.artifact_sha256,
      device_ref_sha256: "a".repeat(64),
      plan_sha256: "b".repeat(64),
      target_signature_version: JAVA_SIGNATURE_VERSION,
      target_fingerprint: "d".repeat(12),
      child_session_ids: ["child-1", "child-2", "child-3"],
    }),
    /build provenance must be bound first/,
  );
  await recordCandidateTarget(ordered.dir, candidate, "ordered-target");
  await recordCandidateProvenance(ordered.dir, candidate);
  await assert.rejects(
    recordCandidateProvenance(ordered.dir, {
      stage: "export",
      canonical_diff_sha256: candidate.canonical_diff_sha256,
      candidate_manifest_sha256: candidate.candidate_manifest_sha256,
      destination_ref_sha256: "c".repeat(64),
    }),
    /verification provenance must be bound first/,
  );

  const partial = await createSession({
    name: "partial-candidate",
    workspaceRoot: tmp,
    sourceLock: lock,
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      requested_mode: "patch",
      requested_execution_profile: "docker_strict",
    },
  });
  await recordSnapshotProvenance(partial.dir, source);
  await recordCandidateTarget(partial.dir, candidate, "partial-target");
  const partialMeta = await loadMeta(partial.dir);
  partialMeta.extra = { ...partialMeta.extra, artifact_sha256: candidate.artifact_sha256 };
  await writeMeta(partial.dir, partialMeta);
  await assert.rejects(recordCandidateProvenance(partial.dir, candidate), /partial/);

  const terminal = await createSession({
    name: "terminal-candidate",
    workspaceRoot: tmp,
    sourceLock: lock,
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      requested_mode: "patch",
      requested_execution_profile: "docker_strict",
    },
  });
  await recordSnapshotProvenance(terminal.dir, source);
  await finalizeSession(terminal.dir, "aborted", async () => undefined);
  await assert.rejects(recordCandidateProvenance(terminal.dir, candidate), /not running/);

  const racing = await createSession({
    name: "racing-candidate",
    workspaceRoot: tmp,
    sourceLock: lock,
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      requested_mode: "patch",
      requested_execution_profile: "docker_strict",
    },
  });
  await recordSnapshotProvenance(racing.dir, source);
  await recordCandidateTarget(racing.dir, candidate, "racing-target");
  const outcomes = await Promise.allSettled([
    recordCandidateProvenance(racing.dir, candidate),
    recordCandidateProvenance(racing.dir, {
      ...candidate,
      artifact_sha256: "d".repeat(64),
    }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
});

test("verification evidence cannot be self-declared or finalized from an unproven child", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-verification-guards-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const targetFingerprint = "d".repeat(12);
  const artifactSha256 = "5".repeat(64);
  const deviceRefSha256 = "a".repeat(64);
  const planSha256 = "b".repeat(64);

  const verificationInput = {
    stage: "verification" as const,
    artifact_sha256: artifactSha256,
    device_ref_sha256: deviceRefSha256,
    plan_sha256: planSha256,
    target_signature_version: JAVA_SIGNATURE_VERSION,
    target_fingerprint: targetFingerprint,
    child_session_ids: ["child-1", "child-2", "child-3"],
  };
  assert.throws(
    () => candidateProvenanceSchema.parse({ ...verificationInput, verification_runs: 3 }),
    /unrecognized key/i,
  );
  assert.deepEqual(
    publicSessionExtra({ verification_runs: 3, verified: true }),
    {},
    "unbound generic metadata must not publish verified semantics",
  );
  await assert.rejects(
    createSession({
      name: "self-declared-verified",
      workspaceRoot: tmp,
      extra: { verification_runs: 3, verified: true },
    }),
    /CrashFix provenance fields require provenance_status/i,
  );
  assert.throws(
    () => candidateProvenanceSchema.parse({
      ...verificationInput,
      child_session_ids: ["child-1", "child-1", "child-3"],
    }),
    /three distinct sessions/i,
  );

  await assert.rejects(
    createSession({
      name: "simulator-child",
      workspaceRoot: tmp,
      extra: {
        verification_schema_version: "crashfix-child-verification/v1",
        verification_parent_session_id: "parent-session",
        verification_run: 1,
        artifact_sha256: artifactSha256,
        device_ref_sha256: deviceRefSha256,
        plan_sha256: planSha256,
        verification_target_signature_version: JAVA_SIGNATURE_VERSION,
        verification_target_fingerprint: targetFingerprint,
        platform: "android",
        type: "simulator",
      },
    }),
    /verification child context is partial or invalid/i,
  );

  const missingCompletion = await createSession({
    name: "missing-completion",
    workspaceRoot: tmp,
    extra: {
      verification_schema_version: "crashfix-child-verification/v1",
      verification_parent_session_id: "parent-session",
      verification_run: 1,
      artifact_sha256: artifactSha256,
      device_ref_sha256: deviceRefSha256,
      plan_sha256: planSha256,
      verification_target_signature_version: JAVA_SIGNATURE_VERSION,
      verification_target_fingerprint: targetFingerprint,
      platform: "android",
      type: "real",
    },
  });
  await appendStep(missingCompletion.dir, {
    index: 1,
    ts: new Date().toISOString(),
    action: "replay",
    result: "ok",
  });
  await assert.rejects(
    finalizeSession(missingCompletion.dir, "passed", async () => undefined),
    /requires structured verification_evidence/i,
  );
  assert.equal((await loadMeta(missingCompletion.dir)).status, "running");

  const crashing = await createSession({
    name: "target-crashed",
    workspaceRoot: tmp,
    extra: {
      verification_schema_version: "crashfix-child-verification/v1",
      verification_parent_session_id: "parent-session",
      verification_run: 2,
      artifact_sha256: artifactSha256,
      device_ref_sha256: deviceRefSha256,
      plan_sha256: planSha256,
      verification_target_signature_version: JAVA_SIGNATURE_VERSION,
      verification_target_fingerprint: targetFingerprint,
      platform: "android",
      type: "real",
    },
  });
  await appendStep(crashing.dir, {
    index: 1,
    ts: new Date().toISOString(),
    action: "replay",
    result: "ok",
  });
  await recordCrashEvidence(crashing.dir, {
    signature: targetFingerprint,
    signature_version: JAVA_SIGNATURE_VERSION,
    stack: "FATAL EXCEPTION: main",
    kind: "java",
    repro_path: [1],
  });
  await assert.rejects(
    finalizeSession(
      crashing.dir,
      "passed",
      async () => undefined,
      { verificationEvidence: CHILD_VERIFICATION_COMPLETION },
    ),
    /observed the target analyzer signature identity/i,
  );
  assert.equal((await loadMeta(crashing.dir)).status, "running");
});

test("CrashFix requested_mode and passed lifecycle fail closed", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-crashfix-mode-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const source = snapshotProvenanceFixture({
    manifest_sha256: "1".repeat(64),
    exclusion_policy_sha256: "2".repeat(64),
    dynamic_exclusions_sha256: "3".repeat(64),
    approved_test_fixtures_sha256: "4".repeat(64),
    approved_test_fixture_count: 1,
    files: 2,
    directories: 1,
    bytes: 10,
  });
  const analyze = await createSession({
    name: "analyze-only",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock(),
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      requested_mode: "analyze",
      requested_execution_profile: "local_trusted",
    },
  });
  await recordSnapshotProvenance(analyze.dir, source);
  const candidate = {
    stage: "candidate" as const,
    baseline_artifact_sha256: "4".repeat(64),
    artifact_sha256: "5".repeat(64),
    build_environment_sha256: "6".repeat(64),
    execution_profile: "local_trusted" as const,
    strong_isolation: false,
    workspace_disk_quota_enforced: false,
    network_policy: "not_enforced" as const,
    filesystem_write_isolation: "not_enforced" as const,
    secret_filesystem_isolation: "not_enforced" as const,
    process_containment: "process_group_best_effort" as const,
    canonical_diff_sha256: "7".repeat(64),
    candidate_manifest_sha256: "8".repeat(64),
    workspace_canonical_diff_sha256: "7".repeat(64),
    workspace_manifest_sha256: "8".repeat(64),
    workspace_role: "candidate" as const,
    changed_files: ["app/src/Main.kt"],
    artifact_platform: "android" as const,
    artifact_app_id: "com.example.app",
    artifact_version: "1.0",
    artifact_build: "1",
    artifact_variant: "debug",
    variant_source: "task-bound" as const,
    variant_artifact_derived: false as const,
    artifact_signing_identity_ref_sha256: "9".repeat(64),
  };
  await assert.rejects(
    recordCandidateProvenance(analyze.dir, candidate),
    /requested_mode=patch/,
  );

  const emptyPatch = await createSession({
    name: "empty-patch",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock(),
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      requested_mode: "patch",
      requested_execution_profile: "local_trusted",
    },
  });
  await recordCrashfixTarget(emptyPatch.dir, {
    project: "project",
    app: "app",
    issue: "issue",
    app_build: {
      platform: candidate.artifact_platform,
      app_id: candidate.artifact_app_id,
      version: candidate.artifact_version,
      build: candidate.artifact_build,
    },
  });
  await assert.rejects(
    finalizeSession(emptyPatch.dir, "passed", async () => undefined),
    /archived Firebase crash evidence/,
  );
  assert.equal((await loadMeta(emptyPatch.dir)).status, "running");
});

test("public extra suppresses contradictory provenance and path-shaped change metadata", () => {
  const completeSnapshot = snapshotProvenanceFixture({
    manifest_sha256: "1".repeat(64),
    exclusion_policy_sha256: "2".repeat(64),
    dynamic_exclusions_sha256: "3".repeat(64),
    approved_test_fixtures_sha256: "4".repeat(64),
    approved_test_fixture_count: 1,
    files: 2,
    directories: 1,
    bytes: 10,
  });
  assert.deepEqual(publicSessionExtra({ ...completeSnapshot }), {});
  assert.deepEqual(publicSessionExtra({
    execution_profile: "local_trusted",
    strong_isolation: false,
    workspace_disk_quota_enforced: false,
    network_policy: "not_enforced",
    filesystem_write_isolation: "not_enforced",
    secret_filesystem_isolation: "not_enforced",
    process_containment: "process_group_best_effort",
  }), {});
  assert.deepEqual(
    publicSessionExtra({ provenance_status: "invalid", ...completeSnapshot }),
    {},
  );
  const legacySnapshotWithoutFixtureBinding = { ...completeSnapshot } as Record<
    string,
    unknown
  >;
  delete legacySnapshotWithoutFixtureBinding.approved_test_fixtures_sha256;
  delete legacySnapshotWithoutFixtureBinding.approved_test_fixture_count;
  assert.deepEqual(
    publicSessionExtra({
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      ...legacySnapshotWithoutFixtureBinding,
    }),
    { provenance_status: "resolved", provenance_mode: "snapshot_repro_equivalent" },
  );
  assert.deepEqual(
    publicSessionExtra({
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      ...completeSnapshot,
      approved_test_fixture_paths: ["private/test.json"],
    }),
    { provenance_status: "resolved", provenance_mode: "snapshot_repro_equivalent" },
  );
  assert.deepEqual(
    publicSessionExtra({
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      ...completeSnapshot,
      approved_test_fixture_count: 9,
    }),
    { provenance_status: "resolved", provenance_mode: "snapshot_repro_equivalent" },
  );
  assert.deepEqual(
    publicSessionExtra({
      provenance_status: "unavailable",
      provenance_mode: "snapshot_repro_equivalent",
      ...completeSnapshot,
      canonical_diff_sha256: "4".repeat(64),
    }),
    { provenance_status: "unavailable" },
  );
  assert.deepEqual(
    publicSessionExtra({
      provenance_status: "resolved",
      provenance_mode: "git_release_exact",
      ...completeSnapshot,
      canonical_diff_sha256: "4".repeat(64),
    }),
    { provenance_status: "resolved", provenance_mode: "git_release_exact" },
  );
  assert.deepEqual(
    publicSessionExtra({
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      source_snapshot_sha256: "1".repeat(64),
      candidate_manifest_sha256: "4".repeat(64),
    }),
    { provenance_status: "resolved", provenance_mode: "snapshot_repro_equivalent" },
  );

  assert.deepEqual(publicSessionExtra({
    commit: "/Users/private/repo",
    candidate_base_sha: "not-a-git-oid",
    artifact_sha256: "/private/app.apk",
    diff_sha256: "A".repeat(64),
    changed_files: ["src/Main.kt", "../private/secret"],
    origin: "/Users/private/origin",
    package: "C:\\Users\\private\\package",
    platform: "android\n/private",
    proc_name: "D:private-process",
    provider: "/private/provider",
    requested_mode: "C:\\private\\mode",
    strategy: "/private/strategy",
    target_fingerprint: "/private/fingerprint",
    type: "C:\\private\\type",
  }), {});
  assert.deepEqual(publicSessionExtra({
    commit: "a".repeat(40),
    artifact_sha256: "b".repeat(64),
    diff_sha256: "c".repeat(64),
    changed_files: ["src/Main.kt", "ios/App.swift"],
  }), {
    commit: "a".repeat(12),
    artifact_sha256: "b".repeat(12),
    diff_sha256: "c".repeat(12),
    changed_files: ["src/Main.kt", "ios/App.swift"],
  });
});

test("createSession uses collision-resistant private directories", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-session-unique-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const [first, second] = await Promise.all([
    createSession({ name: "same-name", workspaceRoot: tmp }),
    createSession({ name: "same-name", workspaceRoot: tmp }),
  ]);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.dir, second.dir);
  assert.equal((await stat(first.dir)).mode & 0o077, 0);
  assert.equal((await stat(second.dir)).mode & 0o077, 0);
});

test("session selectors reject traversal, ambiguity, and relative target paths", () => {
  const workspaceRoot = path.join(os.tmpdir(), "report-selector-root");
  assert.equal(
    resolveSessionDir({ workspaceRoot, sessionId: "2026-08-04_demo_deadbeef" }),
    path.join(workspaceRoot, "2026-08-04_demo_deadbeef"),
  );
  assert.equal(
    resolveSessionDir({ sessionDir: path.join(workspaceRoot, "direct") }),
    path.join(workspaceRoot, "direct"),
  );
  for (const sessionId of ["../outside", "nested/session", "nested\\session", ".", ""]) {
    assert.throws(
      () => resolveSessionDir({ workspaceRoot, sessionId }),
      /invalid|string|session_id/i,
    );
  }
  assert.throws(
    () => resolveSessionDir({
      workspaceRoot,
      sessionId: "safe-session",
      sessionDir: path.join(workspaceRoot, "direct"),
    }),
    /exactly one/i,
  );
  assert.throws(
    () => resolveSessionDir({
      workspaceRoot,
      sessionDir: path.join(workspaceRoot, "direct"),
    }),
    /workspace_root is only valid/i,
  );
  assert.throws(
    () => resolveSessionDir({ sessionDir: "relative/session" }),
    /absolute path/i,
  );
  assert.throws(
    () => resolveSessionDir({ workspaceRoot: "relative/workspace", sessionId: "safe" }),
    /workspace_root.*absolute path/i,
  );
});

test("session metadata is bounded, schema-validated, and never follows symlinks", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-session-meta-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  await assert.rejects(
    createSession({ name: "invalid\nname", workspaceRoot: tmp }),
    /control characters/,
  );

  const session = await createSession({ name: "bounded-meta", workspaceRoot: tmp });
  const original = await loadMeta(session.dir);
  await assert.rejects(
    writeMeta(session.dir, {
      ...original,
      extra: { oversized: "x".repeat(MAX_SESSION_META_BYTES) },
    }),
    /byte size limit/,
  );
  assert.deepEqual(await loadMeta(session.dir), original);

  const metaPath = path.join(session.dir, "meta.json");
  await writeFile(metaPath, JSON.stringify({ ...original, status: "unknown" }), "utf8");
  await assert.rejects(loadMeta(session.dir), /meta\.json is invalid/);
  await writeFile(metaPath, "x".repeat(MAX_SESSION_META_BYTES + 1), "utf8");
  await assert.rejects(loadMeta(session.dir), /byte size limit/);

  const outside = path.join(tmp, "outside-meta.json");
  await writeFile(outside, JSON.stringify(original), "utf8");
  await rm(metaPath);
  await symlink(outside, metaPath);
  await assert.rejects(
    loadMeta(session.dir),
    /ELOOP|symbolic link|too many levels/i,
  );
});

test("step evidence paths are strictly scoped to their record index", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-step-path-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const session = await createSession({ name: "step-paths", workspaceRoot: tmp });
  await assert.rejects(
    appendStep(session.dir, {
      index: 1,
      ts: new Date().toISOString(),
      action: "tampered direct append",
      screenshot: "steps/999.png",
      log_excerpt: "steps/999.log",
    }),
    /path must match the step index/,
  );
  assert.deepEqual(await readSteps(session.dir), []);

  await writeFile(
    path.join(session.dir, "steps.jsonl"),
    `${JSON.stringify({
      index: 1,
      ts: new Date().toISOString(),
      action: "tampered persisted record",
      screenshot: "steps/999.png",
    })}\n`,
    "utf8",
  );
  await assert.rejects(readSteps(session.dir), /path must match the step index/);
});

test("CrashFix steps and summaries use closed leak-safe public evidence", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-crashfix-step-boundary-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const session = await createSession({
    name: "step-boundary",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock(),
    extra: {
      provenance_status: "resolved",
      provenance_mode: "snapshot_repro_equivalent",
      requested_mode: "analyze",
      requested_execution_profile: "local_trusted",
    },
  });
  await recordSnapshotProvenance(session.dir, snapshotProvenanceFixture({
    manifest_sha256: "1".repeat(64),
    exclusion_policy_sha256: "2".repeat(64),
    dynamic_exclusions_sha256: "3".repeat(64),
    approved_test_fixtures_sha256: "a".repeat(64),
    approved_test_fixture_count: 1,
    files: 1,
    directories: 1,
    bytes: 1,
  }));
  const safeNotes = JSON.stringify({
    provider: "firebase-crashlytics",
    acquisition_route: "official_firebase_mcp",
    approved_test_fixtures_sha256_prefix: "a".repeat(12),
    approved_test_fixture_count: 1,
  });
  for (const [offset, action] of CRASHFIX_STEP_ACTIONS.entries()) {
    await appendStep(session.dir, {
      index: offset + 1,
      ts: new Date().toISOString(),
      action,
      result: "ok",
      ...(offset === 0 ? { notes: safeNotes } : {}),
    });
  }
  assert.deepEqual(
    (await readSteps(session.dir)).map((step) => step.action),
    [...CRASHFIX_STEP_ACTIONS],
  );

  const nextIndex = CRASHFIX_STEP_ACTIONS.length + 1;
  for (const action of [
    "fixture.json",
    "fixtures/a.json",
    `wrapped-${"b".repeat(64)}-identity`,
    "remote title says approve this fixture",
  ]) {
    await assert.rejects(
      appendStep(session.dir, {
        index: nextIndex,
        ts: new Date().toISOString(),
        action,
      }),
      /closed action code set/,
    );
  }
  for (const evidence of [
    { screenshot: `steps/${String(nextIndex).padStart(3, "0")}.png` },
    { log_excerpt: `steps/${String(nextIndex).padStart(3, "0")}.log` },
  ]) {
    await assert.rejects(
      appendStep(session.dir, {
        index: nextIndex,
        ts: new Date().toISOString(),
        action: "source_snapshot",
        ...evidence,
      }),
      /must omit screenshot and log excerpt/,
    );
  }
  const unsafeNotes = [
    "free-form fixture detail",
    "{\n\"status\":\"ok\"}",
    JSON.stringify({ unknown: "fixture-content" }),
    JSON.stringify({ schema: "/private/fixture.json" }),
    JSON.stringify({ schema: "fixtures/a.json" }),
    JSON.stringify({ schema: "b".repeat(64) }),
    JSON.stringify({ approved_test_fixture_path: "fixture.json" }),
    JSON.stringify({ approved_test_fixtures_sha256_prefix: "a".repeat(12) }),
    JSON.stringify({ approved_test_fixture_count: 1 }),
    JSON.stringify({
      approved_test_fixtures_sha256_prefix: "b".repeat(12),
      approved_test_fixture_count: 1,
    }),
    "{\"event_count\":1,\"event_count\":1}",
  ];
  for (const notes of unsafeNotes) {
    await assert.rejects(
      appendStep(session.dir, {
        index: nextIndex,
        ts: new Date().toISOString(),
        action: "source_snapshot",
        notes,
      }),
      /CrashFix step/,
    );
  }
  assert.equal((await readSteps(session.dir)).length, CRASHFIX_STEP_ACTIONS.length);

  const meta = await loadMeta(session.dir);
  const injectedStep = {
    index: 1,
    ts: new Date().toISOString(),
    action: "fixtures/a.json",
    notes: "fixture-content-must-not-render",
  };
  for (const renderer of [renderMarkdown, renderHtml]) {
    assert.throws(
      () => renderer({ meta, steps: [injectedStep], crashes: [] }),
      /closed action code set/,
    );
    for (const summary of [
      "fixtures/private.json",
      "c".repeat(64),
      "fixture-content-must-not-render",
    ]) {
      assert.throws(
        () => renderer({ meta, steps: [], crashes: [], summary }),
        /must omit caller-supplied summary text/,
      );
    }
  }

  const tampered = await createSession({
    name: "tampered-step-boundary",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock(),
    extra: {
      provenance_status: "unavailable",
      requested_mode: "analyze",
    },
  });
  await writeFile(
    path.join(tampered.dir, "steps.jsonl"),
    `${JSON.stringify(injectedStep)}\n`,
    "utf8",
  );
  await assert.rejects(readSteps(tampered.dir), /closed action code set/);
  const tamperedMeta = await loadMeta(tampered.dir);
  delete tamperedMeta.source_lock;
  await writeMeta(tampered.dir, tamperedMeta);
  await assert.rejects(readSteps(tampered.dir), /closed action code set/);

  const ordinary = await createSession({ name: "ordinary-step-boundary", workspaceRoot: tmp });
  await appendStep(ordinary.dir, {
    index: 1,
    ts: new Date().toISOString(),
    action: "open fixtures/a.json for local devtest",
    screenshot: "steps/001.png",
    log_excerpt: "steps/001.log",
    notes: "ordinary free-form notes",
  });
  const ordinaryMeta = await loadMeta(ordinary.dir);
  const ordinarySteps = await readSteps(ordinary.dir);
  assert.match(
    renderMarkdown({
      meta: ordinaryMeta,
      steps: ordinarySteps,
      crashes: [],
      summary: "ordinary free-form summary",
    }),
    /ordinary free-form summary/,
  );
});

test("JSONL readers and appenders fail closed on missing, symlinked, or hard-linked indexes", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-jsonl-integrity-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));

  const missing = await createSession({ name: "missing-jsonl", workspaceRoot: tmp });
  await rm(path.join(missing.dir, "steps.jsonl"));
  await assert.rejects(readSteps(missing.dir), /steps\.jsonl is missing/);

  const linked = await createSession({ name: "linked-jsonl", workspaceRoot: tmp });
  const outside = path.join(tmp, "outside-steps.jsonl");
  await writeFile(outside, "", "utf8");
  await rm(path.join(linked.dir, "steps.jsonl"));
  await symlink(outside, path.join(linked.dir, "steps.jsonl"));
  await assert.rejects(
    appendStep(linked.dir, {
      index: 1,
      ts: new Date().toISOString(),
      action: "must not follow",
    }),
    /ELOOP|symbolic link|too many levels/i,
  );
  assert.equal(await readFile(outside, "utf8"), "");

  const hardLinked = await createSession({ name: "hard-linked-jsonl", workspaceRoot: tmp });
  const hardLinkedPath = path.join(hardLinked.dir, "steps.jsonl");
  await rm(hardLinkedPath);
  await link(outside, hardLinkedPath);
  await assert.rejects(
    appendStep(hardLinked.dir, {
      index: 1,
      ts: new Date().toISOString(),
      action: "must not append",
    }),
    /single-link regular file/,
  );
  assert.equal(await readFile(outside, "utf8"), "");
});

test("session mutations reject symlinked evidence directories", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-session-symlink-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const session = await createSession({ name: "symlink", workspaceRoot: tmp });
  const outside = path.join(tmp, "outside");
  await mkdir(outside);
  await rm(path.join(session.dir, "crashes"), { recursive: true });
  await symlink(outside, path.join(session.dir, "crashes"));
  await assert.rejects(
    recordCrashEvidence(session.dir, {
      signature: "must-not-write",
      stack: "java.lang.IllegalStateException",
      repro_path: [],
    }),
    /session crashes must be a real directory/i,
  );
});

test("private evidence import is bounded and rejects links or concurrent mutation", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-private-copy-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const source = path.join(tmp, "source.log");
  const linkPath = path.join(tmp, "source-link.log");
  const destination = path.join(tmp, "copied.log");
  await writeFile(source, "private evidence", "utf8");
  await symlink(source, linkPath);
  await copyRegularFilePrivate(source, destination, 1024);
  assert.equal(await readFile(destination, "utf8"), "private evidence");
  assert.equal((await stat(destination)).mode & 0o077, 0);
  await assert.rejects(
    copyRegularFilePrivate(linkPath, path.join(tmp, "must-not-copy.log"), 1024),
    /ELOOP|symbolic link|too many levels/i,
  );
  await assert.rejects(
    copyRegularFilePrivate(source, path.join(tmp, "too-small.log"), 2),
    /byte size limit/i,
  );

  const hardLink = path.join(tmp, "source-hard-link.log");
  await link(source, hardLink);
  await assert.rejects(
    copyRegularFilePrivate(source, path.join(tmp, "hard-link-copy.log"), 1024),
    /single-link regular file/i,
  );
  await rm(hardLink);

  const changingSource = path.join(tmp, "changing-source.log");
  const changingDestination = path.join(tmp, "changing-copy.log");
  await writeFile(changingSource, "x".repeat(128 * 1024), "utf8");
  await assert.rejects(
    copyRegularFilePrivate(changingSource, changingDestination, 256 * 1024, {
      onSourceValidated: async () => truncate(changingSource, 1),
    }),
    /changed while it was being copied/i,
  );
  await assert.rejects(access(changingDestination), isMissingPath);
});

test("renderHtml produces self-contained HTML with inlined CSS + status badge", () => {
  const signature = "NullPointerException at LoginActivity.onClick";
  const html = renderHtml({
    meta: {
      id: "abc",
      name: "demo",
      started_at: new Date(Date.now() - 5000).toISOString(),
      ended_at: new Date().toISOString(),
      status: "failed",
      report_language: "en-US",
      extra: {
        platform: "ios",
        device_id: "private-ios-udid",
        password: "must-not-render",
      },
    },
    steps: [
      {
        index: 1,
        ts: new Date().toISOString(),
        action: "tap login",
        result: "ok",
        screenshot: "steps/001.png",
      },
      {
        index: 2,
        ts: new Date().toISOString(),
        action: "tap submit",
        result: "fail",
        notes: "crashed here\nfound NPE",
      },
    ],
    crashes: [
      {
        id: "c1",
        ts: new Date().toISOString(),
        step_index: 2,
        signature,
        signature_version: JAVA_SIGNATURE_VERSION,
        kind: "java",
        stack_path: "crashes/c1.stack.txt",
        repro_path: [1, 2],
        source: firebaseCrashSource(signature, {
          project: "private-project",
          app: "private-app",
          issue: "private-issue-123456",
          event: "private-event-654321",
          occurred: "2026-07-29T01:02:03Z",
        }),
      },
    ],
    summary: "1 crash in 2 steps",
  });
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /<style>[\s\S]*<\/style>/); // inline CSS
  assert.match(html, /FAILED/);
  assert.match(html, /NullPointerException/);
  assert.match(html, /Signature version[\s\S]*java-v2/);
  assert.match(html, /steps\/001\.png/);
  assert.match(html, /crashed here<br>found NPE/);
  assert.match(html, /firebase-crashlytics/);
  assert.match(html, /ref sha256:[a-f0-9]{10}/);
  assert.doesNotMatch(html, /private-project|private-app|private-issue|private-event/);
  assert.match(html, /device_ref_sha256/);
  assert.doesNotMatch(html, /private-ios-udid|password|must-not-render/);
  // no external resources (no <link rel="stylesheet" href=...) or <script src=...
  assert.doesNotMatch(html, /<link[^>]*rel=["']stylesheet/);
  assert.doesNotMatch(html, /<script[^>]*src=/);
});

test("recordCrashEvidence is session-idempotent by source.external_key", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-idempotent-test-"));
  try {
    const session = await createSession({
      name: "remote",
      workspaceRoot: tmp,
      sourceLock: firebaseSourceLock(),
    });
    const source = firebaseCrashSource("111111111111", {
      project: "project",
      app: "app",
      issue: "issue",
      event: "event-1",
      occurred: "2026-07-29T01:02:03Z",
      metrics: { events: 5, users: 2 },
    });
    const [first, retry] = await Promise.all([
      recordCrashEvidence(session.dir, {
        signature: "111111111111",
        signature_version: JAVA_SIGNATURE_VERSION,
        stack: "FATAL EXCEPTION: main\njava.lang.IllegalStateException\n at a.b.C.run(C.kt:1)",
        kind: "java",
        repro_path: [],
        source,
        acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
      }),
      recordCrashEvidence(session.dir, {
        signature: "111111111111",
        signature_version: JAVA_SIGNATURE_VERSION,
        stack: "FATAL EXCEPTION: main\njava.lang.IllegalStateException\n at a.b.C.run(C.kt:1)",
        kind: "java",
        repro_path: [],
        source,
        acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
      }),
    ]);

    const results = [first, retry];
    assert.equal(results.filter((result) => result.deduplicated === false).length, 1);
    assert.equal(results.filter((result) => result.deduplicated === true).length, 1);
    assert.equal(retry.crash.id, first.crash.id);
    assert.equal(retry.crash.signature, "111111111111");
    const crashes = await readCrashes(session.dir);
    assert.equal(crashes.length, 1);
    assert.equal(crashes[0]?.source?.external_key, source.external_key);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("recordCrashEvidence rolls back evidence when the crash index append fails", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-crash-rollback-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const session = await createSession({ name: "rollback", workspaceRoot: tmp });
  const crashIndexPath = path.join(session.dir, "crashes.jsonl");
  const stackPath = path.join(session.dir, "crashes", "c1.stack.txt");
  const logPath = path.join(session.dir, "crashes", "c1.log");
  const logSource = path.join(tmp, "source.log");
  await writeFile(logSource, "full crash log", "utf8");

  await chmod(crashIndexPath, 0o400);
  try {
    await assert.rejects(
      recordCrashEvidence(session.dir, {
        signature: "rollback-signature",
        stack: "canonical stack",
        kind: "java",
        repro_path: [],
        log_full_src: logSource,
      }),
      /EACCES|EPERM|permission denied|operation not permitted/i,
    );
  } finally {
    await chmod(crashIndexPath, 0o600);
  }

  await assert.rejects(access(stackPath), isMissingPath);
  await assert.rejects(access(logPath), isMissingPath);
  assert.equal((await readCrashes(session.dir)).length, 0);

  const retry = await recordCrashEvidence(session.dir, {
    signature: "rollback-signature",
    stack: "canonical stack",
    kind: "java",
    repro_path: [],
    log_full_src: logSource,
  });
  assert.equal(retry.deduplicated, false);
  assert.equal(retry.crash.id, "c1");
  assert.equal(await readFile(stackPath, "utf8"), "canonical stack");
  assert.equal(await readFile(logPath, "utf8"), "full crash log");
  assert.equal((await readCrashes(session.dir)).length, 1);
});

test("firebase-crashlytics evidence requires and obeys the session acquisition route lock", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-source-lock-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const signature = "222222222222";
  const source = firebaseCrashSource(signature);

  const unlocked = await createSession({ name: "unlocked", workspaceRoot: tmp });
  await assert.rejects(
    recordCrashEvidence(unlocked.dir, {
      signature,
      signature_version: JAVA_SIGNATURE_VERSION,
      stack: "canonical stack",
      repro_path: [],
      source,
      acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
    }),
    /requires a session source_lock|requires a locked remote acquisition route/,
  );

  const locked = await createSession({
    name: "locked",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock(),
  });
  await assert.rejects(
    recordCrashEvidence(locked.dir, {
      signature,
      signature_version: JAVA_SIGNATURE_VERSION,
      stack: "canonical stack",
      repro_path: [],
      source,
    }),
    /requires acquisition_route for every crash/,
  );
  await assert.rejects(
    recordCrashEvidence(locked.dir, {
      signature,
      signature_version: JAVA_SIGNATURE_VERSION,
      stack: "canonical stack",
      repro_path: [],
      source,
      acquisition_route: "cloud_logging_mcp",
    }),
    /does not match the session source_lock/,
  );

  const recorded = await recordCrashEvidence(locked.dir, {
    signature,
    signature_version: JAVA_SIGNATURE_VERSION,
    stack: "canonical stack",
    repro_path: [],
    source,
    acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
  });
  assert.equal(recorded.deduplicated, false);
  assert.equal((await readCrashes(locked.dir)).length, 1);
  assert.equal((await readCrashes(unlocked.dir)).length, 0);
});

test("recordCrashEvidence preserves colliding evidence files it did not create", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-crash-collision-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const session = await createSession({ name: "collision", workspaceRoot: tmp });
  const stackPath = path.join(session.dir, "crashes", "c1.stack.txt");
  const logPath = path.join(session.dir, "crashes", "c1.log");
  const logSource = path.join(tmp, "source.log");

  await writeFile(stackPath, "pre-existing stack", { mode: 0o600 });
  await assert.rejects(
    recordCrashEvidence(session.dir, {
      signature: "collision-signature",
      stack: "new stack",
      repro_path: [],
    }),
    /EEXIST|file already exists/i,
  );
  assert.equal(await readFile(stackPath, "utf8"), "pre-existing stack");

  await rm(stackPath);
  await writeFile(logSource, "new log", "utf8");
  await writeFile(logPath, "pre-existing log", { mode: 0o600 });
  await assert.rejects(
    recordCrashEvidence(session.dir, {
      signature: "collision-signature",
      stack: "new stack",
      repro_path: [],
      log_full_src: logSource,
    }),
    /EEXIST|file already exists/i,
  );
  await assert.rejects(access(stackPath), isMissingPath);
  assert.equal(await readFile(logPath, "utf8"), "pre-existing log");
  assert.equal((await readCrashes(session.dir)).length, 0);
});

test("recordCrashEvidence fails closed on a conflicting external_key", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-idempotent-conflict-test-"));
  try {
    const session = await createSession({
      name: "remote",
      workspaceRoot: tmp,
      sourceLock: firebaseSourceLock(),
    });
    const signature = "333333333333";
    const source = firebaseCrashSource(signature, {
      event: "event-1",
    });
    await recordCrashEvidence(session.dir, {
      signature,
      signature_version: JAVA_SIGNATURE_VERSION,
      stack: "first canonical stack",
      kind: "java",
      repro_path: [],
      source,
      acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
    });
    await assert.rejects(
      () => recordCrashEvidence(session.dir, {
        signature,
        signature_version: JAVA_SIGNATURE_VERSION,
        stack: "different canonical stack",
        kind: "native",
        repro_path: [],
        source,
        acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
      }),
      /already archived with different crash evidence/,
    );
    assert.equal((await readCrashes(session.dir)).length, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("recordCrashEvidence rejects an external_key retry with a different app build", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-app-build-conflict-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const session = await createSession({
    name: "remote",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock(),
  });
  const signature = "333333333333";
  const source = firebaseCrashSource(signature, {
    event: "event-1",
    app_build: {
      platform: "android",
      app_id: "com.example.app",
      version: "1.2.3",
      build: "42",
    },
  });
  await recordCrashEvidence(session.dir, {
    signature,
    signature_version: JAVA_SIGNATURE_VERSION,
    stack: "canonical stack",
    kind: "java",
    repro_path: [],
    source,
    acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
  });

  await assert.rejects(
    recordCrashEvidence(session.dir, {
      signature,
      signature_version: JAVA_SIGNATURE_VERSION,
      stack: "canonical stack",
      kind: "java",
      repro_path: [],
      source: {
        ...source,
        app_build: {
          ...source.app_build!,
          build: "43",
        },
      },
      acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
    }),
    /already archived with different crash evidence/,
  );
  assert.equal((await readCrashes(session.dir)).length, 1);
});

test("firebase-crashlytics source requires a complete, signature-bound SHA-256 key", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-firebase-key-test-"));
  try {
    const session = await createSession({
      name: "firebase-key",
      workspaceRoot: tmp,
      sourceLock: firebaseSourceLock(),
    });
    const signature = "444444444444";
    const validSource = firebaseCrashSource(signature);
    const { event: _event, ...missingEvent } = validSource;

    assert.throws(
      () => crashSourceSchema.parse(missingEvent),
      /firebase-crashlytics source requires event/,
    );
    assert.throws(
      () => crashSourceSchema.parse({
        ...validSource,
        external_key: validSource.external_key.toUpperCase(),
      }),
      /64 lowercase SHA-256 hex characters/,
    );
    await assert.rejects(
      () => recordCrashEvidence(session.dir, {
        signature,
        signature_version: JAVA_SIGNATURE_VERSION,
        stack: "canonical stack",
        kind: "java",
        repro_path: [],
        source: { ...validSource, external_key: "0".repeat(64) },
        acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
      }),
      /external_key does not match the normalized source identity.*signature_version.*signature/,
    );
    assert.equal((await readCrashes(session.dir)).length, 0);

    const recorded = await recordCrashEvidence(session.dir, {
      signature,
      signature_version: JAVA_SIGNATURE_VERSION,
      stack: "canonical stack",
      kind: "java",
      repro_path: [],
      source: validSource,
      acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
    });
    assert.equal(recorded.deduplicated, false);
    assert.equal(recorded.crash.source?.external_key, validSource.external_key);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("new firebase crash evidence requires a closed signature_version", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-version-required-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const session = await createSession({
    name: "version-required",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock(),
  });
  const signature = "555555555555";

  await assert.rejects(
    recordCrashEvidence(session.dir, {
      signature,
      stack: "canonical stack",
      kind: "java",
      repro_path: [],
      source: firebaseCrashSource(signature),
      acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
    }),
    /requires signature_version/,
  );
  assert.equal((await readCrashes(session.dir)).length, 0);
});

test("versioned crash evidence requires an exact analyzer fingerprint", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-versioned-fingerprint-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const session = await createSession({
    name: "versioned-fingerprint",
    workspaceRoot: tmp,
  });

  for (const signature of [
    "a".repeat(11),
    "a".repeat(13),
    "A".repeat(12),
    "g".repeat(12),
  ]) {
    await assert.rejects(
      recordCrashEvidence(session.dir, {
        signature,
        signature_version: "java-v2",
        stack: "canonical stack",
        kind: "java",
        repro_path: [],
      }),
      /12-character lowercase hexadecimal analyzer fingerprint/,
    );
  }
  assert.equal((await readCrashes(session.dir)).length, 0);

  await writeFile(
    path.join(session.dir, "crashes.jsonl"),
    `${JSON.stringify({
      id: "c1",
      ts: "2026-07-29T01:02:03Z",
      signature: "NOT-HEX-0000",
      signature_version: "java-v2",
      kind: "java",
      stack_path: "crashes/c1.stack.txt",
      repro_path: [],
    })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    readCrashes(session.dir),
    /12-character lowercase hexadecimal analyzer fingerprint/,
  );
});

test("firebase idempotency identity keeps equal fingerprints in different versions separate", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-versioned-key-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const session = await createSession({
    name: "versioned-key",
    workspaceRoot: tmp,
    sourceLock: firebaseSourceLock(),
  });
  const signature = "777777777777";
  const versions = ["v1", "java-v2"] as const;
  const results = [];

  for (const signatureVersion of versions) {
    results.push(await recordCrashEvidence(session.dir, {
      signature,
      signature_version: signatureVersion,
      stack: "canonical stack",
      kind: "java",
      repro_path: [],
      source: firebaseCrashSource(
        signature,
        { event: "same-event" },
        signatureVersion,
      ),
      acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
    }));
  }

  assert.deepEqual(results.map((result) => result.deduplicated), [false, false]);
  assert.notEqual(
    results[0]?.crash.source?.external_key,
    results[1]?.crash.source?.external_key,
  );
  const crashes = await readCrashes(session.dir);
  assert.equal(crashes.length, 2);
  assert.deepEqual(crashes.map((crash) => crash.signature_version), versions);
});

test("duplicate conflict checks signature_version for provider-defined keys", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-version-conflict-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const session = await createSession({ name: "version-conflict", workspaceRoot: tmp });
  const source: CrashSource = {
    provider: "custom-provider",
    external_key: "same-provider-key",
  };
  await recordCrashEvidence(session.dir, {
    signature: "666666666666",
    signature_version: "v1",
    stack: "canonical stack",
    kind: "native",
    repro_path: [],
    source,
  });

  await assert.rejects(
    recordCrashEvidence(session.dir, {
      signature: "666666666666",
      signature_version: "java-v2",
      stack: "canonical stack",
      kind: "native",
      repro_path: [],
      source,
    }),
    /already archived with different crash evidence/,
  );
  assert.equal((await readCrashes(session.dir)).length, 1);
});

test("readCrashes accepts legacy firebase records only with the historical key", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-legacy-version-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const session = await createSession({ name: "legacy-version", workspaceRoot: tmp });
  const signature = "legacy-fingerprint";
  const legacyRecord = {
    id: "c1",
    ts: "2026-07-29T01:02:03Z",
    signature,
    kind: "java",
    stack_path: "crashes/c1.stack.txt",
    repro_path: [],
    source: legacyFirebaseCrashSource(signature, {
      project: "private-project",
      app: "private-app",
      issue: "private-issue",
      event: "private-event",
    }),
  };
  await writeFile(
    path.join(session.dir, "crashes.jsonl"),
    `${JSON.stringify(legacyRecord)}\n`,
    "utf8",
  );

  const crashes = await readCrashes(session.dir);
  assert.equal(crashes.length, 1);
  assert.equal(crashes[0]?.signature_version, undefined);
  const meta = await loadMeta(session.dir);
  for (const report of [
    renderMarkdown({ meta, steps: [], crashes }),
    renderHtml({ meta, steps: [], crashes }),
  ]) {
    assert.match(report, /Signature version/);
    assert.match(report, /unversioned/);
    assert.doesNotMatch(report, /private-project|private-app|private-issue|private-event/);
  }

  legacyRecord.source.external_key = "0".repeat(64);
  await writeFile(
    path.join(session.dir, "crashes.jsonl"),
    `${JSON.stringify(legacyRecord)}\n`,
    "utf8",
  );
  await assert.rejects(
    readCrashes(session.dir),
    /external_key does not match the normalized source identity/,
  );
});

test("cross-process finalize excludes recordCrashEvidence and makes the session immutable", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-finalize-race-test-"));
  const readyPath = path.join(tmp, "finalizer-ready");
  const releasePath = path.join(tmp, "release-finalizer");
  let child: ReturnType<typeof spawn> | undefined;
  let childExit: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>
    | undefined;
  try {
    const session = await createSession({ name: "finalize-race", workspaceRoot: tmp });
    const sessionsModuleUrl = new URL("./sessions.ts", import.meta.url).href;
    const childScript = `
      import { access, writeFile } from "node:fs/promises";
      import { finalizeSession } from ${JSON.stringify(sessionsModuleUrl)};
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await finalizeSession(process.env.SESSION_DIR, "passed", async () => {
        await writeFile(process.env.READY_PATH, "ready", "utf8");
        while (true) {
          try {
            await access(process.env.RELEASE_PATH);
            break;
          } catch {
            await delay(10);
          }
        }
      });
    `;
    child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", childScript],
      {
        cwd: path.dirname(fileURLToPath(import.meta.url)),
        env: {
          ...process.env,
          SESSION_DIR: session.dir,
          READY_PATH: readyPath,
          RELEASE_PATH: releasePath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    childExit = collectChildExit(child);
    await Promise.race([
      waitForFile(readyPath, 5_000),
      childExit.then(({ code, signal, stderr }) => {
        throw new Error(
          `finalizer exited before acquiring the lock (${code ?? signal}): ${stderr}`,
        );
      }),
    ]);

    let recordSettled = false;
    const recordOutcome = recordCrashEvidence(session.dir, {
      signature: "must-not-be-appended",
      stack: "canonical stack",
      kind: "java",
      repro_path: [],
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    ).finally(() => {
      recordSettled = true;
    });

    await delay(100);
    assert.equal(recordSettled, false, "record_crash must wait for the finalizer lock");
    await writeFile(releasePath, "release", "utf8");

    const exit = await childExit;
    assert.equal(exit.code, 0, exit.stderr);
    const outcome = await recordOutcome;
    assert.ok("error" in outcome);
    assert.match(String(outcome.error), /session is not running \(status=passed\)/);
    assert.equal((await readCrashes(session.dir)).length, 0);

    const endedAt = (await loadMeta(session.dir)).ended_at;
    const retry = await finalizeSession(session.dir, "passed", async (context) => ({
      alreadyFinalized: context.already_finalized,
      endedAt: context.meta.ended_at,
    }));
    assert.equal(retry.context.already_finalized, true);
    assert.equal(retry.value.alreadyFinalized, true);
    assert.equal(retry.value.endedAt, endedAt);
    await assert.rejects(
      () => finalizeSession(session.dir, "failed", async () => undefined),
      /already finalized as passed/,
    );
  } finally {
    await writeFile(releasePath, "release", "utf8").catch(() => undefined);
    if (childExit !== undefined) await childExit.catch(() => undefined);
    else child?.kill();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("session lock has a hard timeout and preserves an unknown lock", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-lock-timeout-test-"));
  try {
    const session = await createSession({ name: "locked", workspaceRoot: tmp });
    const lockDir = path.join(session.dir, ".session-write.lock");
    const ownerPath = path.join(lockDir, "owner.json");
    const unknownOwner = JSON.stringify({ token: "unknown-owner", pid: 999_999 });
    await mkdir(lockDir);
    await writeFile(ownerPath, unknownOwner, "utf8");

    await assert.rejects(
      () => withSessionLock(
        session.dir,
        async () => assert.fail("operation must not run"),
        { timeoutMs: 40, retryMs: 5 },
      ),
      /timed out after 40ms.*not removed automatically/,
    );
    assert.equal(await readFile(ownerPath, "utf8"), unknownOwner);
    await stat(lockDir);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("session lock release rejects linked, oversized, or malformed owner metadata", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-lock-owner-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));

  for (const attack of ["symlink", "hardlink", "oversized", "malformed"] as const) {
    const session = await createSession({ name: `owner-${attack}`, workspaceRoot: tmp });
    const lockDir = path.join(session.dir, ".session-write.lock");
    const ownerPath = path.join(lockDir, "owner.json");
    const outside = path.join(tmp, `outside-${attack}.json`);
    await writeFile(outside, JSON.stringify({ token: "outside" }), "utf8");
    await assert.rejects(
      withSessionLock(session.dir, async () => {
        if (attack === "symlink") {
          await rm(ownerPath);
          await symlink(outside, ownerPath);
        } else if (attack === "hardlink") {
          await rm(ownerPath);
          await link(outside, ownerPath);
        } else if (attack === "oversized") {
          await writeFile(ownerPath, "x".repeat(MAX_SESSION_LOCK_OWNER_BYTES + 1), "utf8");
        } else {
          await writeFile(ownerPath, JSON.stringify({ token: "wrong-shape" }), "utf8");
        }
      }),
      /cannot verify session lock ownership|ownership changed/,
    );
    await stat(lockDir);
  }
});

test("CrashSource is strict, bounded, and validates metrics", () => {
  assert.deepEqual(
    crashSourceSchema.parse({ provider: "custom-provider", external_key: "key" }),
    { provider: "custom-provider", external_key: "key" },
  );
  assert.throws(
    () => crashSourceSchema.parse({
      provider: "custom-provider",
      external_key: "key",
      unexpected: "not allowed",
    }),
    /unrecognized key/i,
  );
  assert.throws(
    () => crashSourceSchema.parse({
      provider: "custom-provider",
      external_key: "key",
      metrics: { users: -1 },
    }),
    /greater than or equal to 0/i,
  );
  assert.throws(
    () => crashSourceSchema.parse({
      provider: "custom-provider",
      external_key: "x".repeat(513),
    }),
    /at most 512 character/i,
  );
});

test("renderHtml escapes HTML in content", () => {
  const html = renderHtml({
    meta: { id: "x", name: "<script>", started_at: new Date().toISOString(), status: "passed" },
    steps: [{ index: 1, ts: new Date().toISOString(), action: "<img onerror=alert(1)>", result: "ok" }],
    crashes: [],
  });
  assert.doesNotMatch(html, /<script>.*<\/script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img onerror/);
});

test("writeHtmlReport writes report.html", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "html-report-test-"));
  try {
    const out = await writeHtmlReport(
      tmp,
      renderHtml({
        meta: { id: "x", name: "t", started_at: new Date().toISOString(), status: "passed" },
        steps: [],
        crashes: [],
      }),
    );
    assert.equal(path.basename(out), "report.html");
    const content = await readFile(out, "utf8");
    assert.match(content, /<!DOCTYPE html>/);
    assert.equal((await stat(out)).mode & 0o077, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for child marker: ${String(error)}`);
      }
      await delay(10);
    }
  }
}

function collectChildExit(child: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}> {
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
}

const OFFICIAL_ACQUISITION_ROUTE = "official_firebase_mcp" as const;
const JAVA_SIGNATURE_VERSION = "java-v2" as const;
const CHILD_VERIFICATION_COMPLETION = {
  schema_version: "crashfix-child-verification/v1" as const,
  artifact_identity_verified: true as const,
  capture_started: true as const,
  capture_stopped: true as const,
  crash_drain_complete: true as const,
  evidence_archive_complete: true as const,
  analyzer_check_complete: true as const,
  assertions_passed: true as const,
};

type SnapshotProvenanceOverrides = Partial<
  Omit<SnapshotProvenance, "source_snapshot_sha256">
>;

function snapshotProvenanceFixture(
  overrides: SnapshotProvenanceOverrides = {},
): SnapshotProvenance {
  const values = {
    manifest_sha256: "0".repeat(64),
    exclusion_policy_sha256: "1".repeat(64),
    dynamic_exclusions_sha256: "2".repeat(64),
    approved_test_fixtures_sha256: EMPTY_APPROVED_TEST_FIXTURES_SHA256,
    approved_test_fixture_count: 0,
    files: 1,
    directories: 1,
    bytes: 1,
    ...overrides,
  };
  const fixtureContext = values.approved_test_fixture_count === 0
    ? {
        schema_version: "crashfix-test-fixture-context/v1",
        enabled: false,
        execution_profile: "none",
        project_classification: "none",
      }
    : {
        schema_version: "crashfix-test-fixture-context/v1",
        enabled: true,
        execution_profile: "local_trusted",
        project_classification: "test",
      };
  const sourceSnapshotSha256 = createHash("sha256")
    .update("crashfix-workspace-source-snapshot/v2\0", "utf8")
    .update(values.manifest_sha256, "utf8").update("\0", "utf8")
    .update(values.exclusion_policy_sha256, "utf8").update("\0", "utf8")
    .update(values.dynamic_exclusions_sha256, "utf8").update("\0", "utf8")
    .update(values.approved_test_fixtures_sha256, "utf8").update("\0", "utf8")
    .update(JSON.stringify(fixtureContext), "utf8").update("\0", "utf8")
    .update(String(values.approved_test_fixture_count), "utf8").update("\0", "utf8")
    .digest("hex");
  return {
    ...values,
    source_snapshot_sha256: sourceSnapshotSha256,
  };
}

async function createPassedVerificationChildren(input: {
  workspaceRoot: string;
  parentSessionId: string;
  artifactSha256: string;
  deviceRefSha256: string;
  planSha256: string;
  targetSignatureVersion: CrashSignatureVersion;
  targetFingerprint: string;
}): Promise<[string, string, string]> {
  const ids: string[] = [];
  for (const run of [1, 2, 3] as const) {
    const child = await createSession({
      name: `verification-child-${run}`,
      workspaceRoot: input.workspaceRoot,
      extra: {
        verification_schema_version: "crashfix-child-verification/v1",
        verification_parent_session_id: input.parentSessionId,
        verification_run: run,
        artifact_sha256: input.artifactSha256,
        device_ref_sha256: input.deviceRefSha256,
        plan_sha256: input.planSha256,
        verification_target_signature_version: input.targetSignatureVersion,
        verification_target_fingerprint: input.targetFingerprint,
        platform: "android",
        type: "real",
      },
    });
    await appendStep(child.dir, {
      index: 1,
      ts: new Date().toISOString(),
      action: "replay verified crash path",
      result: "ok",
    });
    await finalizeSession(
      child.dir,
      "passed",
      async () => undefined,
      { verificationEvidence: CHILD_VERIFICATION_COMPLETION },
    );
    ids.push(child.id);
  }
  return ids as [string, string, string];
}

async function recordCandidateTarget(
  sessionDir: string,
  candidate: {
    artifact_platform: "android" | "ios";
    artifact_app_id: string;
    artifact_version: string;
    artifact_build: string;
  },
  event: string,
): Promise<{ fingerprint: string; signatureVersion: CrashSignatureVersion }> {
  const stack = [
    "Normalized Crash Event",
    "Kind: java",
    "Exception Class: java.lang.IllegalStateException",
    "Frame 0: app.Main.run",
  ].join("\n");
  const identity = computeCanonicalAnalyzerIdentity(stack);
  await recordCrashfixTarget(sessionDir, {
    project: "project",
    app: "app",
    issue: "issue",
    app_build: {
      platform: candidate.artifact_platform,
      app_id: candidate.artifact_app_id,
      version: candidate.artifact_version,
      build: candidate.artifact_build,
    },
  });
  await recordCrashEvidence(sessionDir, {
    signature: identity.fingerprint,
    signature_version: identity.signature_version,
    signature_degraded: false,
    cross_source_comparable: true,
    stack,
    kind: "java",
    repro_path: [],
    source: firebaseCrashSource(identity.fingerprint, {
      event,
      app_build: {
        platform: candidate.artifact_platform,
        app_id: candidate.artifact_app_id,
        version: candidate.artifact_version,
        build: candidate.artifact_build,
      },
    }, identity.signature_version),
    acquisition_route: OFFICIAL_ACQUISITION_ROUTE,
  });
  await recordHighConfidenceAnalysis(sessionDir, identity);
  return {
    fingerprint: identity.fingerprint,
    signatureVersion: identity.signature_version,
  };
}

async function recordHighConfidenceAnalysis(
  sessionDir: string,
  identity: { fingerprint: string; signature_version: CrashSignatureVersion },
): Promise<void> {
  await recordCrashfixAnalysis(sessionDir, {
    schema_version: "crashfix-analysis/v1",
    target_signature_version: identity.signature_version,
    target_fingerprint: identity.fingerprint,
    root_cause_summary: "归档堆栈指向唯一且可重复定位的应用代码故障点。",
    confidence: "high",
    category: "other",
    locations: [],
    remediation_summary: "对故障点实施最小修复，并保留现有行为边界。",
    limitations: ["候选验证状态由独立验证证据派生。"],
  });
}

function firebaseSourceLock(
  acquisitionRoute: "official_firebase_mcp" | "cloud_logging_mcp" = OFFICIAL_ACQUISITION_ROUTE,
) {
  return {
    provider: "firebase-crashlytics" as const,
    acquisition_route: acquisitionRoute,
  };
}

function firebaseCrashSource(
  signature: string,
  overrides: Partial<Omit<CrashSource, "provider" | "external_key">> & {
    external_key?: string;
  } = {},
  signatureVersion: CrashSignatureVersion = JAVA_SIGNATURE_VERSION,
): CrashSource {
  const provider = "firebase-crashlytics";
  const project = overrides.project ?? "project";
  const app = overrides.app ?? "app";
  const issue = overrides.issue ?? "issue";
  const event = overrides.event ?? "event";
  return {
    provider,
    project,
    app,
    issue,
    event,
    external_key: overrides.external_key ?? createHash("sha256")
      .update(
        [provider, project, app, issue, event, signatureVersion, signature].join("\0"),
        "utf8",
      )
      .digest("hex"),
    ...(overrides.occurred !== undefined ? { occurred: overrides.occurred } : {}),
    ...(overrides.metrics !== undefined ? { metrics: overrides.metrics } : {}),
    ...(overrides.app_build !== undefined ? { app_build: overrides.app_build } : {}),
  };
}

function legacyFirebaseCrashSource(
  signature: string,
  overrides: Partial<Omit<CrashSource, "provider" | "external_key">> = {},
): CrashSource {
  const provider = "firebase-crashlytics";
  const project = overrides.project ?? "project";
  const app = overrides.app ?? "app";
  const issue = overrides.issue ?? "issue";
  const event = overrides.event ?? "event";
  return {
    provider,
    project,
    app,
    issue,
    event,
    external_key: createHash("sha256")
      .update([provider, project, app, issue, event, signature].join("\0"), "utf8")
      .digest("hex"),
    ...(overrides.occurred !== undefined ? { occurred: overrides.occurred } : {}),
    ...(overrides.metrics !== undefined ? { metrics: overrides.metrics } : {}),
  };
}
