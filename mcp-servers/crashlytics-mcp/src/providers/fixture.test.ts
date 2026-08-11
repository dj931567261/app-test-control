import assert from "node:assert/strict";
import { constants } from "node:fs";
import { link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CrashlyticsError } from "../errors.js";
import {
  FixtureProvider,
  readFixtureFileSecure,
  type FixtureIo,
} from "./fixture.js";

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
    readFileSecure: async () => {
      callCount += 1;
      return bytes;
    },
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
  assert.equal(fake.calls(), 1);
  assert.equal(apps[0]?.firebase_app_id, "demo-app");

  const first = await provider.listEvents(query());
  assert.equal(first.items[0]?.event.id, "event-2");
  assert.ok(first.nextPageToken);
  const second = await provider.listEvents(query(first.nextPageToken));
  assert.equal(second.items[0]?.event.id, "event-1");
  assert.equal(second.nextPageToken, undefined);
  assert.equal(fake.calls(), 1);
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

test("fixture fails closed when any event is malformed, conflicting, or undeclared", async () => {
  const cases = [
    { broken: true },
    {
      ...fixture.events[0],
      resource: { labels: { firebase_app_id: "other-app" } },
    },
    {
      ...fixture.events[0],
      project_id: "other-project",
      firebase_app_id: "other-app",
    },
  ];
  for (const invalidEvent of cases) {
    const fake = fakeIo({ ...fixture, events: [...fixture.events, invalidEvent] });
    const provider = new FixtureProvider("/fixtures/crash.json", fake.io);
    await assert.rejects(
      () => provider.listApps("demo-project"),
      (error) => error instanceof CrashlyticsError && error.code === "FIXTURE_INVALID",
    );
  }
});

test("secure fixture reader rejects symbolic links, hard links, and invalid UTF-8", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crashlytics-fixture-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "fixture.json");
  await writeFile(source, JSON.stringify(fixture), { mode: 0o600, flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY });

  const symbolic = path.join(root, "symbolic.json");
  await symlink(source, symbolic);
  await assert.rejects(
    () => readFixtureFileSecure(symbolic),
    (error) => error instanceof CrashlyticsError && error.code === "FIXTURE_INVALID",
  );

  const hard = path.join(root, "hard.json");
  await link(source, hard);
  await assert.rejects(
    () => readFixtureFileSecure(source),
    (error) => error instanceof CrashlyticsError && error.code === "FIXTURE_INVALID",
  );
  await rm(hard);

  const invalid = path.join(root, "invalid.json");
  await writeFile(invalid, Buffer.from([0xff]), { mode: 0o600, flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY });
  const provider = new FixtureProvider(invalid);
  await assert.rejects(
    () => provider.listApps("demo-project"),
    (error) => error instanceof CrashlyticsError && error.code === "FIXTURE_INVALID",
  );
});
