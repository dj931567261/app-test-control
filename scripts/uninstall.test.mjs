import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UNINSTALL_SCRIPT = path.join(HERE, "uninstall.mjs");

async function createFixture(t) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "app-test-uninstall-")),
  );
  t.after(async () => rm(root, { recursive: true, force: true }));
  const scripts = path.join(root, "scripts");
  const home = path.join(root, "home");
  await Promise.all([
    mkdir(scripts, { recursive: true }),
    mkdir(home, { recursive: true }),
  ]);
  const script = path.join(scripts, "uninstall.mjs");
  await copyFile(UNINSTALL_SCRIPT, script);
  return { root, home, script };
}

async function writeCanonicalSkill(root, name, skillBody, referenceBody = null) {
  const skillRoot = path.join(root, "skills", name);
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), skillBody, "utf8");
  if (referenceBody !== null) {
    await mkdir(path.join(skillRoot, "references"), { recursive: true });
    await writeFile(
      path.join(skillRoot, "references", "policy.md"),
      referenceBody,
      "utf8",
    );
  }
}

async function writeInstalledSkill(root, skillBody, referenceBody = null) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "SKILL.md"), skillBody, "utf8");
  if (referenceBody !== null) {
    await mkdir(path.join(root, "references"), { recursive: true });
    await writeFile(path.join(root, "references", "policy.md"), referenceBody, "utf8");
  }
}

async function writeCursorBundle(root, referenceBody) {
  await mkdir(path.join(root, "references"), { recursive: true });
  await writeFile(path.join(root, "references", "policy.md"), referenceBody, "utf8");
}

function runUninstall(fixture, client) {
  return spawnSync(process.execPath, [fixture.script, "--client", client], {
    cwd: fixture.root,
    env: { ...process.env, HOME: fixture.home },
    encoding: "utf8",
    timeout: 10_000,
  });
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function ownedServerPath(root, server) {
  return path.join(root, "mcp-servers", server, "dist", "index.js");
}

test("claude-code 只删除 owned MCP 与字节一致的 skill bundle", async (t) => {
  const fixture = await createFixture(t);
  const devtest = "---\nname: devtest\n---\n\nCanonical devtest.\n";
  const qa = "---\nname: qa\n---\n\nCanonical qa.\n";
  await writeCanonicalSkill(fixture.root, "devtest", devtest, "# Policy\n");
  await writeCanonicalSkill(fixture.root, "qa", qa);

  const installedBase = path.join(fixture.root, ".claude", "skills");
  await writeInstalledSkill(
    path.join(installedBase, "devtest"),
    devtest,
    "# Policy\n",
  );
  await writeInstalledSkill(
    path.join(installedBase, "qa"),
    `${qa}\nUser modification.\n`,
  );
  await writeInstalledSkill(
    path.join(installedBase, "user-skill"),
    "User-owned skill.\n",
  );

  const configPath = path.join(fixture.root, ".mcp.json");
  await writeFile(configPath, `${JSON.stringify({
    theme: "keep-me",
    mcpServers: {
      log: {
        command: "node",
        args: [ownedServerPath(fixture.root, "log-mcp")],
      },
      analyzer: {
        command: "node",
        args: ["/user/servers/analyzer.js"],
      },
      report: {
        command: "node",
        args: [`${ownedServerPath(fixture.root, "report-mcp")}.backup`],
      },
      custom: { command: "custom-mcp", args: [] },
    },
  }, null, 2)}\n`, "utf8");

  const result = runUninstall(fixture, "claude-code");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.theme, "keep-me");
  assert.equal(config.mcpServers.log, undefined);
  assert.deepEqual(config.mcpServers.analyzer.args, ["/user/servers/analyzer.js"]);
  assert.match(config.mcpServers.report.args[0], /\.backup$/);
  assert.equal(config.mcpServers.custom.command, "custom-mcp");
  assert.equal(await pathExists(path.join(installedBase, "devtest")), false);
  assert.equal(await pathExists(path.join(installedBase, "qa")), true);
  assert.equal(await pathExists(path.join(installedBase, "user-skill")), true);
  assert.match(
    await readFile(path.join(installedBase, "qa", "SKILL.md"), "utf8"),
    /User modification/,
  );
});

test("cursor 仅凭精确 managed marker 删除 rule，并联动校验 supporting bundle", async (t) => {
  const fixture = await createFixture(t);
  await writeCanonicalSkill(
    fixture.root,
    "devtest",
    "---\nname: devtest\n---\n\nDevtest.\n",
    "devtest reference\n",
  );
  await writeCanonicalSkill(
    fixture.root,
    "qa",
    "---\nname: qa\n---\n\nQA.\n",
    "qa reference\n",
  );
  const rules = path.join(fixture.root, ".cursor", "rules");
  await mkdir(rules, { recursive: true });
  const unmarkedRule = path.join(rules, "devtest.mdc");
  await writeFile(unmarkedRule, "# User-owned devtest rule\n", "utf8");
  await writeCursorBundle(path.join(rules, "devtest"), "devtest reference\n");

  const markedRule = path.join(rules, "qa.mdc");
  await writeFile(
    markedRule,
    "---\nalwaysApply: false\n---\n\n<!-- app-test-ctrl-managed-rule:qa:v1 -->\n",
    "utf8",
  );
  await writeCursorBundle(path.join(rules, "qa"), "qa reference\n");

  const result = runUninstall(fixture, "cursor");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await pathExists(unmarkedRule), true);
  assert.equal(await pathExists(path.join(rules, "devtest")), true);
  assert.equal(await pathExists(markedRule), false);
  assert.equal(await pathExists(path.join(rules, "qa")), false);
});

test("codex TOML 只移除 owned 根表及子表，并保留未标记 AGENTS", async (t) => {
  const fixture = await createFixture(t);
  const configPath = path.join(fixture.home, ".codex", "config.toml");
  await mkdir(path.dirname(configPath), { recursive: true });
  const logPath = ownedServerPath(fixture.root, "log-mcp");
  const reportPath = ownedServerPath(fixture.root, "report-mcp");
  await writeFile(configPath, [
    "model = \"keep-model\"",
    "",
    "[mcp_servers.\"log\"]",
    "command = \"node\"",
    `args = [${JSON.stringify(logPath)}]`,
    "",
    "[mcp_servers.\"log\".env]",
    "ADB_BIN = \"adb\"",
    "",
    "[mcp_servers.analyzer]",
    "command = \"node\"",
    "args = [\"/user/analyzer.js\"]",
    "",
    "[mcp_servers.report]",
    "command = \"node\"",
    `args = [${JSON.stringify(`${reportPath}.backup`)}]`,
    `env = { USER_NOTE = ${JSON.stringify(reportPath)} }`,
    "",
    "[mcp_servers.custom]",
    "command = \"custom\"",
    "",
    "[projects.\"/tmp/example\"]",
    "trust_level = \"trusted\"",
    "",
  ].join("\n"), "utf8");
  const agentsPath = path.join(fixture.root, "AGENTS.md");
  await writeFile(agentsPath, "# User AGENTS\n\nDo not delete.\n", "utf8");

  const result = runUninstall(fixture, "codex");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const cleaned = await readFile(configPath, "utf8");
  assert.doesNotMatch(cleaned, /mcp_servers\."log"/);
  assert.doesNotMatch(cleaned, /ADB_BIN/);
  assert.match(cleaned, /mcp_servers\.analyzer/);
  assert.match(cleaned, /\/user\/analyzer\.js/);
  assert.match(cleaned, /mcp_servers\.report/);
  assert.match(cleaned, /\.backup/);
  assert.match(cleaned, /mcp_servers\.custom/);
  assert.match(cleaned, /projects\."\/tmp\/example"/);
  assert.equal(await readFile(agentsPath, "utf8"), "# User AGENTS\n\nDo not delete.\n");

  await writeFile(
    agentsPath,
    "# Managed AGENTS\n\n<!-- app-test-ctrl-managed-agents:v1 -->\n",
    "utf8",
  );
  const markedResult = runUninstall(fixture, "codex");
  assert.equal(markedResult.status, 0, `${markedResult.stdout}\n${markedResult.stderr}`);
  assert.equal(await pathExists(agentsPath), false);
});

test("OpenCode 与 Antigravity 仅移除 owned 节点，不删除整份用户配置", async (t) => {
  const fixture = await createFixture(t);
  const openCodePath = path.join(
    fixture.home,
    ".config",
    "opencode",
    "opencode.json",
  );
  await mkdir(path.dirname(openCodePath), { recursive: true });
  await writeFile(openCodePath, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    theme: "user-theme",
    mcp: {
      report: {
        type: "local",
        command: ["node", ownedServerPath(fixture.root, "report-mcp")],
      },
      log: { type: "local", command: ["node", "/user/log.js"] },
      custom: { type: "local", command: ["custom"] },
    },
  }, null, 2), "utf8");

  const openCodeResult = runUninstall(fixture, "opencode");
  assert.equal(
    openCodeResult.status,
    0,
    `${openCodeResult.stdout}\n${openCodeResult.stderr}`,
  );
  assert.equal(await pathExists(openCodePath), true);
  const openCode = JSON.parse(await readFile(openCodePath, "utf8"));
  assert.equal(openCode.theme, "user-theme");
  assert.equal(openCode.mcp.report, undefined);
  assert.deepEqual(openCode.mcp.log.command, ["node", "/user/log.js"]);
  assert.deepEqual(openCode.mcp.custom.command, ["custom"]);

  const antigravityPath = path.join(
    fixture.home,
    ".gemini",
    "config",
    "mcp_config.json",
  );
  await mkdir(path.dirname(antigravityPath), { recursive: true });
  await writeFile(antigravityPath, JSON.stringify({
    ui: { density: "compact" },
    mcpServers: {
      ui: {
        command: "node",
        args: [ownedServerPath(fixture.root, "ui-mcp")],
      },
      analyzer: { command: "node", args: ["/user/analyzer.js"] },
      custom: { command: "custom" },
    },
  }, null, 2), "utf8");

  const antigravityResult = runUninstall(fixture, "antigravity");
  assert.equal(
    antigravityResult.status,
    0,
    `${antigravityResult.stdout}\n${antigravityResult.stderr}`,
  );
  assert.equal(await pathExists(antigravityPath), true);
  const antigravity = JSON.parse(await readFile(antigravityPath, "utf8"));
  assert.equal(antigravity.ui.density, "compact");
  assert.equal(antigravity.mcpServers.ui, undefined);
  assert.deepEqual(antigravity.mcpServers.analyzer.args, ["/user/analyzer.js"]);
  assert.equal(antigravity.mcpServers.custom.command, "custom");
});
