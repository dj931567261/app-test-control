import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
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
import {
  FIREBASE_CODEX_FORWARDED_ENV_VARS,
  FIREBASE_MANAGED_ENV,
  FIREBASE_MANAGED_OWNER_ENV,
  FIREBASE_MANAGED_VALUE,
  OFFICIAL_FIREBASE_READ_TOOLS,
  bindOfficialFirebaseServerOwner,
  buildCodexOfficialFirebaseServer,
  buildOfficialFirebaseServer,
  officialFirebaseOwnerSha256,
} from "./firebase-mcp-config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UNINSTALL_SCRIPT = path.join(HERE, "uninstall.mjs");
const FIREBASE_CONFIG_HELPER = path.join(HERE, "firebase-mcp-config.mjs");

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
  await copyFile(
    FIREBASE_CONFIG_HELPER,
    path.join(scripts, "firebase-mcp-config.mjs"),
  );
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

function runUninstallArgs(fixture, args) {
  return spawnSync(process.execPath, [fixture.script, ...args], {
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
      "build-runner": {
        command: "node",
        args: [ownedServerPath(fixture.root, "build-runner-mcp")],
      },
      "build-runner-mcp": {
        command: "node",
        args: ["/user/servers/build-runner.js"],
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
  assert.equal(config.mcpServers["build-runner"], undefined);
  assert.deepEqual(
    config.mcpServers["build-runner-mcp"].args,
    ["/user/servers/build-runner.js"],
  );
  assert.equal(config.mcpServers.custom.command, "custom-mcp");
  assert.equal(await pathExists(path.join(installedBase, "devtest")), false);
  assert.equal(await pathExists(path.join(installedBase, "qa")), true);
  assert.equal(await pathExists(path.join(installedBase, "user-skill")), true);
  assert.match(
    await readFile(path.join(installedBase, "qa", "SKILL.md"), "utf8"),
    /User modification/,
  );
});

test("official Firebase MCP requires pinned invocation and checkout-bound ownership", async (t) => {
  const fixture = await createFixture(t);
  const configPath = path.join(fixture.root, ".mcp.json");
  const managed = bindOfficialFirebaseServerOwner(
    buildOfficialFirebaseServer(fixture.root, { projectRoot: fixture.root }),
    fixture.root,
  );
  await writeFile(configPath, JSON.stringify({
    mcpServers: {
      firebase: managed,
      custom: { command: "custom", args: [] },
    },
  }, null, 2), "utf8");

  const removed = runUninstall(fixture, "claude-code");
  assert.equal(removed.status, 0, `${removed.stdout}\n${removed.stderr}`);
  const cleaned = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(cleaned.mcpServers.firebase, undefined);
  assert.equal(cleaned.mcpServers.custom.command, "custom");

  const unmarked = structuredClone(managed);
  delete unmarked.env[FIREBASE_MANAGED_ENV];
  const wrongVersion = structuredClone(managed);
  wrongVersion.args[1] = "firebase-tools@latest";
  const extraFlag = structuredClone(managed);
  extraFlag.args.push("--debug");
  const preloadedRuntime = structuredClone(managed);
  preloadedRuntime.env.NODE_OPTIONS = "--require=/tmp/preload.js";
  const legacyUnbound = buildOfficialFirebaseServer(fixture.root, {
    projectRoot: fixture.root,
  });
  const foreignCheckout = bindOfficialFirebaseServerOwner(
    buildOfficialFirebaseServer(fixture.root, { projectRoot: fixture.root }),
    path.join(fixture.root, "other-checkout"),
  );
  for (const firebase of [
    unmarked,
    wrongVersion,
    extraFlag,
    preloadedRuntime,
    legacyUnbound,
    foreignCheckout,
  ]) {
    const original = `${JSON.stringify({ mcpServers: { firebase } }, null, 2)}\n`;
    await writeFile(configPath, original, "utf8");
    const preserved = runUninstall(fixture, "claude-code");
    assert.equal(
      preserved.status,
      0,
      `${preserved.stdout}\n${preserved.stderr}`,
    );
    assert.equal(await readFile(configPath, "utf8"), original);
  }
});

test("uninstall removes an exact checkout-owned v1 Firebase entry during safe migration", async (t) => {
  const fixture = await createFixture(t);
  const configPath = path.join(fixture.root, ".mcp.json");
  const legacyOwner = createHash("sha256")
    .update("app-test-ctrl-firebase-owner/v1\0")
    .update(fixture.root)
    .digest("hex");
  await writeFile(configPath, JSON.stringify({
    mcpServers: {
      firebase: {
        command: "npx",
        args: [
          "-y",
          "firebase-tools@15.24.0",
          "mcp",
          "--only",
          "crashlytics",
          "--dir",
          fixture.root,
        ],
        env: {
          APP_TEST_CTRL_MANAGED_FIREBASE_MCP: "official-v1",
          APP_TEST_CTRL_FIREBASE_OWNER_SHA256: legacyOwner,
        },
      },
    },
  }), "utf8");
  const result = runUninstall(fixture, "claude-code");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.mcpServers.firebase, undefined);
});

test("uninstall rejects unknown, positional, duplicate, and missing CLI arguments", async (t) => {
  const fixture = await createFixture(t);
  for (const args of [
    ["positional"],
    ["--unknown"],
    ["--client"],
    ["--client", "codxe"],
    ["--client", "codex", "--client", "cursor"],
    ["--help", "--client", "codex"],
  ]) {
    const result = runUninstallArgs(fixture, args);
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  }
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
  const buildRunnerPath = ownedServerPath(fixture.root, "build-runner-mcp");
  const firebase = buildCodexOfficialFirebaseServer(
    buildOfficialFirebaseServer(fixture.root, { projectRoot: fixture.root }),
    fixture.root,
    { nodeCommand: process.execPath },
  );
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
    "[mcp_servers.build-runner]",
    "command = \"node\"",
    `args = [${JSON.stringify(buildRunnerPath)}]`,
    "",
    "[mcp_servers.build-runner.env]",
    "APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN = \"\"",
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
    "[mcp_servers.firebase]",
    `command = ${JSON.stringify(firebase.command)}`,
    `args = ${JSON.stringify(firebase.args)}`,
    `cwd = ${JSON.stringify(firebase.cwd)}`,
    `startup_timeout_sec = ${firebase.startup_timeout_sec}`,
    `enabled = ${firebase.enabled}`,
    `env_vars = ${JSON.stringify(FIREBASE_CODEX_FORWARDED_ENV_VARS)}`,
    `env = { ${FIREBASE_MANAGED_ENV} = ${JSON.stringify(FIREBASE_MANAGED_VALUE)}, ${FIREBASE_MANAGED_OWNER_ENV} = ${JSON.stringify(officialFirebaseOwnerSha256(fixture.root))} }`,
    `enabled_tools = ${JSON.stringify(OFFICIAL_FIREBASE_READ_TOOLS)}`,
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
  assert.doesNotMatch(cleaned, /mcp_servers\.build-runner/);
  assert.doesNotMatch(cleaned, /APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN/);
  assert.match(cleaned, /mcp_servers\.analyzer/);
  assert.match(cleaned, /\/user\/analyzer\.js/);
  assert.match(cleaned, /mcp_servers\.report/);
  assert.match(cleaned, /\.backup/);
  assert.match(cleaned, /mcp_servers\.custom/);
  assert.doesNotMatch(cleaned, /mcp_servers\.firebase/);
  assert.doesNotMatch(cleaned, /crashlytics_get_issue/);
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

test("codex 卸载清理项目级 TOML 并保留同名非受管 block", async (t) => {
  const fixture = await createFixture(t);
  const projectConfigPath = path.join(fixture.root, ".codex", "config.toml");
  await mkdir(path.dirname(projectConfigPath), { recursive: true });
  await writeFile(projectConfigPath, [
    "approval_policy = \"on-request\"",
    "",
    "[mcp_servers.log]",
    "command = \"node\"",
    `args = [${JSON.stringify(ownedServerPath(fixture.root, "log-mcp"))}]`,
    "",
    "[mcp_servers.report]",
    "command = \"node\"",
    "args = [\"/user/report.js\"]",
    "",
    "[mcp_servers.custom]",
    "command = \"custom\"",
    "",
  ].join("\n"), "utf8");

  const result = runUninstall(fixture, "codex");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const cleaned = await readFile(projectConfigPath, "utf8");
  assert.doesNotMatch(cleaned, /mcp_servers\.log/);
  assert.doesNotMatch(cleaned, /log-mcp/);
  assert.match(cleaned, /approval_policy = "on-request"/);
  assert.match(cleaned, /mcp_servers\.report/);
  assert.match(cleaned, /\/user\/report\.js/);
  assert.match(cleaned, /mcp_servers\.custom/);
  assert.equal(
    await pathExists(path.join(fixture.home, ".codex", "config.toml")),
    false,
  );
});

test("codex 卸载同时清理 global/project 并分别保留非受管同名 block", async (t) => {
  const fixture = await createFixture(t);
  const globalConfigPath = path.join(fixture.home, ".codex", "config.toml");
  const projectConfigPath = path.join(fixture.root, ".codex", "config.toml");
  await Promise.all([
    mkdir(path.dirname(globalConfigPath), { recursive: true }),
    mkdir(path.dirname(projectConfigPath), { recursive: true }),
  ]);
  await writeFile(globalConfigPath, [
    "model = \"keep-global\"",
    "",
    "[mcp_servers.log]",
    "command = \"node\"",
    "args = [\"/user/log.js\"]",
    "",
    "[mcp_servers.report]",
    "command = \"node\"",
    `args = [${JSON.stringify(ownedServerPath(fixture.root, "report-mcp"))}]`,
    "",
  ].join("\n"), "utf8");
  await writeFile(projectConfigPath, [
    "approval_policy = \"never\"",
    "",
    "[mcp_servers.log]",
    "command = \"node\"",
    `args = [${JSON.stringify(ownedServerPath(fixture.root, "log-mcp"))}]`,
    "",
    "[mcp_servers.report]",
    "command = \"node\"",
    "args = [\"/project-user/report.js\"]",
    "",
  ].join("\n"), "utf8");

  const result = runUninstall(fixture, "codex");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const [globalCleaned, projectCleaned] = await Promise.all([
    readFile(globalConfigPath, "utf8"),
    readFile(projectConfigPath, "utf8"),
  ]);
  assert.match(globalCleaned, /model = "keep-global"/);
  assert.match(globalCleaned, /mcp_servers\.log/);
  assert.match(globalCleaned, /\/user\/log\.js/);
  assert.doesNotMatch(globalCleaned, /mcp_servers\.report/);
  assert.match(projectCleaned, /approval_policy = "never"/);
  assert.doesNotMatch(projectCleaned, /mcp_servers\.log/);
  assert.match(projectCleaned, /mcp_servers\.report/);
  assert.match(projectCleaned, /\/project-user\/report\.js/);
});

test("codex 卸载在两层配置均不存在时安全跳过", async (t) => {
  const fixture = await createFixture(t);
  const result = runUninstall(fixture, "codex");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await pathExists(path.join(fixture.home, ".codex", "config.toml")), false);
  assert.equal(await pathExists(path.join(fixture.root, ".codex", "config.toml")), false);
});

test("codex 任一层配置无法安全读取时在写入前 fail-closed", async (t) => {
  const fixture = await createFixture(t);
  const globalConfigPath = path.join(fixture.home, ".codex", "config.toml");
  const projectConfigPath = path.join(fixture.root, ".codex", "config.toml");
  await mkdir(path.dirname(globalConfigPath), { recursive: true });
  const globalOriginal = [
    "[mcp_servers.log]",
    "command = \"node\"",
    `args = [${JSON.stringify(ownedServerPath(fixture.root, "log-mcp"))}]`,
    "",
  ].join("\n");
  await writeFile(globalConfigPath, globalOriginal, "utf8");
  await mkdir(projectConfigPath, { recursive: true });

  const result = runUninstall(fixture, "codex");
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /unsafe or oversized Codex config/);
  assert.equal(await readFile(globalConfigPath, "utf8"), globalOriginal);
});

test("codex 配置写入失败时保留原文并 fail-closed", {
  skip: process.platform === "win32"
    || typeof process.getuid !== "function"
    || process.getuid() === 0,
}, async (t) => {
  const fixture = await createFixture(t);
  const projectConfigDir = path.join(fixture.root, ".codex");
  const projectConfigPath = path.join(projectConfigDir, "config.toml");
  await mkdir(projectConfigDir, { recursive: true });
  const original = [
    "[mcp_servers.log]",
    "command = \"node\"",
    `args = [${JSON.stringify(ownedServerPath(fixture.root, "log-mcp"))}]`,
    "",
  ].join("\n");
  await writeFile(projectConfigPath, original, { encoding: "utf8", mode: 0o600 });
  await chmod(projectConfigDir, 0o500);
  let result;
  try {
    result = runUninstall(fixture, "codex");
  } finally {
    await chmod(projectConfigDir, 0o700);
  }
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /failed to write/);
  assert.equal(await readFile(projectConfigPath, "utf8"), original);
});

test("OpenCode 与 Antigravity 仅移除 owned 节点，不删除整份用户配置", async (t) => {
  const fixture = await createFixture(t);
  const managedFirebase = bindOfficialFirebaseServerOwner(
    buildOfficialFirebaseServer(fixture.root, { projectRoot: fixture.root }),
    fixture.root,
  );
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
      firebase: {
        type: "local",
        command: [managedFirebase.command, ...managedFirebase.args],
        environment: managedFirebase.env,
      },
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
  assert.equal(openCode.mcp.firebase, undefined);
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
      firebase: {
        command: managedFirebase.command,
        args: managedFirebase.args,
        env: {},
      },
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
  assert.deepEqual(antigravity.mcpServers.firebase.args, managedFirebase.args);
  assert.equal(antigravity.mcpServers.custom.command, "custom");
});
