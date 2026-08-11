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
  CRASHFIX_STEP_ACTIONS,
  assertStoredCrashfixAnalysis,
  childVerificationContextSchema,
  crashfixAnalysisSchema,
  crashfixProvenanceModeSchema,
  crashfixProvenanceStatusSchema,
  crashfixRequestedModeSchema,
  crashfixRequestedWorkflowSchema,
  loadMeta,
  readSteps,
  readCrashes,
  remoteSourceLockSchema,
  resolveWorkspaceRoot,
} from "../mcp-servers/report-mcp/dist/sessions.js";
import { renderHtml } from "../mcp-servers/report-mcp/dist/html-report.js";
import {
  assertCrashfixPublicProjectionOmitsSourceIdentifiers,
  publicSessionExtra,
  renderMarkdown,
} from "../mcp-servers/report-mcp/dist/report.js";

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
const CRASH_SIGNATURE_VERSIONS = new Set(["v1", "java-v2", "ios-v2"]);
const REPORT_LANGUAGES = new Set(["zh-CN", "en-US"]);
const PUBLIC_SOURCE_METRIC_KEYS = new Set([
  "events",
  "users",
  "eventCount",
  "affectedUsers",
]);
const CRASHFIX_STAGES = new Set(CRASHFIX_STEP_ACTIONS);
const VERIFICATION_CONTEXT_KEYS = [
  "verification_schema_version",
  "verification_parent_session_id",
  "verification_run",
  "artifact_sha256",
  "device_ref_sha256",
  "plan_sha256",
  "verification_target_signature_version",
  "verification_target_fingerprint",
  "platform",
  "type",
];
const VERIFICATION_OPT_IN_KEYS = [
  "verification_schema_version",
  "verification_parent_session_id",
  "verification_run",
  "verification_target_signature_version",
  "verification_target_fingerprint",
];
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
      ([key, value]) =>
        PUBLIC_SOURCE_METRIC_KEYS.has(key)
        && typeof value === "number"
        && Number.isFinite(value)
        && value >= 0,
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

/**
 * Keep the public crash identity in the same closed domain as report-mcp.
 * Missing historical values are explicitly labelled; malformed values are
 * never reflected into API or dynamically rendered report output.
 */
export function normalizePublicCrashSignatureVersion(value) {
  return CRASH_SIGNATURE_VERSIONS.has(value) ? value : "unversioned";
}

/**
 * Report language is an immutable, session-owned presentation control. Keep
 * the public viewer on the same closed values as report-mcp and omit missing
 * legacy or malformed values so the renderer, rather than untrusted evidence,
 * applies its default.
 */
export function normalizePublicReportLanguage(value) {
  return REPORT_LANGUAGES.has(value) ? value : undefined;
}

/**
 * Project only the caller-authored, schema-bounded analysis. The persisted
 * evidence_set_sha256 is a private server binding and must never cross the
 * Viewer API boundary.
 */
function publicCrashfixAnalysis(value) {
  if (!isRecord(value)) return undefined;
  const {
    evidence_set_sha256: _privateEvidenceSetSha256,
    ...candidate
  } = value;
  const parsed = crashfixAnalysisSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function verificationContextFromExtra(extra) {
  if (!isRecord(extra)) return { optedIn: false };
  // artifact/device/plan/platform/type are shared with ordinary candidate or
  // devtest metadata. Only verification-namespaced controls opt a session in.
  const optedIn = VERIFICATION_OPT_IN_KEYS.some((key) => hasOwn(extra, key));
  if (!optedIn) return { optedIn: false };
  const parsed = childVerificationContextSchema.safeParse(
    Object.fromEntries(VERIFICATION_CONTEXT_KEYS.map((key) => [key, extra[key]])),
  );
  return parsed.success
    ? { optedIn: true, context: parsed.data }
    : { optedIn: true };
}

function closedCrashfixControls(meta, publicExtra) {
  const extra = isRecord(meta.extra) ? meta.extra : {};
  const sourceLock = remoteSourceLockSchema.safeParse(meta.source_lock);
  const provenanceStatus = crashfixProvenanceStatusSchema.safeParse(
    extra.provenance_status,
  );
  if (!sourceLock.success || !provenanceStatus.success) return undefined;

  let provenanceMode;
  if (provenanceStatus.data === "resolved") {
    const parsedMode = crashfixProvenanceModeSchema.safeParse(extra.provenance_mode);
    if (!parsedMode.success) return undefined;
    provenanceMode = parsedMode.data;
  } else if (hasOwn(extra, "provenance_mode")) {
    return undefined;
  }

  // publicSessionExtra already applies the cross-field quick_test constraints.
  // Re-parse its closed projection rather than trusting arbitrary raw extra.
  const workflow = crashfixRequestedWorkflowSchema.safeParse(
    publicExtra.requested_workflow,
  );
  const mode = crashfixRequestedModeSchema.safeParse(publicExtra.requested_mode);
  if (!workflow.success || !mode.success) return undefined;

  return {
    acquisition_route: sourceLock.data.acquisition_route,
    workflow: workflow.data,
    mode: mode.data,
    provenance_status: provenanceStatus.data,
    ...(provenanceMode === undefined ? {} : { provenance_mode: provenanceMode }),
    artifact_sha256:
      typeof extra.artifact_sha256 === "string"
      && /^[a-f0-9]{64}$/.test(extra.artifact_sha256)
        ? extra.artifact_sha256
        : undefined,
  };
}

function lastCrashfixStage(steps) {
  let currentStage;
  for (const step of steps) {
    if (typeof step.action === "string" && CRASHFIX_STAGES.has(step.action)) {
      currentStage = step.action;
    }
  }
  return currentStage;
}

function conservativeLocalSessionType(meta) {
  const publicName = meta.id.replace(/^\d{4}-\d{2}-\d{2}_\d{6}_/, "");
  const names = [meta.name, publicName];
  const matches = (pattern) => names.every(
    (name) => typeof name === "string" && pattern.test(name),
  );
  if (matches(/^(?:qa|smart-qa)(?:[-_]|$)/)) return "qa";
  if (matches(/^devtest(?:[-_]|$)/)) return "devtest";
  if (matches(/^minimize(?:[-_]|$)/)) return "minimize";
  return "other";
}

function deriveSessionView(meta, steps, publicExtra) {
  const extra = isRecord(meta.extra) ? meta.extra : {};
  const verification = verificationContextFromExtra(extra);
  const hasRemoteControls = meta.source_lock !== undefined
    || hasOwn(extra, "provenance_status")
    || hasOwn(extra, "provenance_mode");

  if (
    verification.context !== undefined
    && meta.source_lock === undefined
    && !hasOwn(extra, "provenance_status")
    && !hasOwn(extra, "provenance_mode")
  ) {
    return {
      session_type: "crashfix_verification",
      verification_context: verification.context,
    };
  }

  const crashfix = closedCrashfixControls(meta, publicExtra);
  if (crashfix !== undefined && !verification.optedIn) {
    const currentStage = lastCrashfixStage(steps);
    return {
      session_type: "crashfix",
      ...crashfix,
      ...(currentStage === undefined ? {} : { current_stage: currentStage }),
    };
  }

  // Malformed remote/verification controls never fall through to a friendly
  // local label merely because an attacker chose a qa/devtest-like name.
  if (hasRemoteControls || verification.optedIn) return { session_type: "other" };
  return { session_type: conservativeLocalSessionType(meta) };
}

function buildPublicRecords(meta, steps, crashes) {
  const deviceIdentifiers = collectDeviceIdentifiers(meta.extra);
  const publicExtra = publicSessionExtra(meta.extra);
  const reportLanguage = normalizePublicReportLanguage(meta.report_language);
  const sessionView = deriveSessionView(meta, steps, publicExtra);
  const analysis = sessionView.session_type === "crashfix"
    ? publicCrashfixAnalysis(meta.crashfix_analysis)
    : undefined;
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
      signature_version: normalizePublicCrashSignatureVersion(crash.signature_version),
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
      // Keep the full source only in this in-memory renderer input. Report's
      // validator needs it to recheck target/app-build identity; its renderer
      // emits only provider + a second-hash correlation ref + occurrence time.
      ...(crash.source ? { source: crash.source } : {}),
    };
  });
  const publicMeta = {
    id: meta.id,
    name: meta.id.replace(/^\d{4}-\d{2}-\d{2}_\d{6}_/, ""),
    started_at: meta.started_at,
    ...(typeof meta.ended_at === "string" ? { ended_at: meta.ended_at } : {}),
    status: meta.status,
    session_type: sessionView.session_type,
    ...(reportLanguage === undefined ? {} : { report_language: reportLanguage }),
    ...(analysis === undefined ? {} : { crashfix_analysis: analysis }),
    ...(sessionView.session_type === "crashfix"
      ? {
          acquisition_route: sessionView.acquisition_route,
          workflow: sessionView.workflow,
          mode: sessionView.mode,
          ...(sessionView.current_stage === undefined
            ? {}
            : { current_stage: sessionView.current_stage }),
        }
      : {}),
    ...(Object.keys(publicExtra).length > 0 ? { extra: publicExtra } : {}),
  };
  const records = {
    meta: publicMeta,
    // Report renderers apply the same publicSessionExtra projection once.
    // Keep the raw object private to this in-memory rendering input: exposing
    // it through the API would bypass the viewer's allowlist boundary.
    renderMeta: {
      ...publicMeta,
      ...(meta.crashfix_analysis === undefined
        ? {}
        : { crashfix_analysis: meta.crashfix_analysis }),
      ...(meta.source_lock === undefined
        ? {}
        : { source_lock: meta.source_lock }),
      ...(meta.extra === undefined ? {} : { extra: meta.extra }),
    },
    steps: publicSteps,
    crashes: publicCrashes,
    renderCrashes,
    assets,
    sessionView,
  };
  assertCrashfixPublicProjectionOmitsSourceIdentifiers(meta, crashes, {
    meta: publicMeta,
    steps: publicSteps,
    crashes: publicCrashes,
  });
  return records;
}

async function loadPublicSession(workspace, rawId) {
  const dir = await resolveSessionDirectory(workspace, rawId);
  let meta;
  let steps;
  let crashes;
  try {
    [meta, steps, crashes] = await Promise.all([
      loadMeta(dir),
      readSteps(dir),
      readCrashes(dir),
    ]);
  } catch {
    // A malformed or concurrently changing archive is not a public session.
    // Do not reflect parser diagnostics, absolute paths, or stored evidence.
    throw new HttpError(404, "session not found");
  }
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
  try {
    // Validate the private target, canonical stacks and evidence-set digest
    // before projecting any analysis into the browser-facing API.
    await assertStoredCrashfixAnalysis(dir, meta);
  } catch {
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
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SESSION_ID_RE.test(entry.name)) continue;
    try {
      const session = await loadPublicSession(workspaceReal, entry.name);
      const durationMs = session.meta.ended_at
        ? new Date(session.meta.ended_at).getTime() - new Date(session.meta.started_at).getTime()
        : null;
      candidates.push({
        session,
        summary: {
          id: session.meta.id,
          name: session.meta.name,
          status: session.meta.status,
          session_type: session.meta.session_type,
          ...(session.meta.report_language
            ? { report_language: session.meta.report_language }
            : {}),
          ...(session.meta.session_type === "crashfix"
            ? {
                acquisition_route: session.meta.acquisition_route,
                workflow: session.meta.workflow,
                mode: session.meta.mode,
                ...(session.meta.current_stage
                  ? { current_stage: session.meta.current_stage }
                  : {}),
              }
            : {}),
          started_at: session.meta.started_at,
          ...(session.meta.ended_at ? { ended_at: session.meta.ended_at } : {}),
          duration_ms: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null,
          step_count: session.steps.length,
          crash_count: session.crashes.length,
          has_report_html: true,
        },
      });
    } catch {
      // Corrupt, mismatched, or unsafe entries are not public sessions.
    }
  }
  const byId = new Map(candidates.map((candidate) => [candidate.summary.id, candidate]));
  for (const child of candidates) {
    const context = child.session.sessionView.verification_context;
    if (child.session.sessionView.session_type !== "crashfix_verification" || !context) {
      continue;
    }
    const parent = byId.get(context.verification_parent_session_id);
    if (
      parent === undefined
      || parent === child
      || parent.session.sessionView.session_type !== "crashfix"
      || parent.session.sessionView.workflow !== "strict"
      || parent.session.sessionView.artifact_sha256 !== context.artifact_sha256
      || (parent.session.meta.report_language ?? "zh-CN")
        !== (child.session.meta.report_language ?? "zh-CN")
      || Date.parse(child.session.meta.started_at) < Date.parse(parent.session.meta.started_at)
    ) {
      continue;
    }
    child.summary.verification_parent_session_id = parent.summary.id;
    child.summary.verification_run = context.verification_run;
    parent.summary.verification_children ??= [];
    parent.summary.verification_children.push({
      session_id: child.summary.id,
      verification_run: context.verification_run,
    });
  }
  for (const candidate of candidates) {
    candidate.summary.verification_children?.sort(
      (left, right) => left.verification_run - right.verification_run
        || left.session_id.localeCompare(right.session_id),
    );
  }
  const sessions = candidates.map((candidate) => candidate.summary);
  sessions.sort((a, b) => b.started_at.localeCompare(a.started_at));
  return sessions;
}

function renderableRecords(session) {
  return {
    meta: session.renderMeta,
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
    const before = await lstat(target);
    if (
      before.isSymbolicLink()
      || !before.isFile()
      || before.nlink !== 1
      || before.size > MAX_PUBLIC_ASSET_BYTES
    ) {
      throw new HttpError(404, "asset not found");
    }
    const noFollow = constants.O_NOFOLLOW ?? 0;
    handle = await open(target, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0));
    const fileStat = await handle.stat();
    const [after, canonical] = await Promise.all([lstat(target), realpath(target)]);
    const relativeCanonical = path.relative(session.dir, canonical);
    if (
      !fileStat.isFile()
      || fileStat.nlink !== 1
      || !sameFileIdentity(before, fileStat)
      || !sameFileIdentity(fileStat, after)
      || relativeCanonical === ""
      || relativeCanonical === ".."
      || relativeCanonical.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeCanonical)
    ) {
      throw new HttpError(404, "asset not found");
    }
    return { handle, size: fileStat.size, extension: path.extname(target).toLowerCase() };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, "asset not found");
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
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
  .card .details { font-size: 11px; color: #475569; margin-top: 5px; word-break: break-word; }
  .card .relations { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
  .relation { border: 1px solid #bfdbfe; border-radius: 999px; background: #eff6ff; color: #1d4ed8; padding: 1px 7px; font: inherit; font-size: 10px; cursor: pointer; }
  .relation:hover { background: #dbeafe; }
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
  <button id="refresh" title="重新读取 Session 列表">🔄 刷新</button>
</header>
<main>
  <aside>
    <div class="filters">
      <input id="q" type="search" placeholder="🔍 搜索 name / id…" autocomplete="off">
      <select id="status">
        <option value="">全部状态</option>
        <option value="passed">✅ 通过</option>
        <option value="failed">❌ 失败</option>
        <option value="running">🟡 进行中</option>
        <option value="aborted">⚪ 已中止</option>
      </select>
      <select id="type">
        <option value="">全部类型</option>
        <option value="crashfix">🔥 Firebase CrashFix</option>
        <option value="crashfix_verification">🧪 CrashFix 验证</option>
        <option value="qa">QA</option>
        <option value="devtest">DevTest</option>
        <option value="minimize">Minimize</option>
        <option value="other">其他</option>
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
  const STATUS_ZH = { running:"进行中", passed:"通过", failed:"失败", aborted:"已中止" };
  const STATUS_EN = { running:"RUNNING", passed:"PASSED", failed:"FAILED", aborted:"ABORTED" };
  const STAGE_ZH = {
    preflight:"预检", remote_scope_verification:"远程范围核验",
    remote_issue_triage:"远程问题分诊", remote_evidence_archival:"远程证据归档",
    crash_identity_analysis:"崩溃身份分析", source_provenance_binding:"源码来源绑定",
    test_fixture_probe:"测试夹具探测", test_fixture_approval:"测试夹具审批",
    source_snapshot:"源码快照", source_location:"源码定位",
    baseline_validation:"基线验证", candidate_preparation:"候选修复准备",
    candidate_validation:"候选修复验证", real_device_verification:"真机验证",
    candidate_export:"候选修复导出", abort:"中止"
  };
  const STAGE_EN = {
    preflight:"Preflight", remote_scope_verification:"Remote scope verification",
    remote_issue_triage:"Remote issue triage", remote_evidence_archival:"Remote evidence archival",
    crash_identity_analysis:"Crash identity analysis", source_provenance_binding:"Source provenance binding",
    test_fixture_probe:"Test fixture probe", test_fixture_approval:"Test fixture approval",
    source_snapshot:"Source snapshot", source_location:"Source location",
    baseline_validation:"Baseline validation", candidate_preparation:"Candidate preparation",
    candidate_validation:"Candidate validation", real_device_verification:"Real-device verification",
    candidate_export:"Candidate export", abort:"Abort"
  };

  function isEnglish(s) { return s.report_language === "en-US"; }
  function dur(ms, english) {
    if (ms == null) return english ? "in progress" : "进行中";
    const s = Math.round(ms / 1000);
    if (s < 60) return s + (english ? "s" : "秒");
    const m = Math.floor(s / 60);
    if (m < 60) return english
      ? m + "m " + (s % 60) + "s"
      : m + "分 " + (s % 60) + "秒";
    const h = Math.floor(m / 60);
    return english ? h + "h " + (m % 60) + "m" : h + "小时 " + (m % 60) + "分";
  }
  function typeBadge(s, english) {
    if (s.session_type === "crashfix") return "🔥 Firebase CrashFix";
    if (s.session_type === "crashfix_verification") return english ? "🧪 Verification" : "🧪 CrashFix 验证";
    if (s.session_type === "qa") return "QA";
    if (s.session_type === "devtest") return "DevTest";
    if (s.session_type === "minimize") return "Minimize";
    return english ? "Other" : "其他";
  }
  function crashfixDetails(s, english) {
    if (s.session_type !== "crashfix") return "";
    const details = [
      (english ? "source=" : "来源=") + s.acquisition_route,
      (english ? "workflow=" : "流程=") + s.workflow,
      (english ? "mode=" : "模式=") + s.mode,
    ];
    if (s.current_stage) {
      const label = (english ? STAGE_EN : STAGE_ZH)[s.current_stage];
      details.push((english ? "stage=" : "阶段=") + label + " (" + s.current_stage + ")");
    }
    return '<div class="details">' + details.map(esc).join(" · ") + '</div>';
  }
  function relations(s, english) {
    const links = [];
    if (s.verification_parent_session_id) {
      links.push({
        id: s.verification_parent_session_id,
        label: english ? "Parent · run " + s.verification_run : "父 Session · 第 " + s.verification_run + " 轮",
      });
    }
    for (const child of s.verification_children || []) {
      links.push({
        id: child.session_id,
        label: english ? "Verification run " + child.verification_run : "验证第 " + child.verification_run + " 轮",
      });
    }
    if (links.length === 0) return "";
    return '<div class="relations">' + links.map(link =>
      '<button type="button" class="relation" data-related-id="' + esc(link.id) + '">' + esc(link.label) + '</button>'
    ).join("") + '</div>';
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
    const tp = $("type").value;
    const filtered = SESSIONS.filter(s => {
      if (st && s.status !== st) return false;
      if (tp && s.session_type !== tp) return false;
      if (q && !(s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))) return false;
      return true;
    });
    $("count").textContent = filtered.length + " / " + SESSIONS.length + " 个 Session";
    $("list").innerHTML = filtered.map(s => {
      const active = CURRENT === s.id ? " active" : "";
      const english = isEnglish(s);
      const status = (english ? STATUS_EN : STATUS_ZH)[s.status];
      const counts = english
        ? s.step_count + " steps · " + s.crash_count + " crashes · " + dur(s.duration_ms, true)
        : s.step_count + " 步骤 · " + s.crash_count + " 崩溃 · " + dur(s.duration_ms, false);
      return '<div class="card' + active + '" data-id="' + esc(s.id) + '">' +
        '<div><span class="badge badge-' + s.status + '">' + esc(status) + '</span>' +
        '<span class="badge">' + esc(typeBadge(s, english)) + '</span><span class="name">' + esc(s.name) + '</span></div>' +
        '<div class="meta">' + esc(s.id) + '</div>' +
        '<div class="meta">' + esc(counts) + '</div>' +
        crashfixDetails(s, english) + relations(s, english) +
      '</div>';
    }).join("");
    for (const el of document.querySelectorAll(".card")) {
      el.addEventListener("click", () => select(el.dataset.id));
    }
    for (const el of document.querySelectorAll(".relation")) {
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        select(el.dataset.relatedId);
      });
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
  $("type").addEventListener("change", render);
  $("refresh").addEventListener("click", load);
  load();
</script>
</body>
</html>`;
}
