import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FIREBASE_CODEX_FORWARDED_ENV_VARS,
  FIREBASE_MANAGED_ENV,
  FIREBASE_MANAGED_OWNER_ENV,
  FIREBASE_MANAGED_VALUE,
  FIREBASE_MCP_STARTUP_TIMEOUT_SEC,
  FIREBASE_PROJECT_SOURCES,
  FIREBASE_PROXY_RELATIVE_ENTRY,
  FIREBASE_READONLY_PRELOAD_RELATIVE_ENTRY,
  FIREBASE_REPORTS_GUIDE_URI,
  FIREBASE_TOOLS_VERSION,
  OFFICIAL_FIREBASE_READ_TOOLS,
  bindOfficialFirebaseServerOwner,
  buildCodexOfficialFirebaseServer,
  buildOfficialFirebaseServer,
  inspectOfficialFirebaseServer,
  officialFirebaseOwnerSha256,
  parseGeneratedCodexFirebaseServer,
} from "./firebase-mcp-config.mjs";
import {
  inspectCrashlyticsConfiguration,
  inspectOfficialFirebaseConfiguration,
  normalizeDoctorMcpConfig,
  parseDoctorArgs,
} from "./doctor.mjs";
import {
  PACKAGES,
  PREWARM_TIMEOUT_MS,
  PROJECT_NPM_CACHE,
  buildPrewarmSpawnOptions,
} from "./prewarm.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function configWith(firebase) {
  return JSON.stringify({ mcpServers: { firebase } });
}

function runtimeInspectionStubs(
  projectRoot,
  firebaseDir = null,
  {
    credentialPath = null,
    firebasercText = null,
    preloadPresent = true,
  } = {},
) {
  const gateway = path.join(projectRoot, ...FIREBASE_PROXY_RELATIVE_ENTRY.split("/"));
  const preload = path.join(
    projectRoot,
    ...FIREBASE_READONLY_PRELOAD_RELATIVE_ENTRY.split("/"),
  );
  const cli = path.join(
    projectRoot,
    "node_modules",
    "firebase-tools",
    "lib",
    "bin",
    "firebase.js",
  );
  return {
    fileStat: async (candidate) => ({
      isDirectory: () => firebaseDir !== null && candidate === firebaseDir,
      isFile: () => candidate === gateway
        || (preloadPresent && candidate === preload)
        || candidate === cli,
    }),
    fileLstat: async (candidate) => {
      if (candidate === credentialPath) {
        return {
          isFile: () => true,
          isSymbolicLink: () => false,
          nlink: 1,
          size: 2048,
          uid: typeof process.getuid === "function" ? process.getuid() : 0,
          mode: 0o100600,
        };
      }
      if (firebaseDir !== null && candidate === path.join(firebaseDir, ".firebaserc")) {
        return {
          isFile: () => firebasercText !== null,
          isSymbolicLink: () => false,
          nlink: 1,
          size: firebasercText === null ? 0 : Buffer.byteLength(firebasercText),
          uid: typeof process.getuid === "function" ? process.getuid() : 0,
          mode: 0o100600,
        };
      }
      throw new Error("unexpected fixture lstat");
    },
    fileRealpath: async (candidate) => candidate,
    fileRead: async (candidate) => {
      if (candidate === path.join(projectRoot, "package.json")) {
        return JSON.stringify({ devDependencies: { "firebase-tools": FIREBASE_TOOLS_VERSION } });
      }
      if (candidate === path.join(projectRoot, "node_modules", "firebase-tools", "package.json")) {
        return JSON.stringify({ version: FIREBASE_TOOLS_VERSION });
      }
      if (
        firebaseDir !== null
        && candidate === path.join(firebaseDir, ".firebaserc")
        && firebasercText !== null
      ) {
        return firebasercText;
      }
      throw new Error("unexpected fixture read");
    },
  };
}

test("checked-in MCP template points to the local read-only gateway", async () => {
  const template = JSON.parse(
    await readFile(new URL("../.mcp.json.example", import.meta.url), "utf8"),
  );
  assert.deepEqual(template.mcpServers?.firebase, {
    command: "node",
    args: ["${PROJECT_ROOT}/mcp-servers/firebase-readonly-mcp/dist/index.js"],
    env: { [FIREBASE_MANAGED_ENV]: FIREBASE_MANAGED_VALUE },
  });
});

test("Firebase CLI login uses the pinned project-local launcher", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    manifest.scripts?.firebase,
    "node node_modules/firebase-tools/lib/bin/firebase.js",
  );
  assert.equal(manifest.devDependencies?.["firebase-tools"], FIREBASE_TOOLS_VERSION);
  const firebaseSmoke = [
    "mcp-servers/firebase-readonly-mcp/dist/index.js",
    OFFICIAL_FIREBASE_READ_TOOLS.join(","),
    "--exact",
  ].join(" ");
  assert.ok(manifest.scripts?.["test:smoke"]?.includes(firebaseSmoke));
  assert.equal(manifest.scripts?.["test:smoke"]?.includes("firebase_read_resources"), false);
});

test("official Firebase gateway config supports explicit service-account and firebaserc profiles", () => {
  const projectRoot = "/tmp/this-checkout";
  const plain = bindOfficialFirebaseServerOwner(
    buildOfficialFirebaseServer(null, { projectRoot, platform: "linux" }),
    projectRoot,
    { platform: "linux" },
  );
  const inspected = inspectOfficialFirebaseServer(plain, {
    expectedProjectRoot: projectRoot,
    platform: "linux",
    client: "claude-code",
  });
  assert.equal(inspected.valid, true);
  assert.equal(inspected.firebaseDir, null);
  assert.equal(inspected.projectSource, null);
  assert.equal(inspected.owned_by_expected_project, true);

  assert.deepEqual(FIREBASE_PROJECT_SOURCES, ["service-account", "firebaserc"]);
  const serviceAccountPath = "/tmp/credential-secret-name.json";
  const service = bindOfficialFirebaseServerOwner(
    buildOfficialFirebaseServer("/tmp/firebase-app", {
      projectRoot,
      platform: "linux",
      projectSource: "service-account",
      firebaseProjectId: "fixture-project-1",
      serviceAccountPath,
    }),
    projectRoot,
    { platform: "linux" },
  );
  const inspectedService = inspectOfficialFirebaseServer(service, {
    expectedProjectRoot: projectRoot,
    platform: "linux",
  });
  assert.equal(inspectedService.valid, true);
  assert.equal(inspectedService.firebaseDir, "/tmp/firebase-app");
  assert.equal(inspectedService.projectSource, "service-account");
  assert.equal(inspectedService.firebaseProjectId, "fixture-project-1");
  assert.equal(inspectedService.credentialConfigured, true);
  assert.equal(JSON.stringify(inspectedService).includes(serviceAccountPath), false);

  const firebaserc = bindOfficialFirebaseServerOwner(
    buildOfficialFirebaseServer("/tmp/firebase-app", {
      projectRoot,
      platform: "linux",
      projectSource: "firebaserc",
    }),
    projectRoot,
    { platform: "linux" },
  );
  const inspectedFirebaserc = inspectOfficialFirebaseServer(firebaserc, {
    expectedProjectRoot: projectRoot,
    platform: "linux",
  });
  assert.equal(inspectedFirebaserc.valid, true);
  assert.equal(inspectedFirebaserc.firebaseDir, "/tmp/firebase-app");
  assert.equal(inspectedFirebaserc.projectSource, "firebaserc");
  assert.equal(inspectedFirebaserc.firebaseProjectId, null);
  assert.equal(inspectedFirebaserc.credentialConfigured, false);
});

test("Firebase profile builders reject incomplete or mixed connection state", () => {
  const projectRoot = "/tmp/this-checkout";
  const firebaseDir = "/tmp/firebase-app";
  const serviceAccountPath = "/tmp/service-account.json";
  const serviceOptions = {
    projectRoot,
    platform: "linux",
    projectSource: "service-account",
    firebaseProjectId: "fixture-project-1",
    serviceAccountPath,
  };
  const invalidBuilders = [
    () => buildOfficialFirebaseServer(null, serviceOptions),
    () => buildOfficialFirebaseServer(firebaseDir, {
      ...serviceOptions,
      firebaseProjectId: null,
    }),
    () => buildOfficialFirebaseServer(firebaseDir, {
      ...serviceOptions,
      serviceAccountPath: null,
    }),
    () => buildOfficialFirebaseServer(firebaseDir, {
      ...serviceOptions,
      firebaseProjectId: "INVALID",
    }),
    () => buildOfficialFirebaseServer(firebaseDir, {
      ...serviceOptions,
      serviceAccountPath: "relative/service-account.json",
    }),
    () => buildOfficialFirebaseServer(firebaseDir, {
      projectRoot,
      platform: "linux",
      projectSource: "firebaserc",
      firebaseProjectId: "fixture-project-1",
    }),
    () => buildOfficialFirebaseServer(firebaseDir, {
      projectRoot,
      platform: "linux",
      projectSource: "firebaserc",
      serviceAccountPath,
    }),
    () => buildOfficialFirebaseServer(firebaseDir, {
      projectRoot,
      platform: "linux",
      projectSource: "automatic",
    }),
    () => buildOfficialFirebaseServer(firebaseDir, {
      projectRoot,
      platform: "linux",
      firebaseProjectId: "fixture-project-1",
    }),
  ];
  for (const build of invalidBuilders) assert.throws(build);
});

test("Firebase profile inspection rejects reordered, duplicated, missing, and mixed arguments", () => {
  const projectRoot = "/tmp/this-checkout";
  const serviceAccountPath = "/tmp/credential-secret-name.json";
  const service = bindOfficialFirebaseServerOwner(
    buildOfficialFirebaseServer("/tmp/firebase-app", {
      projectRoot,
      platform: "linux",
      projectSource: "service-account",
      firebaseProjectId: "fixture-project-1",
      serviceAccountPath,
    }),
    projectRoot,
    { platform: "linux" },
  );
  const argumentMutations = [
    (entry) => entry.args.push("--dir", "/tmp/second-app"),
    (entry) => entry.args.push("--project-id", "fixture-project-2"),
    (entry) => entry.args.splice(1, 2),
    (entry) => { entry.args[2] = "firebaserc"; },
    (entry) => { entry.args[4] = "INVALID"; },
    (entry) => { entry.args[6] = "relative/firebase-app"; },
    (entry) => {
      [entry.args[1], entry.args[5]] = [entry.args[5], entry.args[1]];
    },
  ];
  for (const mutate of argumentMutations) {
    const changed = structuredClone(service);
    mutate(changed);
    const inspected = inspectOfficialFirebaseServer(changed, {
      expectedProjectRoot: projectRoot,
      platform: "linux",
    });
    assert.equal(inspected.valid, false);
    assert.equal(JSON.stringify(inspected).includes(serviceAccountPath), false);
  }

  const environmentMutations = [
    (entry) => { delete entry.env.GOOGLE_APPLICATION_CREDENTIALS; },
    (entry) => { entry.env.GOOGLE_APPLICATION_CREDENTIALS = "relative/credential.json"; },
    (entry) => { entry.env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE = "/tmp/other.json"; },
    (entry) => { entry.env.GOOGLE_CLOUD_PROJECT = "other-project-1"; },
    (entry) => { entry.env.GCLOUD_PROJECT = "other-project-1"; },
  ];
  for (const mutate of environmentMutations) {
    const changed = structuredClone(service);
    mutate(changed);
    assert.equal(inspectOfficialFirebaseServer(changed, {
      expectedProjectRoot: projectRoot,
      platform: "linux",
    }).valid, false);
  }

  const firebaserc = bindOfficialFirebaseServerOwner(
    buildOfficialFirebaseServer("/tmp/firebase-app", {
      projectRoot,
      platform: "linux",
      projectSource: "firebaserc",
    }),
    projectRoot,
    { platform: "linux" },
  );
  firebaserc.env.GOOGLE_APPLICATION_CREDENTIALS = serviceAccountPath;
  const mixed = inspectOfficialFirebaseServer(firebaserc, {
    expectedProjectRoot: projectRoot,
    platform: "linux",
  });
  assert.equal(mixed.valid, false);
  assert.equal(JSON.stringify(mixed).includes(serviceAccountPath), false);
});

test("Firebase inspection diagnostics never echo credential paths or private-key values", () => {
  const projectRoot = "/tmp/this-checkout";
  const credentialPath = "/tmp/credential-path-must-not-escape.json";
  const privateKeySentinel = "PRIVATE_KEY_VALUE_MUST_NOT_ESCAPE";
  const entry = bindOfficialFirebaseServerOwner(
    buildOfficialFirebaseServer("/tmp/firebase-app", {
      projectRoot,
      platform: "linux",
      projectSource: "service-account",
      firebaseProjectId: "fixture-project-1",
      serviceAccountPath: credentialPath,
    }),
    projectRoot,
    { platform: "linux" },
  );
  entry.env.PRIVATE_KEY = privateKeySentinel;
  const inspected = inspectOfficialFirebaseServer(entry, {
    expectedProjectRoot: projectRoot,
    platform: "linux",
  });
  assert.equal(inspected.valid, false);
  const diagnostics = JSON.stringify(inspected);
  assert.equal(diagnostics.includes(credentialPath), false);
  assert.equal(diagnostics.includes(privateKeySentinel), false);
  assert.ok(inspected.issues.some((issue) => /PRIVATE_KEY/.test(issue)));
});

test("official Firebase inspection fails closed on drift and missing expected root", () => {
  const projectRoot = "/tmp/this-checkout";
  const base = bindOfficialFirebaseServerOwner(
    buildOfficialFirebaseServer(null, { projectRoot, platform: "linux" }),
    projectRoot,
    { platform: "linux" },
  );
  const mutations = [
    (entry) => entry.args.push("--debug"),
    (entry) => { entry.args[0] = "/tmp/another/gateway.js"; },
    (entry) => { entry.command = "tools/node"; },
    (entry) => { delete entry.env[FIREBASE_MANAGED_ENV]; },
    (entry) => { entry.environment = entry.env; },
    (entry) => { entry.env.NODE_OPTIONS = "--require=/tmp/preload.js"; },
    (entry) => { entry.env.FIREBASE_TOKEN = "do-not-store-tokens-in-client-config"; },
    (entry) => { entry.env.GOOGLE_APPLICATION_CREDENTIALS = { path: "/tmp/adc.json" }; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(base);
    mutate(changed);
    assert.equal(inspectOfficialFirebaseServer(changed, {
      expectedProjectRoot: projectRoot,
      platform: "linux",
    }).valid, false);
  }

  const missingRoot = inspectOfficialFirebaseServer(base, {
    client: "codex",
    platform: "linux",
  });
  assert.equal(missingRoot.valid, false);
  assert.ok(missingRoot.issues.some((issue) => /expectedProjectRoot/.test(issue)));

  const explicitCredentialPath = structuredClone(base);
  explicitCredentialPath.env.GOOGLE_APPLICATION_CREDENTIALS = "/tmp/adc.json";
  assert.equal(inspectOfficialFirebaseServer(explicitCredentialPath, {
    expectedProjectRoot: projectRoot,
    platform: "linux",
  }).valid, true);
});

test("official Firebase read policy is a fixed eight-tool positive allowlist", () => {
  assert.deepEqual(OFFICIAL_FIREBASE_READ_TOOLS, [
    "firebase_get_environment",
    "firebase_get_project",
    "firebase_list_apps",
    "firebase_get_crashlytics_report_guide",
    "crashlytics_get_issue",
    "crashlytics_list_events",
    "crashlytics_batch_get_events",
    "crashlytics_get_report",
  ]);
  assert.equal(OFFICIAL_FIREBASE_READ_TOOLS.length, 8);
  assert.equal(FIREBASE_REPORTS_GUIDE_URI, "firebase://guides/crashlytics/reports");
  assert.equal(OFFICIAL_FIREBASE_READ_TOOLS.includes("firebase_read_resources"), false);
  assert.equal(OFFICIAL_FIREBASE_READ_TOOLS.includes("crashlytics_update_issue"), false);
  assert.equal(OFFICIAL_FIREBASE_READ_TOOLS.includes("firebase_login"), false);
});

test("both Firebase profiles keep the exact Codex eight-tool allowlist", () => {
  const projectRoot = "/tmp/app-test-ctrl project";
  const nodeCommand = "/opt/node/bin/node";
  const profiles = [
    {
      projectSource: "service-account",
      firebaseProjectId: "fixture-project-1",
      serviceAccountPath: "/tmp/service-account.json",
    },
    { projectSource: "firebaserc" },
  ];
  for (const profile of profiles) {
    const base = buildOfficialFirebaseServer("/tmp/firebase app", {
      projectRoot,
      platform: "linux",
      ...profile,
    });
    const runtime = buildCodexOfficialFirebaseServer(base, projectRoot, {
      nodeCommand,
      platform: "linux",
    });
    assert.deepEqual(runtime.enabled_tools, OFFICIAL_FIREBASE_READ_TOOLS);
    assert.notEqual(runtime.enabled_tools, OFFICIAL_FIREBASE_READ_TOOLS);
    assert.deepEqual(runtime.env_vars, FIREBASE_CODEX_FORWARDED_ENV_VARS);
    assert.notEqual(runtime.env_vars, FIREBASE_CODEX_FORWARDED_ENV_VARS);
    assert.equal(inspectOfficialFirebaseServer(runtime, {
      expectedProjectRoot: projectRoot,
      client: "codex",
      platform: "linux",
    }).valid, true);

    for (const changeTools of [
      (tools) => tools.slice(0, -1),
      (tools) => [...tools, "firebase_login"],
      (tools) => [tools[1], tools[0], ...tools.slice(2)],
      (tools) => tools.map((tool) => (
        tool === "firebase_get_crashlytics_report_guide"
          ? "firebase_read_resources"
          : tool
      )),
    ]) {
      const changed = structuredClone(runtime);
      changed.enabled_tools = changeTools(changed.enabled_tools);
      assert.equal(inspectOfficialFirebaseServer(changed, {
        expectedProjectRoot: projectRoot,
        client: "codex",
        platform: "linux",
      }).valid, false);
    }
  }
});

test("Codex gateway runtime is absolute, enabled, bounded, and parseable", () => {
  const projectRoot = "/tmp/app-test-ctrl project";
  const nodeCommand = "/opt/node/bin/node";
  const base = buildOfficialFirebaseServer("/tmp/firebase app", {
    projectRoot,
    platform: "linux",
  });
  const runtime = buildCodexOfficialFirebaseServer(base, projectRoot, {
    nodeCommand,
    platform: "linux",
  });
  assert.equal(runtime.command, nodeCommand);
  assert.equal(runtime.cwd, projectRoot);
  assert.equal(runtime.startup_timeout_sec, FIREBASE_MCP_STARTUP_TIMEOUT_SEC);
  assert.equal(runtime.enabled, true);
  assert.deepEqual(runtime.env_vars, FIREBASE_CODEX_FORWARDED_ENV_VARS);
  assert.notEqual(runtime.env_vars, FIREBASE_CODEX_FORWARDED_ENV_VARS);
  assert.deepEqual(runtime.enabled_tools, OFFICIAL_FIREBASE_READ_TOOLS);
  assert.notEqual(runtime.enabled_tools, OFFICIAL_FIREBASE_READ_TOOLS);
  assert.equal(runtime.env[FIREBASE_MANAGED_OWNER_ENV], officialFirebaseOwnerSha256(
    projectRoot,
    { platform: "linux" },
  ));
  assert.equal(inspectOfficialFirebaseServer(runtime, {
    expectedProjectRoot: projectRoot,
    client: "codex",
    platform: "linux",
  }).valid, true);

  const toml = [
    "[mcp_servers.firebase]",
    "enabled = true",
    `command = ${JSON.stringify(runtime.command)}`,
    `args = ${JSON.stringify(runtime.args)}`,
    `cwd = ${JSON.stringify(runtime.cwd)}`,
    `startup_timeout_sec = ${runtime.startup_timeout_sec}`,
    `env_vars = ${JSON.stringify(runtime.env_vars)}`,
    `env = { ${Object.entries(runtime.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(", ")} }`,
    `enabled_tools = ${JSON.stringify(runtime.enabled_tools)}`,
    "",
  ].join("\n");
  assert.deepEqual(parseGeneratedCodexFirebaseServer(toml), runtime);
  assert.equal(parseGeneratedCodexFirebaseServer(`${toml}\n[mcp_servers.firebase]\n`), null);
});

test("doctor parses strict client selection and normalizes OpenCode/Codex configs", () => {
  assert.deepEqual(parseDoctorArgs([]), { client: "claude-code", help: false });
  assert.deepEqual(parseDoctorArgs(["--client", "codex"]), { client: "codex", help: false });
  for (const args of [
    ["positional"],
    ["--unknown"],
    ["--client"],
    ["--client", "codxe"],
    ["--client", "codex", "--client", "cursor"],
    ["--help", "--client", "codex"],
  ]) assert.throws(() => parseDoctorArgs(args));

  const openCode = normalizeDoctorMcpConfig(JSON.stringify({
    mcp: {
      firebase: {
        type: "local",
        command: ["node", "/tmp/gateway.js"],
        environment: { MARKER: "x" },
      },
    },
  }), "opencode");
  assert.deepEqual(JSON.parse(openCode).mcpServers.firebase, {
    command: "node",
    args: ["/tmp/gateway.js"],
    env: { MARKER: "x" },
  });
});

test("doctor validates service-account metadata without reading or echoing credential contents", async () => {
  const ownerRoot = path.resolve("/tmp/app-test-ctrl-owner");
  const target = path.resolve("/tmp/firebase-app");
  const credentialPath = path.resolve("/tmp/credential-path-must-not-escape.json");
  const firebase = bindOfficialFirebaseServerOwner(
    buildOfficialFirebaseServer(target, {
      projectRoot: ownerRoot,
      projectSource: "service-account",
      firebaseProjectId: "fixture-project-1",
      serviceAccountPath: credentialPath,
    }),
    ownerRoot,
  );
  const inspection = await inspectOfficialFirebaseConfiguration({
    mcpConfigText: configWith(firebase),
    expectedProjectRoot: ownerRoot,
    ...runtimeInspectionStubs(ownerRoot, target, { credentialPath }),
  });
  assert.equal(inspection.status, "valid");
  assert.equal(inspection.configured, true);
  assert.equal(inspection.firebaseDir, target);
  assert.equal(inspection.projectSource, "service-account");
  assert.ok(inspection.checks.some((item) => /gateway build present/.test(item.label)));
  const preloadCheck = inspection.checks.find(
    (item) => /preload guard present/.test(item.label),
  );
  assert.equal(
    preloadCheck?.detail,
    "project-local dist preload exists as a regular file; doctor does not verify its contents or freshness",
  );
  assert.ok(inspection.checks.some((item) => (
    item.detail.includes("firebase_get_crashlytics_report_guide")
      && item.detail.includes("instead of raw resource reads")
  )));
  assert.equal(JSON.stringify(inspection).includes("firebase_read_resources"), false);
  const runtimeCheck = inspection.checks.find((item) => /runtime pinned/.test(item.label));
  assert.equal(
    runtimeCheck?.detail,
    "package.json exact pin, installed manifest version, and CLI entry are present; no lockfile or remote call was checked",
  );
  assert.ok(inspection.checks.some((item) => /credential path is protected/.test(item.label)));
  assert.ok(inspection.checks.some((item) => /low-sensitivity/.test(item.label)));
  assert.equal(JSON.stringify(inspection).includes(credentialPath), false);

  const missingPreload = await inspectOfficialFirebaseConfiguration({
    mcpConfigText: configWith(firebase),
    expectedProjectRoot: ownerRoot,
    ...runtimeInspectionStubs(ownerRoot, target, {
      credentialPath,
      preloadPresent: false,
    }),
  });
  assert.equal(missingPreload.status, "invalid");
  assert.equal(missingPreload.configured, false);
  assert.ok(missingPreload.checks.some((item) => /preload guard missing/.test(item.label)));

  const privateKeySentinel = "PRIVATE_KEY_MUST_NOT_ESCAPE_DOCTOR";
  const unsafeInspection = await inspectOfficialFirebaseConfiguration({
    mcpConfigText: configWith(firebase),
    expectedProjectRoot: ownerRoot,
    ...runtimeInspectionStubs(ownerRoot, target, { credentialPath }),
    fileLstat: async () => {
      throw new Error(`${credentialPath}:${privateKeySentinel}`);
    },
  });
  assert.equal(unsafeInspection.status, "invalid");
  assert.equal(unsafeInspection.configured, false);
  assert.equal(JSON.stringify(unsafeInspection).includes(credentialPath), false);
  assert.equal(JSON.stringify(unsafeInspection).includes(privateKeySentinel), false);
});

test("doctor validates the selected firebaserc profile without remote access", async () => {
  const ownerRoot = path.resolve("/tmp/app-test-ctrl-owner");
  const target = path.resolve("/tmp/firebase-app");
  const firebasercText = `${JSON.stringify({
    projects: { default: "fixture-project-1" },
  })}\n`;
  const firebase = bindOfficialFirebaseServerOwner(
    buildOfficialFirebaseServer(target, {
      projectRoot: ownerRoot,
      projectSource: "firebaserc",
    }),
    ownerRoot,
  );
  const inspection = await inspectOfficialFirebaseConfiguration({
    mcpConfigText: configWith(firebase),
    expectedProjectRoot: ownerRoot,
    ...runtimeInspectionStubs(ownerRoot, target, { firebasercText }),
  });
  assert.equal(inspection.status, "valid");
  assert.equal(inspection.configured, true);
  assert.equal(inspection.firebaseDir, target);
  assert.equal(inspection.projectSource, "firebaserc");
  assert.ok(inspection.checks.some((item) => /project binding present/.test(item.label)));
});

test("doctor reports an unselected Firebase profile as unconfigured, never ready", async () => {
  const ownerRoot = path.resolve("/tmp/app-test-ctrl-owner");
  const target = path.resolve("/tmp/firebase-app");
  const firebase = bindOfficialFirebaseServerOwner(
    buildOfficialFirebaseServer(target, { projectRoot: ownerRoot }),
    ownerRoot,
  );
  const inspection = await inspectOfficialFirebaseConfiguration({
    mcpConfigText: configWith(firebase),
    expectedProjectRoot: ownerRoot,
    ...runtimeInspectionStubs(ownerRoot, target),
  });
  assert.equal(inspection.status, "unconfigured");
  assert.equal(inspection.configured, false);
  assert.equal(inspection.projectSource, null);
});

test("doctor fails closed for missing, unowned, or missing-runtime Firebase config", async () => {
  const ownerRoot = path.resolve("/tmp/app-test-ctrl-owner");
  const missing = await inspectOfficialFirebaseConfiguration({
    mcpConfigText: JSON.stringify({ mcpServers: {} }),
    expectedProjectRoot: ownerRoot,
  });
  assert.equal(missing.status, "missing");

  const unowned = buildOfficialFirebaseServer(null, { projectRoot: ownerRoot });
  const invalid = await inspectOfficialFirebaseConfiguration({
    mcpConfigText: configWith(unowned),
    expectedProjectRoot: ownerRoot,
  });
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.configured, false);

  const owned = bindOfficialFirebaseServerOwner(unowned, ownerRoot);
  const runtimeMissing = await inspectOfficialFirebaseConfiguration({
    mcpConfigText: configWith(owned),
    expectedProjectRoot: ownerRoot,
    fileStat: async () => ({ isDirectory: () => false, isFile: () => false }),
    fileRead: async () => { throw new Error("missing"); },
  });
  assert.equal(runtimeMissing.status, "invalid");
  assert.equal(runtimeMissing.configured, false);
});

test("prewarm only prepares mobile-mcp; Firebase is a project-local lockfile dependency", () => {
  assert.deepEqual(PACKAGES, [{
    label: "mobile-mcp",
    packageName: "@mobilenext/mobile-mcp@latest",
  }]);
  assert.equal(PREWARM_TIMEOUT_MS, 60_000);
  assert.equal(path.isAbsolute(PROJECT_NPM_CACHE), true);
  const cacheDir = path.join(path.resolve(HERE, ".."), ".codex", "npm-cache-fixture");
  const options = buildPrewarmSpawnOptions({
    baseEnv: { PATH: "/fixture/bin", NPM_CONFIG_CACHE: "/must/not/win" },
    cacheDir,
  });
  assert.equal(options.shell, false);
  assert.equal(options.timeout, 60_000);
  assert.equal(options.env.NPM_CONFIG_CACHE, cacheDir);
  assert.throws(() => buildPrewarmSpawnOptions({ cacheDir: "relative/cache" }));
});

test("doctor treats blank Cloud Logging as an optional disabled route", async () => {
  const inspection = await inspectCrashlyticsConfiguration({
    shellEnv: {},
    mcpConfigText: JSON.stringify({
      mcpServers: {
        crashlytics: {
          command: "node",
          args: ["server.js"],
          env: {
            CRASHLYTICS_PROVIDER: "cloud_logging",
            CRASHLYTICS_PROJECT_ALLOWLIST: "",
            CRASHLYTICS_APP_ALLOWLIST: "",
          },
        },
      },
    }),
    cloudLoggingOptional: true,
    fileExists: async () => false,
  });
  assert.equal(inspection.status, "valid");
  assert.ok(inspection.checks.some((item) => /Optional Cloud Logging/.test(item.label)));
});
