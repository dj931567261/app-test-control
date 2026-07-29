import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  inspectCrashlyticsConfiguration,
  isEnoent,
  isValidDeviceUdid,
  isWdaReadyJson,
  looksLikeCliHelp,
  sanitizeDiagnostic,
} from "./doctor.mjs";
import {
  expandTemplateValue,
  findNodeAbsPath,
  findNpxAbsPath,
  firstAbsoluteCommandPath,
} from "./setup-mcp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WDA_SCRIPT = path.join(HERE, "ios-wda-up.sh");
const INSTALL_SKILLS_SCRIPT = path.join(HERE, "install-skills.mjs");
const SETUP_MCP_SCRIPT = path.join(HERE, "setup-mcp.mjs");
const VALID_UDID = "00008030-0011223344556677";
const WDA_BUNDLE = "com.example.wda.runner.xctrunner";

test("doctor strictly accepts only boolean ready=true", () => {
  assert.equal(isWdaReadyJson('{"value":{"ready":true}}'), true);
  assert.equal(isWdaReadyJson('{"ready":true}'), true);
  assert.equal(isWdaReadyJson('{"value":{"ready":"true"}}'), false);
  assert.equal(isWdaReadyJson('{"sessionId":"abc","state":"success"}'), false);
  assert.equal(isWdaReadyJson("not-json"), false);
});

test("doctor recognizes non-zero CLI help without hiding real failures", () => {
  assert.equal(looksLikeCliHelp({ ok: false, code: 1, out: "Usage: tool OPTIONS", stderr: "" }), true);
  assert.equal(looksLikeCliHelp({ ok: false, code: 64, out: "", stderr: "OPTIONS:\n  -h --help" }), true);
  assert.equal(looksLikeCliHelp({ ok: false, code: "ENOENT", out: "", stderr: "" }), false);
  assert.equal(looksLikeCliHelp({ ok: false, code: 1, signal: "SIGSEGV", out: "Usage:", stderr: "" }), false);
  assert.equal(looksLikeCliHelp({ ok: false, code: 1, out: "", stderr: "dyld: missing library" }), false);
  assert.equal(isEnoent({ ok: false, code: "ENOENT" }), true);
});

test("doctor rejects malformed UDIDs and neutralizes terminal controls", () => {
  assert.equal(isValidDeviceUdid(VALID_UDID), true);
  assert.equal(isValidDeviceUdid("warning\u001b[2J"), false);
  assert.equal(sanitizeDiagnostic("line\n\u001b[2Jnext"), "line \\x1b[2Jnext");
  assert.equal(sanitizeDiagnostic("a".repeat(1005), 10), "aaaaaaaaaa…");
});

test("setup-mcp expands nested JSON values without corrupting Windows-like paths", () => {
  const projectRoot = "C:\\Users\\A\"lice\\$&-$$-$`-$'-Project Root";
  const template = {
    command: "node",
    args: [
      "${PROJECT_ROOT}/dist/index.js",
      { nested: ["prefix:${PROJECT_ROOT}:suffix", 7, null] },
    ],
    env: {
      ROOT: "${PROJECT_ROOT}",
      MULTIPLE: "${PROJECT_ROOT}/${PROJECT_ROOT}",
    },
  };

  const expanded = expandTemplateValue(template, projectRoot);
  assert.notEqual(expanded, template);
  assert.equal(expanded.args[0], `${projectRoot}/dist/index.js`);
  assert.equal(expanded.args[1].nested[0], `prefix:${projectRoot}:suffix`);
  assert.equal(expanded.env.ROOT, projectRoot);
  assert.equal(expanded.env.MULTIPLE, `${projectRoot}/${projectRoot}`);
  assert.deepEqual(JSON.parse(JSON.stringify(expanded)), expanded);
  assert.equal(template.env.ROOT, "${PROJECT_ROOT}");
});

test("setup-mcp resolves Windows command paths with spaces and multiline lookup output", () => {
  const nodePath = "C:\\Program Files\\nodejs\\node.exe";
  const npxPath = "C:\\Program Files\\nodejs\\npx.cmd";
  assert.equal(findNodeAbsPath({ platform: "win32", execPath: nodePath }), nodePath);
  assert.equal(
    firstAbsoluteCommandPath(`\r\n"${npxPath}"\r\nC:\\Other\\npx.cmd\r\n`, "win32"),
    npxPath,
  );
  assert.equal(firstAbsoluteCommandPath("\r\n\r\n", "win32"), null);
  assert.equal(firstAbsoluteCommandPath("\r\nrelative\\npx.cmd\r\n", "win32"), null);

  assert.equal(
    findNpxAbsPath({
      platform: "win32",
      execPath: nodePath,
      pathExists: (candidate) => candidate === npxPath,
      execFileSyncFn: () => {
        throw new Error("same-directory npx.cmd should win");
      },
    }),
    npxPath,
  );

  let locatorCall;
  assert.equal(
    findNpxAbsPath({
      platform: "win32",
      execPath: nodePath,
      pathExists: () => false,
      execFileSyncFn: (command, args) => {
        locatorCall = { command, args };
        return `\r\n${npxPath}\r\nC:\\Other\\npx.cmd\r\n`;
      },
    }),
    npxPath,
  );
  assert.deepEqual(locatorCall, { command: "where.exe", args: ["npx"] });
});

function crashlyticsMcpConfig(env) {
  return JSON.stringify({
    mcpServers: {
      crashlytics: { command: "node", args: ["server.js"], env },
    },
  });
}

test("doctor evaluates the effective Crashlytics child env and fixture needs no ADC", async () => {
  const fixturePath = process.platform === "win32"
    ? "C:\\fixtures\\crashlytics.json"
    : "/fixtures/crashlytics.json";
  const inspection = await inspectCrashlyticsConfiguration({
    shellEnv: { HOME: "/shell-home" },
    mcpConfigText: crashlyticsMcpConfig({
      CRASHLYTICS_PROVIDER: "fixture",
      CRASHLYTICS_PROJECT_ALLOWLIST: "demo-project",
      CRASHLYTICS_APP_ALLOWLIST: "demo-project=demo-app",
      CRASHLYTICS_FIXTURE_PATH: fixturePath,
    }),
    fileExists: async (candidate) => candidate === fixturePath,
  });

  assert.equal(inspection.status, "valid");
  assert.equal(inspection.provider, "fixture");
  assert.ok(
    inspection.checks.some((check) =>
      check.kind === "ok" && /allowlists configured/.test(check.label)),
  );
  assert.ok(
    inspection.checks.some((check) =>
      check.kind === "ok" && /fixture path present/.test(check.label)),
  );
  assert.equal(
    inspection.checks.some((check) => check.kind === "warn" && /ADC/.test(check.label)),
    false,
  );
});

test("doctor honors empty child overrides instead of falling back to a green shell", async () => {
  const inspection = await inspectCrashlyticsConfiguration({
    shellEnv: {
      HOME: "/shell-home",
      CRASHLYTICS_PROJECT_ALLOWLIST: "shell-project",
      CRASHLYTICS_APP_ALLOWLIST: "shell-project=shell-app",
      GOOGLE_APPLICATION_CREDENTIALS: "/shell/adc.json",
    },
    mcpConfigText: crashlyticsMcpConfig({
      CRASHLYTICS_PROVIDER: "cloud_logging",
      CRASHLYTICS_PROJECT_ALLOWLIST: "",
      CRASHLYTICS_APP_ALLOWLIST: "",
      GOOGLE_APPLICATION_CREDENTIALS: "",
    }),
    fileExists: async (candidate) => candidate === "/shell/adc.json",
  });

  assert.ok(
    inspection.checks.some((check) =>
      check.kind === "warn" && /allowlists invalid or missing/.test(check.label)),
  );
  assert.ok(
    inspection.checks.some((check) =>
      check.kind === "warn" && /ADC not detected/.test(check.label)),
  );
});

test("doctor checks cloud_logging explicit/default ADC paths without reading them", async () => {
  const explicitPath = process.platform === "win32"
    ? "C:\\credentials\\adc.json"
    : "/credentials/adc.json";
  const baseEnv = {
    CRASHLYTICS_PROVIDER: "cloud_logging",
    CRASHLYTICS_PROJECT_ALLOWLIST: "demo-project",
    CRASHLYTICS_APP_ALLOWLIST: "demo-project=demo-app",
  };
  const explicit = await inspectCrashlyticsConfiguration({
    shellEnv: {},
    mcpConfigText: crashlyticsMcpConfig({
      ...baseEnv,
      GOOGLE_APPLICATION_CREDENTIALS: explicitPath,
    }),
    fileExists: async (candidate) => candidate === explicitPath,
  });
  assert.ok(
    explicit.checks.some((check) =>
      check.kind === "ok" && /ADC credential file configured/.test(check.label)),
  );

  const homeEnv = process.platform === "win32"
    ? { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" }
    : { HOME: "/home/tester" };
  const expectedDefault = process.platform === "win32"
    ? "C:\\Users\\tester\\AppData\\Roaming\\gcloud\\application_default_credentials.json"
    : "/home/tester/.config/gcloud/application_default_credentials.json";
  const defaults = await inspectCrashlyticsConfiguration({
    shellEnv: homeEnv,
    mcpConfigText: crashlyticsMcpConfig(baseEnv),
    fileExists: async (candidate) => candidate === expectedDefault,
  });
  assert.ok(
    defaults.checks.some((check) =>
      check.kind === "ok" && /ADC default credential present/.test(check.label)),
  );
});

test("doctor fails closed when project MCP configuration is invalid", async () => {
  const invalidConfigs = [
    "{not-json",
    "null",
    JSON.stringify({ mcpServers: [] }),
    JSON.stringify({ mcpServers: { crashlytics: { env: null } } }),
  ];
  for (const mcpConfigText of invalidConfigs) {
    const inspection = await inspectCrashlyticsConfiguration({
      shellEnv: {
        CRASHLYTICS_PROVIDER: "cloud_logging",
        CRASHLYTICS_PROJECT_ALLOWLIST: "shell-project",
        CRASHLYTICS_APP_ALLOWLIST: "shell-project=shell-app",
        GOOGLE_APPLICATION_CREDENTIALS: "/shell/adc.json",
      },
      mcpConfigText,
      fileExists: async () => true,
    });

    assert.equal(inspection.status, "invalid");
    assert.ok(
      inspection.checks.some((check) =>
        check.kind === "warn" && /configuration invalid/.test(check.label)),
    );
    assert.equal(inspection.checks.some((check) => check.kind === "ok"), false);
  }
});

test("install-skills keeps Codex project/global scopes isolated", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "app-test-install-skills-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const scriptsDir = path.join(root, "scripts");
  const skillDir = path.join(root, "skills", "fixture-skill");
  const fakeHome = path.join(root, "home");
  await Promise.all([
    mkdir(scriptsDir, { recursive: true }),
    mkdir(skillDir, { recursive: true }),
    mkdir(fakeHome, { recursive: true }),
  ]);
  const fixtureScript = path.join(scriptsDir, "install-skills.mjs");
  await copyFile(INSTALL_SKILLS_SCRIPT, fixtureScript);
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: fixture-skill\ndescription: fixture\n---\n\nFixture body.\n\n[Policy](references/policy.md)\n",
    "utf8",
  );
  await mkdir(path.join(skillDir, "agents"), { recursive: true });
  await mkdir(path.join(skillDir, "references"), { recursive: true });
  await writeFile(path.join(skillDir, "agents", "openai.yaml"), "display_name: Fixture\n", "utf8");
  await writeFile(path.join(skillDir, "references", "policy.md"), "# Fixture policy\n", "utf8");
  const env = { ...process.env, HOME: fakeHome };

  const projectOnly = spawnSync(
    process.execPath,
    [fixtureScript, "--client", "codex", "--project", "--force"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(
    projectOnly.status,
    0,
    `${projectOnly.stdout}\n${projectOnly.stderr}`,
  );
  const agentsPath = path.join(root, "AGENTS.md");
  const agentsBefore = await readFile(agentsPath, "utf8");
  assert.match(agentsBefore, /Fixture body\./);
  assert.match(agentsBefore, /\]\(skills\/fixture-skill\/references\/policy\.md\)/);
  assert.doesNotMatch(agentsBefore, /\]\(references\/policy\.md\)/);
  await assert.rejects(
    readFile(path.join(fakeHome, ".codex", "skills", "fixture-skill", "SKILL.md")),
    /ENOENT/,
  );

  const globalOnly = spawnSync(
    process.execPath,
    [fixtureScript, "--client", "codex", "--global", "--force"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(globalOnly.status, 0, `${globalOnly.stdout}\n${globalOnly.stderr}`);
  assert.match(
    await readFile(
      path.join(fakeHome, ".codex", "skills", "fixture-skill", "SKILL.md"),
      "utf8",
    ),
    /Fixture body\./,
  );
  assert.match(
    await readFile(
      path.join(fakeHome, ".codex", "skills", "fixture-skill", "agents", "openai.yaml"),
      "utf8",
    ),
    /Fixture/,
  );
  assert.match(
    await readFile(
      path.join(fakeHome, ".codex", "skills", "fixture-skill", "references", "policy.md"),
      "utf8",
    ),
    /policy/,
  );
  assert.equal(await readFile(agentsPath, "utf8"), agentsBefore);

  const conflicting = spawnSync(
    process.execPath,
    [fixtureScript, "--client", "codex", "--global", "--project", "--force"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(conflicting.status, 2);
  assert.match(conflicting.stderr, /互斥/);

  const wrongClientScope = spawnSync(
    process.execPath,
    [fixtureScript, "--client", "cursor", "--project", "--force"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(wrongClientScope.status, 2);
  assert.match(wrongClientScope.stderr, /只适用于/);

  const globalSkill = path.join(
    fakeHome,
    ".codex",
    "skills",
    "fixture-skill",
    "SKILL.md",
  );
  const victim = path.join(root, "victim.txt");
  await writeFile(victim, "do-not-overwrite", "utf8");
  await unlink(globalSkill);
  await symlink(victim, globalSkill);
  const symlinkOverwrite = spawnSync(
    process.execPath,
    [fixtureScript, "--client", "codex", "--global", "--force"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(symlinkOverwrite.status, 1);
  assert.match(symlinkOverwrite.stderr, /拒绝.*符号链接/);
  assert.equal(await readFile(victim, "utf8"), "do-not-overwrite");

  await unlink(globalSkill);
  await link(victim, globalSkill);
  const hardlinkOverwrite = spawnSync(
    process.execPath,
    [fixtureScript, "--client", "codex", "--global", "--force"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(hardlinkOverwrite.status, 1);
  assert.match(hardlinkOverwrite.stderr, /拒绝.*硬链接/);
  assert.equal(await readFile(victim, "utf8"), "do-not-overwrite");
});

test("install-skills synchronizes complete bundles without partial installs", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "app-test-skill-bundle-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const scriptsDir = path.join(root, "scripts");
  const skillDir = path.join(root, "skills", "fixture-skill");
  const referencesDir = path.join(skillDir, "references");
  const fakeHome = path.join(root, "home");
  await Promise.all([
    mkdir(scriptsDir, { recursive: true }),
    mkdir(referencesDir, { recursive: true }),
    mkdir(fakeHome, { recursive: true }),
  ]);
  const fixtureScript = path.join(scriptsDir, "install-skills.mjs");
  await copyFile(INSTALL_SKILLS_SCRIPT, fixtureScript);
  const sourceSkill = path.join(skillDir, "SKILL.md");
  await writeFile(
    sourceSkill,
    "---\nname: fixture-skill\ndescription: fixture\n---\n\n[Policy](references/policy.md)\n",
    "utf8",
  );
  await writeFile(path.join(referencesDir, "policy.md"), "# Policy v1\n", "utf8");
  const env = { ...process.env, HOME: fakeHome };

  const first = spawnSync(process.execPath, [fixtureScript, "--force"], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const targetDir = path.join(root, ".claude", "skills", "fixture-skill");
  await writeFile(path.join(targetDir, "references", "stale.md"), "stale\n", "utf8");
  await mkdir(path.join(targetDir, "assets"), { recursive: true });
  await writeFile(path.join(targetDir, "assets", "unknown.txt"), "unknown\n", "utf8");

  await writeFile(
    sourceSkill,
    "---\nname: fixture-skill\ndescription: fixture\n---\n\n[New](references/new.md)\n",
    "utf8",
  );
  await unlink(path.join(referencesDir, "policy.md"));
  await writeFile(path.join(referencesDir, "new.md"), "# Policy v2\n", "utf8");
  const synchronized = spawnSync(process.execPath, [fixtureScript, "--force"], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(synchronized.status, 0, `${synchronized.stdout}\n${synchronized.stderr}`);
  assert.match(await readFile(path.join(targetDir, "references", "new.md"), "utf8"), /v2/);
  await assert.rejects(readFile(path.join(targetDir, "references", "policy.md")), /ENOENT/);
  await assert.rejects(readFile(path.join(targetDir, "references", "stale.md")), /ENOENT/);
  await assert.rejects(readFile(path.join(targetDir, "assets", "unknown.txt")), /ENOENT/);

  // 即使 SKILL.md 尚不存在，只要 bundle 中任一目标冲突，非 force 也必须整项跳过。
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(path.join(targetDir, "references"), { recursive: true });
  const conflict = path.join(targetDir, "references", "keep.md");
  await writeFile(conflict, "keep\n", "utf8");
  const skipped = spawnSync(process.execPath, [fixtureScript], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(skipped.status, 0, `${skipped.stdout}\n${skipped.stderr}`);
  assert.match(skipped.stderr, /skip whole skill/);
  assert.equal(await readFile(conflict, "utf8"), "keep\n");
  await assert.rejects(readFile(path.join(targetDir, "SKILL.md")), /ENOENT/);

  // 源 bundle 不可信：预检发现 symlink 后，已有目标必须保持原样。
  const victim = path.join(root, "victim.txt");
  await writeFile(victim, "victim\n", "utf8");
  await symlink(victim, path.join(referencesDir, "unsafe.md"));
  const unsafeSource = spawnSync(process.execPath, [fixtureScript, "--force"], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(unsafeSource.status, 1);
  assert.match(unsafeSource.stderr, /不允许符号链接/);
  assert.equal(await readFile(conflict, "utf8"), "keep\n");

  await unlink(path.join(referencesDir, "unsafe.md"));
  await link(victim, path.join(referencesDir, "unsafe.md"));
  const hardlinkedSource = spawnSync(process.execPath, [fixtureScript, "--force"], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(hardlinkedSource.status, 1);
  assert.match(hardlinkedSource.stderr, /无硬链接的普通文件/);
  assert.equal(await readFile(conflict, "utf8"), "keep\n");

  await unlink(path.join(referencesDir, "unsafe.md"));
  let deep = referencesDir;
  for (let i = 0; i < 8; i++) {
    deep = path.join(deep, `depth-${i}`);
    await mkdir(deep);
  }
  const excessiveDepth = spawnSync(process.execPath, [fixtureScript, "--force"], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(excessiveDepth.status, 1);
  assert.match(excessiveDepth.stderr, /递归深度超过 8/);
  assert.equal(await readFile(conflict, "utf8"), "keep\n");
  await rm(path.join(referencesDir, "depth-0"), { recursive: true, force: true });

  const manyDirectories = path.join(referencesDir, "many-directories");
  await mkdir(manyDirectories);
  await Promise.all(
    Array.from({ length: 65 }, (_, i) => mkdir(path.join(manyDirectories, `dir-${i}`))),
  );
  const excessiveDirectories = spawnSync(process.execPath, [fixtureScript, "--force"], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(excessiveDirectories.status, 1);
  assert.match(excessiveDirectories.stderr, /目录数超过 64/);
  assert.equal(await readFile(conflict, "utf8"), "keep\n");
});

test("install-skills gives Cursor references and Claude Desktop a full bundle manifest", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "app-test-client-bundle-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const scriptsDir = path.join(root, "scripts");
  const skillDir = path.join(root, "skills", "fixture-skill");
  const referencesDir = path.join(skillDir, "references");
  const fakeHome = path.join(root, "home");
  await Promise.all([
    mkdir(scriptsDir, { recursive: true }),
    mkdir(referencesDir, { recursive: true }),
    mkdir(fakeHome, { recursive: true }),
  ]);
  const fixtureScript = path.join(scriptsDir, "install-skills.mjs");
  await copyFile(INSTALL_SKILLS_SCRIPT, fixtureScript);
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: fixture-skill\ndescription: fixture\n---\n\nRead [policy](references/policy.md).\n",
    "utf8",
  );
  await writeFile(path.join(referencesDir, "policy.md"), "# Fixture policy\n", "utf8");
  const env = { ...process.env, HOME: fakeHome };

  const cursor = spawnSync(
    process.execPath,
    [fixtureScript, "--client", "cursor", "--force"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(cursor.status, 0, `${cursor.stdout}\n${cursor.stderr}`);
  const rule = path.join(root, ".cursor", "rules", "fixture-skill.mdc");
  const cursorReference = path.join(
    root,
    ".cursor",
    "rules",
    "fixture-skill",
    "references",
    "policy.md",
  );
  assert.match(
    await readFile(rule, "utf8"),
    /\]\(\.\/fixture-skill\/references\/policy\.md\)/,
  );
  assert.match(await readFile(cursorReference, "utf8"), /Fixture policy/);

  // force 同步必须清理 Cursor supporting bundle 中的未知旧文件。
  const stale = path.join(root, ".cursor", "rules", "fixture-skill", "references", "stale.md");
  await writeFile(stale, "stale\n", "utf8");
  const cursorSync = spawnSync(
    process.execPath,
    [fixtureScript, "--client", "cursor", "--force"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(cursorSync.status, 0, `${cursorSync.stdout}\n${cursorSync.stderr}`);
  await assert.rejects(readFile(stale), /ENOENT/);

  // 单独残留 supporting bundle 时，默认模式不得只补写 .mdc 形成半安装。
  await unlink(rule);
  const cursorSkipped = spawnSync(
    process.execPath,
    [fixtureScript, "--client", "cursor"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(cursorSkipped.status, 0, `${cursorSkipped.stdout}\n${cursorSkipped.stderr}`);
  assert.match(cursorSkipped.stderr, /skip whole rule/);
  await assert.rejects(readFile(rule), /ENOENT/);
  assert.match(await readFile(cursorReference, "utf8"), /Fixture policy/);

  const desktop = spawnSync(
    process.execPath,
    [fixtureScript, "--client", "claude-desktop"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(desktop.status, 0, `${desktop.stdout}\n${desktop.stderr}`);
  assert.match(desktop.stdout, /不会自动安装/);
  assert.match(desktop.stdout, /bundle 不完整，不应声称可直接运行/);
  assert.match(desktop.stdout, /references[/\\]policy\.md/);
});

test("setup-mcp safely renders unusual paths and fails closed on OpenCode conflicts", async (t) => {
  // ESM entry URLs reject literal backslashes in a POSIX filename, while Windows
  // rejects quotes. Those characters are covered by the pure expansion test above;
  // this spawned integration fixture uses a portable path containing spaces.
  const root = await mkdtemp(path.join(tmpdir(), "app-test-setup-path with spaces-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const scriptsDir = path.join(root, "scripts");
  const fakeHome = path.join(root, "home");
  const fakeAppData = path.join(fakeHome, "AppData", "Roaming");
  await Promise.all([
    mkdir(scriptsDir, { recursive: true }),
    mkdir(fakeHome, { recursive: true }),
  ]);
  const fixtureScript = path.join(scriptsDir, "setup-mcp.mjs");
  await copyFile(SETUP_MCP_SCRIPT, fixtureScript);
  await copyFile(path.join(HERE, "..", ".mcp.json.example"), path.join(root, ".mcp.json.example"));
  const env = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    APPDATA: fakeAppData,
  };

  const generated = spawnSync(process.execPath, [fixtureScript, "--force"], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(generated.status, 0, `${generated.stdout}\n${generated.stderr}`);
  const projectConfig = JSON.parse(await readFile(path.join(root, ".mcp.json"), "utf8"));
  const canonicalRoot = await realpath(root);
  assert.equal(
    path.normalize(projectConfig.mcpServers.crashlytics.args[0]),
    path.join(canonicalRoot, "mcp-servers", "crashlytics-mcp", "dist", "index.js"),
  );

  const desktop = spawnSync(
    process.execPath,
    [fixtureScript, "--client", "claude-desktop"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(desktop.status, 0, `${desktop.stdout}\n${desktop.stderr}`);
  const jsonStart = desktop.stdout.indexOf("{");
  assert.ok(jsonStart >= 0);
  const desktopConfig = JSON.parse(desktop.stdout.slice(jsonStart));
  for (const server of Object.values(desktopConfig.mcpServers)) {
    assert.ok(path.isAbsolute(server.command), `expected absolute command: ${server.command}`);
  }

  const openCodePath = process.platform === "win32"
    ? path.join(fakeAppData, "opencode", "opencode.json")
    : path.join(fakeHome, ".config", "opencode", "opencode.json");
  await mkdir(path.dirname(openCodePath), { recursive: true });
  const invalidConfigs = [
    "not-json\n",
    "null\n",
    "[]\n",
    `${JSON.stringify({ mcp: [] })}\n`,
    `${JSON.stringify({ mcp: "invalid" })}\n`,
  ];
  for (const invalidConfig of invalidConfigs) {
    await writeFile(openCodePath, invalidConfig, "utf8");
    const invalid = spawnSync(
      process.execPath,
      [fixtureScript, "--client", "opencode", "--force"],
      { env, encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /refusing to overwrite invalid existing OpenCode config/);
    assert.equal(await readFile(openCodePath, "utf8"), invalidConfig);
  }

  const collidingConfig = JSON.stringify({
    theme: "dark",
    mcp: {
      log: { owner: "user" },
      custom: { type: "remote", url: "https://example.invalid/mcp" },
    },
  });
  await writeFile(openCodePath, collidingConfig, "utf8");
  const collision = spawnSync(
    process.execPath,
    [fixtureScript, "--client", "opencode"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(collision.status, 1);
  assert.match(collision.stderr, /entries already exist: log/);
  assert.equal(await readFile(openCodePath, "utf8"), collidingConfig);

  const forced = spawnSync(
    process.execPath,
    [fixtureScript, "--client", "opencode", "--force"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(forced.status, 0, `${forced.stdout}\n${forced.stderr}`);
  const merged = JSON.parse(await readFile(openCodePath, "utf8"));
  assert.equal(merged.theme, "dark");
  assert.deepEqual(merged.mcp.custom, {
    type: "remote",
    url: "https://example.invalid/mcp",
  });
  assert.equal(merged.mcp.log.owner, undefined);
  assert.equal(merged.mcp.log.type, "local");
  assert.ok(Array.isArray(merged.mcp.log.command));
});

async function writeExecutable(file, content) {
  await writeFile(file, content, { mode: 0o700 });
  await chmod(file, 0o700);
}

async function makeMockEnvironment({ runner = "reliable", curlReady = true, wrapper = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "app-test-tooling-"));
  const bin = path.join(root, "bin");
  const runtime = path.join(root, "runtime");
  const logs = path.join(root, "logs");
  await Promise.all([
    mkdir(bin, { mode: 0o700 }),
    mkdir(runtime, { mode: 0o700 }),
    mkdir(logs, { mode: 0o700 }),
  ]);

  const trace = path.join(root, "ios.trace");
  const runwdaPid = path.join(root, "runwda.pid");
  const runwdaWorkerPid = path.join(root, "runwda-worker.pid");
  const forwardLauncherPid = path.join(root, "forward-launcher.pid");
  const forwardPid = path.join(root, "forward.pid");

  await writeExecutable(path.join(bin, "idevice_id"), `#!/usr/bin/env bash
printf '%s\\n' "$MOCK_UDID"
printf '%s\\n' 'mock diagnostic on stderr' >&2
`);

  await writeExecutable(path.join(bin, "ideviceinfo"), `#!/usr/bin/env bash
printf '%s\\n' '16.6'
`);

  await writeExecutable(path.join(bin, "ideviceinstaller"), `#!/usr/bin/env bash
case "$MOCK_RUNNER_KIND" in
  reliable) printf '%s, 1, WebDriverAgentRunner-Runner\\n' "$MOCK_WDA_BUNDLE" ;;
  generic) printf '%s\\n' 'com.example.OtherUITests.xctrunner, 1, OtherUITests' ;;
  none) : ;;
esac
`);

  await writeExecutable(path.join(bin, "ios"), `#!/usr/bin/env bash
printf '%s %s\\n' "$$" "$*" >>"$MOCK_TRACE"
case "\${1:-}" in
  runwda)
    printf '%s\\n' "$$" >"$MOCK_RUNWDA_PID"
    worker_file="$MOCK_RUNWDA_WORKER_PID"
    ;;
  forward)
    printf '%s\\n' "$$" >"$MOCK_FORWARD_LAUNCHER_PID"
    worker_file="$MOCK_FORWARD_PID"
    ;;
  *) exit 2 ;;
esac
child_pid=""
trap '[[ -z "$child_pid" ]] || kill "$child_pid" 2>/dev/null || true; exit 0' INT TERM
if [[ "$MOCK_WRAPPER" == "1" ]]; then
  /bin/bash -c '
    printf "%s\\n" "$$" >"$1"
    trap "exit 0" INT TERM
    while :; do sleep 1; done
  ' mock-worker "$worker_file" &
  child_pid=$!
  wait "$child_pid" || true
  exit 0
fi
printf '%s\\n' "$$" >"$worker_file"
while :; do
  sleep 1 &
  child_pid=$!
  wait "$child_pid" || true
done
`);

  await writeExecutable(path.join(bin, "curl"), `#!/usr/bin/env bash
if [[ "$MOCK_CURL_READY" == "1" && -s "$MOCK_FORWARD_PID" ]]; then
  printf '%s\\n' '{"value":{"ready":true}}'
  exit 0
fi
exit 7
`);

  await writeExecutable(path.join(bin, "lsof"), `#!/usr/bin/env bash
if [[ " $* " == *" -tiTCP:8100 "* ]]; then
  if [[ -n "\${MOCK_LISTENER_PID:-}" ]]; then
    printf '%s\\n' "$MOCK_LISTENER_PID"
  elif [[ -s "$MOCK_FORWARD_PID" ]]; then
    listener_pid="$(cat "$MOCK_FORWARD_PID")"
    kill -0 "$listener_pid" 2>/dev/null && printf '%s\\n' "$listener_pid"
  fi
  exit 0
fi
if [[ " $* " == *" -d txt "* ]]; then
  printf 'p%s\\nn%s\\n' "\${MOCK_LISTENER_PID:-0}" "$MOCK_PROCESS_EXECUTABLE"
  exit 0
fi
exit 0
`);

  await writeExecutable(path.join(bin, "ps"), `#!/usr/bin/env bash
args=" $* "
if [[ "$args" == *" -axo pid=,ppid= "* ]]; then
  if [[ "$MOCK_WRAPPER" == "1" && -s "$MOCK_FORWARD_PID" && -s "$MOCK_FORWARD_LAUNCHER_PID" ]]; then
    printf '%s %s\\n' "$(cat "$MOCK_FORWARD_PID")" "$(cat "$MOCK_FORWARD_LAUNCHER_PID")"
  fi
  if [[ "$MOCK_WRAPPER" == "1" && -s "$MOCK_RUNWDA_WORKER_PID" && -s "$MOCK_RUNWDA_PID" ]]; then
    printf '%s %s\\n' "$(cat "$MOCK_RUNWDA_WORKER_PID")" "$(cat "$MOCK_RUNWDA_PID")"
  fi
  exit 0
fi
pid=""
previous=""
for arg in "$@"; do
  [[ "$previous" == "-p" ]] && pid="$arg"
  previous="$arg"
done
if [[ "$args" == *" uid= "* ]]; then
  printf '%s\\n' "$MOCK_UID"
elif [[ "$args" == *" ppid= "* ]]; then
  if [[ "$MOCK_WRAPPER" == "1" && -s "$MOCK_FORWARD_PID" && "$pid" == "$(cat "$MOCK_FORWARD_PID")" && -s "$MOCK_FORWARD_LAUNCHER_PID" ]]; then
    cat "$MOCK_FORWARD_LAUNCHER_PID"
  elif [[ "$MOCK_WRAPPER" == "1" && -s "$MOCK_RUNWDA_WORKER_PID" && "$pid" == "$(cat "$MOCK_RUNWDA_WORKER_PID")" && -s "$MOCK_RUNWDA_PID" ]]; then
    cat "$MOCK_RUNWDA_PID"
  else
    printf '%s\\n' '1'
  fi
elif [[ "$args" == *" lstart= "* ]]; then
  printf 'Mon Jul 28 12:34:56 2026 pid-%s\\n' "$pid"
elif [[ "$args" == *" command= "* ]]; then
  printf '%s %s\\n' "$MOCK_PROCESS_EXECUTABLE" "$pid"
else
  exit 1
fi
`);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TMPDIR: runtime,
    WDA_LOG_DIR: logs,
    MOCK_UDID: VALID_UDID,
    MOCK_WDA_BUNDLE: WDA_BUNDLE,
    MOCK_RUNNER_KIND: runner,
    MOCK_CURL_READY: curlReady ? "1" : "0",
    MOCK_TRACE: trace,
    MOCK_RUNWDA_PID: runwdaPid,
    MOCK_RUNWDA_WORKER_PID: runwdaWorkerPid,
    MOCK_FORWARD_LAUNCHER_PID: forwardLauncherPid,
    MOCK_FORWARD_PID: forwardPid,
    MOCK_IOS_PATH: path.join(bin, "ios"),
    MOCK_PROCESS_EXECUTABLE: process.execPath,
    MOCK_UID: String(process.getuid()),
    MOCK_WRAPPER: wrapper ? "1" : "0",
  };

  return {
    root,
    bin,
    runtime,
    logs,
    trace,
    runwdaPid,
    runwdaWorkerPid,
    forwardLauncherPid,
    forwardPid,
    env,
  };
}

function runWda(env, timeout = 30_000, args = []) {
  return spawnSync("/bin/bash", [WDA_SCRIPT, ...args], {
    env,
    encoding: "utf8",
    timeout,
  });
}

async function waitForProcessExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch {
      return;
    }
  }
  assert.fail(`process ${pid} did not exit within ${timeoutMs}ms`);
}

async function stopRecordedProcesses(...pidFiles) {
  for (const file of pidFiles) {
    let pid;
    try {
      pid = Number((await readFile(file, "utf8")).trim());
    } catch {
      continue;
    }
    if (!Number.isInteger(pid) || pid <= 1) continue;
    try { process.kill(pid, "SIGTERM"); } catch {}
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        pid = null;
        break;
      }
    }
    if (pid) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
}

async function withMockEnvironment(options, fn) {
  const mock = await makeMockEnvironment(options);
  try {
    await fn(mock);
  } finally {
    await stopRecordedProcesses(
      mock.forwardPid,
      mock.forwardLauncherPid,
      mock.runwdaWorkerPid,
      mock.runwdaPid,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(mock.root, { recursive: true, force: true });
  }
}

test("ios-wda keeps stderr out of UDIDs and creates private unique logs", async () => {
  await withMockEnvironment({}, async (mock) => {
    const result = runWda(mock.env);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`目标设备：${VALID_UDID}`));
    assert.match(result.stderr, /mock diagnostic on stderr/);

    const runDirs = await readdir(mock.logs);
    assert.equal(runDirs.length, 1);
    assert.match(runDirs[0], /^app-test-ctrl-wda\./);
    const privateDir = path.join(mock.logs, runDirs[0]);
    const dirStat = await lstat(privateDir);
    assert.equal(dirStat.isDirectory(), true);
    assert.equal(dirStat.isSymbolicLink(), false);
    assert.equal(dirStat.mode & 0o777, 0o700);

    const logFiles = await readdir(privateDir);
    assert.equal(logFiles.length, 2);
    for (const name of logFiles) {
      const fileStat = await lstat(path.join(privateDir, name));
      assert.equal(fileStat.isFile(), true);
      assert.equal(fileStat.isSymbolicLink(), false);
      assert.equal(fileStat.mode & 0o777, 0o600);
    }

    const trace = await readFile(mock.trace, "utf8");
    assert.match(trace, new RegExp(`runwda --udid=${VALID_UDID}`));
    assert.match(trace, new RegExp(`--bundleid=${WDA_BUNDLE}`));
    assert.match(trace, new RegExp(`forward 8100 8100 --udid=${VALID_UDID}`));
  });
});

test("ios-wda refuses an unverified generic xctrunner", async () => {
  await withMockEnvironment({ runner: "generic", curlReady: false }, async (mock) => {
    const result = runWda(mock.env);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /没有任何候选具备可靠 WDA 身份/);
    await assert.rejects(readFile(mock.trace, "utf8"), /ENOENT/);
  });
});

test("ios-wda rejects malformed device-list data before process matching", async () => {
  await withMockEnvironment({}, async (mock) => {
    const result = runWda({ ...mock.env, MOCK_UDID: "warning-from-stdout" });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /返回了非法 UDID/);
    await assert.rejects(readFile(mock.trace, "utf8"), /ENOENT/);
  });
});

test("ios-wda refuses a symlink log parent", async () => {
  await withMockEnvironment({}, async (mock) => {
    const realLogs = path.join(mock.root, "real-logs");
    const linkLogs = path.join(mock.root, "linked-logs");
    await mkdir(realLogs, { mode: 0o700 });
    await symlink(realLogs, linkLogs);
    const result = runWda({ ...mock.env, WDA_LOG_DIR: linkLogs });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /WDA_LOG_DIR 不能是符号链接/);
    await assert.rejects(readFile(mock.trace, "utf8"), /ENOENT/);
  });
});

test("ios-wda serializes concurrent starts with a per-port lock", async () => {
  await withMockEnvironment({}, async (mock) => {
    const stateDir = path.join(mock.runtime, `app-test-ctrl-wda-state-${process.getuid()}`);
    await mkdir(stateDir, { mode: 0o700 });
    await mkdir(path.join(stateDir, "port-8100.lock"), { mode: 0o700 });
    const result = runWda(mock.env);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /另一个 WDA 启动流程/);
    await assert.rejects(readFile(mock.trace, "utf8"), /ENOENT/);
  });
});

test("ios-wda managed stop refuses a symlink state file", async () => {
  await withMockEnvironment({}, async (mock) => {
    const stateDir = path.join(mock.runtime, `app-test-ctrl-wda-state-${process.getuid()}`);
    await mkdir(stateDir, { mode: 0o700 });
    const victim = path.join(mock.root, "state-victim");
    await writeFile(victim, "not-managed-state\n", { mode: 0o600 });
    await symlink(victim, path.join(stateDir, "port-8100.state"));

    const result = runWda(mock.env, 10_000, ["--stop"]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /托管状态文件不安全/);
    assert.equal(await readFile(victim, "utf8"), "not-managed-state\n");
  });
});

test("ios-wda never kills an unknown listener without managed state", async () => {
  await withMockEnvironment({ curlReady: false }, async (mock) => {
    const sleeper = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    try {
      const result = runWda({ ...mock.env, MOCK_LISTENER_PID: String(sleeper.pid) });
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /未知进程或另一台设备占用/);
      assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
    } finally {
      try { sleeper.kill("SIGTERM"); } catch {}
    }
  });
});

test("ios-wda reuses an npm-style wrapper whose listener is a child process", async () => {
  await withMockEnvironment({ wrapper: true }, async (mock) => {
    assert.notEqual(mock.env.MOCK_PROCESS_EXECUTABLE, mock.env.MOCK_IOS_PATH);

    const first = runWda(mock.env);
    assert.equal(first.error, undefined);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);

    const launcherPid = Number((await readFile(mock.forwardLauncherPid, "utf8")).trim());
    const listenerPid = Number((await readFile(mock.forwardPid, "utf8")).trim());
    assert.notEqual(listenerPid, launcherPid);

    const traceBefore = await readFile(mock.trace, "utf8");
    assert.equal(traceBefore.trim().split("\n").length, 2);

    const second = runWda(mock.env);
    assert.equal(second.error, undefined);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.match(second.stdout, /无需重复拉起/);

    const traceAfter = await readFile(mock.trace, "utf8");
    assert.equal(traceAfter, traceBefore, "幂等复用不应再启动 runwda/forward");
  });
});

test("ios-wda managed stop rejects hard-linked state then stops wrapper trees", async () => {
  await withMockEnvironment({ wrapper: true }, async (mock) => {
    const first = runWda(mock.env);
    assert.equal(first.error, undefined);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assert.match(first.stdout, /ios-wda-up\.sh --stop/);

    const stateDir = path.join(mock.runtime, `app-test-ctrl-wda-state-${process.getuid()}`);
    const stateFile = path.join(stateDir, "port-8100.state");
    const originalState = await readFile(stateFile, "utf8");
    const extraLink = path.join(mock.root, "state-hardlink");
    await link(stateFile, extraLink);

    const refused = runWda(mock.env, 10_000, ["--stop"]);
    assert.equal(refused.status, 1, `${refused.stdout}\n${refused.stderr}`);
    assert.match(refused.stderr, /hard links are not allowed/);

    const launcherPids = await Promise.all([
      mock.forwardLauncherPid,
      mock.runwdaPid,
    ].map(async (file) => Number((await readFile(file, "utf8")).trim())));
    for (const pid of launcherPids) {
      assert.doesNotThrow(() => process.kill(pid, 0), "拒绝不安全状态时不得停止进程");
    }

    await unlink(extraLink);
    const stateLines = originalState.trimEnd().split("\n");
    stateLines[4] = "0".repeat(64);
    await writeFile(stateFile, `${stateLines.join("\n")}\n`, "utf8");
    const reusedPidRefused = runWda(mock.env, 10_000, ["--stop"]);
    assert.equal(reusedPidRefused.status, 1);
    assert.match(reusedPidRefused.stderr, /身份不匹配/);
    for (const pid of launcherPids) {
      assert.doesNotThrow(
        () => process.kill(pid, 0),
        "任一身份不匹配时都应在发信号前整体中止",
      );
    }
    await writeFile(stateFile, originalState, "utf8");

    const workerPids = await Promise.all([
      mock.forwardPid,
      mock.runwdaWorkerPid,
    ].map(async (file) => Number((await readFile(file, "utf8")).trim())));

    const stopped = runWda(mock.env, 10_000, ["--stop"]);
    assert.equal(stopped.error, undefined);
    assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
    assert.match(stopped.stdout, /已安全停止/);
    await assert.rejects(readFile(stateFile, "utf8"), /ENOENT/);

    for (const pid of [...launcherPids, ...workerPids]) {
      await waitForProcessExit(pid);
    }
  });
});
