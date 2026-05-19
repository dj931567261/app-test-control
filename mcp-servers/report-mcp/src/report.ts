import path from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import {
  type CrashRecord,
  type SessionMeta,
  type StepRecord,
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
  if (meta.extra && Object.keys(meta.extra).length > 0) {
    lines.push(`- **Extra**: \`${JSON.stringify(meta.extra)}\``);
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
  const out = path.join(sessionDir, "report.md");
  await writeFile(out, content, "utf8");
  return out;
}

export async function readReport(sessionDir: string): Promise<string> {
  return readFile(path.join(sessionDir, "report.md"), "utf8");
}
