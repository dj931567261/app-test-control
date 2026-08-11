import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const preloadSource = path.join(
  projectRoot,
  "mcp-servers/firebase-readonly-mcp/src/readonly-preload.ts",
);

test("pinned Firebase preload permits only the read-only project identity preflight", async () => {
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "firebase-readonly-preload-"));
  const home = path.join(privateRoot, "home");
  await mkdir(home, { mode: 0o700 });
  try {
    const probe = String.raw`
      const ensureApi = require("firebase-tools/lib/ensureApiEnabled.js");
      const apiTransport = require("firebase-tools/lib/apiv2.js");
      const cloudbilling = require("firebase-tools/lib/gcp/cloudbilling.js");
      const track = require("firebase-tools/lib/track.js");
      const { FirebaseMcpServer } = require("firebase-tools/lib/mcp/index.js");
      const requireAuth = require("firebase-tools/lib/requireAuth.js");

      (async () => {
        const billing = await cloudbilling.checkBillingEnabled("fixture-project-1");
        const analytics = await track.trackGA4("must_not_send");
        let ensureRejected = false;
        let bestEffortRejected = false;
        let projectIdentityPreflightAllowed = false;
        let projectIdentityDriftRejected = true;
        try {
          await ensureApi.ensure(
            "fixture-project-1",
            "cloudbilling.googleapis.com",
            "billing",
            true,
          );
        } catch {
          ensureRejected = true;
        }
        try {
          await ensureApi.bestEffortEnsure(
            "fixture-project-1",
            "cloudbilling.googleapis.com",
            "billing",
            true,
          );
        } catch {
          bestEffortRejected = true;
        }
        try {
          await ensureApi.bestEffortEnsure(
            "fixture-project-1",
            "https://cloudresourcemanager.googleapis.com",
            "firebase",
            true,
          );
          projectIdentityPreflightAllowed = true;
        } catch {}
        for (const invalidArgs of [
          [
            "INVALID_PROJECT",
            "https://cloudresourcemanager.googleapis.com",
            "firebase",
            true,
          ],
          [
            "fixture-project-1",
            "https://cloudresourcemanager.googleapis.com",
            "other",
            true,
          ],
          [
            "fixture-project-1",
            "https://cloudresourcemanager.googleapis.com",
            "firebase",
            false,
          ],
          [
            "fixture-project-1",
            "https://cloudresourcemanager.googleapis.com",
            "firebase",
            true,
            "extra",
          ],
        ]) {
          try {
            await ensureApi.bestEffortEnsure(...invalidArgs);
            projectIdentityDriftRejected = false;
          } catch {}
        }
        const featureContext = { activeFeatures: ["crashlytics"] };
        const detectedFeatures = await FirebaseMcpServer.prototype.detectActiveFeatures.call(
          featureContext,
        );
        let featureDriftRejected = false;
        try {
          await FirebaseMcpServer.prototype.detectActiveFeatures.call({
            activeFeatures: ["firestore"],
          });
        } catch {
          featureDriftRejected = true;
        }
        const firebaseCliDisplayName = FirebaseMcpServer.prototype._getFirebaseCliCommand.call({});
        let realAuthenticationCalls = 0;
        requireAuth.requireAuth = async () => {
          realAuthenticationCalls += 1;
          return "fixture@example.invalid";
        };
        const listContext = Object.create(FirebaseMcpServer.prototype);
        listContext.activeFeatures = ["crashlytics"];
        listContext.cachedProjectDir = "/fixture/project";
        listContext.currentLogLevel = undefined;
        listContext.detectProjectRoot = async () => listContext.cachedProjectDir;
        listContext.getProjectId = async () => "fixture-project-1";
        listContext.trackGA4 = async () => undefined;
        let listAuthenticationValue = "not-called";
        let releaseList;
        let markListEntered;
        const listGate = new Promise((resolve) => { releaseList = resolve; });
        const listEntered = new Promise((resolve) => { markListEntered = resolve; });
        listContext.getAvailableTools = async function () {
          listAuthenticationValue = await this.getAuthenticatedUser();
          markListEntered();
          await listGate;
          return [];
        };
        listContext.resolveOptions = async () => ({});
        const listedPromise = FirebaseMcpServer.prototype.mcpListTools.call(listContext);
        await listEntered;
        const authenticationDuringList = await listContext.getAuthenticatedUser();
        releaseList();
        const listed = await listedPromise;
        const authenticationAfterList = await listContext.getAuthenticatedUser();
        let rejectedListAuthenticationValue = "not-called";
        listContext.getAvailableTools = async function () {
          rejectedListAuthenticationValue = await this.getAuthenticatedUser();
          throw new Error("fixture list failure");
        };
        let rejectedListFailed = false;
        try {
          await FirebaseMcpServer.prototype.mcpListTools.call(listContext);
        } catch {
          rejectedListFailed = true;
        }
        const authenticationAfterRejectedList = await listContext.getAuthenticatedUser();
        process.stdout.write(JSON.stringify({
          billing,
          analyticsIsUndefined: analytics === undefined,
          ensureRejected,
          bestEffortRejected,
          projectIdentityPreflightAllowed,
          projectIdentityDriftRejected,
          detectedFeatures,
          featureDriftRejected,
          firebaseCliDisplayName,
          listedToolCount: listed.tools.length,
          listedAuthenticatedUser: listed._meta.authenticatedUser,
          listAuthenticationValue,
          authenticationDuringList,
          authenticationAfterList,
          rejectedListAuthenticationValue,
          rejectedListFailed,
          authenticationAfterRejectedList,
          realAuthenticationCalls,
          listAuthenticationOverrideAbsent:
            !Object.prototype.hasOwnProperty.call(listContext, "getAuthenticatedUser"),
          transportAgentKind: typeof apiTransport.noKeepAliveAgent,
          guardsSealed: [
            Object.getOwnPropertyDescriptor(apiTransport, "noKeepAliveAgent"),
            Object.getOwnPropertyDescriptor(cloudbilling, "checkBillingEnabled"),
            Object.getOwnPropertyDescriptor(ensureApi, "ensure"),
            Object.getOwnPropertyDescriptor(ensureApi, "bestEffortEnsure"),
            Object.getOwnPropertyDescriptor(track, "trackGA4"),
            Object.getOwnPropertyDescriptor(
              FirebaseMcpServer.prototype,
              "detectActiveFeatures",
            ),
            Object.getOwnPropertyDescriptor(
              FirebaseMcpServer.prototype,
              "_getFirebaseCliCommand",
            ),
            Object.getOwnPropertyDescriptor(
              FirebaseMcpServer.prototype,
              "mcpListTools",
            ),
            Object.getOwnPropertyDescriptor(
              FirebaseMcpServer.prototype,
              "getAuthenticatedUser",
            ),
          ].every((descriptor) =>
            descriptor?.writable === false && descriptor?.configurable === false
          ),
        }));
      })().catch(() => process.exit(2));
    `;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        pathToFileURL(preloadSource).href,
        "-e",
        probe,
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        env: {
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          APP_TEST_CTRL_FIREBASE_READONLY_PRELOAD: "official-v1",
          APP_TEST_CTRL_FIREBASE_READONLY_PACKAGE_ROOT: path.join(
            projectRoot,
            "node_modules/firebase-tools",
          ),
          PATH: process.env.PATH ?? "",
        },
      },
    );
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), {
      billing: false,
      analyticsIsUndefined: true,
      ensureRejected: true,
      bestEffortRejected: true,
      projectIdentityPreflightAllowed: true,
      projectIdentityDriftRejected: true,
      detectedFeatures: ["crashlytics"],
      featureDriftRejected: true,
      firebaseCliDisplayName: "firebase",
      listedToolCount: 0,
      listedAuthenticatedUser: null,
      listAuthenticationValue: null,
      authenticationDuringList: "fixture@example.invalid",
      authenticationAfterList: "fixture@example.invalid",
      rejectedListAuthenticationValue: null,
      rejectedListFailed: true,
      authenticationAfterRejectedList: "fixture@example.invalid",
      realAuthenticationCalls: 3,
      listAuthenticationOverrideAbsent: true,
      transportAgentKind: "function",
      guardsSealed: true,
    });
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("managed Firebase preload lets gaxios honor a configured forward proxy", async () => {
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "firebase-readonly-proxy-"));
  const home = path.join(privateRoot, "home");
  await mkdir(home, { mode: 0o700 });
  try {
    const probe = String.raw`
      const apiTransport = require("firebase-tools/lib/apiv2.js");
      const descriptor = Object.getOwnPropertyDescriptor(
        apiTransport,
        "noKeepAliveAgent",
      );
      process.stdout.write(JSON.stringify({
        transportAgentIsNull: apiTransport.noKeepAliveAgent === null,
        transportGuardSealed:
          descriptor?.writable === false && descriptor?.configurable === false,
      }));
    `;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        pathToFileURL(preloadSource).href,
        "-e",
        probe,
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        env: {
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          APP_TEST_CTRL_FIREBASE_READONLY_PRELOAD: "official-v1",
          APP_TEST_CTRL_FIREBASE_READONLY_PACKAGE_ROOT: path.join(
            projectRoot,
            "node_modules/firebase-tools",
          ),
          HTTPS_PROXY: "http://127.0.0.1:9",
          PATH: process.env.PATH ?? "",
        },
      },
    );
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), {
      transportAgentIsNull: true,
      transportGuardSealed: true,
    });
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("Firebase preload refuses to run outside the managed gateway", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["--import", "tsx", "--import", pathToFileURL(preloadSource).href, "-e", ""],
      {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        env: {
          HOME: os.tmpdir(),
          PATH: process.env.PATH ?? "",
        },
      },
    ),
    (error: unknown) => {
      if (!(error instanceof Error)) return false;
      const stderr = (error as Error & { stderr?: unknown }).stderr;
      return typeof stderr === "string"
        && stderr.includes("requires the managed gateway")
        && !stderr.includes("ERR_MODULE_NOT_FOUND");
    },
  );
});

test("managed Firebase preload never falls back to bare package resolution", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["--import", "tsx", "--import", pathToFileURL(preloadSource).href, "-e", ""],
      {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        env: {
          HOME: os.tmpdir(),
          APP_TEST_CTRL_FIREBASE_READONLY_PRELOAD: "official-v1",
          PATH: process.env.PATH ?? "",
        },
      },
    ),
    (error: unknown) => {
      if (!(error instanceof Error)) return false;
      const stderr = (error as Error & { stderr?: unknown }).stderr;
      return typeof stderr === "string"
        && stderr.includes("package root is invalid")
        && !stderr.includes("ERR_MODULE_NOT_FOUND");
    },
  );
});

test("preload ignores a resolvable same-version nested firebase-tools shadow", async () => {
  const privateRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "firebase-readonly-shadow-")),
  );
  const exactRoot = path.join(privateRoot, "firebase-tools");
  const shadowRoot = path.join(exactRoot, "node_modules", "firebase-tools");
  const exactMarker = path.join(privateRoot, "exact-modules.marker");
  const shadowPoison = path.join(privateRoot, "shadow-modules.poison");
  const home = path.join(privateRoot, "home");

  const writeFixtureFile = async (
    root: string,
    relativePath: string,
    source: string,
  ): Promise<void> => {
    const target = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, source, { mode: 0o600 });
  };
  const marked = (marker: string, label: string, body: string): string => [
    `require("node:fs").appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${label}\n`)});`,
    body,
    "",
  ].join("\n");

  try {
    await Promise.all([
      mkdir(home, { mode: 0o700 }),
      writeFixtureFile(
        exactRoot,
        "package.json",
        `${JSON.stringify({ name: "firebase-tools", version: "15.24.0" })}\n`,
      ),
      writeFixtureFile(
        shadowRoot,
        "package.json",
        `${JSON.stringify({ name: "firebase-tools", version: "15.24.0" })}\n`,
      ),
    ]);

    await Promise.all([
      writeFixtureFile(exactRoot, "lib/ensureApiEnabled.js", marked(
        exactMarker,
        "ensure",
        "exports.ensure = async () => true; exports.bestEffortEnsure = async () => true;",
      )),
      writeFixtureFile(exactRoot, "lib/apiv2.js", marked(
        exactMarker,
        "apiv2",
        "exports.noKeepAliveAgent = () => 'exact-agent';",
      )),
      writeFixtureFile(exactRoot, "lib/gcp/cloudbilling.js", marked(
        exactMarker,
        "billing",
        "exports.checkBillingEnabled = async () => true;",
      )),
      writeFixtureFile(exactRoot, "lib/track.js", marked(
        exactMarker,
        "track",
        "exports.trackGA4 = async () => 'sent';",
      )),
      writeFixtureFile(exactRoot, "lib/mcp/index.js", marked(
        exactMarker,
        "mcp",
        [
          "class FirebaseMcpServer {",
          "  async detectActiveFeatures() { return ['unrestricted']; }",
          "  async getAuthenticatedUser() { return 'real-auth'; }",
          "  async mcpListTools() { return { tools: [] }; }",
          "  _getFirebaseCliCommand() { return 'host-firebase'; }",
          "}",
          "exports.FirebaseMcpServer = FirebaseMcpServer;",
        ].join("\n"),
      )),
      writeFixtureFile(shadowRoot, "lib/ensureApiEnabled.js", marked(
        shadowPoison,
        "shadow-ensure",
        "exports.ensure = async () => true; exports.bestEffortEnsure = async () => true;",
      )),
      writeFixtureFile(shadowRoot, "lib/apiv2.js", marked(
        shadowPoison,
        "shadow-apiv2",
        "exports.noKeepAliveAgent = () => 'shadow-agent';",
      )),
      writeFixtureFile(shadowRoot, "lib/gcp/cloudbilling.js", marked(
        shadowPoison,
        "shadow-billing",
        "exports.checkBillingEnabled = async () => true;",
      )),
      writeFixtureFile(shadowRoot, "lib/track.js", marked(
        shadowPoison,
        "shadow-track",
        "exports.trackGA4 = async () => 'shadow-sent';",
      )),
      writeFixtureFile(shadowRoot, "lib/mcp/index.js", marked(
        shadowPoison,
        "shadow-mcp",
        [
          "class FirebaseMcpServer {",
          "  async detectActiveFeatures() { return ['shadow']; }",
          "  async getAuthenticatedUser() { return 'shadow-auth'; }",
          "  async mcpListTools() { return { tools: ['shadow']; }; }",
          "  _getFirebaseCliCommand() { return 'shadow-firebase'; }",
          "}",
          "exports.FirebaseMcpServer = FirebaseMcpServer;",
        ].join("\n"),
      )),
    ]);

    const probe = String.raw`
      const { readFileSync } = require("node:fs");
      const { createRequire } = require("node:module");
      const path = require("node:path");
      const exactRequire = createRequire(path.join(process.env.EXACT_PACKAGE_ROOT, "package.json"));
      const shadowTrack = exactRequire.resolve("firebase-tools/lib/track.js");
      const shadowSource = readFileSync(shadowTrack, "utf8");
      new Function("require", "module", "exports", shadowSource);

      const ensureApi = exactRequire("./lib/ensureApiEnabled.js");
      const apiTransport = exactRequire("./lib/apiv2.js");
      const cloudbilling = exactRequire("./lib/gcp/cloudbilling.js");
      const track = exactRequire("./lib/track.js");
      const { FirebaseMcpServer } = exactRequire("./lib/mcp/index.js");
      const guarded = [
        Object.getOwnPropertyDescriptor(apiTransport, "noKeepAliveAgent"),
        Object.getOwnPropertyDescriptor(cloudbilling, "checkBillingEnabled"),
        Object.getOwnPropertyDescriptor(ensureApi, "ensure"),
        Object.getOwnPropertyDescriptor(ensureApi, "bestEffortEnsure"),
        Object.getOwnPropertyDescriptor(track, "trackGA4"),
        Object.getOwnPropertyDescriptor(FirebaseMcpServer.prototype, "detectActiveFeatures"),
        Object.getOwnPropertyDescriptor(FirebaseMcpServer.prototype, "_getFirebaseCliCommand"),
        Object.getOwnPropertyDescriptor(FirebaseMcpServer.prototype, "mcpListTools"),
        Object.getOwnPropertyDescriptor(FirebaseMcpServer.prototype, "getAuthenticatedUser"),
      ].every((descriptor) =>
        descriptor?.writable === false && descriptor?.configurable === false
      );
      process.stdout.write(JSON.stringify({
        shadowResolvedExactly: shadowTrack === process.env.EXPECTED_SHADOW_TRACK,
        shadowVersion: exactRequire("firebase-tools/package.json").version,
        shadowParseable: true,
        guarded,
        exactMarker: readFileSync(process.env.EXACT_MARKER, "utf8"),
      }));
    `;
    const tsxLoader = pathToFileURL(
      path.join(projectRoot, "node_modules/tsx/dist/loader.mjs"),
    ).href;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "--import",
        tsxLoader,
        "--import",
        pathToFileURL(preloadSource).href,
        "-e",
        probe,
      ],
      {
        cwd: exactRoot,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        env: {
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          APP_TEST_CTRL_FIREBASE_READONLY_PRELOAD: "official-v1",
          APP_TEST_CTRL_FIREBASE_READONLY_PACKAGE_ROOT: exactRoot,
          EXACT_PACKAGE_ROOT: exactRoot,
          EXPECTED_SHADOW_TRACK: path.join(shadowRoot, "lib/track.js"),
          EXACT_MARKER: exactMarker,
          PATH: process.env.PATH ?? "",
        },
      },
    );

    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), {
      shadowResolvedExactly: true,
      shadowVersion: "15.24.0",
      shadowParseable: true,
      guarded: true,
      exactMarker: "apiv2\nensure\nbilling\ntrack\nmcp\n",
    });
    assert.equal(
      await readFile(exactMarker, "utf8"),
      "apiv2\nensure\nbilling\ntrack\nmcp\n",
    );
    await assert.rejects(
      readFile(shadowPoison, "utf8"),
      (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT",
    );
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
});
