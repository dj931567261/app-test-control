// QA state graph storage per session.
// One state-graph.json file per session, atomic-write on every mutation.

import path from "node:path";
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";

export interface PageData {
  hash: string;
  first_seen: string;
  last_seen: string;
  visit_count: number;
  elements_seen: string[]; // element keys clicked from this page
  summary?: string;        // optional human description
  screenshot?: string;     // relative path
}

export interface Edge {
  from: string;
  action: string;
  to: string;
  ts: string;
}

export interface GraphState {
  pages: Record<string, PageData>;
  edges: Edge[];
}

function graphPath(sessionDir: string): string {
  return path.join(sessionDir, "state-graph.json");
}

export async function loadGraph(sessionDir: string): Promise<GraphState> {
  try {
    const txt = await readFile(graphPath(sessionDir), "utf8");
    return JSON.parse(txt) as GraphState;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { pages: {}, edges: [] };
    }
    throw e;
  }
}

async function saveGraph(sessionDir: string, g: GraphState): Promise<void> {
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const final = graphPath(sessionDir);
  const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(g, null, 2), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(tmp, final);
}

export async function recordPage(
  sessionDir: string,
  hash: string,
  opts: { summary?: string; screenshot?: string } = {},
): Promise<PageData> {
  const g = await loadGraph(sessionDir);
  const now = new Date().toISOString();
  const existing = g.pages[hash];
  let page: PageData;
  if (existing) {
    page = {
      ...existing,
      last_seen: now,
      visit_count: existing.visit_count + 1,
      ...(opts.summary ? { summary: opts.summary } : {}),
      ...(opts.screenshot ? { screenshot: opts.screenshot } : {}),
    };
  } else {
    page = {
      hash,
      first_seen: now,
      last_seen: now,
      visit_count: 1,
      elements_seen: [],
      ...(opts.summary ? { summary: opts.summary } : {}),
      ...(opts.screenshot ? { screenshot: opts.screenshot } : {}),
    };
  }
  g.pages[hash] = page;
  await saveGraph(sessionDir, g);
  return page;
}

export async function recordEdge(
  sessionDir: string,
  from: string,
  action: string,
  to: string,
): Promise<Edge> {
  const g = await loadGraph(sessionDir);
  const edge: Edge = { from, action, to, ts: new Date().toISOString() };
  g.edges.push(edge);
  await saveGraph(sessionDir, g);
  return edge;
}

export async function markElementSeen(
  sessionDir: string,
  pageHash: string,
  elementKey: string,
): Promise<{ pageHash: string; added: boolean; total: number }> {
  const g = await loadGraph(sessionDir);
  let page = g.pages[pageHash];
  if (!page) {
    const now = new Date().toISOString();
    page = {
      hash: pageHash,
      first_seen: now,
      last_seen: now,
      visit_count: 0,
      elements_seen: [],
    };
    g.pages[pageHash] = page;
  }
  let added = false;
  if (!page.elements_seen.includes(elementKey)) {
    page.elements_seen.push(elementKey);
    added = true;
  }
  await saveGraph(sessionDir, g);
  return { pageHash, added, total: page.elements_seen.length };
}

export async function listSeenElements(
  sessionDir: string,
  pageHash: string,
): Promise<string[]> {
  const g = await loadGraph(sessionDir);
  return g.pages[pageHash]?.elements_seen ?? [];
}

export interface GraphSummary {
  pages_count: number;
  edges_count: number;
  most_visited?: { hash: string; visit_count: number; summary?: string };
  least_explored?: { hash: string; unexplored_hint: string }; // page with fewest elements_seen
  isolated_pages: number;   // pages with no outgoing edges
}

export async function graphSummary(sessionDir: string): Promise<GraphSummary> {
  const g = await loadGraph(sessionDir);
  const pages = Object.values(g.pages);
  const outgoing = new Set(g.edges.map((e) => e.from));
  const isolated = pages.filter((p) => !outgoing.has(p.hash)).length;
  const mostVisited = pages.reduce<PageData | undefined>(
    (acc, p) => (!acc || p.visit_count > acc.visit_count ? p : acc),
    undefined,
  );
  const leastExplored = pages.reduce<PageData | undefined>(
    (acc, p) => (!acc || p.elements_seen.length < acc.elements_seen.length ? p : acc),
    undefined,
  );
  const summary: GraphSummary = {
    pages_count: pages.length,
    edges_count: g.edges.length,
    isolated_pages: isolated,
  };
  if (mostVisited) {
    summary.most_visited = {
      hash: mostVisited.hash,
      visit_count: mostVisited.visit_count,
      ...(mostVisited.summary ? { summary: mostVisited.summary } : {}),
    };
  }
  if (leastExplored) {
    summary.least_explored = {
      hash: leastExplored.hash,
      unexplored_hint: `${leastExplored.elements_seen.length} elements clicked from this page`,
    };
  }
  return summary;
}

/**
 * Pick the first candidate not yet seen on this page.
 * Caller computes element_key for each candidate (typically `resource_id`,
 * or `text:<text>` fallback). Returns null if every candidate has been seen.
 */
export async function pickNextUnseen(
  sessionDir: string,
  pageHash: string,
  candidateKeys: string[],
): Promise<string | null> {
  const seen = new Set(await listSeenElements(sessionDir, pageHash));
  for (const key of candidateKeys) {
    if (!seen.has(key)) return key;
  }
  return null;
}
