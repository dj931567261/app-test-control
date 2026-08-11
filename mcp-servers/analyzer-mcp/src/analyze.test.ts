import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  link,
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  MAX_SESSION_JSONL_BYTES,
  MAX_SESSION_CRASHES,
  MAX_SESSION_STACK_BYTES,
  MAX_SESSION_TOTAL_STACK_BYTES,
  analyzeSession,
  suggestMinimalPath,
} from "./analyze.js";
import { computeSignature } from "./signature.js";

const execFileAsync = promisify(execFile);

const JAVA_STACK = [
  "FATAL EXCEPTION: main",
  "java.lang.IllegalStateException: boom",
  "    at com.example.MainActivity.crash(MainActivity.java:42)",
].join("\n");

const IOS_V2_STACK = [
  "iOS Crash",
  "Exception Type: EXC_BAD_ACCESS",
  "Signal: SIGSEGV",
  "Process: com.example.MyApp",
  "Identity Frame: MyApp.Payment.submit+3",
  "Frame 0: libsystem_kernel.dylib+1",
  "Frame 1: libobjc.A.dylib+2",
  "Frame 2: MyApp.Payment.submit+3",
].join("\n");

function firebaseExternalKey({
  project,
  app,
  issue,
  event,
  signature,
  signatureVersion,
}: {
  project: string;
  app: string;
  issue: string;
  event: string;
  signature: string;
  signatureVersion?: "v1" | "java-v2" | "ios-v2";
}): string {
  return createHash("sha256")
    .update(
      [
        "firebase-crashlytics",
        project,
        app,
        issue,
        event,
        ...(signatureVersion === undefined ? [] : [signatureVersion]),
        signature,
      ].join("\0"),
      "utf8",
    )
    .digest("hex");
}

async function writeCrashRecord(sessionDir: string, stackPath: string): Promise<void> {
  await writeFile(
    path.join(sessionDir, "crashes.jsonl"),
    `${JSON.stringify({
      id: "crash-1",
      ts: "2026-07-28T00:00:00Z",
      step_index: 1,
      signature: "IllegalStateException",
      kind: "java",
      stack_path: stackPath,
      repro_path: [1],
    })}\n`,
    "utf8",
  );
}

async function sessionWithSteps(steps: unknown[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "analyzer-session-"));
  await writeFile(
    path.join(dir, "steps.jsonl"),
    `${steps.map((step) => JSON.stringify(step)).join("\n")}\n`,
    "utf8",
  );
  return dir;
}

test("suggestMinimalPath reads structured replay and page transition notes", async () => {
  const sessionDir = await sessionWithSteps([
    {
      index: 1,
      ts: "2026-07-27T00:00:00Z",
      action: "launch app",
      result: "ok",
      notes: JSON.stringify({ replay: { action_type: "launch" } }),
    },
    {
      index: 2,
      ts: "2026-07-27T00:00:01Z",
      action: "click login",
      result: "ok",
      notes: JSON.stringify({
        replay: { action_type: "tap", element_key: "text:Login" },
        page_from: "aaa111bbb222",
        page_to: "ccc333ddd444",
      }),
    },
    {
      index: 3,
      ts: "2026-07-27T00:00:02Z",
      action: "click no-op",
      result: "ok",
      notes: JSON.stringify({
        replay: { action_type: "tap", element_key: "text:No-op" },
        page_from: "ccc333ddd444",
        page_to: "ccc333ddd444",
      }),
    },
    {
      index: 4,
      ts: "2026-07-27T00:00:03Z",
      action: "click crash",
      result: "fail",
    },
  ]);

  const result = await suggestMinimalPath(sessionDir, [1, 2, 3, 4], 4);

  assert.deepEqual(result.suggested_path, [1, 2, 4]);
  assert.equal(result.reasoning[1], "launch setup");
  assert.equal(result.reasoning[2], "page transition aaa111 → ccc333");
  assert.equal(result.reasoning[4], "trigger (crash detected after this step)");
  assert.equal(result.confidence, "medium");
});

test("suggestMinimalPath remains compatible with legacy transition notes", async () => {
  const sessionDir = await sessionWithSteps([
    {
      index: 1,
      ts: "2026-07-27T00:00:00Z",
      action: "click next",
      result: "ok",
      notes: "page abcdef123456 → fedcba654321",
    },
    {
      index: 2,
      ts: "2026-07-27T00:00:01Z",
      action: "click crash",
      result: "ok",
    },
  ]);

  const result = await suggestMinimalPath(sessionDir, [1, 2], 2);

  assert.deepEqual(result.suggested_path, [1, 2]);
  assert.equal(result.reasoning[1], "page transition abcdef → fedcba");
  assert.equal(result.confidence, "low");
});

test("runtime validation accepts bounded empty optional/text fields emitted by report-mcp", async () => {
  const sessionDir = await sessionWithSteps([{
    index: 1,
    ts: "2026-07-27T00:00:00Z",
    action: "",
    result: "ok",
    notes: "",
  }]);
  const result = await suggestMinimalPath(sessionDir, [1], 1);
  assert.deepEqual(result.suggested_path, [1]);
});

test("analyzeSession reads a contained regular stack file", async (t) => {
  const sessionDir = await mkdtemp(path.join(os.tmpdir(), "analyzer-safe-session-"));
  t.after(async () => rm(sessionDir, { recursive: true, force: true }));
  await mkdir(path.join(sessionDir, "crashes"));
  await writeFile(path.join(sessionDir, "crashes", "crash-1.stack.txt"), JAVA_STACK);
  await writeCrashRecord(sessionDir, "crashes/crash-1.stack.txt");

  const result = await analyzeSession(sessionDir);
  assert.equal(result.total, 1);
  assert.equal(result.unique, 1);
  assert.equal(result.groups[0]?.kind, "java");
  assert.equal(result.groups[0]?.signature_version, "unversioned");
  assert.equal(result.groups[0]?.fingerprint, "IllegalStateException");
  assert.deepEqual(result.groups[0]?.instance_ids, ["crash-1"]);
});

test("analyzeSession groups cross-kind unversioned archives without merging versioned records", async (t) => {
  const sessionDir = await mkdtemp(path.join(os.tmpdir(), "analyzer-unversioned-session-"));
  t.after(async () => rm(sessionDir, { recursive: true, force: true }));
  const crashesDir = path.join(sessionDir, "crashes");
  await mkdir(crashesDir);
  await writeFile(path.join(crashesDir, "same.stack.txt"), JAVA_STACK);
  const anrStack = "ANR in com.example.app";
  await writeFile(path.join(crashesDir, "anr.stack.txt"), anrStack);
  const current = computeSignature(JAVA_STACK);
  assert.equal(current.signature_version, "java-v2");
  assert.equal(computeSignature(anrStack).kind, "anr");
  await writeFile(
    path.join(sessionDir, "crashes.jsonl"),
    `${[
      {
        id: "legacy-a",
        ts: "2026-07-29T00:00:00Z",
        signature: current.fingerprint,
        kind: "ios",
        stack_path: "crashes/same.stack.txt",
        repro_path: [1],
      },
      {
        id: "legacy-b",
        ts: "2026-07-29T00:00:01Z",
        signature: current.fingerprint,
        kind: "unknown",
        stack_path: "crashes/anr.stack.txt",
        repro_path: [2],
      },
      {
        id: "current",
        ts: "2026-07-29T00:00:02Z",
        signature: current.fingerprint,
        signature_version: current.signature_version,
        kind: "java",
        stack_path: "crashes/same.stack.txt",
        repro_path: [3],
      },
    ].map((record) => JSON.stringify(record)).join("\n")}\n`,
  );

  const result = await analyzeSession(sessionDir);
  assert.equal(result.total, 3);
  assert.equal(result.unique, 2);
  const unversioned = result.groups.find(
    (group) => group.signature_version === "unversioned",
  );
  const versioned = result.groups.find(
    (group) => group.signature_version === "java-v2",
  );
  assert.equal(unversioned?.fingerprint, current.fingerprint);
  assert.equal(unversioned?.occurrences, 2);
  assert.equal(unversioned?.kind, "java");
  assert.deepEqual(unversioned?.instance_ids, ["legacy-a", "legacy-b"]);
  assert.equal(unversioned?.legacy_fingerprint, undefined);
  assert.equal(versioned?.fingerprint, current.fingerprint);
  assert.equal(versioned?.occurrences, 1);
  assert.deepEqual(versioned?.instance_ids, ["current"]);
});

test("analyzeSession validates and preserves normalized remote crash sources", async (t) => {
  const sessionDir = await mkdtemp(path.join(os.tmpdir(), "analyzer-source-session-"));
  t.after(async () => rm(sessionDir, { recursive: true, force: true }));
  await mkdir(path.join(sessionDir, "crashes"));
  await writeFile(path.join(sessionDir, "crashes", "crash-1.stack.txt"), JAVA_STACK);
  await writeFile(
    path.join(sessionDir, "crashes.jsonl"),
    `${JSON.stringify({
      id: "crash-1",
      ts: "2026-07-29T00:00:00Z",
      signature: "IllegalStateException",
      kind: "java",
      stack_path: "crashes/crash-1.stack.txt",
      repro_path: [],
      source: {
        provider: "firebase-crashlytics",
        external_key: firebaseExternalKey({
          project: "project",
          app: "app",
          issue: "issue",
          event: "event",
          signature: "IllegalStateException",
        }),
        project: "project",
        app: "app",
        issue: "issue",
        event: "event",
        occurred: "2026-07-29T00:00:00Z",
        metrics: { events: 10, users: 3 },
      },
    })}\n`,
  );

  const result = await analyzeSession(sessionDir);
  assert.deepEqual(result.groups[0]?.sources, [{
    provider: "firebase-crashlytics",
    external_key: firebaseExternalKey({
      project: "project",
      app: "app",
      issue: "issue",
      event: "event",
      signature: "IllegalStateException",
    }),
    project: "project",
    app: "app",
    issue: "issue",
    event: "event",
    occurred: "2026-07-29T00:00:00Z",
    metrics: { events: 10, users: 3 },
  }]);
});

test("analyzeSession accepts versioned Firebase identities and preserves their version", async (t) => {
  const sessionDir = await mkdtemp(path.join(os.tmpdir(), "analyzer-versioned-source-session-"));
  t.after(async () => rm(sessionDir, { recursive: true, force: true }));
  await mkdir(path.join(sessionDir, "crashes"));
  await writeFile(path.join(sessionDir, "crashes", "crash-1.stack.txt"), JAVA_STACK);
  const signature = computeSignature(JAVA_STACK);
  const source = {
    provider: "firebase-crashlytics",
    external_key: firebaseExternalKey({
      project: "project",
      app: "app",
      issue: "issue",
      event: "event",
      signature: signature.fingerprint,
      signatureVersion: signature.signature_version,
    }),
    project: "project",
    app: "app",
    issue: "issue",
    event: "event",
  };
  await writeFile(
    path.join(sessionDir, "crashes.jsonl"),
    `${JSON.stringify({
      id: "crash-1",
      ts: "2026-07-29T00:00:00Z",
      signature: signature.fingerprint,
      signature_version: signature.signature_version,
      signature_degraded: false,
      cross_source_comparable: true,
      kind: "java",
      stack_path: "crashes/crash-1.stack.txt",
      repro_path: [],
      source,
    })}\n`,
  );

  const result = await analyzeSession(sessionDir);
  assert.equal(result.unique, 1);
  assert.equal(result.groups[0]?.signature_version, signature.signature_version);
  assert.equal(result.groups[0]?.fingerprint, signature.fingerprint);
  assert.equal(result.groups[0]?.signature_degraded, false);
  assert.equal(result.groups[0]?.cross_source_comparable, true);
  assert.deepEqual(result.groups[0]?.sources, [source]);
});

test("analyzeSession never upgrades unknown eligibility attestations", async (t) => {
  const sessionDir = await mkdtemp(path.join(os.tmpdir(), "analyzer-eligibility-session-"));
  t.after(async () => rm(sessionDir, { recursive: true, force: true }));
  await mkdir(path.join(sessionDir, "crashes"));
  await writeFile(path.join(sessionDir, "crashes", "shared.stack.txt"), JAVA_STACK);
  const identity = computeSignature(JAVA_STACK);
  const base = (id: string) => ({
    id,
    ts: "2026-07-29T00:00:00Z",
    signature: identity.fingerprint,
    signature_version: identity.signature_version,
    kind: "java",
    stack_path: "crashes/shared.stack.txt",
    repro_path: [],
  });
  const writeRecords = async (second: Record<string, unknown>) => writeFile(
    path.join(sessionDir, "crashes.jsonl"),
    `${JSON.stringify(base("c1"))}\n${JSON.stringify({ ...base("c2"), ...second })}\n`,
  );

  await writeRecords({
    signature_degraded: false,
    cross_source_comparable: true,
  });
  const unknown = await analyzeSession(sessionDir);
  assert.equal(unknown.groups[0]?.signature_degraded, undefined);
  assert.equal(unknown.groups[0]?.cross_source_comparable, undefined);

  await writeRecords({
    signature_degraded: true,
    cross_source_comparable: false,
  });
  const conclusivelyIneligible = await analyzeSession(sessionDir);
  assert.equal(conclusivelyIneligible.groups[0]?.signature_degraded, true);
  assert.equal(conclusivelyIneligible.groups[0]?.cross_source_comparable, false);
});

test("analyzeSession rejects invalid or stack-mismatched stored signature identities", async (t) => {
  const sessionDir = await mkdtemp(path.join(os.tmpdir(), "analyzer-signature-identity-session-"));
  t.after(async () => rm(sessionDir, { recursive: true, force: true }));
  await mkdir(path.join(sessionDir, "crashes"));
  await writeFile(path.join(sessionDir, "crashes", "crash-1.stack.txt"), JAVA_STACK);
  const signature = computeSignature(JAVA_STACK);
  const base = {
    id: "crash-1",
    ts: "2026-07-29T00:00:00Z",
    kind: "java",
    stack_path: "crashes/crash-1.stack.txt",
    repro_path: [],
  };
  const writeRecord = async (record: unknown) => writeFile(
    path.join(sessionDir, "crashes.jsonl"),
    `${JSON.stringify(record)}\n`,
  );

  await writeRecord({
    ...base,
    signature: signature.fingerprint,
    signature_version: "future-v3",
  });
  await assert.rejects(analyzeSession(sessionDir), /signature_version is invalid/u);

  await writeRecord({
    ...base,
    signature: "0".repeat(12),
    signature_version: signature.signature_version,
  });
  await assert.rejects(analyzeSession(sessionDir), /do not match the archived stack/u);

  await writeRecord({
    ...base,
    signature: signature.fingerprint,
    signature_version: "v1",
  });
  await assert.rejects(analyzeSession(sessionDir), /do not match the archived stack/u);

  await writeRecord({
    ...base,
    signature: signature.fingerprint,
    signature_version: signature.signature_version,
    source: {
      provider: "firebase-crashlytics",
      external_key: firebaseExternalKey({
        project: "project",
        app: "app",
        issue: "issue",
        event: "event",
        signature: signature.fingerprint,
      }),
      project: "project",
      app: "app",
      issue: "issue",
      event: "event",
    },
  });
  await assert.rejects(analyzeSession(sessionDir), /crash signature identity/u);
});

test("analyzeSession strictly validates and separates Java v1 from java-v2", async (t) => {
  const sessionDir = await mkdtemp(path.join(os.tmpdir(), "analyzer-java-version-session-"));
  t.after(async () => rm(sessionDir, { recursive: true, force: true }));
  const crashesDir = path.join(sessionDir, "crashes");
  await mkdir(crashesDir);
  await writeFile(path.join(crashesDir, "same.stack.txt"), JAVA_STACK);
  const current = computeSignature(JAVA_STACK);
  assert.equal(current.signature_version, "java-v2");
  assert.ok(current.legacy_fingerprint);
  await writeFile(
    path.join(sessionDir, "crashes.jsonl"),
    `${[
      {
        id: "legacy-v1",
        ts: "2026-07-29T00:00:00Z",
        signature: current.legacy_fingerprint,
        signature_version: "v1",
        kind: "java",
        stack_path: "crashes/same.stack.txt",
        repro_path: [],
      },
      {
        id: "current-v2",
        ts: "2026-07-29T00:00:01Z",
        signature: current.fingerprint,
        signature_version: current.signature_version,
        kind: "java",
        stack_path: "crashes/same.stack.txt",
        repro_path: [],
      },
    ].map((record) => JSON.stringify(record)).join("\n")}\n`,
  );

  const result = await analyzeSession(sessionDir);
  assert.equal(result.unique, 2);
  assert.deepEqual(
    result.groups
      .map((group) => [group.signature_version, group.fingerprint])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
    [
      ["java-v2", current.fingerprint],
      ["v1", current.legacy_fingerprint],
    ],
  );
});

test("analyzeSession never merges iOS records across signature versions", async (t) => {
  const sessionDir = await mkdtemp(path.join(os.tmpdir(), "analyzer-version-domain-session-"));
  t.after(async () => rm(sessionDir, { recursive: true, force: true }));
  const crashesDir = path.join(sessionDir, "crashes");
  await mkdir(crashesDir);
  await writeFile(path.join(crashesDir, "legacy.stack.txt"), IOS_V2_STACK);
  await writeFile(path.join(crashesDir, "current.stack.txt"), IOS_V2_STACK);
  const current = computeSignature(IOS_V2_STACK);
  assert.equal(current.signature_version, "ios-v2");
  assert.ok(current.legacy_fingerprint);
  await writeFile(
    path.join(sessionDir, "crashes.jsonl"),
    `${[
      {
        id: "legacy",
        ts: "2026-07-29T00:00:00Z",
        signature: current.legacy_fingerprint,
        signature_version: "v1",
        kind: "ios",
        stack_path: "crashes/legacy.stack.txt",
        repro_path: [],
      },
      {
        id: "current",
        ts: "2026-07-29T00:00:01Z",
        signature: current.fingerprint,
        signature_version: current.signature_version,
        kind: "ios",
        stack_path: "crashes/current.stack.txt",
        repro_path: [],
      },
    ].map((record) => JSON.stringify(record)).join("\n")}\n`,
  );

  const result = await analyzeSession(sessionDir);
  assert.equal(result.total, 2);
  assert.equal(result.unique, 2);
  assert.deepEqual(
    result.groups
      .map((group) => [group.signature_version, group.instance_ids[0]])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
    [["ios-v2", "current"], ["v1", "legacy"]],
  );
});

test("analyzeSession rejects relative session_dir and escaped stack paths", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "analyzer-escape-session-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, "session");
  await mkdir(sessionDir);
  const outside = path.join(root, "outside.stack.txt");
  await writeFile(outside, JAVA_STACK);

  await writeCrashRecord(sessionDir, outside);
  await assert.rejects(analyzeSession(sessionDir), /non-empty relative path/i);

  await writeCrashRecord(sessionDir, "../outside.stack.txt");
  await assert.rejects(analyzeSession(sessionDir), /stay inside session_dir/i);

  await assert.rejects(
    analyzeSession(path.relative(process.cwd(), sessionDir)),
    /session_dir must be absolute/i,
  );
});

test("analyzeSession rejects stack symlinks and FIFOs without blocking", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX symlink/FIFO test");
    return;
  }

  const sessionDir = await mkdtemp(path.join(os.tmpdir(), "analyzer-special-session-"));
  t.after(async () => rm(sessionDir, { recursive: true, force: true }));
  const crashesDir = path.join(sessionDir, "crashes");
  await mkdir(crashesDir);
  const regular = path.join(crashesDir, "regular.stack.txt");
  await writeFile(regular, JAVA_STACK);
  const linked = path.join(crashesDir, "linked.stack.txt");
  await symlink(regular, linked);
  await writeCrashRecord(sessionDir, "crashes/linked.stack.txt");
  await assert.rejects(analyzeSession(sessionDir), /symbolic links/i);

  const fifo = path.join(crashesDir, "report.fifo");
  await execFileAsync("mkfifo", [fifo]);
  await writeCrashRecord(sessionDir, "crashes/report.fifo");
  await assert.rejects(analyzeSession(sessionDir), /regular file/i);
});

test("analyzeSession rejects hard-linked and invalid UTF-8 evidence", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX hard-link test");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "analyzer-integrity-session-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, "session");
  const crashesDir = path.join(sessionDir, "crashes");
  await mkdir(crashesDir, { recursive: true });
  const outside = path.join(root, "outside.stack.txt");
  const hardLink = path.join(crashesDir, "hard-linked.stack.txt");
  await writeFile(outside, JAVA_STACK);
  await link(outside, hardLink);
  await writeCrashRecord(sessionDir, "crashes/hard-linked.stack.txt");
  await assert.rejects(analyzeSession(sessionDir), /single-link regular file/i);

  const invalidStack = path.join(crashesDir, "invalid.stack.txt");
  await writeFile(invalidStack, Buffer.from([0xff, 0xfe, 0xfd]));
  await writeCrashRecord(sessionDir, "crashes/invalid.stack.txt");
  await assert.rejects(analyzeSession(sessionDir), /not valid UTF-8/i);

  await writeFile(path.join(sessionDir, "crashes.jsonl"), Buffer.from([0xff]));
  await assert.rejects(analyzeSession(sessionDir), /not valid UTF-8/i);
  await writeFile(path.join(sessionDir, "crashes.jsonl"), "  \t\n", "utf8");
  await assert.rejects(analyzeSession(sessionDir), /whitespace-only/i);
});

test("analyzeSession does not treat a broken crashes.jsonl symlink as missing", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX broken-symlink test");
    return;
  }
  const sessionDir = await mkdtemp(path.join(os.tmpdir(), "analyzer-broken-session-"));
  t.after(async () => rm(sessionDir, { recursive: true, force: true }));
  await symlink("missing-target.jsonl", path.join(sessionDir, "crashes.jsonl"));
  await assert.rejects(analyzeSession(sessionDir), /symbolic links/i);
});

test("session analysis fails closed when a mandatory JSONL index is missing", async (t) => {
  const sessionDir = await mkdtemp(path.join(os.tmpdir(), "analyzer-missing-index-"));
  t.after(async () => rm(sessionDir, { recursive: true, force: true }));
  await assert.rejects(analyzeSession(sessionDir), /ENOENT|no such file/i);
  await assert.rejects(
    suggestMinimalPath(sessionDir, [], 1),
    /ENOENT|no such file/i,
  );
});

test("analyzeSession rejects oversized stack and JSONL files", async (t) => {
  const sessionDir = await mkdtemp(path.join(os.tmpdir(), "analyzer-large-session-"));
  t.after(async () => rm(sessionDir, { recursive: true, force: true }));
  const crashesDir = path.join(sessionDir, "crashes");
  await mkdir(crashesDir);
  const oversizedStack = path.join(crashesDir, "oversized.stack.txt");
  await writeFile(oversizedStack, "");
  await truncate(oversizedStack, MAX_SESSION_STACK_BYTES + 1);
  await writeCrashRecord(sessionDir, "crashes/oversized.stack.txt");
  await assert.rejects(analyzeSession(sessionDir), /stack_path exceeds .* size limit/i);

  const crashesJsonl = path.join(sessionDir, "crashes.jsonl");
  await truncate(crashesJsonl, MAX_SESSION_JSONL_BYTES + 1);
  await assert.rejects(analyzeSession(sessionDir), /crashes\.jsonl exceeds .* size limit/i);
});

test("analyzeSession enforces crash count before parsing the over-limit record", async (t) => {
  const sessionDir = await mkdtemp(path.join(os.tmpdir(), "analyzer-count-session-"));
  t.after(async () => rm(sessionDir, { recursive: true, force: true }));
  const valid = Array.from({ length: MAX_SESSION_CRASHES }, (_, index) => JSON.stringify({
    id: `c${index}`,
    ts: "2026-07-28T00:00:00Z",
    signature: "boom",
    stack_path: "crashes/shared.stack.txt",
    repro_path: [],
  }));
  await writeFile(
    path.join(sessionDir, "crashes.jsonl"),
    `${valid.join("\n")}\n{this line is deliberately invalid JSON\n`,
  );
  await assert.rejects(
    analyzeSession(sessionDir),
    new RegExp(`${MAX_SESSION_CRASHES} record limit`, "i"),
  );
});

test("analyzeSession enforces the aggregate session stack budget", async (t) => {
  const sessionDir = await mkdtemp(path.join(os.tmpdir(), "analyzer-total-session-"));
  t.after(async () => rm(sessionDir, { recursive: true, force: true }));
  const crashesDir = path.join(sessionDir, "crashes");
  await mkdir(crashesDir);
  const shared = path.join(crashesDir, "shared.stack.txt");
  await writeFile(shared, "");
  await truncate(shared, MAX_SESSION_STACK_BYTES);
  const count = Math.floor(MAX_SESSION_TOTAL_STACK_BYTES / MAX_SESSION_STACK_BYTES) + 1;
  const records = Array.from({ length: count }, (_, index) => ({
    id: `c${index}`,
    ts: "2026-07-28T00:00:00Z",
    signature: "boom",
    stack_path: "crashes/shared.stack.txt",
    repro_path: [],
  }));
  await writeFile(
    path.join(sessionDir, "crashes.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  await assert.rejects(analyzeSession(sessionDir), /session stack input exceeds .* total/i);
});

test("session JSONL records receive strict runtime validation", async (t) => {
  const sessionDir = await mkdtemp(path.join(os.tmpdir(), "analyzer-invalid-session-"));
  t.after(async () => rm(sessionDir, { recursive: true, force: true }));

  await writeFile(path.join(sessionDir, "crashes.jsonl"), `${JSON.stringify({
    id: 7,
    ts: "2026-07-28T00:00:00Z",
    signature: "boom",
    stack_path: "crashes/c1.stack.txt",
    repro_path: [],
  })}\n`);
  await assert.rejects(analyzeSession(sessionDir), /\.id must be a non-empty string/i);

  await writeFile(path.join(sessionDir, "steps.jsonl"), `${JSON.stringify({
    index: 1,
    ts: "2026-07-28T00:00:00Z",
    action: "tap",
    result: "maybe",
  })}\n`);
  await assert.rejects(
    suggestMinimalPath(sessionDir, [1], 1),
    /\.result is invalid/i,
  );

  await writeFile(path.join(sessionDir, "steps.jsonl"), `${JSON.stringify({
    index: 1,
    ts: "2026-07-28T00:00:00Z",
    action: "tap",
    attacker_controlled: true,
  })}\n`);
  await assert.rejects(
    suggestMinimalPath(sessionDir, [1], 1),
    /attacker_controlled is not supported/i,
  );
});

test("analyzeSession strictly rejects malformed remote source objects", async (t) => {
  const sessionDir = await mkdtemp(path.join(os.tmpdir(), "analyzer-source-invalid-"));
  t.after(async () => rm(sessionDir, { recursive: true, force: true }));
  await mkdir(path.join(sessionDir, "crashes"));
  await writeFile(path.join(sessionDir, "crashes", "c1.stack.txt"), JAVA_STACK);

  const base = {
    id: "c1",
    ts: "2026-07-29T00:00:00Z",
    signature: "boom",
    stack_path: "crashes/c1.stack.txt",
    repro_path: [],
  };
  await writeFile(path.join(sessionDir, "crashes.jsonl"), `${JSON.stringify({
    ...base,
    source: {
      provider: "other-provider",
      external_key: "key",
      injected: true,
    },
  })}\n`);
  await assert.rejects(analyzeSession(sessionDir), /source\.injected is not supported/i);

  await writeFile(path.join(sessionDir, "crashes.jsonl"), `${JSON.stringify({
    ...base,
    source: {
      provider: "other-provider",
      external_key: "key",
      metrics: { users: -1 },
    },
  })}\n`);
  await assert.rejects(analyzeSession(sessionDir), /metrics\.users must be a bounded/i);

  await writeFile(path.join(sessionDir, "crashes.jsonl"), `${JSON.stringify({
    ...base,
    source: {
      provider: "other-provider",
      external_key: "key",
      occurred: "yesterday",
    },
  })}\n`);
  await assert.rejects(analyzeSession(sessionDir), /occurred must be an RFC 3339/i);

  await writeFile(path.join(sessionDir, "crashes.jsonl"), `${JSON.stringify({
    ...base,
    source: {
      provider: "firebase-crashlytics",
      external_key: "0".repeat(64),
      project: "project",
      app: "app",
      issue: "issue",
    },
  })}\n`);
  await assert.rejects(
    analyzeSession(sessionDir),
    /must include project, app, issue, and event for firebase-crashlytics/i,
  );

  await writeFile(path.join(sessionDir, "crashes.jsonl"), `${JSON.stringify({
    ...base,
    source: {
      provider: "firebase-crashlytics",
      external_key: "0".repeat(64),
      project: "project",
      app: "app",
      issue: "issue",
      event: "event",
    },
  })}\n`);
  await assert.rejects(
    analyzeSession(sessionDir),
    /external_key does not match the Firebase event and crash signature/i,
  );
});
