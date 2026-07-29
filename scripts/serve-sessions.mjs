#!/usr/bin/env node
// app_test_ctrl 本地 session 浏览面板。
// 用法：
//   node scripts/serve-sessions.mjs [--port 7321] [--workspace DIR] [--open]
//   npm run sessions -- --open

import http from "node:http";
import path from "node:path";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  loadMeta,
  readSteps,
  readCrashes,
  resolveWorkspaceRoot,
} from "../mcp-servers/report-mcp/dist/sessions.js";
import { renderHtml } from "../mcp-servers/report-mcp/dist/html-report.js";
import { renderMarkdown } from "../mcp-servers/report-mcp/dist/report.js";

// ── CLI args ─────────────────────────────────────────────────────────────
export const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 7321;

export function parseCliOptions(argv, env = process.env) {
  let portValue = env.PORT ?? DEFAULT_PORT;
  let workspaceValue;
  let shouldOpen = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--open") {
      shouldOpen = true;
      continue;
    }
    if (arg === "--host" || arg.startsWith("--host=")) {
      throw new Error(
        "--host is not supported: the sessions viewer is intentionally loopback-only (127.0.0.1)",
      );
    }

    const [name, inlineValue] = arg.split(/=(.*)/s, 2);
    if (name !== "--port" && name !== "--workspace") {
      throw new Error(`unknown option: ${arg}`);
    }
    const value = inlineValue ?? argv[++i];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    if (name === "--port") portValue = value;
    else workspaceValue = value;
  }

  const port = Number(portValue);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return {
    host: LOOPBACK_HOST,
    port,
    workspace: resolveWorkspaceRoot(workspaceValue),
    open: shouldOpen,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────
const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".ips": "text/plain; charset=utf-8",
  ".crash": "text/plain; charset=utf-8",
};
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const LOG_EXTENSIONS = new Set([".txt", ".log", ".ips", ".crash"]);
const SESSION_STATUSES = new Set(["running", "passed", "failed", "aborted"]);
const STEP_RESULTS = new Set(["ok", "fail", "skip"]);
const SESSION_ID_RE = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/;
const SAFE_ASSET_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_PUBLIC_ASSET_BYTES = 64 * 1024 * 1024;
const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}, headOnly = false) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "text/plain; charset=utf-8",
    ...headers,
  });
  res.end(headOnly ? undefined : body);
}
function sendJson(res, status, obj, headOnly = false) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(headOnly ? undefined : body);
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "invalid encoded path");
  }
}

function validateSessionId(id) {
  if (!SESSION_ID_RE.test(id) || path.basename(id) !== id) {
    throw new HttpError(400, "invalid session id");
  }
  return id;
}

async function resolveSessionDirectory(workspace, rawId) {
  const id = validateSessionId(rawId);
  let workspaceReal;
  try {
    workspaceReal = await realpath(workspace);
  } catch {
    throw new HttpError(404, "session not found");
  }

  const candidate = path.join(workspaceReal, id);
  try {
    const entry = await lstat(candidate);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new HttpError(404, "session not found");
    }
    const resolved = await realpath(candidate);
    if (path.dirname(resolved) !== workspaceReal) {
      throw new HttpError(404, "session not found");
    }
    return resolved;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, "session not found");
  }
}

function normalizeStoredAssetRef(value, type) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) return null;
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.includes("\0")
    || normalized.includes("%")
    || normalized.includes("?")
    || normalized.includes("#")
    || path.posix.isAbsolute(normalized)
    || path.win32.isAbsolute(value)
  ) return null;
  const segments = normalized.split("/");
  if (segments.some((segment) => !SAFE_ASSET_SEGMENT_RE.test(segment) || segment.startsWith("."))) {
    return null;
  }

  const extension = path.posix.extname(normalized).toLowerCase();
  if (type === "screenshot") {
    if (!IMAGE_EXTENSIONS.has(extension)) return null;
    if (segments.length > 1 && segments[0] !== "steps") return null;
  } else if (type === "step-log") {
    if (!LOG_EXTENSIONS.has(extension) || !["steps", "logs"].includes(segments[0])) return null;
  } else if (type === "crash-log") {
    if (!LOG_EXTENSIONS.has(extension) || segments[0] !== "crashes") return null;
  } else {
    return null;
  }
  return segments.join("/");
}

function normalizeRequestedAssetRef(rawValue) {
  const decoded = decodeSegment(rawValue);
  if (decoded.includes("\\")) throw new HttpError(400, "invalid asset path");
  const normalized = normalizeStoredAssetRef(decoded, "screenshot")
    ?? normalizeStoredAssetRef(decoded, "step-log")
    ?? normalizeStoredAssetRef(decoded, "crash-log");
  if (!normalized) throw new HttpError(404, "asset not found");
  return normalized;
}

function collectDeviceIdentifiers(extra) {
  const identifiers = new Set();
  let visited = 0;
  const deviceKey = /(?:^|[_-])(?:device(?:[_-]?id)?|udid|serial|android[_-]?id|idfv|advertising[_-]?id|installation[_-]?id)(?:$|[_-])/i;
  const visit = (value, key = "", depth = 0) => {
    visited += 1;
    if (visited > 1_000 || depth > 8 || value === null || value === undefined) return;
    if (deviceKey.test(key) && (typeof value === "string" || typeof value === "number")) {
      const token = String(value);
      if (token.length >= 3) identifiers.add(token);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 100)) visit(item, key, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const [childKey, child] of Object.entries(value).slice(0, 100)) {
        visit(child, childKey, depth + 1);
      }
    }
  };
  visit(extra);
  return [...identifiers].sort((a, b) => b.length - a.length);
}

function redactKnownIdentifiers(value, deviceIdentifiers) {
  let redacted = typeof value === "string" ? value : "";
  for (const identifier of deviceIdentifiers) {
    redacted = redacted.split(identifier).join("[REDACTED_DEVICE]");
  }
  return redacted;
}

function redactPublicText(value, deviceIdentifiers) {
  return redactKnownIdentifiers(value, deviceIdentifiers)
    .replace(/\b[0-9a-f]{40}\b/gi, "[REDACTED_DEVICE]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{16}\b/gi, "[REDACTED_DEVICE]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[REDACTED_DEVICE]")
    .replace(/\bemulator-\d{4,}\b/gi, "[REDACTED_DEVICE]");
}

function publicSource(source) {
  const metrics = Object.fromEntries(
    Object.entries(source.metrics ?? {}).filter(
      ([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0,
    ),
  );
  return {
    provider: source.provider,
    external_key_ref: `sha256:${createHash("sha256")
      .update(source.external_key, "utf8")
      .digest("hex")
      .slice(0, 10)}`,
    ...(source.occurred ? { occurred: source.occurred } : {}),
    ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
  };
}

function buildPublicRecords(meta, steps, crashes) {
  const deviceIdentifiers = collectDeviceIdentifiers(meta.extra);
  const assets = new Map();
  const publicSteps = steps.map((step, position) => {
    const rawScreenshot = normalizeStoredAssetRef(step.screenshot, "screenshot");
    const rawLogExcerpt = normalizeStoredAssetRef(step.log_excerpt, "step-log");
    const screenshot = rawScreenshot
      && redactPublicText(rawScreenshot, deviceIdentifiers) === rawScreenshot
      ? rawScreenshot
      : null;
    const logExcerpt = rawLogExcerpt
      && redactPublicText(rawLogExcerpt, deviceIdentifiers) === rawLogExcerpt
      ? rawLogExcerpt
      : null;
    if (screenshot) assets.set(screenshot, "screenshot");
    if (logExcerpt) assets.set(logExcerpt, "log");
    return {
      index: Number.isSafeInteger(step.index) && step.index >= 0 ? step.index : position + 1,
      ts: typeof step.ts === "string" ? step.ts : "",
      action: redactPublicText(step.action, deviceIdentifiers),
      ...(STEP_RESULTS.has(step.result) ? { result: step.result } : {}),
      ...(screenshot ? { screenshot } : {}),
      ...(logExcerpt ? { log_excerpt: logExcerpt } : {}),
      // notes intentionally stay private: they can contain replay inputs,
      // device identifiers, credentials, or personal data.
    };
  });
  const publicCrashes = crashes.map((crash, position) => {
    const rawStackPath = normalizeStoredAssetRef(crash.stack_path, "crash-log");
    const rawLogPath = normalizeStoredAssetRef(crash.log_path, "crash-log");
    const stackPath = rawStackPath
      && redactPublicText(rawStackPath, deviceIdentifiers) === rawStackPath
      ? rawStackPath
      : null;
    const logPath = rawLogPath
      && redactPublicText(rawLogPath, deviceIdentifiers) === rawLogPath
      ? rawLogPath
      : null;
    if (stackPath) assets.set(stackPath, "log");
    if (logPath) assets.set(logPath, "log");
    return {
      id: typeof crash.id === "string" ? crash.id : `c${position + 1}`,
      ts: typeof crash.ts === "string" ? crash.ts : "",
      ...(Number.isSafeInteger(crash.step_index) && crash.step_index >= 0
        ? { step_index: crash.step_index }
        : {}),
      signature: redactKnownIdentifiers(crash.signature, deviceIdentifiers) || "unavailable",
      ...(typeof crash.kind === "string" && crash.kind.length > 0
        ? { kind: crash.kind.slice(0, 128) }
        : {}),
      ...(stackPath ? { stack_path: stackPath } : {}),
      ...(logPath ? { log_path: logPath } : {}),
      repro_path: Array.isArray(crash.repro_path)
        ? crash.repro_path.filter((step) => Number.isSafeInteger(step) && step >= 0)
        : [],
      ...(crash.source ? { source: publicSource(crash.source) } : {}),
    };
  });
  const renderCrashes = crashes.map((crash, index) => {
    const publicCrash = publicCrashes[index];
    return {
      ...publicCrash,
      stack_path: publicCrash.stack_path ?? "evidence-unavailable",
      ...(crash.source
        ? {
            source: {
              provider: crash.source.provider,
              // The report renderer applies the required second SHA-256 and
              // never renders this opaque idempotency key itself.
              external_key: crash.source.external_key,
              ...(crash.source.occurred ? { occurred: crash.source.occurred } : {}),
            },
          }
        : {}),
    };
  });
  const publicMeta = {
    id: meta.id,
    name: meta.id.replace(/^\d{4}-\d{2}-\d{2}_\d{6}_/, ""),
    started_at: meta.started_at,
    ...(typeof meta.ended_at === "string" ? { ended_at: meta.ended_at } : {}),
    status: meta.status,
  };
  return {
    meta: publicMeta,
    steps: publicSteps,
    crashes: publicCrashes,
    renderCrashes,
    assets,
  };
}

async function loadPublicSession(workspace, rawId) {
  const dir = await resolveSessionDirectory(workspace, rawId);
  const [meta, steps, crashes] = await Promise.all([
    loadMeta(dir),
    readSteps(dir),
    readCrashes(dir),
  ]);
  if (meta.id !== rawId || !SESSION_ID_RE.test(meta.id)) {
    throw new HttpError(404, "session not found");
  }
  if (
    !SESSION_STATUSES.has(meta.status)
    || typeof meta.started_at !== "string"
    || !Number.isFinite(Date.parse(meta.started_at))
  ) {
    throw new HttpError(404, "session not found");
  }
  return { dir, ...buildPublicRecords(meta, steps, crashes) };
}

async function listPublicSessions(workspace) {
  let workspaceReal;
  try {
    workspaceReal = await realpath(workspace);
  } catch {
    return [];
  }
  const entries = await readdir(workspaceReal, { withFileTypes: true });
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SESSION_ID_RE.test(entry.name)) continue;
    try {
      const session = await loadPublicSession(workspaceReal, entry.name);
      const durationMs = session.meta.ended_at
        ? new Date(session.meta.ended_at).getTime() - new Date(session.meta.started_at).getTime()
        : null;
      sessions.push({
        id: session.meta.id,
        name: session.meta.name,
        status: session.meta.status,
        started_at: session.meta.started_at,
        ...(session.meta.ended_at ? { ended_at: session.meta.ended_at } : {}),
        duration_ms: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null,
        step_count: session.steps.length,
        crash_count: session.crashes.length,
        has_report_html: true,
      });
    } catch {
      // Corrupt, mismatched, or unsafe entries are not public sessions.
    }
  }
  sessions.sort((a, b) => b.started_at.localeCompare(a.started_at));
  return sessions;
}

function renderableRecords(session) {
  return {
    meta: session.meta,
    steps: session.steps,
    crashes: session.renderCrashes,
  };
}

async function assertNoSymlinks(sessionDir, relativePath) {
  try {
    let current = sessionDir;
    for (const segment of relativePath.split("/")) {
      current = path.join(current, segment);
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) throw new HttpError(404, "asset not found");
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, "asset not found");
  }
}

async function openPublicAsset(session, rawRelativePath) {
  const relativePath = normalizeRequestedAssetRef(rawRelativePath);
  if (!session.assets.has(relativePath)) throw new HttpError(404, "asset not found");
  await assertNoSymlinks(session.dir, relativePath);

  let handle;
  try {
    const target = path.join(session.dir, ...relativePath.split("/"));
    const canonical = await realpath(target);
    if (!canonical.startsWith(`${session.dir}${path.sep}`)) {
      throw new HttpError(404, "asset not found");
    }
    const noFollow = constants.O_NOFOLLOW ?? 0;
    handle = await open(canonical, constants.O_RDONLY | noFollow);
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > MAX_PUBLIC_ASSET_BYTES) {
      throw new HttpError(404, "asset not found");
    }
    return { handle, size: fileStat.size, extension: path.extname(canonical).toLowerCase() };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, "asset not found");
  }
}

function htmlHeaders(kind) {
  return {
    ...SECURITY_HEADERS,
    "content-type": "text/html; charset=utf-8",
    "x-frame-options": "SAMEORIGIN",
    "content-security-policy": kind === "index"
      ? "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'"
      : "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'",
  };
}

function isLoopbackAuthority(authority) {
  if (typeof authority !== "string" || authority.length === 0 || authority.length > 512) {
    return false;
  }
  try {
    const hostname = new URL(`http://${authority}`).hostname.toLowerCase();
    return hostname === LOOPBACK_HOST || hostname === "localhost";
  } catch {
    return false;
  }
}

function isAllowedBrowserOrigin(origin) {
  if (origin === undefined) return true;
  if (typeof origin !== "string" || origin.length > 2_048) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:"
      && (parsed.hostname.toLowerCase() === LOOPBACK_HOST
        || parsed.hostname.toLowerCase() === "localhost");
  } catch {
    return false;
  }
}

// ── routes ───────────────────────────────────────────────────────────────
export function createSessionViewerServer({ workspace }) {
  const workspaceRoot = resolveWorkspaceRoot(workspace);
  return http.createServer(async (req, res) => {
    const headOnly = req.method === "HEAD";
    try {
      // Loopback binding is the primary boundary. Host/Origin checks also
      // prevent a browser DNS-rebinding origin from reading local evidence.
      if (!isLoopbackAuthority(req.headers.host) || !isAllowedBrowserOrigin(req.headers.origin)) {
        send(res, 403, "loopback origin required", {}, headOnly);
        return;
      }
      if (req.method !== "GET" && !headOnly) {
        send(res, 405, "method not allowed", { allow: "GET, HEAD" });
        return;
      }
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      const p = u.pathname;

      if (p === "/" || p === "/index.html") {
        const body = renderIndex();
        res.writeHead(200, {
          ...htmlHeaders("index"),
          "content-length": Buffer.byteLength(body),
        });
        res.end(headOnly ? undefined : body);
        return;
      }

      if (p === "/api/sessions") {
        sendJson(res, 200, { sessions: await listPublicSessions(workspaceRoot) }, headOnly);
        return;
      }

      const apiM = p.match(/^\/api\/sessions\/([^/]+)$/);
      if (apiM) {
        const id = validateSessionId(decodeSegment(apiM[1]));
        const { meta, steps, crashes } = await loadPublicSession(workspaceRoot, id);
        sendJson(res, 200, { meta, steps, crashes }, headOnly);
        return;
      }

      const reportM = p.match(/^\/s\/([^/]+)\/report\.(html|md)$/);
      if (reportM) {
        const id = validateSessionId(decodeSegment(reportM[1]));
        const session = await loadPublicSession(workspaceRoot, id);
        const input = renderableRecords(session);
        const isHtml = reportM[2] === "html";
        const body = isHtml ? renderHtml(input) : renderMarkdown(input);
        res.writeHead(200, {
          ...(isHtml
            ? htmlHeaders("report")
            : {
                ...SECURITY_HEADERS,
                "content-type": "text/markdown; charset=utf-8",
                "content-security-policy": "default-src 'none'; sandbox",
              }),
          "content-length": Buffer.byteLength(body),
        });
        res.end(headOnly ? undefined : body);
        return;
      }

      const fileM = p.match(/^\/s\/([^/]+)\/(.+)$/);
      if (fileM) {
        const id = validateSessionId(decodeSegment(fileM[1]));
        const session = await loadPublicSession(workspaceRoot, id);
        const asset = await openPublicAsset(session, fileM[2]);
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          "content-security-policy": "default-src 'none'; sandbox",
          "content-type": MIME[asset.extension] ?? "text/plain; charset=utf-8",
          "content-length": asset.size,
        });
        if (headOnly) {
          await asset.handle.close();
          res.end();
        } else {
          const stream = asset.handle.createReadStream({ autoClose: true });
          stream.on("error", () => res.destroy());
          stream.pipe(res);
        }
        return;
      }

      send(res, 404, "not found", {}, headOnly);
    } catch (error) {
      if (error instanceof HttpError) {
        send(res, error.status, error.message, {}, headOnly);
        return;
      }
      console.error("[serve-sessions]", error);
      send(res, 500, "internal error", {}, headOnly);
    }
  });
}

function runCli(options) {
  const server = createSessionViewerServer({ workspace: options.workspace });
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `\x1b[31mport ${options.port} already in use.\x1b[0m try: npm run sessions -- --port=<n>`,
      );
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });

  server.listen(options.port, options.host, () => {
    const url = `http://${options.host}:${options.port}/`;
    console.log(`\x1b[32m▸\x1b[0m sessions viewer @ \x1b[1m${url}\x1b[0m`);
    console.log("\x1b[33m  security:\x1b[0m loopback-only · public redacted view");
    console.log(`\x1b[90m  workspace:\x1b[0m ${options.workspace}`);
    console.log("\x1b[90m  stop:\x1b[0m Ctrl+C");
    if (options.open) tryOpen(url);
  });
  return server;
}

function tryOpen(url) {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const cmdArgs = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const p = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true });
    p.unref();
  } catch {}
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runCli(parseCliOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(`\x1b[31mserve-sessions: ${error?.message ?? error}\x1b[0m`);
    process.exitCode = 1;
  }
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
  <span class="ws" id="ws">loopback-only · redacted view</span>
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
