import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  graphSummary,
  listSeenElements,
  loadGraph,
  markElementSeen,
  pickNextUnseen,
  recordEdge,
  recordPage,
} from "./graph.js";

test("recordPage creates and increments", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "graph-test-"));
  try {
    const p1 = await recordPage(tmp, "abc", { summary: "home" });
    assert.equal(p1.visit_count, 1);
    assert.equal(p1.summary, "home");
    const p2 = await recordPage(tmp, "abc");
    assert.equal(p2.visit_count, 2);
    assert.equal(p2.first_seen, p1.first_seen);
    assert.notEqual(p2.last_seen, p1.first_seen);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("recordEdge appends", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "graph-test-"));
  try {
    await recordEdge(tmp, "a", "click login", "b");
    await recordEdge(tmp, "b", "click submit", "c");
    const g = await loadGraph(tmp);
    assert.equal(g.edges.length, 2);
    assert.equal(g.edges[0]!.from, "a");
    assert.equal(g.edges[1]!.action, "click submit");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("markElementSeen + pickNextUnseen flow", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "graph-test-"));
  try {
    const first = await pickNextUnseen(tmp, "p1", ["btn1", "btn2", "btn3"]);
    assert.equal(first, "btn1");

    const r = await markElementSeen(tmp, "p1", "btn1");
    assert.equal(r.added, true);
    assert.equal(r.total, 1);

    const dup = await markElementSeen(tmp, "p1", "btn1");
    assert.equal(dup.added, false);
    assert.equal(dup.total, 1);

    const second = await pickNextUnseen(tmp, "p1", ["btn1", "btn2", "btn3"]);
    assert.equal(second, "btn2");

    await markElementSeen(tmp, "p1", "btn2");
    await markElementSeen(tmp, "p1", "btn3");
    const exhausted = await pickNextUnseen(tmp, "p1", ["btn1", "btn2", "btn3"]);
    assert.equal(exhausted, null);

    const seen = await listSeenElements(tmp, "p1");
    assert.deepEqual(seen.sort(), ["btn1", "btn2", "btn3"]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("graphSummary reflects pages/edges/isolated", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "graph-test-"));
  try {
    await recordPage(tmp, "p1", { summary: "home" });
    await recordPage(tmp, "p2");
    await recordPage(tmp, "p3");
    await recordEdge(tmp, "p1", "click", "p2");
    await markElementSeen(tmp, "p1", "el1");
    await markElementSeen(tmp, "p1", "el2");
    // p2 and p3 have no outgoing edges
    const s = await graphSummary(tmp);
    assert.equal(s.pages_count, 3);
    assert.equal(s.edges_count, 1);
    assert.equal(s.isolated_pages, 2);
    assert.equal(s.most_visited?.hash, "p1");
    assert.ok(s.least_explored);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
