import assert from "node:assert/strict";
import test from "node:test";

import {
  getSymbolicationStatusInputSchema,
  listEventsInputSchema,
} from "./schemas.js";

const target = {
  project_id: "demo-project",
  firebase_app_id: "demo-app",
};

test("tool inputs are strict and bounded", () => {
  assert.equal(listEventsInputSchema.safeParse({ ...target, unexpected: true }).success, false);
  assert.equal(listEventsInputSchema.safeParse({ ...target, page_size: 101 }).success, false);
  assert.equal(listEventsInputSchema.safeParse({
    ...target,
    start_time: "not-a-date",
  }).success, false);
});

test("symbolication target requires exactly one id", () => {
  assert.equal(getSymbolicationStatusInputSchema.safeParse(target).success, false);
  assert.equal(getSymbolicationStatusInputSchema.safeParse({
    ...target,
    issue_id: "issue-1",
    event_id: "event-1",
  }).success, false);
  assert.equal(getSymbolicationStatusInputSchema.safeParse({
    ...target,
    issue_id: "issue-1",
  }).success, false);
  assert.equal(getSymbolicationStatusInputSchema.safeParse({
    ...target,
    issue_id: "issue-1",
    version_name: "1.0.0",
    build_version: "100",
  }).success, true);
  assert.equal(listEventsInputSchema.safeParse({
    ...target,
    version_name: "1.0.0",
  }).success, false);
});
