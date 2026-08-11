import { createHash } from "node:crypto";
import path from "node:path";

export const FIREBASE_TOOLS_VERSION = "15.24.0";
export const FIREBASE_TOOLS_PACKAGE = `firebase-tools@${FIREBASE_TOOLS_VERSION}`;
export const FIREBASE_MANAGED_ENV = "APP_TEST_CTRL_MANAGED_FIREBASE_MCP";
export const FIREBASE_MANAGED_VALUE = "official-readonly-proxy-v2";
export const FIREBASE_LEGACY_MANAGED_VALUE = "official-v1";
export const FIREBASE_MANAGED_OWNER_ENV = "APP_TEST_CTRL_FIREBASE_OWNER_SHA256";
export const FIREBASE_REPORTS_GUIDE_URI = "firebase://guides/crashlytics/reports";
export const FIREBASE_MCP_STARTUP_TIMEOUT_SEC = 60;
export const FIREBASE_CODEX_FORWARDED_ENV_VARS = Object.freeze([
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
]);
export const FIREBASE_PROXY_RELATIVE_ENTRY =
  "mcp-servers/firebase-readonly-mcp/dist/index.js";
export const FIREBASE_READONLY_PRELOAD_RELATIVE_ENTRY =
  "mcp-servers/firebase-readonly-mcp/dist/readonly-preload.js";
export const FIREBASE_PROJECT_SOURCES = Object.freeze([
  "service-account",
  "firebaserc",
]);

export const OFFICIAL_FIREBASE_READ_TOOLS = Object.freeze([
  "firebase_get_environment",
  "firebase_get_project",
  "firebase_list_apps",
  "firebase_get_crashlytics_report_guide",
  "crashlytics_get_issue",
  "crashlytics_list_events",
  "crashlytics_batch_get_events",
  "crashlytics_get_report",
]);

const LEGACY_FIREBASE_BASE_ARGS = Object.freeze([
  "-y",
  FIREBASE_TOOLS_PACKAGE,
  "mcp",
  "--only",
  "crashlytics",
]);

// These are the only caller-controlled values the gateway intentionally
// consumes or forwards. In particular, Node/DYLD/LD injection variables are
// excluded so doctor never labels a preloaded gateway process as safely pinned.
const FIREBASE_GATEWAY_ALLOWED_ENV = new Set([
  FIREBASE_MANAGED_ENV,
  FIREBASE_MANAGED_OWNER_ENV,
  "PATH",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
]);

function isObjectRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function normalizeProjectRoot(projectRoot, platform) {
  const api = pathApi(platform);
  if (
    typeof projectRoot !== "string"
    || !projectRoot
    || projectRoot.includes("\0")
    || !api.isAbsolute(projectRoot)
  ) {
    throw new Error("projectRoot must be an absolute path without NUL");
  }
  return api.normalize(projectRoot);
}

function ownerSha256(projectRoot, { platform, domain }) {
  const normalized = normalizeProjectRoot(projectRoot, platform);
  const ownerPath = platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
  return createHash("sha256").update(`${domain}\0`).update(ownerPath).digest("hex");
}

export function officialFirebaseOwnerSha256(projectRoot, {
  platform = process.platform,
} = {}) {
  return ownerSha256(projectRoot, {
    platform,
    domain: "app-test-ctrl-firebase-readonly-owner/v2",
  });
}

function legacyFirebaseOwnerSha256(projectRoot, platform) {
  return ownerSha256(projectRoot, {
    platform,
    domain: "app-test-ctrl-firebase-owner/v1",
  });
}

export function officialFirebaseProxyEntry(projectRoot, {
  platform = process.platform,
} = {}) {
  const api = pathApi(platform);
  return api.join(
    normalizeProjectRoot(projectRoot, platform),
    ...FIREBASE_PROXY_RELATIVE_ENTRY.split("/"),
  );
}

export function bindOfficialFirebaseServerOwner(
  entry,
  projectRoot,
  { platform = process.platform } = {},
) {
  if (!isObjectRecord(entry)) throw new Error("Firebase MCP entry must be an object");
  return {
    ...entry,
    env: {
      ...(isObjectRecord(entry.env) ? entry.env : {}),
      [FIREBASE_MANAGED_ENV]: FIREBASE_MANAGED_VALUE,
      [FIREBASE_MANAGED_OWNER_ENV]: officialFirebaseOwnerSha256(projectRoot, { platform }),
    },
  };
}

function commandLooksLikeNode(command, platform = process.platform) {
  if (typeof command !== "string" || !command.trim()) return false;
  if (command === "node") return true;
  const api = pathApi(platform);
  if (!api.isAbsolute(command)) return false;
  const name = api.basename(command).toLowerCase();
  return name === "node" || name === "node.exe";
}

function commandLooksLikeNpx(command, platform = process.platform) {
  if (typeof command !== "string" || !command.trim()) return false;
  if (command === "npx") return true;
  const api = pathApi(platform);
  if (!api.isAbsolute(command)) return false;
  return ["npx", "npx.cmd", "npx.exe"].includes(api.basename(command).toLowerCase());
}

export function buildOfficialFirebaseServer(
  firebaseDir = null,
  {
    projectRoot,
    nodeCommand = "node",
    platform = process.platform,
    projectSource = null,
    firebaseProjectId = null,
    serviceAccountPath = null,
  } = {},
) {
  if (!commandLooksLikeNode(nodeCommand, platform)) {
    throw new Error("nodeCommand must be node or an absolute Node launcher");
  }
  const api = pathApi(platform);
  const args = [officialFirebaseProxyEntry(projectRoot, { platform })];
  if (projectSource !== null && !FIREBASE_PROJECT_SOURCES.includes(projectSource)) {
    throw new Error(
      `projectSource must be one of: ${FIREBASE_PROJECT_SOURCES.join(", ")}`,
    );
  }
  if (projectSource !== null && firebaseDir === null) {
    throw new Error("an explicit Firebase project source requires firebaseDir");
  }
  if (projectSource === "service-account") {
    if (
      typeof firebaseProjectId !== "string"
      || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(firebaseProjectId)
    ) {
      throw new Error(
        "service-account project source requires a valid firebaseProjectId",
      );
    }
    if (
      typeof serviceAccountPath !== "string"
      || !serviceAccountPath
      || serviceAccountPath.includes("\0")
      || !api.isAbsolute(serviceAccountPath)
    ) {
      throw new Error(
        "service-account project source requires an absolute serviceAccountPath",
      );
    }
  } else if (serviceAccountPath !== null || firebaseProjectId !== null) {
    throw new Error(
      "firebaseProjectId and serviceAccountPath are only valid for service-account project source",
    );
  }
  if (projectSource !== null) {
    args.push("--project-source", projectSource);
    if (projectSource === "service-account") {
      args.push("--project-id", firebaseProjectId);
    }
  }
  if (firebaseDir !== null) {
    if (
      typeof firebaseDir !== "string"
      || !firebaseDir
      || firebaseDir.includes("\0")
      || !api.isAbsolute(firebaseDir)
    ) {
      throw new Error("firebaseDir must be an absolute path without NUL");
    }
    args.push("--dir", api.normalize(firebaseDir));
  }
  return {
    command: nodeCommand,
    args,
    env: {
      [FIREBASE_MANAGED_ENV]: FIREBASE_MANAGED_VALUE,
      ...(projectSource === "service-account"
        ? { GOOGLE_APPLICATION_CREDENTIALS: api.normalize(serviceAccountPath) }
        : {}),
    },
  };
}

/** Add deterministic Codex runtime boundaries without changing other clients. */
export function buildCodexOfficialFirebaseServer(
  entry,
  projectRoot,
  {
    nodeCommand = entry?.command,
    platform = process.platform,
  } = {},
) {
  if (!isObjectRecord(entry)) throw new Error("Firebase MCP entry must be an object");
  const api = pathApi(platform);
  if (!api.isAbsolute(nodeCommand ?? "") || !commandLooksLikeNode(nodeCommand, platform)) {
    throw new Error("nodeCommand must be an absolute Node launcher");
  }
  return bindOfficialFirebaseServerOwner({
    ...entry,
    command: nodeCommand,
    cwd: normalizeProjectRoot(projectRoot, platform),
    startup_timeout_sec: FIREBASE_MCP_STARTUP_TIMEOUT_SEC,
    enabled: true,
    env_vars: [...FIREBASE_CODEX_FORWARDED_ENV_VARS],
    enabled_tools: [...OFFICIAL_FIREBASE_READ_TOOLS],
  }, projectRoot, { platform });
}

function normalizedEnvironment(entry, issues = []) {
  const hasEnv = entry?.env !== undefined;
  const hasEnvironment = entry?.environment !== undefined;
  if (hasEnv && hasEnvironment) {
    issues.push("env and environment must not both be present");
    return {};
  }
  const candidate = hasEnv ? entry.env : hasEnvironment ? entry.environment : {};
  if (!isObjectRecord(candidate)) {
    issues.push("Firebase environment must be an object");
    return {};
  }
  return candidate;
}

function inspectGatewayScope(args, baseLength, platform, issues) {
  const api = pathApi(platform);
  const rest = args.slice(baseLength);
  let projectSource = null;
  let firebaseProjectId = null;
  let directoryArgs = rest;
  if (rest[0] === "--project-source") {
    projectSource = FIREBASE_PROJECT_SOURCES.includes(rest[1]) ? rest[1] : null;
    if (projectSource === "service-account") {
      if (
        rest.length !== 6
        || rest[2] !== "--project-id"
        || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(rest[3] ?? "")
        || rest[4] !== "--dir"
      ) {
        issues.push(
          "service-account binding must be --project-source service-account --project-id <id> --dir <absolute-path>",
        );
        return { firebaseDir: null, projectSource: null, firebaseProjectId: null };
      }
      firebaseProjectId = rest[3];
      directoryArgs = rest.slice(4);
    } else if (projectSource === "firebaserc") {
      if (rest.length !== 4 || rest[2] !== "--dir") {
        issues.push(
          "firebaserc binding must be --project-source firebaserc --dir <absolute-path>",
        );
        return { firebaseDir: null, projectSource: null, firebaseProjectId: null };
      }
      directoryArgs = rest.slice(2);
    } else {
      issues.push(
        "--project-source must be service-account or firebaserc",
      );
      return { firebaseDir: null, projectSource: null, firebaseProjectId: null };
    }
  }
  if (directoryArgs.length === 0) {
    return { firebaseDir: null, projectSource, firebaseProjectId };
  }
  if (directoryArgs.length !== 2 || directoryArgs[0] !== "--dir") {
    issues.push("only one optional --dir <absolute-path> pair is allowed");
    return { firebaseDir: null, projectSource, firebaseProjectId };
  }
  const firebaseDir = directoryArgs[1];
  if (!firebaseDir || firebaseDir.includes("\0") || !api.isAbsolute(firebaseDir)) {
    issues.push("--dir must be followed by an absolute path without NUL");
    return { firebaseDir: null, projectSource, firebaseProjectId };
  }
  return {
    firebaseDir: api.normalize(firebaseDir),
    projectSource,
    firebaseProjectId,
  };
}

/** Strictly recognize only the read-only gateway generated by this checkout. */
export function inspectOfficialFirebaseServer(
  entry,
  {
    platform = process.platform,
    expectedProjectRoot,
    client,
  } = {},
) {
  const issues = [];
  const empty = {
    valid: false,
    managed: false,
    owner_bound: false,
    owned_by_expected_project: false,
    firebaseDir: null,
    projectSource: null,
    firebaseProjectId: null,
    credentialConfigured: false,
    issues,
  };
  if (!isObjectRecord(entry)) {
    issues.push("entry must be an object");
    return empty;
  }

  let normalizedExpectedRoot;
  try {
    normalizedExpectedRoot = normalizeProjectRoot(expectedProjectRoot, platform);
  } catch {
    issues.push("expectedProjectRoot must be an absolute path without NUL");
  }

  if (!commandLooksLikeNode(entry.command, platform)) {
    issues.push("command must be node or an absolute Node launcher");
  }
  if (!Array.isArray(entry.args) || entry.args.some((value) => typeof value !== "string")) {
    issues.push("args must be an array of strings");
  }
  const args = Array.isArray(entry.args) ? entry.args : [];
  const expectedEntry = normalizedExpectedRoot === undefined
    ? null
    : officialFirebaseProxyEntry(normalizedExpectedRoot, { platform });
  if (args.length === 0 || expectedEntry === null || args[0] !== expectedEntry) {
    issues.push("args must start with this checkout's absolute firebase-readonly-mcp entry");
  }
  const scope = inspectGatewayScope(args, 1, platform, issues);
  const { firebaseDir, projectSource, firebaseProjectId } = scope;

  const env = normalizedEnvironment(entry, issues);
  for (const [name, value] of Object.entries(env)) {
    if (!FIREBASE_GATEWAY_ALLOWED_ENV.has(name)) {
      issues.push(`unsupported Firebase gateway environment key: ${name}`);
      continue;
    }
    if (
      typeof value !== "string"
      || value.length > 8192
      || /[\u0000\r\n]/u.test(value)
    ) {
      issues.push(`Firebase gateway environment value is invalid: ${name}`);
    }
  }
  const managed = env[FIREBASE_MANAGED_ENV] === FIREBASE_MANAGED_VALUE;
  if (!managed) issues.push("managed Firebase read-only gateway marker is missing");
  const owner = env[FIREBASE_MANAGED_OWNER_ENV];
  const ownerBound = typeof owner === "string" && /^[a-f0-9]{64}$/u.test(owner);
  let ownedByExpectedProject = false;
  if (normalizedExpectedRoot !== undefined) {
    const expectedOwner = officialFirebaseOwnerSha256(normalizedExpectedRoot, { platform });
    ownedByExpectedProject = managed && ownerBound && owner === expectedOwner;
    if (!ownerBound) issues.push("managed Firebase gateway checkout owner is missing");
    else if (owner !== expectedOwner) issues.push("managed Firebase gateway belongs to a different checkout");
  }

  const credential = env.GOOGLE_APPLICATION_CREDENTIALS;
  const credentialConfigured = typeof credential === "string"
    && credential.length > 0
    && !credential.includes("\0")
    && pathApi(platform).isAbsolute(credential);
  if (projectSource === "service-account" && !credentialConfigured) {
    issues.push(
      "service-account project source requires an absolute GOOGLE_APPLICATION_CREDENTIALS path",
    );
  }
  if (projectSource === "service-account") {
    for (const ambiguous of [
      "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
      "GOOGLE_CLOUD_PROJECT",
      "GCLOUD_PROJECT",
    ]) {
      if (Object.prototype.hasOwnProperty.call(env, ambiguous)) {
        issues.push(`service-account project source forbids ambiguous environment key: ${ambiguous}`);
      }
    }
  }
  if (
    projectSource === "firebaserc"
    && Object.prototype.hasOwnProperty.call(env, "GOOGLE_APPLICATION_CREDENTIALS")
  ) {
    issues.push("firebaserc project source must use Firebase CLI authentication, not explicit ADC");
  }

  if (["codex", "claude-desktop", "antigravity"].includes(client)) {
    const api = pathApi(platform);
    if (!api.isAbsolute(entry.command ?? "")) {
      issues.push(`${client} command must be an absolute Node launcher`);
    }
  }
  if (client === "codex") {
    if (normalizedExpectedRoot === undefined || entry.cwd !== normalizedExpectedRoot) {
      issues.push("Codex cwd must equal the canonical checkout root");
    }
    if (entry.startup_timeout_sec !== FIREBASE_MCP_STARTUP_TIMEOUT_SEC) {
      issues.push(`Codex startup_timeout_sec must equal ${FIREBASE_MCP_STARTUP_TIMEOUT_SEC}`);
    }
    if (entry.enabled !== true) issues.push("Codex Firebase gateway must be enabled");
    if (
      !Array.isArray(entry.env_vars)
      || entry.env_vars.length !== FIREBASE_CODEX_FORWARDED_ENV_VARS.length
      || entry.env_vars.some(
        (name, index) => name !== FIREBASE_CODEX_FORWARDED_ENV_VARS[index],
      )
    ) {
      issues.push(
        "Codex env_vars must exactly forward the bounded proxy environment",
      );
    }
    if (
      !Array.isArray(entry.enabled_tools)
      || entry.enabled_tools.length !== OFFICIAL_FIREBASE_READ_TOOLS.length
      || entry.enabled_tools.some((name, index) => name !== OFFICIAL_FIREBASE_READ_TOOLS[index])
    ) {
      issues.push("Codex enabled_tools must exactly match the fixed read-only allowlist");
    }
  }

  return {
    valid: issues.length === 0,
    managed,
    owner_bound: ownerBound,
    owned_by_expected_project: ownedByExpectedProject,
    firebaseDir,
    projectSource,
    firebaseProjectId,
    credentialConfigured,
    issues,
  };
}

function inspectLegacyOptionalDir(args, baseLength, platform, issues) {
  const api = pathApi(platform);
  const rest = args.slice(baseLength);
  if (rest.length === 0) return null;
  if (rest.length !== 2 || rest[0] !== "--dir") {
    issues.push("legacy Firebase invocation only allows --dir <absolute-path>");
    return null;
  }
  if (!rest[1] || rest[1].includes("\0") || !api.isAbsolute(rest[1])) {
    issues.push("legacy --dir must be followed by an absolute path without NUL");
    return null;
  }
  return api.normalize(rest[1]);
}

/** Recognize the exact pre-gateway v1 npx entry only for safe migration/uninstall. */
export function inspectLegacyOfficialFirebaseServer(
  entry,
  {
    platform = process.platform,
    expectedProjectRoot,
  } = {},
) {
  if (!isObjectRecord(entry) || !commandLooksLikeNpx(entry.command, platform)) return false;
  if (!Array.isArray(entry.args) || entry.args.some((value) => typeof value !== "string")) return false;
  if (!LEGACY_FIREBASE_BASE_ARGS.every((value, index) => entry.args[index] === value)) return false;
  const issues = [];
  inspectLegacyOptionalDir(entry.args, LEGACY_FIREBASE_BASE_ARGS.length, platform, issues);
  if (issues.length > 0) return false;
  const env = normalizedEnvironment(entry, issues);
  if (issues.length > 0 || env[FIREBASE_MANAGED_ENV] !== FIREBASE_LEGACY_MANAGED_VALUE) {
    return false;
  }
  if (expectedProjectRoot === undefined) return false;
  try {
    return env[FIREBASE_MANAGED_OWNER_ENV]
      === legacyFirebaseOwnerSha256(expectedProjectRoot, platform);
  } catch {
    return false;
  }
}

function parseTomlHeader(line) {
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
  return { name, suffix: match[3].trim() };
}

function parseInlineStringMap(source) {
  const value = source.trim();
  if (!value.startsWith("{") || !value.endsWith("}")) return null;
  const result = {};
  let index = 1;
  const end = value.length - 1;
  const skipWhitespace = () => {
    while (index < end && /\s/u.test(value[index])) index += 1;
  };
  skipWhitespace();
  while (index < end) {
    let key;
    if (value[index] === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < end) {
        const character = value[index++];
        if (!escaped && character === '"') break;
        escaped = !escaped && character === "\\";
        if (character !== "\\") escaped = false;
      }
      try {
        key = JSON.parse(value.slice(start, index));
      } catch {
        return null;
      }
    } else {
      const match = value.slice(index).match(/^[A-Za-z_][A-Za-z0-9_-]*/u);
      if (!match) return null;
      key = match[0];
      index += match[0].length;
    }
    if (Object.prototype.hasOwnProperty.call(result, key)) return null;
    skipWhitespace();
    if (value[index] !== "=") return null;
    index += 1;
    skipWhitespace();
    if (value[index] !== '"') return null;
    const start = index;
    index += 1;
    let escaped = false;
    while (index < end) {
      const character = value[index++];
      if (!escaped && character === '"') break;
      escaped = !escaped && character === "\\";
      if (character !== "\\") escaped = false;
    }
    let parsed;
    try {
      parsed = JSON.parse(value.slice(start, index));
    } catch {
      return null;
    }
    if (typeof parsed !== "string") return null;
    result[key] = parsed;
    skipWhitespace();
    if (index === end) break;
    if (value[index] !== ",") return null;
    index += 1;
    skipWhitespace();
    if (index === end) return null;
  }
  return result;
}

/**
 * Parse only the bounded, single-line TOML shape emitted by setup-mcp for the
 * Firebase section. It is deliberately not a general TOML parser: ambiguity or
 * unsupported syntax returns null so doctor/uninstall fail closed.
 */
export function parseGeneratedCodexMcpServer(text, serverName) {
  if (typeof text !== "string" || text.length > 4 * 1024 * 1024) return null;
  if (typeof serverName !== "string" || !/^[A-Za-z0-9_-]+$/u.test(serverName)) return null;
  const roots = [];
  let current = null;
  for (const line of text.split(/\r?\n/u)) {
    if (line.trimStart().startsWith("[")) {
      const header = parseTomlHeader(line);
      current = header?.name === serverName && header.suffix === "" ? [] : null;
      if (current) roots.push(current);
      continue;
    }
    if (current) current.push(line);
  }
  if (roots.length !== 1) return null;

  const raw = {};
  for (const line of roots[0]) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/u);
    if (!match || Object.prototype.hasOwnProperty.call(raw, match[1])) return null;
    if (![
      "command",
      "args",
      "cwd",
      "startup_timeout_sec",
      "enabled",
      "env_vars",
      "enabled_tools",
      "env",
    ].includes(match[1])) return null;
    raw[match[1]] = match[2];
  }

  try {
    const command = JSON.parse(raw.command);
    const args = JSON.parse(raw.args);
    if (
      typeof command !== "string"
      || !Array.isArray(args)
      || args.some((item) => typeof item !== "string")
    ) return null;
    const parsed = { command, args };
    if (raw.cwd !== undefined) {
      const cwd = JSON.parse(raw.cwd);
      if (typeof cwd !== "string") return null;
      parsed.cwd = cwd;
    }
    if (raw.startup_timeout_sec !== undefined) {
      const startupTimeout = Number(raw.startup_timeout_sec);
      if (!Number.isSafeInteger(startupTimeout)) return null;
      parsed.startup_timeout_sec = startupTimeout;
    }
    if (raw.enabled !== undefined) {
      if (!['true', 'false'].includes(raw.enabled)) return null;
      parsed.enabled = raw.enabled === 'true';
    }
    if (raw.enabled_tools !== undefined) {
      const enabledTools = JSON.parse(raw.enabled_tools);
      if (!Array.isArray(enabledTools) || enabledTools.some((item) => typeof item !== "string")) {
        return null;
      }
      parsed.enabled_tools = enabledTools;
    }
    if (raw.env_vars !== undefined) {
      const envVars = JSON.parse(raw.env_vars);
      if (!Array.isArray(envVars) || envVars.some((item) => typeof item !== "string")) {
        return null;
      }
      parsed.env_vars = envVars;
    }
    if (raw.env !== undefined) {
      const env = parseInlineStringMap(raw.env);
      if (env === null) return null;
      parsed.env = env;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function parseGeneratedCodexFirebaseServer(text) {
  return parseGeneratedCodexMcpServer(text, "firebase");
}
