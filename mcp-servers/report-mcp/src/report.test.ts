import { test } from "node:test";
import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import {
  appendCrash,
  appendStep,
  crashSourceSchema,
  copyRegularFilePrivate,
  createSession,
  finalizeSession,
  loadMeta,
  readCrashes,
  readSteps,
  recordCrashEvidence,
  withSessionLock,
  writeMeta,
  type CrashSource,
} from "./sessions.js";
import { renderMarkdown, writeReport } from "./report.js";
import { renderHtml, writeHtmlReport } from "./html-report.js";

test("end-to-end: create session, add steps + crash, render report", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-mcp-test-"));
  try {
    const session = await createSession({
      name: "devtest-login",
      workspaceRoot: tmp,
      extra: {
        commit: "abc1234",
        device_id: "private-device-udid",
        private_token: "must-not-render",
      },
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
    const signature = "NullPointerException at LoginActivity.onClick";
    await appendCrash(session.dir, {
      id: "c1",
      ts: new Date().toISOString(),
      step_index: 2,
      signature,
      kind: "java",
      stack_path: "crashes/c1.stack.txt",
      repro_path: [1, 2],
      source: firebaseCrashSource(signature, {
        project: "demo-project",
        app: "app-1",
        issue: "issue-secret-1234567890",
        event: "event-secret-0987654321",
        occurred: "2026-07-29T01:02:03Z",
        metrics: { events: 7, users: 3 },
      }),
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
    assert.match(onDisk, /firebase-crashlytics/);
    assert.match(onDisk, /ref sha256:[a-f0-9]{10}/);
    assert.match(onDisk, /occurred 2026-07-29T01:02:03Z/);
    assert.doesNotMatch(onDisk, /demo-project|app-1|issue-secret|event-secret/);
    assert.match(onDisk, /device_ref_sha256/);
    assert.doesNotMatch(onDisk, /private-device-udid|private_token|must-not-render/);

    // session dir structure
    for (const directory of [tmp, session.dir, path.join(session.dir, "steps")]) {
      assert.equal((await stat(directory)).mode & 0o077, 0, directory);
    }
    for (const file of ["meta.json", "steps.jsonl", "crashes.jsonl", "report.md"]) {
      const filePath = path.join(session.dir, file);
      assert.equal((await stat(filePath)).mode & 0o077, 0, filePath);
    }
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

test("createSession uses collision-resistant private directories", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-session-unique-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const [first, second] = await Promise.all([
    createSession({ name: "same-name", workspaceRoot: tmp }),
    createSession({ name: "same-name", workspaceRoot: tmp }),
  ]);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.dir, second.dir);
  assert.equal((await stat(first.dir)).mode & 0o077, 0);
  assert.equal((await stat(second.dir)).mode & 0o077, 0);
});

test("session mutations reject symlinked evidence directories", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-session-symlink-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const session = await createSession({ name: "symlink", workspaceRoot: tmp });
  const outside = path.join(tmp, "outside");
  await mkdir(outside);
  await rm(path.join(session.dir, "crashes"), { recursive: true });
  await symlink(outside, path.join(session.dir, "crashes"));
  await assert.rejects(
    recordCrashEvidence(session.dir, {
      signature: "must-not-write",
      stack: "java.lang.IllegalStateException",
      repro_path: [],
    }),
    /session crashes must be a real directory/i,
  );
});

test("private evidence import is bounded, mode 0600, and rejects symlinks", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-private-copy-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const source = path.join(tmp, "source.log");
  const link = path.join(tmp, "source-link.log");
  const destination = path.join(tmp, "copied.log");
  await writeFile(source, "private evidence", "utf8");
  await symlink(source, link);
  await copyRegularFilePrivate(source, destination, 1024);
  assert.equal(await readFile(destination, "utf8"), "private evidence");
  assert.equal((await stat(destination)).mode & 0o077, 0);
  await assert.rejects(
    copyRegularFilePrivate(link, path.join(tmp, "must-not-copy.log"), 1024),
    /ELOOP|symbolic link|too many levels/i,
  );
  await assert.rejects(
    copyRegularFilePrivate(source, path.join(tmp, "too-small.log"), 2),
    /byte size limit/i,
  );
});

test("renderHtml produces self-contained HTML with inlined CSS + status badge", () => {
  const signature = "NullPointerException at LoginActivity.onClick";
  const html = renderHtml({
    meta: {
      id: "abc",
      name: "demo",
      started_at: new Date(Date.now() - 5000).toISOString(),
      ended_at: new Date().toISOString(),
      status: "failed",
      extra: {
        platform: "ios",
        device_id: "private-ios-udid",
        password: "must-not-render",
      },
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
        signature,
        kind: "java",
        stack_path: "crashes/c1.stack.txt",
        repro_path: [1, 2],
        source: firebaseCrashSource(signature, {
          project: "private-project",
          app: "private-app",
          issue: "private-issue-123456",
          event: "private-event-654321",
          occurred: "2026-07-29T01:02:03Z",
        }),
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
  assert.match(html, /firebase-crashlytics/);
  assert.match(html, /ref sha256:[a-f0-9]{10}/);
  assert.doesNotMatch(html, /private-project|private-app|private-issue|private-event/);
  assert.match(html, /device_ref_sha256/);
  assert.doesNotMatch(html, /private-ios-udid|password|must-not-render/);
  // no external resources (no <link rel="stylesheet" href=...) or <script src=...
  assert.doesNotMatch(html, /<link[^>]*rel=["']stylesheet/);
  assert.doesNotMatch(html, /<script[^>]*src=/);
});

test("recordCrashEvidence is session-idempotent by source.external_key", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-idempotent-test-"));
  try {
    const session = await createSession({ name: "remote", workspaceRoot: tmp });
    const source = firebaseCrashSource("sig-first", {
      project: "project",
      app: "app",
      issue: "issue",
      event: "event-1",
      occurred: "2026-07-29T01:02:03Z",
      metrics: { events: 5, users: 2 },
    });
    const [first, retry] = await Promise.all([
      recordCrashEvidence(session.dir, {
        signature: "sig-first",
        stack: "FATAL EXCEPTION: main\njava.lang.IllegalStateException\n at a.b.C.run(C.kt:1)",
        kind: "java",
        repro_path: [],
        source,
      }),
      recordCrashEvidence(session.dir, {
        signature: "sig-first",
        stack: "FATAL EXCEPTION: main\njava.lang.IllegalStateException\n at a.b.C.run(C.kt:1)",
        kind: "java",
        repro_path: [],
        source,
      }),
    ]);

    const results = [first, retry];
    assert.equal(results.filter((result) => result.deduplicated === false).length, 1);
    assert.equal(results.filter((result) => result.deduplicated === true).length, 1);
    assert.equal(retry.crash.id, first.crash.id);
    assert.equal(retry.crash.signature, "sig-first");
    const crashes = await readCrashes(session.dir);
    assert.equal(crashes.length, 1);
    assert.equal(crashes[0]?.source?.external_key, source.external_key);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("recordCrashEvidence rolls back evidence when the crash index append fails", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-crash-rollback-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const session = await createSession({ name: "rollback", workspaceRoot: tmp });
  const crashIndexPath = path.join(session.dir, "crashes.jsonl");
  const stackPath = path.join(session.dir, "crashes", "c1.stack.txt");
  const logPath = path.join(session.dir, "crashes", "c1.log");
  const logSource = path.join(tmp, "source.log");
  await writeFile(logSource, "full crash log", "utf8");

  await chmod(crashIndexPath, 0o400);
  try {
    await assert.rejects(
      recordCrashEvidence(session.dir, {
        signature: "rollback-signature",
        stack: "canonical stack",
        kind: "java",
        repro_path: [],
        log_full_src: logSource,
      }),
      /EACCES|EPERM|permission denied|operation not permitted/i,
    );
  } finally {
    await chmod(crashIndexPath, 0o600);
  }

  await assert.rejects(access(stackPath), isMissingPath);
  await assert.rejects(access(logPath), isMissingPath);
  assert.equal((await readCrashes(session.dir)).length, 0);

  const retry = await recordCrashEvidence(session.dir, {
    signature: "rollback-signature",
    stack: "canonical stack",
    kind: "java",
    repro_path: [],
    log_full_src: logSource,
  });
  assert.equal(retry.deduplicated, false);
  assert.equal(retry.crash.id, "c1");
  assert.equal(await readFile(stackPath, "utf8"), "canonical stack");
  assert.equal(await readFile(logPath, "utf8"), "full crash log");
  assert.equal((await readCrashes(session.dir)).length, 1);
});

test("recordCrashEvidence preserves colliding evidence files it did not create", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-crash-collision-test-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const session = await createSession({ name: "collision", workspaceRoot: tmp });
  const stackPath = path.join(session.dir, "crashes", "c1.stack.txt");
  const logPath = path.join(session.dir, "crashes", "c1.log");
  const logSource = path.join(tmp, "source.log");

  await writeFile(stackPath, "pre-existing stack", { mode: 0o600 });
  await assert.rejects(
    recordCrashEvidence(session.dir, {
      signature: "collision-signature",
      stack: "new stack",
      repro_path: [],
    }),
    /EEXIST|file already exists/i,
  );
  assert.equal(await readFile(stackPath, "utf8"), "pre-existing stack");

  await rm(stackPath);
  await writeFile(logSource, "new log", "utf8");
  await writeFile(logPath, "pre-existing log", { mode: 0o600 });
  await assert.rejects(
    recordCrashEvidence(session.dir, {
      signature: "collision-signature",
      stack: "new stack",
      repro_path: [],
      log_full_src: logSource,
    }),
    /EEXIST|file already exists/i,
  );
  await assert.rejects(access(stackPath), isMissingPath);
  assert.equal(await readFile(logPath, "utf8"), "pre-existing log");
  assert.equal((await readCrashes(session.dir)).length, 0);
});

test("recordCrashEvidence fails closed on a conflicting external_key", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-idempotent-conflict-test-"));
  try {
    const session = await createSession({ name: "remote", workspaceRoot: tmp });
    const signature = "fingerprint-a";
    const source = firebaseCrashSource(signature, {
      event: "event-1",
    });
    await recordCrashEvidence(session.dir, {
      signature,
      stack: "first canonical stack",
      kind: "java",
      repro_path: [],
      source,
    });
    await assert.rejects(
      () => recordCrashEvidence(session.dir, {
        signature,
        stack: "different canonical stack",
        kind: "native",
        repro_path: [],
        source,
      }),
      /already archived with different crash evidence/,
    );
    assert.equal((await readCrashes(session.dir)).length, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("firebase-crashlytics source requires a complete, signature-bound SHA-256 key", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-firebase-key-test-"));
  try {
    const session = await createSession({ name: "firebase-key", workspaceRoot: tmp });
    const signature = "fingerprint-canonical";
    const validSource = firebaseCrashSource(signature);
    const { event: _event, ...missingEvent } = validSource;

    assert.throws(
      () => crashSourceSchema.parse(missingEvent),
      /firebase-crashlytics source requires event/,
    );
    assert.throws(
      () => crashSourceSchema.parse({
        ...validSource,
        external_key: validSource.external_key.toUpperCase(),
      }),
      /64 lowercase SHA-256 hex characters/,
    );
    await assert.rejects(
      () => recordCrashEvidence(session.dir, {
        signature,
        stack: "canonical stack",
        kind: "java",
        repro_path: [],
        source: { ...validSource, external_key: "0".repeat(64) },
      }),
      /external_key does not match the normalized source identity and signature/,
    );
    assert.equal((await readCrashes(session.dir)).length, 0);

    const recorded = await recordCrashEvidence(session.dir, {
      signature,
      stack: "canonical stack",
      kind: "java",
      repro_path: [],
      source: validSource,
    });
    assert.equal(recorded.deduplicated, false);
    assert.equal(recorded.crash.source?.external_key, validSource.external_key);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("cross-process finalize excludes recordCrashEvidence and makes the session immutable", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-finalize-race-test-"));
  const readyPath = path.join(tmp, "finalizer-ready");
  const releasePath = path.join(tmp, "release-finalizer");
  let child: ReturnType<typeof spawn> | undefined;
  let childExit: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>
    | undefined;
  try {
    const session = await createSession({ name: "finalize-race", workspaceRoot: tmp });
    const sessionsModuleUrl = new URL("./sessions.ts", import.meta.url).href;
    const childScript = `
      import { access, writeFile } from "node:fs/promises";
      import { finalizeSession } from ${JSON.stringify(sessionsModuleUrl)};
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await finalizeSession(process.env.SESSION_DIR, "passed", async () => {
        await writeFile(process.env.READY_PATH, "ready", "utf8");
        while (true) {
          try {
            await access(process.env.RELEASE_PATH);
            break;
          } catch {
            await delay(10);
          }
        }
      });
    `;
    child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", childScript],
      {
        cwd: path.dirname(fileURLToPath(import.meta.url)),
        env: {
          ...process.env,
          SESSION_DIR: session.dir,
          READY_PATH: readyPath,
          RELEASE_PATH: releasePath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    childExit = collectChildExit(child);
    await Promise.race([
      waitForFile(readyPath, 5_000),
      childExit.then(({ code, signal, stderr }) => {
        throw new Error(
          `finalizer exited before acquiring the lock (${code ?? signal}): ${stderr}`,
        );
      }),
    ]);

    let recordSettled = false;
    const recordOutcome = recordCrashEvidence(session.dir, {
      signature: "must-not-be-appended",
      stack: "canonical stack",
      kind: "java",
      repro_path: [],
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    ).finally(() => {
      recordSettled = true;
    });

    await delay(100);
    assert.equal(recordSettled, false, "record_crash must wait for the finalizer lock");
    await writeFile(releasePath, "release", "utf8");

    const exit = await childExit;
    assert.equal(exit.code, 0, exit.stderr);
    const outcome = await recordOutcome;
    assert.ok("error" in outcome);
    assert.match(String(outcome.error), /session is not running \(status=passed\)/);
    assert.equal((await readCrashes(session.dir)).length, 0);

    const endedAt = (await loadMeta(session.dir)).ended_at;
    const retry = await finalizeSession(session.dir, "passed", async (context) => ({
      alreadyFinalized: context.already_finalized,
      endedAt: context.meta.ended_at,
    }));
    assert.equal(retry.context.already_finalized, true);
    assert.equal(retry.value.alreadyFinalized, true);
    assert.equal(retry.value.endedAt, endedAt);
    await assert.rejects(
      () => finalizeSession(session.dir, "failed", async () => undefined),
      /already finalized as passed/,
    );
  } finally {
    await writeFile(releasePath, "release", "utf8").catch(() => undefined);
    if (childExit !== undefined) await childExit.catch(() => undefined);
    else child?.kill();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("session lock has a hard timeout and preserves an unknown lock", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "report-lock-timeout-test-"));
  try {
    const session = await createSession({ name: "locked", workspaceRoot: tmp });
    const lockDir = path.join(session.dir, ".session-write.lock");
    const ownerPath = path.join(lockDir, "owner.json");
    const unknownOwner = JSON.stringify({ token: "unknown-owner", pid: 999_999 });
    await mkdir(lockDir);
    await writeFile(ownerPath, unknownOwner, "utf8");

    await assert.rejects(
      () => withSessionLock(
        session.dir,
        async () => assert.fail("operation must not run"),
        { timeoutMs: 40, retryMs: 5 },
      ),
      /timed out after 40ms.*not removed automatically/,
    );
    assert.equal(await readFile(ownerPath, "utf8"), unknownOwner);
    await stat(lockDir);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("CrashSource is strict, bounded, and validates metrics", () => {
  assert.deepEqual(
    crashSourceSchema.parse({ provider: "custom-provider", external_key: "key" }),
    { provider: "custom-provider", external_key: "key" },
  );
  assert.throws(
    () => crashSourceSchema.parse({
      provider: "custom-provider",
      external_key: "key",
      unexpected: "not allowed",
    }),
    /unrecognized key/i,
  );
  assert.throws(
    () => crashSourceSchema.parse({
      provider: "custom-provider",
      external_key: "key",
      metrics: { users: -1 },
    }),
    /greater than or equal to 0/i,
  );
  assert.throws(
    () => crashSourceSchema.parse({
      provider: "custom-provider",
      external_key: "x".repeat(513),
    }),
    /at most 512 character/i,
  );
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
    assert.equal((await stat(out)).mode & 0o077, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for child marker: ${String(error)}`);
      }
      await delay(10);
    }
  }
}

function collectChildExit(child: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}> {
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
}

function firebaseCrashSource(
  signature: string,
  overrides: Partial<Omit<CrashSource, "provider" | "external_key">> & {
    external_key?: string;
  } = {},
): CrashSource {
  const provider = "firebase-crashlytics";
  const project = overrides.project ?? "project";
  const app = overrides.app ?? "app";
  const issue = overrides.issue ?? "issue";
  const event = overrides.event ?? "event";
  return {
    provider,
    project,
    app,
    issue,
    event,
    external_key: overrides.external_key ?? createHash("sha256")
      .update([provider, project, app, issue, event, signature].join("\0"), "utf8")
      .digest("hex"),
    ...(overrides.occurred !== undefined ? { occurred: overrides.occurred } : {}),
    ...(overrides.metrics !== undefined ? { metrics: overrides.metrics } : {}),
  };
}
