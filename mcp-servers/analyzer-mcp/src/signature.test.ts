import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { parseStack, computeSignature, normalizeFrame } from "./signature.js";

const JAVA_NPE = `\
FATAL EXCEPTION: main
Process: com.example.app, PID: 2345
java.lang.NullPointerException: Attempt to invoke virtual method 'java.lang.String android.widget.EditText.getText()' on a null object reference
\tat com.example.app.LoginActivity.onClick(LoginActivity.java:42)
\tat android.view.View.performClick(View.java:7448)
\tat android.view.View.performClickInternal(View.java:7425)
`;

const JAVA_WITH_CAUSE = `\
FATAL EXCEPTION: main
java.lang.RuntimeException: Unable to start activity ComponentInfo{com.example/.MainActivity}
\tat android.app.ActivityThread.performLaunchActivity(ActivityThread.java:3270)
\tat android.app.ActivityThread.handleLaunchActivity(ActivityThread.java:3409)
Caused by: java.lang.IllegalStateException: Required value was null
\tat com.example.MainActivity.onCreate(MainActivity.kt:88)
`;

const ANDROID_RUNTIME_THREADTIME = `\
07-30 18:11:51.919 17753 17753 E AndroidRuntime: FATAL EXCEPTION: main
07-30 18:11:51.919 17753 17753 E AndroidRuntime: Process: com.example.app, PID: 17753
07-30 18:11:51.919 17753 17753 E AndroidRuntime: java.lang.RuntimeException: wrapper
07-30 18:11:51.919 17753 17753 E AndroidRuntime: \tat android.app.ActivityThread.handleReceiver(ActivityThread.java:5017)
07-30 18:11:51.919 17753 17753 E AndroidRuntime: \tat android.app.ActivityThread.-$$Nest$mhandleReceiver(Unknown Source:0)
07-30 18:11:51.919 17753 17753 E AndroidRuntime: \tat android.app.ActivityThread$H.handleMessage(ActivityThread.java:2667)
07-30 18:11:51.919 17753 17753 E AndroidRuntime: Caused by: java.lang.IllegalStateException: root
07-30 18:11:51.919 17753 17753 E AndroidRuntime: \tat com.example.app.DebugCrashReceiver.onReceive(DebugCrashReceiver.kt:20)
`;

const ANR = `\
ANR in com.example.app (com.example.app/.MainActivity)
PID: 5678
Reason: Input dispatching timed out
`;

const NATIVE = `\
Fatal signal 11 (SIGSEGV)
*** *** *** *** *** *** *** ***
Build fingerprint: 'google/sdk_gphone64_arm64/...'
signal 11 (SIGSEGV), code 1 (SEGV_MAPERR)
\tat libfoo.so::Foo::bar+0x44
`;

const NATIVE_HYPHENATED_FRAME = `\
Fatal signal 11 (SIGSEGV)
signal 11 (SIGSEGV), code 1 (SEGV_MAPERR)
\tat libfoo-bar.so::Foo::bar+0x44
`;

test("normalizeFrame strips file:line", () => {
  assert.equal(
    normalizeFrame("com.example.LoginActivity.onClick(LoginActivity.java:42)"),
    "com.example.LoginActivity.onClick",
  );
  assert.equal(
    normalizeFrame("foo.bar.Baz$1.onClick(Baz.kt:100)"),
    "foo.bar.Baz$1.onClick",
  );
});

test("parseStack identifies java NPE", () => {
  const p = parseStack(JAVA_NPE);
  assert.equal(p.kind, "java");
  assert.equal(p.exception_class, "java.lang.NullPointerException");
  assert.ok(p.message?.includes("EditText.getText()"));
  assert.equal(p.top_frames[0], "com.example.app.LoginActivity.onClick");
  assert.equal(p.top_frames.length, 3);
  assert.equal(p.root_cause_class, undefined);
});

test("parseStack picks innermost Caused by", () => {
  const p = parseStack(JAVA_WITH_CAUSE);
  assert.equal(p.exception_class, "java.lang.RuntimeException");
  assert.equal(p.root_cause_class, "java.lang.IllegalStateException");
  // Top frames are from the outer exception (before Caused by)
  assert.equal(p.top_frames[0], "android.app.ActivityThread.performLaunchActivity");
});

test("parseStack normalizes AndroidRuntime threadtime prefixes and ART synthetic frames", () => {
  const parsed = parseStack(ANDROID_RUNTIME_THREADTIME);
  assert.equal(parsed.kind, "java");
  assert.equal(parsed.exception_class, "java.lang.RuntimeException");
  assert.equal(parsed.root_cause_class, "java.lang.IllegalStateException");
  assert.deepEqual(parsed.top_frames.slice(0, 3), [
    "android.app.ActivityThread.handleReceiver",
    "android.app.ActivityThread.-$$Nest$mhandleReceiver",
    "android.app.ActivityThread$H.handleMessage",
  ]);

  const clean = ANDROID_RUNTIME_THREADTIME
    .split("\n")
    .map((line) => line.replace(
      /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+\d+\s+E\s+AndroidRuntime:\s*/,
      "",
    ))
    .join("\n");
  const threadtimeSignature = computeSignature(ANDROID_RUNTIME_THREADTIME);
  const cleanSignature = computeSignature(clean);
  assert.equal(threadtimeSignature.signature_version, "java-v2");
  assert.equal(cleanSignature.signature_version, "java-v2");
  assert.equal(threadtimeSignature.fingerprint, cleanSignature.fingerprint);
  // v1 never parsed frames behind a threadtime prefix. Preserve that exact
  // historical identity as an explicit bridge rather than relabeling v2 as v1.
  assert.equal(threadtimeSignature.legacy_fingerprint, "e4823a51cd4e");
  // A clean v1 stack skipped the ART synthetic frame, so its historical
  // fingerprint is intentionally distinct from prefixed v1 evidence.
  assert.equal(cleanSignature.legacy_fingerprint, "2751bae18e30");

  const brief = clean
    .split("\n")
    .map((line) => line ? `E/AndroidRuntime(17753): ${line}` : line)
    .join("\n");
  const bareTag = clean
    .split("\n")
    .map((line) => line ? `AndroidRuntime: ${line}` : line)
    .join("\n");
  for (const prefixed of [brief, bareTag]) {
    const signature = computeSignature(prefixed);
    assert.equal(signature.signature_version, "java-v2");
    assert.equal(signature.fingerprint, cleanSignature.fingerprint);
    assert.notEqual(signature.legacy_fingerprint, cleanSignature.legacy_fingerprint);
  }
});

test("compute_signature MCP preserves the raw Java legacy fingerprint", { timeout: 10_000 }, async () => {
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.join(sourceDir, "index.ts")],
  });
  const client = new Client({ name: "analyzer-signature-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "compute_signature",
      arguments: { stack: ANDROID_RUNTIME_THREADTIME },
    });
    assert.notEqual(result.isError, true);
    const text = (result.content as Array<{ type: string; text?: string }>)
      .map((item) => item.text ?? "")
      .join("\n");
    const payload = JSON.parse(text) as {
      signature_version?: unknown;
      legacy_fingerprint?: unknown;
    };
    assert.equal(payload.signature_version, "java-v2");
    assert.equal(payload.legacy_fingerprint, "e4823a51cd4e");
  } finally {
    await client.close();
  }
});

test("parseStack handles ANR", () => {
  const p = parseStack(ANR);
  assert.equal(p.kind, "anr");
  assert.equal(p.process, "com.example.app");
  assert.equal(p.top_frames[0], "anr:com.example.app");
});

test("parseStack handles native crash", () => {
  const p = parseStack(NATIVE);
  assert.equal(p.kind, "native");
  assert.equal(p.signal, "SIGSEGV");
});

test("parseStack only treats a leading canonical marker as iOS", () => {
  const stack = `FATAL EXCEPTION: main
Process: com.example.app, PID: 123
java.lang.IllegalStateException: renderer output follows
iOS Crash
\tat com.example.MainActivity.render(MainActivity.kt:42)`;
  const parsed = parseStack(stack);
  assert.equal(parsed.kind, "java");
  assert.equal(parsed.exception_class, "java.lang.IllegalStateException");
  assert.equal(parsed.top_frames[0], "com.example.MainActivity.render");
});

test("AndroidRuntime prefixes cannot grant canonical marker semantics", () => {
  const parsed = parseStack(`E/AndroidRuntime(123): iOS Crash
E/AndroidRuntime(123): Exception Type: EXC_BAD_ACCESS
E/AndroidRuntime(123):     at com.example.MainActivity.render(MainActivity.kt:42)`);
  assert.notEqual(parsed.kind, "ios");
});

test("Java prefix normalization does not change legacy native frame parsing", () => {
  const parsed = parseStack(NATIVE_HYPHENATED_FRAME);
  assert.equal(parsed.kind, "native");
  assert.equal(parsed.top_frames[0], "libfoo");
  assert.equal(computeSignature(NATIVE_HYPHENATED_FRAME).fingerprint, "8596b3b7e43c");
});

test("computeSignature is stable across whitespace differences", () => {
  const a = computeSignature(JAVA_NPE);
  const b = computeSignature(JAVA_NPE.replace(/\t/g, "    "));
  assert.equal(a.fingerprint, b.fingerprint);
});

test("computeSignature differs when exception class changes", () => {
  const a = computeSignature(JAVA_NPE);
  const b = computeSignature(JAVA_NPE.replace(/NullPointerException/g, "IllegalStateException"));
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test("computeSignature differs when top frame changes", () => {
  const a = computeSignature(JAVA_NPE);
  const b = computeSignature(JAVA_NPE.replace("LoginActivity.onClick", "PaymentActivity.onClick"));
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test("computeSignature is stable when line numbers change", () => {
  const a = computeSignature(JAVA_NPE);
  const b = computeSignature(JAVA_NPE.replace(":42)", ":99)").replace(":7448)", ":9999)"));
  assert.equal(a.fingerprint, b.fingerprint);
});

test("computeSignature label is human-readable", () => {
  const a = computeSignature(JAVA_NPE);
  assert.match(a.label, /NullPointerException/);
  assert.match(a.label, /LoginActivity\.onClick/);

  const anr = computeSignature(ANR);
  assert.match(anr.label, /ANR/);
  assert.match(anr.label, /com\.example\.app/);

  const nat = computeSignature(NATIVE);
  assert.match(nat.label, /Native|SIGSEGV/);
});

test("computeSignature returns 12-char fingerprint", () => {
  const sig = computeSignature(JAVA_NPE);
  assert.equal(sig.fingerprint.length, 12);
  assert.match(sig.fingerprint, /^[a-f0-9]{12}$/);
});

test("Java v2 exposes the exact historical v1 fingerprint without silent relabeling", () => {
  const java = computeSignature(JAVA_NPE);
  assert.equal(java.signature_version, "java-v2");
  assert.equal(java.legacy_fingerprint, "78ed06b3254c");
  assert.notEqual(java.fingerprint, java.legacy_fingerprint);

  // Non-Java v1 identities are unchanged and do not need a compatibility key.
  assert.equal(computeSignature(NATIVE).fingerprint, "7c6594522138");
  assert.equal(computeSignature(NATIVE).signature_version, "v1");
  assert.equal(computeSignature(NATIVE).legacy_fingerprint, undefined);
});
