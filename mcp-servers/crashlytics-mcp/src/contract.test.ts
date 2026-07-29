import assert from "node:assert/strict";
import test from "node:test";

import { analyzeCrashEvent, normalizedCrashEventSchema } from "../../analyzer-mcp/src/crash-event.js";
import { normalizeCrashEvent } from "./normalize.js";

test("normalized provider event passes analyzer analyzeCrashEvent contract", () => {
  const event = normalizeCrashEvent({
    project_id: "demo-project",
    firebase_app_id: "demo-app",
    issue_id: "issue-contract",
    event_id: "event-contract",
    timestamp: "2026-07-29T00:00:00Z",
    platform: "android",
    package_name: "com.example.demo",
    fatal: true,
    event_type: "crash",
    issue_title: "Null pointer",
    exception: { class: "java.lang.NullPointerException" },
    frames: [{
      symbol: "com.example.demo.MainActivity.onCreate(MainActivity.kt:42)",
      module: "app",
      file: "MainActivity.kt",
      line: 42,
      app_owned: true,
    }],
  }, {
    projectId: "demo-project",
    firebaseAppId: "demo-app",
    frameLimit: 10,
    fetchedAt: "2026-07-29T01:00:00.000Z",
  });
  assert.ok(event);
  assert.equal(normalizedCrashEventSchema.safeParse(event).success, true);
  const analyzed = analyzeCrashEvent(event);
  assert.equal(analyzed.event_ref.issue_id, "issue-contract");
  assert.match(analyzed.fingerprint, /^[0-9a-f]{12}$/);
});

test("bare provider hexadecimal offsets are normalized before analyzer handoff", () => {
  const event = normalizeCrashEvent({
    project_id: "demo-project",
    firebase_app_id: "demo-app",
    issue_id: "issue-native-contract",
    event_id: "event-native-contract",
    timestamp: "2026-07-29T00:00:00Z",
    platform: "android",
    package_name: "com.example.demo",
    fatal: true,
    event_type: "native_crash",
    errors: [{
      signal: "SIGSEGV",
      frames: [{ symbol: "???", library: "libapp.so", offset: "deadbeef" }],
    }],
  }, {
    projectId: "demo-project",
    firebaseAppId: "demo-app",
    frameLimit: 10,
    fetchedAt: "2026-07-29T01:00:00.000Z",
  });
  assert.ok(event);
  assert.equal(event.frames[0]?.offset, "0xdeadbeef");
  assert.equal(normalizedCrashEventSchema.safeParse(event).success, true);
  assert.equal(analyzeCrashEvent(event).degraded_reason, "native_signal_only_identity");
});
