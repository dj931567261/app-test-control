import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.js";
import { CrashlyticsError } from "./errors.js";
import type {
  CrashEvent,
  CrashProvider,
  ProviderEventQuery,
} from "./model.js";
import { CrashlyticsService } from "./service.js";

function event(id: string, issueId = "issue-1"): CrashEvent {
  return {
    schema_version: "crash-event/v1",
    provider: "firebase-crashlytics",
    project_id: "demo-project",
    firebase_app_id: "demo-app",
    app: {
      platform: "android",
      package_name: "com.example.demo",
      version_name: "1.0.0",
      build_version: "100",
    },
    issue: { id: issueId, title: "Illegal state", type: "crash" },
    event: { id, occurred_at: `2026-07-29T0${id === "event-2" ? 1 : 0}:00:00.000Z` },
    fatal: true,
    kind: "java",
    exception: { class: "java.lang.IllegalStateException" },
    frames: [{ index: 0, symbol: "com.example.Demo.run", app_owned: true }],
    canonical_stack: "java.lang.IllegalStateException\n#0 com.example.Demo.run",
    symbolication: "symbolicated",
    truncated: false,
    fetched_at: "2026-07-29T02:00:00.000Z",
  };
}

class FakeProvider implements CrashProvider {
  readonly kind = "fixture" as const;
  calls: ProviderEventQuery[] = [];

  async listApps(projectId: string) {
    return [
      { project_id: projectId, firebase_app_id: "demo-app", app: { platform: "android" as const } },
      { project_id: projectId, firebase_app_id: "not-allowed", app: { platform: "ios" as const } },
    ];
  }

  async listEvents(query: ProviderEventQuery) {
    this.calls.push(query);
    let items = [event("event-2"), event("event-1")];
    if (query.issueId) items = items.filter((item) => item.issue.id === query.issueId);
    if (query.eventId) items = items.filter((item) => item.event.id === query.eventId);
    if (query.versionName) items = items.filter((item) => item.app.version_name === query.versionName);
    if (query.buildVersion) items = items.filter((item) => item.app.build_version === query.buildVersion);
    return { items };
  }
}

const config = loadConfig({
  CRASHLYTICS_PROVIDER: "cloud_logging",
  CRASHLYTICS_PROJECT_ALLOWLIST: "demo-project",
  CRASHLYTICS_APP_ALLOWLIST: "demo-project=demo-app",
  CRASHLYTICS_MAX_WINDOW_HOURS: "24",
});

function service(provider = new FakeProvider()) {
  return new CrashlyticsService(config, provider, {
    now: () => new Date("2026-07-29T02:00:00.000Z"),
  });
}

test("getContext is local-only and advertises privacy defaults", () => {
  const provider = new FakeProvider();
  const context = service(provider).getContext();
  assert.equal(provider.calls.length, 0);
  assert.equal(context.read_only, true);
  assert.deepEqual((context.privacy as Record<string, unknown>).logs_returned, false);
});

test("listApps filters provider output through project-scoped allowlist", async () => {
  const result = await service().listApps("demo-project");
  assert.equal(result.count, 1);
  assert.equal((result.apps as Array<{ firebase_app_id: string }>)[0]?.firebase_app_id, "demo-app");
});

test("list/get tools produce bounded issue and event results", async () => {
  const instance = service();
  const common = {
    project_id: "demo-project",
    firebase_app_id: "demo-app",
    page_size: 25,
    frame_limit: 80,
  };
  const listed = await instance.listEvents({ ...common, fatal_only: false });
  assert.equal(listed.count, 2);
  const issues = await instance.listIssues({ ...common, fatal_only: false });
  assert.equal(issues.count, 1);
  const selected = await instance.getEvent({
    project_id: "demo-project",
    firebase_app_id: "demo-app",
    event_id: "event-1",
    frame_limit: 80,
  });
  assert.equal(selected.event.id, "event-1");
  const symbolication = await instance.getSymbolicationStatus({
    project_id: "demo-project",
    firebase_app_id: "demo-app",
    issue_id: "issue-1",
    version_name: "1.0.0",
    build_version: "100",
    frame_limit: 80,
  });
  assert.equal((symbolication.symbolication as Record<string, unknown>).status, "symbolicated");
  assert.equal(symbolication.evidence_kind, "frame_symbolication_coverage");
  assert.deepEqual(symbolication.artifact_identity, {
    verified: false,
    reason: "Cloud Logging events do not prove mapping, dSYM, or native-symbol artifact identity",
  });
});

test("symbolication coverage excludes unknown symbols", async () => {
  const provider = new FakeProvider();
  provider.listEvents = async (query) => {
    provider.calls.push(query);
    return {
      items: [{
        ...event("event-1"),
        frames: [{ index: 0, symbol: "???", module: "libgame.so", offset: "42" }],
        symbolication: "unsymbolicated" as const,
      }],
    };
  };
  const result = await service(provider).getSymbolicationStatus({
    project_id: "demo-project",
    firebase_app_id: "demo-app",
    event_id: "event-1",
    frame_limit: 80,
  });
  assert.deepEqual(result.symbolication, {
    status: "unsymbolicated",
    total_frames: 1,
    symbolicated_frames: 0,
  });
});

test("service rejects forbidden app and oversized time ranges before provider call", async () => {
  const provider = new FakeProvider();
  const instance = service(provider);
  await assert.rejects(
    () => instance.listEvents({
      project_id: "demo-project",
      firebase_app_id: "other-app",
      page_size: 25,
      frame_limit: 80,
      fatal_only: false,
    }),
    (error) => error instanceof CrashlyticsError && error.code === "FORBIDDEN_APP",
  );
  await assert.rejects(
    () => instance.listEvents({
      project_id: "demo-project",
      firebase_app_id: "demo-app",
      start_time: "2026-07-27T00:00:00.000Z",
      end_time: "2026-07-29T00:00:00.000Z",
      page_size: 25,
      frame_limit: 80,
      fatal_only: false,
    }),
    (error) => error instanceof CrashlyticsError && error.code === "INVALID_TIME_RANGE",
  );
  assert.equal(provider.calls.length, 0);
});
