import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CRASH_STACK_BYTES,
  MAX_DEDUP_CRASHES,
  dedupCrashes,
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
