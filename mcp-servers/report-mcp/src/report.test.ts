import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  appendCrash,
  appendStep,
  createSession,
  loadMeta,
  readCrashes,
  readSteps,
  writeMeta,
} from "./sessions.js";
import { renderMarkdown, writeReport } from "./report.js";
import { renderHtml, writeHtmlReport } from "./html-report.js";

test("end-to-end: create session, add steps + crash, render report", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-mcp-test-"));
  try {
    const session = await createSession({
      name: "devtest-login",
      workspaceRoot: tmp,
      extra: { commit: "abc1234" },
    });
    assert.ok(session.id.includes("devtest-login"));

    // record two steps
    await appendStep(session.dir, {
      index: 1,
      ts: new Date().toISOString(),
      action: "launch app",
      result: "ok",
    });
    await appendStep(session.dir, {
      index: 2,
      ts: new Date().toISOString(),
      action: "tap login button",
      result: "fail",
      notes: "crashed here",
    });

    // record a crash
    await appendCrash(session.dir, {
      id: "c1",
      ts: new Date().toISOString(),
      step_index: 2,
      signature: "NullPointerException at LoginActivity.onClick",
      kind: "java",
      stack_path: "crashes/c1.stack.txt",
      repro_path: [1, 2],
    });

    // finalize: update meta, render markdown
    const meta = await loadMeta(session.dir);
    meta.status = "failed";
    meta.ended_at = new Date(Date.now() + 5_000).toISOString();
    await writeMeta(session.dir, meta);

    const steps = await readSteps(session.dir);
    const crashes = await readCrashes(session.dir);
    assert.equal(steps.length, 2);
    assert.equal(crashes.length, 1);

    const md = renderMarkdown({ meta, steps, crashes, summary: "1 crash detected" });
    const reportPath = await writeReport(session.dir, md);
    const onDisk = await readFile(reportPath, "utf8");
    assert.match(onDisk, /Session: devtest-login/);
    assert.match(onDisk, /Steps\*\*:\s*2/);
    assert.match(onDisk, /Crashes\*\*:\s*1/);
    assert.match(onDisk, /NullPointerException/);
    assert.match(onDisk, /Repro path \(steps\)\*\*:\s*#1\s*→\s*#2/);
    assert.match(onDisk, /FAILED/);

    // session dir structure
    await stat(path.join(session.dir, "meta.json"));
    await stat(path.join(session.dir, "steps.jsonl"));
    await stat(path.join(session.dir, "crashes.jsonl"));
    await stat(path.join(session.dir, "report.md"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("renderMarkdown handles zero steps and zero crashes", () => {
  const md = renderMarkdown({
    meta: {
      id: "x",
      name: "empty",
      started_at: new Date().toISOString(),
      status: "passed",
    },
    steps: [],
    crashes: [],
  });
  assert.match(md, /no steps recorded/);
  assert.match(md, /Steps\*\*:\s*0/);
  assert.match(md, /Crashes\*\*:\s*0/);
});

test("renderHtml produces self-contained HTML with inlined CSS + status badge", () => {
  const html = renderHtml({
    meta: {
      id: "abc",
      name: "demo",
      started_at: new Date(Date.now() - 5000).toISOString(),
      ended_at: new Date().toISOString(),
      status: "failed",
    },
    steps: [
      {
        index: 1,
        ts: new Date().toISOString(),
        action: "tap login",
        result: "ok",
        screenshot: "steps/001.png",
      },
      {
        index: 2,
        ts: new Date().toISOString(),
        action: "tap submit",
        result: "fail",
        notes: "crashed here\nfound NPE",
      },
    ],
    crashes: [
      {
        id: "c1",
        ts: new Date().toISOString(),
        step_index: 2,
        signature: "NullPointerException at LoginActivity.onClick",
        kind: "java",
        stack_path: "crashes/c1.stack.txt",
        repro_path: [1, 2],
      },
    ],
    summary: "1 crash in 2 steps",
  });
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /<style>[\s\S]*<\/style>/); // inline CSS
  assert.match(html, /FAILED/);
  assert.match(html, /NullPointerException/);
  assert.match(html, /steps\/001\.png/);
  assert.match(html, /crashed here<br>found NPE/);
  // no external resources (no <link rel="stylesheet" href=...) or <script src=...
  assert.doesNotMatch(html, /<link[^>]*rel=["']stylesheet/);
  assert.doesNotMatch(html, /<script[^>]*src=/);
});

test("renderHtml escapes HTML in content", () => {
  const html = renderHtml({
    meta: { id: "x", name: "<script>", started_at: new Date().toISOString(), status: "passed" },
    steps: [{ index: 1, ts: new Date().toISOString(), action: "<img onerror=alert(1)>", result: "ok" }],
    crashes: [],
  });
  assert.doesNotMatch(html, /<script>.*<\/script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img onerror/);
});

test("writeHtmlReport writes report.html", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "html-report-test-"));
  try {
    const out = await writeHtmlReport(
      tmp,
      renderHtml({
        meta: { id: "x", name: "t", started_at: new Date().toISOString(), status: "passed" },
        steps: [],
        crashes: [],
      }),
    );
    assert.equal(path.basename(out), "report.html");
    const content = await readFile(out, "utf8");
    assert.match(content, /<!DOCTYPE html>/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
