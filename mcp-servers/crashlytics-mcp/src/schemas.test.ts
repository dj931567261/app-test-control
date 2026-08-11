import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createCrashlyticsMcpServer } from "./index.js";
import {
  getSymbolicationStatusInputSchema,
  listEventsInputSchema,
} from "./schemas.js";

const target = {
  project_id: "demo-project",
  firebase_app_id: "demo-app",
};

function objectValue(value: unknown, label: string): Record<string, unknown> {
  assert.equal(typeof value, "object", `${label} must be an object`);
  assert.notEqual(value, null, `${label} must not be null`);
  assert.equal(Array.isArray(value), false, `${label} must not be an array`);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, label: string): string[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  assert.ok(value.every((item) => typeof item === "string"), `${label} must contain strings`);
  return value as string[];
}

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

test("tools/list advertises complete Crashlytics query schemas", async () => {
  const server = createCrashlyticsMcpServer();
  const client = new Client({ name: "crashlytics-schema-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const expectedProperties: Record<string, readonly string[]> = {
      list_issues: [
        "project_id", "firebase_app_id", "version_name", "build_version",
        "start_time", "end_time", "page_size", "page_token", "frame_limit",
        "fatal_only", "kind",
      ],
      get_issue: [
        "project_id", "firebase_app_id", "issue_id", "version_name",
        "build_version", "start_time", "end_time", "frame_limit",
      ],
      list_events: [
        "project_id", "firebase_app_id", "issue_id", "version_name",
        "build_version", "start_time", "end_time", "page_size", "page_token",
        "frame_limit", "fatal_only", "kind",
      ],
      get_symbolication_status: [
        "project_id", "firebase_app_id", "issue_id", "event_id", "version_name",
        "build_version", "start_time", "end_time", "frame_limit",
      ],
    };

    for (const [name, propertyNames] of Object.entries(expectedProperties)) {
      const tool = listed.tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} must be listed`);
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.deepEqual(
        Object.keys(objectValue(tool.inputSchema.properties, `${name} properties`)).sort(),
        [...propertyNames].sort(),
      );
      const required = stringArray(tool.inputSchema.required, `${name} required`);
      assert.ok(required.includes("project_id"));
      assert.ok(required.includes("firebase_app_id"));
      if (name === "get_issue") assert.ok(required.includes("issue_id"));
      assert.ok(Array.isArray(tool.inputSchema.allOf), `${name} must advertise branch rules`);
      const constraint = objectValue(tool.inputSchema.allOf[0], `${name} branch rule`);
      assert.ok(Array.isArray(constraint.oneOf), `${name} must advertise oneOf branches`);
      assert.equal((constraint.oneOf as unknown[]).length, name === "get_symbolication_status" ? 3 : 2);
    }

    const symbolication = listed.tools.find(
      (tool) => tool.name === "get_symbolication_status",
    );
    assert.ok(symbolication);
    const symbolicationConstraint = objectValue(
      symbolication.inputSchema.allOf[0],
      "symbolication target rule",
    );
    const symbolicationBranches = symbolicationConstraint.oneOf as unknown[];
    assert.deepEqual(
      stringArray(
        objectValue(symbolicationBranches[0], "issue symbolication branch").required,
        "issue symbolication required",
      ),
      ["issue_id", "version_name", "build_version"],
    );
    assert.deepEqual(
      stringArray(
        objectValue(symbolicationBranches[2], "event symbolication branch").required,
        "event symbolication required",
      ),
      ["event_id"],
    );
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});
