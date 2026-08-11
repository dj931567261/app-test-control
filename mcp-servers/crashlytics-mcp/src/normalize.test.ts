import assert from "node:assert/strict";
import test from "node:test";

import { normalizedCrashEventSchema } from "../../analyzer-mcp/src/crash-event.js";
import { normalizeCrashEvent } from "./normalize.js";

function rawEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project_id: "demo-project",
    firebase_app_id: "demo-app",
    issue_id: "issue-1",
    event_id: "event-1",
    timestamp: "2026-07-29T00:00:00Z",
    platform: "android",
    package_name: "com.example.demo",
    fatal: true,
    event_type: "crash",
    issue_title: "NPE for dev@example.test at https://private.test/path?q=secret",
    exception: {
      class: "java.lang.NullPointerException",
      message: "password=do-not-return",
    },
    frames: [{
      symbol: "com.example.demo.MainActivity.onCreate",
      file: "/Users/alice/work/MainActivity.kt",
      line: 42,
      app_owned: true,
    }],
    customKeys: { api_key: "secret" },
    user: { id: "person-123" },
    installation_id: "install-123",
    logs: ["token=secret"],
    breadcrumbs: ["private"],
    ...overrides,
  };
}

test("normalizeCrashEvent emits analyzer-compatible shape and masks values", () => {
  const event = normalizeCrashEvent(rawEvent(), {
    projectId: "demo-project",
    firebaseAppId: "demo-app",
    frameLimit: 10,
    fetchedAt: "2026-07-29T01:00:00.000Z",
  });
  assert.ok(event);
  assert.equal(event.kind, "java");
  assert.equal(event.issue.type, "crash");
  assert.equal(event.symbolication, "symbolicated");
  assert.equal(event.issue.title, "java.lang.NullPointerException");
  assert.equal(event.frames[0]?.file, "work/MainActivity.kt");
  const serialized = JSON.stringify(event);
  assert.doesNotMatch(serialized, /customKeys|person-123|install-123|do-not-return|breadcrumbs/);
  assert.doesNotMatch(serialized, /redaction_count/);
});

test("normalizeCrashEvent drops traversal and non-file URI frame paths", () => {
  for (const file of [
    "../../src/MainActivity.kt",
    "/build/../src/MainActivity.kt",
    "https://example.invalid/src/MainActivity.kt",
    "src//MainActivity.kt",
    "C:\\build\\..\\src\\MainActivity.kt",
    "C:src\\MainActivity.kt",
    "src/\u0000MainActivity.kt",
  ]) {
    const event = normalizeCrashEvent(rawEvent({
      frames: [{
        symbol: "com.example.demo.MainActivity.onCreate",
        file,
        line: 42,
        app_owned: true,
      }],
    }), {
      projectId: "demo-project",
      firebaseAppId: "demo-app",
      frameLimit: 10,
    });
    assert.ok(event);
    assert.equal(event.frames[0]?.file, undefined, file);
  }
});

test("normalizeCrashEvent strips absolute Windows and UNC roots before analyzer handoff", () => {
  const cases = [
    ["D:\\build\\repo\\src\\MainActivity.kt", "build/repo/src/MainActivity.kt"],
    ["\\\\builder-01\\private-share\\repo\\src\\MainActivity.kt", "repo/src/MainActivity.kt"],
    ["file://builder-01/private-share/repo/src/MainActivity.kt", "repo/src/MainActivity.kt"],
    ["/opt/build/repo/src/MainActivity.kt", "opt/build/repo/src/MainActivity.kt"],
  ] as const;
  for (const [file, expected] of cases) {
    const event = normalizeCrashEvent(rawEvent({
      frames: [{
        symbol: "com.example.demo.MainActivity.onCreate",
        file,
        line: 42,
        app_owned: true,
      }],
    }), {
      projectId: "demo-project",
      firebaseAppId: "demo-app",
      frameLimit: 10,
      fetchedAt: "2026-07-29T01:00:00.000Z",
    });
    assert.ok(event);
    assert.equal(event.frames[0]?.file, expected, file);
    assert.equal(normalizedCrashEventSchema.safeParse(event).success, true, file);
  }
});

test("normalizeCrashEvent rejects cross-app data and incomplete events", () => {
  const context = {
    projectId: "demo-project",
    firebaseAppId: "demo-app",
    frameLimit: 10,
  };
  assert.equal(
    normalizeCrashEvent(rawEvent({ firebase_app_id: "other-app" }), context),
    undefined,
  );
  assert.equal(
    normalizeCrashEvent(rawEvent({ firebase_app_id: undefined }), context),
    undefined,
  );
  assert.equal(
    normalizeCrashEvent(rawEvent({ project_id: undefined }), context),
    undefined,
  );
  assert.equal(normalizeCrashEvent(rawEvent({ frames: [] }), context), undefined);
  assert.equal(normalizeCrashEvent(rawEvent({ platform: "unknown" }), context), undefined);
  assert.equal(normalizeCrashEvent({
    ...rawEvent(),
    jsonPayload: {
      ...rawEvent(),
      firebase_app_id: "demo-app",
    },
    resource: { labels: { firebase_app_id: "other-app" } },
  }, context), undefined);
});

test("normalizeCrashEvent parses exact resource names and rejects conflicting name identity", () => {
  const base = {
    jsonPayload: {
      name: "projects/demo-project/apps/demo-app/events/event-from-name",
      issue: { id: "issue-name" },
      eventTime: "2026-07-29T00:00:00Z",
      platform: "android",
      bundleOrPackage: "com.example.demo",
      exceptions: [{
        type: "java.lang.IllegalStateException",
        frames: [{ symbol: "com.example.Demo.run" }],
      }],
    },
  };
  const event = normalizeCrashEvent(base, {
    projectId: "demo-project",
    firebaseAppId: "demo-app",
    frameLimit: 10,
  });
  assert.equal(event?.event.id, "event-from-name");
  assert.equal(normalizeCrashEvent({
    ...base,
    resource: { labels: { firebase_app_id: "other-app" } },
  }, {
    projectId: "demo-project",
    firebaseAppId: "demo-app",
    frameLimit: 10,
  }), undefined);
});

test("normalizeCrashEvent bounds frames and normalizes unique indexes", () => {
  const event = normalizeCrashEvent(rawEvent({
    frames: Array.from({ length: 5 }, (_, index) => ({
      index: 99,
      symbol: `frame${index}`,
    })),
  }), {
    projectId: "demo-project",
    firebaseAppId: "demo-app",
    frameLimit: 2,
  });
  assert.ok(event);
  assert.equal(event.frames.length, 2);
  assert.deepEqual(event.frames.map((frame) => frame.index), [0, 1]);
  assert.equal(event.truncated, true);
});

test("normalizeCrashEvent maps the official Cloud Logging camelCase schema", () => {
  const event = normalizeCrashEvent({
    resource: {
      labels: {
        project_id: "demo-project",
        firebase_app_id: "1:123:android:abc",
      },
    },
    insertId: "logging-insert-id",
    jsonPayload: {
      name: "projects/demo-project/apps/1:123:android:abc/events/event-official",
      platform: "ANDROID",
      bundleOrPackage: "com.example.official",
      eventId: "event-official",
      eventTime: "2026-07-29T02:03:04.123Z",
      issue: { id: "issue-official", type: "FATAL" },
      issueTitle: "IllegalStateException at user@example.test",
      version: { displayVersion: "2.4.0", buildVersion: "240" },
      blameFrame: {
        symbol: "com.example.official.HomeViewModel.load",
        file: "C:\\Users\\Alice\\build\\HomeViewModel.kt",
        line: 42,
      },
      exceptions: [{
        type: "java.lang.IllegalStateException",
        exceptionMessage: "password=must-not-leak",
        frames: [{
          symbol: "com.example.official.HomeViewModel.load",
          file: "C:\\Users\\Alice\\build\\HomeViewModel.kt",
          line: 42,
        }, {
          symbol: "android.os.Handler.dispatchMessage",
          file: "Handler.java",
          line: 100,
        }],
      }],
      threads: [{
        name: "main",
        crashed: true,
        frames: [{ symbol: "unused.thread.frame" }],
      }],
      user: { id: "private-user" },
      customKeys: { token: "private-token" },
    },
  }, {
    projectId: "demo-project",
    firebaseAppId: "1:123:android:abc",
    frameLimit: 10,
    fetchedAt: "2026-07-29T03:00:00.000Z",
  });

  assert.ok(event);
  assert.equal(event.event.id, "event-official");
  assert.equal(event.event.occurred_at, "2026-07-29T02:03:04.123Z");
  assert.equal(event.app.package_name, "com.example.official");
  assert.equal(event.app.version_name, "2.4.0");
  assert.equal(event.app.build_version, "240");
  assert.equal(event.issue.type, "crash");
  assert.equal(event.fatal, true);
  assert.equal(event.kind, "java");
  assert.equal(event.exception.class, "java.lang.IllegalStateException");
  assert.equal(event.thread, undefined);
  assert.equal(event.frames.length, 2);
  assert.equal(event.frames[0]?.app_owned, true);
  assert.equal(event.frames[0]?.file, "build/HomeViewModel.kt");
  assert.equal(event.symbolication, "symbolicated");
  const serialized = JSON.stringify(event);
  assert.doesNotMatch(serialized, /Alice|private-user|private-token|must-not-leak/);
  assert.doesNotMatch(serialized, /user@example\.test/);
});

test("normalizeCrashEvent never returns free-form issue, process or thread text", () => {
  const event = normalizeCrashEvent(rawEvent({
    issue_title: "customer Alice Smith account_id=acct-42",
    process: "worker for Alice Smith",
    thread: "user Alice Smith",
    exception: { class: "java.lang.IllegalStateException", message: "private message" },
  }), {
    projectId: "demo-project",
    firebaseAppId: "demo-app",
    frameLimit: 10,
  });
  assert.ok(event);
  assert.equal(event.issue.title, "java.lang.IllegalStateException");
  assert.equal(event.process, "com.example.demo");
  assert.equal(event.thread, undefined);
  assert.doesNotMatch(JSON.stringify(event), /Alice Smith|acct-42|private message/);
});

test("normalizeCrashEvent rejects free-form package and bundle identities", () => {
  const android = normalizeCrashEvent(rawEvent({
    package_name: "customer Alice Smith",
  }), {
    projectId: "demo-project",
    firebaseAppId: "demo-app",
    frameLimit: 10,
  });
  assert.ok(android);
  assert.equal(android.app.package_name, undefined);
  assert.equal(android.process, undefined);
  assert.doesNotMatch(JSON.stringify(android), /Alice Smith/);

  const ios = normalizeCrashEvent(rawEvent({
    platform: "ios",
    package_name: undefined,
    bundle_id: "account owner Alice Smith",
    exception: { class: "EXC_BAD_ACCESS", signal: "SIGSEGV" },
  }), {
    projectId: "demo-project",
    firebaseAppId: "demo-app",
    frameLimit: 10,
  });
  assert.ok(ios);
  assert.equal(ios.app.bundle_id, undefined);
  assert.equal(ios.process, undefined);
  assert.doesNotMatch(JSON.stringify(ios), /Alice Smith/);
});

test("normalizeCrashEvent preserves a bounded nested Java root-cause class", () => {
  const event = normalizeCrashEvent({
    ...rawEvent(),
    exceptions: [{
      type: "java.lang.RuntimeException",
      frames: [{ symbol: "com.example.Wrapper.run" }],
    }, {
      type: "java.lang.IllegalArgumentException",
      frames: [{ symbol: "com.example.Root.run" }],
    }],
    exception: undefined,
    frames: undefined,
  }, {
    projectId: "demo-project",
    firebaseAppId: "demo-app",
    frameLimit: 10,
  });
  assert.ok(event);
  assert.equal(event.exception.class, "java.lang.RuntimeException");
  assert.equal(event.exception.root_cause_class, "java.lang.IllegalArgumentException");
  assert.equal(event.frames[0]?.symbol, "com.example.Wrapper.run");
});

test("normalizeCrashEvent preserves a repeated root-cause class for local parity", () => {
  const event = normalizeCrashEvent({
    ...rawEvent(),
    exceptions: [{
      type: "java.lang.RuntimeException",
      frames: [{ symbol: "com.example.Wrapper.run" }],
    }, {
      type: "java.lang.RuntimeException",
      frames: [{ symbol: "com.example.Root.run" }],
    }],
    exception: undefined,
    frames: undefined,
  }, {
    projectId: "demo-project",
    firebaseAppId: "demo-app",
    frameLimit: 10,
  });
  assert.equal(event?.exception.class, "java.lang.RuntimeException");
  assert.equal(event?.exception.root_cause_class, "java.lang.RuntimeException");
});

test("normalizeCrashEvent maps official native errors and never upgrades unknown symbols", () => {
  const event = normalizeCrashEvent({
    project_id: "demo-project",
    firebase_app_id: "1:123:android:abc",
    jsonPayload: {
      platform: "ANDROID",
      bundleOrPackage: "com.example.native",
      eventId: "native-event",
      eventTime: "2026-07-29T02:03:04Z",
      issue: { id: "native-issue", type: "NATIVE_CRASH" },
      errors: [{
        signal: "SIGSEGV",
        frames: [{ symbol: "???", library: "libgame.so", offset: 42 }],
      }],
      symbolicationStatus: "symbolicated",
    },
  }, {
    projectId: "demo-project",
    firebaseAppId: "1:123:android:abc",
    frameLimit: 10,
  });
  assert.ok(event);
  assert.equal(event.kind, "native");
  assert.equal(event.fatal, true);
  assert.equal(event.exception.signal, "SIGSEGV");
  assert.equal(event.symbolication, "unsymbolicated");
});

test("normalizeCrashEvent canonicalizes bare hexadecimal offsets for analyzer", () => {
  const event = normalizeCrashEvent({
    project_id: "demo-project",
    firebase_app_id: "1:123:android:abc",
    event_id: "native-offset-event",
    event_time: "2026-07-29T02:03:04Z",
    issue_id: "native-offset-issue",
    platform: "android",
    issue_type: "native_crash",
    errors: [{
      signal: "SIGSEGV",
      frames: [
        { symbol: "???", library: "libapp.so", offset: "deadbeef" },
        { symbol: "???", library: "libother.so", offset: "0X0000002A" },
      ],
    }],
  }, {
    projectId: "demo-project",
    firebaseAppId: "1:123:android:abc",
    frameLimit: 10,
  });
  assert.equal(event?.frames[0]?.offset, "0xdeadbeef");
  assert.equal(event?.frames[1]?.offset, "0x2a");
});

test("normalizeCrashEvent treats redaction placeholders and bare addresses as unsymbolicated", () => {
  for (const symbol of ["[REDACTED_PHONE]", "7ffdeadbeef"]) {
    const event = normalizeCrashEvent({
      project_id: "demo-project",
      firebase_app_id: "1:123:android:abc",
      event_id: `event-${symbol.length}`,
      event_time: "2026-07-29T02:03:04Z",
      issue_id: `issue-${symbol.length}`,
      platform: "android",
      issue_type: "native_crash",
      errors: [{ signal: "SIGSEGV", frames: [{ symbol, library: "libapp.so", offset: 42 }] }],
    }, {
      projectId: "demo-project",
      firebaseAppId: "1:123:android:abc",
      frameLimit: 10,
    });
    assert.ok(event);
    assert.equal(event.symbolication, "unsymbolicated");
  }
});

test("normalizeCrashEvent never emits an analyzer-incompatible iOS ANR kind", () => {
  const event = normalizeCrashEvent({
    project_id: "demo-project",
    firebase_app_id: "1:123:ios:def",
    event_id: "ios-event",
    event_time: "2026-07-29T02:03:04Z",
    issue_id: "ios-issue",
    platform: "ios",
    issue_type: "anr",
    exception: { type: "EXC_CRASH", signal: "SIGABRT" },
    frames: [{ symbol: "MyApp.crash", module: "MyApp", offset: 0 }],
  }, {
    projectId: "demo-project",
    firebaseAppId: "1:123:ios:def",
    frameLimit: 10,
  });
  assert.ok(event);
  assert.equal(event.kind, "ios");
  assert.equal(event.app.platform, "ios");
});
