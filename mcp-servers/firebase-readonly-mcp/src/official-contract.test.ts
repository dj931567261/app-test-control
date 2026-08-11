import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { UPSTREAM_FIREBASE_READ_TOOLS, sanitizeUpstreamToolResult } from "./schemas.js";
import { FIREBASE_TOOLS_VERSION } from "./upstream.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

interface OfficialContractProbe {
  version: string;
  tools: Array<{
    name: string;
    inputSchema: Record<string, unknown>;
    readOnlyHint?: unknown;
    destructiveHint?: unknown;
  }>;
  environmentResult: unknown;
}

test("pinned official contract is exact in a private child with common network APIs denied", async () => {
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "firebase-contract-test-"));
  const home = path.join(privateRoot, "home");
  const temp = path.join(privateRoot, "tmp");
  await Promise.all([
    mkdir(home, { mode: 0o700 }),
    mkdir(temp, { mode: 0o700 }),
  ]);
  const expected = [...UPSTREAM_FIREBASE_READ_TOOLS];
  const source = String.raw`
    const deny = () => { throw new Error("network access is forbidden in this contract probe"); };
    for (const name of ["node:http", "node:https"]) {
      const api = require(name);
      api.request = deny;
      api.get = deny;
    }
    const net = require("node:net");
    net.connect = deny;
    net.createConnection = deny;
    global.fetch = deny;

    const expected = ${JSON.stringify(expected)};
    const manifest = require("firebase-tools/package.json");
    const { getToolsByFeature } = require("firebase-tools/lib/mcp/tools/index.js");
    const { hydrateTemplate } = require(
      "firebase-tools/lib/mcp/tools/core/get_environment.js"
    );
    const { toContent } = require("firebase-tools/lib/mcp/util.js");

    Promise.resolve(getToolsByFeature(["crashlytics"])).then((official) => {
      const byName = new Map(official.map((tool) => [tool.mcp.name, tool.mcp]));
      const tools = expected.map((name) => {
        const tool = byName.get(name);
        return {
          name,
          inputSchema: tool?.inputSchema ?? null,
          readOnlyHint: tool?.annotations?.readOnlyHint,
          destructiveHint: tool?.annotations?.destructiveHint,
        };
      });
      const environmentResult = toContent(hydrateTemplate({
        projectId: "fixture-project-1",
        projectAliases: [],
        projectDir: "/private/fixture",
        projectConfigPath: undefined,
        geminiTosAccepted: false,
        isBillingEnabled: false,
        authenticatedUser: "fixture@example.invalid",
        projectAliasMap: { default: "fixture-project-1" },
        allAccounts: ["fixture@example.invalid"],
        detectedAppIds: {},
        projectFileContents: undefined,
      }));
      process.stdout.write(JSON.stringify({
        version: manifest.version,
        tools,
        environmentResult,
      }));
    }).catch(() => {
      process.stderr.write("official contract probe failed safely\n");
      process.exitCode = 2;
    });
  `;

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["-e", source], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 256 * 1024,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        TMPDIR: temp,
        TMP: temp,
        TEMP: temp,
        METADATA_SERVER_DETECTION: "none",
        NO_UPDATE_NOTIFIER: "1",
        TERM: "dumb",
      },
    });
    assert.equal(stderr, "");
    const probe = JSON.parse(stdout) as OfficialContractProbe;
    assert.equal(probe.version, FIREBASE_TOOLS_VERSION);
    assert.deepEqual(probe.tools.map((tool) => tool.name), expected);
    for (const tool of probe.tools) {
      assert.equal(tool.inputSchema?.type, "object", `${tool.name} input must be an object`);
      assert.equal(tool.readOnlyHint, true, `${tool.name} must be read-only`);
      assert.notEqual(tool.destructiveHint, true, `${tool.name} must not be destructive`);
    }
    assert.deepEqual(
      probe.tools.find((tool) => tool.name === "firebase_get_environment")?.inputSchema,
      { type: "object" },
    );
    assert.deepEqual(
      sanitizeUpstreamToolResult(probe.environmentResult),
      probe.environmentResult,
    );
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
});
