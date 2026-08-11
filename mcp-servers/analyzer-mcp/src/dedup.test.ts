import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CRASH_STACK_BYTES,
  MAX_DEDUP_CRASHES,
  dedupCrashes,
  signatureGroupKey,
  type CrashInput,
} from "./dedup.js";

const NPE_AT_LOGIN = `\
FATAL EXCEPTION: main
java.lang.NullPointerException
\tat com.example.LoginActivity.onClick(LoginActivity.java:42)
\tat android.view.View.performClick(View.java:7448)
`;

const NPE_AT_LOGIN_DIFF_LINE = `\
FATAL EXCEPTION: main
java.lang.NullPointerException
\tat com.example.LoginActivity.onClick(LoginActivity.java:88)
\tat android.view.View.performClick(View.java:9999)
`;

const NPE_AT_PAY = `\
FATAL EXCEPTION: main
java.lang.NullPointerException
\tat com.example.PaymentActivity.submit(PaymentActivity.java:120)
\tat android.view.View.performClick(View.java:7448)
`;

const ISE_AT_LOGIN = `\
FATAL EXCEPTION: main
java.lang.IllegalStateException: bad state
\tat com.example.LoginActivity.onClick(LoginActivity.java:42)
`;

const PREFIXED_ART_CRASH = `\
07-30 18:11:51.919 17753 17753 E AndroidRuntime: FATAL EXCEPTION: main
07-30 18:11:51.919 17753 17753 E AndroidRuntime: Process: com.example.app, PID: 17753
07-30 18:11:51.919 17753 17753 E AndroidRuntime: java.lang.RuntimeException: wrapper
07-30 18:11:51.919 17753 17753 E AndroidRuntime: \tat android.app.ActivityThread.handleReceiver(ActivityThread.java:5017)
07-30 18:11:51.919 17753 17753 E AndroidRuntime: \tat android.app.ActivityThread.-$$Nest$mhandleReceiver(Unknown Source:0)
07-30 18:11:51.919 17753 17753 E AndroidRuntime: \tat android.app.ActivityThread$H.handleMessage(ActivityThread.java:2667)
07-30 18:11:51.919 17753 17753 E AndroidRuntime: Caused by: java.lang.IllegalStateException: root
07-30 18:11:51.919 17753 17753 E AndroidRuntime: \tat com.example.app.DebugCrashReceiver.onReceive(DebugCrashReceiver.kt:20)
`;

test("identical signatures group together", () => {
  const inputs: CrashInput[] = [
    { id: "c1", stack: NPE_AT_LOGIN, step_index: 5 },
    { id: "c2", stack: NPE_AT_LOGIN_DIFF_LINE, step_index: 12 },
    { id: "c3", stack: NPE_AT_LOGIN, step_index: 20 },
  ];
  const r = dedupCrashes(inputs);
  assert.equal(r.total, 3);
  assert.equal(r.unique, 1);
  assert.equal(r.groups[0]!.occurrences, 3);
  assert.deepEqual(r.groups[0]!.instance_ids, ["c1", "c2", "c3"]);
  assert.equal(r.groups[0]!.first_step_index, 5);
});

test("different exception classes do not group", () => {
  const r = dedupCrashes([
    { id: "c1", stack: NPE_AT_LOGIN },
    { id: "c2", stack: ISE_AT_LOGIN },
  ]);
  assert.equal(r.unique, 2);
});

test("different top frame does not group", () => {
  const r = dedupCrashes([
    { id: "c1", stack: NPE_AT_LOGIN },
    { id: "c2", stack: NPE_AT_PAY },
  ]);
  assert.equal(r.unique, 2);
});

test("groups sorted by occurrence desc", () => {
  const r = dedupCrashes([
    { id: "c1", stack: NPE_AT_PAY },
    { id: "c2", stack: NPE_AT_LOGIN },
    { id: "c3", stack: NPE_AT_LOGIN },
    { id: "c4", stack: NPE_AT_LOGIN },
  ]);
  assert.equal(r.groups[0]!.occurrences, 3); // login NPE first
  assert.equal(r.groups[1]!.occurrences, 1);
});

test("empty input returns empty result", () => {
  const r = dedupCrashes([]);
  assert.equal(r.total, 0);
  assert.equal(r.unique, 0);
  assert.deepEqual(r.groups, []);
});

test("dedup preserves the exact raw Java v1 compatibility fingerprint", () => {
  const result = dedupCrashes([{ id: "prefixed", stack: PREFIXED_ART_CRASH }]);
  assert.equal(result.groups[0]!.signature_version, "java-v2");
  assert.equal(result.groups[0]!.legacy_fingerprint, "e4823a51cd4e");
});

test("primary group keys are exactly signature_version plus fingerprint", () => {
  const fingerprint = "0123456789ab";
  const keys = ["v1", "java-v2", "ios-v2"].map((signatureVersion) =>
    signatureGroupKey(
      fingerprint,
      signatureVersion as "v1" | "java-v2" | "ios-v2",
    )
  );
  assert.equal(new Set(keys).size, 3);
  for (const key of keys) assert.match(key, /0123456789ab/u);
});

test("dedupCrashes enforces count, per-stack, and aggregate budgets internally", () => {
  assert.throws(
    () => dedupCrashes(Array.from(
      { length: MAX_DEDUP_CRASHES + 1 },
      (_, index) => ({ id: `c${index}`, stack: NPE_AT_LOGIN }),
    )),
    /1000 record limit/i,
  );

  assert.throws(
    () => dedupCrashes([{ id: "large", stack: "x".repeat(MAX_CRASH_STACK_BYTES + 1) }]),
    /stack exceeds .* byte size limit/i,
  );

  const fourMiB = "x".repeat(MAX_CRASH_STACK_BYTES);
  assert.throws(
    () => dedupCrashes(Array.from(
      { length: 17 },
      (_, index) => ({ id: `c${index}`, stack: fourMiB }),
    )),
    /total byte limit/i,
  );
});
