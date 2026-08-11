import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  createReadonlyFirebaseServer,
  FIREBASE_GATEWAY_DIAGNOSTIC_SCHEMA,
  type FirebaseGatewayFailureStage,
} from "./server.js";
import {
  FIREBASE_REPORTS_GUIDE_URI,
  MAX_UPSTREAM_RESPONSE_BYTES,
  PUBLIC_FIREBASE_READ_TOOLS,
  UPSTREAM_FIREBASE_READ_TOOLS,
  sanitizeCrashlyticsReportGuideResult,
  sanitizeUpstreamToolResult,
} from "./schemas.js";
import {
  FirebaseUpstreamCleanupError,
  FirebaseUpstreamStageError,
  type FirebaseUpstream,
} from "./upstream.js";

interface FakeCall {
  name: string;
  args: Record<string, unknown>;
}

async function connectedGateway(fake: FirebaseUpstream) {
  const runtime = createReadonlyFirebaseServer(async () => fake);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "firebase-readonly-test", version: "1" });
  await Promise.all([
    runtime.server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { runtime, client };
}

const GUIDE_BODY = "### Crashlytics Reports\n\nBounded fixture guide.";

function assertGatewayFailure(
  result: unknown,
  stage: FirebaseGatewayFailureStage,
): void {
  const diagnostic = {
    schema_version: FIREBASE_GATEWAY_DIAGNOSTIC_SCHEMA,
    error_code: "gateway_rejected",
    stage,
  };
  assert.deepEqual(result, {
    isError: true,
    content: [{
      type: "text",
      text: JSON.stringify(diagnostic),
    }],
    structuredContent: diagnostic,
  });
  // Codex 等客户端可能不保留 structuredContent；文本仍必须独立、精确地
  // 恢复同一个三字段诊断，且不能引入第四个字段。
  const textOnly = (result as { content: Array<{ text: string }> }).content[0].text;
  assert.deepEqual(JSON.parse(textOnly), diagnostic);
}

function guideWrapper(body = GUIDE_BODY, uri = FIREBASE_REPORTS_GUIDE_URI): string {
  return `<resource uri="${uri}" title="Firebase Crashlytics Reports Guide">\n${body}\n</resource>`;
}

test("tools/list exposes exactly the fixed eight public read-only Firebase tools", async (t) => {
  const fake: FirebaseUpstream = {
    callTool: async () => ({ content: [{ type: "text", text: "{}" }] }),
    close: async () => undefined,
  };
  const { runtime, client } = await connectedGateway(fake);
  t.after(async () => runtime.close());
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    [...PUBLIC_FIREBASE_READ_TOOLS].sort(),
  );
  assert.equal(listed.tools.some((tool) => tool.name === "firebase_read_resources"), false);
  assert.equal(
    listed.tools.some((tool) => tool.name === "firebase_get_crashlytics_report_guide"),
    true,
  );
  assert.equal(UPSTREAM_FIREBASE_READ_TOOLS.includes("firebase_read_resources"), true);
  assert.equal(
    (UPSTREAM_FIREBASE_READ_TOOLS as readonly string[])
      .includes("firebase_get_crashlytics_report_guide"),
    false,
  );
  for (const tool of listed.tools) {
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
});

test("unknown and write tools are rejected before upstream construction", async (t) => {
  let constructed = 0;
  const runtime = createReadonlyFirebaseServer(async () => {
    constructed += 1;
    throw new Error("must not construct");
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "firebase-readonly-test", version: "1" });
  await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => runtime.close());

  for (const request of [
    {
      name: "crashlytics_update_issue",
      arguments: { issueId: "12345678", state: "CLOSED" },
    },
    {
      name: "firebase_read_resources",
      arguments: { uris: [FIREBASE_REPORTS_GUIDE_URI] },
    },
  ]) {
    const result = await client.callTool(request);
    assert.equal(result.isError, true);
  }
  assert.equal(constructed, 0);
});

test("strict schemas reject unknown fields and bounded arguments before upstream calls", async (t) => {
  const calls: FakeCall[] = [];
  const fake: FirebaseUpstream = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "{}" }] };
    },
    close: async () => undefined,
  };
  const { runtime, client } = await connectedGateway(fake);
  t.after(async () => runtime.close());

  for (const request of [
    { name: "firebase_get_environment", arguments: { unexpected: true } },
    {
      name: "crashlytics_list_events",
      arguments: {
        appId: "1:2:android:abc",
        filter: { issueId: "issue-1234" },
        pageSize: 4,
      },
    },
    { name: "crashlytics_list_events", arguments: { appId: "1:2:android:abc", filter: {} } },
    {
      name: "crashlytics_batch_get_events",
      arguments: {
        appId: "1:2:android:abc",
        names: ["events/1", "events/2", "events/3", "events/4"],
      },
    },
    { name: "firebase_get_crashlytics_report_guide", arguments: { uris: [] } },
    {
      name: "crashlytics_get_report",
      arguments: {
        appId: "1:2:android:abc",
        report: "topIssues",
        pageSize: 4,
      },
    },
    {
      name: "crashlytics_get_report",
      arguments: {
        appId: "1:2:android:abc",
        report: "topIssues",
        filter: {
          intervalStartTime: "2024-01-01T00:00:00+99:99",
          intervalEndTime: "2024-01-02T00:00:00+99:99",
        },
      },
    },
    {
      name: "crashlytics_list_events",
      arguments: {
        appId: "1:2:android:abc",
        filter: {
          issueId: "issue-1234",
          versionDisplayNames: ["1.0"],
        },
      },
    },
    {
      name: "crashlytics_list_events",
      arguments: {
        appId: "1:2:android:abc",
        filter: {
          issueId: "issue-1234",
          operatingSystemDisplayNames: ["Android 14"],
        },
      },
    },
    {
      name: "crashlytics_list_events",
      arguments: {
        appId: "1:2:android:abc",
        filter: {
          issueId: "issue-1234",
          deviceDisplayNames: ["Pixel 8"],
        },
      },
    },
  ]) {
    const result = await client.callTool(request);
    assert.equal(result.isError, true);
  }
  const secretValue = "PRIVATE_ARGUMENT_VALUE_MUST_NOT_BE_ECHOED";
  const sdkRejected = await client.callTool({
    name: "firebase_get_environment",
    arguments: { unexpected: secretValue },
  });
  assert.equal(sdkRejected.isError, true);
  assert.equal(JSON.stringify(sdkRejected).includes(secretValue), false);
  assert.equal(calls.length, 0);
});

test("the other seven public tools retain bounded validation and upstream forwarding", async (t) => {
  const calls: FakeCall[] = [];
  const fake: FirebaseUpstream = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "{\"ok\":true}" }] };
    },
    close: async () => undefined,
  };
  const { runtime, client } = await connectedGateway(fake);
  t.after(async () => runtime.close());

  const requests = [
    { name: "firebase_get_environment", arguments: {} },
    { name: "firebase_get_project", arguments: {} },
    { name: "firebase_list_apps", arguments: { platform: "android" } },
    {
      name: "crashlytics_get_issue",
      arguments: { appId: "1:2:android:abc", issueId: "issue-1234" },
    },
    {
      name: "crashlytics_list_events",
      arguments: {
        appId: "1:2:android:abc",
        filter: {
          issueId: "issue-1234",
          versionDisplayNames: ["1.0 (1)"],
          operatingSystemDisplayNames: ["Android 14 (34)"],
          deviceDisplayNames: ["Google (Pixel 8)"],
        },
      },
    },
    {
      name: "crashlytics_batch_get_events",
      arguments: { appId: "1:2:android:abc", names: ["events/fixture-1"] },
    },
    {
      name: "crashlytics_get_report",
      arguments: { appId: "1:2:android:abc", report: "topIssues" },
    },
  ];
  for (const request of requests) {
    const result = await client.callTool(request);
    assert.equal(result.isError, undefined);
  }
  assert.deepEqual(calls, [
    { name: "firebase_get_environment", args: {} },
    { name: "firebase_get_project", args: {} },
    { name: "firebase_list_apps", args: { platform: "android" } },
    {
      name: "crashlytics_get_issue",
      args: { appId: "1:2:android:abc", issueId: "issue-1234" },
    },
    {
      name: "crashlytics_list_events",
      args: {
        appId: "1:2:android:abc",
        filter: {
          issueId: "issue-1234",
          versionDisplayNames: ["1.0 (1)"],
          operatingSystemDisplayNames: ["Android 14 (34)"],
          deviceDisplayNames: ["Google (Pixel 8)"],
        },
        pageSize: 1,
      },
    },
    {
      name: "crashlytics_batch_get_events",
      args: { appId: "1:2:android:abc", names: ["events/fixture-1"] },
    },
    {
      name: "crashlytics_get_report",
      args: { appId: "1:2:android:abc", report: "topIssues", pageSize: 3 },
    },
  ]);
});

test("guide alias accepts only an empty object and makes the one fixed upstream call", async (t) => {
  const calls: FakeCall[] = [];
  const fake: FirebaseUpstream = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: guideWrapper() }] };
    },
    close: async () => undefined,
  };
  const { runtime, client } = await connectedGateway(fake);
  t.after(async () => runtime.close());

  const result = await client.callTool({
    name: "firebase_get_crashlytics_report_guide",
    arguments: {},
  });
  assert.deepEqual(result, { content: [{ type: "text", text: GUIDE_BODY }] });
  assert.deepEqual(calls, [{
    name: "firebase_read_resources",
    args: { uris: [FIREBASE_REPORTS_GUIDE_URI] },
  }]);
});

test("guide response requires one exact wrapper, exact URI, and non-empty body", () => {
  assert.deepEqual(
    sanitizeCrashlyticsReportGuideResult({
      content: [{ type: "text", text: guideWrapper() }],
      _meta: { bounded: true },
    }),
    { content: [{ type: "text", text: GUIDE_BODY }] },
  );

  const invalidResponses = [
    { content: [{ type: "text", text: guideWrapper("   ") }] },
    { content: [{ type: "text", text: guideWrapper(GUIDE_BODY, "firebase://docs/anything") }] },
    {
      content: [{
        type: "text",
        text: `<resource uri="${FIREBASE_REPORTS_GUIDE_URI}" error>\nRESOURCE NOT FOUND\n</resource>`,
      }],
    },
    {
      content: [{
        type: "text",
        text: guideWrapper(`${GUIDE_BODY}\n${guideWrapper("second")}`),
      }],
    },
    {
      content: [
        { type: "text", text: guideWrapper() },
        { type: "text", text: guideWrapper("second") },
      ],
    },
    { content: [{ type: "text", text: guideWrapper() }], isError: true },
    {
      content: [{ type: "text", text: guideWrapper() }],
      structuredContent: { unexpected: true },
    },
    {
      content: [{ type: "text", text: guideWrapper() }],
      _meta: { oversized: "x".repeat(MAX_UPSTREAM_RESPONSE_BYTES + 1) },
    },
    {
      content: [{
        type: "text",
        text: guideWrapper("你".repeat(Math.floor(MAX_UPSTREAM_RESPONSE_BYTES / 3) + 1)),
      }],
    },
  ];
  for (const response of invalidResponses) {
    assert.throws(() => sanitizeCrashlyticsReportGuideResult(response));
  }
});

test("non-text, metadata, upstream errors, and oversized responses fail closed", () => {
  for (const response of [
    { content: [{ type: "image", data: "x", mimeType: "image/png" }] },
    { content: [{ type: "text", text: "ok", _meta: { unsafe: true } }] },
    { content: [{ type: "text", text: "failed" }], isError: true },
    { content: [{ type: "text", text: "x".repeat(MAX_UPSTREAM_RESPONSE_BYTES + 1) }] },
    {
      content: [{ type: "text", text: "ok" }],
      structuredContent: { raw: "x".repeat(MAX_UPSTREAM_RESPONSE_BYTES + 1) },
    },
    { content: [] },
    { content: [{ type: "text", text: "" }] },
  ]) {
    assert.throws(() => sanitizeUpstreamToolResult(response));
  }
});

test("bounded official structuredContent is validated then stripped", () => {
  const sanitized = sanitizeUpstreamToolResult({
    content: [{ type: "text", text: "projectId: fixture-project-1\n" }],
    structuredContent: {
      projectId: "fixture-project-1",
      displayName: "Fixture",
    },
    _meta: { trace: "bounded-and-discarded" },
  });
  assert.deepEqual(sanitized, {
    content: [{ type: "text", text: "projectId: fixture-project-1\n" }],
  });
  assert.equal("structuredContent" in sanitized, false);
  assert.equal("_meta" in sanitized, false);
});

test("top-level upstream metadata is bounded and never forwarded", () => {
  assert.deepEqual(sanitizeUpstreamToolResult({
    content: [{ type: "text", text: "ok" }],
    _meta: { safe: true },
  }), {
    content: [{ type: "text", text: "ok" }],
  });
  assert.throws(() => sanitizeUpstreamToolResult({
    content: [{ type: "text", text: "ok" }],
    _meta: { oversized: "x".repeat(MAX_UPSTREAM_RESPONSE_BYTES + 1) },
  }));
  assert.throws(() => sanitizeUpstreamToolResult({
    content: [{ type: "text", text: "x".repeat(600 * 1024) }],
    structuredContent: { duplicate: "x".repeat(300 * 1024) },
    _meta: { duplicate: "x".repeat(300 * 1024) },
  }));
});

test("the pinned official environment response shape crosses the sanitizer exactly", () => {
  const fixture = {
    content: [{
      type: "text" as const,
      text: [
        "# Environment Information",
        "",
        "Project Directory: /private/fixture",
        "Active Project ID: fixture-project-1",
      ].join("\n"),
    }],
  };
  assert.deepEqual(sanitizeUpstreamToolResult(fixture), fixture);
});

test("fixed upstream stages are exposed without leaking the original failure", async (t) => {
  const secret = "PRIVATE_SENTINEL_/absolute/credential.json";
  const runtime = createReadonlyFirebaseServer(async () => {
    throw Object.assign(
      new FirebaseUpstreamStageError("startup_list_tools"),
      { privateDetail: secret },
    );
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "firebase-readonly-test", version: "1" });
  await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => Promise.all([
    client.close().catch(() => undefined),
    runtime.close().catch(() => undefined),
  ]));

  const result = await client.callTool({
    name: "firebase_get_environment",
    arguments: {},
  });
  assertGatewayFailure(result, "startup_list_tools");
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("corrupted or throwing stage carriers fail closed without reflection", async (t) => {
  const secret = "PRIVATE_SENTINEL_STAGE";
  const corrupted = new FirebaseUpstreamStageError("startup_connect");
  Object.defineProperty(corrupted, "stage", {
    configurable: true,
    value: secret,
  });
  const throwing = new FirebaseUpstreamStageError("tool_call");
  Object.defineProperty(throwing, "stage", {
    configurable: true,
    get() { throw new Error(secret); },
  });

  for (const error of [corrupted, throwing]) {
    const runtime = createReadonlyFirebaseServer(async () => { throw error; });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "firebase-readonly-test", version: "1" });
    await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
    t.after(async () => Promise.all([
      client.close().catch(() => undefined),
      runtime.close().catch(() => undefined),
    ]));

    const first = await client.callTool({
      name: "firebase_get_environment",
      arguments: {},
    });
    assertGatewayFailure(first, "gateway_unavailable");
    assert.equal(JSON.stringify(first).includes(secret), false);
    const second = await client.callTool({
      name: "firebase_get_environment",
      arguments: {},
    });
    assertGatewayFailure(second, "gateway_unavailable");
  }
});

test("tool and response failures have separate bounded diagnostic stages", async (t) => {
  const secret = "UPSTREAM_SECRET_RESPONSE_OR_PATH";
  const throwing: FirebaseUpstream = {
    callTool: async () => { throw new Error(secret); },
    close: async () => undefined,
  };
  const first = await connectedGateway(throwing);
  t.after(async () => Promise.all([
    first.client.close().catch(() => undefined),
    first.runtime.close().catch(() => undefined),
  ]));
  const callFailure = await first.client.callTool({
    name: "firebase_get_environment",
    arguments: {},
  });
  assertGatewayFailure(callFailure, "tool_call");
  assert.equal(JSON.stringify(callFailure).includes(secret), false);

  const malformed: FirebaseUpstream = {
    callTool: async () => ({ content: [{ type: "text", text: "" }], privateDetail: secret }),
    close: async () => undefined,
  };
  const second = await connectedGateway(malformed);
  t.after(async () => Promise.all([
    second.client.close().catch(() => undefined),
    second.runtime.close().catch(() => undefined),
  ]));
  const responseFailure = await second.client.callTool({
    name: "firebase_get_environment",
    arguments: {},
  });
  assertGatewayFailure(responseFailure, "response_sanitize");
  assert.equal(JSON.stringify(responseFailure).includes(secret), false);

  const reportedError: FirebaseUpstream = {
    callTool: async () => ({
      isError: true,
      content: [{ type: "text", text: secret }],
    }),
    close: async () => undefined,
  };
  const reported = await connectedGateway(reportedError);
  t.after(async () => Promise.all([
    reported.client.close().catch(() => undefined),
    reported.runtime.close().catch(() => undefined),
  ]));
  const reportedFailure = await reported.client.callTool({
    name: "crashlytics_list_events",
    arguments: {
      appId: "1:2:android:abc",
      filter: { issueId: "issue-1234" },
    },
  });
  assertGatewayFailure(reportedFailure, "response_sanitize");
  assert.equal(JSON.stringify(reportedFailure).includes(secret), false);

  const identity: FirebaseUpstream = {
    callTool: async () => { throw new FirebaseUpstreamStageError("identity_validation"); },
    close: async () => undefined,
  };
  const third = await connectedGateway(identity);
  t.after(async () => Promise.all([
    third.client.close().catch(() => undefined),
    third.runtime.close().catch(() => undefined),
  ]));
  const identityFailure = await third.client.callTool({
    name: "firebase_get_project",
    arguments: {},
  });
  assertGatewayFailure(identityFailure, "identity_validation");
});

test("the fifth concurrent request is rejected as busy without disturbing queued reads", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  const fake: FirebaseUpstream = {
    callTool: async () => {
      calls += 1;
      if (calls === 1) entered();
      await gate;
      return { content: [{ type: "text", text: "ok" }] };
    },
    close: async () => undefined,
  };
  const { runtime, client } = await connectedGateway(fake);
  t.after(async () => Promise.all([
    client.close().catch(() => undefined),
    runtime.close().catch(() => undefined),
  ]));

  const queued = Array.from({ length: 4 }, () => client.callTool({
    name: "firebase_get_environment",
    arguments: {},
  }));
  await firstEntered;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const fifthPromise = client.callTool({
    name: "firebase_get_environment",
    arguments: {},
  });
  const timeout = Symbol("timeout");
  const fifthOrTimeout = await Promise.race([
    fifthPromise,
    new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 250)),
  ]);
  release();
  const queuedResults = await Promise.all(queued);
  const fifth = fifthOrTimeout === timeout ? await fifthPromise : fifthOrTimeout;
  assert.notEqual(fifthOrTimeout, timeout, "fifth request unexpectedly entered the queue");
  assertGatewayFailure(fifth, "gateway_busy");
  for (const result of queuedResults) assert.equal(result.isError, undefined);
  assert.equal(calls, 4);
});

test("cleanup poison drains queued requests without reconstructing upstream", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
  let constructed = 0;
  const runtime = createReadonlyFirebaseServer(async () => {
    constructed += 1;
    return {
      callTool: async () => {
        entered();
        await gate;
        return { content: [] };
      },
      close: async () => { throw new Error("fixed cleanup fixture"); },
    };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "firebase-readonly-test", version: "1" });
  await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => client.close().catch(() => undefined));

  const pending = Array.from({ length: 4 }, () => client.callTool({
    name: "firebase_get_environment",
    arguments: {},
  }));
  await firstEntered;
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  const results = await Promise.all(pending);
  assertGatewayFailure(results[0], "cleanup");
  for (const result of results.slice(1)) {
    assertGatewayFailure(result, "gateway_unavailable");
  }
  assert.equal(constructed, 1);
  await assert.rejects(runtime.close(), /fixed cleanup fixture/);
});

test("upstream cleanup failure poisons the gateway and is reported on shutdown", async (t) => {
  let constructed = 0;
  const runtime = createReadonlyFirebaseServer(async () => {
    constructed += 1;
    return {
      callTool: async () => ({ content: [] }),
      close: async () => { throw new Error("fixture cleanup failed"); },
    };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "firebase-readonly-test", version: "1" });
  await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => client.close().catch(() => undefined));

  const first = await client.callTool({
    name: "firebase_get_environment",
    arguments: {},
  });
  assertGatewayFailure(first, "cleanup");
  const second = await client.callTool({
    name: "firebase_get_environment",
    arguments: {},
  });
  assertGatewayFailure(second, "gateway_unavailable");
  assert.equal(constructed, 1);
  await assert.rejects(runtime.close(), /fixture cleanup failed/);
});

test("startup cleanup failure also poisons the gateway instead of retrying", async (t) => {
  let constructed = 0;
  const runtime = createReadonlyFirebaseServer(async () => {
    constructed += 1;
    throw new FirebaseUpstreamCleanupError();
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "firebase-readonly-test", version: "1" });
  await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => client.close().catch(() => undefined));

  for (let index = 0; index < 2; index += 1) {
    const result = await client.callTool({
      name: "firebase_get_environment",
      arguments: {},
    });
    assertGatewayFailure(
      result,
      index === 0 ? "cleanup" : "gateway_unavailable",
    );
  }
  assert.equal(constructed, 1);
  await assert.rejects(
    runtime.close(),
    (error: unknown) => error instanceof FirebaseUpstreamCleanupError
      && error.stage === "cleanup",
  );
});

test("gateway shutdown is promise-idempotent and closes the upstream once", async (t) => {
  let closeCalls = 0;
  const fake: FirebaseUpstream = {
    callTool: async () => ({ content: [{ type: "text", text: "{}" }] }),
    close: async () => {
      closeCalls += 1;
    },
  };
  const { runtime, client } = await connectedGateway(fake);
  t.after(async () => client.close().catch(() => undefined));
  const result = await client.callTool({
    name: "firebase_get_environment",
    arguments: {},
  });
  assert.equal(result.isError, undefined);

  const first = runtime.close();
  const second = runtime.close();
  assert.equal(first, second);
  await first;
  assert.equal(closeCalls, 1);
});
