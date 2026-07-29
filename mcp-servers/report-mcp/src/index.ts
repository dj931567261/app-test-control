#!/usr/bin/env node
// report-mcp: sessions and markdown report generation.
// See PLAN.md §4.2 for the tool surface.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { lstat, unlink, writeFile } from "node:fs/promises";

import {
  appendStep,
  copyRegularFilePrivate,
  crashSourceSchema,
  createSession,
  finalizeSession,
  listSessions,
  loadMeta,
  readCrashes,
  readSteps,
  recordCrashEvidence,
  resolveSessionDir,
  resolveWorkspaceRoot,
  withSessionLock,
  type StepRecord,
  MAX_CRASH_KIND_CHARS,
  MAX_CRASH_SIGNATURE_CHARS,
  MAX_CRASH_STACK_BYTES,
  MAX_REPRO_PATH_ENTRIES,
  MAX_SESSION_ID_CHARS,
  MAX_SESSION_PATH_CHARS,
} from "./sessions.js";
import { renderMarkdown, writeReport } from "./report.js";
import { renderHtml, writeHtmlReport } from "./html-report.js";
import {
  graphSummary,
  listSeenElements,
  markElementSeen,
  pickNextUnseen,
  recordEdge,
  recordPage,
} from "./graph.js";

const server = new McpServer({
  name: "report-mcp",
  version: "0.1.0",
});

const MAX_STEP_ACTION_CHARS = 16 * 1024;
const MAX_STEP_NOTES_CHARS = 64 * 1024;
const MAX_STEP_SCREENSHOT_BYTES = 32 * 1024 * 1024;
const MAX_STEP_LOG_BYTES = 16 * 1024 * 1024;
const SCREENSHOT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function asText(payload: unknown) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function asError(err: unknown) {
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: err instanceof Error ? err.message : String(err),
      },
    ],
  };
}

// ---------- start_session ----------
server.tool(
  "start_session",
  "Create a new test session directory and return its id/path. Subsequent calls reference it via session_id.",
  {
    name: z.string().describe("human-readable session name, e.g. 'devtest-login'"),
    workspace_root: z
      .string()
      .optional()
      .describe(
        "absolute path; defaults to APP_TEST_CTRL_WORKSPACE or <cwd>/workspace/sessions",
      ),
    extra: z.record(z.any()).optional(),
  },
  async ({ name, workspace_root, extra }) => {
    try {
      const created = await createSession({
        name,
        workspaceRoot: workspace_root,
        extra,
      });
      return asText({
        session_id: created.id,
        session_dir: created.dir,
        meta_path: created.meta_path,
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- record_step ----------
server.tool(
  "record_step",
  "Append one bounded step while the session is running. Step indexing and finalize are serialized by the session lock; imported screenshots/logs must be regular bounded files.",
  {
    session_id: z.string().optional(),
    session_dir: z.string().optional(),
    workspace_root: z.string().optional(),
    action: z.string().min(1).max(MAX_STEP_ACTION_CHARS),
    result: z.enum(["ok", "fail", "skip"]).optional(),
    screenshot_src: z
      .string()
      .min(1)
      .max(MAX_SESSION_PATH_CHARS)
      .optional()
      .describe("absolute path of an existing screenshot to import"),
    log_excerpt: z
      .string()
      .max(MAX_STEP_LOG_BYTES)
      .optional()
      .describe("inline log text; will be saved into steps/<idx>.log"),
    log_excerpt_src: z
      .string()
      .min(1)
      .max(MAX_SESSION_PATH_CHARS)
      .optional()
      .describe("absolute path of an existing log snippet to import"),
    notes: z.string().max(MAX_STEP_NOTES_CHARS).optional(),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      if (
        input.log_excerpt !== undefined
        && Buffer.byteLength(input.log_excerpt, "utf8") > MAX_STEP_LOG_BYTES
      ) {
        throw new RangeError(`log_excerpt exceeds ${MAX_STEP_LOG_BYTES} byte size limit`);
      }
      const step = await withSessionLock(sessionDir, async () => {
        const meta = await loadMeta(sessionDir);
        if (meta.status !== "running") {
          throw new Error(
            `cannot record step: session is not running (status=${meta.status})`,
          );
        }
        const stepsDir = path.join(sessionDir, "steps");
        const stepsMetadata = await lstat(stepsDir);
        if (!stepsMetadata.isDirectory() || stepsMetadata.isSymbolicLink()) {
          throw new Error("session steps directory must be a real directory");
        }
        const existing = await readSteps(sessionDir);
        const index = existing.length + 1;
        const stepNum = String(index).padStart(3, "0");
        const created: string[] = [];
        try {
          let screenshotRel: string | undefined;
          if (input.screenshot_src) {
            const ext = path.extname(input.screenshot_src).toLowerCase();
            if (!SCREENSHOT_EXTENSIONS.has(ext)) {
              throw new TypeError("screenshot_src must use png, jpg, jpeg, or webp");
            }
            const dest = path.join(stepsDir, `${stepNum}${ext}`);
            await copyRegularFilePrivate(
              input.screenshot_src,
              dest,
              MAX_STEP_SCREENSHOT_BYTES,
            );
            created.push(dest);
            screenshotRel = path.relative(sessionDir, dest);
          }

          let logRel: string | undefined;
          if (input.log_excerpt_src) {
            const dest = path.join(stepsDir, `${stepNum}.log`);
            await copyRegularFilePrivate(input.log_excerpt_src, dest, MAX_STEP_LOG_BYTES);
            created.push(dest);
            logRel = path.relative(sessionDir, dest);
          } else if (input.log_excerpt) {
            const dest = path.join(stepsDir, `${stepNum}.log`);
            await writeFile(dest, input.log_excerpt, {
              encoding: "utf8",
              flag: "wx",
              mode: 0o600,
            });
            created.push(dest);
            logRel = path.relative(sessionDir, dest);
          }

          const record: StepRecord = {
            index,
            ts: new Date().toISOString(),
            action: input.action,
            ...(input.result !== undefined ? { result: input.result } : {}),
            ...(screenshotRel ? { screenshot: screenshotRel } : {}),
            ...(logRel ? { log_excerpt: logRel } : {}),
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
          };
          await appendStep(sessionDir, record);
          return record;
        } catch (error) {
          await Promise.all(created.map((file) => unlink(file).catch(() => undefined)));
          throw error;
        }
      });
      return asText({ ok: true, step });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- record_crash ----------
server.tool(
  "record_crash",
  "Append a crash record while the session is running. Remote sources are idempotent by external_key. firebase-crashlytics requires project/app/issue/event and a server-verified SHA-256 external_key bound to signature. stack is required as inline text; log_full_src (optional) imports a bounded full log file.",
  {
    session_id: z.string().min(1).max(MAX_SESSION_ID_CHARS).optional(),
    session_dir: z.string().min(1).max(MAX_SESSION_PATH_CHARS).optional(),
    workspace_root: z.string().min(1).max(MAX_SESSION_PATH_CHARS).optional(),
    signature: z.string().min(1).max(MAX_CRASH_SIGNATURE_CHARS),
    stack: z
      .string()
      .min(1)
      .max(MAX_CRASH_STACK_BYTES)
      .describe("the captured stack/block text"),
    kind: z.string().min(1).max(MAX_CRASH_KIND_CHARS).optional(),
    step_index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    repro_path: z
      .array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))
      .max(MAX_REPRO_PATH_ENTRIES)
      .default([])
      .describe("ordered step indices required to reproduce"),
    log_full_src: z
      .string()
      .min(1)
      .max(MAX_SESSION_PATH_CHARS)
      .optional()
      .describe("absolute path of a full log file to archive"),
    source: crashSourceSchema
      .optional()
      .describe(
        "strict normalized remote origin; firebase-crashlytics external_key must equal SHA-256(provider\\0project\\0app\\0issue\\0event\\0signature)",
      ),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      const result = await recordCrashEvidence(sessionDir, {
        signature: input.signature,
        stack: input.stack,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.step_index !== undefined ? { step_index: input.step_index } : {}),
        repro_path: input.repro_path,
        ...(input.log_full_src !== undefined
          ? { log_full_src: input.log_full_src }
          : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
      });
      return asText({
        ok: true,
        deduplicated: result.deduplicated,
        crash: result.crash,
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- finalize ----------
server.tool(
  "finalize",
  "Set session status + end time, render report.md and report.html. Returns both paths.",
  {
    session_id: z.string().optional(),
    session_dir: z.string().optional(),
    workspace_root: z.string().optional(),
    status: z.enum(["passed", "failed", "aborted"]),
    summary: z.string().optional().describe("optional summary block at the top of the report"),
    html: z.boolean().optional().default(true).describe("also emit report.html (default true)"),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      const finalized = await finalizeSession(
        sessionDir,
        input.status,
        async ({ meta, steps, crashes }) => {
          const renderInput = {
            meta,
            steps,
            crashes,
            ...(input.summary !== undefined ? { summary: input.summary } : {}),
          };
          const md = renderMarkdown(renderInput);
          const reportPath = await writeReport(sessionDir, md);
          let htmlPath: string | undefined;
          if (input.html !== false) {
            htmlPath = await writeHtmlReport(sessionDir, renderHtml(renderInput));
          }
          return { reportPath, htmlPath };
        },
      );
      const { meta, steps, crashes, already_finalized } = finalized.context;
      const { reportPath, htmlPath } = finalized.value;
      return asText({
        ok: true,
        session_id: meta.id,
        status: meta.status,
        already_finalized,
        report_path: reportPath,
        ...(htmlPath ? { html_path: htmlPath } : {}),
        steps: steps.length,
        crashes: crashes.length,
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- get_session_path ----------
server.tool(
  "get_session_path",
  "Resolve the absolute directory of a session.",
  {
    session_id: z.string(),
    workspace_root: z.string().optional(),
  },
  async ({ session_id, workspace_root }) => {
    const dir = resolveSessionDir({ sessionId: session_id, workspaceRoot: workspace_root });
    return asText({ session_dir: dir });
  },
);

// ---------- list_sessions ----------
server.tool(
  "list_sessions",
  "List sessions in the workspace, newest first.",
  {
    workspace_root: z.string().optional(),
    limit: z.number().int().positive().optional(),
  },
  async ({ workspace_root, limit }) => {
    try {
      const all = await listSessions(workspace_root);
      const trimmed = limit ? all.slice(0, limit) : all;
      return asText({ count: trimmed.length, root: resolveWorkspaceRoot(workspace_root), sessions: trimmed });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- regenerate_report (utility) ----------
server.tool(
  "regenerate_report",
  "Re-render report.md (and report.html unless html=false) from current jsonl + meta (no status change).",
  {
    session_id: z.string().optional(),
    session_dir: z.string().optional(),
    workspace_root: z.string().optional(),
    summary: z.string().optional(),
    html: z.boolean().optional().default(true),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      const meta = await loadMeta(sessionDir);
      const steps = await readSteps(sessionDir);
      const crashes = await readCrashes(sessionDir);
      const renderInput = {
        meta,
        steps,
        crashes,
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
      };
      const md = renderMarkdown(renderInput);
      const reportPath = await writeReport(sessionDir, md);
      let htmlPath: string | undefined;
      if (input.html !== false) {
        htmlPath = await writeHtmlReport(sessionDir, renderHtml(renderInput));
      }
      return asText({
        ok: true,
        report_path: reportPath,
        ...(htmlPath ? { html_path: htmlPath } : {}),
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// =========================
//   QA state graph tools
// =========================

// ---------- graph_record_page ----------
server.tool(
  "graph_record_page",
  "QA: record visiting a page (by fingerprint hash). Creates the page if new, otherwise bumps visit_count/last_seen.",
  {
    session_id: z.string().optional(),
    session_dir: z.string().optional(),
    workspace_root: z.string().optional(),
    page_hash: z.string(),
    summary: z.string().optional().describe("short human description of the page"),
    screenshot: z.string().optional().describe("relative path of screenshot inside session"),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      const opts: { summary?: string; screenshot?: string } = {};
      if (input.summary !== undefined) opts.summary = input.summary;
      if (input.screenshot !== undefined) opts.screenshot = input.screenshot;
      const page = await recordPage(sessionDir, input.page_hash, opts);
      return asText({ ok: true, page });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- graph_record_edge ----------
server.tool(
  "graph_record_edge",
  "QA: record a transition (from page_hash, action) → to page_hash.",
  {
    session_id: z.string().optional(),
    session_dir: z.string().optional(),
    workspace_root: z.string().optional(),
    from_hash: z.string(),
    action: z.string().describe("human description of the action that caused the transition"),
    to_hash: z.string(),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      const edge = await recordEdge(sessionDir, input.from_hash, input.action, input.to_hash);
      return asText({ ok: true, edge });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- graph_mark_element_seen ----------
server.tool(
  "graph_mark_element_seen",
  "QA: mark an element on a page as already interacted with (so the explorer skips it next time).",
  {
    session_id: z.string().optional(),
    session_dir: z.string().optional(),
    workspace_root: z.string().optional(),
    page_hash: z.string(),
    element_key: z
      .string()
      .describe(
        "stable element identifier — prefer resource_id; fall back to 'text:<text>' or 'bounds:x1,y1,x2,y2'",
      ),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      const r = await markElementSeen(sessionDir, input.page_hash, input.element_key);
      return asText({ ok: true, ...r });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- graph_pick_next_unseen ----------
server.tool(
  "graph_pick_next_unseen",
  "QA: given current candidate element_keys (in priority order), return the first one not yet seen on this page. Returns null when everything has been tried.",
  {
    session_id: z.string().optional(),
    session_dir: z.string().optional(),
    workspace_root: z.string().optional(),
    page_hash: z.string(),
    candidate_keys: z.array(z.string()),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      const picked = await pickNextUnseen(sessionDir, input.page_hash, input.candidate_keys);
      const seen = await listSeenElements(sessionDir, input.page_hash);
      return asText({
        picked,
        seen_count: seen.length,
        candidates_count: input.candidate_keys.length,
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- graph_summary ----------
server.tool(
  "graph_summary",
  "QA: stats over the current state graph (pages, edges, isolated pages, most-visited, least-explored).",
  {
    session_id: z.string().optional(),
    session_dir: z.string().optional(),
    workspace_root: z.string().optional(),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      const s = await graphSummary(sessionDir);
      return asText(s);
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- boot ----------
const transport = new StdioServerTransport();
await server.connect(transport);
