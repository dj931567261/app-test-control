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
  doctorClientConfigCandidates,
  inspectBuildRunnerConfiguration,
  inspectCrashlyticsConfiguration,
  inspectOfficialFirebaseConfiguration,
  isEnoent,
  isValidDeviceUdid,
  isWdaReadyJson,
  looksLikeCliHelp,
  loadDoctorMcpConfiguration,
  sanitizeDiagnostic,
} from "./doctor.mjs";
import {
  expandTemplateValue,
  findNodeAbsPath,
  findNpxAbsPath,
  firstAbsoluteCommandPath,
} from "./setup-mcp.mjs";
import {
  FIREBASE_MANAGED_ENV,
  FIREBASE_MANAGED_OWNER_ENV,
  FIREBASE_MANAGED_VALUE,
  FIREBASE_MCP_STARTUP_TIMEOUT_SEC,
  OFFICIAL_FIREBASE_READ_TOOLS,
  buildCodexOfficialFirebaseServer,
  buildOfficialFirebaseServer,
  inspectOfficialFirebaseServer,
  officialFirebaseOwnerSha256,
} from "./firebase-mcp-config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WDA_SCRIPT = path.join(HERE, "ios-wda-up.sh");
const INSTALL_SKILLS_SCRIPT = path.join(HERE, "install-skills.mjs");
const SETUP_MCP_SCRIPT = path.join(HERE, "setup-mcp.mjs");
const FIREBASE_MCP_CONFIG_HELPER = path.join(HERE, "firebase-mcp-config.mjs");
const BUILD_RUNNER_ENTRY = path.join(
  HERE,
  "..",
  "mcp-servers",
  "build-runner-mcp",
  "dist",
  "index.js",
);
const VALID_UDID = "00008030-0011223344556677";
const WDA_BUNDLE = "com.example.wda.runner.xctrunner";

async function collectTestFiles(directory, suffix, prefix = "") {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await collectTestFiles(
        path.join(directory, entry.name),
        suffix,
        relativeName,
      ));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      files.push(relativeName);
    }
  }
  return files;
}

function tomlServerSection(text, serverName) {
  const marker = `[mcp_servers.${serverName}]`;
  const start = text.indexOf(marker);
  assert.ok(start >= 0, `missing TOML section ${marker}`);
  const remainder = text.slice(start + marker.length);
  const next = remainder.search(/\n\[mcp_servers\.[^\]]+\]/);
  return next < 0 ? remainder : remainder.slice(0, next);
}

function tomlJsonString(section, key) {
  const match = section.match(new RegExp(`^${key}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")\\s*$`, "m"));
  assert.ok(match, `missing TOML string ${key}`);
  return JSON.parse(match[1]);
}

function codexTomlConfig(servers) {
  const lines = [];
  for (const [name, entry] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${name}]`);
    if (typeof entry.enabled === "boolean") lines.push(`enabled = ${entry.enabled}`);
    lines.push(`command = ${JSON.stringify(entry.command)}`);
    lines.push(`args = ${JSON.stringify(entry.args)}`);
    if (typeof entry.cwd === "string") lines.push(`cwd = ${JSON.stringify(entry.cwd)}`);
    if (Number.isSafeInteger(entry.startup_timeout_sec)) {
      lines.push(`startup_timeout_sec = ${entry.startup_timeout_sec}`);
    }
    if (Array.isArray(entry.env_vars)) {
      lines.push(`env_vars = ${JSON.stringify(entry.env_vars)}`);
    }
    if (Array.isArray(entry.enabled_tools)) {
      lines.push(`enabled_tools = ${JSON.stringify(entry.enabled_tools)}`);
    }
    if (entry.env && Object.keys(entry.env).length > 0) {
      const environment = Object.entries(entry.env)
        .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
        .join(", ");
      lines.push(`env = { ${environment} }`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function loadCodexLayerFixture({ globalText, projectText }) {
  const root = "/tmp/app-test-ctrl-owner";
  const home = "/tmp/codex-home";
  const candidates = doctorClientConfigCandidates("codex", {
    root,
    home,
    platform: "linux",
  });
  const contents = new Map();
  for (const { configPath, scope } of candidates) {
    const text = scope === "global" ? globalText : projectText;
    if (text !== undefined) contents.set(configPath, text);
  }
  const missing = () => Object.assign(new Error("missing fixture"), { code: "ENOENT" });
  const loaded = await loadDoctorMcpConfiguration("codex", {
    root,
    home,
    platform: "linux",
    fileStat: async (candidate) => {
      if (!contents.has(candidate)) throw missing();
      return {
        isFile: () => true,
        size: Buffer.byteLength(contents.get(candidate), "utf8"),
      };
    },
    fileRead: async (candidate) => {
      if (!contents.has(candidate)) throw missing();
      return contents.get(candidate);
    },
  });
  return { loaded, root, home, candidates };
}

test("doctor strictly accepts only boolean ready=true", () => {
  assert.equal(isWdaReadyJson('{"value":{"ready":true}}'), true);
  assert.equal(isWdaReadyJson('{"ready":true}'), true);
  assert.equal(isWdaReadyJson('{"value":{"ready":"true"}}'), false);
  assert.equal(isWdaReadyJson('{"sessionId":"abc","state":"success"}'), false);
  assert.equal(isWdaReadyJson("not-json"), false);
});

test("root test:unit manifest includes every repository unit test exactly once", async () => {
  const root = path.resolve(HERE, "..");
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const command = manifest?.scripts?.["test:unit"];
  assert.equal(typeof command, "string");
  const listed = command
    .split(/\s+/u)
    .filter((token) => token.endsWith(".test.ts") || token.endsWith(".test.mjs"))
    .sort();
  assert.equal(new Set(listed).size, listed.length, "test:unit must not list a test twice");

  const scriptTests = (await collectTestFiles(path.join(root, "scripts"), ".test.mjs"))
    .map((name) => `scripts/${name}`);
  const serverTests = (await collectTestFiles(path.join(root, "mcp-servers"), ".test.ts"))
    .map((name) => `mcp-servers/${name}`);
  const expected = [...scriptTests, ...serverTests].sort();
  assert.deepEqual(listed, expected);
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

test("doctor inherits a global Codex firebase server when project config omits it", async () => {
  const globalFirebase = {
    command: "/usr/bin/node",
    args: ["/global/firebase-gateway.js", "--project-source", "firebaserc", "--dir", "/app"],
  };
  const { loaded, root, home, candidates } = await loadCodexLayerFixture({
    globalText: codexTomlConfig({
      firebase: globalFirebase,
      report: { command: "/usr/bin/node", args: ["/global/report.js"] },
    }),
    projectText: codexTomlConfig({
      log: { command: "/usr/bin/node", args: ["/project/log.js"] },
    }),
  });
  assert.deepEqual(
    candidates,
    [
      {
        configPath: path.posix.join(home, ".codex", "config.toml"),
        scope: "global",
      },
      {
        configPath: path.posix.join(root, ".codex", "config.toml"),
        scope: "project",
      },
    ],
  );
  assert.equal(loaded.mcpConfigReadError, undefined);
  assert.equal(loaded.configScope, "merged(global→project)");
  const servers = JSON.parse(loaded.mcpConfigText).mcpServers;
  assert.deepEqual(servers.firebase, globalFirebase);
  assert.deepEqual(servers.log.args, ["/project/log.js"]);
  assert.deepEqual(servers.report.args, ["/global/report.js"]);
});

test("doctor applies project Codex overrides per MCP server key", async () => {
  const { loaded } = await loadCodexLayerFixture({
    globalText: codexTomlConfig({
      log: { command: "/usr/bin/node", args: ["/global/log.js"] },
      report: { command: "/usr/bin/node", args: ["/global/report.js"] },
    }),
    projectText: codexTomlConfig({
      log: { command: "/usr/bin/node", args: ["/project/log.js"] },
    }),
  });
  assert.equal(loaded.mcpConfigReadError, undefined);
  const servers = JSON.parse(loaded.mcpConfigText).mcpServers;
  assert.deepEqual(servers.log.args, ["/project/log.js"]);
  assert.deepEqual(servers.report.args, ["/global/report.js"]);
});

test("doctor rejects a shadowed global Codex service-account profile", async () => {
  const projectRoot = "/tmp/app-test-ctrl-owner";

  const firebaseDir = "/tmp/firebase-app";
  const serviceAccountPath = "/tmp/service-account.json";
  const globalFirebase = buildCodexOfficialFirebaseServer(
    buildOfficialFirebaseServer(firebaseDir, {
      projectRoot,
      nodeCommand: process.execPath,
      platform: "linux",
      projectSource: "service-account",
      firebaseProjectId: "fixture-project-1",
      serviceAccountPath,
    }),
    projectRoot,
    { nodeCommand: process.execPath, platform: "linux" },
  );
  const projectFirebase = buildCodexOfficialFirebaseServer(
    buildOfficialFirebaseServer(firebaseDir, {
      projectRoot,
      nodeCommand: process.execPath,
      platform: "linux",
      projectSource: "firebaserc",
    }),
    projectRoot,
    { nodeCommand: process.execPath, platform: "linux" },
  );
  const { loaded } = await loadCodexLayerFixture({
    globalText: codexTomlConfig({ firebase: globalFirebase }),
    projectText: codexTomlConfig({ firebase: projectFirebase }),
  });
  assert.equal(loaded.mcpConfigReadError, undefined);
  const effectiveFirebase = JSON.parse(loaded.mcpConfigText).mcpServers.firebase;
  assert.ok(effectiveFirebase.args.includes("firebaserc"));
  assert.equal(effectiveFirebase.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);

  const inspection = await inspectOfficialFirebaseConfiguration({
    mcpConfigText: loaded.mcpConfigText,
    codexGlobalMcpConfigText: loaded.codexGlobalMcpConfigText,
    expectedProjectRoot: projectRoot,
    client: "codex",
    configScope: loaded.configScope,
    platform: "linux",
    fileStat: async () => assert.fail("shadowed global credential must fail before runtime probing"),
    fileRead: async () => assert.fail("shadowed global credential must fail before file reads"),
  });
  assert.equal(inspection.status, "invalid");
  assert.equal(inspection.configured, false);
  assert.equal(inspection.projectSource, "service-account");
  assert.ok(inspection.checks.some((check) => (
    check.label === "Codex global service-account Profile is invalid"
  )));
  assert.equal(inspection.checks.some((check) => check.kind === "ok"), false);
  assert.equal(JSON.stringify(inspection).includes(serviceAccountPath), false);
});

test("doctor fails closed when either Codex configuration layer is unsafe", async () => {
  const valid = codexTomlConfig({
    log: { command: "/usr/bin/node", args: ["/valid/log.js"] },
  });
  const invalid = "[mcp_servers.firebase]\ncommand = \"/usr/bin/node\"\nargs = [\n";
  for (const fixture of [
    { globalText: invalid, projectText: valid },
    { globalText: valid, projectText: invalid },
  ]) {
    const { loaded } = await loadCodexLayerFixture(fixture);
    assert.equal(loaded.mcpConfigText, undefined);
    assert.ok(loaded.mcpConfigReadError instanceof Error);
    assert.equal(loaded.mcpConfigReadError.message.includes("/tmp/"), false);
  }
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

function buildRunnerMcpConfig(env, entry = BUILD_RUNNER_ENTRY) {
  return JSON.stringify({
    mcpServers: {
      "build-runner": { command: "node", args: [entry], env },
    },
  });
}

function readyLocalTrustedCapability(overrides = {}) {
  return {
    schema_version: "build-runner-capabilities/v2",
    available: true,
    backend: "local_trusted",
    execution_profile: "local_trusted",
    local_trusted_execution_eligible: true,
    auto_patch_eligible: false,
    strong_isolation: false,
    network_policy: "not_enforced",
    workspace_disk_quota: { enforced: false, mechanism: "none" },
    filesystem_write_isolation: "not_enforced",
    secret_environment_isolation: "allowlist",
    secret_filesystem_isolation: "not_enforced",
    process_containment: "process_group_best_effort",
    project_trust_required: true,
    requires_explicit_trust: true,
    requires_per_run_approval: true,
    cache_mode: "sealed_seed_disposable_copy",
    verification_level: "trusted_local",
    max_command_seconds: 60,
    reasons: [],
    ...overrides,
  };
}

function readyDockerCapability(overrides = {}) {
  return {
    schema_version: "build-runner-capabilities/v2",
    available: true,
    backend: "docker",
    execution_profile: "docker_strict",
    local_trusted_execution_eligible: false,
    auto_patch_eligible: true,
    strong_isolation: true,
    network_policy: "denied",
    workspace_disk_quota: { enforced: true, mechanism: "attested" },
    filesystem_write_isolation: "enforced",
    secret_environment_isolation: "allowlist",
    secret_filesystem_isolation: "enforced",
    process_containment: "container+process_group",
    project_trust_required: false,
    requires_explicit_trust: false,
    requires_per_run_approval: true,
    cache_mode: "sealed_seed_readonly_overlay",
    verification_level: "strong_isolation",
    max_command_seconds: 60,
    reasons: [],
    ...overrides,
  };
}

test("doctor accepts explicit local_trusted without Docker configuration or fallback", async () => {
  let probes = 0;
  const inspection = await inspectBuildRunnerConfiguration({
    shellEnv: {
      DOCKER_HOST: "tcp://remote.example:2375",
      APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN: "/shell/docker",
      APP_TEST_CTRL_BUILD_RUNNER_IMAGE: `example/android@sha256:${"a".repeat(64)}`,
    },
    mcpConfigText: buildRunnerMcpConfig({
      APP_TEST_CTRL_BUILD_RUNNER_BACKEND: "local_trusted",
    }),
    probeCapabilities: async (effectiveEnv) => {
      probes += 1;
      assert.equal(effectiveEnv.APP_TEST_CTRL_BUILD_RUNNER_BACKEND, "local_trusted");
      return readyLocalTrustedCapability();
    },
  });

  assert.equal(inspection.status, "ready");
  assert.equal(inspection.configured, true);
  assert.equal(inspection.backend, "local_trusted");
  assert.equal(probes, 1);
  assert.ok(inspection.checks.some((check) =>
    check.kind === "ok" && /local Build Runner probe passed/.test(check.label)));
  assert.ok(inspection.checks.some((check) =>
    check.kind === "warn" && /not strong isolation/.test(check.label)));
  assert.ok(inspection.checks.some((check) =>
    check.kind === "warn"
    && /explicitly approved local_trusted patch may proceed/.test(check.detail)));
});

test("doctor never mistakes local_trusted for isolated auto-patch capability", async () => {
  for (const capability of [
    readyLocalTrustedCapability({ auto_patch_eligible: true }),
    readyLocalTrustedCapability({ network_policy: "denied" }),
    readyLocalTrustedCapability({ strong_isolation: true }),
    readyLocalTrustedCapability({ secret_environment_isolation: "unavailable" }),
    readyLocalTrustedCapability({ requires_explicit_trust: false }),
    readyLocalTrustedCapability({ cache_mode: "sealed_seed_readonly_overlay" }),
    readyLocalTrustedCapability({ requires_per_run_approval: false }),
    { ...readyLocalTrustedCapability(), schema_version: "build-runner-capabilities/v1" },
  ]) {
    const inspection = await inspectBuildRunnerConfiguration({
      shellEnv: {},
      mcpConfigText: buildRunnerMcpConfig({
        APP_TEST_CTRL_BUILD_RUNNER_BACKEND: "local_trusted",
      }),
      probeCapabilities: async () => capability,
    });
    assert.equal(inspection.status, "unavailable");
    assert.equal(inspection.checks.some((check) => check.kind === "ok"), false);
  }
});

test("doctor keeps explicit Docker placeholders fail-closed", async () => {
  let probes = 0;
  const inspection = await inspectBuildRunnerConfiguration({
    shellEnv: {
      APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN: "/shell/docker",
      APP_TEST_CTRL_BUILD_RUNNER_IMAGE: `example/android@sha256:${"a".repeat(64)}`,
    },
    mcpConfigText: buildRunnerMcpConfig({
      APP_TEST_CTRL_BUILD_RUNNER_BACKEND: "docker",
      APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN: "",
      APP_TEST_CTRL_BUILD_RUNNER_DOCKER_HOST: "",
      APP_TEST_CTRL_BUILD_RUNNER_IMAGE: "",
    }),
    probeCapabilities: async () => {
      probes += 1;
      return { available: true };
    },
  });

  assert.equal(inspection.status, "unconfigured");
  assert.equal(inspection.configured, false);
  assert.equal(probes, 0);
  assert.ok(inspection.checks.some((check) =>
    check.kind === "warn" && /fail-closed defaults/.test(check.label)));
});

test("doctor reports Docker/image probe failures as warnings, never false green", async () => {
  const configured = buildRunnerMcpConfig({
    APP_TEST_CTRL_BUILD_RUNNER_BACKEND: "docker",
    APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN: "/usr/bin/docker",
    APP_TEST_CTRL_BUILD_RUNNER_DOCKER_HOST: "unix:///var/run/docker.sock",
    APP_TEST_CTRL_BUILD_RUNNER_IMAGE: `example/android@sha256:${"b".repeat(64)}`,
  });
  const unavailable = await inspectBuildRunnerConfiguration({
    shellEnv: {},
    mcpConfigText: configured,
    probeCapabilities: async () => ({
      available: false,
      auto_patch_eligible: false,
      backend: "docker",
      network_policy: "denied",
      reasons: ["DOCKER_DAEMON_UNAVAILABLE"],
    }),
  });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.checks.some((check) => check.kind === "ok"), false);
  assert.ok(unavailable.checks.some((check) =>
    check.kind === "warn" && /DOCKER_DAEMON_UNAVAILABLE/.test(check.detail)));

  const stringBoolean = await inspectBuildRunnerConfiguration({
    shellEnv: {},
    mcpConfigText: configured,
    probeCapabilities: async () => ({
      available: "true",
      auto_patch_eligible: true,
      backend: "docker",
      network_policy: "denied",
    }),
  });
  assert.equal(stringBoolean.status, "unavailable");
  assert.equal(stringBoolean.checks.some((check) => check.kind === "ok"), false);

  const missingQuotaProof = await inspectBuildRunnerConfiguration({
    shellEnv: {},
    mcpConfigText: configured,
    probeCapabilities: async () => ({
      available: true,
      auto_patch_eligible: true,
      backend: "docker",
      network_policy: "denied",
    }),
  });
  assert.equal(missingQuotaProof.status, "unavailable");
  assert.equal(missingQuotaProof.checks.some((check) => check.kind === "ok"), false);
});

test("doctor accepts only the owned Build Runner entry plus a strict passing probe", async () => {
  let probes = 0;
  const foreign = await inspectBuildRunnerConfiguration({
    shellEnv: {},
    mcpConfigText: buildRunnerMcpConfig({
      APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN: "/usr/bin/docker",
      APP_TEST_CTRL_BUILD_RUNNER_IMAGE: `example/android@sha256:${"c".repeat(64)}`,
    }, "/foreign/build-runner.js"),
    probeCapabilities: async () => {
      probes += 1;
      return { available: true };
    },
  });
  assert.equal(foreign.status, "invalid");
  assert.equal(probes, 0);

  const ready = await inspectBuildRunnerConfiguration({
    shellEnv: {},
    mcpConfigText: buildRunnerMcpConfig({
      APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN: "/usr/bin/docker",
      APP_TEST_CTRL_BUILD_RUNNER_IMAGE: `example/android@sha256:${"d".repeat(64)}`,
    }),
    probeCapabilities: async (effectiveEnv) => {
      probes += 1;
      assert.equal(effectiveEnv.APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN, "/usr/bin/docker");
      return readyDockerCapability();
    },
  });
  assert.equal(ready.status, "ready");
  assert.equal(probes, 1);
  assert.ok(ready.checks.some((check) => check.kind === "ok"));
});

test("doctor rejects an unknown Build Runner backend before probing", async () => {
  let probes = 0;
  const inspection = await inspectBuildRunnerConfiguration({
    shellEnv: {},
    mcpConfigText: buildRunnerMcpConfig({
      APP_TEST_CTRL_BUILD_RUNNER_BACKEND: "automatic",
    }),
    probeCapabilities: async () => {
      probes += 1;
      return readyLocalTrustedCapability();
    },
  });
  assert.equal(inspection.status, "invalid");
  assert.equal(inspection.configured, false);
  assert.equal(probes, 0);
});

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
  const templatePath = path.join(HERE, "..", ".mcp.json.example");
  const checkedInTemplate = JSON.parse(await readFile(templatePath, "utf8"));
  assert.deepEqual(
    checkedInTemplate.mcpServers.firebase,
    {
      command: "node",
      args: ["${PROJECT_ROOT}/mcp-servers/firebase-readonly-mcp/dist/index.js"],
      env: { [FIREBASE_MANAGED_ENV]: FIREBASE_MANAGED_VALUE },
    },
  );
  const scriptsDir = path.join(root, "scripts");
  const fakeHome = path.join(root, "home");
  const fakeAppData = path.join(fakeHome, "AppData", "Roaming");
  const firebaseDir = path.join(root, "firebase app");
  const serviceAccountPath = path.join(root, "service-account-fixture.json");
  const serviceAccountSentinel = "opaque-private-key-sentinel-never-parse-or-print";
  await Promise.all([
    mkdir(scriptsDir, { recursive: true }),
    mkdir(fakeHome, { recursive: true }),
    mkdir(firebaseDir, { recursive: true }),
    writeFile(serviceAccountPath, `${serviceAccountSentinel}\n`, { mode: 0o600 }),
  ]);
  const fixtureScript = path.join(scriptsDir, "setup-mcp.mjs");
  await copyFile(SETUP_MCP_SCRIPT, fixtureScript);
  await copyFile(
    FIREBASE_MCP_CONFIG_HELPER,
    path.join(scriptsDir, "firebase-mcp-config.mjs"),
  );
  await copyFile(templatePath, path.join(root, ".mcp.json.example"));
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
  assert.equal(
    path.normalize(projectConfig.mcpServers["build-runner"].args[0]),
    path.join(canonicalRoot, "mcp-servers", "build-runner-mcp", "dist", "index.js"),
  );
  assert.deepEqual(projectConfig.mcpServers["build-runner"].env, {
    APP_TEST_CTRL_BUILD_RUNNER_BACKEND: "local_trusted",
  });
  assert.equal(Object.keys(projectConfig.mcpServers).length, 9);
  const expectedProjectNpmCache = path.join(canonicalRoot, ".codex", "npm-cache");
  const expectedFirebaseBase = buildOfficialFirebaseServer(null, {
    projectRoot: canonicalRoot,
  });
  assert.equal(projectConfig.mcpServers.firebase.command, expectedFirebaseBase.command);
  assert.deepEqual(projectConfig.mcpServers.firebase.args, expectedFirebaseBase.args);
  assert.equal(
    projectConfig.mcpServers.firebase.env[FIREBASE_MANAGED_ENV],
    FIREBASE_MANAGED_VALUE,
  );
  assert.equal(
    projectConfig.mcpServers.firebase.env[FIREBASE_MANAGED_OWNER_ENV],
    officialFirebaseOwnerSha256(canonicalRoot),
  );
  assert.equal(projectConfig.mcpServers.firebase.env.NPM_CONFIG_CACHE, undefined);
  assert.equal(
    projectConfig.mcpServers.mobile.env.NPM_CONFIG_CACHE,
    expectedProjectNpmCache,
  );
  assert.equal(path.isAbsolute(projectConfig.mcpServers.mobile.env.NPM_CONFIG_CACHE), true);

  const dockerGenerated = spawnSync(
    process.execPath,
    [fixtureScript, "--force", "--build-runner-backend", "docker"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(
    dockerGenerated.status,
    0,
    `${dockerGenerated.stdout}\n${dockerGenerated.stderr}`,
  );
  const dockerProjectConfig = JSON.parse(
    await readFile(path.join(root, ".mcp.json"), "utf8"),
  );
  assert.deepEqual(dockerProjectConfig.mcpServers["build-runner"].env, {
    APP_TEST_CTRL_BUILD_RUNNER_BACKEND: "docker",
    APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN: "",
    APP_TEST_CTRL_BUILD_RUNNER_DOCKER_HOST: "",
    APP_TEST_CTRL_BUILD_RUNNER_IMAGE: "",
    APP_TEST_CTRL_BUILD_RUNNER_OCI_RUNTIME: "runc",
  });
  assert.equal(Object.keys(dockerProjectConfig.mcpServers).length, 9);

  const canonicalFirebaseDir = await realpath(firebaseDir);
  const canonicalServiceAccountPath = await realpath(serviceAccountPath);
  const scoped = spawnSync(
    process.execPath,
    [
      fixtureScript,
      "--force",
      "--firebase-project-source", "service-account",
      "--firebase-project-id", "fixture-project-1",
      "--firebase-service-account", canonicalServiceAccountPath,
      "--firebase-dir", firebaseDir,
    ],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(scoped.status, 0, `${scoped.stdout}\n${scoped.stderr}`);
  assert.equal(scoped.stdout.includes(serviceAccountSentinel), false);
  assert.equal(scoped.stderr.includes(serviceAccountSentinel), false);
  await assert.rejects(lstat(path.join(firebaseDir, ".firebaserc")), /ENOENT/);
  const scopedConfigPath = path.join(root, ".mcp.json");
  const scopedText = await readFile(scopedConfigPath, "utf8");
  assert.equal(scopedText.includes(serviceAccountSentinel), false);
  const scopedConfig = JSON.parse(scopedText);
  const scopedFirebase = inspectOfficialFirebaseServer(
    scopedConfig.mcpServers.firebase,
    { expectedProjectRoot: canonicalRoot },
  );
  assert.equal(scopedFirebase.valid, true);
  assert.equal(scopedFirebase.owned_by_expected_project, true);
  assert.equal(scopedFirebase.firebaseDir, canonicalFirebaseDir);
  assert.equal(scopedFirebase.projectSource, "service-account");
  assert.equal(scopedFirebase.firebaseProjectId, "fixture-project-1");
  assert.equal(scopedFirebase.credentialConfigured, true);
  assert.equal(
    scopedConfig.mcpServers.firebase.env.GOOGLE_APPLICATION_CREDENTIALS,
    canonicalServiceAccountPath,
  );
  assert.equal(scopedConfig.mcpServers.firebase.env.NPM_CONFIG_CACHE, undefined);
  assert.equal(
    scopedConfig.mcpServers.mobile.env.NPM_CONFIG_CACHE,
    expectedProjectNpmCache,
  );

  const invalidFirebaseDirs = [
    "relative/firebase-app",
    path.join(root, "missing-firebase-app"),
    path.join(root, "not-a-directory.txt"),
  ];
  await writeFile(invalidFirebaseDirs[2], "not a directory\n", "utf8");
  for (const invalidFirebaseDir of invalidFirebaseDirs) {
    const invalid = spawnSync(
      process.execPath,
      [
        fixtureScript,
        "--force",
        "--firebase-project-source", "firebaserc",
        "--firebase-dir", invalidFirebaseDir,
      ],
      { env, encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /--firebase-dir must be an absolute existing directory/);
    assert.equal(await readFile(scopedConfigPath, "utf8"), scopedText);
  }
  const missingFirebaseDirValue = spawnSync(
    process.execPath,
    [fixtureScript, "--firebase-dir"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(missingFirebaseDirValue.status, 2);
  assert.match(missingFirebaseDirValue.stderr, /--firebase-dir requires/);

  const unselectedFirebaseProfile = spawnSync(
    process.execPath,
    [fixtureScript, "--force", "--firebase-dir", firebaseDir],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(unselectedFirebaseProfile.status, 2);
  assert.match(unselectedFirebaseProfile.stderr, /requires --firebase-project-source/);
  assert.equal(await readFile(scopedConfigPath, "utf8"), scopedText);

  const missingFirebaserc = spawnSync(
    process.execPath,
    [
      fixtureScript,
      "--force",
      "--firebase-project-source", "firebaserc",
      "--firebase-dir", firebaseDir,
    ],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(missingFirebaserc.status, 1);
  assert.match(missingFirebaserc.stderr, /requires an existing current-user \.firebaserc/);
  assert.equal(await readFile(scopedConfigPath, "utf8"), scopedText);

  for (const invalidCliArgs of [
    ["positional"],
    ["--unknown"],
    ["--force", "--force"],
    ["--client", "claude-code", "--client", "cursor"],
    ["--global"],
    ["--project"],
    ["--client", "claude-cdoe"],
    ["--firebase-project-source", "firebaserc"],
    [
      "--firebase-project-source", "service-account",
      "--firebase-dir", firebaseDir,
    ],
    ["--firebase-project-id", "fixture-project-1"],
    ["--firebase-service-account", serviceAccountPath],
  ]) {
    const invalid = spawnSync(
      process.execPath,
      [fixtureScript, ...invalidCliArgs],
      { env, encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(invalid.status, 2, `${invalid.stdout}\n${invalid.stderr}`);
    assert.equal(await readFile(scopedConfigPath, "utf8"), scopedText);
  }

  await writeFile(
    path.join(firebaseDir, ".firebaserc"),
    `${JSON.stringify({ projects: { default: "fixture-project-1" } })}\n`,
    { mode: 0o600 },
  );
  if (process.platform !== "win32") {
    await chmod(path.join(firebaseDir, ".firebaserc"), 0o666);
    const writableFirebaserc = spawnSync(
      process.execPath,
      [
        fixtureScript,
        "--client", "codex",
        "--firebase-project-source", "firebaserc",
        "--firebase-dir", firebaseDir,
      ],
      { env, encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(writableFirebaserc.status, 1);
    assert.match(writableFirebaserc.stderr, /not group\/other writable/);
    await chmod(path.join(firebaseDir, ".firebaserc"), 0o600);
  }

  const configVictim = path.join(root, "setup-config-victim.json");
  await writeFile(configVictim, "user-owned\n", "utf8");
  await unlink(scopedConfigPath);
  await symlink(configVictim, scopedConfigPath);
  const linkedConfig = spawnSync(
    process.execPath,
    [fixtureScript, "--force"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(linkedConfig.status, 1, `${linkedConfig.stdout}\n${linkedConfig.stderr}`);
  assert.match(linkedConfig.stderr, /linked or non-regular configuration/);
  assert.equal(await readFile(configVictim, "utf8"), "user-owned\n");
  await unlink(scopedConfigPath);

  await link(configVictim, scopedConfigPath);
  const hardLinkedConfig = spawnSync(
    process.execPath,
    [fixtureScript, "--force"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(hardLinkedConfig.status, 1, `${hardLinkedConfig.stdout}\n${hardLinkedConfig.stderr}`);
  assert.match(hardLinkedConfig.stderr, /linked or non-regular configuration/);
  assert.equal(await readFile(configVictim, "utf8"), "user-owned\n");
  await unlink(scopedConfigPath);
  await writeFile(scopedConfigPath, scopedText, "utf8");

  for (const invalidBackendArgs of [
    ["--build-runner-backend"],
    ["--build-runner-backend", "automatic"],
  ]) {
    const invalid = spawnSync(
      process.execPath,
      [fixtureScript, "--force", ...invalidBackendArgs],
      { env, encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /--build-runner-backend (?:requires|must be one of)/);
    assert.equal(await readFile(scopedConfigPath, "utf8"), scopedText);
  }

  const codex = spawnSync(
    process.execPath,
    [
      fixtureScript,
      "--client", "codex",
      "--firebase-project-source", "firebaserc",
      "--firebase-dir", firebaseDir,
    ],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(codex.status, 0, `${codex.stdout}\n${codex.stderr}`);
  assert.ok(codex.stdout.includes(JSON.stringify(canonicalFirebaseDir)));
  assert.equal(OFFICIAL_FIREBASE_READ_TOOLS.length, 8);
  const enabledToolsLine = `enabled_tools = [${OFFICIAL_FIREBASE_READ_TOOLS
    .map((tool) => JSON.stringify(tool))
    .join(", ")}]`;
  const firebaseSection = tomlServerSection(codex.stdout, "firebase");
  const buildRunnerSection = tomlServerSection(codex.stdout, "build-runner");
  assert.ok(buildRunnerSection.includes('APP_TEST_CTRL_BUILD_RUNNER_BACKEND = "local_trusted"'));
  assert.equal(buildRunnerSection.includes("APP_TEST_CTRL_BUILD_RUNNER_DOCKER_"), false);
  assert.ok(firebaseSection.includes(enabledToolsLine));
  for (const tool of OFFICIAL_FIREBASE_READ_TOOLS) {
    assert.ok(firebaseSection.includes(JSON.stringify(tool)));
  }
  for (const tool of [
    "firebase_read_resources",
    "firebase_login",
    "crashlytics_update_issue",
    "crashlytics_create_note",
  ]) {
    assert.equal(firebaseSection.includes(JSON.stringify(tool)), false);
  }
  assert.equal(codex.stdout.includes("[mcp_servers.firebase.tools."), false);
  assert.equal(firebaseSection.includes('"--project-source", "firebaserc"'), true);
  assert.equal(firebaseSection.includes("GOOGLE_APPLICATION_CREDENTIALS"), false);
  const codexNode = tomlJsonString(firebaseSection, "command");
  const codexCwd = tomlJsonString(firebaseSection, "cwd");
  assert.equal(path.isAbsolute(codexNode), true);
  assert.match(path.basename(codexNode).toLowerCase(), /^node(?:\.exe)?$/);
  assert.equal(codexCwd, canonicalRoot);
  assert.equal(path.isAbsolute(codexCwd), true);
  assert.match(
    firebaseSection,
    new RegExp(`^startup_timeout_sec\\s*=\\s*${FIREBASE_MCP_STARTUP_TIMEOUT_SEC}\\s*$`, "m"),
  );
  assert.match(firebaseSection, /^enabled\s*=\s*true\s*$/m);
  assert.equal(firebaseSection.includes("NPM_CONFIG_CACHE"), false);
  assert.ok(
    firebaseSection.includes(
      `${FIREBASE_MANAGED_OWNER_ENV} = ${JSON.stringify(officialFirebaseOwnerSha256(canonicalRoot))}`,
    ),
  );

  const dockerCodex = spawnSync(
    process.execPath,
    [fixtureScript, "--client", "codex", "--build-runner-backend", "docker"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(dockerCodex.status, 0, `${dockerCodex.stdout}\n${dockerCodex.stderr}`);
  const dockerBuildRunnerSection = tomlServerSection(dockerCodex.stdout, "build-runner");
  assert.ok(dockerBuildRunnerSection.includes('APP_TEST_CTRL_BUILD_RUNNER_BACKEND = "docker"'));
  assert.ok(dockerBuildRunnerSection.includes('APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN = ""'));
  assert.ok(dockerBuildRunnerSection.includes('APP_TEST_CTRL_BUILD_RUNNER_DOCKER_HOST = ""'));
  assert.ok(dockerBuildRunnerSection.includes('APP_TEST_CTRL_BUILD_RUNNER_IMAGE = ""'));
  assert.ok(dockerBuildRunnerSection.includes('APP_TEST_CTRL_BUILD_RUNNER_OCI_RUNTIME = "runc"'));

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
  assert.equal(
    desktopConfig.mcpServers.firebase.env[FIREBASE_MANAGED_ENV],
    FIREBASE_MANAGED_VALUE,
  );
  assert.equal(
    desktopConfig.mcpServers.firebase.env[FIREBASE_MANAGED_OWNER_ENV],
    officialFirebaseOwnerSha256(canonicalRoot),
  );
  assert.deepEqual(desktopConfig.mcpServers["build-runner"].env, {
    APP_TEST_CTRL_BUILD_RUNNER_BACKEND: "local_trusted",
  });

  const escapedConfigParent = path.join(root, "escaped-config-parent");
  await mkdir(escapedConfigParent);
  await symlink(escapedConfigParent, path.join(fakeHome, ".gemini"));
  const linkedParent = spawnSync(
    process.execPath,
    [fixtureScript, "--client", "antigravity", "--force"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(linkedParent.status, 1, `${linkedParent.stdout}\n${linkedParent.stderr}`);
  assert.match(linkedParent.stderr, /linked or non-directory config parent/);
  await assert.rejects(
    readFile(path.join(escapedConfigParent, "config", "mcp_config.json")),
    /ENOENT/,
  );

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
  assert.equal(
    merged.mcp.firebase.environment[FIREBASE_MANAGED_ENV],
    FIREBASE_MANAGED_VALUE,
  );
  assert.deepEqual(merged.mcp["build-runner"].environment, {
    APP_TEST_CTRL_BUILD_RUNNER_BACKEND: "local_trusted",
  });
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
