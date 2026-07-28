import { test } from "node:test";
import assert from "node:assert/strict";
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
