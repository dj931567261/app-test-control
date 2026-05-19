// Self-contained HTML rendering for a session. Inline CSS, file:// refs for
// screenshots (relative to the session dir). No external assets or JS deps.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { type RenderInput } from "./report.js";

const STATUS_BG: Record<string, string> = {
  running: "#fef3c7",
  passed: "#d1fae5",
  failed: "#fee2e2",
  aborted: "#e5e7eb",
};
const STATUS_FG: Record<string, string> = {
  running: "#92400e",
  passed: "#065f46",
  failed: "#991b1b",
  aborted: "#374151",
};
const STATUS_ICON: Record<string, string> = {
  running: "⏳",
  passed: "✅",
  failed: "❌",
  aborted: "⚪",
};

export function renderHtml(input: RenderInput): string {
  const { meta, steps, crashes, summary } = input;
  const passed = steps.filter((s) => s.result === "ok").length;
  const failed = steps.filter((s) => s.result === "fail").length;
  const skipped = steps.filter((s) => s.result === "skip").length;
  const duration = meta.ended_at
    ? humanDuration(
        new Date(meta.ended_at).getTime() - new Date(meta.started_at).getTime(),
      )
    : "in progress";
  const bg = STATUS_BG[meta.status] ?? "#e5e7eb";
  const fg = STATUS_FG[meta.status] ?? "#374151";
  const icon = STATUS_ICON[meta.status] ?? "·";

  const extra = meta.extra ? `<code>${esc(JSON.stringify(meta.extra))}</code>` : "—";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${esc(meta.name)} · ${meta.status}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; margin: 0; background: #f9fafb; color: #111827; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f172a; color: #e5e7eb; }
    header, section, details { background: #1f2937 !important; border-color: #374151 !important; }
    summary, .meta-row span:first-child { color: #9ca3af !important; }
    pre, code { background: #0f172a !important; color: #e5e7eb !important; }
  }
  main { max-width: 1100px; margin: 0 auto; padding: 24px; }
  header { background: white; padding: 24px; border-radius: 12px; border: 1px solid #e5e7eb; margin-bottom: 24px; }
  h1 { margin: 0 0 12px; font-size: 22px; display: flex; align-items: center; gap: 10px; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; letter-spacing: .02em; background: ${bg}; color: ${fg}; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 16px; }
  .stat { padding: 10px 14px; background: #f3f4f6; border-radius: 8px; }
  .stat .label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #6b7280; }
  .stat .value { font-size: 16px; font-weight: 600; margin-top: 2px; }
  section { background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; margin-bottom: 18px; }
  section h2 { margin: 0 0 14px; font-size: 16px; display: flex; align-items: center; gap: 8px; }
  details { background: #fafafa; border: 1px solid #e5e7eb; border-radius: 8px; padding: 0; margin-bottom: 10px; }
  details > summary { padding: 10px 14px; cursor: pointer; user-select: none; font-weight: 500; display: flex; align-items: center; gap: 8px; list-style: none; }
  details > summary::-webkit-details-marker { display: none; }
  details > summary::before { content: "▸"; color: #9ca3af; transition: transform .15s; display: inline-block; width: 12px; }
  details[open] > summary::before { transform: rotate(90deg); }
  details > .body { padding: 0 14px 14px 14px; }
  .meta-row { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; align-items: baseline; margin: 4px 0; }
  .meta-row span:first-child { font-size: 12px; color: #6b7280; }
  pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
  pre { background: #f3f4f6; padding: 12px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow-y: auto; }
  img.screenshot { max-width: 340px; max-height: 480px; border-radius: 6px; border: 1px solid #e5e7eb; cursor: zoom-in; transition: transform .15s; }
  img.screenshot:hover { transform: scale(1.02); }
  .crash-card { border-left: 3px solid #ef4444; padding-left: 12px; }
  .crash-label { font-weight: 600; font-size: 14px; margin-bottom: 6px; }
  .crash-kind { display: inline-block; padding: 1px 8px; border-radius: 4px; font-size: 11px; background: #fee2e2; color: #991b1b; margin-right: 6px; }
  .notes { background: #fffbeb; border-left: 3px solid #f59e0b; padding: 8px 12px; margin: 6px 0; border-radius: 4px; font-size: 13px; }
  .step-ok > summary { color: #065f46; }
  .step-fail > summary { color: #991b1b; }
  .step-skip > summary { color: #6b7280; opacity: .8; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { color: #9ca3af; font-style: italic; padding: 20px; text-align: center; }
</style>
</head>
<body><main>
<header>
  <h1>${icon} <span>${esc(meta.name)}</span> <span class="badge">${meta.status.toUpperCase()}</span></h1>
  <div class="meta-row"><span>ID</span><code>${esc(meta.id)}</code></div>
  <div class="meta-row"><span>Started</span><span>${esc(meta.started_at)}</span></div>
  ${meta.ended_at ? `<div class="meta-row"><span>Ended</span><span>${esc(meta.ended_at)}</span></div>` : ""}
  <div class="meta-row"><span>Duration</span><span>${esc(duration)}</span></div>
  <div class="meta-row"><span>Extra</span>${extra}</div>
  <div class="stats">
    <div class="stat"><div class="label">Total steps</div><div class="value">${steps.length}</div></div>
    <div class="stat"><div class="label">Passed</div><div class="value">✅ ${passed}</div></div>
    <div class="stat"><div class="label">Failed</div><div class="value">❌ ${failed}</div></div>
    ${skipped ? `<div class="stat"><div class="label">Skipped</div><div class="value">⏭️ ${skipped}</div></div>` : ""}
    <div class="stat"><div class="label">Crashes</div><div class="value">🐛 ${crashes.length}</div></div>
  </div>
</header>

${summary ? `<section><h2>Summary</h2><div>${esc(summary).replace(/\n/g, "<br>")}</div></section>` : ""}

${crashes.length > 0 ? `<section>
  <h2>🐛 Crashes (${crashes.length})</h2>
  ${crashes.map((c) => `
    <details class="crash-card" open>
      <summary><span class="crash-kind">${esc(c.kind ?? "unknown")}</span>${esc(c.id)} · ${esc(c.signature)}</summary>
      <div class="body">
        <div class="meta-row"><span>At</span><span>${esc(c.ts)}</span></div>
        ${c.step_index !== undefined ? `<div class="meta-row"><span>After step</span><span>#${c.step_index}</span></div>` : ""}
        ${c.repro_path.length > 0 ? `<div class="meta-row"><span>Repro path</span><span>${c.repro_path.map((i) => `#${i}`).join(" → ")}</span></div>` : ""}
        <div class="meta-row"><span>Stack</span><a href="${esc(c.stack_path)}">${esc(c.stack_path)}</a></div>
        ${c.log_path ? `<div class="meta-row"><span>Full log</span><a href="${esc(c.log_path)}">${esc(c.log_path)}</a></div>` : ""}
      </div>
    </details>`).join("")}
</section>` : ""}

<section>
  <h2>Steps (${steps.length})</h2>
  ${steps.length === 0 ? '<div class="empty">no steps recorded</div>' : steps.map((s) => {
    const sIcon = s.result === "ok" ? "✅" : s.result === "fail" ? "❌" : s.result === "skip" ? "⏭️" : "·";
    const cls = s.result === "ok" ? "step-ok" : s.result === "fail" ? "step-fail" : s.result === "skip" ? "step-skip" : "";
    return `<details class="${cls}">
      <summary>${sIcon} #${s.index} — ${esc(s.action)}</summary>
      <div class="body">
        <div class="meta-row"><span>At</span><span>${esc(s.ts)}</span></div>
        ${s.screenshot ? `<a href="${esc(s.screenshot)}" target="_blank"><img class="screenshot" src="${esc(s.screenshot)}" alt="step ${s.index}"></a>` : ""}
        ${s.log_excerpt ? `<div class="meta-row"><span>Log</span><a href="${esc(s.log_excerpt)}">${esc(s.log_excerpt)}</a></div>` : ""}
        ${s.notes ? `<div class="notes">${esc(s.notes).replace(/\n/g, "<br>")}</div>` : ""}
      </div>
    </details>`;
  }).join("")}
</section>

<footer style="text-align:center;color:#9ca3af;font-size:12px;margin-top:24px;">
  Generated by <code>app_test_ctrl/report-mcp</code> · ${esc(new Date().toISOString())}
</footer>
</main></body></html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

export async function writeHtmlReport(sessionDir: string, content: string): Promise<string> {
  const out = path.join(sessionDir, "report.html");
  await writeFile(out, content, "utf8");
  return out;
}
