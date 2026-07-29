import assert from "node:assert/strict";
import test from "node:test";
import type { lstat, readFile } from "node:fs/promises";

import { CrashlyticsError } from "../errors.js";
import { FixtureProvider, type FixtureIo } from "./fixture.js";

const fixture = {
  schema_version: "crashlytics-fixture/v1",
  apps: [{
    project_id: "demo-project",
    firebase_app_id: "demo-app",
    platform: "android",
    package_name: "com.example.demo",
  }],
  events: [
    {
      project_id: "demo-project",
      firebase_app_id: "demo-app",
      issue_id: "issue-1",
      event_id: "event-2",
      timestamp: "2026-07-29T00:00:00Z",
      platform: "android",
      exception: { class: "java.lang.IllegalStateException" },
      frames: [{ symbol: "Example.second" }],
    },
    {
      project_id: "demo-project",
      firebase_app_id: "demo-app",
      issue_id: "issue-1",
      event_id: "event-1",
      timestamp: "2026-07-28T23:00:00Z",
      platform: "android",
      exception: { class: "java.lang.IllegalStateException" },
      frames: [{ symbol: "Example.first" }],
    },
  ],
};

function fakeIo(json: unknown): { io: FixtureIo; calls: () => number } {
  let callCount = 0;
  const bytes = Buffer.from(JSON.stringify(json));
  const io: FixtureIo = {
    lstat: (async () => {
      callCount += 1;
      return { isFile: () => true, size: bytes.byteLength };
    }) as unknown as typeof lstat,
    readFile: (async () => {
      callCount += 1;
      return bytes;
    }) as unknown as typeof readFile,
  };
  return { io, calls: () => callCount };
}

function query(pageToken?: string) {
  return {
    projectId: "demo-project",
    appId: "demo-app",
    startTime: "2026-07-28T00:00:00.000Z",
    endTime: "2026-07-30T00:00:00.000Z",
    pageSize: 1,
    frameLimit: 10,
    ...(pageToken ? { pageToken } : {}),
  };
}

test("fixture is lazy-loaded once and pagination is bounded", async () => {
  const fake = fakeIo(fixture);
  const provider = new FixtureProvider("/fixtures/crash.json", fake.io);
  assert.equal(fake.calls(), 0);
  const apps = await provider.listApps("demo-project");
  assert.equal(fake.calls(), 2);
  assert.equal(apps[0]?.firebase_app_id, "demo-app");

  const first = await provider.listEvents(query());
  assert.equal(first.items[0]?.event.id, "event-2");
  assert.ok(first.nextPageToken);
  const second = await provider.listEvents(query(first.nextPageToken));
  assert.equal(second.items[0]?.event.id, "event-1");
  assert.equal(second.nextPageToken, undefined);
  assert.equal(fake.calls(), 2);
});
test("fixture rejects unknown fields and invalid page tokens", async () => {
  const fake = fakeIo({ ...fixture, unexpected: true });
  const provider = new FixtureProvider("/fixtures/crash.json", fake.io);
  await assert.rejects(
    () => provider.listApps("demo-project"),
    (error) => error instanceof CrashlyticsError && error.code === "FIXTURE_INVALID",
  );

  const valid = fakeIo(fixture);
  const validProvider = new FixtureProvider("/fixtures/crash.json", valid.io);
  await assert.rejects(
    () => validProvider.listEvents(query("not-a-cursor")),
    (error) => error instanceof CrashlyticsError && error.code === "INVALID_PAGE_TOKEN",
  );
});
