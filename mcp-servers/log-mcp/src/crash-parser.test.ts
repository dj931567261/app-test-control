import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boundCrashRecords,
  MAX_CRASH_RESPONSE_RECORDS,
  MAX_CRASH_STACK_BYTES,
  MAX_CRASH_TOTAL_STACK_BYTES,
  MAX_PARSED_CRASH_RECORDS,
  parseCrashes,
  parseCrashesWithMeta,
  type CrashRecord,
} from "./crash-parser.js";

const javaCrashLog = `\
05-14 14:23:11.123  1234  1234 I ActivityManager: Start proc com.example.app
05-14 14:23:12.456  2345  2345 E AndroidRuntime: FATAL EXCEPTION: main
05-14 14:23:12.456  2345  2345 E AndroidRuntime: Process: com.example.app, PID: 2345
05-14 14:23:12.456  2345  2345 E AndroidRuntime: java.lang.NullPointerException: Attempt to invoke virtual method 'java.lang.String android.widget.EditText.getText()' on a null object reference
05-14 14:23:12.456  2345  2345 E AndroidRuntime: 	at com.example.app.LoginActivity.onClick(LoginActivity.java:42)
05-14 14:23:12.456  2345  2345 E AndroidRuntime: 	at android.view.View.performClick(View.java:7448)
05-14 14:23:12.789  1111  1111 I OtherTag: unrelated chatter
`;

const anrLog = `\
05-14 14:25:00.000  1234  1234 E ActivityManager: ANR in com.example.app (com.example.app/.MainActivity)
05-14 14:25:00.000  1234  1234 E ActivityManager: PID: 5678
05-14 14:25:00.000  1234  1234 E ActivityManager: Reason: Input dispatching timed out
`;

const nativeLog = `\
05-14 14:26:00.000  9999  9999 F libc    : Fatal signal 11 (SIGSEGV)
05-14 14:26:00.000  9999  9999 F DEBUG   : *** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***
05-14 14:26:00.000  9999  9999 F DEBUG   : Build fingerprint: 'google/sdk_gphone64_arm64/...'
05-14 14:26:00.000  9999  9999 F DEBUG   : signal 11 (SIGSEGV), code 1 (SEGV_MAPERR)
`;

test("parses java FATAL EXCEPTION", () => {
  const crashes = parseCrashes(javaCrashLog);
  assert.equal(crashes.length, 1);
  const c = crashes[0]!;
  assert.equal(c.kind, "java");
  assert.equal(c.pid, "2345");
  assert.match(c.signature, /NullPointerException/);
  assert.match(c.stack, /LoginActivity\.onClick/);
});

test("parses ANR", () => {
  const crashes = parseCrashes(anrLog);
  assert.equal(crashes.length, 1);
  assert.equal(crashes[0]!.kind, "anr");
  assert.equal(crashes[0]!.process, "com.example.app");
});

test("parses native crash marker", () => {
  const crashes = parseCrashes(nativeLog);
  assert.ok(crashes.length >= 1);
  const c = crashes.find((x) => x.kind === "native")!;
  assert.match(c.signature, /signal|Build fingerprint/);
});

test("empty log produces no crashes", () => {
  assert.deepEqual(parseCrashes(""), []);
  assert.deepEqual(
    parseCrashes("05-14 14:00:00.000  1 1 I Tag: nothing to see here\n"),
    [],
  );
});

test("filter by package via stack content works at caller layer", () => {
  // parser does not filter; caller does. Sanity that signature/stack contain pkg.
  const c = parseCrashes(javaCrashLog)[0]!;
  assert.ok(c.stack.includes("com.example.app"));
});

test("parseCrashes caps record creation for adversarial logcat input", () => {
  const log = Array.from({ length: MAX_PARSED_CRASH_RECORDS + 20 }, (_, index) => [
    `05-14 14:23:12.456  ${1000 + index}  ${1000 + index} E AndroidRuntime: FATAL EXCEPTION: main`,
    `05-14 14:23:12.457  99999  99999 I OtherTag: boundary`,
  ].join("\n")).join("\n");
  const crashes = parseCrashes(log);
  assert.equal(crashes.length, MAX_PARSED_CRASH_RECORDS);
});

test("boundCrashRecords exposes explicit count and byte truncation metadata", () => {
  const records: CrashRecord[] = Array.from(
    { length: MAX_CRASH_RESPONSE_RECORDS + 4 },
    (_, index) => ({
      kind: "java",
      process: `fixture-${index}`,
      signature: `Failure-${index}:${"s".repeat(8_000)}`,
      stack: `${"😀".repeat(MAX_CRASH_STACK_BYTES)}\nend`,
    }),
  );
  const bounded = boundCrashRecords(records);
  assert.equal(bounded.crashes.length, MAX_CRASH_RESPONSE_RECORDS);
  assert.equal(bounded.total_detected, records.length);
  assert.equal(bounded.results_truncated, true);
  assert.equal(bounded.stack_bytes <= MAX_CRASH_TOTAL_STACK_BYTES, true);
  assert.equal(
    bounded.crashes.every(
      (record) =>
        record.stack_truncated &&
        record.signature_truncated &&
        Buffer.byteLength(record.stack, "utf8") <= MAX_CRASH_STACK_BYTES &&
        !record.stack.endsWith("�"),
    ),
    true,
  );
});

test("boundCrashRecords applies five-line mode before the byte budget", () => {
  const record: CrashRecord = {
    kind: "anr",
    signature: "ANR fixture",
    stack: Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n"),
  };
  const bounded = boundCrashRecords([record], { includeFullStack: false });
  assert.equal(bounded.crashes[0]?.stack.split("\n").length, 5);
  assert.equal(bounded.crashes[0]?.stack_truncated, true);
});

test("crash predicate is applied before the record cap", () => {
  const noise = Array.from({ length: 300 }, (_, index) => [
    `05-14 14:23:12.456  ${1000 + index}  ${1000 + index} E AndroidRuntime: FATAL EXCEPTION: worker`,
    `05-14 14:23:12.457  ${1000 + index}  ${1000 + index} E AndroidRuntime: java.lang.IllegalStateException: noise-${index}`,
    `05-14 14:23:12.458  99999  99999 I OtherTag: boundary`,
  ].join("\n")).join("\n");
  const target = [
    "05-14 14:24:12.456  9000  9000 E AndroidRuntime: FATAL EXCEPTION: main",
    "05-14 14:24:12.457  9000  9000 E AndroidRuntime: Process: com.target.app, PID: 9000",
    "05-14 14:24:12.458  9000  9000 E AndroidRuntime: java.lang.AssertionError: target",
  ].join("\n");
  const parsed = parseCrashesWithMeta(`${noise}\n${target}`, {
    maxRecords: 1,
    predicate: (record) => record.stack.includes("com.target.app"),
  });
  assert.equal(parsed.crashes.length, 1);
  assert.match(parsed.crashes[0]!.stack, /com\.target\.app/);
  assert.equal(parsed.totalDetected, 1);
  assert.equal(parsed.limitReached, false);
});
