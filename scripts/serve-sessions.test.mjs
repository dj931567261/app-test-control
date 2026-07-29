import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  createSessionViewerServer,
  LOOPBACK_HOST,
  parseCliOptions,
} from "./serve-sessions.mjs";

const sessionId = "2026-07-29_120000_crashfix-safe";
const deviceId = "00008030-0011223344556677";
const projectId = "firebase-project-private";
const appId = "1:123456789:ios:private-app";
const issueId = "issue-private-123";
const eventId = "event-private-456";
const signature = "0123456789abcdef";
const noteSecret = "private-note-token";
const storedReportSecret = "stored-report-must-not-be-served";

let root;
let workspace;
let sessionDir;
let server;
let baseUrl;
let externalKey;

async function writeJson(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

async function requestStatus(url, headers) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    req.once("error", reject);
    req.end();
  });
}

async function makeOutsideSession(dir) {
  await mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, "meta.json"), {
    id: "outside-session",
    name: "outside",
    started_at: "2026-07-29T00:00:00.000Z",
    status: "running",
    extra: { secret: "outside-session-secret" },
  });
  await writeFile(path.join(dir, "steps.jsonl"), "", "utf8");
  await writeFile(path.join(dir, "crashes.jsonl"), "", "utf8");
  await writeFile(path.join(dir, "report.html"), "outside-session-secret", "utf8");
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "serve-sessions-test-"));
  workspace = path.join(root, "sessions");
  sessionDir = path.join(workspace, sessionId);
  await Promise.all([
    mkdir(path.join(sessionDir, "steps"), { recursive: true }),
    mkdir(path.join(sessionDir, "logs"), { recursive: true }),
    mkdir(path.join(sessionDir, "crashes"), { recursive: true }),
    mkdir(path.join(sessionDir, "source-snapshot"), { recursive: true }),
  ]);

  externalKey = createHash("sha256")
    .update(
      [
        "firebase-crashlytics",
        projectId,
        appId,
        issueId,
        eventId,
        signature,
      ].join("\0"),
      "utf8",
    )
    .digest("hex");

  await writeJson(path.join(sessionDir, "meta.json"), {
    id: sessionId,
    name: `raw name ${deviceId}`,
    started_at: "2026-07-29T01:00:00.000Z",
    ended_at: "2026-07-29T01:00:03.000Z",
    status: "failed",
    extra: {
      device_id: deviceId,
      project: "/Users/private/source",
      package: "com.private.application",
      token: "meta-private-token",
    },
  });

  const steps = [
    {
      index: 1,
      ts: "2026-07-29T01:00:01.000Z",
      action: `launch device ${deviceId}`,
      result: "ok",
      screenshot: "steps/001.png",
      log_excerpt: "steps/001.log",
      notes: `device=${deviceId}; token=${noteSecret}`,
    },
    {
      index: 2,
      ts: "2026-07-29T01:00:02.000Z",
      action: "malicious source snapshot reference",
      result: "fail",
      log_excerpt: "source-snapshot/source.txt",
    },
    {
      index: 3,
      ts: "2026-07-29T01:00:02.100Z",
      action: "symlink evidence",
      result: "fail",
      log_excerpt: "steps/symlink.log",
    },
    {
      index: 4,
      ts: "2026-07-29T01:00:02.200Z",
      action: "symlink directory evidence",
      result: "fail",
      log_excerpt: "logs/linked/evidence.log",
    },
  ];
  await writeFile(
    path.join(sessionDir, "steps.jsonl"),
    `${steps.map((step) => JSON.stringify(step)).join("\n")}\n`,
    "utf8",
  );

  const crash = {
    id: "c1",
    ts: "2026-07-29T01:00:02.500Z",
    step_index: 2,
    signature,
    kind: "java",
    stack_path: "crashes/c1.stack.txt",
    log_path: "crashes/c1.log",
    repro_path: [1, 2],
    source: {
      provider: "firebase-crashlytics",
      external_key: externalKey,
      project: projectId,
      app: appId,
      issue: issueId,
      event: eventId,
      occurred: "2026-07-29T00:59:59.000Z",
      metrics: { eventCount: 7, affectedUsers: 3 },
    },
  };
  await writeFile(path.join(sessionDir, "crashes.jsonl"), `${JSON.stringify(crash)}\n`, "utf8");

  await Promise.all([
    writeFile(path.join(sessionDir, "steps", "001.png"), "safe-image", "utf8"),
    writeFile(path.join(sessionDir, "steps", "001.log"), "safe-step-log", "utf8"),
    writeFile(path.join(sessionDir, "steps", "unreferenced.png"), "hidden-image", "utf8"),
    writeFile(path.join(sessionDir, "crashes", "c1.stack.txt"), "safe-stack", "utf8"),
    writeFile(path.join(sessionDir, "crashes", "c1.log"), "safe-crash-log", "utf8"),
    writeFile(path.join(sessionDir, "source-snapshot", "source.txt"), "private-source", "utf8"),
    writeFile(path.join(sessionDir, "report.html"), storedReportSecret, "utf8"),
    writeFile(path.join(sessionDir, "report.md"), storedReportSecret, "utf8"),
  ]);

  const outsideEvidence = path.join(root, "outside-evidence");
  await mkdir(outsideEvidence, { recursive: true });
  await writeFile(path.join(outsideEvidence, "evidence.log"), "outside-secret", "utf8");
  await symlink(path.join(outsideEvidence, "evidence.log"), path.join(sessionDir, "steps", "symlink.log"));
  await symlink(outsideEvidence, path.join(sessionDir, "logs", "linked"));
  await makeOutsideSession(path.join(root, "outside-session"));

  server = createSessionViewerServer({ workspace });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  assert.equal(address.address, LOOPBACK_HOST);
  baseUrl = `http://${LOOPBACK_HOST}:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

test("CLI 固定监听 loopback，并拒绝 --host 覆盖", () => {
  const parsed = parseCliOptions([], {});
  assert.equal(parsed.host, LOOPBACK_HOST);
  assert.equal(parsed.port, 7321);
  assert.throws(
    () => parseCliOptions(["--host", "0.0.0.0"], {}),
    /loopback-only/,
  );
  assert.throws(
    () => parseCliOptions(["--host=localhost"], {}),
    /loopback-only/,
  );
});

test("session API 只返回公开脱敏视图", async () => {
  const response = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
  assert.equal(response.status, 200);
  const text = await response.text();
  const body = JSON.parse(text);

  for (const secret of [
    deviceId,
    noteSecret,
    "meta-private-token",
    "/Users/private/source",
    "com.private.application",
    projectId,
    appId,
    issueId,
    eventId,
    externalKey,
  ]) {
    assert.equal(text.includes(secret), false, `API must not expose ${secret}`);
  }
  assert.equal(body.meta.extra, undefined);
  assert.equal(body.meta.name, "crashfix-safe");
  assert.equal(body.steps[0].notes, undefined);
  assert.match(body.steps[0].action, /\[REDACTED_DEVICE\]/);
  assert.equal(body.steps[1].log_excerpt, undefined);
  assert.deepEqual(body.crashes[0].source, {
    provider: "firebase-crashlytics",
    external_key_ref: `sha256:${createHash("sha256")
      .update(externalKey, "utf8")
      .digest("hex")
      .slice(0, 10)}`,
    occurred: "2026-07-29T00:59:59.000Z",
    metrics: { eventCount: 7, affectedUsers: 3 },
  });
});

test("session 列表不暴露 workspace 绝对路径", async () => {
  const response = await fetch(`${baseUrl}/api/sessions`);
  assert.equal(response.status, 200);
  const text = await response.text();
  const body = JSON.parse(text);
  assert.equal(text.includes(root), false);
  assert.equal(body.workspace, undefined);
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].id, sessionId);
});

test("拒绝非 loopback Host 和浏览器 Origin", async () => {
  assert.equal(
    await requestStatus(`${baseUrl}/api/sessions`, { host: "attacker.example" }),
    403,
  );

  const badOrigin = await fetch(`${baseUrl}/api/sessions`, {
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(badOrigin.status, 403);
});

test("report.html 和 report.md 动态生成脱敏报告，而非返回落盘原文", async () => {
  for (const extension of ["html", "md"]) {
    const response = await fetch(`${baseUrl}/s/${sessionId}/report.${extension}`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes(storedReportSecret), false);
    assert.equal(text.includes(deviceId), false);
    assert.equal(text.includes(noteSecret), false);
    assert.equal(text.includes(projectId), false);
    assert.equal(text.includes(appId), false);
    assert.equal(text.includes(issueId), false);
    assert.equal(text.includes(eventId), false);
    assert.equal(text.includes(externalKey), false);
    assert.match(text, /firebase-crashlytics/);
    assert.match(
      text,
      new RegExp(
        createHash("sha256").update(externalKey, "utf8").digest("hex").slice(0, 10),
      ),
    );
  }
});

test("静态接口只提供报告引用的截图和日志证据", async () => {
  const allowed = new Map([
    ["steps/001.png", "safe-image"],
    ["steps/001.log", "safe-step-log"],
    ["crashes/c1.stack.txt", "safe-stack"],
    ["crashes/c1.log", "safe-crash-log"],
  ]);
  for (const [relative, expected] of allowed) {
    const response = await fetch(`${baseUrl}/s/${sessionId}/${relative}`);
    assert.equal(response.status, 200, relative);
    assert.equal(await response.text(), expected);
  }

  for (const relative of [
    "meta.json",
    "steps.jsonl",
    "crashes.jsonl",
    ".session-write.lock/owner.json",
    "source-snapshot/source.txt",
    "steps/unreferenced.png",
  ]) {
    const response = await fetch(`${baseUrl}/s/${sessionId}/${relative}`);
    assert.notEqual(response.status, 200, relative);
  }
});

test("静态接口拒绝文件和父目录 symlink", async () => {
  for (const relative of ["steps/symlink.log", "logs/linked/evidence.log"]) {
    const response = await fetch(`${baseUrl}/s/${sessionId}/${relative}`);
    assert.equal(response.status, 404, relative);
    assert.equal((await response.text()).includes("outside-secret"), false);
  }
});

test("API、报告和静态路由都拒绝编码 session id 穿越", async () => {
  const encodedTraversal = "%2e%2e%2foutside-session";
  const routes = [
    `/api/sessions/${encodedTraversal}`,
    `/s/${encodedTraversal}/report.html`,
    `/s/${encodedTraversal}/meta.json`,
  ];
  for (const route of routes) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 400, route);
    assert.equal((await response.text()).includes("outside-session-secret"), false);
  }
});

test("静态证据路径拒绝编码 traversal", async () => {
  const response = await fetch(
    `${baseUrl}/s/${sessionId}/steps/%2e%2e%2fmeta.json`,
  );
  assert.notEqual(response.status, 200);
  assert.equal((await response.text()).includes(deviceId), false);
});
