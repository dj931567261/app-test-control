import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeCrashEvent,
  type NormalizedCrashEvent,
} from "../../analyzer-mcp/src/crash-event.js";
import { computeSignature } from "../../analyzer-mcp/src/signature.js";
import {
  assertCanonicalAnalyzerIdentity,
  computeCanonicalAnalyzerIdentity,
} from "./analyzer-identity.js";

function javaEvent(): NormalizedCrashEvent {
  return {
    schema_version: "crash-event/v1",
    provider: "firebase-crashlytics",
    project_id: "project",
    firebase_app_id: "1:123:android:abc",
    app: {
      platform: "android",
      package_name: "com.example.app",
      version_name: "1.0",
      build_version: "1",
    },
    issue: { id: "issue", title: "Crash", type: "crash" },
    event: { id: "event", occurred_at: "2026-08-04T00:00:00Z" },
    fatal: true,
    kind: "java",
    process: "com.example.app",
    exception: {
      class: "java.lang.RuntimeException",
      root_cause_class: "java.lang.IllegalStateException",
    },
    frames: [
      { index: 0, symbol: "com.example.Main.run", app_owned: true },
      { index: 1, symbol: "android.app.Activity.performCreate", app_owned: false },
    ],
    canonical_stack: "untrusted provider rendering",
    symbolication: "symbolicated",
    truncated: false,
    fetched_at: "2026-08-04T00:01:00Z",
  };
}

test("Report independently matches Analyzer canonical identities for every supported crash kind", () => {
  const anr: NormalizedCrashEvent = {
    ...javaEvent(),
    issue: { id: "anr", title: "ANR", type: "anr" },
    kind: "anr",
    exception: {},
  };
  const native: NormalizedCrashEvent = {
    ...javaEvent(),
    issue: { id: "native", title: "Native", type: "crash" },
    kind: "native",
    exception: { signal: "SIGSEGV" },
    frames: [{
      index: 0,
      symbol: "Game::tick + 4",
      module: "libgame.so",
      offset: 4,
      app_owned: true,
    }],
  };
  const ios: NormalizedCrashEvent = {
    ...javaEvent(),
    firebase_app_id: "1:123:ios:def",
    app: {
      platform: "ios",
      bundle_id: "com.example.ios",
      version_name: "1.0",
      build_version: "1",
    },
    issue: { id: "ios", title: "iOS", type: "crash" },
    kind: "ios",
    process: "com.example.ios",
    exception: { class: "EXC_BAD_ACCESS", signal: "SIGSEGV" },
    frames: [
      { index: 0, symbol: "objc_exception_throw + 1", module: "libobjc", offset: 1 },
      { index: 1, symbol: "App.main + 2", module: "App", offset: 2, app_owned: true },
      { index: 2, symbol: "start + 3", module: "dyld", offset: 3 },
      { index: 3, symbol: "thread_start + 4", module: "libsystem", offset: 4 },
    ],
  };

  for (const event of [javaEvent(), anr, native, ios]) {
    const analyzer = analyzeCrashEvent(event);
    const report = computeCanonicalAnalyzerIdentity(analyzer.canonical_stack);
    assert.deepEqual(report, {
      kind: analyzer.kind,
      signature_version: analyzer.signature_version,
      fingerprint: analyzer.fingerprint,
    });
    const analyzerRoundTrip = computeSignature(analyzer.canonical_stack);
    assert.equal(report.signature_version, analyzerRoundTrip.signature_version);
    assert.equal(report.fingerprint, analyzerRoundTrip.fingerprint);
    assert.doesNotThrow(() => assertCanonicalAnalyzerIdentity(
      analyzer.canonical_stack,
      {
        signature: analyzer.fingerprint,
        signature_version: analyzer.signature_version,
        kind: analyzer.kind,
      },
    ));
  }
});

test("Report canonical verifier fails closed on identity or grammar drift", () => {
  const analyzed = analyzeCrashEvent(javaEvent());
  assert.throws(
    () => assertCanonicalAnalyzerIdentity(analyzed.canonical_stack, {
      signature: "0".repeat(12),
      signature_version: analyzed.signature_version,
      kind: analyzed.kind,
    }),
    /does not match/,
  );
  assert.throws(
    () => computeCanonicalAnalyzerIdentity(
      `${analyzed.canonical_stack}\nUnexpected: attacker-controlled`,
    ),
    /unsupported|metadata after/,
  );
  assert.throws(
    () => computeCanonicalAnalyzerIdentity(
      analyzed.canonical_stack.replace("Main.run", "Main\trun"),
    ),
    /forbidden control characters/,
  );
});
