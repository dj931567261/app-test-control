// QA state graph storage per session.
// One bounded state-graph.json file per session, serialized by the session lock.

import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  readBoundedRegularTextFile,
  withSessionLock,
} from "./sessions.js";

export const MAX_GRAPH_BYTES = 16 * 1024 * 1024;
export const MAX_GRAPH_PAGES = 10_000;
export const MAX_GRAPH_EDGES = 100_000;
export const MAX_GRAPH_ELEMENTS_PER_PAGE = 10_000;
export const MAX_GRAPH_CANDIDATES = 10_000;

const MAX_SUMMARY_CHARS = 2_048;
const MAX_ACTION_CHARS = 4_096;
const MAX_ELEMENT_KEY_CHARS = 4_096;
const GRAPH_FILENAME = "state-graph.json";
const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const INLINE_CONTROL_RE = /[\u0000-\u001f\u007f]/;

function boundedInlineString(maxChars: number) {
  return z
    .string()
    .min(1)
    .max(maxChars)
    .refine((value) => value === value.trim(), "must not have surrounding whitespace")
    .refine((value) => !INLINE_CONTROL_RE.test(value), "must be a single printable line");
}

/** ui-mcp page_fingerprint emits exactly twelve lowercase hexadecimal chars. */
export const pageHashSchema = z.string().regex(/^[a-f0-9]{12}$/);
const timestampSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) => RFC3339_RE.test(value) && Number.isFinite(Date.parse(value)),
    "must be a valid RFC 3339 timestamp",
  );
const summarySchema = boundedInlineString(MAX_SUMMARY_CHARS);
const actionSchema = boundedInlineString(MAX_ACTION_CHARS);
const elementKeySchema = boundedInlineString(MAX_ELEMENT_KEY_CHARS);
const screenshotSchema = boundedInlineString(4_096).refine(
  (value) => /^steps\/[0-9]+\.(?:png|jpg|jpeg|webp)$/.test(value),
  "must be a generated screenshot path inside steps/",
);

const pageDataSchema = z
  .object({
    hash: pageHashSchema,
    first_seen: timestampSchema,
    last_seen: timestampSchema,
    visit_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    elements_seen: z
      .array(elementKeySchema)
      .max(MAX_GRAPH_ELEMENTS_PER_PAGE)
      .superRefine((elements, context) => {
        if (new Set(elements).size !== elements.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "elements_seen must not contain duplicates",
          });
        }
      }),
    summary: summarySchema.optional(),
    screenshot: screenshotSchema.optional(),
  })
  .strict()
  .superRefine((page, context) => {
    if (Date.parse(page.last_seen) < Date.parse(page.first_seen)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["last_seen"],
        message: "last_seen must not precede first_seen",
      });
    }
  });

const edgeSchema = z
  .object({
    from: pageHashSchema,
    action: actionSchema,
    to: pageHashSchema,
    ts: timestampSchema,
  })
  .strict();

export const graphStateSchema = z
  .object({
    pages: z.record(pageHashSchema, pageDataSchema),
    edges: z.array(edgeSchema).max(MAX_GRAPH_EDGES),
  })
  .strict()
  .superRefine((graph, context) => {
    const entries = Object.entries(graph.pages);
    if (entries.length > MAX_GRAPH_PAGES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pages"],
        message: `pages exceeds ${MAX_GRAPH_PAGES} entry limit`,
      });
    }
    for (const [key, page] of entries) {
      if (key !== page.hash) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pages", key, "hash"],
          message: "page hash must match its map key",
        });
      }
    }
  });

export type PageData = z.infer<typeof pageDataSchema>;
export type Edge = z.infer<typeof edgeSchema>;
export type GraphState = z.infer<typeof graphStateSchema>;

function graphPath(sessionDir: string): string {
  return path.join(sessionDir, GRAPH_FILENAME);
}

function emptyGraph(): GraphState {
  return { pages: {}, edges: [] };
}

async function loadGraphUnlocked(sessionDir: string): Promise<GraphState> {
  const finalPath = graphPath(sessionDir);
  try {
    // Check absence before entering the strict reader. Once a path exists, an
    // ENOENT caused by replacement/deletion is a concurrent mutation, not an
    // empty graph, and must therefore propagate.
    await lstat(finalPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return emptyGraph();
    throw error;
  }

  const text = await readBoundedRegularTextFile(
    sessionDir,
    GRAPH_FILENAME,
    MAX_GRAPH_BYTES,
    GRAPH_FILENAME,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${GRAPH_FILENAME} is invalid JSON`);
  }
  const result = graphStateSchema.safeParse(parsed);
  if (!result.success) {
    throw new TypeError(
      `${GRAPH_FILENAME} violates its closed schema: ${result.error.issues[0]?.message ?? "invalid value"}`,
    );
  }
  return result.data;
}

/** Reads are locked too, so callers never observe a graph between mutations. */
export async function loadGraph(sessionDir: string): Promise<GraphState> {
  const resolvedSessionDir = path.resolve(sessionDir);
  return withSessionLock(
    resolvedSessionDir,
    () => loadGraphUnlocked(resolvedSessionDir),
  );
}

async function saveGraphUnlocked(
  sessionDir: string,
  graph: GraphState,
): Promise<void> {
  const validated = graphStateSchema.parse(graph);
  let serialized: string;
  try {
    serialized = JSON.stringify(validated, null, 2);
  } catch {
    throw new TypeError("state graph must be JSON-serializable");
  }
  const bytes = Buffer.from(serialized, "utf8");
  if (bytes.byteLength > MAX_GRAPH_BYTES) {
    throw new RangeError(
      `${GRAPH_FILENAME} exceeds ${MAX_GRAPH_BYTES} byte size limit`,
    );
  }

  const finalPath = graphPath(sessionDir);
  const temporaryPath = path.join(
    sessionDir,
    `.${GRAPH_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  const flags = fsConstants.O_WRONLY
    | fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | (fsConstants.O_NOFOLLOW ?? 0);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryMetadata: Awaited<ReturnType<NonNullable<typeof handle>["stat"]>> | undefined;
  let published = false;
  try {
    handle = await open(temporaryPath, flags, 0o600);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (bytesWritten <= 0) {
        throw new Error("state graph write made no progress");
      }
      offset += bytesWritten;
    }
    temporaryMetadata = await handle.stat({ bigint: true });
    if (
      !temporaryMetadata.isFile()
      || temporaryMetadata.nlink !== 1n
      || temporaryMetadata.size !== BigInt(bytes.byteLength)
      || (temporaryMetadata.mode & 0o077n) !== 0n
    ) {
      throw new Error("state graph temporary file failed its integrity check");
    }
    await handle.sync();
    await handle.close();
    handle = undefined;

    await rename(temporaryPath, finalPath);
    published = true;
    const finalMetadata = await lstat(finalPath, { bigint: true });
    if (
      !finalMetadata.isFile()
      || finalMetadata.isSymbolicLink()
      || finalMetadata.nlink !== 1n
      || finalMetadata.dev !== temporaryMetadata.dev
      || finalMetadata.ino !== temporaryMetadata.ino
      || finalMetadata.size !== temporaryMetadata.size
      || (finalMetadata.mode & 0o077n) !== 0n
    ) {
      throw new Error("published state graph failed its integrity check");
    }

    // Persist the directory entry as well as the file contents before the
    // mutation is reported successful.
    const directoryHandle = await open(
      sessionDir,
      fsConstants.O_RDONLY
        | (fsConstants.O_DIRECTORY ?? 0)
        | (fsConstants.O_NOFOLLOW ?? 0),
    );
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (!published) await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

const recordPageOptionsSchema = z
  .object({
    summary: summarySchema.optional(),
    screenshot: screenshotSchema.optional(),
  })
  .strict();

export async function recordPage(
  sessionDir: string,
  hashInput: string,
  optionsInput: { summary?: string; screenshot?: string } = {},
): Promise<PageData> {
  const hash = pageHashSchema.parse(hashInput);
  const options = recordPageOptionsSchema.parse(optionsInput);
  const resolvedSessionDir = path.resolve(sessionDir);
  return withSessionLock(resolvedSessionDir, async () => {
    const graph = await loadGraphUnlocked(resolvedSessionDir);
    const now = new Date().toISOString();
    const existing = graph.pages[hash];
    const page: PageData = existing
      ? {
          ...existing,
          last_seen: now,
          visit_count: existing.visit_count + 1,
          ...(options.summary !== undefined ? { summary: options.summary } : {}),
          ...(options.screenshot !== undefined
            ? { screenshot: options.screenshot }
            : {}),
        }
      : {
          hash,
          first_seen: now,
          last_seen: now,
          visit_count: 1,
          elements_seen: [],
          ...(options.summary !== undefined ? { summary: options.summary } : {}),
          ...(options.screenshot !== undefined
            ? { screenshot: options.screenshot }
            : {}),
        };
    graph.pages[hash] = page;
    await saveGraphUnlocked(resolvedSessionDir, graph);
    return page;
  });
}

export async function recordEdge(
  sessionDir: string,
  fromInput: string,
  actionInput: string,
  toInput: string,
): Promise<Edge> {
  const from = pageHashSchema.parse(fromInput);
  const action = actionSchema.parse(actionInput);
  const to = pageHashSchema.parse(toInput);
  const resolvedSessionDir = path.resolve(sessionDir);
  return withSessionLock(resolvedSessionDir, async () => {
    const graph = await loadGraphUnlocked(resolvedSessionDir);
    const edge: Edge = { from, action, to, ts: new Date().toISOString() };
    graph.edges.push(edge);
    await saveGraphUnlocked(resolvedSessionDir, graph);
    return edge;
  });
}

export async function markElementSeen(
  sessionDir: string,
  pageHashInput: string,
  elementKeyInput: string,
): Promise<{ pageHash: string; added: boolean; total: number }> {
  const pageHash = pageHashSchema.parse(pageHashInput);
  const elementKey = elementKeySchema.parse(elementKeyInput);
  const resolvedSessionDir = path.resolve(sessionDir);
  return withSessionLock(resolvedSessionDir, async () => {
    const graph = await loadGraphUnlocked(resolvedSessionDir);
    let page = graph.pages[pageHash];
    if (!page) {
      const now = new Date().toISOString();
      page = {
        hash: pageHash,
        first_seen: now,
        last_seen: now,
        visit_count: 0,
        elements_seen: [],
      };
      graph.pages[pageHash] = page;
    }
    const added = !page.elements_seen.includes(elementKey);
    if (added) page.elements_seen.push(elementKey);
    await saveGraphUnlocked(resolvedSessionDir, graph);
    return { pageHash, added, total: page.elements_seen.length };
  });
}

export async function listSeenElements(
  sessionDir: string,
  pageHashInput: string,
): Promise<string[]> {
  const pageHash = pageHashSchema.parse(pageHashInput);
  const graph = await loadGraph(sessionDir);
  return [...(graph.pages[pageHash]?.elements_seen ?? [])];
}

export interface GraphSummary {
  pages_count: number;
  edges_count: number;
  most_visited?: { hash: string; visit_count: number; summary?: string };
  least_explored?: { hash: string; unexplored_hint: string };
  isolated_pages: number;
}

export async function graphSummary(sessionDir: string): Promise<GraphSummary> {
  const graph = await loadGraph(sessionDir);
  const pages = Object.values(graph.pages);
  const outgoing = new Set(graph.edges.map((edge) => edge.from));
  const isolated = pages.filter((page) => !outgoing.has(page.hash)).length;
  const mostVisited = pages.reduce<PageData | undefined>(
    (current, page) =>
      !current || page.visit_count > current.visit_count ? page : current,
    undefined,
  );
  const leastExplored = pages.reduce<PageData | undefined>(
    (current, page) =>
      !current || page.elements_seen.length < current.elements_seen.length
        ? page
        : current,
    undefined,
  );
  const summary: GraphSummary = {
    pages_count: pages.length,
    edges_count: graph.edges.length,
    isolated_pages: isolated,
  };
  if (mostVisited) {
    summary.most_visited = {
      hash: mostVisited.hash,
      visit_count: mostVisited.visit_count,
      ...(mostVisited.summary !== undefined
        ? { summary: mostVisited.summary }
        : {}),
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

const candidateKeysSchema = z
  .array(elementKeySchema)
  .max(MAX_GRAPH_CANDIDATES);

/** Pick the first candidate not yet seen on this page. */
export async function pickNextUnseen(
  sessionDir: string,
  pageHashInput: string,
  candidateKeysInput: string[],
): Promise<string | null> {
  const pageHash = pageHashSchema.parse(pageHashInput);
  const candidateKeys = candidateKeysSchema.parse(candidateKeysInput);
  const seen = new Set(await listSeenElements(sessionDir, pageHash));
  for (const key of candidateKeys) {
    if (!seen.has(key)) return key;
  }
  return null;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}
