#!/usr/bin/env node
// scripts/uninstall.mjs
// 卸载指定 AI 客户端的 MCP 配置与 Skills。
//
// 用法：
//   node scripts/uninstall.mjs [--client <name>]
//

import {
  access,
  lstat,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  inspectLegacyOfficialFirebaseServer,
  inspectOfficialFirebaseServer,
  parseGeneratedCodexFirebaseServer,
} from "./firebase-mcp-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const canonicalProjectRoot = realpathSync(projectRoot);

const SUPPORTED_CLIENTS = ["claude-code", "cursor", "codex", "claude-desktop", "opencode", "antigravity"];
const SERVERS_TO_REMOVE = ["log-mcp", "report-mcp", "ui-mcp", "analyzer-mcp", "code-analyzer-mcp", "build-runner-mcp", "crashlytics-mcp", "mobile", "log", "report", "ui", "analyzer", "code-analyzer", "build-runner", "crashlytics", "firebase"];
const SKILLS_TO_REMOVE = ["devtest", "qa", "minimize", "smart-qa", "crashfix"];
const BUNDLE_DIRS = ["agents", "references", "scripts", "assets"];
const SERVER_DIR_BY_NAME = {
  "log-mcp": "log-mcp",
  log: "log-mcp",
  "report-mcp": "report-mcp",
  report: "report-mcp",
  "ui-mcp": "ui-mcp",
  ui: "ui-mcp",
  "analyzer-mcp": "analyzer-mcp",
  analyzer: "analyzer-mcp",
  "code-analyzer-mcp": "code-analyzer-mcp",
  "code-analyzer": "code-analyzer-mcp",
  "build-runner-mcp": "build-runner-mcp",
  "build-runner": "build-runner-mcp",
  "crashlytics-mcp": "crashlytics-mcp",
  crashlytics: "crashlytics-mcp",
};

class CliUsageError extends Error {}

function safeErrorMessage(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/\x1b/gu, "\\x1b")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "?")
    .slice(0, 1000);
}

function parseArgs(argv) {
  const out = { client: "claude-code", help: false };
  const seen = new Set();
  const mark = (name) => {
    if (seen.has(name)) throw new CliUsageError(`${name} may be supplied only once`);
    seen.add(name);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--client") {
      mark("--client");
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        throw new CliUsageError("--client requires a value");
      }
      out.client = value;
    }
    else if (a === "--help" || a === "-h") {
      mark("--help");
      out.help = true;
    } else {
      throw new CliUsageError(`unknown or positional argument: ${a}`);
    }
  }
  if (out.help && argv.length !== 1) {
    throw new CliUsageError("--help cannot be combined with other arguments");
  }
  return out;
}

function printHelp() {
  console.log(`Usage: uninstall.mjs [--client <name>]`);
  console.log(`  --client one of: ${SUPPORTED_CLIENTS.join(", ")} (default claude-code)`);
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

function normalizedConfigText(value) {
  return String(value ?? "").replace(/\\\\/g, "/").replace(/\\/g, "/");
}

function quotedConfigValues(text) {
  const values = [];
  for (const match of String(text ?? "").matchAll(/"(?:\\.|[^"\\])*"/g)) {
    try {
      values.push(JSON.parse(match[0]));
    } catch {
      // 不是 setup-mcp 生成的 JSON 风格 TOML 字符串，不把它作为所有权证据。
    }
  }
  return values;
}

function invocationValues(configOrText) {
  if (typeof configOrText === "string") {
    const assignments = { command: [], args: [] };
    for (const line of configOrText.split("\n")) {
      const match = line.match(/^\s*(command|args)\s*=\s*(.*)$/);
      if (match) assignments[match[1]].push(match[2]);
    }
    // setup-mcp 为每个 server 恰好生成一条 command 和一条单行 args；任何歧义都保留。
    if (assignments.command.length !== 1 || assignments.args.length !== 1) return [];
    return [
      ...quotedConfigValues(assignments.command[0]),
      ...quotedConfigValues(assignments.args[0]),
    ];
  }
  if (!configOrText || typeof configOrText !== "object") return [];
  if (Array.isArray(configOrText.command)) return configOrText.command;
  return [configOrText.command, ...(Array.isArray(configOrText.args) ? configOrText.args : [])];
}

function officialFirebaseEntry(configOrText) {
  if (typeof configOrText === "string") {
    return parseGeneratedCodexFirebaseServer(configOrText);
  }
  if (!configOrText || typeof configOrText !== "object") return null;
  if (Array.isArray(configOrText.command)) {
    const [command, ...args] = configOrText.command;
    return {
      command,
      args,
      environment: configOrText.environment,
    };
  }
  return configOrText;
}

function isOwnedServer(name, configOrText, client) {
  if (name === "firebase") {
    const entry = officialFirebaseEntry(configOrText);
    if (entry === null) return false;
    const inspected = inspectOfficialFirebaseServer(entry, {
      expectedProjectRoot: canonicalProjectRoot,
      client,
    });
    return (inspected.valid && inspected.owned_by_expected_project)
      || inspectLegacyOfficialFirebaseServer(entry, {
        expectedProjectRoot: canonicalProjectRoot,
      });
  }
  const values = invocationValues(configOrText)
    .filter((value) => typeof value === "string")
    .map(normalizedConfigText);
  if (name === "mobile" || name === "mobile-mcp") {
    return values.includes("@mobilenext/mobile-mcp@latest");
  }
  const serverDir = SERVER_DIR_BY_NAME[name];
  if (!serverDir) return false;
  const expected = normalizedConfigText(
    resolve(projectRoot, "mcp-servers", serverDir, "dist", "index.js"),
  );
  return values.includes(expected);
}

async function cleanOwnedJsonServers(configPath, rootKey, client) {
  if (!(await exists(configPath))) return;
  let json;
  try {
    json = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(`refusing to edit invalid JSON config ${configPath}: ${error.message}`);
  }
  const servers = json?.[rootKey];
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return;
  let removed = 0;
  for (const name of SERVERS_TO_REMOVE) {
    if (
      Object.prototype.hasOwnProperty.call(servers, name)
      && isOwnedServer(name, servers[name], client)
    ) {
      delete servers[name];
      removed += 1;
    }
  }
  if (removed === 0) {
    console.log(`[uninstall] No owned MCP entries found in ${configPath}; preserved file`);
    return;
  }
  await writeFile(configPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  console.log(`[uninstall] Removed ${removed} owned MCP server(s) from ${configPath}`);
}

async function collectRegularFiles(root, relativeRoot = "") {
  const result = new Map();
  let rootMetadata;
  try {
    rootMetadata = await lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") return result;
    throw error;
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`refusing to inspect unsafe/non-directory bundle root: ${root}`);
  }
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    const absolute = resolve(root, entry.name);
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error(`refusing to inspect symlink: ${absolute}`);
    if (metadata.isDirectory()) {
      const nested = await collectRegularFiles(absolute, relativePath);
      for (const [key, value] of nested) result.set(key, value);
    } else if (metadata.isFile() && metadata.nlink === 1) {
      result.set(relativePath, await readFile(absolute));
    } else {
      throw new Error(`refusing to inspect non-regular or hard-linked file: ${absolute}`);
    }
  }
  return result;
}

async function canonicalSkillFiles(name, bundleOnly) {
  const root = resolve(projectRoot, "skills", name);
  const files = new Map();
  const skillPath = resolve(root, "SKILL.md");
  if (!(await exists(skillPath))) return null;
  const skillMetadata = await lstat(skillPath);
  if (skillMetadata.isSymbolicLink() || !skillMetadata.isFile() || skillMetadata.nlink !== 1) {
    throw new Error(`refusing to inspect unsafe canonical skill: ${skillPath}`);
  }
  if (!bundleOnly) {
    files.set("SKILL.md", await readFile(skillPath));
  }
  for (const directory of BUNDLE_DIRS) {
    const nested = await collectRegularFiles(resolve(root, directory), directory);
    for (const [key, value] of nested) files.set(key, value);
  }
  return files;
}

async function removeSkillIfUnmodified(target, name, bundleOnly = false) {
  if (!(await exists(target))) return;
  const targetStat = await lstat(target);
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    console.warn(`[uninstall] Preserved unsafe/non-directory skill target: ${target}`);
    return;
  }
  const [expected, actual] = await Promise.all([
    canonicalSkillFiles(name, bundleOnly),
    collectRegularFiles(target),
  ]);
  const matches = expected !== null
    && expected.size === actual.size
    && [...expected].every(([key, content]) => actual.get(key)?.equals(content));
  if (!matches) {
    console.warn(`[uninstall] Preserved modified or unowned skill bundle: ${target}`);
    return;
  }
  await rm(target, { recursive: true, force: false });
  console.log(`[uninstall] Removed owned skill bundle: ${target}`);
}

async function removeMarkedFile(target, marker) {
  if (!(await exists(target))) return false;
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    console.warn(`[uninstall] Preserved unsafe/unowned file: ${target}`);
    return false;
  }
  const content = await readFile(target, "utf8");
  const markerLine = `<!-- ${marker} -->`;
  if (!content.split(/\r?\n/).some((line) => line.trim() === markerLine)) {
    console.warn(`[uninstall] Preserved unmarked file: ${target}`);
    return false;
  }
  await rm(target, { force: false });
  console.log(`[uninstall] Removed owned file: ${target}`);
  return true;
}

function parseMcpTomlHeader(line) {
  const match = line.trim().match(
    /^\[\s*mcp_servers\.(?:"((?:\\.|[^"\\])*)"|([A-Za-z0-9_-]+))([^\]]*)\]\s*(?:#.*)?$/,
  );
  if (!match) return null;
  let name = match[2];
  if (match[1] !== undefined) {
    try {
      name = JSON.parse(`"${match[1]}"`);
    } catch {
      return null;
    }
  }
  const suffix = match[3].trim();
  return {
    name,
    root: suffix === "",
    descendant: suffix.startsWith("."),
  };
}

function cleanOwnedTomlServers(content) {
  const lines = content.split("\n");
  const sections = [];
  let current = { header: null, lines: [] };
  for (const line of lines) {
    if (line.trimStart().startsWith("[")) {
      sections.push(current);
      current = { header: parseMcpTomlHeader(line), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);

  const rootSectionsByName = new Map();
  for (const section of sections) {
    if (!section.header?.root) continue;
    const list = rootSectionsByName.get(section.header.name) ?? [];
    list.push(section);
    rootSectionsByName.set(section.header.name, list);
  }

  const ownedNames = new Set();
  for (const [name, roots] of rootSectionsByName) {
    // 重复根表不是合法的 setup-mcp 输出；存在歧义时全部保留。
    if (
      roots.length === 1
      && SERVERS_TO_REMOVE.includes(name)
      && isOwnedServer(name, roots[0].lines.join("\n"), "codex")
    ) {
      ownedNames.add(name);
    }
  }

  if (ownedNames.size === 0) return { content, removed: 0 };
  const kept = sections.filter((section) => {
    const header = section.header;
    return !(
      header
      && ownedNames.has(header.name)
      && (header.root || header.descendant)
    );
  });
  return {
    content: kept.flatMap((section) => section.lines).join("\n"),
    removed: ownedNames.size,
  };
}

const MAX_CODEX_CONFIG_BYTES = 4 * 1024 * 1024;

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

async function planCodexTomlCleanup(configPath) {
  let before;
  try {
    before = await lstat(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`failed to inspect ${configPath}: ${error.message}`);
  }
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1
    || before.size > MAX_CODEX_CONFIG_BYTES
  ) {
    throw new Error(`refusing to edit unsafe or oversized Codex config: ${configPath}`);
  }

  let content;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    throw new Error(`failed to read ${configPath}: ${error.message}`);
  }

  let after;
  try {
    after = await lstat(configPath);
  } catch (error) {
    throw new Error(`failed to re-inspect ${configPath}: ${error.message}`);
  }
  if (
    after.isSymbolicLink()
    || !after.isFile()
    || after.nlink !== 1
    || !sameFileIdentity(before, after)
  ) {
    throw new Error(`Codex config changed while it was being read: ${configPath}`);
  }

  return {
    configPath,
    before: after,
    ...cleanOwnedTomlServers(content),
  };
}

async function applyCodexTomlCleanup(plan) {
  if (plan.removed === 0) {
    console.log(`[uninstall] No owned MCP blocks found in ${plan.configPath}; preserved file`);
    return;
  }

  let current;
  try {
    current = await lstat(plan.configPath);
  } catch (error) {
    throw new Error(`failed to inspect ${plan.configPath} before writing: ${error.message}`);
  }
  if (
    current.isSymbolicLink()
    || !current.isFile()
    || current.nlink !== 1
    || !sameFileIdentity(plan.before, current)
  ) {
    throw new Error(`Codex config changed before it could be written: ${plan.configPath}`);
  }

  const tempPath = resolve(
    dirname(plan.configPath),
    `.app-test-ctrl-uninstall-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(tempPath, "wx", current.mode & 0o777);
    await handle.writeFile(plan.content, "utf8");
    await handle.sync();
    const tempIdentity = await handle.stat();
    await handle.close();
    handle = undefined;

    const beforeRename = await lstat(plan.configPath);
    if (
      beforeRename.isSymbolicLink()
      || !beforeRename.isFile()
      || beforeRename.nlink !== 1
      || !sameFileIdentity(plan.before, beforeRename)
    ) {
      throw new Error(`Codex config changed before atomic replacement: ${plan.configPath}`);
    }

    await rename(tempPath, plan.configPath);
    const written = await lstat(plan.configPath);
    if (
      written.isSymbolicLink()
      || !written.isFile()
      || written.nlink !== 1
      || written.dev !== tempIdentity.dev
      || written.ino !== tempIdentity.ino
      || written.size !== tempIdentity.size
    ) {
      throw new Error(`Codex config identity changed after atomic replacement: ${plan.configPath}`);
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new Error(`failed to write ${plan.configPath}: ${error.message}`);
  }
  console.log(
    `[uninstall] Removed ${plan.removed} owned MCP server block(s) from ${plan.configPath}`,
  );
}

async function main() {
  const { client, help } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }
  if (!SUPPORTED_CLIENTS.includes(client)) {
    throw new CliUsageError(`unknown --client; supported values: ${SUPPORTED_CLIENTS.join(", ")}`);
  }

  console.log(`[uninstall] Uninstalling MCP servers and skills for client: ${client}`);

  if (client === "claude-code") {
    await cleanOwnedJsonServers(resolve(projectRoot, ".mcp.json"), "mcpServers", client);
    for (const skill of SKILLS_TO_REMOVE) {
      await removeSkillIfUnmodified(resolve(projectRoot, `.claude/skills/${skill}`), skill);
    }
  }

  else if (client === "cursor") {
    await cleanOwnedJsonServers(resolve(projectRoot, ".cursor/mcp.json"), "mcpServers", client);
    for (const skill of SKILLS_TO_REMOVE) {
      const removedRule = await removeMarkedFile(
        resolve(projectRoot, `.cursor/rules/${skill}.mdc`),
        `app-test-ctrl-managed-rule:${skill}:v1`,
      );
      if (removedRule) {
        await removeSkillIfUnmodified(
          resolve(projectRoot, `.cursor/rules/${skill}`),
          skill,
          true,
        );
      }
    }
  }

  else if (client === "codex") {
    // 1) MCP。Codex 按 global → project 合并配置，因此卸载也必须审计并清理两层。
    // 先完成所有读取与所有权判定，再开始任一写入；任一层不可安全读取时不产生部分修改。
    const configPaths = [...new Set([
      resolve(homedir(), ".codex/config.toml"),
      resolve(projectRoot, ".codex/config.toml"),
    ])];
    const cleanupPlans = [];
    for (const configPath of configPaths) {
      const plan = await planCodexTomlCleanup(configPath);
      if (plan !== null) cleanupPlans.push(plan);
    }
    for (const plan of cleanupPlans) {
      await applyCodexTomlCleanup(plan);
    }

    // 2) Skills
    for (const skill of SKILLS_TO_REMOVE) {
      await removeSkillIfUnmodified(resolve(homedir(), `.codex/skills/${skill}`), skill);
    }
    await removeMarkedFile(resolve(projectRoot, "AGENTS.md"), "app-test-ctrl-managed-agents:v1");
  }

  else if (client === "claude-desktop") {
    const configPath = process.platform === "win32"
      ? resolve(process.env.APPDATA || resolve(homedir(), "AppData/Roaming"), "Claude/claude_desktop_config.json")
      : process.platform === "darwin"
        ? resolve(homedir(), "Library/Application Support/Claude/claude_desktop_config.json")
        : resolve(homedir(), ".config/Claude/claude_desktop_config.json");

    console.log(`\n[uninstall] For Claude Desktop:`);
    console.log(`  1. Open your Claude Desktop configuration file:`);
    console.log(`     ${configPath}`);
    console.log(`  2. Under "mcpServers", delete a key below only when its command/args`);
    console.log(`     point to this checkout (or exact @mobilenext/mobile-mcp@latest).`);
    console.log(`     For "firebase", also require the managed marker and exact pinned invocation.`);
    console.log(`     Preserve same-named entries with any other invocation:`);
    SERVERS_TO_REMOVE.forEach((s) => console.log(`     - "${s}"`));
    console.log(`  3. Manually remove the Custom Instructions for skills in your Claude Projects.`);
  }

  else if (client === "opencode") {
    // 1) MCP (Global config)
    const configPath = process.platform === "win32"
      ? resolve(process.env.APPDATA || resolve(homedir(), "AppData/Roaming"), "opencode/opencode.json")
      : resolve(homedir(), ".config/opencode/opencode.json");

    await cleanOwnedJsonServers(configPath, "mcp", client);

    // 2) Skills (Global skills directory)
    const globalSkillsDir = process.platform === "win32"
      ? resolve(process.env.APPDATA || resolve(homedir(), "AppData/Roaming"), "opencode/skills")
      : resolve(homedir(), ".config/opencode/skills");

    for (const skill of SKILLS_TO_REMOVE) {
      await removeSkillIfUnmodified(resolve(globalSkillsDir, skill), skill);
    }
  }

  else if (client === "antigravity") {
    await cleanOwnedJsonServers(
      resolve(homedir(), ".gemini/config/mcp_config.json"),
      "mcpServers",
      client,
    );
    const globalSkillsDir = resolve(homedir(), ".gemini/config/skills");
    for (const skill of SKILLS_TO_REMOVE) {
      await removeSkillIfUnmodified(resolve(globalSkillsDir, skill), skill);
    }
  }
}

main().catch((err) => {
  console.error(`[uninstall] failed: ${safeErrorMessage(err)}`);
  process.exit(err instanceof CliUsageError ? 2 : 1);
});
