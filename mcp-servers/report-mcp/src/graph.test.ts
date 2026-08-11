import assert from "node:assert/strict";
import { link, mkdtemp, rm, stat, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import {
  MAX_GRAPH_BYTES,
  graphSummary,
  listSeenElements,
  loadGraph,
  markElementSeen,
  pickNextUnseen,
  recordEdge,
  recordPage,
} from "./graph.js";
import { createSession, type CreatedSession } from "./sessions.js";

const HASH_A = "a".repeat(12);
const HASH_B = "b".repeat(12);
const HASH_C = "c".repeat(12);

async function makeSession(
  t: TestContext,
  name: string,
): Promise<{ root: string; session: CreatedSession }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return {
    root,
    session: await createSession({ name, workspaceRoot: root }),
  };
}

test("recordPage creates and increments", async (t) => {
  const { session } = await makeSession(t, "record-page");
  const first = await recordPage(session.dir, HASH_A, {
    summary: "home",
    screenshot: "steps/001.png",
  });
  assert.equal(first.visit_count, 1);
  assert.equal(first.summary, "home");
  assert.equal(first.screenshot, "steps/001.png");

  const second = await recordPage(session.dir, HASH_A);
  assert.equal(second.visit_count, 2);
  assert.equal(second.first_seen, first.first_seen);
  assert.ok(Date.parse(second.last_seen) >= Date.parse(first.last_seen));
  assert.equal((await stat(path.join(session.dir, "state-graph.json"))).mode & 0o077, 0);
});

test("recordEdge appends", async (t) => {
  const { session } = await makeSession(t, "record-edge");
  await recordEdge(session.dir, HASH_A, "click login", HASH_B);
  await recordEdge(session.dir, HASH_B, "click submit", HASH_C);
  const graph = await loadGraph(session.dir);
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.edges[0]!.from, HASH_A);
  assert.equal(graph.edges[1]!.action, "click submit");
});

test("markElementSeen + pickNextUnseen flow", async (t) => {
  const { session } = await makeSession(t, "element-flow");
  const first = await pickNextUnseen(session.dir, HASH_A, ["btn1", "btn2", "btn3"]);
  assert.equal(first, "btn1");

  const recorded = await markElementSeen(session.dir, HASH_A, "btn1");
  assert.equal(recorded.added, true);
  assert.equal(recorded.total, 1);

  const duplicate = await markElementSeen(session.dir, HASH_A, "btn1");
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.total, 1);

  const second = await pickNextUnseen(session.dir, HASH_A, ["btn1", "btn2", "btn3"]);
  assert.equal(second, "btn2");

  await markElementSeen(session.dir, HASH_A, "btn2");
  await markElementSeen(session.dir, HASH_A, "btn3");
  assert.equal(
    await pickNextUnseen(session.dir, HASH_A, ["btn1", "btn2", "btn3"]),
    null,
  );
  assert.deepEqual(await listSeenElements(session.dir, HASH_A), ["btn1", "btn2", "btn3"]);
});

test("graphSummary reflects pages, edges, and isolated pages", async (t) => {
  const { session } = await makeSession(t, "summary");
  await recordPage(session.dir, HASH_A, { summary: "home" });
  await recordPage(session.dir, HASH_B);
  await recordPage(session.dir, HASH_C);
  await recordEdge(session.dir, HASH_A, "click", HASH_B);
  await markElementSeen(session.dir, HASH_A, "el1");
  await markElementSeen(session.dir, HASH_A, "el2");

  const summary = await graphSummary(session.dir);
  assert.equal(summary.pages_count, 3);
  assert.equal(summary.edges_count, 1);
  assert.equal(summary.isolated_pages, 2);
  assert.equal(summary.most_visited?.hash, HASH_A);
  assert.ok(summary.least_explored);
});

test("missing state graph is a bounded empty graph", async (t) => {
  const { session } = await makeSession(t, "missing");
  assert.deepEqual(await loadGraph(session.dir), { pages: {}, edges: [] });
});

test("concurrent page and edge mutations do not lose updates", async (t) => {
  const { session } = await makeSession(t, "concurrent");
  const writes = 16;
  await Promise.all([
    ...Array.from({ length: writes }, () => recordPage(session.dir, HASH_A)),
    ...Array.from({ length: writes }, (_, index) =>
      recordEdge(session.dir, HASH_A, `action-${index}`, HASH_B)
    ),
  ]);

  const graph = await loadGraph(session.dir);
  assert.equal(graph.pages[HASH_A]?.visit_count, writes);
  assert.equal(graph.edges.length, writes);
  assert.deepEqual(
    new Set(graph.edges.map((edge) => edge.action)),
    new Set(Array.from({ length: writes }, (_, index) => `action-${index}`)),
  );
});

test("state graph reads reject symbolic and hard links", async (t) => {
  const { root, session } = await makeSession(t, "links");
  const graphPath = path.join(session.dir, "state-graph.json");
  const external = path.join(root, "external.json");
  await writeFile(external, JSON.stringify({ pages: {}, edges: [] }), "utf8");
  await symlink(external, graphPath);
  await assert.rejects(
    loadGraph(session.dir),
    /single-link regular file|symbolic link|ELOOP/i,
  );

  await unlink(graphPath);
  await writeFile(graphPath, JSON.stringify({ pages: {}, edges: [] }), {
    encoding: "utf8",
    mode: 0o600,
  });
  const hardLink = path.join(root, "graph-hard-link.json");
  await link(graphPath, hardLink);
  await assert.rejects(loadGraph(session.dir), /single-link regular file/i);
});

test("state graph reads reject invalid UTF-8 and oversized files", async (t) => {
  const { session } = await makeSession(t, "bounded-read");
  const graphPath = path.join(session.dir, "state-graph.json");
  await writeFile(graphPath, Buffer.from([0xc3, 0x28]), { mode: 0o600 });
  await assert.rejects(loadGraph(session.dir), /not valid UTF-8/i);

  await writeFile(graphPath, "", { mode: 0o600 });
  await truncate(graphPath, MAX_GRAPH_BYTES + 1);
  await assert.rejects(loadGraph(session.dir), /byte size limit/i);
});

test("state graph uses a closed schema and rejects escaped screenshot paths", async (t) => {
  const { session } = await makeSession(t, "closed-schema");
  const graphPath = path.join(session.dir, "state-graph.json");
  const now = new Date().toISOString();
  const validPage = {
    hash: HASH_A,
    first_seen: now,
    last_seen: now,
    visit_count: 1,
    elements_seen: [],
  };
  const invalidGraphs = [
    { pages: {}, edges: [], unexpected: true },
    { pages: { [HASH_A]: { ...validPage, unexpected: true } }, edges: [] },
    { pages: { [HASH_A]: { ...validPage, hash: HASH_B } }, edges: [] },
    {
      pages: {
        [HASH_A]: { ...validPage, screenshot: "../private.png" },
      },
      edges: [],
    },
  ];

  for (const invalid of invalidGraphs) {
    await writeFile(graphPath, JSON.stringify(invalid), { encoding: "utf8", mode: 0o600 });
    await assert.rejects(loadGraph(session.dir), /closed schema/i);
  }
  await assert.rejects(
    recordPage(session.dir, HASH_A, { screenshot: "../private.png" }),
    /generated screenshot path/i,
  );
  await assert.rejects(recordPage(session.dir, "__proto__"), /invalid_string|Invalid/i);
});
