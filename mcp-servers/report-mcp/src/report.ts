import path from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  type CrashRecord,
  type CrashSource,
  type SessionMeta,
  type StepRecord,
  writePrivateTextFile,
} from "./sessions.js";

export interface RenderInput {
  meta: SessionMeta;
  steps: StepRecord[];
  crashes: CrashRecord[];
  /** Free-form summary the agent wants to surface at the top. */
  summary?: string;
}

const STATUS_ICON: Record<SessionMeta["status"], string> = {
  running: "🟡",
  passed: "✅",
  failed: "❌",
  aborted: "⚪",
};

const PUBLIC_EXTRA_KEYS = new Set([
  "artifact_sha256",
  "candidate_base_sha",
  "changed_files",
  "commit",
  "device_ref_sha256",
  "diff_sha256",
  "duration_min",
  "max_steps",
  "origin",
  "package",
  "plan_sha256",
  "platform",
  "proc_name",
  "provider",
  "raw_evidence_archived",
  "repo_alias",
  "requested_mode",
  "strategy",
  "target_fingerprint",
  "type",
  "verification_runs",
]);
const RAW_DEVICE_KEYS = new Set([
  "device",
  "device_id",
  "device_name",
  "serial",
  "serial_number",
  "udid",
]);

function publicExtraValue(value: unknown): string | number | boolean | string[] | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 512);
  }
  if (Array.isArray(value) && value.length <= 100) {
    const strings = value.map((entry) => publicExtraValue(entry));
    if (strings.every((entry): entry is string => typeof entry === "string")) {
      return strings;
    }
  }
  return undefined;
}

/** Produce the bounded allowlisted view used by Markdown/HTML and viewers. */
export function publicSessionExtra(
  extra: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | string[]> {
  const result: Record<string, string | number | boolean | string[]> = {};
  if (!extra) return result;
  for (const [key, rawValue] of Object.entries(extra)) {
    if (RAW_DEVICE_KEYS.has(key) && typeof rawValue === "string" && rawValue.length > 0) {
      result.device_ref_sha256 = createHash("sha256")
        .update(rawValue, "utf8")
        .digest("hex");
      continue;
    }
    if (!PUBLIC_EXTRA_KEYS.has(key)) continue;
    if (key === "device_ref_sha256") {
      if (typeof rawValue === "string" && /^[a-f0-9]{64}$/.test(rawValue)) {
        result[key] = rawValue;
      }
      continue;
    }
    const value = publicExtraValue(rawValue);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function markdownSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/`/g, "\\u0060");
}

export function renderMarkdown(input: RenderInput): string {
  const { meta, steps, crashes, summary } = input;
  const passed = steps.filter((s) => s.result === "ok").length;
  const failed = steps.filter((s) => s.result === "fail").length;
  const duration = meta.ended_at
    ? humanDuration(
        new Date(meta.ended_at).getTime() - new Date(meta.started_at).getTime(),
      )
    : "in progress";

  const lines: string[] = [];
  lines.push(`# ${STATUS_ICON[meta.status]} Session: ${meta.name}`);
  lines.push("");
  lines.push(`- **ID**: \`${meta.id}\``);
  lines.push(`- **Status**: ${meta.status.toUpperCase()}`);
  lines.push(`- **Started**: ${meta.started_at}`);
  if (meta.ended_at) lines.push(`- **Ended**: ${meta.ended_at}`);
  lines.push(`- **Duration**: ${duration}`);
  lines.push(`- **Steps**: ${steps.length} (✅ ${passed}, ❌ ${failed})`);
  lines.push(`- **Crashes**: ${crashes.length}`);
  const publicExtra = publicSessionExtra(meta.extra);
  if (Object.keys(publicExtra).length > 0) {
    lines.push(`- **Extra**: \`${markdownSafeJson(publicExtra)}\``);
  }
  lines.push("");

  if (summary) {
    lines.push("## Summary");
    lines.push("");
    lines.push(summary.trim());
    lines.push("");
  }

  if (crashes.length > 0) {
    lines.push("## 🐛 Crashes");
    lines.push("");
    for (const c of crashes) {
      lines.push(`### ${c.id} · ${c.kind ?? "unknown"} · ${escape(c.signature)}`);
      lines.push("");
      lines.push(`- **At**: ${c.ts}`);
      if (c.step_index !== undefined) {
        lines.push(`- **Detected after step**: #${c.step_index}`);
      }
      if (c.repro_path.length > 0) {
        lines.push(`- **Repro path (steps)**: ${c.repro_path.map((i) => `#${i}`).join(" → ")}`);
      }
      if (c.source) {
        lines.push(`- **Source**: ${renderSourceSummary(c.source)}`);
      }
      lines.push(`- **Stack**: [\`${c.stack_path}\`](${c.stack_path})`);
      if (c.log_path) {
        lines.push(`- **Full log**: [\`${c.log_path}\`](${c.log_path})`);
      }
      lines.push("");
    }
  }

  lines.push("## Steps");
  lines.push("");
  if (steps.length === 0) {
    lines.push("_no steps recorded_");
  } else {
    for (const s of steps) {
      const icon =
        s.result === "ok" ? "✅" : s.result === "fail" ? "❌" : s.result === "skip" ? "⏭️" : "·";
      lines.push(`### ${icon} Step #${s.index} — ${escape(s.action)}`);
      lines.push("");
      lines.push(`- **At**: ${s.ts}`);
      if (s.screenshot) {
        lines.push(`- **Screenshot**: ![](${s.screenshot})`);
      }
      if (s.log_excerpt) {
        lines.push(`- **Log**: [\`${s.log_excerpt}\`](${s.log_excerpt})`);
      }
      if (s.notes) {
        lines.push("");
        lines.push("> " + s.notes.replace(/\n/g, "\n> "));
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

/** Render only a provider, an opaque correlation ref, and occurrence time. */
export function renderSourceSummary(source: CrashSource): string {
  const opaqueRef = createHash("sha256")
    // external_key is the provider-neutral idempotency identity. Hashing it
    // again avoids exposing or correlating low-entropy provider issue ids.
    .update(source.external_key, "utf8")
    .digest("hex")
    .slice(0, 10);
  return [
    escape(source.provider),
    `ref sha256:${opaqueRef}`,
    ...(source.occurred ? [`occurred ${escape(source.occurred)}`] : []),
  ].join(" · ");
}

function humanDuration(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function escape(s: string): string {
  return s.replace(/[\r\n]+/g, " ").slice(0, 200);
}

export async function writeReport(
  sessionDir: string,
  content: string,
): Promise<string> {
  return writePrivateTextFile(sessionDir, "report.md", content);
}

export async function readReport(sessionDir: string): Promise<string> {
  return readFile(path.join(sessionDir, "report.md"), "utf8");
}
