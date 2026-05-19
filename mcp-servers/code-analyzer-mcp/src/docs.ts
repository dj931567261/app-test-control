// discover_docs: classify Markdown / plain text docs in the project root.

import { walk, rel, readUtf8, fileSize } from "./walker.js";
import type { DocHit } from "./types.js";

// Tags that strongly suggest a kind. Lowercased before matching.
const KIND_RULES: Array<{ pattern: RegExp; kind: DocHit["kind"]; signal: string }> = [
  { pattern: /^prd(\b|[._-])|product[._-]?requirement|prd\.md$/i, kind: "prd", signal: "prd-filename" },
  { pattern: /requirement(s)?\.md$|requirement[._-]/i, kind: "requirements", signal: "requirements-filename" },
  { pattern: /test[._-]?plan|test[._-]?case|testplan/i, kind: "test-plan", signal: "test-plan-filename" },
  { pattern: /spec(\b|[._-])|specification/i, kind: "spec", signal: "spec-filename" },
  { pattern: /^readme(\b|\.)/i, kind: "readme", signal: "readme-filename" },
];

const CONTENT_RULES: Array<{ pattern: RegExp; kind: DocHit["kind"]; signal: string }> = [
  { pattern: /用户故事|business\s+flow|user\s+journey|流程\s*[图描述]/i, kind: "requirements", signal: "content:user-journey" },
  { pattern: /验收标准|acceptance\s+criteria/i, kind: "spec", signal: "content:acceptance" },
  { pattern: /测试用例|test\s+case/i, kind: "test-plan", signal: "content:test-case" },
];

function classify(rel_path: string, head: string): { kind: DocHit["kind"]; signals: string[] } {
  const name = rel_path.toLowerCase().split("/").pop() || "";
  const signals: string[] = [];
  let kind: DocHit["kind"] = "other";
  for (const r of KIND_RULES) {
    if (r.pattern.test(name)) {
      kind = r.kind;
      signals.push(r.signal);
      break;
    }
  }
  // Content rules can promote "other" → something stronger, but never downgrade.
  for (const r of CONTENT_RULES) {
    if (r.pattern.test(head)) {
      signals.push(r.signal);
      if (kind === "other" || kind === "readme") kind = r.kind;
    }
  }
  return { kind, signals };
}

function head(content: string, lines = 30): string {
  const out: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (out.length >= lines) break;
    const t = line.trim();
    if (t.length === 0) continue;
    out.push(t);
  }
  return out.join("\n");
}

export async function discoverDocs(project_dir: string): Promise<DocHit[]> {
  const { files } = await walk(project_dir, { extensions: ["md", "markdown", "txt"], maxFiles: 200 });
  const hits: DocHit[] = [];
  for (const abs of files) {
    const r = rel(project_dir, abs);
    // Skip anything obviously not a project doc.
    if (r.includes("/CHANGELOG") || r.toLowerCase() === "license.md") continue;
    const sz = await fileSize(abs);
    const text = await readUtf8(abs);
    const h = head(text);
    const { kind, signals } = classify(r, h);
    // Suppress tiny "other"-kind notes — they're rarely useful and dominate the result list.
    if (kind === "other" && sz < 200) continue;
    hits.push({ path: r, abs, kind, size: sz, head: h, signal: signals });
  }
  // Order: prd > requirements > spec > test-plan > readme > other; within group by path.
  const order: Record<DocHit["kind"], number> = {
    prd: 0,
    requirements: 1,
    spec: 2,
    "test-plan": 3,
    readme: 4,
    other: 5,
  };
  hits.sort((a, b) => order[a.kind] - order[b.kind] || a.path.localeCompare(b.path));
  return hits;
}
