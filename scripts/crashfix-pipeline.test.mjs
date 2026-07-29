import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeSession } from "../mcp-servers/analyzer-mcp/src/analyze.ts";
import { analyzeCrashEvent } from "../mcp-servers/analyzer-mcp/src/crash-event.ts";
import { createServiceFromEnvironment } from "../mcp-servers/crashlytics-mcp/src/runtime.ts";
import { renderMarkdown } from "../mcp-servers/report-mcp/src/report.ts";
import {
  createSession,
  loadMeta,
  readCrashes,
  recordCrashEvidence,
} from "../mcp-servers/report-mcp/src/sessions.ts";

test("CrashFix fixture pipeline normalizes, fingerprints, archives and deduplicates one event", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "crashfix-pipeline-"));
  try {
    const projectId = "demo-project";
    const appId = "1:1234567890:android:abc123";
    const issueId = "issue-private-123";
    const eventId = "event-private-456";
    const fixturePath = path.join(temporaryRoot, "events.fixture.json");
    await writeFile(fixturePath, JSON.stringify({
      schema_version: "crashlytics-fixture/v1",
      apps: [{
        project_id: projectId,
        firebase_app_id: appId,
        platform: "android",
        package_name: "com.example.demo",
      }],
      events: [{
        resource: { labels: { project_id: projectId, firebase_app_id: appId } },
        jsonPayload: {
          platform: "ANDROID",
          bundleOrPackage: "com.example.demo",
          eventId,
          eventTime: "2026-07-29T01:00:00Z",
          issue: { id: issueId, type: "FATAL" },
          issueTitle: "java.lang.IllegalStateException",
          version: { displayVersion: "2.4.0", buildVersion: "240" },
          exceptions: [{
            type: "java.lang.IllegalStateException",
            frames: [{
              function: "com.example.demo.HomeViewModel.load",
              file: "/Users/private-user/repo/app/src/main/HomeViewModel.kt",
              line: 42,
              blamed: true,
            }],
          }],
        },
      }],
    }), { mode: 0o600 });

    const service = createServiceFromEnvironment({
      CRASHLYTICS_PROVIDER: "fixture",
      CRASHLYTICS_PROJECT_ALLOWLIST: projectId,
      CRASHLYTICS_APP_ALLOWLIST: `${projectId}=${appId}`,
      CRASHLYTICS_FIXTURE_PATH: fixturePath,
      CRASHLYTICS_MAX_WINDOW_HOURS: "24",
    });
    const event = await service.getEvent({
      project_id: projectId,
      firebase_app_id: appId,
      event_id: eventId,
      start_time: "2026-07-29T00:00:00Z",
      end_time: "2026-07-29T02:00:00Z",
      frame_limit: 80,
    });
    assert.equal(event.issue.id, issueId);
    assert.equal(event.kind, "java");
    assert.equal(event.app.build_version, "240");
    assert.doesNotMatch(event.frames[0]?.file ?? "", /private-user/);

    const analysis = analyzeCrashEvent(event);
    assert.match(analysis.fingerprint, /^[a-f0-9]{12}$/);
    assert.match(analysis.canonical_stack, /^Normalized Crash Event/m);
    assert.equal(analysis.signature_degraded, false);
    assert.equal(analysis.cross_source_comparable, true);

    const session = await createSession({
      name: "crashfix-e2e",
      workspaceRoot: path.join(temporaryRoot, "sessions"),
      extra: { origin: "remote", raw_evidence_archived: false },
    });
    const externalKey = createHash("sha256")
      .update([
        event.provider,
        event.project_id,
        event.firebase_app_id,
        event.issue.id,
        event.event.id,
        analysis.fingerprint,
      ].join("\0"), "utf8")
      .digest("hex");
    const source = {
      provider: event.provider,
      external_key: externalKey,
      project: event.project_id,
      app: event.firebase_app_id,
      issue: event.issue.id,
      event: event.event.id,
      occurred: event.event.occurred_at,
    };
    const first = await recordCrashEvidence(session.dir, {
      signature: analysis.fingerprint,
      stack: analysis.canonical_stack,
      kind: analysis.kind,
      repro_path: [],
      source,
    });
    const retry = await recordCrashEvidence(session.dir, {
      signature: analysis.fingerprint,
      stack: analysis.canonical_stack,
      kind: analysis.kind,
      repro_path: [],
      source,
    });
    assert.equal(first.deduplicated, false);
    assert.equal(retry.deduplicated, true);

    const sessionAnalysis = await analyzeSession(session.dir);
    assert.equal(sessionAnalysis.total, 1);
    assert.equal(sessionAnalysis.unique, 1);
    assert.equal(sessionAnalysis.groups[0]?.fingerprint, analysis.fingerprint);
    assert.equal(sessionAnalysis.groups[0]?.sources?.[0]?.external_key, externalKey);

    const crashes = await readCrashes(session.dir);
    const markdown = renderMarkdown({
      meta: await loadMeta(session.dir),
      steps: [],
      crashes,
      summary: "CrashFix fixture contract pipeline",
    });
    assert.match(markdown, /firebase-crashlytics/);
    assert.match(markdown, /ref sha256:[a-f0-9]{10}/);
    assert.doesNotMatch(markdown, new RegExp([
      projectId,
      appId,
      issueId,
      eventId,
      externalKey,
    ].map(escapeRegExp).join("|")));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
