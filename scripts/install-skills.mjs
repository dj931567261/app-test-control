#!/usr/bin/env node
// scripts/install-skills.mjs
// 把 skills/<name>/SKILL.md 安装到指定 AI 客户端的位置。
//
// 用法：
//   node scripts/install-skills.mjs [--client <name>] [--force]
//
// 支持的 client：
//   claude-code (默认)  → .claude/skills/<name>/SKILL.md (复制，frontmatter 原样)
//   cursor             → .cursor/rules/<name>.mdc (转换 frontmatter)
//   codex              → ~/.codex/skills/<name>/SKILL.md (复制到全局) + 项目根 AGENTS.md (聚合 prompt 注入)
//   claude-desktop     → 打印手动粘贴说明 (无项目级 skill 概念)
//   opencode           → 同时写 .opencode/skills/<name>/SKILL.md 和复用 .claude/skills/（兜底）

import { readFile, writeFile, readdir, mkdir, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const skillsDir = resolve(projectRoot, "skills");

const SUPPORTED_CLIENTS = ["claude-code", "cursor", "codex", "claude-desktop", "opencode", "antigravity"];

function parseArgs(argv) {
  const out = { client: "claude-code", force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--client") out.client = argv[++i];
    else if (a === "--force" || a === "-f") out.force = true;
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: install-skills.mjs [--client <name>] [--force]`);
      console.log(`  --client one of: ${SUPPORTED_CLIENTS.join(", ")} (default claude-code)`);
      console.log(`  --force    overwrite existing files`);
      process.exit(0);
    }
  }
  return out;
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

// Parse YAML-ish frontmatter at top of file.
// Returns { frontmatter: { name, description, version?, "argument-hint"? }, body: string }
function parseSkill(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: raw };
  const fmRaw = m[1];
  const body = m[2];
  const fm = {};
  // Simple line-based parser: "key: value" (value may be quoted)
  // Multi-line values (folded scalars) not supported; we don't use them.
  for (const line of fmRaw.split("\n")) {
    const k = line.match(/^([\w-]+):\s*(.*)$/);
    if (!k) continue;
    let val = k[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[k[1]] = val;
  }
  return { frontmatter: fm, body };
}

async function listSkills() {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const names = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = resolve(skillsDir, e.name, "SKILL.md");
    if (await exists(p)) names.push({ name: e.name, path: p });
  }
  return names.sort((a, b) => a.name.localeCompare(b.name));
}

async function installClaudeCode(skills, force) {
  const targetBase = resolve(projectRoot, ".claude/skills");
  const written = [];
  for (const s of skills) {
    const dst = resolve(targetBase, s.name, "SKILL.md");
    if (await exists(dst) && !force) {
      console.error(`[install-skills] skip (exists): ${dst} — use --force to overwrite`);
      continue;
    }
    await mkdir(dirname(dst), { recursive: true });
    const raw = await readFile(s.path, "utf8");
    await writeFile(dst, raw, "utf8");
    written.push(dst);
  }
  console.log(`[install-skills] wrote ${written.length} skill(s) for claude-code:`);
  written.forEach((p) => console.log(`  - ${p}`));
}

async function installCursor(skills, force) {
  const targetBase = resolve(projectRoot, ".cursor/rules");
  await mkdir(targetBase, { recursive: true });
  const written = [];
  for (const s of skills) {
    const raw = await readFile(s.path, "utf8");
    const { frontmatter, body } = parseSkill(raw);
    const desc = (frontmatter.description ?? `Skill: ${s.name}`).replace(/"/g, '\\"');
    const dst = resolve(targetBase, `${s.name}.mdc`);
    if (await exists(dst) && !force) {
      console.error(`[install-skills] skip (exists): ${dst}`);
      continue;
    }
    const mdc = `---
description: "${desc}"
globs: ["**/*"]
alwaysApply: false
---

# ${frontmatter.name ?? s.name}

${body}
`;
    await writeFile(dst, mdc, "utf8");
    written.push(dst);
  }
  console.log(`[install-skills] wrote ${written.length} rule(s) for cursor:`);
  written.forEach((p) => console.log(`  - ${p}`));
  console.log(`[install-skills] don't forget to run: npm run setup -- --client cursor`);
}

async function installCodex(skills, force) {
  // 1) 复制每个 skill 到 ~/.codex/skills/<name>/SKILL.md（用户级，所有 codex 会话可见）
  const globalBase = resolve(homedir(), ".codex/skills");
  const writtenGlobal = [];
  const skipped = [];
  for (const s of skills) {
    const dst = resolve(globalBase, s.name, "SKILL.md");
    if (await exists(dst) && !force) {
      skipped.push(dst);
      continue;
    }
    await mkdir(dirname(dst), { recursive: true });
    const raw = await readFile(s.path, "utf8");
    await writeFile(dst, raw, "utf8");
    writtenGlobal.push(dst);
  }
  if (writtenGlobal.length) {
    console.log(`[install-skills] wrote ${writtenGlobal.length} skill(s) to ~/.codex/skills/:`);
    writtenGlobal.forEach((p) => console.log(`  - ${p}`));
  }
  if (skipped.length) {
    console.log(`[install-skills] skipped ${skipped.length} existing file(s) — use --force to overwrite:`);
    skipped.forEach((p) => console.log(`  - ${p}`));
  }

  // 2) 项目根 AGENTS.md（聚合 prompt 注入，codex 进入此目录时自动读取）
  const agentsDst = resolve(projectRoot, "AGENTS.md");
  if (await exists(agentsDst) && !force) {
    console.log(`[install-skills] AGENTS.md exists — use --force to overwrite (project-level aggregate)`);
  } else {
    const header = `# app-test-ctrl — AI Agent Skills

Aggregated skills for Codex CLI / any AGENTS.md-aware coding agent. Each section is a self-contained workflow. The agent should match user requests to the most relevant skill via its description.

Source of truth: \`skills/<name>/SKILL.md\` in this repo.
Also installed at user level: \`~/.codex/skills/<name>/SKILL.md\` (for any project).

---

`;
    const sections = [];
    for (const s of skills) {
      const raw = await readFile(s.path, "utf8");
      const { frontmatter, body } = parseSkill(raw);
      sections.push(`## ${frontmatter.name ?? s.name}

**Description**: ${frontmatter.description ?? "(none)"}

${body}

---
`);
    }
    await writeFile(agentsDst, header + sections.join("\n"), "utf8");
    console.log(`[install-skills] wrote ${agentsDst} with ${skills.length} skill(s)`);
  }

  console.log(`[install-skills] don't forget to set up MCP: npm run setup -- --client codex (then paste TOML)`);
}

async function installClaudeDesktop(skills) {
  console.log(`[install-skills] Claude Desktop has no project-level "skills".`);
  console.log(`[install-skills] To use these skills in Claude Desktop:`);
  console.log(``);
  console.log(`  1. Create a Project in Claude Desktop`);
  console.log(`  2. In the project's "Custom Instructions", paste the content of one or more of:`);
  for (const s of skills) {
    console.log(`     - ${s.path}`);
  }
  console.log(``);
  console.log(`  3. For MCP servers: npm run setup -- --client claude-desktop  (prints JSON to paste)`);
}

async function installOpencode(skills) {
  // opencode 直接兼容 .claude/skills/<name>/SKILL.md（见 https://opencode.ai/docs/zh-cn/skills/ "Claude 兼容"）。
  // 仓库里 .claude/skills/ 已 committed，clone 后开箱即用。
  // 这里只做检测 + 友好提示，避免写 .opencode/skills/ 与 .claude/skills/ 同名冲突
  // （opencode 文档说"技能名在所有搜索路径中保持唯一"）。
  const compatBase = resolve(projectRoot, ".claude/skills");
  const missing = [];
  const found = [];
  for (const s of skills) {
    const p = resolve(compatBase, s.name, "SKILL.md");
    if (await exists(p)) found.push(p);
    else missing.push(p);
  }
  if (found.length) {
    console.log(`[install-skills] opencode reads .claude/skills/ natively. Already in place:`);
    found.forEach((p) => console.log(`  - ${p}`));
  }
  if (missing.length) {
    console.log(`[install-skills] missing — run \`npm run install:skills\` (claude-code branch) first to populate them:`);
    missing.forEach((p) => console.log(`  - ${p}`));
  }
  console.log(``);
  console.log(`[install-skills] don't forget to set up MCP: npm run setup -- --client opencode  (writes opencode.json)`);
}

async function installAntigravity(skills, force) {
  const targetBase = resolve(homedir(), ".gemini/config/skills");
  const written = [];
  for (const s of skills) {
    const dst = resolve(targetBase, s.name, "SKILL.md");
    if (await exists(dst) && !force) {
      console.error(`[install-skills] skip (exists): ${dst} — use --force to overwrite`);
      continue;
    }
    await mkdir(dirname(dst), { recursive: true });
    const raw = await readFile(s.path, "utf8");
    await writeFile(dst, raw, "utf8");
    written.push(dst);
  }
  console.log(`[install-skills] wrote ${written.length} skill(s) for antigravity:`);
  written.forEach((p) => console.log(`  - ${p}`));
}

async function main() {
  const { client, force } = parseArgs(process.argv.slice(2));
  if (!SUPPORTED_CLIENTS.includes(client)) {
    console.error(`[install-skills] unknown --client "${client}". Supported: ${SUPPORTED_CLIENTS.join(", ")}`);
    process.exit(2);
  }
  const skills = await listSkills();
  if (skills.length === 0) {
    console.error(`[install-skills] no skills found under ${skillsDir}`);
    process.exit(1);
  }
  console.log(`[install-skills] client=${client}, ${skills.length} skill(s): ${skills.map((s) => s.name).join(", ")}`);
  if (client === "claude-code") await installClaudeCode(skills, force);
  else if (client === "cursor") await installCursor(skills, force);
  else if (client === "codex") await installCodex(skills, force);
  else if (client === "claude-desktop") await installClaudeDesktop(skills);
  else if (client === "opencode") await installOpencode(skills);
  else if (client === "antigravity") await installAntigravity(skills, force);
}

main().catch((err) => {
  console.error("[install-skills] failed:", err);
  process.exit(1);
});
