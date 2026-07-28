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
//   codex              → ~/.codex/skills/<name>/SKILL.md (全局) + 项目根 AGENTS.md
//                        `--global` / `--project` 可只安装其中一种 scope
//   claude-desktop     → 打印手动粘贴说明 (无项目级 skill 概念)
//   opencode           → 同时写 .opencode/skills/<name>/SKILL.md 和复用 .claude/skills/（兜底）

import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const skillsDir = resolve(projectRoot, "skills");

const SUPPORTED_CLIENTS = ["claude-code", "cursor", "codex", "claude-desktop", "opencode", "antigravity"];
const MAX_SKILL_BYTES = 4 * 1024 * 1024;

function usage() {
  console.log(`Usage: install-skills.mjs [--client <name>] [--force] [--global|--project]`);
  console.log(`  --client one of: ${SUPPORTED_CLIENTS.join(", ")} (default claude-code)`);
  console.log(`  --force    overwrite existing regular files`);
  console.log(`  --global   Codex: only install ~/.codex/skills`);
  console.log(`  --project  Codex: only generate project AGENTS.md`);
}

function parseArgs(argv) {
  const out = { client: "claude-code", force: false, global: null };
  let scopeFlag = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--client") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) throw new Error("--client 缺少客户端名称");
      out.client = value;
    }
    else if (a === "--force" || a === "-f") out.force = true;
    else if (a === "--global" || a === "--project") {
      if (scopeFlag && scopeFlag !== a) {
        throw new Error("--global 与 --project 互斥，不能同时使用");
      }
      scopeFlag = a;
      out.global = a === "--global";
    }
    else if (a === "--help" || a === "-h") {
      out.help = true;
    } else {
      throw new Error(`未知参数：${a}`);
    }
  }
  if (out.global !== null && out.client !== "codex") {
    throw new Error("--global / --project 目前只适用于 --client codex");
  }
  return out;
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

function assertContained(target, boundary) {
  const rel = relative(resolve(boundary), resolve(target));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`目标路径越过允许边界：${target}`);
  }
}

async function ensureSafeDirectory(targetDir, boundary) {
  const base = resolve(boundary);
  const target = resolve(targetDir);
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`目录越过允许边界：${target}`);
  }

  let current = base;
  const parts = rel ? rel.split(sep).filter(Boolean) : [];
  for (const part of parts) {
    current = resolve(current, part);
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new Error(`拒绝经过符号链接或非目录路径：${current}`);
      }
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
        throw new Error(`拒绝经过其他用户拥有的目录：${current}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o755 });
      const st = await lstat(current);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new Error(`创建出的目录不安全：${current}`);
      }
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
        throw new Error(`创建出的目录 owner 不匹配：${current}`);
      }
    }
  }
}

async function inspectManagedDestination(dst) {
  try {
    const st = await lstat(dst);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(`拒绝覆盖符号链接或非普通文件：${dst}`);
    }
    if (st.nlink !== 1) throw new Error(`拒绝覆盖硬链接文件：${dst}`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      throw new Error(`拒绝覆盖其他用户拥有的文件：${dst}`);
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeManagedFile(dst, content, { force, boundary, mode = 0o644 }) {
  assertContained(dst, boundary);
  await ensureSafeDirectory(dirname(dst), boundary);
  const existed = await inspectManagedDestination(dst);
  if (existed && !force) return false;

  const tmp = `${dst}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let handle;
  try {
    handle = await open(tmp, "wx", mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(tmp, mode);
    await inspectManagedDestination(tmp);
    if (force) {
      // rename 替换的是目录项本身，不会跟随目标文件；前面的 lstat 负责拒绝可疑旧目标。
      await rename(tmp, dst);
    } else {
      // hard-link + unlink 是同文件系统内的原子 no-clobber 发布；避免检查后到发布前
      // 目标刚好出现时，默认模式意外覆盖已有文件。
      try {
        await link(tmp, dst);
      } catch (error) {
        if (error?.code === "EEXIST") return false;
        throw error;
      }
      await unlink(tmp);
    }
    await inspectManagedDestination(dst);
    return true;
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(tmp).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function readSkillSource(skillPath) {
  const st = await lstat(skillPath);
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) {
    throw new Error(`skill 源必须是无硬链接的普通文件：${skillPath}`);
  }
  if (st.size > MAX_SKILL_BYTES) {
    throw new Error(`skill 源超过 ${MAX_SKILL_BYTES} 字节上限：${skillPath}`);
  }
  return readFile(skillPath, "utf8");
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
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(e.name)) {
      throw new Error(`非法 skill 目录名：${e.name}`);
    }
    const p = resolve(skillsDir, e.name, "SKILL.md");
    if (await exists(p)) {
      await readSkillSource(p);
      names.push({ name: e.name, path: p });
    }
  }
  return names.sort((a, b) => a.name.localeCompare(b.name));
}

async function installClaudeCode(skills, force) {
  const targetBase = resolve(projectRoot, ".claude/skills");
  const written = [];
  for (const s of skills) {
    const dst = resolve(targetBase, s.name, "SKILL.md");
    const raw = await readSkillSource(s.path);
    if (!(await writeManagedFile(dst, raw, { force, boundary: projectRoot }))) {
      console.error(`[install-skills] skip (exists): ${dst} — use --force to overwrite`);
      continue;
    }
    written.push(dst);
  }
  console.log(`[install-skills] wrote ${written.length} skill(s) for claude-code:`);
  written.forEach((p) => console.log(`  - ${p}`));
}

async function installCursor(skills, force) {
  const targetBase = resolve(projectRoot, ".cursor/rules");
  const written = [];
  for (const s of skills) {
    const raw = await readSkillSource(s.path);
    const { frontmatter, body } = parseSkill(raw);
    const desc = (frontmatter.description ?? `Skill: ${s.name}`)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    const dst = resolve(targetBase, `${s.name}.mdc`);
    const mdc = `---
description: "${desc}"
globs: ["**/*"]
alwaysApply: false
---

# ${frontmatter.name ?? s.name}

${body}
`;
    if (!(await writeManagedFile(dst, mdc, { force, boundary: projectRoot }))) {
      console.error(`[install-skills] skip (exists): ${dst}`);
      continue;
    }
    written.push(dst);
  }
  console.log(`[install-skills] wrote ${written.length} rule(s) for cursor:`);
  written.forEach((p) => console.log(`  - ${p}`));
  console.log(`[install-skills] don't forget to run: npm run setup -- --client cursor`);
}

async function installCodex(skills, force, globalScope) {
  // 1) 复制每个 skill 到 ~/.codex/skills/<name>/SKILL.md（用户级，所有 codex 会话可见）
  if (globalScope !== false) {
    const globalBase = resolve(homedir(), ".codex/skills");
    const writtenGlobal = [];
    const skipped = [];
    for (const s of skills) {
      const dst = resolve(globalBase, s.name, "SKILL.md");
      const raw = await readSkillSource(s.path);
      if (!(await writeManagedFile(dst, raw, { force, boundary: homedir(), mode: 0o600 }))) {
        skipped.push(dst);
        continue;
      }
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
  }

  // 2) 项目根 AGENTS.md（聚合 prompt 注入，codex 进入此目录时自动读取）
  if (globalScope !== true) {
    const agentsDst = resolve(projectRoot, "AGENTS.md");
    const agentsExists = await inspectManagedDestination(agentsDst);
    if (agentsExists && !force) {
      console.log(`[install-skills] AGENTS.md exists — use --force to overwrite (project-level aggregate)`);
    } else {
      const header = `# app-test-ctrl — AI Agent Skills

Aggregated skills for Codex CLI / any AGENTS.md-aware coding agent. Each section is a self-contained workflow. The agent should match user requests to the most relevant skill via its description.

Source of truth: \`skills/<name>/SKILL.md\` in this repo.
Optional user-level installation: \`~/.codex/skills/<name>/SKILL.md\` (for any project).

---

`;
      const sections = [];
      for (const s of skills) {
        const raw = await readSkillSource(s.path);
        const { frontmatter, body } = parseSkill(raw);
        sections.push(`## ${frontmatter.name ?? s.name}

**Description**: ${frontmatter.description ?? "(none)"}

${body}

---
`);
      }
      const wroteAgents = await writeManagedFile(agentsDst, header + sections.join("\n"), {
        force,
        boundary: projectRoot,
      });
      if (wroteAgents) {
        console.log(`[install-skills] wrote ${agentsDst} with ${skills.length} skill(s)`);
      } else {
        console.log(`[install-skills] AGENTS.md appeared concurrently; did not overwrite without --force`);
      }
    }
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

async function installOpencode(skills, force) {
  const compatBase = resolve(projectRoot, ".claude/skills");
  const globalOpencodeSkillsDir = process.platform === "win32"
    ? resolve(process.env.APPDATA || resolve(homedir(), "AppData/Roaming"), "opencode/skills")
    : resolve(homedir(), ".config/opencode/skills");

  const written = [];
  const skippedCompat = [];
  const skippedExists = [];

  for (const s of skills) {
    const claudeSkillPath = resolve(compatBase, s.name, "SKILL.md");
    const claudeSkillExists = await exists(claudeSkillPath);

    if (claudeSkillExists) {
      skippedCompat.push(s.name);
      continue;
    }

    // Claude doesn't have it, copy to global OpenCode skills
    const dst = resolve(globalOpencodeSkillsDir, s.name, "SKILL.md");
    const boundary = process.platform === "win32"
      ? resolve(process.env.APPDATA || resolve(homedir(), "AppData/Roaming"))
      : homedir();
    const raw = await readSkillSource(s.path);
    if (!(await writeManagedFile(dst, raw, { force, boundary, mode: 0o600 }))) {
      skippedExists.push(dst);
      continue;
    }
    written.push(dst);
  }

  if (skippedCompat.length) {
    console.log(`[install-skills] Skipped copying these skills to global OpenCode skills because they are already present in Claude's project skills (.claude/skills/):`);
    skippedCompat.forEach((name) => console.log(`  - ${name}`));
  }
  if (skippedExists.length) {
    console.log(`[install-skills] Skipped copying these skills to global OpenCode skills because they already exist:`);
    skippedExists.forEach((p) => console.log(`  - ${p} (use --force to overwrite)`));
  }
  if (written.length) {
    console.log(`[install-skills] Wrote ${written.length} skill(s) globally for OpenCode:`);
    written.forEach((p) => console.log(`  - ${p}`));
  }
}

async function installAntigravity(skills, force) {
  const targetBase = resolve(homedir(), ".gemini/config/skills");
  const written = [];
  for (const s of skills) {
    const dst = resolve(targetBase, s.name, "SKILL.md");
    const raw = await readSkillSource(s.path);
    if (!(await writeManagedFile(dst, raw, { force, boundary: homedir(), mode: 0o600 }))) {
      console.error(`[install-skills] skip (exists): ${dst} — use --force to overwrite`);
      continue;
    }
    written.push(dst);
  }
  console.log(`[install-skills] wrote ${written.length} skill(s) for antigravity:`);
  written.forEach((p) => console.log(`  - ${p}`));
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[install-skills] ${error.message}`);
    usage();
    process.exitCode = 2;
    return;
  }
  const { client, force, global, help } = parsed;
  if (help) {
    usage();
    return;
  }
  if (!SUPPORTED_CLIENTS.includes(client)) {
    console.error(`[install-skills] unknown --client "${client}". Supported: ${SUPPORTED_CLIENTS.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  const skills = await listSkills();
  if (skills.length === 0) {
    console.error(`[install-skills] no skills found under ${skillsDir}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[install-skills] client=${client}, ${skills.length} skill(s): ${skills.map((s) => s.name).join(", ")}`);
  if (client === "claude-code") await installClaudeCode(skills, force);
  else if (client === "cursor") await installCursor(skills, force);
  else if (client === "codex") await installCodex(skills, force, global);
  else if (client === "claude-desktop") await installClaudeDesktop(skills);
  else if (client === "opencode") await installOpencode(skills, force);
  else if (client === "antigravity") await installAntigravity(skills, force);
}

main().catch((err) => {
  console.error("[install-skills] failed:", err);
  process.exit(1);
});
