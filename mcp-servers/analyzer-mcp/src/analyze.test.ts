import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { suggestMinimalPath } from "./analyze.js";

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
