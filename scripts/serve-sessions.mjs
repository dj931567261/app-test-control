#!/usr/bin/env node
// app_test_ctrl 本地 session 浏览面板。
// 用法：
//   node scripts/serve-sessions.mjs [--port 7321] [--workspace DIR] [--open]
//   npm run sessions -- --open

import http from "node:http";
import path from "node:path";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  listSessions,
  loadMeta,
  readSteps,
  readCrashes,
  resolveWorkspaceRoot,
} from "../mcp-servers/report-mcp/dist/sessions.js";
import { renderHtml } from "../mcp-servers/report-mcp/dist/html-report.js";

// ── CLI args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith("--") ? v : true;
}
const PORT = Number(flag("--port") ?? process.env.PORT ?? 7321);
const wsArg = flag("--workspace");
const WORKSPACE = resolveWorkspaceRoot(typeof wsArg === "string" ? wsArg : undefined);
const OPEN = Boolean(flag("--open"));

// ── helpers ──────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}
function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

async function enrichSession(s) {
  const dir = s.dir;
  let step_count = 0;
  let crash_count = 0;
  let ended_at;
  let has_report_html = false;
  try {
    const meta = await loadMeta(dir);
    ended_at = meta.ended_at;
  } catch {}
  try { step_count = (await readSteps(dir)).length; } catch {}
  try { crash_count = (await readCrashes(dir)).length; } catch {}
  try { await stat(path.join(dir, "report.html")); has_report_html = true; } catch {}
  const duration_ms = ended_at
    ? new Date(ended_at).getTime() - new Date(s.started_at).getTime()
    : null;
  return {
    id: s.id,
    name: s.id.replace(/^\d{4}-\d{2}-\d{2}_\d{6}_/, ""),
    status: s.status,
    started_at: s.started_at,
    ended_at,
    duration_ms,
    step_count,
    crash_count,
    has_report_html,
  };
}

function safeJoin(baseDir, rel) {
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { return null; }
  const target = path.resolve(baseDir, decoded);
  if (target !== baseDir && !target.startsWith(baseDir + path.sep)) return null;
  return target;
}

async function buildReportHtml(sessionDir) {
  try {
    return await readFile(path.join(sessionDir, "report.html"), "utf8");
  } catch {}
  const meta = await loadMeta(sessionDir);
  const steps = await readSteps(sessionDir);
  const crashes = await readCrashes(sessionDir);
  return renderHtml({ meta, steps, crashes });
}

// ── routes ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const p = u.pathname;

    if (p === "/" || p === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderIndex());
      return;
    }

    if (p === "/api/sessions") {
      const list = await listSessions(WORKSPACE);
      const enriched = await Promise.all(list.map(enrichSession));
      sendJson(res, 200, { workspace: WORKSPACE, sessions: enriched });
      return;
    }

    const apiM = p.match(/^\/api\/sessions\/([^/]+)$/);
    if (apiM) {
      const id = decodeURIComponent(apiM[1]);
      const dir = path.join(WORKSPACE, id);
      try {
        const meta = await loadMeta(dir);
        const steps = await readSteps(dir);
        const crashes = await readCrashes(dir);
        sendJson(res, 200, { meta, steps, crashes });
      } catch {
        send(res, 404, `session not found: ${id}`);
      }
      return;
    }

    const reportM = p.match(/^\/s\/([^/]+)\/report\.html$/);
    if (reportM) {
      const id = decodeURIComponent(reportM[1]);
      const dir = path.join(WORKSPACE, id);
      try {
        const html = await buildReportHtml(dir);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      } catch (e) {
        send(res, 404, `cannot render report for ${id}: ${e?.message ?? e}`);
      }
      return;
    }

    const fileM = p.match(/^\/s\/([^/]+)\/(.+)$/);
    if (fileM) {
      const id = decodeURIComponent(fileM[1]);
      const rel = fileM[2];
      const dir = path.join(WORKSPACE, id);
      const target = safeJoin(dir, rel);
      if (!target) { send(res, 400, "bad path"); return; }
      try {
        const s = await stat(target);
        if (!s.isFile()) { send(res, 404, "not a file"); return; }
        const ext = path.extname(target).toLowerCase();
        res.writeHead(200, {
          "content-type": MIME[ext] ?? "application/octet-stream",
          "content-length": s.size,
        });
        createReadStream(target).pipe(res);
      } catch {
        send(res, 404, "file not found");
      }
      return;
    }

    send(res, 404, "not found");
  } catch (err) {
    console.error("[serve-sessions]", err);
    send(res, 500, `internal error: ${err?.message ?? err}`);
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\x1b[31mport ${PORT} already in use.\x1b[0m try: npm run sessions -- --port=<n>`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`\x1b[32m▸\x1b[0m sessions viewer @ \x1b[1m${url}\x1b[0m`);
  console.log(`\x1b[90m  workspace:\x1b[0m ${WORKSPACE}`);
  console.log(`\x1b[90m  stop:\x1b[0m Ctrl+C`);
  if (OPEN) tryOpen(url);
});

function tryOpen(url) {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const cmdArgs = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const p = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true });
    p.unref();
  } catch {}
}

// ── inline SPA ───────────────────────────────────────────────────────────
function renderIndex() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>app_test_ctrl · sessions</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #f9fafb; color: #111827; display: flex; flex-direction: column; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f172a; color: #e5e7eb; }
    header, aside, .card, .pane { background: #1f2937 !important; border-color: #374151 !important; }
    input, select { background: #0f172a !important; color: #e5e7eb !important; border-color: #374151 !important; }
    .card.active { background: #1e3a8a !important; border-color: #3b82f6 !important; }
    header button:hover { background: #374151 !important; }
  }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: white; border-bottom: 1px solid #e5e7eb; flex-shrink: 0; }
  header h1 { margin: 0; font-size: 14px; font-weight: 600; }
  header .ws { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #6b7280; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header button { font: inherit; padding: 4px 10px; border: 1px solid #e5e7eb; border-radius: 6px; background: transparent; cursor: pointer; color: inherit; }
  header button:hover { background: #f3f4f6; }
  main { flex: 1; display: flex; min-height: 0; }
  aside { width: 340px; background: white; border-right: 1px solid #e5e7eb; display: flex; flex-direction: column; min-height: 0; flex-shrink: 0; }
  .filters { padding: 10px; border-bottom: 1px solid #e5e7eb; display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; }
  .filters input, .filters select { width: 100%; padding: 6px 8px; border: 1px solid #e5e7eb; border-radius: 6px; font: inherit; color: inherit; background: white; }
  .count { font-size: 11px; color: #6b7280; padding: 6px 12px; border-bottom: 1px solid #e5e7eb; flex-shrink: 0; }
  .list { flex: 1; overflow-y: auto; padding: 8px; }
  .card { display: block; padding: 10px 12px; margin-bottom: 6px; background: white; border: 1px solid #e5e7eb; border-radius: 8px; cursor: pointer; transition: border-color .12s; }
  .card:hover { border-color: #93c5fd; }
  .card.active { border-color: #2563eb; background: #eff6ff; }
  .card .name { font-weight: 600; word-break: break-all; font-size: 13px; }
  .card .meta { font-size: 11px; color: #6b7280; margin-top: 4px; font-family: ui-monospace, Menlo, monospace; word-break: break-all; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 10px; font-weight: 600; letter-spacing: .02em; vertical-align: middle; margin-right: 6px; }
  .badge-running { background: #fef3c7; color: #92400e; }
  .badge-passed { background: #d1fae5; color: #065f46; }
  .badge-failed { background: #fee2e2; color: #991b1b; }
  .badge-aborted { background: #e5e7eb; color: #374151; }
  .pane { flex: 1; min-width: 0; display: flex; flex-direction: column; background: white; }
  .pane iframe { flex: 1; border: 0; width: 100%; background: white; }
  .empty { display: flex; align-items: center; justify-content: center; flex: 1; color: #9ca3af; font-style: italic; }
</style>
</head>
<body>
<header>
  <h1>📊 app_test_ctrl · sessions</h1>
  <span class="ws" id="ws"></span>
  <button id="refresh" title="重抓 session 列表">🔄 Refresh</button>
</header>
<main>
  <aside>
    <div class="filters">
      <input id="q" type="search" placeholder="🔍 搜索 name / id…" autocomplete="off">
      <select id="status">
        <option value="">All status</option>
        <option value="passed">✅ Passed</option>
        <option value="failed">❌ Failed</option>
        <option value="running">🟡 Running</option>
        <option value="aborted">⚪ Aborted</option>
      </select>
    </div>
    <div class="count" id="count">loading…</div>
    <div class="list" id="list"></div>
  </aside>
  <section class="pane">
    <div class="empty" id="empty">← 在左侧选择一个 session</div>
    <iframe id="frame" style="display:none"></iframe>
  </section>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  let SESSIONS = [];
  let CURRENT = null;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]));
  }
  function dur(ms) {
    if (ms == null) return "in progress";
    const s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m " + (s % 60) + "s";
    const h = Math.floor(m / 60);
    return h + "h " + (m % 60) + "m";
  }

  async function load() {
    $("count").textContent = "loading…";
    try {
      const r = await fetch("/api/sessions");
      const data = await r.json();
      $("ws").textContent = data.workspace;
      SESSIONS = data.sessions;
      render();
    } catch (e) {
      $("count").textContent = "load failed: " + e.message;
    }
  }

  function render() {
    const q = $("q").value.trim().toLowerCase();
    const st = $("status").value;
    const filtered = SESSIONS.filter(s => {
      if (st && s.status !== st) return false;
      if (q && !(s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))) return false;
      return true;
    });
    $("count").textContent = filtered.length + " / " + SESSIONS.length + " sessions";
    $("list").innerHTML = filtered.map(s => {
      const active = CURRENT === s.id ? " active" : "";
      return '<div class="card' + active + '" data-id="' + esc(s.id) + '">' +
        '<div><span class="badge badge-' + s.status + '">' + s.status.toUpperCase() + '</span><span class="name">' + esc(s.name) + '</span></div>' +
        '<div class="meta">' + esc(s.id) + '</div>' +
        '<div class="meta">' + s.step_count + ' steps · ' + s.crash_count + ' crash · ' + esc(dur(s.duration_ms)) + (s.has_report_html ? '' : ' · <em>no report.html</em>') + '</div>' +
      '</div>';
    }).join("");
    for (const el of document.querySelectorAll(".card")) {
      el.addEventListener("click", () => select(el.dataset.id));
    }
  }

  function select(id) {
    CURRENT = id;
    const frame = $("frame");
    frame.style.display = "";
    $("empty").style.display = "none";
    frame.src = "/s/" + encodeURIComponent(id) + "/report.html";
    for (const el of document.querySelectorAll(".card")) {
      el.classList.toggle("active", el.dataset.id === id);
    }
  }

  $("q").addEventListener("input", render);
  $("status").addEventListener("change", render);
  $("refresh").addEventListener("click", load);
  load();
</script>
</body>
</html>`;
}
