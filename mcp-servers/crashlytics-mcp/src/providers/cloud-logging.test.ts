import assert from "node:assert/strict";
import test from "node:test";

import { CLOUD_LOGGING_ENDPOINT } from "../constants.js";
import { CrashlyticsError } from "../errors.js";
import {
  buildLoggingFilter,
  CloudLoggingProvider,
  type CloudLoggingRequest,
  type CloudLoggingRequester,
} from "./cloud-logging.js";

function query() {
  return {
    projectId: "demo-project",
    appId: "demo-app",
    startTime: "2026-07-28T00:00:00.000Z",
    endTime: "2026-07-29T00:00:00.000Z",
    pageSize: 10,
    frameLimit: 10,
  };
}

function loggingEntry(): Record<string, unknown> {
  return {
    insertId: "event-1",
    timestamp: "2026-07-29T00:00:00Z",
    resource: {
      labels: { project_id: "demo-project", firebase_app_id: "demo-app" },
    },
    jsonPayload: {
      issue_id: "issue-1",
      platform: "android",
      fatal: true,
      event_type: "crash",
      exception: { class: "java.lang.IllegalStateException" },
      frames: [{ symbol: "com.example.App.run", app_owned: true }],
    },
  };
}

test("Cloud Logging request always uses the fixed endpoint and bounded body", async () => {
  const calls: CloudLoggingRequest[] = [];
  const requester: CloudLoggingRequester = {
    async request(input) {
      calls.push(input);
      return { entries: [loggingEntry()], nextPageToken: "next" };
    },
  };
  const provider = new CloudLoggingProvider({
    allowedApps: [{ projectId: "demo-project", appId: "demo-app" }],
    requestTimeoutMs: 1_000,
    maxRetries: 0,
    requester,
  });
  const page = await provider.listEvents(query());
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, CLOUD_LOGGING_ENDPOINT);
  assert.deepEqual(calls[0]?.body.resourceNames, ["projects/demo-project"]);
  assert.equal(calls[0]?.body.pageSize, 10);
  assert.equal(page.items[0]?.event.id, "event-1");
  assert.equal(page.nextPageToken, "next");
});

test("Cloud Logging rejects responses larger than the requested event page", async () => {
  const provider = new CloudLoggingProvider({
    allowedApps: [{ projectId: "demo-project", appId: "demo-app" }],
    requestTimeoutMs: 1_000,
    maxRetries: 0,
    requester: {
      request: async () => ({ entries: [loggingEntry(), loggingEntry()] }),
    },
  });
  await assert.rejects(
    () => provider.listEvents({ ...query(), pageSize: 1 }),
    (error) => {
      assert.ok(error instanceof CrashlyticsError);
      assert.equal(error.code, "UPSTREAM_ERROR");
      assert.deepEqual(error.details, { entries_received: 2, page_size: 1 });
      return true;
    },
  );
});

test("filter escapes literals and never accepts a configurable origin", () => {
  const filter = buildLoggingFilter({
    ...query(),
    projectId: 'demo-project" OR logName="evil',
    appId: 'app"\\id',
    issueId: 'issue"id',
  });
  assert.match(
    filter,
    /^logName="projects\/demo-project\\" OR logName=\\"evil\/logs\/firebasecrashlytics\.googleapis\.com%2Fevents"/,
  );
  assert.match(filter, /app\\"\\\\id/);
  assert.match(filter, /issue\\"id/);
  assert.match(filter, /jsonPayload\.issue\.id="issue\\"id"/);
  assert.doesNotMatch(filter, /resource\.type|https?:/);
});

test("official camelCase entries are accepted and malformed entries fail closed", async () => {
  const official = {
    resource: {
      labels: { project_id: "demo-project", firebase_app_id: "demo-app" },
    },
    jsonPayload: {
      platform: "ANDROID",
      bundleOrPackage: "com.example.app",
      eventId: "official-event",
      eventTime: "2026-07-28T12:00:00Z",
      issue: { id: "official-issue", type: "FATAL" },
      issueTitle: "IllegalStateException",
      version: { displayVersion: "1.0", buildVersion: "10" },
      exceptions: [{
        type: "java.lang.IllegalStateException",
        frames: [{ symbol: "com.example.App.run" }],
      }],
    },
  };
  const validProvider = new CloudLoggingProvider({
    allowedApps: [{ projectId: "demo-project", appId: "demo-app" }],
    requestTimeoutMs: 1_000,
    maxRetries: 0,
    requester: { request: async () => ({ entries: [official] }) },
  });
  const valid = await validProvider.listEvents(query());
  assert.equal(valid.items[0]?.event.id, "official-event");
  assert.equal(valid.items[0]?.app.build_version, "10");

  const invalidProvider = new CloudLoggingProvider({
    allowedApps: [{ projectId: "demo-project", appId: "demo-app" }],
    requestTimeoutMs: 1_000,
    maxRetries: 0,
    requester: { request: async () => ({ entries: [{ jsonPayload: { eventId: "broken" } }] }) },
  });
  await assert.rejects(
    () => invalidProvider.listEvents(query()),
    (error) => {
      assert.ok(error instanceof CrashlyticsError);
      assert.equal(error.code, "UPSTREAM_ERROR");
      assert.deepEqual(error.details, { entries_received: 1, entries_rejected: 1 });
      return true;
    },
  );
});

test("normalized occurrence time is rechecked against the requested window", async () => {
  const delayed = loggingEntry();
  delayed.timestamp = "2026-07-28T12:00:00Z";
  (delayed.jsonPayload as Record<string, unknown>).event_time = "2020-01-01T00:00:00Z";
  const provider = new CloudLoggingProvider({
    allowedApps: [{ projectId: "demo-project", appId: "demo-app" }],
    requestTimeoutMs: 1_000,
    maxRetries: 0,
    requester: { request: async () => ({ entries: [delayed] }) },
  });

  const page = await provider.listEvents(query());
  assert.deepEqual(page.items, []);
});

test("429 and 5xx receive bounded retries", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const provider = new CloudLoggingProvider({
    allowedApps: [],
    requestTimeoutMs: 1_000,
    maxRetries: 2,
    requester: {
      async request() {
        attempts += 1;
        if (attempts === 1) throw { response: { status: 429 } };
        if (attempts === 2) throw { response: { status: 503 } };
        return { entries: [] };
      },
    },
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
  });
  await provider.listEvents(query());
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [100, 200]);
});

test("non-retryable upstream errors expose only stable status metadata", async () => {
  const provider = new CloudLoggingProvider({
    allowedApps: [],
    requestTimeoutMs: 1_000,
    maxRetries: 3,
    requester: {
      async request() {
        throw {
          response: { status: 403, data: { token: "must-not-leak" } },
          message: "secret upstream body",
        };
      },
    },
    sleep: async () => {},
  });
  await assert.rejects(
    () => provider.listEvents(query()),
    (error) => {
      assert.ok(error instanceof CrashlyticsError);
      assert.equal(error.code, "UPSTREAM_ERROR");
      assert.deepEqual(error.details, { status: 403 });
      assert.doesNotMatch(error.message, /secret|token/);
      return true;
    },
  );
});

test("requests have a hard timeout even for a hanging requester", async () => {
  const provider = new CloudLoggingProvider({
    allowedApps: [],
    requestTimeoutMs: 25,
    maxRetries: 0,
    requester: { request: async () => new Promise(() => {}) },
  });
  await assert.rejects(
    () => provider.listEvents(query()),
    (error) => error instanceof CrashlyticsError && error.code === "UPSTREAM_TIMEOUT",
  );
});

test("transport timeout codes are normalized and retried within the bound", async () => {
  let attempts = 0;
  const provider = new CloudLoggingProvider({
    allowedApps: [],
    requestTimeoutMs: 1_000,
    maxRetries: 1,
    requester: {
      async request() {
        attempts += 1;
        throw Object.assign(new Error("request included secret diagnostics"), {
          code: "ETIMEDOUT",
        });
      },
    },
    sleep: async () => {},
  });
  await assert.rejects(
    () => provider.listEvents(query()),
    (error) => {
      assert.ok(error instanceof CrashlyticsError);
      assert.equal(error.code, "UPSTREAM_TIMEOUT");
      assert.doesNotMatch(error.message, /secret/);
      return true;
    },
  );
  assert.equal(attempts, 2);
});
