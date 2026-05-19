#!/usr/bin/env node
// report-mcp: sessions and markdown report generation.
// See PLAN.md §4.2 for the tool surface.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { copyFile, mkdir, writeFile } from "node:fs/promises";

import {
  appendCrash,
  appendStep,
  createSession,
  listSessions,
  loadMeta,
  readCrashes,
  readSteps,
  resolveSessionDir,
  resolveWorkspaceRoot,
  writeMeta,
  type CrashRecord,
  type SessionStatus,
  type StepRecord,
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
  "Append a step record. If screenshot_src is given, the file will be copied into the session steps/ dir.",
  {
    session_id: z.string().optional(),
    session_dir: z.string().optional(),
    workspace_root: z.string().optional(),
    action: z.string(),
    result: z.enum(["ok", "fail", "skip"]).optional(),
    screenshot_src: z
      .string()
      .optional()
      .describe("absolute path of an existing screenshot to import"),
    log_excerpt: z
      .string()
      .optional()
      .describe("inline log text; will be saved into steps/<idx>.log"),
    log_excerpt_src: z
      .string()
      .optional()
      .describe("absolute path of an existing log snippet to import"),
    notes: z.string().optional(),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      const existing = await readSteps(sessionDir);
      const index = existing.length + 1;
      const stepNum = String(index).padStart(3, "0");
      const stepsDir = path.join(sessionDir, "steps");
      await mkdir(stepsDir, { recursive: true });

      let screenshotRel: string | undefined;
      if (input.screenshot_src) {
        const ext = path.extname(input.screenshot_src) || ".png";
        const dest = path.join(stepsDir, `${stepNum}${ext}`);
        await copyFile(input.screenshot_src, dest);
        screenshotRel = path.relative(sessionDir, dest);
      }

      let logRel: string | undefined;
      if (input.log_excerpt_src) {
        const dest = path.join(stepsDir, `${stepNum}.log`);
        await copyFile(input.log_excerpt_src, dest);
        logRel = path.relative(sessionDir, dest);
      } else if (input.log_excerpt) {
        const dest = path.join(stepsDir, `${stepNum}.log`);
        await writeFile(dest, input.log_excerpt, "utf8");
        logRel = path.relative(sessionDir, dest);
      }

      const step: StepRecord = {
        index,
        ts: new Date().toISOString(),
        action: input.action,
        ...(input.result !== undefined ? { result: input.result } : {}),
        ...(screenshotRel ? { screenshot: screenshotRel } : {}),
        ...(logRel ? { log_excerpt: logRel } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      };
      await appendStep(sessionDir, step);
      return asText({ ok: true, step });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- record_crash ----------
server.tool(
  "record_crash",
  "Append a crash record. stack is required as inline text; log_full_src (optional) imports a full log file.",
  {
    session_id: z.string().optional(),
    session_dir: z.string().optional(),
    workspace_root: z.string().optional(),
    signature: z.string(),
    stack: z.string().describe("the captured stack/block text"),
    kind: z.string().optional(),
    step_index: z.number().int().nonnegative().optional(),
    repro_path: z
      .array(z.number().int().nonnegative())
      .default([])
      .describe("ordered step indices required to reproduce"),
    log_full_src: z
      .string()
      .optional()
      .describe("absolute path of a full log file to archive"),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      const existing = await readCrashes(sessionDir);
      const id = `c${existing.length + 1}`;
      const crashDir = path.join(sessionDir, "crashes");
      await mkdir(crashDir, { recursive: true });

      const stackPath = path.join(crashDir, `${id}.stack.txt`);
      await writeFile(stackPath, input.stack, "utf8");

      let logPath: string | undefined;
      if (input.log_full_src) {
        const dest = path.join(crashDir, `${id}.log`);
        await copyFile(input.log_full_src, dest);
        logPath = path.relative(sessionDir, dest);
      }

      const crash: CrashRecord = {
        id,
        ts: new Date().toISOString(),
        signature: input.signature,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.step_index !== undefined ? { step_index: input.step_index } : {}),
        stack_path: path.relative(sessionDir, stackPath),
        ...(logPath ? { log_path: logPath } : {}),
        repro_path: input.repro_path,
      };
      await appendCrash(sessionDir, crash);
      return asText({ ok: true, crash });
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
      const meta = await loadMeta(sessionDir);
      meta.status = input.status as SessionStatus;
      meta.ended_at = new Date().toISOString();
      await writeMeta(sessionDir, meta);

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
        session_id: meta.id,
        status: meta.status,
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
