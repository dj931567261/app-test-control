import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CRASH_EVENT_CANONICAL_STACK_BYTES,
  analyzeCrashEvent,
  canonicalizeCrashFrame,
  type NormalizedCrashEvent,
} from "./crash-event.js";
import { computeSignature } from "./signature.js";
import { ipsToParsedStack, parseIpsContent } from "./ips.js";

function javaEvent(): NormalizedCrashEvent {
  return {
    schema_version: "crash-event/v1",
    provider: "firebase-crashlytics",
    project_id: "demo-project",
    firebase_app_id: "1:123:android:abc",
    app: {
      platform: "android",
      package_name: "com.example.app",
      version_name: "1.2.3",
      build_version: "42",
    },
    issue: {
      id: "issue-1",
      title: "NullPointerException in LoginActivity",
      type: "fatal",
      state: "open",
    },
    event: {
      id: "event-1",
      occurred_at: "2026-07-29T01:02:03.000Z",
    },
    fatal: true,
    kind: "java",
    process: "com.example.app",
    thread: "main",
    exception: { class: "java.lang.NullPointerException" },
    frames: [
      {
        index: 0,
        symbol: "com.example.app.LoginActivity.onClick(LoginActivity.kt:42)",
        file: "LoginActivity.kt",
        line: 42,
        app_owned: true,
        address: "7ff001",
      },
      {
        index: 1,
        symbol: "android.view.View.performClick(View.java:7448)",
        file: "View.java",
        line: 7_448,
        app_owned: false,
      },
    ],
    canonical_stack: "provider supplied stack evidence",
    symbolication: "symbolicated",
    aggregate: {
      events: 12,
      users: 4,
      first_seen: "2026-07-28T00:00:00Z",
      last_seen: "2026-07-29T01:02:03Z",
    },
    truncated: false,
    fetched_at: "2026-07-29T02:00:00Z",
  };
}

test("analyzeCrashEvent keeps structured Java fingerprints compatible with raw stacks", () => {
  const event = javaEvent();
  const analyzed = analyzeCrashEvent(event);
  const raw = [
    "FATAL EXCEPTION: main",
    "java.lang.NullPointerException: ignored volatile message",
    "    at com.example.app.LoginActivity.onClick(LoginActivity.kt:99)",
    "    at android.view.View.performClick(View.java:9999)",
  ].join("\n");

  assert.equal(analyzed.fingerprint, computeSignature(raw).fingerprint);
  assert.equal(computeSignature(analyzed.canonical_stack).fingerprint, analyzed.fingerprint);
  assert.equal(analyzed.kind, "java");
  assert.equal(analyzed.signature_degraded, false);
  assert.equal(analyzed.cross_source_comparable, true);
  assert.deepEqual(analyzed.top_frames, [
    "com.example.app.LoginActivity.onClick",
    "android.view.View.performClick",
  ]);
  assert.equal(analyzed.event_ref.issue_id, "issue-1");
});

test("nested Java exceptions keep remote and local root-cause fingerprints compatible", () => {
  const event = javaEvent();
  event.exception.class = "java.lang.RuntimeException";
  event.exception.root_cause_class = "java.lang.IllegalArgumentException";
  const analyzed = analyzeCrashEvent(event);
  const raw = [
    "FATAL EXCEPTION: main",
    "java.lang.RuntimeException: wrapper",
    "    at com.example.app.LoginActivity.onClick(LoginActivity.kt:42)",
    "    at android.view.View.performClick(View.java:7448)",
    "Caused by: java.lang.IllegalArgumentException: root",
    "    at com.example.app.Repository.load(Repository.kt:10)",
  ].join("\n");
  assert.equal(analyzed.fingerprint, computeSignature(raw).fingerprint);
  assert.equal(computeSignature(analyzed.canonical_stack).fingerprint, analyzed.fingerprint);
});

test("custom Throwable names and repeated cause classes retain local parity", () => {
  const event = javaEvent();
  event.exception.class = "com.example.CrashProblem";
  event.exception.root_cause_class = "com.example.CrashProblem";
  const analyzed = analyzeCrashEvent(event);
  const raw = [
    "FATAL EXCEPTION: main",
    "com.example.CrashProblem: wrapper",
    "    at com.example.app.LoginActivity.onClick(LoginActivity.kt:42)",
    "    at android.view.View.performClick(View.java:7448)",
    "Caused by: com.example.CrashProblem: root",
    "    at com.example.app.Repository.load(Repository.kt:10)",
  ].join("\n");
  assert.equal(analyzed.fingerprint, computeSignature(raw).fingerprint);
});

test("native canonical frames ignore absolute address, source line and symbol offset", () => {
  const first = canonicalizeCrashFrame({
    index: 0,
    symbol: "CrashEngine::run + 68",
    module: "/private/Frameworks/CrashKit.framework/CrashKit",
    file: "/build/agent/CrashEngine.mm",
    line: 100,
    address: "0x1000abcd",
    offset: "0x44",
  }, "native");
  const second = canonicalizeCrashFrame({
    index: 0,
    symbol: "CrashEngine::run + 999",
    module: "CrashKit",
    file: "/different/root/CrashEngine.mm",
    line: 900,
    address: "0x7fff1234",
    offset: 999,
  }, "native");

  assert.equal(first, "CrashKit!CrashEngine::run");
  assert.equal(second, first);
});

test("native signal bridge matches marker-first tombstones and is explicitly degraded", () => {
  const base: NormalizedCrashEvent = {
    ...javaEvent(),
    app: {
      platform: "android",
      package_name: "com.example.app",
    },
    kind: "native",
    exception: { signal: "SIGSEGV" },
    frames: [
      {
        index: 0,
        symbol: "abort + 8",
        module: "/system/lib64/libc.so",
        address: "0x11111111",
        offset: 8,
        app_owned: false,
      },
      {
        index: 1,
        symbol: "GameEngine::tick + 44",
        module: "/data/app/libgame.so",
        address: "0x22222222",
        offset: 44,
        app_owned: true,
      },
    ],
  };
  const sampleB: NormalizedCrashEvent = {
    ...base,
    event: {
      id: "event-2",
      occurred_at: "2026-07-29T03:00:00Z",
    },
    frames: base.frames.map((frame) => ({
      ...frame,
      address: frame.index === 0 ? "0xaaaaaaaa" : "0xbbbbbbbb",
      offset: frame.index === 0 ? 80 : 440,
      line: frame.index === 0 ? 10 : 500,
    })),
  };

  const a = analyzeCrashEvent(base);
  const b = analyzeCrashEvent(sampleB);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.deepEqual(a.top_frames, ["SIGSEGV"]);
  assert.equal(a.canonical_frames[1], "libgame.so!GameEngine::tick");
  assert.equal(a.signature_degraded, true);
  assert.equal(a.cross_source_comparable, true);
  assert.equal(a.degraded_reason, "native_signal_only_identity");
  const localTombstone = [
    "*** *** *** *** *** *** *** ***",
    "Build fingerprint: 'google/device/build'",
    "pid: 123, tid: 124, name: demo  >>> com.example.app <<<",
    "signal 11 (SIGSEGV), code 1 (SEGV_MAPERR)",
    "backtrace:",
    "  #00 pc 0000000000001234 /data/app/libgame.so (GameEngine::tick+44)",
  ].join("\n");
  assert.equal(a.fingerprint, computeSignature(localTombstone).fingerprint);
  assert.equal(computeSignature(a.canonical_stack).fingerprint, a.fingerprint);
});

test("ANR process bridge matches ActivityManager logcat and is explicitly degraded", () => {
  const event: NormalizedCrashEvent = {
    ...javaEvent(),
    kind: "anr",
    exception: {},
    process: "com.example.app",
    issue: { id: "anr-issue", title: "ANR", type: "anr" },
    frames: [{
      index: 0,
      symbol: "com.example.app.MainActivity.busy",
      app_owned: true,
    }],
  };
  const remote = analyzeCrashEvent(event);
  const local = computeSignature([
    "ANR in com.example.app (com.example.app/.MainActivity)",
    "PID: 5678",
    "Reason: Input dispatching timed out",
  ].join("\n"));
  assert.equal(remote.fingerprint, local.fingerprint);
  assert.deepEqual(remote.top_frames, ["anr:com.example.app"]);
  assert.equal(remote.signature_degraded, true);
  assert.equal(remote.cross_source_comparable, true);
  assert.equal(remote.degraded_reason, "anr_process_only_identity");
  assert.equal(computeSignature(remote.canonical_stack).fingerprint, remote.fingerprint);
});

test("ANR/native evidence without a bridge identity fails closed as non-comparable", () => {
  const missingProcess: NormalizedCrashEvent = {
    ...javaEvent(),
    app: { platform: "android" },
    process: undefined,
    kind: "anr",
    exception: {},
  };
  const anr = analyzeCrashEvent(missingProcess);
  assert.equal(anr.signature_degraded, true);
  assert.equal(anr.cross_source_comparable, false);
  assert.equal(anr.degraded_reason, "anr_missing_process");

  const missingSignal: NormalizedCrashEvent = {
    ...javaEvent(),
    kind: "native",
    exception: { class: "NativeAbort" },
  };
  const native = analyzeCrashEvent(missingSignal);
  assert.equal(native.signature_degraded, true);
  assert.equal(native.cross_source_comparable, false);
  assert.equal(native.degraded_reason, "native_missing_signal");
});

test("structured iOS events retain bundle and app-owned identity on round-trip", () => {
  const event: NormalizedCrashEvent = {
    ...javaEvent(),
    firebase_app_id: "1:123:ios:def",
    app: {
      platform: "ios",
      bundle_id: "com.example.ios",
      version_name: "2.0",
      build_version: "20",
    },
    kind: "ios",
    process: "ExampleApp",
    exception: { class: "EXC_BAD_ACCESS", signal: "SIGSEGV" },
    frames: [
      { index: 0, symbol: "objc_exception_throw + 40", module: "libobjc.A.dylib" },
      { index: 1, symbol: "-[LoginController submit] + 80", module: "ExampleApp", app_owned: true },
    ],
  };

  const analyzed = analyzeCrashEvent(event);
  assert.equal(analyzed.kind, "ios");
  assert.equal(analyzed.process, "com.example.ios");
  assert.deepEqual(analyzed.identity_frames, ["-[LoginController submit]+80"]);
  assert.equal(analyzed.signature_version, "ios-v2");
  assert.equal(computeSignature(analyzed.canonical_stack).fingerprint, analyzed.fingerprint);
});

test("structured iOS events share the same fingerprint as an equivalent .ips report", () => {
  const remote: NormalizedCrashEvent = {
    ...javaEvent(),
    firebase_app_id: "1:123:ios:def",
    app: { platform: "ios", bundle_id: "com.example.ios" },
    kind: "ios",
    exception: { class: "EXC_BAD_ACCESS", signal: "SIGSEGV" },
    frames: [
      {
        index: 0,
        symbol: "__exceptionPreprocess",
        module: "CoreFoundation",
        offset: 1,
      },
      {
        index: 1,
        symbol: "objc_exception_throw",
        module: "libobjc.A.dylib",
        offset: 2,
      },
      {
        index: 2,
        symbol: "common_raise",
        module: "CoreFoundation",
        offset: 3,
      },
      {
        index: 3,
        symbol: "MyApp.Payment.submit",
        module: "MyApp",
        offset: 4,
        app_owned: true,
      },
    ],
  };
  const ips = [
    JSON.stringify({ name: "MyApp", bundleID: "com.example.ios" }),
    JSON.stringify({
      procName: "MyApp",
      exception: { type: "EXC_BAD_ACCESS", signal: "SIGSEGV" },
      faultingThread: 0,
      threads: [{
        triggered: true,
        frames: [
          { imageIndex: 0, symbol: "__exceptionPreprocess", symbolLocation: 1 },
          { imageIndex: 1, symbol: "objc_exception_throw", symbolLocation: 2 },
          { imageIndex: 0, symbol: "common_raise", symbolLocation: 3 },
          { imageIndex: 2, symbol: "MyApp.Payment.submit", symbolLocation: 4 },
        ],
      }],
      usedImages: [
        { name: "CoreFoundation" },
        { name: "libobjc.A.dylib" },
        { name: "MyApp", path: "/Applications/MyApp.app/MyApp" },
      ],
    }),
  ].join("\n");

  const remoteFingerprint = analyzeCrashEvent(remote).fingerprint;
  const localFingerprint = computeSignature(ipsToParsedStack(parseIpsContent(ips))).fingerprint;
  assert.equal(remoteFingerprint, localFingerprint);
});

test("iOS evidence without bundle or process identity is analyze-only", () => {
  const event: NormalizedCrashEvent = {
    ...javaEvent(),
    firebase_app_id: "1:123:ios:def",
    app: { platform: "ios" },
    process: undefined,
    kind: "ios",
    exception: { class: "EXC_BAD_ACCESS", signal: "SIGSEGV" },
    frames: [{
      index: 0,
      symbol: "MyApp.Payment.submit",
      module: "MyApp",
      offset: 4,
      app_owned: true,
    }],
  };

  const analyzed = analyzeCrashEvent(event);
  assert.equal(analyzed.signature_degraded, true);
  assert.equal(analyzed.cross_source_comparable, false);
  assert.equal(analyzed.degraded_reason, "ios_missing_process_identity");
  assert.equal(computeSignature(analyzed.canonical_stack).fingerprint, analyzed.fingerprint);
});

test("iOS evidence without explicit identity-frame offsets is analyze-only", () => {
  const event: NormalizedCrashEvent = {
    ...javaEvent(),
    firebase_app_id: "1:123:ios:def",
    app: { platform: "ios", bundle_id: "com.example.ios" },
    kind: "ios",
    exception: { class: "EXC_BAD_ACCESS", signal: "SIGSEGV" },
    frames: [{
      index: 0,
      symbol: "MyApp.Payment.submit",
      module: "MyApp",
      app_owned: true,
    }],
  };

  const analyzed = analyzeCrashEvent(event);
  assert.equal(analyzed.signature_degraded, true);
  assert.equal(analyzed.cross_source_comparable, false);
  assert.equal(analyzed.degraded_reason, "ios_missing_frame_offset");
  assert.equal(computeSignature(analyzed.canonical_stack).fingerprint, analyzed.fingerprint);
});

test("unsymbolicated native frames require a module-relative offset", () => {
  assert.throws(
    () => canonicalizeCrashFrame({ index: 0, symbol: "0x12345678" }, "native"),
    /stable module-relative offset/i,
  );
  assert.equal(
    canonicalizeCrashFrame({
      index: 0,
      symbol: "???",
      module: "/data/libfoo.so",
      offset: "0X0000002A",
    }, "native"),
    "libfoo.so+0x2a",
  );
});

test("crash-event/v1 validation is strict and bounded", () => {
  assert.throws(
    () => analyzeCrashEvent({ ...javaEvent(), unexpected: true }),
    /unrecognized key/i,
  );
  assert.throws(
    () => analyzeCrashEvent({
      ...javaEvent(),
      frames: [javaEvent().frames[0], javaEvent().frames[0]],
    }),
    /ordered contiguous indexes/i,
  );
  assert.throws(
    () => analyzeCrashEvent({
      ...javaEvent(),
      frames: [
        { ...javaEvent().frames[1], index: 1 },
        { ...javaEvent().frames[0], index: 0 },
      ],
    }),
    /ordered contiguous indexes/i,
  );
  assert.throws(
    () => analyzeCrashEvent({
      ...javaEvent(),
      canonical_stack: "界".repeat(MAX_CRASH_EVENT_CANONICAL_STACK_BYTES),
    }),
    /canonical_stack exceeds .* byte size limit/i,
  );
  assert.throws(
    () => analyzeCrashEvent({
      ...javaEvent(),
      event: { id: "event-1", occurred_at: "not-a-timestamp" },
    }),
    /RFC 3339/i,
  );
});
