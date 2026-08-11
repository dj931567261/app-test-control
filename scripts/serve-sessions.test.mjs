import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  finalizeSession,
  recordCrashEvidence,
  recordCrashfixAnalysis,
  recordCrashfixTarget,
} from "../mcp-servers/report-mcp/dist/sessions.js";
import {
  computeCanonicalAnalyzerIdentity,
} from "../mcp-servers/report-mcp/dist/analyzer-identity.js";
import {
  createSessionViewerServer,
  LOOPBACK_HOST,
  normalizePublicCrashSignatureVersion,
  normalizePublicReportLanguage,
  parseCliOptions,
} from "./serve-sessions.mjs";

const sessionId = "2026-07-29_120000_crashfix-safe";
const englishSessionId = "2026-07-29_120100_report-english";
const legacySessionId = "2026-07-29_120200_report-legacy";
const invalidLanguageSessionId = "2026-07-29_120300_report-invalid-language";
const strictCrashfixSessionId = "2026-07-29_120400_crashfix-strict-viewer";
const verificationChildSessionId = "2026-07-29_120500_devtest-crashfix-verification-1";
const orphanVerificationSessionId = "2026-07-29_120600_devtest-crashfix-orphan";
const invalidVerificationSessionId = "2026-07-29_120700_devtest-invalid-verification";
const englishQuickCrashfixSessionId = "2026-07-29_120800_crashfix-quick-english";
const qaSessionId = "2026-07-29_120900_qa-classified";
const devtestSessionId = "2026-07-29_121000_devtest-classified";
const minimizeSessionId = "2026-07-29_121100_minimize-classified";
const deviceId = "00008030-0011223344556677";
const projectId = "firebase-project-private";
const appId = "1:123456789:ios:private-app";
const issueId = "issue-private-123";
const eventId = "event-private-456";
const signature = "0123456789ab";
const signatureVersion = "java-v2";
const legacySignature = "legacy-archived-id";
const noteSecret = "private-note-token";
const storedReportSecret = "stored-report-must-not-be-served";
const viewerArtifactSha256 = "a".repeat(64);
const viewerDeviceRefSha256 = "b".repeat(64);
const viewerPlanSha256 = "c".repeat(64);
const viewerCanonicalStack = [
  "Normalized Crash Event",
  "Kind: java",
  "Exception Class: java.lang.NullPointerException",
  "Root Cause Class: java.lang.NullPointerException",
  "Frame 0: com.example.viewer.MainActivity.onCreate",
  "Frame 1: android.app.Activity.performCreate",
].join("\n");
const viewerAnalyzerIdentity = computeCanonicalAnalyzerIdentity(viewerCanonicalStack);
const viewerTargetFingerprint = viewerAnalyzerIdentity.fingerprint;
const viewerAppBuild = {
  platform: "android",
  app_id: "com.example.viewer",
  version: "1.0.0",
  build: "42",
};
const viewerPrivateProjectId = "viewer-private-firebase-project";
const viewerPrivateAppId = "1:999999999:android:viewer-private-app";
const viewerPrivateIssueId = "viewer-private-issue";
const viewerPrivateCredentialPath = "/Users/private/viewer-service-account.json";
const maliciousStageAction = "<script>candidate_export-malicious-stage</script>";

let root;
let workspace;
let sessionDir;
let server;
let baseUrl;
let externalKey;

async function writeJson(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

async function requestStatus(url, headers) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    req.once("error", reject);
    req.end();
  });
}

async function makeOutsideSession(dir) {
  await mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, "meta.json"), {
    id: "outside-session",
    name: "outside",
    started_at: "2026-07-29T00:00:00.000Z",
    status: "running",
    extra: { secret: "outside-session-secret" },
  });
  await writeFile(path.join(dir, "steps.jsonl"), "", "utf8");
  await writeFile(path.join(dir, "crashes.jsonl"), "", "utf8");
  await writeFile(path.join(dir, "report.html"), "outside-session-secret", "utf8");
}

async function makeLanguageSession(id, reportLanguage) {
  const dir = path.join(workspace, id);
  await mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, "meta.json"), {
    id,
    name: id.replace(/^\d{4}-\d{2}-\d{2}_\d{6}_/, ""),
    started_at: "2026-07-29T02:00:00.000Z",
    ended_at: "2026-07-29T02:00:01.000Z",
    status: "passed",
    ...(reportLanguage === undefined ? {} : { report_language: reportLanguage }),
  });
  await writeFile(path.join(dir, "steps.jsonl"), "", "utf8");
  await writeFile(path.join(dir, "crashes.jsonl"), "", "utf8");
}

async function makeViewerSession({
  id,
  name = id.replace(/^\d{4}-\d{2}-\d{2}_\d{6}_/, ""),
  startedAt,
  endedAt,
  status = "passed",
  reportLanguage,
  sourceLock,
  crashfixAnalysis,
  extra,
  steps = [],
  crashes = [],
}) {
  const dir = path.join(workspace, id);
  await Promise.all([
    mkdir(path.join(dir, "steps"), { recursive: true }),
    mkdir(path.join(dir, "crashes"), { recursive: true }),
    mkdir(path.join(dir, "logs"), { recursive: true }),
  ]);
  await writeJson(path.join(dir, "meta.json"), {
    id,
    name,
    started_at: startedAt,
    ...(endedAt === undefined ? {} : { ended_at: endedAt }),
    status,
    ...(reportLanguage === undefined ? {} : { report_language: reportLanguage }),
    ...(sourceLock === undefined ? {} : { source_lock: sourceLock }),
    ...(crashfixAnalysis === undefined
      ? {}
      : { crashfix_analysis: crashfixAnalysis }),
    ...(extra === undefined ? {} : { extra }),
  });
  await writeFile(
    path.join(dir, "steps.jsonl"),
    steps.length === 0 ? "" : `${steps.map((step) => JSON.stringify(step)).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    path.join(dir, "crashes.jsonl"),
    crashes.length === 0 ? "" : `${crashes.map((crash) => JSON.stringify(crash)).join("\n")}\n`,
    "utf8",
  );
  return dir;
}

async function bindViewerCrashfixEvidence({
  dir,
  route,
  eventId: firebaseEventId,
  language,
  locations,
}) {
  await recordCrashfixTarget(dir, {
    project: viewerPrivateProjectId,
    app: viewerPrivateAppId,
    issue: viewerPrivateIssueId,
    app_build: viewerAppBuild,
  });
  const externalKey = createHash("sha256")
    .update([
      "firebase-crashlytics",
      viewerPrivateProjectId,
      viewerPrivateAppId,
      viewerPrivateIssueId,
      firebaseEventId,
      viewerAnalyzerIdentity.signature_version,
      viewerAnalyzerIdentity.fingerprint,
    ].join("\0"), "utf8")
    .digest("hex");
  await recordCrashEvidence(dir, {
    signature: viewerAnalyzerIdentity.fingerprint,
    signature_version: viewerAnalyzerIdentity.signature_version,
    signature_degraded: false,
    cross_source_comparable: true,
    stack: viewerCanonicalStack,
    kind: viewerAnalyzerIdentity.kind,
    repro_path: [],
    acquisition_route: route,
    source: {
      provider: "firebase-crashlytics",
      external_key: externalKey,
      project: viewerPrivateProjectId,
      app: viewerPrivateAppId,
      issue: viewerPrivateIssueId,
      event: firebaseEventId,
      occurred: "2026-07-29T02:59:59.000Z",
      app_build: viewerAppBuild,
    },
  });
  const english = language === "en-US";
  await recordCrashfixAnalysis(dir, {
    schema_version: "crashfix-analysis/v1",
    target_signature_version: viewerAnalyzerIdentity.signature_version,
    target_fingerprint: viewerAnalyzerIdentity.fingerprint,
    root_cause_summary: english
      ? "A lifecycle callback dereferences a value before initialization."
      : "生命周期回调在初始化前解引用了对象。",
    confidence: locations.length > 0 ? "high" : "medium",
    category: "null_dereference",
    locations,
    remediation_summary: english
      ? "Initialize the value before entering the callback and add a regression test."
      : "在进入回调前完成初始化，并补充回归测试。",
    limitations: english
      ? ["The quick parent does not bind local source locations or device verification."]
      : ["当前记录只证明根因分析完整，不代表候选或真机验证通过。"],
  });
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "serve-sessions-test-"));
  workspace = path.join(root, "sessions");
  sessionDir = path.join(workspace, sessionId);
  await Promise.all([
    mkdir(path.join(sessionDir, "steps"), { recursive: true }),
    mkdir(path.join(sessionDir, "logs"), { recursive: true }),
    mkdir(path.join(sessionDir, "crashes"), { recursive: true }),
    mkdir(path.join(sessionDir, "source-snapshot"), { recursive: true }),
  ]);

  externalKey = createHash("sha256")
    .update(
      [
        "firebase-crashlytics",
        projectId,
        appId,
        issueId,
        eventId,
        signatureVersion,
        signature,
      ].join("\0"),
      "utf8",
    )
    .digest("hex");

  await writeJson(path.join(sessionDir, "meta.json"), {
    id: sessionId,
    name: `raw name ${deviceId}`,
    started_at: "2026-07-29T01:00:00.000Z",
    ended_at: "2026-07-29T01:00:03.000Z",
    status: "failed",
    report_language: "zh-CN",
    extra: {
      device_id: deviceId,
      project: "/Users/private/source",
      package: "com.private.application",
      token: "meta-private-token",
    },
  });

  const steps = [
    {
      index: 1,
      ts: "2026-07-29T01:00:01.000Z",
      action: `launch device ${deviceId}`,
      result: "ok",
      screenshot: "steps/001.png",
      log_excerpt: "steps/001.log",
      notes: `device=${deviceId}; token=${noteSecret}`,
    },
    {
      index: 2,
      ts: "2026-07-29T01:00:02.000Z",
      action: "malicious source snapshot reference",
      result: "fail",
    },
    {
      index: 3,
      ts: "2026-07-29T01:00:02.100Z",
      action: "symlink evidence",
      result: "fail",
      log_excerpt: "steps/003.log",
    },
    {
      index: 4,
      ts: "2026-07-29T01:00:02.200Z",
      action: "unreferenced symlink directory evidence",
      result: "fail",
    },
    {
      index: 5,
      ts: "2026-07-29T01:00:02.300Z",
      action: "hard-linked evidence",
      result: "fail",
      log_excerpt: "steps/005.log",
    },
  ];
  await writeFile(
    path.join(sessionDir, "steps.jsonl"),
    `${steps.map((step) => JSON.stringify(step)).join("\n")}\n`,
    "utf8",
  );

  const crash = {
    id: "c1",
    ts: "2026-07-29T01:00:02.500Z",
    step_index: 2,
    signature,
    signature_version: signatureVersion,
    kind: "java",
    stack_path: "crashes/c1.stack.txt",
    log_path: "crashes/c1.log",
    repro_path: [1, 2],
    source: {
      provider: "firebase-crashlytics",
      external_key: externalKey,
      project: projectId,
      app: appId,
      issue: issueId,
      event: eventId,
      occurred: "2026-07-29T00:59:59.000Z",
      metrics: {
        eventCount: 7,
        affectedUsers: 3,
        [projectId]: 9,
        unknownMetric: 11,
      },
    },
  };
  const legacyCrash = {
    id: "c2",
    ts: "2026-07-29T01:00:02.750Z",
    signature: legacySignature,
    kind: "java",
    stack_path: "crashes/c2.stack.txt",
    repro_path: [],
  };
  await writeFile(
    path.join(sessionDir, "crashes.jsonl"),
    `${JSON.stringify(crash)}\n${JSON.stringify(legacyCrash)}\n`,
    "utf8",
  );

  await Promise.all([
    writeFile(path.join(sessionDir, "steps", "001.png"), "safe-image", "utf8"),
    writeFile(path.join(sessionDir, "steps", "001.log"), "safe-step-log", "utf8"),
    writeFile(path.join(sessionDir, "steps", "unreferenced.png"), "hidden-image", "utf8"),
    writeFile(path.join(sessionDir, "crashes", "c1.stack.txt"), "safe-stack", "utf8"),
    writeFile(path.join(sessionDir, "crashes", "c1.log"), "safe-crash-log", "utf8"),
    writeFile(path.join(sessionDir, "crashes", "c2.stack.txt"), "legacy-safe-stack", "utf8"),
    writeFile(path.join(sessionDir, "source-snapshot", "source.txt"), "private-source", "utf8"),
    writeFile(path.join(sessionDir, "report.html"), storedReportSecret, "utf8"),
    writeFile(path.join(sessionDir, "report.md"), storedReportSecret, "utf8"),
  ]);

  const outsideEvidence = path.join(root, "outside-evidence");
  await mkdir(outsideEvidence, { recursive: true });
  await writeFile(path.join(outsideEvidence, "evidence.log"), "outside-secret", "utf8");
  await symlink(path.join(outsideEvidence, "evidence.log"), path.join(sessionDir, "steps", "003.log"));
  await symlink(outsideEvidence, path.join(sessionDir, "logs", "linked"));
  await link(path.join(outsideEvidence, "evidence.log"), path.join(sessionDir, "steps", "005.log"));
  await makeLanguageSession(englishSessionId, "en-US");
  await makeLanguageSession(legacySessionId, undefined);
  await makeLanguageSession(
    invalidLanguageSessionId,
    "en-US\"><script>invalid-report-language</script>",
  );
  const strictCrashfixDir = await makeViewerSession({
    id: strictCrashfixSessionId,
    startedAt: "2026-07-29T03:00:00.000Z",
    status: "running",
    reportLanguage: "zh-CN",
    sourceLock: {
      provider: "firebase-crashlytics",
      acquisition_route: "official_firebase_mcp",
    },
    extra: {
      provenance_status: "resolved",
      provenance_mode: "git_release_exact",
      commit: "e".repeat(40),
      requested_mode: "patch",
      requested_workflow: "strict",
      requested_execution_profile: "local_trusted",
      workspace_project_classification: "test",
      firebase_access: "service-account",
      artifact_sha256: viewerArtifactSha256,
      firebase_project_id: viewerPrivateProjectId,
      firebase_app_id: viewerPrivateAppId,
      firebase_issue_id: viewerPrivateIssueId,
      credential_path: viewerPrivateCredentialPath,
      private_note: noteSecret,
    },
    steps: [
      {
        index: 1,
        ts: "2026-07-29T03:00:01.000Z",
        action: "preflight",
        result: "ok",
      },
      {
        index: 2,
        ts: "2026-07-29T03:00:02.000Z",
        action: "source_location",
        result: "ok",
      },
    ],
  });
  await bindViewerCrashfixEvidence({
    dir: strictCrashfixDir,
    route: "official_firebase_mcp",
    eventId: "viewer-private-event-strict",
    language: "zh-CN",
    locations: [{
      path: "app/src/main/java/com/example/viewer/MainActivity.kt",
      line: 42,
      symbol: "MainActivity.onCreate",
    }],
  });
  await finalizeSession(strictCrashfixDir, "failed", async () => undefined);
  await makeViewerSession({
    id: verificationChildSessionId,
    startedAt: "2026-07-29T03:01:00.000Z",
    endedAt: "2026-07-29T03:01:02.000Z",
    reportLanguage: "zh-CN",
    extra: {
      verification_schema_version: "crashfix-child-verification/v1",
      verification_parent_session_id: strictCrashfixSessionId,
      verification_run: 1,
      artifact_sha256: viewerArtifactSha256,
      device_ref_sha256: viewerDeviceRefSha256,
      plan_sha256: viewerPlanSha256,
      verification_target_signature_version: "java-v2",
      verification_target_fingerprint: viewerTargetFingerprint,
      platform: "android",
      type: "real",
      firebase_project_id: viewerPrivateProjectId,
      credential_path: viewerPrivateCredentialPath,
    },
    steps: [{
      index: 1,
      ts: "2026-07-29T03:01:01.000Z",
      action: "回放已确认路径",
      result: "ok",
      notes: noteSecret,
    }],
  });
  await makeViewerSession({
    id: orphanVerificationSessionId,
    startedAt: "2026-07-29T03:02:00.000Z",
    endedAt: "2026-07-29T03:02:02.000Z",
    reportLanguage: "zh-CN",
    extra: {
      verification_schema_version: "crashfix-child-verification/v1",
      verification_parent_session_id: "2026-07-29_000000_crashfix-missing",
      verification_run: 2,
      artifact_sha256: viewerArtifactSha256,
      device_ref_sha256: viewerDeviceRefSha256,
      plan_sha256: viewerPlanSha256,
      verification_target_signature_version: "java-v2",
      verification_target_fingerprint: viewerTargetFingerprint,
      platform: "android",
      type: "real",
    },
  });
  await makeViewerSession({
    id: invalidVerificationSessionId,
    startedAt: "2026-07-29T03:03:00.000Z",
    endedAt: "2026-07-29T03:03:01.000Z",
    reportLanguage: "zh-CN",
    extra: {
      verification_parent_session_id: strictCrashfixSessionId,
      firebase_project_id: viewerPrivateProjectId,
    },
    steps: [{
      index: 1,
      ts: "2026-07-29T03:03:00.500Z",
      action: maliciousStageAction,
      result: "fail",
      notes: noteSecret,
    }],
  });
  const quickCrashfixDir = await makeViewerSession({
    id: englishQuickCrashfixSessionId,
    startedAt: "2026-07-29T03:04:00.000Z",
    status: "running",
    reportLanguage: "en-US",
    sourceLock: {
      provider: "firebase-crashlytics",
      acquisition_route: "cloud_logging_mcp",
    },
    extra: {
      provenance_status: "unavailable",
      requested_mode: "analyze",
      requested_workflow: "quick_test",
      requested_execution_profile: "local_trusted",
      workspace_project_classification: "test",
      firebase_project_id: viewerPrivateProjectId,
      firebase_app_id: viewerPrivateAppId,
      firebase_issue_id: viewerPrivateIssueId,
      credential_path: viewerPrivateCredentialPath,
    },
    steps: [{
      index: 1,
      ts: "2026-07-29T03:04:01.000Z",
      action: "remote_evidence_archival",
      result: "ok",
    }],
  });
  await bindViewerCrashfixEvidence({
    dir: quickCrashfixDir,
    route: "cloud_logging_mcp",
    eventId: "viewer-private-event-quick",
    language: "en-US",
    locations: [],
  });
  await finalizeSession(quickCrashfixDir, "passed", async () => undefined);
  for (const [id, name] of [
    [qaSessionId, "qa-classified"],
    [devtestSessionId, "devtest-classified"],
    [minimizeSessionId, "minimize-classified"],
  ]) {
    await makeViewerSession({
      id,
      name,
      startedAt: "2026-07-29T03:05:00.000Z",
      endedAt: "2026-07-29T03:05:01.000Z",
      extra: { package: "com.example.safe" },
    });
  }
  await makeOutsideSession(path.join(root, "outside-session"));

  server = createSessionViewerServer({ workspace });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  assert.equal(address.address, LOOPBACK_HOST);
  baseUrl = `http://${LOOPBACK_HOST}:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

test("CLI 固定监听 loopback，并拒绝 --host 覆盖", () => {
  const parsed = parseCliOptions([], {});
  assert.equal(parsed.host, LOOPBACK_HOST);
  assert.equal(parsed.port, 7321);
  assert.throws(
    () => parseCliOptions(["--host", "0.0.0.0"], {}),
    /loopback-only/,
  );
  assert.throws(
    () => parseCliOptions(["--host=localhost"], {}),
    /loopback-only/,
  );
});

test("公开 crash 版本只允许闭合集合，缺失或非法值显示 unversioned", () => {
  for (const version of ["v1", "java-v2", "ios-v2"]) {
    assert.equal(normalizePublicCrashSignatureVersion(version), version);
  }
  for (const value of [undefined, null, "future-v3", "<script>bad</script>"]) {
    assert.equal(normalizePublicCrashSignatureVersion(value), "unversioned");
  }
});

test("公开报告语言只允许闭合中英文值，缺失或非法值不透传", () => {
  assert.equal(normalizePublicReportLanguage("zh-CN"), "zh-CN");
  assert.equal(normalizePublicReportLanguage("en-US"), "en-US");
  for (const value of [
    undefined,
    null,
    "zh",
    "en",
    "en-US\"><script>invalid-report-language</script>",
  ]) {
    assert.equal(normalizePublicReportLanguage(value), undefined);
  }
});

test("Session 类型保守分类，CrashFix 控制字段和阶段使用闭合集合", async () => {
  const response = await fetch(`${baseUrl}/api/sessions`);
  assert.equal(response.status, 200);
  const text = await response.text();
  const body = JSON.parse(text);
  const sessions = new Map(body.sessions.map((session) => [session.id, session]));

  const strict = sessions.get(strictCrashfixSessionId);
  assert.equal(strict.session_type, "crashfix");
  assert.equal(strict.acquisition_route, "official_firebase_mcp");
  assert.equal(strict.workflow, "strict");
  assert.equal(strict.mode, "patch");
  assert.equal(strict.current_stage, "source_location");
  assert.equal(strict.report_language, "zh-CN");
  assert.deepEqual(strict.verification_children, [{
    session_id: verificationChildSessionId,
    verification_run: 1,
  }]);
  assert.equal(strict.verification_runs, undefined);
  assert.equal(strict.verified, undefined);

  const child = sessions.get(verificationChildSessionId);
  assert.equal(child.session_type, "crashfix_verification");
  assert.equal(child.verification_parent_session_id, strictCrashfixSessionId);
  assert.equal(child.verification_run, 1);

  const orphan = sessions.get(orphanVerificationSessionId);
  assert.equal(orphan.session_type, "crashfix_verification");
  assert.equal(orphan.verification_parent_session_id, undefined);
  assert.equal(orphan.verification_run, undefined);
  assert.equal(sessions.get(invalidVerificationSessionId).session_type, "other");
  assert.equal(sessions.get(invalidVerificationSessionId).current_stage, undefined);

  const quick = sessions.get(englishQuickCrashfixSessionId);
  assert.equal(quick.session_type, "crashfix");
  assert.equal(quick.acquisition_route, "cloud_logging_mcp");
  assert.equal(quick.workflow, "quick_test");
  assert.equal(quick.mode, "analyze");
  assert.equal(quick.current_stage, "remote_evidence_archival");
  assert.equal(quick.report_language, "en-US");

  assert.equal(sessions.get(qaSessionId).session_type, "qa");
  assert.equal(sessions.get(devtestSessionId).session_type, "devtest");
  assert.equal(sessions.get(minimizeSessionId).session_type, "minimize");
  // A crashfix-looking name or remote crash record is insufficient without
  // the closed source_lock + provenance controls.
  assert.equal(sessions.get(sessionId).session_type, "other");

  for (const secret of [
    viewerPrivateProjectId,
    viewerPrivateAppId,
    viewerPrivateIssueId,
    viewerPrivateCredentialPath,
    viewerArtifactSha256,
    viewerDeviceRefSha256,
    viewerPlanSha256,
    noteSecret,
    maliciousStageAction,
  ]) {
    assert.equal(text.includes(secret), false, `session list must not expose ${secret}`);
  }
});

test("CrashFix 详情 API 只增加安全派生字段，不返回 source_lock、raw extra 或 notes", async () => {
  const response = await fetch(`${baseUrl}/api/sessions/${strictCrashfixSessionId}`);
  assert.equal(response.status, 200);
  const text = await response.text();
  const body = JSON.parse(text);

  assert.equal(body.meta.session_type, "crashfix");
  assert.equal(body.meta.acquisition_route, "official_firebase_mcp");
  assert.equal(body.meta.workflow, "strict");
  assert.equal(body.meta.mode, "patch");
  assert.equal(body.meta.current_stage, "source_location");
  assert.deepEqual(body.meta.crashfix_analysis, {
    schema_version: "crashfix-analysis/v1",
    target_signature_version: viewerAnalyzerIdentity.signature_version,
    target_fingerprint: viewerAnalyzerIdentity.fingerprint,
    root_cause_summary: "生命周期回调在初始化前解引用了对象。",
    confidence: "high",
    category: "null_dereference",
    locations: [{
      path: "app/src/main/java/com/example/viewer/MainActivity.kt",
      line: 42,
      symbol: "MainActivity.onCreate",
    }],
    remediation_summary: "在进入回调前完成初始化，并补充回归测试。",
    limitations: ["当前记录只证明根因分析完整，不代表候选或真机验证通过。"],
  });
  assert.equal("evidence_set_sha256" in body.meta.crashfix_analysis, false);
  assert.equal(body.steps[0].notes, undefined);

  for (const secret of [
    viewerPrivateProjectId,
    viewerPrivateAppId,
    viewerPrivateIssueId,
    viewerPrivateCredentialPath,
    viewerArtifactSha256,
    noteSecret,
    "source_lock",
    "evidence_set_sha256",
    "firebase_project_id",
    "credential_path",
  ]) {
    assert.equal(text.includes(secret), false, `detail API must not expose ${secret}`);
  }

  const maliciousResponse = await fetch(
    `${baseUrl}/api/sessions/${invalidVerificationSessionId}`,
  );
  assert.equal(maliciousResponse.status, 200);
  const maliciousBody = await maliciousResponse.json();
  assert.equal(maliciousBody.meta.session_type, "other");
  assert.equal(maliciousBody.meta.current_stage, undefined);
  assert.equal(maliciousBody.steps[0].action, maliciousStageAction);
  assert.equal(maliciousBody.steps[0].notes, undefined);
});

test("首页提供类型筛选、Firebase 徽标、中英文卡片文案和可点击父子关系", async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<select id="type">/);
  for (const type of [
    "crashfix",
    "crashfix_verification",
    "qa",
    "devtest",
    "minimize",
    "other",
  ]) {
    assert.match(html, new RegExp(`option value="${type}"`));
  }
  assert.match(html, /s\.session_type !== tp/);
  assert.match(html, /🔥 Firebase CrashFix/);
  assert.match(html, /进行中/);
  assert.match(html, /RUNNING/);
  assert.match(html, /阶段=/);
  assert.match(html, /stage=/);
  assert.match(html, /data-related-id/);
  assert.match(html, /select\(el\.dataset\.relatedId\)/);
});

test("session API 只返回公开脱敏视图", async () => {
  const response = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
  assert.equal(response.status, 200);
  const text = await response.text();
  const body = JSON.parse(text);

  for (const secret of [
    deviceId,
    noteSecret,
    "meta-private-token",
    "/Users/private/source",
    projectId,
    appId,
    issueId,
    eventId,
    externalKey,
    "unknownMetric",
  ]) {
    assert.equal(text.includes(secret), false, `API must not expose ${secret}`);
  }
  assert.deepEqual(body.meta.extra, {
    device_ref_sha256: createHash("sha256").update(deviceId, "utf8").digest("hex"),
    package: "com.private.application",
  });
  assert.equal(body.meta.session_type, "other");
  assert.equal(body.meta.report_language, "zh-CN");
  assert.equal(body.meta.name, "crashfix-safe");
  assert.equal(body.steps[0].notes, undefined);
  assert.match(body.steps[0].action, /\[REDACTED_DEVICE\]/);
  assert.equal(body.steps[1].log_excerpt, undefined);
  assert.equal(body.crashes[0].signature_version, signatureVersion);
  assert.equal(body.crashes[1].signature, legacySignature);
  assert.equal(body.crashes[1].signature_version, "unversioned");
  assert.deepEqual(body.crashes[0].source, {
    provider: "firebase-crashlytics",
    external_key_ref: `sha256:${createHash("sha256")
      .update(externalKey, "utf8")
      .digest("hex")
      .slice(0, 10)}`,
    occurred: "2026-07-29T00:59:59.000Z",
    metrics: { eventCount: 7, affectedUsers: 3 },
  });
});

test("session 列表不暴露 workspace 绝对路径", async () => {
  const response = await fetch(`${baseUrl}/api/sessions`);
  assert.equal(response.status, 200);
  const text = await response.text();
  const body = JSON.parse(text);
  assert.equal(text.includes(root), false);
  assert.equal(body.workspace, undefined);
  assert.deepEqual(
    new Set(body.sessions.map((session) => session.id)),
    new Set([
      sessionId,
      englishSessionId,
      legacySessionId,
      strictCrashfixSessionId,
      verificationChildSessionId,
      orphanVerificationSessionId,
      invalidVerificationSessionId,
      englishQuickCrashfixSessionId,
      qaSessionId,
      devtestSessionId,
      minimizeSessionId,
    ]),
  );
  assert.equal(
    body.sessions.some((session) => session.id === invalidLanguageSessionId),
    false,
  );
});

test("拒绝非 loopback Host 和浏览器 Origin", async () => {
  assert.equal(
    await requestStatus(`${baseUrl}/api/sessions`, { host: "attacker.example" }),
    403,
  );

  const badOrigin = await fetch(`${baseUrl}/api/sessions`, {
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(badOrigin.status, 403);
});

test("report.html 和 report.md 动态生成脱敏报告，而非返回落盘原文", async () => {
  for (const extension of ["html", "md"]) {
    const response = await fetch(`${baseUrl}/s/${sessionId}/report.${extension}`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes(storedReportSecret), false);
    assert.equal(text.includes(deviceId), false);
    assert.equal(text.includes(noteSecret), false);
    assert.equal(text.includes("meta-private-token"), false);
    assert.equal(text.includes("/Users/private/source"), false);
    assert.equal(text.includes(projectId), false);
    assert.equal(text.includes(appId), false);
    assert.equal(text.includes(issueId), false);
    assert.equal(text.includes(eventId), false);
    assert.equal(text.includes(externalKey), false);
    assert.match(text, /firebase-crashlytics/);
    assert.match(
      text,
      new RegExp(
        createHash("sha256").update(externalKey, "utf8").digest("hex").slice(0, 10),
      ),
    );
    assert.match(text, /java-v2/);
    assert.match(text, /unversioned/);
    assert.match(text, /com\.private\.application/);
    assert.match(
      text,
      new RegExp(createHash("sha256").update(deviceId, "utf8").digest("hex")),
    );
    assert.match(text, /会话|步骤/);
    if (extension === "html") {
      assert.match(text, /<html lang="zh-CN">/);
    }
  }
});

test("动态报告保持显式英文 session 语言", async () => {
  const apiResponse = await fetch(`${baseUrl}/api/sessions/${englishSessionId}`);
  assert.equal(apiResponse.status, 200);
  const apiBody = await apiResponse.json();
  assert.equal(apiBody.meta.report_language, "en-US");

  for (const extension of ["html", "md"]) {
    const response = await fetch(`${baseUrl}/s/${englishSessionId}/report.${extension}`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /Session|Steps/);
    if (extension === "html") {
      assert.match(text, /<html lang="en-US">/);
    }
  }
});

test("显式英文 CrashFix Session 的动态报告继续使用英文且不返回 Firebase 私有字段", async () => {
  const response = await fetch(
    `${baseUrl}/s/${englishQuickCrashfixSessionId}/report.html`,
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<html lang="en-US">/);
  assert.match(html, /PASSED/);
  assert.match(html, /remote_evidence_archival/);
  assert.match(html, /Root cause analysis/);
  assert.match(html, /Repair status/);
  assert.match(html, /No candidate prepared/);
  assert.match(html, /Strict verification not completed \(3\/3\)/);
  assert.match(html, /A lifecycle callback dereferences a value before initialization/);
  assert.match(html, /Initialize the value before entering the callback/);
  assert.match(html, /The quick parent does not bind local source locations/);
  for (const secret of [
    viewerPrivateProjectId,
    viewerPrivateAppId,
    viewerPrivateIssueId,
    viewerPrivateCredentialPath,
  ]) {
    assert.equal(html.includes(secret), false);
  }
  assert.equal(html.includes("evidence_set_sha256"), false);
});

test("strict CrashFix 动态报告展示中文根因、相对位置、修复建议和限制", async () => {
  for (const extension of ["html", "md"]) {
    const response = await fetch(
      `${baseUrl}/s/${strictCrashfixSessionId}/report.${extension}`,
    );
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /根因分析/);
    assert.match(text, /修复状态/);
    assert.match(text, /尚未生成候选/);
    assert.match(text, /尚未完成 3\/3 严格验证/);
    assert.match(text, /尚未导出候选/);
    assert.match(text, /生命周期回调在初始化前解引用了对象/);
    assert.match(text, /app\/src\/main\/java\/com\/example\/viewer\/MainActivity\.kt/);
    assert.match(text, /在进入回调前完成初始化，并补充回归测试/);
    assert.match(text, /当前记录只证明根因分析完整，不代表候选或真机验证通过/);
    for (const secret of [
      viewerPrivateProjectId,
      viewerPrivateAppId,
      viewerPrivateIssueId,
      "viewer-private-event-strict",
      viewerPrivateCredentialPath,
      "evidence_set_sha256",
    ]) {
      assert.equal(text.includes(secret), false, `${extension} leaked ${secret}`);
    }
  }
});

test("缺失报告语言的旧 session 由 renderer 默认生成中文", async () => {
  for (const extension of ["html", "md"]) {
    const response = await fetch(`${baseUrl}/s/${legacySessionId}/report.${extension}`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /会话|步骤/);
    if (extension === "html") {
      assert.match(text, /<html lang="zh-CN">/);
    }
  }
});

test("非法报告语言既不公开也不进入动态 renderer", async () => {
  const response = await fetch(`${baseUrl}/api/sessions/${invalidLanguageSessionId}`);
  assert.equal(response.status, 404);
  assert.equal((await response.text()).includes("invalid-report-language"), false);
});

test("静态接口只提供报告引用的截图和日志证据", async () => {
  const allowed = new Map([
    ["steps/001.png", "safe-image"],
    ["steps/001.log", "safe-step-log"],
    ["crashes/c1.stack.txt", "safe-stack"],
    ["crashes/c1.log", "safe-crash-log"],
    ["crashes/c2.stack.txt", "legacy-safe-stack"],
  ]);
  for (const [relative, expected] of allowed) {
    const response = await fetch(`${baseUrl}/s/${sessionId}/${relative}`);
    assert.equal(response.status, 200, relative);
    assert.equal(await response.text(), expected);
  }

  for (const relative of [
    "meta.json",
    "steps.jsonl",
    "crashes.jsonl",
    ".session-write.lock/owner.json",
    "source-snapshot/source.txt",
    "steps/unreferenced.png",
    "logs/linked/evidence.log",
  ]) {
    const response = await fetch(`${baseUrl}/s/${sessionId}/${relative}`);
    assert.notEqual(response.status, 200, relative);
  }
});

test("静态接口拒绝被记录引用的 symlink 和 hardlink", async () => {
  for (const relative of [
    "steps/003.log",
    "steps/005.log",
  ]) {
    const response = await fetch(`${baseUrl}/s/${sessionId}/${relative}`);
    assert.equal(response.status, 404, relative);
    assert.equal((await response.text()).includes("outside-secret"), false);
  }
});

test("API、报告和静态路由都拒绝编码 session id 穿越", async () => {
  const encodedTraversal = "%2e%2e%2foutside-session";
  const routes = [
    `/api/sessions/${encodedTraversal}`,
    `/s/${encodedTraversal}/report.html`,
    `/s/${encodedTraversal}/meta.json`,
  ];
  for (const route of routes) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 400, route);
    assert.equal((await response.text()).includes("outside-session-secret"), false);
  }
});

test("静态证据路径拒绝编码 traversal", async () => {
  const response = await fetch(
    `${baseUrl}/s/${sessionId}/steps/%2e%2e%2fmeta.json`,
  );
  assert.notEqual(response.status, 200);
  assert.equal((await response.text()).includes(deviceId), false);
});
