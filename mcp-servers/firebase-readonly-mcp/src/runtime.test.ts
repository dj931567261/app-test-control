import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  link,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { parseCliArgs } from "./index.js";
import {
  buildFirebaseUpstreamEnvironment,
  buildOfficialFirebaseCliArgs,
  buildOfficialFirebaseSpawnOptions,
  copyPrivateServiceAccountCredential,
  createProjectLockedFirebaseToolCaller,
  FIREBASE_PRIVATE_ROOT_LEASE_FILE,
  FIREBASE_PRIVATE_ROOT_MAX_CANDIDATES,
  FIREBASE_PRIVATE_ROOT_PREFIX,
  FIREBASE_PRIVATE_ROOT_STALE_AFTER_MS,
  FIREBASE_READONLY_PACKAGE_ROOT_ENV,
  FIREBASE_READONLY_PRELOAD_MARKER,
  FIREBASE_TOOLS_VERSION,
  FirebaseUpstreamStageError,
  lockVerifiedRuntimeForProcess,
  preparePrivateFirebaseProjectDirectory,
  sweepStaleOfficialFirebasePrivateRoots,
  verifyFirebaseRuntime,
  writePrivateFirebaseCliProfile,
  writePrivateProjectBinding,
} from "./upstream.js";

async function runtimeFixture(version = FIREBASE_TOOLS_VERSION): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "firebase-readonly-runtime-")),
  );
  const packageRoot = path.join(root, "node_modules", "firebase-tools");
  await mkdir(path.join(packageRoot, "lib", "bin"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ version }), {
    mode: 0o600,
  });
  await writeFile(path.join(packageRoot, "lib", "bin", "firebase.js"), "// fixture\n", {
    mode: 0o600,
  });
  const preloadEntry = path.join(
    root,
    "mcp-servers/firebase-readonly-mcp/dist/readonly-preload.js",
  );
  await mkdir(path.dirname(preloadEntry), { recursive: true, mode: 0o700 });
  await writeFile(preloadEntry, "// fixture preload\n", { mode: 0o600 });
  return root;
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, "expected the operation to reject with an Error");
  return caught.message;
}

test("CLI parsing rejects unknown, positional, duplicate, and relative directory arguments", () => {
  assert.deepEqual(parseCliArgs([]), {
    firebaseDir: undefined,
    projectSource: undefined,
    firebaseProjectId: undefined,
    help: false,
  });
  assert.deepEqual(parseCliArgs([
    "--project-source", "service-account",
    "--project-id", "fixture-project-1",
    "--dir", "/tmp/firebase",
  ]), {
    firebaseDir: "/tmp/firebase",
    projectSource: "service-account",
    firebaseProjectId: "fixture-project-1",
    help: false,
  });
  assert.deepEqual(parseCliArgs([
    "--project-source", "firebaserc",
    "--dir", "/tmp/firebase",
  ]), {
    firebaseDir: "/tmp/firebase",
    projectSource: "firebaserc",
    firebaseProjectId: undefined,
    help: false,
  });
  for (const args of [
    ["positional"],
    ["--unknown"],
    ["--dir"],
    ["--dir", "--help"],
    ["--dir", "/tmp/firebase"],
    ["--dir", "/tmp/a", "--dir", "/tmp/b"],
    ["--project-source"],
    ["--project-source", "--dir", "/tmp/a"],
    ["--project-id"],
    ["--project-id", "--dir", "/tmp/a"],
    ["--project-source", "service-account", "--dir", "/tmp/a"],
    ["--project-source", "firebaserc", "--project-id", "fixture-project-1", "--dir", "/tmp/a"],
    ["--project-source", "service-account", "--project-id", "INVALID", "--dir", "/tmp/a"],
    ["--project-source", "automatic", "--dir", "/tmp/a"],
    ["--project-source", "service-account", "--project-source", "firebaserc", "--dir", "/tmp/a"],
    ["--project-source", "service-account", "--project-id", "fixture-project-1", "--project-id", "fixture-project-2", "--dir", "/tmp/a"],
    ["--project-id", "fixture-project-1"],
    ["--help", "--dir", "/tmp/a"],
    ["--help", "--help"],
  ]) {
    assert.throws(() => parseCliArgs(args));
  }
});

test("explicit project sources resolve and service credentials use a private stable copy", async (t) => {
  const root = await runtimeFixture();
  const appDir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "firebase-readonly-app-")),
  );
  const credential = path.join(root, "service-account.json");
  const privateKeySentinel = "PRIVATE_KEY_MUST_NOT_ESCAPE_RUNTIME_TEST";
  await writeFile(credential, `${privateKeySentinel}\n`, {
    mode: 0o600,
  });
  t.after(async () => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(appDir, { recursive: true, force: true }),
  ]));

  const service = await verifyFirebaseRuntime({
    projectRoot: root,
    firebaseDir: appDir,
    projectSource: "service-account",
    firebaseProjectId: "fixture-project-1",
    env: { GOOGLE_APPLICATION_CREDENTIALS: credential },
  });
  assert.equal(service.projectSource, "service-account");
  assert.equal(service.firebaseProjectId, "fixture-project-1");
  assert.ok(service.serviceAccountCredential);
  const privateRoot = path.join(root, "private-runtime");
  await mkdir(privateRoot, { mode: 0o700 });
  if (process.platform !== "win32") await chmod(privateRoot, 0o700);
  const privateProjectDir = await preparePrivateFirebaseProjectDirectory(privateRoot);
  assert.deepEqual(buildOfficialFirebaseCliArgs(service, privateProjectDir), [
    "--import",
    service.readonlyPreloadEntry,
    service.cliEntry,
    "mcp",
    "--only",
    "crashlytics",
    "--dir",
    privateProjectDir,
  ]);
  assert.equal(buildOfficialFirebaseCliArgs(service, privateProjectDir).includes("--project"), false);
  assert.equal(
    buildOfficialFirebaseCliArgs(service, privateProjectDir).join("\0").includes(appDir),
    false,
  );
  assert.equal(
    buildOfficialFirebaseCliArgs(service, privateProjectDir).join("\0").includes(credential),
    false,
  );
  assert.equal(
    buildOfficialFirebaseCliArgs(service, privateProjectDir).join("\0").includes(privateKeySentinel),
    false,
  );
  const privateCredential = await copyPrivateServiceAccountCredential(
    service.serviceAccountCredential,
    privateRoot,
  );
  const spawnOptions = buildOfficialFirebaseSpawnOptions(
    service,
    { GOOGLE_APPLICATION_CREDENTIALS: credential },
    path.join(root, "private-home"),
    path.join(root, "private-tmp"),
    privateProjectDir,
    privateCredential,
  );
  assert.equal(spawnOptions.cwd, privateProjectDir);
  assert.notEqual(spawnOptions.cwd, appDir);
  assert.notEqual(spawnOptions.cwd, root);
  assert.equal(spawnOptions.env.GOOGLE_APPLICATION_CREDENTIALS, privateCredential);
  assert.equal(
    spawnOptions.env.APP_TEST_CTRL_FIREBASE_READONLY_PRELOAD,
    "official-v1",
  );
  assert.equal(
    spawnOptions.env[FIREBASE_READONLY_PACKAGE_ROOT_ENV],
    service.firebaseToolsPackageRoot,
  );
  assert.notEqual(spawnOptions.env.GOOGLE_APPLICATION_CREDENTIALS, credential);
  assert.equal(await readFile(privateCredential, "utf8"), `${privateKeySentinel}\n`);
  await writeFile(credential, "SOURCE_CHANGED_AFTER_PRIVATE_COPY\n", { mode: 0o600 });
  assert.equal(await readFile(privateCredential, "utf8"), `${privateKeySentinel}\n`);

  await writeFile(
    path.join(appDir, ".firebaserc"),
    `${JSON.stringify({ projects: { default: "fixture-project-2" } })}\n`,
    { mode: 0o600 },
  );
  const cli = await verifyFirebaseRuntime({
    projectRoot: root,
    firebaseDir: appDir,
    projectSource: "firebaserc",
    env: {},
  });
  assert.equal(cli.projectSource, "firebaserc");
  assert.equal(cli.firebaseProjectId, "fixture-project-2");
});

test("service-account source rejects unsafe metadata and conflicting firebaserc aliases", async (t) => {
  const root = await runtimeFixture();
  const appDir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "firebase-readonly-app-")),
  );
  const credential = path.join(root, "service-account.json");
  await writeFile(credential, "opaque\n", { mode: 0o600 });
  t.after(async () => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(appDir, { recursive: true, force: true }),
  ]));
  const base = {
    projectRoot: root,
    firebaseDir: appDir,
    projectSource: "service-account" as const,
    firebaseProjectId: "fixture-project-1",
    env: { GOOGLE_APPLICATION_CREDENTIALS: credential },
  };
  await assert.rejects(
    verifyFirebaseRuntime({ ...base, firebaseProjectId: undefined }),
    /valid Firebase project id/,
  );
  await assert.rejects(
    verifyFirebaseRuntime({ ...base, env: {} }),
    /GOOGLE_APPLICATION_CREDENTIALS/,
  );
  if (process.platform !== "win32") {
    await chmod(credential, 0o644);
    await assert.rejects(
      verifyFirebaseRuntime(base),
      /must not be accessible by group or other/,
    );
    await chmod(credential, 0o600);
  }
  await writeFile(
    path.join(appDir, ".firebaserc"),
    `${JSON.stringify({ projects: { "fixture-project-1": "other-project-1" } })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    verifyFirebaseRuntime(base),
    /would remap the explicit Firebase project id/,
  );
  await writeFile(
    path.join(appDir, ".firebaserc"),
    `${JSON.stringify({ projects: { unrelated: "other-project-1" } })}\n`,
    { mode: 0o600 },
  );
  const verified = await verifyFirebaseRuntime(base);
  assert.equal(verified.firebaseProjectId, "fixture-project-1");
});

test("credential validation rejects linked, empty, oversized, and non-canonical inputs without leaking secrets", async (t) => {
  const root = await runtimeFixture();
  const appDir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "firebase-readonly-app-")),
  );
  t.after(async () => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(appDir, { recursive: true, force: true }),
  ]));
  const privateKeySentinel = "PRIVATE_KEY_MUST_NOT_ESCAPE_REJECTION";
  const credential = path.join(root, "credential-secret-name.json");
  const base = {
    projectRoot: root,
    firebaseDir: appDir,
    projectSource: "service-account" as const,
    firebaseProjectId: "fixture-project-1",
  };

  const missingPath = path.join(root, "missing-credential-secret-name.json");
  const missingMessage = await rejectionMessage(verifyFirebaseRuntime({
    ...base,
    env: { GOOGLE_APPLICATION_CREDENTIALS: missingPath },
  }));
  assert.equal(missingMessage.includes(missingPath), false);
  assert.equal(missingMessage.includes("missing-credential-secret-name"), false);

  await writeFile(credential, "", { mode: 0o600 });
  let message = await rejectionMessage(verifyFirebaseRuntime({
    ...base,
    env: { GOOGLE_APPLICATION_CREDENTIALS: credential },
  }));
  assert.equal(message.includes(credential), false);

  await writeFile(credential, `${privateKeySentinel}\n`, { mode: 0o600 });
  const linkedCredential = path.join(root, "linked-credential.json");
  await symlink(credential, linkedCredential);
  message = await rejectionMessage(verifyFirebaseRuntime({
    ...base,
    env: { GOOGLE_APPLICATION_CREDENTIALS: linkedCredential },
  }));
  assert.equal(message.includes(linkedCredential), false);
  assert.equal(message.includes(privateKeySentinel), false);
  await rm(linkedCredential);

  const secondLink = path.join(root, "credential-hardlink.json");
  await link(credential, secondLink);
  message = await rejectionMessage(verifyFirebaseRuntime({
    ...base,
    env: { GOOGLE_APPLICATION_CREDENTIALS: credential },
  }));
  assert.equal(message.includes(credential), false);
  assert.equal(message.includes(privateKeySentinel), false);
  await rm(secondLink);

  await writeFile(credential, Buffer.alloc(65 * 1024, 0x78), { mode: 0o600 });
  message = await rejectionMessage(verifyFirebaseRuntime({
    ...base,
    env: { GOOGLE_APPLICATION_CREDENTIALS: credential },
  }));
  assert.equal(message.includes(credential), false);
  assert.equal(message.includes(privateKeySentinel), false);
});

test("service-account private copy rejects identity drift after runtime verification", async (t) => {
  const root = await runtimeFixture();
  const appDir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "firebase-readonly-app-")),
  );
  const credential = path.join(root, "service-account.json");
  await writeFile(credential, "ORIGINAL_PRIVATE_CREDENTIAL\n", { mode: 0o600 });
  t.after(async () => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(appDir, { recursive: true, force: true }),
  ]));

  const runtime = await verifyFirebaseRuntime({
    projectRoot: root,
    firebaseDir: appDir,
    projectSource: "service-account",
    firebaseProjectId: "fixture-project-1",
    env: { GOOGLE_APPLICATION_CREDENTIALS: credential },
  });
  assert.ok(runtime.serviceAccountCredential);
  await rm(credential);
  const replacementSentinel = "REPLACEMENT_PRIVATE_CREDENTIAL_MUST_NOT_COPY";
  await writeFile(credential, `${replacementSentinel}\n`, { mode: 0o600 });
  const privateRoot = path.join(root, "private-runtime");
  await mkdir(privateRoot, { mode: 0o700 });
  const message = await rejectionMessage(copyPrivateServiceAccountCredential(
    runtime.serviceAccountCredential,
    privateRoot,
  ));
  assert.match(message, /changed before private copy/);
  assert.equal(message.includes(credential), false);
  assert.equal(message.includes(replacementSentinel), false);
});

test("firebaserc source fails closed on missing, malformed, unsafe, or ambiguous project binding", async (t) => {
  const root = await runtimeFixture();
  const appDir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "firebase-readonly-app-")),
  );
  t.after(async () => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(appDir, { recursive: true, force: true }),
  ]));
  const rcPath = path.join(appDir, ".firebaserc");
  const base = {
    projectRoot: root,
    firebaseDir: appDir,
    projectSource: "firebaserc" as const,
    env: {},
  };

  await assert.rejects(verifyFirebaseRuntime(base), /\.firebaserc/);
  const contentSentinel = "FIREBASERC_CONTENT_MUST_NOT_ESCAPE";
  await writeFile(rcPath, `{${contentSentinel}`, { mode: 0o600 });
  let message = await rejectionMessage(verifyFirebaseRuntime(base));
  assert.equal(message.includes(contentSentinel), false);
  assert.equal(message.includes(appDir), false);

  for (const value of [
    {},
    { projects: {} },
    { projects: { default: "INVALID" } },
    { projects: { default: ["fixture-project-1"] } },
  ]) {
    await writeFile(rcPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await assert.rejects(verifyFirebaseRuntime(base), /valid Firebase project id/);
  }
  await writeFile(
    rcPath,
    `${JSON.stringify({
      projects: {
        default: "fixture-project-1",
        "fixture-project-1": "other-project-1",
      },
    })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(verifyFirebaseRuntime(base), /would remap/);

  await rm(rcPath);
  const target = path.join(appDir, "actual-firebaserc.json");
  await writeFile(
    target,
    `${JSON.stringify({ projects: { default: "fixture-project-1" } })}\n`,
    { mode: 0o600 },
  );
  await symlink(target, rcPath);
  message = await rejectionMessage(verifyFirebaseRuntime(base));
  assert.equal(message.includes(target), false);
  assert.equal(message.includes(appDir), false);
  await rm(rcPath);

  if (process.platform !== "win32") {
    await writeFile(
      rcPath,
      `${JSON.stringify({ projects: { default: "fixture-project-1" } })}\n`,
      { mode: 0o600 },
    );
    await chmod(rcPath, 0o666);
    await assert.rejects(verifyFirebaseRuntime(base), /must not be writable by group or other/);
    await rm(rcPath);
  }

  await writeFile(rcPath, Buffer.alloc(65 * 1024, 0x78), { mode: 0o600 });
  await assert.rejects(verifyFirebaseRuntime(base), /exceeded the byte limit/);
});

test("process profile lock rejects firebaserc project drift across upstream recreation", async (t) => {
  const root = await runtimeFixture();
  const appDir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "firebase-readonly-app-")),
  );
  const rcPath = path.join(appDir, ".firebaserc");
  t.after(async () => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(appDir, { recursive: true, force: true }),
  ]));
  const options = {
    projectRoot: root,
    firebaseDir: appDir,
    projectSource: "firebaserc" as const,
    env: {},
  };

  await writeFile(
    rcPath,
    `${JSON.stringify({ projects: { default: "fixture-project-1" } })}\n`,
    { mode: 0o600 },
  );
  const initial = await verifyFirebaseRuntime(options);
  lockVerifiedRuntimeForProcess(options, initial);

  await writeFile(
    rcPath,
    `${JSON.stringify({ projects: { default: "other-project-1" } })}\n`,
    { mode: 0o600 },
  );
  const drifted = await verifyFirebaseRuntime(options);
  await assert.rejects(
    Promise.resolve().then(() => lockVerifiedRuntimeForProcess(options, drifted)),
    /connection profile changed/,
  );
});

test("connection profiles isolate authentication environment and private project binding", async (t) => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "firebase-private-binding-")),
  );
  t.after(async () => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const temp = path.join(root, "tmp");
  const firebaseToolsPackageRoot = path.join(root, "node_modules/firebase-tools");
  await Promise.all([mkdir(home), mkdir(temp)]);
  const hostEnv = {
    HOME: "/host/home",
    XDG_CONFIG_HOME: "/host/config",
    GOOGLE_APPLICATION_CREDENTIALS: "/private/credential.json",
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/must/not/pass.json",
    FIREBASE_TOKEN: "must-not-pass",
    GOOGLE_CLOUD_PROJECT: "must-not-pass",
    GCLOUD_PROJECT: "must-not-pass-either",
    APP_TEST_CTRL_FIREBASE_READONLY_PRELOAD: "host-must-not-pass",
    [FIREBASE_READONLY_PACKAGE_ROOT_ENV]: "/host/must-not-pass",
    PATH: "/fixture/bin",
  };
  const service = buildFirebaseUpstreamEnvironment(
    hostEnv,
    home,
    temp,
    "service-account",
    firebaseToolsPackageRoot,
    "/private/runtime/service-account.json",
  );
  assert.equal(
    service.GOOGLE_APPLICATION_CREDENTIALS,
    "/private/runtime/service-account.json",
  );
  assert.notEqual(
    service.GOOGLE_APPLICATION_CREDENTIALS,
    hostEnv.GOOGLE_APPLICATION_CREDENTIALS,
  );
  assert.equal(service.XDG_CONFIG_HOME, path.join(home, ".config"));
  assert.equal(service.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE, undefined);
  assert.equal(service.FIREBASE_TOKEN, undefined);
  assert.equal(service.GOOGLE_CLOUD_PROJECT, undefined);
  assert.equal(service.GCLOUD_PROJECT, undefined);
  assert.equal(service.METADATA_SERVER_DETECTION, "none");
  assert.equal(
    service.APP_TEST_CTRL_FIREBASE_READONLY_PRELOAD,
    FIREBASE_READONLY_PRELOAD_MARKER,
  );
  assert.notEqual(
    service.APP_TEST_CTRL_FIREBASE_READONLY_PRELOAD,
    hostEnv.APP_TEST_CTRL_FIREBASE_READONLY_PRELOAD,
  );
  assert.equal(
    service[FIREBASE_READONLY_PACKAGE_ROOT_ENV],
    firebaseToolsPackageRoot,
  );
  assert.notEqual(
    service[FIREBASE_READONLY_PACKAGE_ROOT_ENV],
    hostEnv[FIREBASE_READONLY_PACKAGE_ROOT_ENV],
  );
  assert.equal(service.HOME, home);
  assert.equal(service.TMPDIR, temp);

  const cli = buildFirebaseUpstreamEnvironment(
    hostEnv,
    home,
    temp,
    "firebaserc",
    firebaseToolsPackageRoot,
  );
  assert.equal(cli.XDG_CONFIG_HOME, path.join(home, ".config"));
  assert.notEqual(cli.XDG_CONFIG_HOME, "/host/config");
  assert.equal(cli.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(cli.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE, undefined);
  assert.equal(cli.FIREBASE_TOKEN, undefined);
  assert.equal(cli.GOOGLE_CLOUD_PROJECT, undefined);
  assert.equal(cli.GCLOUD_PROJECT, undefined);
  assert.equal(cli.METADATA_SERVER_DETECTION, "none");
  assert.equal(
    cli.APP_TEST_CTRL_FIREBASE_READONLY_PRELOAD,
    FIREBASE_READONLY_PRELOAD_MARKER,
  );
  assert.throws(
    () => buildFirebaseUpstreamEnvironment(
      hostEnv,
      home,
      temp,
      "service-account",
      firebaseToolsPackageRoot,
    ),
    /private service account credential copy is required/,
  );
  assert.throws(
    () => buildFirebaseUpstreamEnvironment(
      hostEnv,
      home,
      temp,
      "firebaserc",
      firebaseToolsPackageRoot,
      "/private/runtime/service-account.json",
    ),
    /must not receive a service account credential/,
  );

  await writePrivateProjectBinding(
    path.join(home, ".config"),
    "/fixture/app",
    "fixture-project-1",
  );
  const privateConfig = JSON.parse(await readFile(
    path.join(home, ".config", "configstore", "firebase-tools.json"),
    "utf8",
  ));
  assert.deepEqual(privateConfig, {
    activeProjects: { "/fixture/app": "fixture-project-1" },
  });
  const configPath = path.join(home, ".config", "configstore", "firebase-tools.json");
  const [configMetadata, directoryMetadata] = await Promise.all([
    lstat(configPath),
    lstat(path.dirname(configPath)),
  ]);
  if (process.platform !== "win32") {
    assert.equal(configMetadata.mode & 0o777, 0o600);
    assert.equal(directoryMetadata.mode & 0o777, 0o700);
  }
  const serialized = JSON.stringify(privateConfig);
  assert.equal(serialized.includes(hostEnv.GOOGLE_APPLICATION_CREDENTIALS), false);
  assert.equal(serialized.includes(hostEnv.FIREBASE_TOKEN), false);

  const sourceConfigHome = path.join(root, "host-config");
  const sourceConfigstore = path.join(sourceConfigHome, "configstore");
  await mkdir(sourceConfigstore, { recursive: true, mode: 0o700 });
  const defaultTokenSentinel = "DEFAULT_REFRESH_TOKEN_MUST_NOT_BE_COPIED";
  const selectedTokenSentinel = "SELECTED_REFRESH_TOKEN_PRIVATE_COPY";
  await writeFile(
    path.join(sourceConfigstore, "firebase-tools.json"),
    `${JSON.stringify({
      user: { email: "default@example.test", ignored: "drop-me" },
      tokens: { refresh_token: defaultTokenSentinel, ignored: "drop-me" },
      additionalAccounts: [{
        user: { email: "selected@example.test", ignored: "drop-me" },
        tokens: {
          refresh_token: selectedTokenSentinel,
          access_token: "bounded-access-token",
          expires_at: 4_000_000_000_000,
          scopes: ["scope-a"],
          ignored: "drop-me",
        },
      }],
      activeAccounts: { "/fixture/app": "selected@example.test" },
      activeProjects: { "/fixture/app": "host-project-must-not-win" },
      unrelated: "drop-me",
    })}\n`,
    { mode: 0o600 },
  );
  const firePrivateConfigHome = path.join(root, "fire-private-config");
  const isolatedProjectDir = "/fixture/private-upstream-project";
  await writePrivateFirebaseCliProfile(
    sourceConfigHome,
    firePrivateConfigHome,
    "/fixture/app",
    isolatedProjectDir,
    "fixture-project-1",
  );
  const firePrivateConfigText = await readFile(
    path.join(firePrivateConfigHome, "configstore", "firebase-tools.json"),
    "utf8",
  );
  const firePrivateConfig = JSON.parse(firePrivateConfigText);
  assert.deepEqual(firePrivateConfig, {
    user: { email: "selected@example.test" },
    tokens: {
      refresh_token: selectedTokenSentinel,
      access_token: "bounded-access-token",
      expires_at: 4_000_000_000_000,
      scopes: ["scope-a"],
    },
    activeProjects: { [isolatedProjectDir]: "fixture-project-1" },
  });
  assert.equal(firePrivateConfigText.includes(defaultTokenSentinel), false);
  assert.equal(firePrivateConfigText.includes("host-project-must-not-win"), false);
  assert.equal(firePrivateConfigText.includes("drop-me"), false);

  const sourceConfigPath = path.join(sourceConfigstore, "firebase-tools.json");
  await writeFile(
    sourceConfigPath,
    `${JSON.stringify({
      user: { email: "default@example.test" },
      tokens: { refresh_token: defaultTokenSentinel },
      additionalAccounts: [{
        user: { email: "selected@example.test" },
        tokens: { refresh_token: selectedTokenSentinel },
      }],
    })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    writePrivateFirebaseCliProfile(
      sourceConfigHome,
      path.join(root, "ambiguous-fire-private-config"),
      "/fixture/app",
      isolatedProjectDir,
      "fixture-project-1",
    ),
    /active account binding is required/,
  );

  await writeFile(
    sourceConfigPath,
    `${JSON.stringify({
      user: { email: "only@example.test" },
      tokens: { refresh_token: "ONLY_ACCOUNT_REFRESH_TOKEN" },
    })}\n`,
    { mode: 0o600 },
  );
  const singleAccountEmail = await writePrivateFirebaseCliProfile(
    sourceConfigHome,
    path.join(root, "single-fire-private-config"),
    "/fixture/app",
    isolatedProjectDir,
    "fixture-project-1",
  );
  assert.equal(singleAccountEmail, "only@example.test");
  await assert.rejects(
    writePrivateFirebaseCliProfile(
      sourceConfigHome,
      path.join(root, "drifted-fire-private-config"),
      "/fixture/app",
      isolatedProjectDir,
      "fixture-project-1",
      "different@example.test",
    ),
    /selected account changed/,
  );
  if (process.platform !== "win32") {
    await chmod(sourceConfigPath, 0o644);
    const message = await rejectionMessage(writePrivateFirebaseCliProfile(
      sourceConfigHome,
      path.join(root, "rejected-fire-private-config"),
      "/fixture/app",
      isolatedProjectDir,
      "fixture-project-1",
    ));
    assert.match(message, /must not be accessible by group or other/);
    assert.equal(message.includes(sourceConfigPath), false);
    assert.equal(message.includes(selectedTokenSentinel), false);
    await chmod(sourceConfigPath, 0o600);
  }
});

test("private project root prevents runtime firebaserc alias remapping", async (t) => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "firebase-private-resolution-")),
  );
  t.after(async () => rm(root, { recursive: true, force: true }));
  const appDir = path.join(root, "app");
  const privateRoot = path.join(root, "managed-private-root");
  const home = path.join(root, "home");
  const configHome = path.join(home, ".config");
  await Promise.all([
    mkdir(appDir),
    mkdir(privateRoot, { mode: 0o700 }),
    mkdir(home),
  ]);
  if (process.platform !== "win32") await chmod(privateRoot, 0o700);
  const privateProjectDir = await preparePrivateFirebaseProjectDirectory(privateRoot);
  await writePrivateProjectBinding(configHome, privateProjectDir, "fixture-project-1");

  const commandModule = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../node_modules/firebase-tools/lib/command.js",
  );
  const childScript = `
    const { Command } = require(${JSON.stringify(commandModule)});
    (async () => {
      const options = { cwd: process.cwd(), isMCP: true };
      await new Command("mcp").prepare(options);
      process.stdout.write(String(options.projectId || ""));
    })().catch(() => process.exit(1));
  `;
  const runResolver = () => promisify(execFile)(process.execPath, ["-e", childScript], {
    cwd: privateProjectDir,
    env: {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: configHome,
      PATH: process.env.PATH ?? "",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
    },
    timeout: 5_000,
  });
  assert.equal((await runResolver()).stdout, "fixture-project-1");

  await writeFile(
    path.join(appDir, ".firebaserc"),
    `${JSON.stringify({
      projects: {
        default: "other-project-1",
        "fixture-project-1": "other-project-1",
      },
    })}\n`,
    { mode: 0o600 },
  );
  assert.equal((await runResolver()).stdout, "fixture-project-1");
  assert.equal(await readFile(path.join(privateProjectDir, "firebase.json"), "utf8"), "{}\n");
  await assert.rejects(readFile(path.join(privateProjectDir, ".firebaserc"), "utf8"), /ENOENT/);
});

test("startup sweep removes only old dead strictly managed private roots", async (t) => {
  const tempRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "firebase-private-sweep-")),
  );
  t.after(async () => rm(tempRoot, { recursive: true, force: true }));
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    assert.equal(await sweepStaleOfficialFirebasePrivateRoots(tempRoot), 0);
    return;
  }

  const now = Date.now();
  const stale = now - FIREBASE_PRIVATE_ROOT_STALE_AFTER_MS - 60_000;
  const deadPid = 2_147_483_647;
  const createCandidate = async (
    suffix: string,
    options: {
      pid?: number;
      createdAt?: number;
      directoryMode?: number;
      leaseMode?: number;
      validLease?: boolean;
      prefix?: string;
    } = {},
  ) => {
    const candidate = path.join(
      tempRoot,
      `${options.prefix ?? FIREBASE_PRIVATE_ROOT_PREFIX}${suffix}`,
    );
    await mkdir(candidate, { mode: options.directoryMode ?? 0o700 });
    await chmod(candidate, options.directoryMode ?? 0o700);
    const leasePath = path.join(candidate, FIREBASE_PRIVATE_ROOT_LEASE_FILE);
    await writeFile(
      leasePath,
      options.validLease === false
        ? "not-json\n"
        : `${JSON.stringify({
          schema: "app-test-ctrl/firebase-private-root/v1",
          pid: options.pid ?? deadPid,
          created_at_ms: options.createdAt ?? stale,
        })}\n`,
      { mode: options.leaseMode ?? 0o600 },
    );
    await chmod(leasePath, options.leaseMode ?? 0o600);
    await mkdir(path.join(candidate, "credentials"), { mode: 0o700 });
    await writeFile(path.join(candidate, "credentials", "secret.json"), "opaque\n", {
      mode: 0o600,
    });
    const timestamp = new Date(options.createdAt ?? stale);
    await utimes(leasePath, timestamp, timestamp);
    await utimes(candidate, timestamp, timestamp);
    return candidate;
  };

  const removable = await createCandidate("ABC123");
  const live = await createCandidate("ABC124", { pid: process.pid });
  const fresh = await createCandidate("ABC125", { createdAt: now });
  const malformed = await createCandidate("ABC126", { validLease: false });
  const permissive = await createCandidate("ABC127", { directoryMode: 0o755 });
  const wrongPrefix = await createCandidate("ABC128", { prefix: "unrelated-firebase-" });
  const unmarked = path.join(tempRoot, `${FIREBASE_PRIVATE_ROOT_PREFIX}ABC129`);
  await mkdir(unmarked, { mode: 0o700 });
  await chmod(unmarked, 0o700);
  await utimes(unmarked, new Date(stale), new Date(stale));

  assert.equal(await sweepStaleOfficialFirebasePrivateRoots(tempRoot, now), 1);
  await assert.rejects(lstat(removable), /ENOENT/);
  for (const retained of [live, fresh, malformed, permissive, wrongPrefix, unmarked]) {
    assert.equal((await lstat(retained)).isDirectory(), true);
  }
});

test("startup sweep stops safely at the managed-candidate cap", async (t) => {
  const tempRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "firebase-private-sweep-cap-")),
  );
  t.after(async () => rm(tempRoot, { recursive: true, force: true }));
  if (process.platform === "win32" || typeof process.getuid !== "function") return;

  const now = Date.now();
  const stale = now - FIREBASE_PRIVATE_ROOT_STALE_AFTER_MS - 60_000;
  const timestamp = new Date(stale);
  const candidates: string[] = [];
  for (let index = 0; index < FIREBASE_PRIVATE_ROOT_MAX_CANDIDATES + 1; index += 1) {
    const suffix = `B${String(index).padStart(5, "0")}`;
    const candidate = path.join(tempRoot, `${FIREBASE_PRIVATE_ROOT_PREFIX}${suffix}`);
    candidates.push(candidate);
    await mkdir(candidate, { mode: 0o700 });
    await chmod(candidate, 0o700);
    const leasePath = path.join(candidate, FIREBASE_PRIVATE_ROOT_LEASE_FILE);
    await writeFile(leasePath, `${JSON.stringify({
      schema: "app-test-ctrl/firebase-private-root/v1",
      pid: 2_147_483_647,
      created_at_ms: stale,
    })}\n`, { mode: 0o600 });
    await chmod(leasePath, 0o600);
    await utimes(leasePath, timestamp, timestamp);
    await utimes(candidate, timestamp, timestamp);
  }

  assert.equal(
    await sweepStaleOfficialFirebasePrivateRoots(tempRoot, now),
    FIREBASE_PRIVATE_ROOT_MAX_CANDIDATES,
  );
  let retained = 0;
  for (const candidate of candidates) {
    try {
      await lstat(candidate);
      retained += 1;
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    }
  }
  assert.equal(retained, 1);
});

test("startup sweep stops safely at an injected lower entry cap", async (t) => {
  const tempRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "firebase-private-sweep-entry-cap-")),
  );
  t.after(async () => rm(tempRoot, { recursive: true, force: true }));
  if (process.platform === "win32" || typeof process.getuid !== "function") return;

  const now = Date.now();
  const stale = now - FIREBASE_PRIVATE_ROOT_STALE_AFTER_MS - 60_000;
  const timestamp = new Date(stale);
  const candidates: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const candidate = path.join(tempRoot, `${FIREBASE_PRIVATE_ROOT_PREFIX}C0000${index}`);
    candidates.push(candidate);
    await mkdir(candidate, { mode: 0o700 });
    await chmod(candidate, 0o700);
    const leasePath = path.join(candidate, FIREBASE_PRIVATE_ROOT_LEASE_FILE);
    await writeFile(leasePath, `${JSON.stringify({
      schema: "app-test-ctrl/firebase-private-root/v1",
      pid: 2_147_483_647,
      created_at_ms: stale,
    })}\n`, { mode: 0o600 });
    await chmod(leasePath, 0o600);
    await utimes(leasePath, timestamp, timestamp);
    await utimes(candidate, timestamp, timestamp);
  }

  assert.equal(
    await sweepStaleOfficialFirebasePrivateRoots(tempRoot, now, {
      maxScanEntries: 2,
      maxCandidates: FIREBASE_PRIVATE_ROOT_MAX_CANDIDATES,
    }),
    2,
  );
  let retained = 0;
  for (const candidate of candidates) {
    try {
      await lstat(candidate);
      retained += 1;
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    }
  }
  assert.equal(retained, 1);
});

test("project lock rejects cross-project app ids and cross-app event resources before forwarding", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const projectResult = (projectId = "fixture-project-1", projectNumber = "123456789") => ({
    content: [{ type: "text", text: `projectId: ${projectId}\nprojectNumber: '${projectNumber}'\n` }],
    structuredContent: { projectId, projectNumber, displayName: "Fixture" },
  });
  const callUpstream = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "firebase_get_project") return projectResult();
    return { content: [{ type: "text", text: "ok" }] };
  };
  const call = createProjectLockedFirebaseToolCaller(
    callUpstream,
    "fixture-project-1",
  );
  const appId = "1:123456789:android:abcdef123456";

  await call("crashlytics_get_issue", { appId, issueId: "issue-1234" });
  assert.deepEqual(calls.map((item) => item.name), [
    "firebase_get_project",
    "crashlytics_get_issue",
  ]);

  const beforeCrossProject = calls.length;
  await assert.rejects(
    call("crashlytics_get_issue", {
      appId: "1:987654321:android:abcdef123456",
      issueId: "issue-1234",
    }),
    /escaped the locked project/,
  );
  assert.equal(calls.length, beforeCrossProject);

  const validEvent = `projects/123456789/apps/${appId}/events/event-1234`;
  await call("crashlytics_batch_get_events", { appId, names: [validEvent] });
  assert.equal(calls.at(-1)?.name, "crashlytics_batch_get_events");

  for (const invalidEvent of [
    `projects/987654321/apps/${appId}/events/event-1234`,
    "projects/123456789/apps/1:123456789:android:otherapp/events/event-1234",
    `projects/123456789/apps/${appId}/events/nested/event-1234`,
    `projects/123456789/apps/${appId}/events/`,
  ]) {
    const before = calls.length;
    await assert.rejects(
      call("crashlytics_batch_get_events", { appId, names: [invalidEvent] }),
      /event resource escaped the locked app/,
    );
    assert.equal(calls.length, before);
  }
});

test("project lock fails closed on mismatched, malformed, or process-drifted identity", async () => {
  const response = (structuredContent?: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: "bounded identity" }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
  });
  for (const projectResponse of [
    response({ projectId: "other-project-1", projectNumber: "123456789" }),
    response({ projectId: "fixture-project-1", projectNumber: "not-a-number" }),
    response(),
  ]) {
    const calls: string[] = [];
    const call = createProjectLockedFirebaseToolCaller(async (name) => {
      calls.push(name);
      if (name === "firebase_get_project") return projectResponse;
      return { content: [{ type: "text", text: "must-not-run" }] };
    }, "fixture-project-1");
    await assert.rejects(
      call("crashlytics_get_issue", {
        appId: "1:123456789:android:abcdef123456",
        issueId: "issue-1234",
      }),
      (error: unknown) => error instanceof FirebaseUpstreamStageError
        && error.stage === "identity_validation",
    );
    assert.deepEqual(calls, ["firebase_get_project"]);
  }

  const processLock = { projectNumber: "111111111" };
  const calls: string[] = [];
  const call = createProjectLockedFirebaseToolCaller(async (name) => {
    calls.push(name);
    return response({ projectId: "fixture-project-1", projectNumber: "222222222" });
  }, "fixture-project-1", processLock);
  await assert.rejects(
    call("firebase_get_project", {}),
    (error: unknown) => error instanceof FirebaseUpstreamStageError
      && error.stage === "identity_validation",
  );
  assert.deepEqual(calls, ["firebase_get_project"]);
});

test("unconfigured runtime and directory-only runtime fail before ambient authentication", async (t) => {
  const root = await runtimeFixture();
  const appDir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "firebase-readonly-app-")),
  );
  t.after(async () => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(appDir, { recursive: true, force: true }),
  ]));
  const secretCredentialPath = path.join(root, "ambient-credential-must-not-run.json");
  const ambientEnv = {
    GOOGLE_APPLICATION_CREDENTIALS: secretCredentialPath,
    FIREBASE_TOKEN: "ambient-token-must-not-run",
    XDG_CONFIG_HOME: path.join(root, "ambient-firebase-login"),
  };

  for (const options of [
    { projectRoot: root, env: ambientEnv },
    { projectRoot: root, firebaseDir: appDir, env: ambientEnv },
  ]) {
    const message = await rejectionMessage(verifyFirebaseRuntime(options));
    assert.match(message, /project source|connection profile/i);
    assert.equal(message.includes(secretCredentialPath), false);
    assert.equal(message.includes(ambientEnv.FIREBASE_TOKEN), false);
  }
});

test("runtime requires the exact project-local firebase-tools package and regular CLI entry", async (t) => {
  const root = await runtimeFixture();
  const appDir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "firebase-readonly-app-")),
  );
  await writeFile(
    path.join(appDir, ".firebaserc"),
    `${JSON.stringify({ projects: { default: "fixture-project-1" } })}\n`,
    { mode: 0o600 },
  );
  const profile = { firebaseDir: appDir, projectSource: "firebaserc" as const, env: {} };
  t.after(async () => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(appDir, { recursive: true, force: true }),
  ]));
  const verified = await verifyFirebaseRuntime({ projectRoot: root, ...profile });
  const canonicalRoot = await realpath(root);
  assert.equal(verified.projectRoot, canonicalRoot);
  assert.equal(
    verified.cliEntry,
    path.join(canonicalRoot, "node_modules/firebase-tools/lib/bin/firebase.js"),
  );
  assert.equal(
    verified.readonlyPreloadEntry,
    path.join(
      canonicalRoot,
      "mcp-servers/firebase-readonly-mcp/dist/readonly-preload.js",
    ),
  );

  const wrong = await runtimeFixture("15.24.1");
  t.after(async () => rm(wrong, { recursive: true, force: true }));
  await assert.rejects(
    verifyFirebaseRuntime({ projectRoot: wrong, ...profile }),
    /exactly 15\.24\.0/,
  );

  const linked = await runtimeFixture();
  t.after(async () => rm(linked, { recursive: true, force: true }));
  const entry = path.join(linked, "node_modules/firebase-tools/lib/bin/firebase.js");
  await rm(entry);
  await symlink(path.join(linked, "node_modules/firebase-tools/package.json"), entry);
  await assert.rejects(
    verifyFirebaseRuntime({ projectRoot: linked, ...profile }),
    /canonical regular file/,
  );

  const linkedPreload = await runtimeFixture();
  t.after(async () => rm(linkedPreload, { recursive: true, force: true }));
  const preloadEntry = path.join(
    linkedPreload,
    "mcp-servers/firebase-readonly-mcp/dist/readonly-preload.js",
  );
  await rm(preloadEntry);
  await symlink(
    path.join(linkedPreload, "node_modules/firebase-tools/package.json"),
    preloadEntry,
  );
  await assert.rejects(
    verifyFirebaseRuntime({ projectRoot: linkedPreload, ...profile }),
    /read-only preload entry must be a canonical regular file/,
  );

  if (process.platform !== "win32") {
    const writablePreload = await runtimeFixture();
    t.after(async () => rm(writablePreload, { recursive: true, force: true }));
    await chmod(
      path.join(
        writablePreload,
        "mcp-servers/firebase-readonly-mcp/dist/readonly-preload.js",
      ),
      0o622,
    );
    await assert.rejects(
      verifyFirebaseRuntime({ projectRoot: writablePreload, ...profile }),
      /read-only preload entry must not be writable by group or other/,
    );
  }
});

test("runtime reads the pinned package manifest through bounded stable UTF-8 identity", async (t) => {
  const appDir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "firebase-readonly-app-")),
  );
  await writeFile(
    path.join(appDir, ".firebaserc"),
    `${JSON.stringify({ projects: { default: "fixture-project-1" } })}\n`,
    { mode: 0o600 },
  );
  const profile = { firebaseDir: appDir, projectSource: "firebaserc" as const, env: {} };
  t.after(async () => rm(appDir, { recursive: true, force: true }));
  const oversized = await runtimeFixture();
  t.after(async () => rm(oversized, { recursive: true, force: true }));
  await writeFile(
    path.join(oversized, "node_modules/firebase-tools/package.json"),
    Buffer.alloc(65 * 1024, 0x78),
  );
  await assert.rejects(
    verifyFirebaseRuntime({ projectRoot: oversized, ...profile }),
    /package manifest exceeded the byte limit/,
  );

  const invalidUtf8 = await runtimeFixture();
  t.after(async () => rm(invalidUtf8, { recursive: true, force: true }));
  await writeFile(
    path.join(invalidUtf8, "node_modules/firebase-tools/package.json"),
    Buffer.from([0x7b, 0x22, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x22, 0x3a, 0xff, 0x7d]),
  );
  await assert.rejects(
    verifyFirebaseRuntime({ projectRoot: invalidUtf8, ...profile }),
    /package manifest must contain valid UTF-8/,
  );

  const hardLinked = await runtimeFixture();
  t.after(async () => rm(hardLinked, { recursive: true, force: true }));
  const packageManifest = path.join(hardLinked, "node_modules/firebase-tools/package.json");
  const secondName = path.join(hardLinked, "firebase-tools-package-hardlink.json");
  await link(packageManifest, secondName);
  await assert.rejects(
    verifyFirebaseRuntime({ projectRoot: hardLinked, ...profile }),
    /package manifest must be a canonical regular file with one link/,
  );
});
