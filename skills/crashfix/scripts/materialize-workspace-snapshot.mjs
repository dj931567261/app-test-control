#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants as FS } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_WORKSPACE_LIMITS = Object.freeze({
  maxFiles: 20_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxDirectories: 10_000,
  maxDepth: 64,
  maxPathChars: 4_096,
  maxManifestBytes: 128 * 1024 * 1024,
});
export const DEFAULT_LIMITS = DEFAULT_WORKSPACE_LIMITS;

export const WORKSPACE_CREDENTIAL_REASON_CODES = Object.freeze({
  PRIVATE_KEY_BLOCK: "private_key_block",
  HIGH_CONFIDENCE_TOKEN_OR_SENSITIVE_ASSIGNMENT:
    "high_confidence_token_or_sensitive_assignment",
  STRUCTURED_SENSITIVE_VALUE: "structured_sensitive_value",
  CREDENTIAL_FILE_NAME: "credential_file_name",
  CREDENTIAL_DIRECTORY_NAME: "credential_directory_name",
});
const WORKSPACE_CREDENTIAL_REASON_CODE_SET = new Set(
  Object.values(WORKSPACE_CREDENTIAL_REASON_CODES),
);
const CREDENTIAL_DIAGNOSTIC_SCHEMA = "crashfix-workspace-credential-diagnostic/v1";
const CREDENTIAL_DIAGNOSTIC_ERROR_CODE = "credential_material_detected";
const HELPER_DIAGNOSTIC_SCHEMA = "crashfix-workspace-helper-diagnostic/v1";
const HELPER_DIAGNOSTIC_ERROR_CODE = "operation_failed";
const TEST_FIXTURE_PROBE_SCHEMA = "crashfix-test-fixture-probe/v1";
const TEST_FIXTURE_APPROVAL_SCHEMA = "crashfix-test-fixture-approval/v1";
const TEST_FIXTURE_CONTEXT_SCHEMA = "crashfix-test-fixture-context/v1";
const WORKSPACE_MANIFEST_SCHEMA = "crashfix-workspace-manifest/v2";
const WORKSPACE_OWNER_SCHEMA = "crashfix-workspace-owner/v2";
const WORKSPACE_CLONE_OWNER_SCHEMA = "crashfix-workspace-clone-owner/v2";
const WORKSPACE_SNAPSHOT_SCHEMA = "crashfix-workspace-snapshot/v2";
const WORKSPACE_CLONE_SCHEMA = "crashfix-workspace-clone/v2";
const WORKSPACE_SOURCE_VERIFICATION_SCHEMA = "crashfix-workspace-source-verification/v2";
const WORKSPACE_AUDIT_SCHEMA = "crashfix-workspace-audit/v2";
const CANDIDATE_EXPORT_SCHEMA = "crashfix-candidate-export/v2";
export const MAX_APPROVED_TEST_FIXTURES = 8;

// Human approval is part of the fixture boundary. Reject invisible formatting
// and default-ignorable code points that can make one path render as another.
const UNSAFE_PATH_CODE_POINT_RE =
  /[\p{Cc}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const LFS_PREFIX = Buffer.from("version https://git-lfs.github.com/spec/v1\n", "utf8");
const FILE_READ_CHUNK = 64 * 1024;
const CREDENTIAL_TEXT_TAIL_CHARS = 64 * 1024;
const CREDENTIAL_TEXT_OVERLAP_CHARS = 4 * 1024;
const OWNER_FILE = ".owner.json";
const MANIFEST_FILE = ".manifest.json";
const SNAPSHOT_DIR = "snapshot";
const CLONE_DIR = "workspace";

// This document is the single source of truth for exclusions. Runtime matchers
// are derived from it, and its digest travels with every snapshot/clone so a
// later implementation cannot silently interpret an older manifest using a
// different policy.
const EXCLUSION_POLICY = Object.freeze({
  schema_version: "crashfix-workspace-exclusions/v1",
  name_normalization: "NFC+en-US-lowercase",
  credential_detection: "bounded-high-confidence-heuristic-not-a-completeness-guarantee",
  always_excluded_names: Object.freeze([
    ".git", ".hg", ".svn", ".bzr", "_darcs", ".fossil-settings",
    ".worktrees", ".firebase", ".codex", ".claude", ".cursor", ".agents",
    ".gemini", ".windsurf", ".continue", ".roo", ".aider",
  ]),
  excluded_directory_names: Object.freeze([
    "build", ".build", "dist", "out", "target", "bin", "obj", ".gradle",
    ".cache", "cache", "caches", ".tmp", "tmp", ".temp", "temp",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    ".kotlin", ".cxx", ".externalnativebuild", "captures", ".idea",
    ".next", ".nuxt", ".output", ".svelte-kit", ".angular", "coverage",
    ".nyc_output", ".expo", ".metro-cache", ".parcel-cache", ".turbo",
    ".tox", ".nox",
    "node_modules", "bower_components", "vendor", ".venv", "venv",
    ".dart_tool", ".pub-cache", ".pnpm-store", "pods", "deriveddata",
    "xcuserdata", "carthage", ".swiftpm",
  ]),
  credential_directory_names: Object.freeze([
    ".aws", ".azure", ".ssh", ".gnupg", ".kube", "credentials",
    ".credentials", "secrets", ".secrets", "keys", ".keys",
  ]),
  exact_excluded_files: Object.freeze([
    ".env", ".envrc", ".npmrc", ".pypirc", ".netrc", ".mcp.json",
    "application_default_credentials.json", "credentials.json",
    "firebase-debug.log", "local.properties",
    "key.properties", "keystore.properties", "id_rsa", "id_ed25519",
    "auth.txt", "authorization.txt", "deploy-token.txt", "deploy_token.txt",
    "auth-token.txt", "auth_token.txt", "access-token.txt", "access_token.txt",
    "refresh-token.txt", "refresh_token.txt", "api-token.txt", "api_token.txt",
    "api-key.txt", "api_key.txt", "token.txt", "secret.txt", "password.txt",
    ".auth", ".token", ".credentials",
  ]),
  excluded_file_prefixes: Object.freeze([".env."]),
  strong_credential_name_pattern: "(?:^|[-_.])(?:service[-_]?account|firebase[-_]?adminsdk)(?:[-_.]|$)",
  sensitive_config_name_pattern: "(?:^|[-_.])(?:credential|credentials|secret|secrets|token|tokens)(?:[-_.]|$)",
  secret_extension_pattern: "\\.(?:jks|keystore|p12|pfx|pem|key)$",
  structured_config_extensions: Object.freeze([
    ".json", ".properties", ".conf", ".config", ".cfg", ".ini", ".toml",
    ".yaml", ".yml", ".xml", ".auth",
  ]),
  structured_config_basenames: Object.freeze(["gradle.properties"]),
  source_code_extensions: Object.freeze([
    ".c", ".cc", ".cpp", ".cs", ".css", ".dart", ".go", ".gradle",
    ".h", ".hpp", ".html", ".java", ".js", ".jsx", ".kt", ".kts",
    ".less", ".mjs", ".cjs", ".php", ".py", ".rb", ".rs", ".scss",
    ".sql", ".svelte", ".swift", ".ts", ".tsx", ".vue",
  ]),
  high_confidence_token_patterns: Object.freeze([
    "\\bgh[pousr]_[A-Za-z0-9]{30,}\\b",
    "\\bgithub_pat_[A-Za-z0-9_]{40,}\\b",
    "\\bglpat-[A-Za-z0-9_-]{20,}\\b",
    "\\bxox[baprs]-[A-Za-z0-9-]{20,}\\b",
    "\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b",
    "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b",
    "\\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\\b",
    "\\bwhsec_[A-Za-z0-9]{20,}\\b",
    "\\bnpm_[A-Za-z0-9]{30,}\\b",
  ]),
  sensitive_assignment_segment_pattern: "(?:^|[_.-])(?:token|secret|password|passwd|private[-_.]?key|api[-_.]?key|access[-_.]?key)(?:$|[_.-])",
  sensitive_assignment_camel_pattern: "(?:Token|Secret|Password|Passwd|PrivateKey|ApiKey|AccessKey)$",
  non_secret_metadata_key_pattern: "(?:token|secret|password)[-_.]?(?:endpoint|url|uri|type|name|version)$",
  create_credential_action: "exclude",
  audit_credential_action: "reject",
  structured_credential_action: "reject",
  approved_test_fixture_policy: Object.freeze({
    schema_version: TEST_FIXTURE_APPROVAL_SCHEMA,
    default: "disabled",
    max_entries: MAX_APPROVED_TEST_FIXTURES,
    eligible_file_format: "strict_json",
    execution_profile: "local_trusted",
    project_classification: "test",
    requires_explicit_user_confirmation: true,
    eligible_reason: "structured_sensitive_value",
    hard_blocked_reasons: Object.freeze([
      "private_key_block",
      "high_confidence_token_or_sensitive_assignment",
      "credential_file_name",
      "credential_directory_name",
    ]),
    hard_blocked_structures: Object.freeze([
      "service_account",
      "authorized_user",
      "opaque_or_high_confidence_secret",
    ]),
  }),
  exact_excluded_artifact_files: Object.freeze([
    ".coverage", "mapping.txt", "lcov.info", "coverage.lcov",
    "coverage.xml", "coverage.json", "coverage-final.json", "jacoco.exec",
    "jacoco.xml", "cobertura.xml", "clover.xml",
  ]),
  excluded_artifact_file_suffixes: Object.freeze([
    ".apk", ".aab", ".apks", ".xapk", ".ipa",
    ".dsym.zip", ".xcarchive.zip",
    ".js.map", ".css.map", ".wasm.map", ".dart.map",
    ".sourcemap", ".source-map", ".profraw", ".profdata",
    ".gcda", ".gcno", ".lcov",
  ]),
  excluded_artifact_directory_suffixes: Object.freeze([
    ".app", ".xcarchive", ".dsym", ".xcresult",
  ]),
});

const ALWAYS_EXCLUDED_NAMES = new Set(EXCLUSION_POLICY.always_excluded_names);
const EXCLUDED_DIRECTORY_NAMES = new Set(EXCLUSION_POLICY.excluded_directory_names);
const CREDENTIAL_DIRECTORY_NAMES = new Set(EXCLUSION_POLICY.credential_directory_names);
const EXACT_EXCLUDED_FILES = new Set(EXCLUSION_POLICY.exact_excluded_files);
const SOURCE_CODE_EXTENSIONS = new Set(EXCLUSION_POLICY.source_code_extensions);
const EXACT_EXCLUDED_ARTIFACT_FILES = new Set(EXCLUSION_POLICY.exact_excluded_artifact_files);
const HIGH_CONFIDENCE_TOKEN_RES = EXCLUSION_POLICY.high_confidence_token_patterns
  .map((pattern) => new RegExp(pattern, "u"));
const STRONG_CREDENTIAL_NAME_RE = new RegExp(EXCLUSION_POLICY.strong_credential_name_pattern, "u");
const SENSITIVE_CONFIG_NAME_RE = new RegExp(EXCLUSION_POLICY.sensitive_config_name_pattern, "u");
const SECRET_EXTENSION_RE = new RegExp(EXCLUSION_POLICY.secret_extension_pattern, "u");
const SENSITIVE_ASSIGNMENT_SEGMENT_RE = new RegExp(EXCLUSION_POLICY.sensitive_assignment_segment_pattern, "iu");
const SENSITIVE_ASSIGNMENT_CAMEL_RE = new RegExp(EXCLUSION_POLICY.sensitive_assignment_camel_pattern, "u");
const NON_SECRET_METADATA_KEY_RE = new RegExp(EXCLUSION_POLICY.non_secret_metadata_key_pattern, "iu");

export const EXCLUSION_POLICY_SHA256 = createHash("sha256")
  .update(JSON.stringify(EXCLUSION_POLICY))
  .digest("hex");

// A BEGIN marker alone is sufficient to reject. This deliberately covers
// generic, encrypted, RSA/DSA/EC/OpenSSH/SSH2 and PGP private-key blocks,
// including truncated or same-line payloads.
const PRIVATE_KEY_MARKER_RE = /-----BEGIN [^-\r\n]{0,96}PRIVATE KEY[^-\r\n]{0,48}-----/iu;
const NPM_PACKAGE_SPEC_MAP_KEYS = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);
const SAFE_NPM_VERSION_ATOM = String.raw`(?:[v=]?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|beta|rc|dev|next|canary|snapshot)(?:\.(?:0|[1-9]\d*))?)?|(?:0|[1-9]\d*|[xX*])(?:\.(?:0|[1-9]\d*|[xX*])){0,2})`;
const SAFE_NPM_COMPARATOR = String.raw`(?:(?:[~^]|>=|<=|>|<|=)\s*)?${SAFE_NPM_VERSION_ATOM}`;
const SAFE_NPM_RANGE_CLAUSE_RE = new RegExp(
  String.raw`^(?:${SAFE_NPM_COMPARATOR})(?:\s+${SAFE_NPM_COMPARATOR})*$`,
  "u",
);
const SAFE_NPM_HYPHEN_RANGE_RE = new RegExp(
  String.raw`^${SAFE_NPM_VERSION_ATOM}\s+-\s+${SAFE_NPM_VERSION_ATOM}$`,
  "u",
);

function isStructuredConfigPath(relativePath) {
  const basename = portableName(path.posix.basename(relativePath));
  const extension = path.posix.extname(basename);
  return EXCLUSION_POLICY.structured_config_basenames.includes(basename)
    || EXCLUSION_POLICY.structured_config_extensions.includes(extension);
}

function isSourceCodePath(relativePath) {
  const basename = portableName(path.posix.basename(relativePath));
  return SOURCE_CODE_EXTENSIONS.has(path.posix.extname(basename));
}

function hasSubstantiveSecret(value) {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().replace(/^(?:["'])([\s\S]*)(?:["'])$/u, "$1").trim();
  if (normalized.length < 4) return false;
  if (/^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<[^>]+>|\*+|x+|redacted|placeholder|changeme|example|dummy|your[-_].*|test[-_]?value)$/iu.test(normalized)) {
    return false;
  }
  return true;
}

function isSensitiveAssignmentKey(key) {
  if (typeof key !== "string" || NON_SECRET_METADATA_KEY_RE.test(key)) return false;
  return SENSITIVE_ASSIGNMENT_SEGMENT_RE.test(key) || SENSITIVE_ASSIGNMENT_CAMEL_RE.test(key);
}

function looksLikeOpaqueSecret(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().replace(/^(?:["'])([\s\S]*)(?:["'])$/u, "$1").trim();
  if (
    normalized.length < 20
    || /(?:^|[-_.])(?:redacted|placeholder|changeme|example|dummy|fake|your[-_]?token)(?:$|[-_.])/iu.test(normalized)
  ) {
    return false;
  }
  // Oversized values assigned to a sensitive key are never eligible for the
  // narrow fixture exception. Do not let the bounded entropy inspection turn
  // them into an implicit allow case.
  if (normalized.length > 4_096) return true;
  // Opaque credentials commonly use padded base64/base64url or punctuation
  // outside a tiny token alphabet. Restrict this heuristic to whitespace-free
  // printable ASCII, then use bounded diversity/entropy rather than a narrow
  // character whitelist.
  if (!/^[\x21-\x7e]+$/u.test(normalized)) return false;
  const classes = [
    /[a-z]/u.test(normalized),
    /[A-Z]/u.test(normalized),
    /[0-9]/u.test(normalized),
    /[^A-Za-z0-9]/u.test(normalized),
  ].filter(Boolean).length;
  const frequencies = new Map();
  for (const character of normalized) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }
  const distinct = frequencies.size;
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / normalized.length;
    entropy -= probability * Math.log2(probability);
  }
  return (classes >= 3 && distinct >= 10 && entropy >= 3.25)
    || (normalized.length >= 32 && classes >= 2 && distinct >= 14 && entropy >= 3.5);
}

function textLineContainsHeuristicCredential(rawLine, allowOpaqueAssignment) {
  const line = rawLine.trim();
  if (HIGH_CONFIDENCE_TOKEN_RES.some((pattern) => pattern.test(line))) return true;
  if (!allowOpaqueAssignment) return false;
  const authorization = /^(?:(?:proxy-)?authorization\s*[:=]\s*)?(?:bearer|basic)\s+(.+)$/iu.exec(line);
  if (authorization && looksLikeOpaqueSecret(authorization[1])) return true;
  const assignment = /^(?:export\s+)?([A-Za-z0-9_.-]+)\s*(?:=|:)\s*(.+)$/u.exec(line);
  return assignment !== null
    && isSensitiveAssignmentKey(assignment[1])
    && looksLikeOpaqueSecret(assignment[2]);
}

function isClearlySafeNpmVersionRange(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  if (
    normalized.length < 1
    || normalized.length > 256
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) return false;
  const clauses = normalized.split(/\s*\|\|\s*/u);
  return clauses.length > 0 && clauses.every((clause) => (
    clause.length > 0
    && (
      SAFE_NPM_RANGE_CLAUSE_RE.test(clause)
      || SAFE_NPM_HYPHEN_RANGE_RE.test(clause)
    )
  ));
}

function isLockDependencyRecordPath(pathSegments) {
  if (pathSegments.length < 2 || pathSegments.length % 2 !== 0) return false;
  for (let index = 0; index < pathSegments.length; index += 2) {
    if (
      pathSegments[index] !== "dependencies"
      || typeof pathSegments[index + 1] !== "string"
      || pathSegments[index + 1].length < 1
    ) return false;
  }
  return true;
}

function isNpmDependencySpecifierMap(metadataKind, pathSegments) {
  if (metadataKind === "package") {
    return (
      pathSegments.length === 1
      && NPM_PACKAGE_SPEC_MAP_KEYS.has(pathSegments[0])
    ) || (pathSegments.length >= 1 && pathSegments[0] === "overrides");
  }
  if (metadataKind !== "lock") return false;
  if (
    pathSegments.length === 3
    && pathSegments[0] === "packages"
    && typeof pathSegments[1] === "string"
    && NPM_PACKAGE_SPEC_MAP_KEYS.has(pathSegments[2])
  ) return true;
  return pathSegments.at(-1) === "requires"
    && isLockDependencyRecordPath(pathSegments.slice(0, -1));
}

function isNpmLockPackageRecordIdentifier(metadataKind, pathSegments, key) {
  return metadataKind === "lock"
    && pathSegments.length === 1
    && pathSegments[0] === "packages"
    && typeof key === "string"
    && (key === "" || key.startsWith("node_modules/"));
}

const NO_STRUCTURED_CREDENTIAL = Object.freeze({ detected: false, override_eligible: false });
const APPROVABLE_STRUCTURED_CREDENTIAL = Object.freeze({ detected: true, override_eligible: true });
const HARD_BLOCKED_STRUCTURED_CREDENTIAL = Object.freeze({ detected: true, override_eligible: false });

function mergeStructuredCredentialClassification(left, right) {
  if (
    (left.detected && !left.override_eligible)
    || (right.detected && !right.override_eligible)
  ) return HARD_BLOCKED_STRUCTURED_CREDENTIAL;
  if (left.detected || right.detected) return APPROVABLE_STRUCTURED_CREDENTIAL;
  return NO_STRUCTURED_CREDENTIAL;
}

function containsPrivateKeyMarker(value) {
  return typeof value === "string"
    && PRIVATE_KEY_MARKER_RE.test(value);
}

function isHardBlockedStructuredAssignment(key, value) {
  const portableKey = portableName(key);
  return /(?:^|[_.-])private[-_.]?key(?:$|[_.-])/iu.test(portableKey)
    || containsPrivateKeyMarker(value)
    || (typeof value === "string" && HIGH_CONFIDENCE_TOKEN_RES.some((pattern) => pattern.test(value)))
    || (typeof value === "string" && value.trim().length > 4_096)
    || looksLikeOpaqueSecret(value);
}

function jsonCredentialClassification(
  value,
  budget = { nodes: 0 },
  context = {
    npmMetadataKind: undefined,
    pathSegments: [],
    sensitiveContext: false,
    firebaseClientConfig: false,
  },
) {
  budget.nodes += 1;
  if (budget.nodes > 20_000) fail("structured credential inspection exceeds its node budget");
  if (value === null || typeof value !== "object") {
    return containsPrivateKeyMarker(value)
      || (typeof value === "string" && HIGH_CONFIDENCE_TOKEN_RES.some((pattern) => pattern.test(value)))
      || (context.sensitiveContext && hasSubstantiveSecret(value))
      ? HARD_BLOCKED_STRUCTURED_CREDENTIAL
      : NO_STRUCTURED_CREDENTIAL;
  }
  // A sensitive assignment that changes shape from a scalar into an
  // object/array is not eligible for the fixture exception. This also prevents
  // a benign sibling password from masking a nested credential payload.
  if (context.sensitiveContext) return HARD_BLOCKED_STRUCTURED_CREDENTIAL;
  if (Array.isArray(value)) {
    let classification = NO_STRUCTURED_CREDENTIAL;
    for (let index = 0; index < value.length; index += 1) {
      classification = mergeStructuredCredentialClassification(
        classification,
        jsonCredentialClassification(value[index], budget, {
          npmMetadataKind: context.npmMetadataKind,
          pathSegments: [...context.pathSegments, String(index)],
          sensitiveContext: false,
          firebaseClientConfig: context.firebaseClientConfig,
        }),
      );
      if (classification.detected && !classification.override_eligible) return classification;
    }
    return classification;
  }
  const type = typeof value.type === "string" ? value.type.toLocaleLowerCase("en-US") : "";
  if (
    type === "service_account"
    && hasSubstantiveSecret(value.private_key)
    && typeof value.client_email === "string"
  ) return HARD_BLOCKED_STRUCTURED_CREDENTIAL;
  if (
    type === "authorized_user"
    && hasSubstantiveSecret(value.client_secret)
    && hasSubstantiveSecret(value.refresh_token)
  ) return HARD_BLOCKED_STRUCTURED_CREDENTIAL;
  if (
    hasSubstantiveSecret(value.private_key)
    && typeof value.client_email === "string"
  ) return HARD_BLOCKED_STRUCTURED_CREDENTIAL;
  const dependencySpecifierMap = isNpmDependencySpecifierMap(
    context.npmMetadataKind,
    context.pathSegments,
  );
  let classification = NO_STRUCTURED_CREDENTIAL;
  for (const [key, entry] of Object.entries(value)) {
    // npm package names are identifiers, not configuration assignments, but a
    // dependency map must not become a generic secret-hiding namespace. Ignore
    // a sensitive-looking package name only at an exact npm schema path and
    // only when its scalar value is a deliberately conservative semver/range.
    const sensitiveKey = isSensitiveAssignmentKey(key)
      && !isNpmLockPackageRecordIdentifier(
        context.npmMetadataKind,
        context.pathSegments,
        key,
      );
    const safeFirebaseClientApiKeyContainer = context.firebaseClientConfig
      && key === "api_key"
      && context.pathSegments.length === 2
      && context.pathSegments[0] === "client"
      && /^[0-9]+$/u.test(context.pathSegments[1])
      && Array.isArray(entry);
    const safeDependencySpecifier = sensitiveKey
      && (
        (dependencySpecifierMap && isClearlySafeNpmVersionRange(entry))
        || safeFirebaseClientApiKeyContainer
      );
    if (sensitiveKey && !safeDependencySpecifier && entry !== null && typeof entry === "object") {
      return HARD_BLOCKED_STRUCTURED_CREDENTIAL;
    }
    if (sensitiveKey && hasSubstantiveSecret(entry) && !safeDependencySpecifier) {
      const assignment = isHardBlockedStructuredAssignment(key, entry)
        ? HARD_BLOCKED_STRUCTURED_CREDENTIAL
        : APPROVABLE_STRUCTURED_CREDENTIAL;
      classification = mergeStructuredCredentialClassification(classification, assignment);
      if (!classification.override_eligible) return classification;
    }
    classification = mergeStructuredCredentialClassification(
      classification,
      jsonCredentialClassification(entry, budget, {
        npmMetadataKind: context.npmMetadataKind,
        pathSegments: [...context.pathSegments, key],
        sensitiveContext: context.sensitiveContext,
        firebaseClientConfig: context.firebaseClientConfig,
      }),
    );
    if (classification.detected && !classification.override_eligible) return classification;
  }
  return classification;
}

function npmDependencyMetadataKind(relativePath, value) {
  const basename = portableName(path.posix.basename(relativePath));
  if (basename === "package.json") {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? "package"
      : undefined;
  }
  if (basename !== "package-lock.json" && basename !== "npm-shrinkwrap.json") {
    return undefined;
  }
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Number.isSafeInteger(value.lockfileVersion)
    && value.lockfileVersion >= 1
    ? "lock"
    : undefined;
}

function assertNoDuplicateJsonObjectKeys(text) {
  let index = 0;
  const failJson = () => fail("structured JSON configuration is ambiguous or invalid");
  const skipWhitespace = () => {
    while (index < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[index])) index += 1;
  };
  const parseStringToken = () => {
    if (text[index] !== '"') failJson();
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          failJson();
        }
      }
      if (character === "\\") {
        index += 1;
        if (index >= text.length) failJson();
        if (text[index] === "u") index += 4;
      }
      index += 1;
    }
    failJson();
  };
  const parsePrimitive = () => {
    const remainder = text.slice(index);
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u.exec(remainder);
    if (match === null) failJson();
    index += match[0].length;
  };
  const parseValue = () => {
    skipWhitespace();
    if (text[index] === '"') {
      parseStringToken();
      return;
    }
    if (text[index] === "[") {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      for (;;) {
        parseValue();
        skipWhitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") failJson();
        index += 1;
      }
    }
    if (text[index] === "{") {
      index += 1;
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      const keys = new Set();
      for (;;) {
        skipWhitespace();
        const key = parseStringToken();
        if (keys.has(key)) failJson();
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ":") failJson();
        index += 1;
        parseValue();
        skipWhitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") failJson();
        index += 1;
      }
    }
    parsePrimitive();
  };
  parseValue();
  skipWhitespace();
  if (index !== text.length) failJson();
}

function configTextCredentialClassification(text, relativePath) {
  let classification = NO_STRUCTURED_CREDENTIAL;
  if (path.posix.extname(portableName(relativePath)) === ".json") {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail("structured JSON configuration is invalid");
    }
    assertNoDuplicateJsonObjectKeys(text);
    classification = jsonCredentialClassification(
      parsed,
      { nodes: 0 },
      {
        npmMetadataKind: npmDependencyMetadataKind(relativePath, parsed),
          pathSegments: [],
          sensitiveContext: false,
          firebaseClientConfig:
            portableName(path.posix.basename(relativePath)) === "google-services.json",
      },
    );
    if (classification.detected && !classification.override_eligible) return classification;
    return classification;
  }
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";") || line.startsWith("//")) continue;
    const assignment = /^(?:export\s+)?([A-Za-z0-9_.-]+)\s*(?:=|:)\s*(.+)$/u.exec(line);
    if (assignment && isSensitiveAssignmentKey(assignment[1]) && hasSubstantiveSecret(assignment[2])) {
      const detected = isHardBlockedStructuredAssignment(assignment[1], assignment[2])
        ? HARD_BLOCKED_STRUCTURED_CREDENTIAL
        : APPROVABLE_STRUCTURED_CREDENTIAL;
      classification = mergeStructuredCredentialClassification(classification, detected);
      if (!classification.override_eligible) return classification;
    }
    const xml = /<([A-Za-z0-9_.-]*(?:token|secret|password|passwd|privateKey|apiKey|accessKey)[A-Za-z0-9_.-]*)>\s*([^<]+)\s*<\//iu.exec(line);
    if (xml && hasSubstantiveSecret(xml[2])) {
      const detected = isHardBlockedStructuredAssignment(xml[1], xml[2])
        ? HARD_BLOCKED_STRUCTURED_CREDENTIAL
        : APPROVABLE_STRUCTURED_CREDENTIAL;
      classification = mergeStructuredCredentialClassification(classification, detected);
      if (!classification.override_eligible) return classification;
    }
  }
  return classification;
}

class CredentialContentDetector {
  constructor(relativePath) {
    this.structured = isStructuredConfigPath(relativePath);
    this.allowOpaqueAssignment = !isSourceCodePath(relativePath);
    this.allowPrivateKeyMarker = !isSourceCodePath(relativePath);
    this.parts = [];
    this.lineTail = "";
    this.textDecoder = new TextDecoder("utf-8", { fatal: true });
    this.textInspectionDisabled = false;
    this.privateKeyDetected = false;
    this.tokenDetected = false;
    this.relativePath = relativePath;
  }

  update(chunk) {
    if (this.structured) this.parts.push(Buffer.from(chunk));
    if (this.textInspectionDisabled) return;
    let text;
    try {
      text = this.textDecoder.decode(chunk, { stream: true });
    } catch {
      // Binary/non-UTF-8 files are not converted with replacement characters:
      // only the bounded byte-oriented hashes continue. Structured configs are
      // still rejected by the independent fatal decode in detected().
      this.textInspectionDisabled = true;
      this.lineTail = "";
      return;
    }
    this.inspectText(text);
  }

  inspectText(text) {
    const combined = `${this.lineTail}${text}`;
    const lines = combined.split(/\r?\n/u);
    this.lineTail = lines.pop() ?? "";
    for (const line of lines) this.inspectLine(line);
    while (this.lineTail.length > CREDENTIAL_TEXT_TAIL_CHARS) {
      this.inspectLine(this.lineTail.slice(0, CREDENTIAL_TEXT_TAIL_CHARS));
      this.lineTail = this.lineTail.slice(
        CREDENTIAL_TEXT_TAIL_CHARS - CREDENTIAL_TEXT_OVERLAP_CHARS,
      );
    }
  }

  inspectLine(line) {
    const trimmed = line.trim();
    if (
      PRIVATE_KEY_MARKER_RE.test(trimmed)
      && (this.allowPrivateKeyMarker || trimmed.startsWith("-----BEGIN "))
    ) {
      this.privateKeyDetected = true;
    }
    if (textLineContainsHeuristicCredential(trimmed, this.allowOpaqueAssignment)) {
      this.tokenDetected = true;
    }
  }

  detectedCredential() {
    if (!this.textInspectionDisabled) {
      try {
        this.inspectText(this.textDecoder.decode());
      } catch {
        this.textInspectionDisabled = true;
        this.lineTail = "";
      }
    }
    if (!this.textInspectionDisabled) this.inspectLine(this.lineTail);
    if (this.privateKeyDetected) {
      return {
        reason: WORKSPACE_CREDENTIAL_REASON_CODES.PRIVATE_KEY_BLOCK,
        override_eligible: false,
      };
    }
    if (this.tokenDetected) {
      return {
        reason: WORKSPACE_CREDENTIAL_REASON_CODES.HIGH_CONFIDENCE_TOKEN_OR_SENSITIVE_ASSIGNMENT,
        override_eligible: false,
      };
    }
    if (!this.structured) return undefined;
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(this.parts));
    } catch {
      fail("structured configuration is not valid UTF-8");
    }
    const structured = configTextCredentialClassification(text, this.relativePath);
    return structured.detected
      ? {
        reason: WORKSPACE_CREDENTIAL_REASON_CODES.STRUCTURED_SENSITIVE_VALUE,
        override_eligible: structured.override_eligible,
      }
      : undefined;
  }
}

function fail(message) {
  throw new Error(message);
}

function normalizedCredentialRelativePath(relativePath) {
  if (typeof relativePath !== "string") fail("credential diagnostic path is invalid");
  const normalized = relativePath.normalize("NFC");
  return validateWorkspaceRelativePath(normalized, new Set());
}

export class WorkspaceCredentialError extends Error {
  constructor(relativePath, reasonCode, message = "workspace credential policy rejected an entry") {
    if (!WORKSPACE_CREDENTIAL_REASON_CODE_SET.has(reasonCode)) {
      fail("credential diagnostic reason code is invalid");
    }
    super(message);
    Object.defineProperty(this, "name", {
      value: "WorkspaceCredentialError",
      enumerable: false,
      configurable: false,
      writable: false,
    });
    // V8's default stack contains absolute helper paths. Credential failures
    // deliberately expose no stack frames or causes to their API/CLI callers.
    Object.defineProperty(this, "stack", {
      value: `${this.name}: ${this.message}`,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    const diagnostic = Object.freeze({
      schema_version: CREDENTIAL_DIAGNOSTIC_SCHEMA,
      error_code: CREDENTIAL_DIAGNOSTIC_ERROR_CODE,
      reason: reasonCode,
      relative_path: normalizedCredentialRelativePath(relativePath),
    });
    Object.defineProperty(this, "diagnostic", {
      value: diagnostic,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
}

function failCredential(relativePath, reasonCode, message) {
  throw new WorkspaceCredentialError(relativePath, reasonCode, message);
}

function validateLifecycle(lifecycle, allowedHooks, label) {
  if (lifecycle === undefined) return;
  if (
    lifecycle === null
    || typeof lifecycle !== "object"
    || Array.isArray(lifecycle)
    || Object.keys(lifecycle).some((key) => !allowedHooks.includes(key))
    || allowedHooks.some((key) => (
      lifecycle[key] !== undefined && typeof lifecycle[key] !== "function"
    ))
  ) {
    fail(`${label} lifecycle injection is invalid`);
  }
}

function currentUid() {
  if (typeof process.getuid !== "function") {
    fail("workspace snapshots require an operating system with numeric user ownership");
  }
  return BigInt(process.getuid());
}

function portableName(value) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function isExcludedCredentialFile(name) {
  const key = portableName(name);
  return EXACT_EXCLUDED_FILES.has(key)
    || EXCLUSION_POLICY.excluded_file_prefixes.some((prefix) => key.startsWith(prefix))
    || STRONG_CREDENTIAL_NAME_RE.test(key)
    || (SENSITIVE_CONFIG_NAME_RE.test(key) && isStructuredConfigPath(key))
    || SECRET_EXTENSION_RE.test(key);
}

function isExcludedBuildArtifact(name, isDirectory) {
  const key = portableName(name);
  if (isDirectory) {
    return EXCLUSION_POLICY.excluded_artifact_directory_suffixes
      .some((suffix) => key.endsWith(suffix));
  }
  return EXACT_EXCLUDED_ARTIFACT_FILES.has(key)
    || EXCLUSION_POLICY.excluded_artifact_file_suffixes
      .some((suffix) => key.endsWith(suffix));
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateAbsolutePath(value, option) {
  if (
    typeof value !== "string"
    || !path.isAbsolute(value)
    || value.includes("\0")
    || UNSAFE_PATH_CODE_POINT_RE.test(value)
  ) {
    fail(`${option} must be an absolute path without control characters`);
  }
}

function normalizeLimits(overrides = undefined) {
  if (overrides !== undefined && (overrides === null || typeof overrides !== "object" || Array.isArray(overrides))) {
    fail("limits must be an object");
  }
  const unknown = overrides === undefined
    ? []
    : Object.keys(overrides).filter((key) => !(key in DEFAULT_WORKSPACE_LIMITS));
  if (unknown.length > 0) fail(`unsupported limit: ${unknown[0]}`);
  const limits = { ...DEFAULT_WORKSPACE_LIMITS, ...(overrides ?? {}) };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) fail(`${key} must be a positive safe integer`);
    if (value > DEFAULT_WORKSPACE_LIMITS[key]) fail(`${key} cannot exceed the fixed safety ceiling`);
  }
  return Object.freeze(limits);
}

function validatePathSegment(segment) {
  if (
    segment.length === 0
    || segment === "."
    || segment === ".."
    || segment.trim() !== segment
    || segment.includes("/")
    || segment.includes("\\")
    || UNSAFE_PATH_CODE_POINT_RE.test(segment)
  ) {
    fail("workspace contains an unsafe or non-portable path segment");
  }
}

export function validateWorkspaceRelativePath(rawPath, seenPortablePaths = new Set(), maxPathChars = DEFAULT_WORKSPACE_LIMITS.maxPathChars) {
  if (
    typeof rawPath !== "string"
    || rawPath.length === 0
    || rawPath.length > maxPathChars
    || Buffer.byteLength(rawPath, "utf8") > maxPathChars
    || rawPath.startsWith("/")
    || rawPath.includes("\\")
    || UNSAFE_PATH_CODE_POINT_RE.test(rawPath)
  ) {
    fail("workspace contains an unsafe or overlong relative path");
  }
  const segments = rawPath.split("/");
  for (const segment of segments) validatePathSegment(segment);
  const key = portableName(rawPath);
  if (seenPortablePaths.has(key)) {
    fail("workspace contains a case-insensitive or Unicode-normalized path collision");
  }
  seenPortablePaths.add(key);
  return rawPath;
}

function approvedTestFixturesDigest(entries) {
  const digest = createHash("sha256").update("crashfix-approved-test-fixtures/v1\0");
  for (const entry of entries) {
    digest.update(entry.relative_path).update("\0");
    digest.update(entry.sha256).update("\0");
  }
  return digest.digest("hex");
}

export const EMPTY_APPROVED_TEST_FIXTURES_SHA256 = approvedTestFixturesDigest([]);

const EMPTY_TEST_FIXTURE_CONTEXT = Object.freeze({
  schema_version: TEST_FIXTURE_CONTEXT_SCHEMA,
  enabled: false,
  execution_profile: "none",
  project_classification: "none",
});
const ENABLED_TEST_FIXTURE_CONTEXT = Object.freeze({
  schema_version: TEST_FIXTURE_CONTEXT_SCHEMA,
  enabled: true,
  execution_profile: "local_trusted",
  project_classification: "test",
});

function approvedTestFixtureContext(count) {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_APPROVED_TEST_FIXTURES) {
    fail("approved test fixture context count is invalid");
  }
  return count === 0 ? EMPTY_TEST_FIXTURE_CONTEXT : ENABLED_TEST_FIXTURE_CONTEXT;
}

function validateApprovedTestFixtureContext(value, count) {
  assertExactKeys(
    value,
    ["schema_version", "enabled", "execution_profile", "project_classification"],
    "approved test fixture context",
  );
  const expected = approvedTestFixtureContext(count);
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    fail("approved test fixture context does not match its sealed fixture count");
  }
  return expected;
}

function validateApprovedTestFixturePath(rawPath, seenPortablePaths) {
  if (typeof rawPath !== "string" || rawPath !== rawPath.normalize("NFC")) {
    fail("approved test fixture paths must already be NFC-normalized strings");
  }
  const relativePath = validateWorkspaceRelativePath(rawPath, seenPortablePaths);
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = portableName(segments[index]);
    if (
      ALWAYS_EXCLUDED_NAMES.has(key)
      || EXCLUDED_DIRECTORY_NAMES.has(key)
      || CREDENTIAL_DIRECTORY_NAMES.has(key)
      || isExcludedBuildArtifact(segments[index], true)
    ) {
      fail("approved test fixture path is excluded or credential-like");
    }
  }
  const basename = segments.at(-1);
  if (
    basename === undefined
    || path.posix.extname(portableName(basename)) !== ".json"
    || isExcludedCredentialFile(basename)
    || isExcludedBuildArtifact(basename, false)
  ) {
    fail("approved test fixture path must be an eligible strict JSON data file");
  }
  return relativePath;
}

function normalizeApprovedTestFixtureEntries(rawEntries, { allowEmpty }) {
  if (!Array.isArray(rawEntries)) fail("approved test fixture entries must be an array");
  if (
    rawEntries.length > MAX_APPROVED_TEST_FIXTURES
    || (!allowEmpty && rawEntries.length === 0)
  ) {
    fail("approved test fixture entry count is invalid");
  }
  const seenPortablePaths = new Set();
  const entries = rawEntries.map((entry) => {
    assertExactKeys(entry, ["relative_path", "sha256"], "approved test fixture entry");
    const relativePath = validateApprovedTestFixturePath(
      entry.relative_path,
      seenPortablePaths,
    );
    if (typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256)) {
      fail("approved test fixture hash must be a 64-character lowercase SHA-256");
    }
    return Object.freeze({ relative_path: relativePath, sha256: entry.sha256 });
  }).sort((left, right) => Buffer.compare(
    Buffer.from(left.relative_path, "utf8"),
    Buffer.from(right.relative_path, "utf8"),
  ));
  return Object.freeze(entries);
}

function approvedTestFixturePolicy(rawEntries) {
  const entries = normalizeApprovedTestFixtureEntries(rawEntries, { allowEmpty: true });
  return Object.freeze({
    entries,
    approved_test_fixture_count: entries.length,
    approved_test_fixtures_sha256: approvedTestFixturesDigest(entries),
    approved_test_fixture_context: approvedTestFixtureContext(entries.length),
    byPath: new Map(entries.map((entry) => [entry.relative_path, entry.sha256])),
  });
}

function normalizeTestFixtureApproval(receipt, expectedSourceRefSha256) {
  if (receipt === undefined) return approvedTestFixturePolicy([]);
  assertExactKeys(
    receipt,
    [
      "schema_version",
      "execution_profile",
      "project_classification",
      "user_confirmed",
      "source_ref_sha256",
      "entries",
    ],
    "test fixture approval receipt",
  );
  if (
    receipt.schema_version !== TEST_FIXTURE_APPROVAL_SCHEMA
    || receipt.execution_profile !== "local_trusted"
    || receipt.project_classification !== "test"
    || receipt.user_confirmed !== true
    || typeof receipt.source_ref_sha256 !== "string"
    || !SHA256_RE.test(receipt.source_ref_sha256)
    || receipt.source_ref_sha256 !== expectedSourceRefSha256
  ) {
    fail("test fixture approval receipt is not bound to this trusted local test source");
  }
  const entries = normalizeApprovedTestFixtureEntries(receipt.entries, { allowEmpty: false });
  return approvedTestFixturePolicy(entries);
}

const EMPTY_APPROVED_TEST_FIXTURE_POLICY = approvedTestFixturePolicy([]);

function statType(statValue) {
  if (statValue.isDirectory()) return "directory";
  if (statValue.isFile()) return "file";
  if (statValue.isSymbolicLink()) return "symbolic link";
  if (statValue.isFIFO()) return "FIFO";
  if (statValue.isSocket()) return "socket";
  if (statValue.isCharacterDevice()) return "character device";
  if (statValue.isBlockDevice()) return "block device";
  return "unsupported filesystem entry";
}

function assertOwned(statValue, label) {
  if (statValue.uid !== currentUid()) fail(`${label} is not owned by the current user`);
}

function assertNotGroupOrOtherWritable(statValue, label) {
  if ((statValue.mode & 0o022n) !== 0n) {
    fail(`${label} must not be group/other writable`);
  }
}

function identityFields(statValue) {
  return [
    statValue.dev,
    statValue.ino,
    statValue.mode,
    statValue.uid,
    statValue.gid,
    statValue.nlink,
    statValue.size,
    statValue.mtimeNs,
    statValue.ctimeNs,
  ].map(String).join(":");
}

function assertSameIdentity(expected, actual, label) {
  if (identityFields(expected) !== identityFields(actual)) {
    fail(`${label} changed while the source manifest was being read`);
  }
}

function assertRegularSingleLink(statValue, label) {
  if (!statValue.isFile()) fail(`${label} is a ${statType(statValue)}; only regular files are allowed`);
  assertOwned(statValue, label);
  assertNotGroupOrOtherWritable(statValue, label);
  if (statValue.nlink !== 1n) fail(`${label} is hard-linked; source files must have exactly one link`);
}

function assertRealDirectory(statValue, label) {
  if (!statValue.isDirectory()) fail(`${label} is a ${statType(statValue)}; only real directories are allowed`);
  assertOwned(statValue, label);
  assertNotGroupOrOtherWritable(statValue, label);
}

function directoryFlags() {
  if (FS.O_NOFOLLOW === undefined || FS.O_NONBLOCK === undefined || FS.O_DIRECTORY === undefined) {
    fail("this platform does not provide O_NOFOLLOW, O_NONBLOCK, and O_DIRECTORY");
  }
  return FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK | FS.O_DIRECTORY;
}

function sourceFileFlags() {
  if (FS.O_NOFOLLOW === undefined || FS.O_NONBLOCK === undefined) {
    fail("this platform does not provide O_NOFOLLOW and O_NONBLOCK");
  }
  return FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK;
}

function destinationFileFlags() {
  if (FS.O_NOFOLLOW === undefined || FS.O_NONBLOCK === undefined) {
    fail("this platform does not provide O_NOFOLLOW and O_NONBLOCK");
  }
  return FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW | FS.O_NONBLOCK;
}

function decodeDirectoryName(rawName) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(rawName);
  } catch {
    fail("workspace contains a non-UTF-8 path");
  }
}

async function writeAll(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.byteLength - offset,
      position + offset,
    );
    if (bytesWritten <= 0) fail("snapshot destination stopped accepting file bytes");
    offset += bytesWritten;
  }
}

async function readFileSafely({
  sourcePath,
  relativePath,
  initialStat,
  destinationPath,
  executable,
  limits,
  remainingBytes,
  destinationMutable,
  approvedTestFixtures,
  consumedApprovedTestFixtures,
  credentialMode = "enforce",
}) {
  if (credentialMode !== "enforce" && credentialMode !== "probe") {
    fail("workspace credential inspection mode is invalid");
  }
  assertRegularSingleLink(initialStat, "workspace entry");
  const declaredBytes = Number(initialStat.size);
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > limits.maxFileBytes) {
    fail("workspace file exceeds the per-file byte limit");
  }
  if (declaredBytes > remainingBytes) fail("workspace exceeds the aggregate byte limit");

  const source = await open(sourcePath, sourceFileFlags());
  let destination;
  try {
    const openedStat = await source.stat({ bigint: true });
    assertRegularSingleLink(openedStat, "opened workspace entry");
    assertSameIdentity(initialStat, openedStat, "workspace entry");

    if (destinationPath !== undefined) {
      await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
      destination = await open(destinationPath, destinationFileFlags(), 0o600);
      const destinationStat = await destination.stat({ bigint: true });
      assertRegularSingleLink(destinationStat, "snapshot destination");
      if (destinationStat.dev === openedStat.dev && destinationStat.ino === openedStat.ino) {
        fail("snapshot clone unexpectedly shares a source inode");
      }
    }

    const digest = createHash("sha256");
    const credentialDetector = new CredentialContentDetector(relativePath);
    const buffer = Buffer.allocUnsafe(Math.min(FILE_READ_CHUNK, Math.max(1, declaredBytes)));
    let position = 0;
    let prefix = Buffer.alloc(0);
    while (position < declaredBytes) {
      const wanted = Math.min(buffer.byteLength, declaredBytes - position);
      const { bytesRead } = await source.read(buffer, 0, wanted, position);
      if (bytesRead <= 0) fail("workspace file ended before its declared size");
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      credentialDetector.update(chunk);
      if (prefix.byteLength < LFS_PREFIX.byteLength) {
        const needed = LFS_PREFIX.byteLength - prefix.byteLength;
        prefix = Buffer.concat([prefix, chunk.subarray(0, needed)]);
      }
      if (destination !== undefined) await writeAll(destination, chunk, position);
      position += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await source.read(extra, 0, 1, declaredBytes);
    if (extraBytes !== 0) fail("workspace file grew while it was being read");
    if (prefix.byteLength >= LFS_PREFIX.byteLength && prefix.subarray(0, LFS_PREFIX.byteLength).equals(LFS_PREFIX)) {
      fail("workspace contains a Git LFS pointer instead of local source content");
    }
    const finalHandleStat = await source.stat({ bigint: true });
    const finalPathStat = await lstat(sourcePath, { bigint: true });
    assertSameIdentity(initialStat, finalHandleStat, "workspace entry");
    assertSameIdentity(initialStat, finalPathStat, "workspace entry");
    if (destination !== undefined) {
      const destinationStat = await destination.stat({ bigint: true });
      assertRegularSingleLink(destinationStat, "snapshot destination");
      if (destinationStat.size !== BigInt(declaredBytes)) fail("snapshot destination size does not match its source");
      await destination.chmod(destinationMutable ? (executable ? 0o700 : 0o600) : 0o600);
    }
    const sha256 = digest.digest("hex");
    const credential = credentialDetector.detectedCredential();
    const approvedSha256 = approvedTestFixtures?.byPath.get(relativePath);
    if ((credentialMode === "probe" || approvedSha256 !== undefined) && executable) {
      fail("approved test fixtures must be non-executable regular data files");
    }
    if (credentialMode === "probe") {
      if (credential === undefined || !credential.override_eligible) {
        if (credential !== undefined) {
          failCredential(
            relativePath,
            credential.reason,
            "workspace credential policy rejected a non-approvable test fixture",
          );
        }
        fail("test fixture probe target does not require an approvable structured-value exception");
      }
    } else {
      if (credential !== undefined) {
        if (
          credential.reason === WORKSPACE_CREDENTIAL_REASON_CODES.STRUCTURED_SENSITIVE_VALUE
          && credential.override_eligible
          && approvedSha256 === sha256
        ) {
          if (consumedApprovedTestFixtures?.has(relativePath)) {
            fail("approved test fixture was consumed more than once in one workspace scan");
          }
          consumedApprovedTestFixtures?.add(relativePath);
        } else {
          failCredential(
            relativePath,
            credential.reason,
            "workspace contains credential material without an exact eligible test fixture approval",
          );
        }
      } else if (approvedSha256 !== undefined) {
        fail("approved test fixture no longer has the exact eligible structured-value classification");
      }
    }
    return {
      path: relativePath,
      type: "file",
      mode: executable ? "100755" : "100644",
      size: declaredBytes,
      sha256,
      ...(credentialMode === "probe" ? {
        fixture_reason: credential.reason,
        fixture_override_eligible: true,
      } : {}),
      source_identity: identityFields(initialStat),
    };
  } finally {
    await destination?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}

function manifestDigest(entries) {
  const digest = createHash("sha256");
  for (const entry of entries) {
    digest.update(entry.type).update("\0");
    digest.update(entry.mode).update("\0");
    digest.update(entry.path).update("\0");
    if (entry.type === "file") {
      digest.update(String(entry.size)).update("\0");
      digest.update(entry.sha256).update("\0");
    }
  }
  return digest.digest("hex");
}

function stabilityDigest(rootIdentity, entries) {
  const digest = createHash("sha256");
  digest.update(rootIdentity).update("\0");
  for (const entry of entries) {
    digest.update(entry.type).update("\0");
    digest.update(entry.path).update("\0");
    digest.update(entry.source_identity).update("\0");
    if (entry.type === "file") digest.update(entry.sha256).update("\0");
  }
  return digest.digest("hex");
}

function publicEntries(entries) {
  return entries.map(({ source_identity: _sourceIdentity, ...entry }) => entry);
}

async function scanWorkspace({
  sourceRoot,
  destinationRoot,
  limits,
  destinationMutable = false,
  destinationRootPrecreated = false,
  requireSealed = false,
  requireMutableApprovedFixturePermissions = false,
  rejectCredentialEntries = false,
  excludedAbsoluteRoots = [],
  approvedTestFixtures = EMPTY_APPROVED_TEST_FIXTURE_POLICY,
}) {
  if (
    approvedTestFixtures === null
    || typeof approvedTestFixtures !== "object"
    || !(approvedTestFixtures.byPath instanceof Map)
  ) {
    fail("approved test fixture scan policy is invalid");
  }
  const seenPortablePaths = new Set();
  const consumedApprovedTestFixtures = new Set();
  const entries = [];
  const state = { files: 0, directories: 1, bytes: 0 };
  const rootBefore = await lstat(sourceRoot, { bigint: true });
  assertRealDirectory(rootBefore, "workspace root");
  if (requireSealed && Number(rootBefore.mode & 0o777n) !== 0o500) {
    fail("sealed snapshot root permissions changed");
  }

  async function walk(sourceDirectory, relativeDirectory, depth, initialDirectoryStat) {
    if (depth > limits.maxDepth) fail("workspace exceeds the directory-depth limit");
    const directory = await open(sourceDirectory, directoryFlags());
    try {
      const openedDirectoryStat = await directory.stat({ bigint: true });
      assertRealDirectory(openedDirectoryStat, "workspace directory");
      assertSameIdentity(initialDirectoryStat, openedDirectoryStat, "workspace directory");
      if (requireSealed && Number(openedDirectoryStat.mode & 0o777n) !== 0o500) {
        fail("sealed snapshot directory permissions changed");
      }
      const canonicalDirectory = await realpath(sourceDirectory);
      if (!isInside(sourceRoot, canonicalDirectory)) fail("workspace directory resolves outside its root");

      const rawNames = await readdir(sourceDirectory, { encoding: "buffer" });
      if (rawNames.length > limits.maxFiles + limits.maxDirectories) {
        fail("workspace directory enumeration exceeds the combined file/directory budget");
      }
      const names = rawNames.map(decodeDirectoryName).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
      for (const name of names) {
        validatePathSegment(name);
        const key = portableName(name);
        if (ALWAYS_EXCLUDED_NAMES.has(key)) continue;

        const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
        const sourcePath = path.join(sourceDirectory, name);
        if (excludedAbsoluteRoots.some((excludedRoot) => isInside(excludedRoot, sourcePath))) {
          continue;
        }
        const entryStat = await lstat(sourcePath, { bigint: true });
        if (entryStat.isDirectory() && EXCLUDED_DIRECTORY_NAMES.has(key)) continue;
        if (isExcludedBuildArtifact(name, entryStat.isDirectory())) continue;
        if (entryStat.isDirectory() && CREDENTIAL_DIRECTORY_NAMES.has(key)) {
          if (rejectCredentialEntries) {
            failCredential(
              relativePath,
              WORKSPACE_CREDENTIAL_REASON_CODES.CREDENTIAL_DIRECTORY_NAME,
              "audited workspace introduced a credential directory",
            );
          }
          continue;
        }
        if (entryStat.isFile() && isExcludedCredentialFile(name)) {
          if (rejectCredentialEntries) {
            failCredential(
              relativePath,
              WORKSPACE_CREDENTIAL_REASON_CODES.CREDENTIAL_FILE_NAME,
              "audited workspace introduced a credential file",
            );
          }
          continue;
        }

        validateWorkspaceRelativePath(relativePath, seenPortablePaths, limits.maxPathChars);
        if (entryStat.isDirectory()) {
          assertRealDirectory(entryStat, "workspace entry");
          if (state.directories >= limits.maxDirectories) fail("workspace exceeds the directory-count limit");
          if (depth + 1 > limits.maxDepth) fail("workspace exceeds the directory-depth limit");
          state.directories += 1;
          const directoryEntry = {
            path: relativePath,
            type: "directory",
            mode: "040000",
            source_identity: identityFields(entryStat),
          };
          entries.push(directoryEntry);
          if (destinationRoot !== undefined) {
            const destinationDirectory = path.resolve(destinationRoot, ...relativePath.split("/"));
            if (!isInside(destinationRoot, destinationDirectory)) fail("snapshot destination escaped its private root");
            await mkdir(destinationDirectory, { mode: 0o700 });
          }
          await walk(sourcePath, relativePath, depth + 1, entryStat);
          continue;
        }
        if (!entryStat.isFile()) {
          fail(`workspace contains a ${statType(entryStat)}; only regular files and real directories are allowed`);
        }
        if (state.files >= limits.maxFiles) fail("workspace exceeds the file-count limit");
        const executable = (entryStat.mode & 0o111n) !== 0n;
        const isApprovedTestFixture = approvedTestFixtures.byPath.has(relativePath);
        if (
          isApprovedTestFixture
          && requireMutableApprovedFixturePermissions
          && Number(entryStat.mode & 0o777n) !== 0o600
        ) {
          fail("approved test fixture mutable permissions changed");
        }
        if (requireSealed) {
          const expectedMode = executable ? 0o500 : 0o400;
          if (Number(entryStat.mode & 0o777n) !== expectedMode) fail("sealed snapshot file permissions changed");
        }
        const destinationPath = destinationRoot === undefined
          ? undefined
          : path.resolve(destinationRoot, ...relativePath.split("/"));
        if (destinationPath !== undefined && !isInside(destinationRoot, destinationPath)) {
          fail("snapshot destination escaped its private root");
        }
        const fileEntry = await readFileSafely({
          sourcePath,
          relativePath,
          initialStat: entryStat,
          destinationPath,
          executable,
          limits,
          remainingBytes: limits.maxTotalBytes - state.bytes,
          destinationMutable,
          approvedTestFixtures,
          consumedApprovedTestFixtures,
        });
        state.files += 1;
        state.bytes += fileEntry.size;
        entries.push(fileEntry);
      }
      const finalHandleStat = await directory.stat({ bigint: true });
      const finalPathStat = await lstat(sourceDirectory, { bigint: true });
      assertSameIdentity(initialDirectoryStat, finalHandleStat, "workspace directory");
      assertSameIdentity(initialDirectoryStat, finalPathStat, "workspace directory");
    } finally {
      await directory.close().catch(() => undefined);
    }
  }

  if (destinationRoot !== undefined && !destinationRootPrecreated) {
    await mkdir(destinationRoot, { mode: 0o700 });
  }
  await walk(sourceRoot, "", 0, rootBefore);
  const rootAfter = await lstat(sourceRoot, { bigint: true });
  assertSameIdentity(rootBefore, rootAfter, "workspace root");
  if (
    consumedApprovedTestFixtures.size !== approvedTestFixtures.approved_test_fixture_count
    || approvedTestFixtures.entries.some((entry) => !consumedApprovedTestFixtures.has(entry.relative_path))
  ) {
    fail("approved test fixture set was not exactly consumed by the workspace scan");
  }
  const cleanEntries = publicEntries(entries);
  return {
    entries: cleanEntries,
    manifest_sha256: manifestDigest(cleanEntries),
    stability_sha256: stabilityDigest(identityFields(rootBefore), entries),
    files: state.files,
    directories: state.directories,
    bytes: state.bytes,
  };
}

function assertSameScan(first, second) {
  if (
    first.stability_sha256 !== second.stability_sha256
    || first.manifest_sha256 !== second.manifest_sha256
    || first.files !== second.files
    || first.directories !== second.directories
    || first.bytes !== second.bytes
  ) {
    fail("workspace changed between the two source manifest passes");
  }
}

async function canonicalOwnedDirectory(value, option, { sealed = false } = {}) {
  validateAbsolutePath(value, option);
  const before = await lstat(value, { bigint: true });
  assertRealDirectory(before, option);
  const canonical = await realpath(value);
  const after = await lstat(canonical, { bigint: true });
  assertRealDirectory(after, option);
  if (before.dev !== after.dev || before.ino !== after.ino) fail(`${option} changed during validation`);
  if (sealed && Number(after.mode & 0o777n) !== 0o500) fail(`${option} is not a sealed snapshot directory`);
  return canonical;
}

async function canonicalForbidRoots(forbidRoot, forbidRoots) {
  if (forbidRoots !== undefined && !Array.isArray(forbidRoots)) {
    fail("forbidRoots must be an array of absolute paths");
  }
  const values = [
    ...(forbidRoot === undefined ? [] : [forbidRoot]),
    ...(forbidRoots ?? []),
  ];
  if (values.length > 16) fail("at most 16 forbidden roots may be supplied");
  const canonical = [];
  for (const value of values) {
    const root = await canonicalOwnedDirectory(value, "--forbid-root");
    if (!canonical.includes(root)) canonical.push(root);
  }
  return canonical;
}

function assertDisjointRoots(firstRoot, forbiddenRoots, label) {
  for (const forbiddenRoot of forbiddenRoots) {
    if (isInside(firstRoot, forbiddenRoot) || isInside(forbiddenRoot, firstRoot)) {
      fail(`${label} must not overlap a forbidden project/session/viewer root in either direction`);
    }
  }
}

async function createPrivateRoot(prefix, forbiddenRoots, sourceRoot) {
  const created = await mkdtemp(path.join(tmpdir(), prefix));
  await chmod(created, 0o700);
  const privateRoot = await realpath(created);
  try {
    if (forbiddenRoots.some((forbiddenRoot) => isInside(forbiddenRoot, privateRoot))) {
      fail("private workspace must stay outside every forbidden project/session/viewer root");
    }
    if (sourceRoot !== undefined && isInside(sourceRoot, privateRoot)) {
      fail("private workspace must not be created inside its source tree");
    }
    return privateRoot;
  } catch (error) {
    await cleanupPrivateRoot(privateRoot);
    throw error;
  }
}

async function cleanupPrivateRoot(privateRoot) {
  if (privateRoot === undefined) return;
  // A failure during the sealing phase may leave read-only directories. Only
  // paths below the random root created by this process are made writable.
  async function unlock(entryPath) {
    let entryStat;
    try {
      entryStat = await lstat(entryPath, { bigint: true });
    } catch {
      return;
    }
    if (entryStat.isSymbolicLink()) return;
    if (entryStat.isDirectory()) {
      await chmod(entryPath, 0o700).catch(() => undefined);
      const names = await readdir(entryPath).catch(() => []);
      for (const name of names) await unlock(path.join(entryPath, name));
    } else {
      await chmod(entryPath, 0o600).catch(() => undefined);
    }
  }
  await unlock(privateRoot);
  await rm(privateRoot, { recursive: true, force: true });
}

async function sealSnapshot(snapshotRoot, entries) {
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const destination = path.resolve(snapshotRoot, ...entry.path.split("/"));
    await chmod(destination, entry.mode === "100755" ? 0o500 : 0o400);
  }
  const directories = entries
    .filter((entry) => entry.type === "directory")
    .sort((left, right) => right.path.split("/").length - left.path.split("/").length);
  for (const entry of directories) {
    await chmod(path.resolve(snapshotRoot, ...entry.path.split("/")), 0o500);
  }
  await chmod(snapshotRoot, 0o500);
}

function sourceReference(canonicalWorkspace) {
  return createHash("sha256")
    .update("crashfix-workspace-source/v1\0")
    .update(canonicalWorkspace)
    .digest("hex");
}

export async function probeTestFixture({
  workspace,
  relativePath,
  limits: limitOverrides,
} = {}) {
  const limits = normalizeLimits(limitOverrides);
  const canonicalWorkspace = await canonicalOwnedDirectory(workspace, "--workspace");
  const normalizedPath = validateApprovedTestFixturePath(relativePath, new Set());
  const rootBefore = await lstat(canonicalWorkspace, { bigint: true });
  assertRealDirectory(rootBefore, "workspace root");
  const pinnedAncestors = [];
  let current = canonicalWorkspace;
  const segments = normalizedPath.split("/");
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = path.join(current, segments[index]);
    const entryStat = await lstat(current, { bigint: true });
    assertRealDirectory(entryStat, "test fixture parent directory");
    const canonicalDirectory = await realpath(current);
    if (!isInside(canonicalWorkspace, canonicalDirectory)) {
      fail("test fixture parent directory resolves outside the workspace");
    }
    pinnedAncestors.push({ entryPath: current, stat: entryStat });
  }
  const sourcePath = path.resolve(canonicalWorkspace, ...segments);
  if (!isInside(canonicalWorkspace, sourcePath)) fail("test fixture path escaped the workspace");
  const initialStat = await lstat(sourcePath, { bigint: true });
  const entry = await readFileSafely({
    sourcePath,
    relativePath: normalizedPath,
    initialStat,
    executable: (initialStat.mode & 0o111n) !== 0n,
    limits,
    remainingBytes: limits.maxTotalBytes,
    credentialMode: "probe",
  });
  for (const ancestor of pinnedAncestors) {
    assertSameIdentity(
      ancestor.stat,
      await lstat(ancestor.entryPath, { bigint: true }),
      "test fixture parent directory",
    );
  }
  assertSameIdentity(
    rootBefore,
    await lstat(canonicalWorkspace, { bigint: true }),
    "workspace root",
  );
  return {
    schema_version: TEST_FIXTURE_PROBE_SCHEMA,
    source_ref_sha256: sourceReference(canonicalWorkspace),
    relative_path: normalizedPath,
    sha256: entry.sha256,
    bytes: entry.size,
    reason: entry.fixture_reason,
    override_eligible: entry.fixture_override_eligible,
    approval_requires_user_confirmation: true,
  };
}

function dynamicExclusionsForWorkspace(canonicalWorkspace, forbiddenRoots) {
  const candidates = [];
  const seen = new Set();
  for (const forbiddenRoot of forbiddenRoots) {
    if (forbiddenRoot === canonicalWorkspace || isInside(forbiddenRoot, canonicalWorkspace)) {
      fail("workspace cannot be equal to or nested below a forbidden root");
    }
    if (!isInside(canonicalWorkspace, forbiddenRoot)) continue;
    const relativePath = path.relative(canonicalWorkspace, forbiddenRoot).split(path.sep).join("/");
    validateWorkspaceRelativePath(relativePath, seen);
    candidates.push({ relativePath, absolutePath: forbiddenRoot });
  }
  // A parent exclusion already covers all of its descendants. Keeping a
  // per-session child below a stable report root would otherwise make the
  // content identity change even though the effective source view is equal.
  candidates.sort((left, right) => {
    const depth = left.relativePath.split("/").length - right.relativePath.split("/").length;
    return depth || Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath));
  });
  const topmost = [];
  for (const candidate of candidates) {
    if (topmost.some((entry) => isInside(entry.absolutePath, candidate.absolutePath))) continue;
    topmost.push(candidate);
  }
  const ordered = topmost
    .sort((left, right) => Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)));
  const digest = createHash("sha256").update("crashfix-workspace-dynamic-exclusions/v1\0");
  for (const entry of ordered) digest.update(entry.relativePath).update("\0");
  return {
    dynamic_exclusions_sha256: digest.digest("hex"),
    excludedAbsoluteRoots: ordered.map((entry) => entry.absolutePath),
  };
}

function sourceSnapshotIdentity(
  manifestSha256,
  dynamicExclusionsSha256,
  approvedTestFixturesSha256,
  approvedTestFixtureCount,
  approvedTestFixtureContextValue = approvedTestFixtureContext(approvedTestFixtureCount),
) {
  const context = validateApprovedTestFixtureContext(
    approvedTestFixtureContextValue,
    approvedTestFixtureCount,
  );
  return createHash("sha256")
    .update("crashfix-workspace-source-snapshot/v2\0")
    .update(manifestSha256).update("\0")
    .update(EXCLUSION_POLICY_SHA256).update("\0")
    .update(dynamicExclusionsSha256).update("\0")
    .update(approvedTestFixturesSha256).update("\0")
    .update(JSON.stringify(context)).update("\0")
    .update(String(approvedTestFixtureCount)).update("\0")
    .digest("hex");
}

function manifestDocument(scan, sourceRef, dynamicExclusionsSha256, approvedTestFixtures) {
  return {
    schema_version: WORKSPACE_MANIFEST_SCHEMA,
    source_ref_sha256: sourceRef,
    manifest_sha256: scan.manifest_sha256,
    source_snapshot_sha256: sourceSnapshotIdentity(
      scan.manifest_sha256,
      dynamicExclusionsSha256,
      approvedTestFixtures.approved_test_fixtures_sha256,
      approvedTestFixtures.approved_test_fixture_count,
      approvedTestFixtures.approved_test_fixture_context,
    ),
    exclusion_policy_sha256: EXCLUSION_POLICY_SHA256,
    dynamic_exclusions_sha256: dynamicExclusionsSha256,
    approved_test_fixtures_sha256: approvedTestFixtures.approved_test_fixtures_sha256,
    approved_test_fixture_count: approvedTestFixtures.approved_test_fixture_count,
    approved_test_fixture_context: approvedTestFixtures.approved_test_fixture_context,
    approved_test_fixtures: approvedTestFixtures.entries,
    files: scan.files,
    directories: scan.directories,
    bytes: scan.bytes,
    entries: scan.entries,
  };
}

async function writeMetadata(privateRoot, owner, manifest, maxManifestBytes) {
  const ownerJson = `${JSON.stringify(owner)}\n`;
  const manifestJson = `${JSON.stringify(manifest)}\n`;
  if (Buffer.byteLength(ownerJson, "utf8") > 64 * 1024) fail("snapshot owner exceeds its byte limit");
  if (Buffer.byteLength(manifestJson, "utf8") > maxManifestBytes) {
    fail("snapshot manifest exceeds its byte limit");
  }
  await writeFile(path.join(privateRoot, OWNER_FILE), ownerJson, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(privateRoot, MANIFEST_FILE), manifestJson, { flag: "wx", mode: 0o600 });
  await chmod(path.join(privateRoot, OWNER_FILE), 0o400);
  await chmod(path.join(privateRoot, MANIFEST_FILE), 0o400);
}

export async function materializeWorkspaceSnapshot({
  workspace,
  forbidRoot,
  forbidRoots,
  testFixtureApproval,
  limits: limitOverrides,
} = {}, lifecycle = undefined) {
  validateLifecycle(lifecycle, ["betweenSnapshotVerificationPasses"], "workspace snapshot");
  const limits = normalizeLimits(limitOverrides);
  const canonicalWorkspace = await canonicalOwnedDirectory(workspace, "--workspace");
  const forbiddenRoots = await canonicalForbidRoots(forbidRoot, forbidRoots);
  if (forbiddenRoots.length < 1) {
    fail("workspace snapshot requires a report/viewer forbidden root in addition to its implicit project root");
  }
  const sourceRef = sourceReference(canonicalWorkspace);
  const approvedTestFixtures = normalizeTestFixtureApproval(
    testFixtureApproval,
    sourceRef,
  );
  const dynamicExclusions = dynamicExclusionsForWorkspace(canonicalWorkspace, forbiddenRoots);
  const first = await scanWorkspace({
    sourceRoot: canonicalWorkspace,
    limits,
    excludedAbsoluteRoots: dynamicExclusions.excludedAbsoluteRoots,
    approvedTestFixtures,
  });
  let privateRoot;
  try {
    privateRoot = await createPrivateRoot(
      "app-test-ctrl-crashfix-workspace-",
      forbiddenRoots,
      canonicalWorkspace,
    );
    const snapshotDir = path.join(privateRoot, SNAPSHOT_DIR);
    const second = await scanWorkspace({
      sourceRoot: canonicalWorkspace,
      destinationRoot: snapshotDir,
      limits,
      excludedAbsoluteRoots: dynamicExclusions.excludedAbsoluteRoots,
      approvedTestFixtures,
    });
    assertSameScan(first, second);
    const manifest = manifestDocument(
      second,
      sourceRef,
      dynamicExclusions.dynamic_exclusions_sha256,
      approvedTestFixtures,
    );
    await sealSnapshot(snapshotDir, second.entries);
    const copiedFirst = await scanWorkspace({
      sourceRoot: snapshotDir,
      limits,
      requireSealed: true,
      rejectCredentialEntries: true,
      approvedTestFixtures,
    });
    await lifecycle?.betweenSnapshotVerificationPasses?.(snapshotDir);
    const copiedSecond = await scanWorkspace({
      sourceRoot: snapshotDir,
      limits,
      requireSealed: true,
      rejectCredentialEntries: true,
      approvedTestFixtures,
    });
    assertSameScan(copiedFirst, copiedSecond);
    if (
      copiedSecond.manifest_sha256 !== manifest.manifest_sha256
      || copiedSecond.files !== manifest.files
      || copiedSecond.directories !== manifest.directories
      || copiedSecond.bytes !== manifest.bytes
      || JSON.stringify(copiedSecond.entries) !== JSON.stringify(manifest.entries)
    ) {
      fail("sealed snapshot copy does not match its trusted source manifest");
    }
    const owner = {
      schema_version: WORKSPACE_OWNER_SCHEMA,
      kind: "sealed-source",
      source_ref_sha256: sourceRef,
      manifest_sha256: second.manifest_sha256,
      source_snapshot_sha256: manifest.source_snapshot_sha256,
      exclusion_policy_sha256: EXCLUSION_POLICY_SHA256,
      dynamic_exclusions_sha256: dynamicExclusions.dynamic_exclusions_sha256,
      approved_test_fixtures_sha256: approvedTestFixtures.approved_test_fixtures_sha256,
      approved_test_fixture_count: approvedTestFixtures.approved_test_fixture_count,
      approved_test_fixture_context: approvedTestFixtures.approved_test_fixture_context,
    };
    await writeMetadata(privateRoot, owner, manifest, limits.maxManifestBytes);
    return {
      schema_version: WORKSPACE_SNAPSHOT_SCHEMA,
      snapshot_dir: snapshotDir,
      snapshot_root: privateRoot,
      source_ref_sha256: sourceRef,
      manifest_sha256: second.manifest_sha256,
      source_snapshot_sha256: manifest.source_snapshot_sha256,
      exclusion_policy_sha256: EXCLUSION_POLICY_SHA256,
      dynamic_exclusions_sha256: dynamicExclusions.dynamic_exclusions_sha256,
      approved_test_fixtures_sha256: approvedTestFixtures.approved_test_fixtures_sha256,
      approved_test_fixture_count: approvedTestFixtures.approved_test_fixture_count,
      approved_test_fixture_context: approvedTestFixtures.approved_test_fixture_context,
      files: second.files,
      directories: second.directories,
      bytes: second.bytes,
      cleanup_requires_confirmation: true,
    };
  } catch (error) {
    await cleanupPrivateRoot(privateRoot);
    throw error;
  }
}

async function readBoundedJson(filePath, maxBytes, label) {
  const before = await lstat(filePath, { bigint: true });
  assertRegularSingleLink(before, label);
  if (before.size < 1n || before.size > BigInt(maxBytes)) fail(`${label} exceeds its byte limit`);
  if (Number(before.mode & 0o777n) !== 0o400) fail(`${label} is not sealed`);
  const handle = await open(filePath, sourceFileFlags());
  try {
    const opened = await handle.stat({ bigint: true });
    assertSameIdentity(before, opened, label);
    const length = Number(before.size);
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
      if (bytesRead <= 0) fail(`${label} ended before its declared size`);
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, length)).bytesRead !== 0) fail(`${label} grew while being read`);
    const finalHandle = await handle.stat({ bigint: true });
    const finalPath = await lstat(filePath, { bigint: true });
    assertSameIdentity(before, finalHandle, label);
    assertSameIdentity(before, finalPath, label);
    let decoded;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      fail(`${label} is not UTF-8 JSON`);
    }
    try {
      return JSON.parse(decoded);
    } catch {
      fail(`${label} is not valid JSON`);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label} has unsupported or missing fields`);
}

function validateManifestDocument(manifest, limits) {
  assertExactKeys(
    manifest,
    [
      "schema_version", "source_ref_sha256", "manifest_sha256", "source_snapshot_sha256",
      "exclusion_policy_sha256", "dynamic_exclusions_sha256",
      "approved_test_fixtures_sha256", "approved_test_fixture_count",
      "approved_test_fixture_context", "approved_test_fixtures",
      "files", "directories", "bytes", "entries",
    ],
    "snapshot manifest",
  );
  if (manifest.schema_version !== WORKSPACE_MANIFEST_SCHEMA) fail("snapshot manifest schema is unsupported");
  const approvedTestFixtures = approvedTestFixturePolicy(
    normalizeApprovedTestFixtureEntries(manifest.approved_test_fixtures, { allowEmpty: true }),
  );
  const approvedTestFixtureContextValue = validateApprovedTestFixtureContext(
    manifest.approved_test_fixture_context,
    approvedTestFixtures.approved_test_fixture_count,
  );
  if (
    !SHA256_RE.test(manifest.source_ref_sha256)
    || !SHA256_RE.test(manifest.manifest_sha256)
    || !SHA256_RE.test(manifest.source_snapshot_sha256)
    || !SHA256_RE.test(manifest.exclusion_policy_sha256)
    || !SHA256_RE.test(manifest.dynamic_exclusions_sha256)
    || !SHA256_RE.test(manifest.approved_test_fixtures_sha256)
    || manifest.exclusion_policy_sha256 !== EXCLUSION_POLICY_SHA256
    || manifest.approved_test_fixture_count !== approvedTestFixtures.approved_test_fixture_count
    || manifest.approved_test_fixtures_sha256 !== approvedTestFixtures.approved_test_fixtures_sha256
    || JSON.stringify(manifest.approved_test_fixture_context) !== JSON.stringify(approvedTestFixtureContextValue)
    || JSON.stringify(manifest.approved_test_fixtures) !== JSON.stringify(approvedTestFixtures.entries)
    || manifest.source_snapshot_sha256 !== sourceSnapshotIdentity(
      manifest.manifest_sha256,
      manifest.dynamic_exclusions_sha256,
      manifest.approved_test_fixtures_sha256,
      manifest.approved_test_fixture_count,
      manifest.approved_test_fixture_context,
    )
  ) {
    fail("snapshot manifest identity or exclusion policy is invalid");
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length > limits.maxFiles + limits.maxDirectories) {
    fail("snapshot manifest entry count is invalid");
  }
  const seen = new Set();
  let files = 0;
  let directories = 1;
  let bytes = 0;
  const normalized = [];
  for (const entry of manifest.entries) {
    if (entry?.type === "directory") {
      assertExactKeys(entry, ["path", "type", "mode"], "snapshot directory entry");
      if (entry.mode !== "040000") fail("snapshot directory mode is invalid");
      validateWorkspaceRelativePath(entry.path, seen, limits.maxPathChars);
      directories += 1;
    } else if (entry?.type === "file") {
      assertExactKeys(entry, ["path", "type", "mode", "size", "sha256"], "snapshot file entry");
      validateWorkspaceRelativePath(entry.path, seen, limits.maxPathChars);
      if (entry.mode !== "100644" && entry.mode !== "100755") fail("snapshot file mode is invalid");
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limits.maxFileBytes) {
        fail("snapshot file size is invalid");
      }
      if (!SHA256_RE.test(entry.sha256)) fail("snapshot file hash is invalid");
      files += 1;
      bytes += entry.size;
      if (files > limits.maxFiles || bytes > limits.maxTotalBytes) fail("snapshot manifest exceeds workspace budgets");
    } else {
      fail("snapshot manifest contains an unsupported entry type");
    }
    normalized.push(entry);
  }
  if (directories > limits.maxDirectories) fail("snapshot manifest exceeds the directory-count limit");
  if (
    manifest.files !== files
    || manifest.directories !== directories
    || manifest.bytes !== bytes
    || manifest.manifest_sha256 !== manifestDigest(normalized)
  ) {
    fail("snapshot manifest counts or digest are invalid");
  }
  const fileByPath = new Map(
    normalized
      .filter((entry) => entry.type === "file")
      .map((entry) => [entry.path, entry]),
  );
  for (const fixture of approvedTestFixtures.entries) {
    const fileEntry = fileByPath.get(fixture.relative_path);
    if (
      fileEntry === undefined
      || fileEntry.mode !== "100644"
      || fileEntry.sha256 !== fixture.sha256
    ) {
      fail("snapshot manifest approved test fixture binding is invalid");
    }
  }
}

function assertOwnerBinding(owner, manifest, role = undefined) {
  const sourceOwner = role === undefined;
  assertExactKeys(
    owner,
    sourceOwner
      ? [
        "schema_version", "kind", "source_ref_sha256", "manifest_sha256",
        "source_snapshot_sha256", "exclusion_policy_sha256", "dynamic_exclusions_sha256",
        "approved_test_fixtures_sha256", "approved_test_fixture_count",
        "approved_test_fixture_context",
      ]
      : [
        "schema_version", "role", "source_ref_sha256", "manifest_sha256",
        "source_snapshot_sha256", "exclusion_policy_sha256", "dynamic_exclusions_sha256",
        "approved_test_fixtures_sha256", "approved_test_fixture_count",
        "approved_test_fixture_context",
      ],
    sourceOwner ? "snapshot owner" : "clone owner",
  );
  if (sourceOwner) {
    if (owner.schema_version !== WORKSPACE_OWNER_SCHEMA || owner.kind !== "sealed-source") {
      fail("snapshot owner is not a sealed CrashFix workspace source");
    }
  } else if (
    owner.schema_version !== WORKSPACE_CLONE_OWNER_SCHEMA
    || (owner.role !== "baseline" && owner.role !== "candidate")
    || owner.role !== role
  ) {
    fail("clone owner role does not match the requested audit role");
  }
  const approvedTestFixtureContextValue = validateApprovedTestFixtureContext(
    owner.approved_test_fixture_context,
    owner.approved_test_fixture_count,
  );
  if (
    !SHA256_RE.test(owner.source_ref_sha256)
    || !SHA256_RE.test(owner.manifest_sha256)
    || !SHA256_RE.test(owner.source_snapshot_sha256)
    || !SHA256_RE.test(owner.exclusion_policy_sha256)
    || !SHA256_RE.test(owner.dynamic_exclusions_sha256)
    || !SHA256_RE.test(owner.approved_test_fixtures_sha256)
    || !Number.isSafeInteger(owner.approved_test_fixture_count)
    || owner.approved_test_fixture_count < 0
    || owner.approved_test_fixture_count > MAX_APPROVED_TEST_FIXTURES
    || owner.source_ref_sha256 !== manifest.source_ref_sha256
    || owner.manifest_sha256 !== manifest.manifest_sha256
    || owner.source_snapshot_sha256 !== manifest.source_snapshot_sha256
    || owner.exclusion_policy_sha256 !== manifest.exclusion_policy_sha256
    || owner.dynamic_exclusions_sha256 !== manifest.dynamic_exclusions_sha256
    || owner.approved_test_fixtures_sha256 !== manifest.approved_test_fixtures_sha256
    || owner.approved_test_fixture_count !== manifest.approved_test_fixture_count
    || JSON.stringify(owner.approved_test_fixture_context) !== JSON.stringify(approvedTestFixtureContextValue)
    || JSON.stringify(owner.approved_test_fixture_context) !== JSON.stringify(manifest.approved_test_fixture_context)
    || owner.exclusion_policy_sha256 !== EXCLUSION_POLICY_SHA256
  ) {
    fail("workspace owner and manifest identities do not match");
  }
}

function validateStoredManifest(owner, manifest, limits) {
  validateManifestDocument(manifest, limits);
  assertOwnerBinding(owner, manifest);
}

export async function cloneSnapshotWorkspace({
  snapshotRoot,
  role,
  expectedSourceRefSha256,
  expectedSourceSnapshotSha256,
  forbidRoot,
  forbidRoots,
  limits: limitOverrides,
} = {}, lifecycle = undefined) {
  validateLifecycle(lifecycle, ["betweenWorkspaceVerificationPasses"], "snapshot clone");
  if (role !== "baseline" && role !== "candidate") fail("--role must be baseline or candidate");
  if (typeof expectedSourceRefSha256 !== "string" || !SHA256_RE.test(expectedSourceRefSha256)) {
    fail("--expected-source-ref-sha256 must be the in-memory locked 64-character source reference hash");
  }
  if (typeof expectedSourceSnapshotSha256 !== "string" || !SHA256_RE.test(expectedSourceSnapshotSha256)) {
    fail("--expected-source-sha256 must be the in-memory locked 64-character content-addressed source hash");
  }
  const limits = normalizeLimits(limitOverrides);
  const sourcePrivateRoot = await canonicalOwnedDirectory(snapshotRoot, "--snapshot-root");
  const sourcePrivateStat = await lstat(sourcePrivateRoot, { bigint: true });
  assertRealDirectory(sourcePrivateStat, "snapshot private root");
  if (Number(sourcePrivateStat.mode & 0o777n) !== 0o700) fail("snapshot private root permissions changed");
  const canonicalSnapshot = await canonicalOwnedDirectory(
    path.join(sourcePrivateRoot, SNAPSHOT_DIR),
    "sealed snapshot",
    { sealed: true },
  );
  if (path.dirname(canonicalSnapshot) !== sourcePrivateRoot) {
    fail("sealed snapshot directory escaped its private root");
  }
  const owner = await readBoundedJson(path.join(sourcePrivateRoot, OWNER_FILE), 64 * 1024, "snapshot owner");
  const manifest = await readBoundedJson(
    path.join(sourcePrivateRoot, MANIFEST_FILE),
    limits.maxManifestBytes,
    "snapshot manifest",
  );
  validateStoredManifest(owner, manifest, limits);
  const approvedTestFixtures = approvedTestFixturePolicy(manifest.approved_test_fixtures);
  if (owner.source_ref_sha256 !== expectedSourceRefSha256) {
    fail("sealed snapshot does not match the in-memory locked source reference");
  }
  if (owner.source_snapshot_sha256 !== expectedSourceSnapshotSha256) {
    fail("sealed snapshot does not match the in-memory locked source hash");
  }

  const forbiddenRoots = await canonicalForbidRoots(forbidRoot, forbidRoots);
  if (forbiddenRoots.length < 2) {
    fail("snapshot clone requires distinct original-project and report/viewer forbidden roots");
  }
  assertDisjointRoots(sourcePrivateRoot, forbiddenRoots, "snapshot root");
  const first = await scanWorkspace({
    sourceRoot: canonicalSnapshot,
    limits,
    requireSealed: true,
    rejectCredentialEntries: true,
    approvedTestFixtures,
  });
  if (
    first.manifest_sha256 !== manifest.manifest_sha256
    || JSON.stringify(first.entries) !== JSON.stringify(manifest.entries)
  ) {
    fail("sealed snapshot contents do not match its manifest");
  }

  let privateRoot;
  try {
    privateRoot = await createPrivateRoot(
      `app-test-ctrl-crashfix-${role}-`,
      forbiddenRoots,
      canonicalSnapshot,
    );
    const workspaceDir = path.join(privateRoot, CLONE_DIR);
    const second = await scanWorkspace({
      sourceRoot: canonicalSnapshot,
      destinationRoot: workspaceDir,
      limits,
      destinationMutable: true,
      requireSealed: true,
      rejectCredentialEntries: true,
      approvedTestFixtures,
    });
    assertSameScan(first, second);
    if (JSON.stringify(second.entries) !== JSON.stringify(manifest.entries)) {
      fail("sealed snapshot changed before cloning completed");
    }
    const copiedFirst = await scanWorkspace({
      sourceRoot: workspaceDir,
      limits,
      rejectCredentialEntries: true,
      requireMutableApprovedFixturePermissions: true,
      approvedTestFixtures,
    });
    await lifecycle?.betweenWorkspaceVerificationPasses?.(workspaceDir);
    const copiedSecond = await scanWorkspace({
      sourceRoot: workspaceDir,
      limits,
      rejectCredentialEntries: true,
      requireMutableApprovedFixturePermissions: true,
      approvedTestFixtures,
    });
    assertSameScan(copiedFirst, copiedSecond);
    if (
      copiedSecond.manifest_sha256 !== manifest.manifest_sha256
      || copiedSecond.files !== manifest.files
      || copiedSecond.directories !== manifest.directories
      || copiedSecond.bytes !== manifest.bytes
      || JSON.stringify(copiedSecond.entries) !== JSON.stringify(manifest.entries)
    ) {
      fail("clone copy does not match its trusted source manifest");
    }
    const cloneOwner = {
      schema_version: WORKSPACE_CLONE_OWNER_SCHEMA,
      role,
      source_ref_sha256: owner.source_ref_sha256,
      manifest_sha256: owner.manifest_sha256,
      source_snapshot_sha256: owner.source_snapshot_sha256,
      exclusion_policy_sha256: owner.exclusion_policy_sha256,
      dynamic_exclusions_sha256: owner.dynamic_exclusions_sha256,
      approved_test_fixtures_sha256: owner.approved_test_fixtures_sha256,
      approved_test_fixture_count: owner.approved_test_fixture_count,
      approved_test_fixture_context: owner.approved_test_fixture_context,
    };
    await writeMetadata(privateRoot, cloneOwner, manifest, limits.maxManifestBytes);
    return {
      schema_version: WORKSPACE_CLONE_SCHEMA,
      role,
      workspace_dir: workspaceDir,
      workspace_root: privateRoot,
      source_ref_sha256: owner.source_ref_sha256,
      manifest_sha256: owner.manifest_sha256,
      source_snapshot_sha256: owner.source_snapshot_sha256,
      exclusion_policy_sha256: owner.exclusion_policy_sha256,
      dynamic_exclusions_sha256: owner.dynamic_exclusions_sha256,
      approved_test_fixtures_sha256: owner.approved_test_fixtures_sha256,
      approved_test_fixture_count: owner.approved_test_fixture_count,
      approved_test_fixture_context: owner.approved_test_fixture_context,
      files: second.files,
      directories: second.directories,
      bytes: second.bytes,
      cleanup_requires_confirmation: true,
    };
  } catch (error) {
    await cleanupPrivateRoot(privateRoot);
    throw error;
  }
}

export const MAX_REPORTED_AUDIT_CHANGES = 200;

export async function verifyWorkspaceSource({
  workspace,
  snapshotRoot,
  expectedSourceRefSha256,
  expectedSourceSnapshotSha256,
  forbidRoot,
  forbidRoots,
  limits: limitOverrides,
} = {}) {
  if (typeof expectedSourceRefSha256 !== "string" || !SHA256_RE.test(expectedSourceRefSha256)) {
    fail("--expected-source-ref-sha256 must be the in-memory locked 64-character source reference hash");
  }
  if (typeof expectedSourceSnapshotSha256 !== "string" || !SHA256_RE.test(expectedSourceSnapshotSha256)) {
    fail("--expected-source-sha256 must be the in-memory locked 64-character content-addressed source hash");
  }
  const limits = normalizeLimits(limitOverrides);
  const canonicalWorkspace = await canonicalOwnedDirectory(workspace, "--workspace");
  const trustedRoot = await canonicalOwnedDirectory(snapshotRoot, "--snapshot-root");
  if (Number((await lstat(trustedRoot, { bigint: true })).mode & 0o777n) !== 0o700) {
    fail("sealed snapshot private root permissions changed");
  }
  assertDisjointRoots(trustedRoot, [canonicalWorkspace], "trusted snapshot root");
  const trustedSnapshot = await canonicalOwnedDirectory(
    path.join(trustedRoot, SNAPSHOT_DIR),
    "sealed snapshot",
    { sealed: true },
  );
  if (path.dirname(trustedSnapshot) !== trustedRoot) fail("sealed snapshot escaped its trusted private root");
  const trustedOwner = await readBoundedJson(
    path.join(trustedRoot, OWNER_FILE),
    64 * 1024,
    "snapshot owner",
  );
  const trustedManifest = await readBoundedJson(
    path.join(trustedRoot, MANIFEST_FILE),
    limits.maxManifestBytes,
    "snapshot manifest",
  );
  validateStoredManifest(trustedOwner, trustedManifest, limits);
  const approvedTestFixtures = approvedTestFixturePolicy(
    trustedManifest.approved_test_fixtures,
  );
  if (
    trustedOwner.source_ref_sha256 !== expectedSourceRefSha256
    || trustedOwner.source_snapshot_sha256 !== expectedSourceSnapshotSha256
  ) {
    fail("trusted snapshot does not match the in-memory locked source identity");
  }
  const trustedFirst = await scanWorkspace({
    sourceRoot: trustedSnapshot,
    limits,
    requireSealed: true,
    rejectCredentialEntries: true,
    approvedTestFixtures,
  });
  const trustedSecond = await scanWorkspace({
    sourceRoot: trustedSnapshot,
    limits,
    requireSealed: true,
    rejectCredentialEntries: true,
    approvedTestFixtures,
  });
  assertSameScan(trustedFirst, trustedSecond);
  if (
    trustedSecond.manifest_sha256 !== trustedManifest.manifest_sha256
    || JSON.stringify(trustedSecond.entries) !== JSON.stringify(trustedManifest.entries)
  ) {
    fail("trusted sealed snapshot contents do not match its manifest");
  }
  const forbiddenRoots = await canonicalForbidRoots(forbidRoot, forbidRoots);
  if (forbiddenRoots.length < 1) {
    fail("source verification requires the original report/viewer forbidden root set");
  }
  const dynamicExclusions = dynamicExclusionsForWorkspace(canonicalWorkspace, forbiddenRoots);
  const currentSourceRef = sourceReference(canonicalWorkspace);
  if (currentSourceRef !== expectedSourceRefSha256) {
    fail("workspace does not match the in-memory locked source reference");
  }
  const first = await scanWorkspace({
    sourceRoot: canonicalWorkspace,
    limits,
    excludedAbsoluteRoots: dynamicExclusions.excludedAbsoluteRoots,
    approvedTestFixtures,
  });
  const second = await scanWorkspace({
    sourceRoot: canonicalWorkspace,
    limits,
    excludedAbsoluteRoots: dynamicExclusions.excludedAbsoluteRoots,
    approvedTestFixtures,
  });
  assertSameScan(first, second);
  if (JSON.stringify(first.entries) !== JSON.stringify(second.entries)) {
    fail("workspace entries changed between source verification passes");
  }
  const currentSourceSnapshot = sourceSnapshotIdentity(
    second.manifest_sha256,
    dynamicExclusions.dynamic_exclusions_sha256,
    approvedTestFixtures.approved_test_fixtures_sha256,
    approvedTestFixtures.approved_test_fixture_count,
    approvedTestFixtures.approved_test_fixture_context,
  );
  if (currentSourceSnapshot !== expectedSourceSnapshotSha256) {
    fail("workspace included-source manifest changed from the in-memory locked snapshot");
  }
  return {
    schema_version: WORKSPACE_SOURCE_VERIFICATION_SCHEMA,
    unchanged: true,
    source_ref_sha256: currentSourceRef,
    source_snapshot_sha256: currentSourceSnapshot,
    manifest_sha256: second.manifest_sha256,
    exclusion_policy_sha256: EXCLUSION_POLICY_SHA256,
    dynamic_exclusions_sha256: dynamicExclusions.dynamic_exclusions_sha256,
    approved_test_fixtures_sha256: approvedTestFixtures.approved_test_fixtures_sha256,
    approved_test_fixture_count: approvedTestFixtures.approved_test_fixture_count,
    approved_test_fixture_context: approvedTestFixtures.approved_test_fixture_context,
    files: second.files,
    directories: second.directories,
    bytes: second.bytes,
  };
}

function entryIdentity(entry) {
  if (entry === undefined) return "-";
  if (entry.type === "directory") return `directory\0${entry.mode}`;
  return `file\0${entry.mode}\0${entry.size}\0${entry.sha256}`;
}

function publicChangeSide(entry) {
  if (entry === undefined) return undefined;
  if (entry.type === "directory") return { type: "directory", mode: entry.mode };
  return { type: "file", mode: entry.mode, size: entry.size };
}

function computeCanonicalDiff(baseEntries, currentEntries) {
  const base = new Map(baseEntries.map((entry) => [entry.path, entry]));
  const current = new Map(currentEntries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...base.keys(), ...current.keys()])]
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const changes = [];
  const stat = {
    paths: 0,
    added_files: 0,
    modified_files: 0,
    deleted_files: 0,
    mode_changed_files: 0,
    type_changed_paths: 0,
    added_directories: 0,
    deleted_directories: 0,
    changed_bytes_before: 0,
    changed_bytes_after: 0,
  };
  const digest = createHash("sha256").update("crashfix-workspace-canonical-diff/v1\0");
  for (const relativePath of paths) {
    const before = base.get(relativePath);
    const after = current.get(relativePath);
    if (entryIdentity(before) === entryIdentity(after)) continue;
    let change;
    if (before === undefined) {
      change = "added";
      if (after.type === "file") stat.added_files += 1;
      else stat.added_directories += 1;
    } else if (after === undefined) {
      change = "deleted";
      if (before.type === "file") stat.deleted_files += 1;
      else stat.deleted_directories += 1;
    } else if (before.type !== after.type) {
      change = "type_changed";
      stat.type_changed_paths += 1;
    } else if (before.type === "file") {
      const contentChanged = before.sha256 !== after.sha256 || before.size !== after.size;
      const modeChanged = before.mode !== after.mode;
      change = contentChanged ? "modified" : "mode_changed";
      if (contentChanged) stat.modified_files += 1;
      if (modeChanged) stat.mode_changed_files += 1;
    } else {
      // Directory entries have a normalized mode and no content identity, so
      // equal-type directory changes cannot reach this branch.
      fail("workspace diff encountered an inconsistent directory identity");
    }
    stat.paths += 1;
    if (before?.type === "file") stat.changed_bytes_before += before.size;
    if (after?.type === "file") stat.changed_bytes_after += after.size;
    digest.update(change).update("\0");
    digest.update(relativePath).update("\0");
    digest.update(entryIdentity(before)).update("\0");
    digest.update(entryIdentity(after)).update("\0");
    changes.push({
      path: relativePath,
      change,
      ...(publicChangeSide(before) === undefined ? {} : { before: publicChangeSide(before) }),
      ...(publicChangeSide(after) === undefined ? {} : { after: publicChangeSide(after) }),
    });
  }
  return {
    canonical_diff_sha256: digest.digest("hex"),
    change_stat: stat,
    changes: changes.slice(0, MAX_REPORTED_AUDIT_CHANGES),
    truncated: changes.length > MAX_REPORTED_AUDIT_CHANGES,
  };
}

function assertApprovedTestFixturesUnchanged(baseEntries, currentEntries, approvedTestFixtures) {
  const base = new Map(baseEntries.map((entry) => [entry.path, entry]));
  const current = new Map(currentEntries.map((entry) => [entry.path, entry]));
  for (const fixture of approvedTestFixtures.entries) {
    const before = base.get(fixture.relative_path);
    const after = current.get(fixture.relative_path);
    if (
      before?.type !== "file"
      || after?.type !== "file"
      || before.mode !== "100644"
      || entryIdentity(before) !== entryIdentity(after)
      || before.sha256 !== fixture.sha256
    ) {
      fail("approved test fixture identity changed in the candidate workspace");
    }
  }
}

export async function auditSnapshotWorkspace({
  workspaceRoot,
  snapshotRoot,
  expectedSourceSnapshotSha256,
  role,
  limits: limitOverrides,
} = {}) {
  if (role !== "baseline" && role !== "candidate") fail("--role must be baseline or candidate");
  if (typeof expectedSourceSnapshotSha256 !== "string" || !SHA256_RE.test(expectedSourceSnapshotSha256)) {
    fail("--expected-source-sha256 must be the in-memory locked 64-character content-addressed source hash");
  }
  const limits = normalizeLimits(limitOverrides);

  const trustedRoot = await canonicalOwnedDirectory(snapshotRoot, "--snapshot-root");
  if (Number((await lstat(trustedRoot, { bigint: true })).mode & 0o777n) !== 0o700) {
    fail("sealed snapshot private root permissions changed");
  }
  const trustedSnapshot = await canonicalOwnedDirectory(
    path.join(trustedRoot, SNAPSHOT_DIR),
    "sealed snapshot",
    { sealed: true },
  );
  if (path.dirname(trustedSnapshot) !== trustedRoot) fail("sealed snapshot escaped its trusted private root");
  const trustedOwner = await readBoundedJson(path.join(trustedRoot, OWNER_FILE), 64 * 1024, "snapshot owner");
  const trustedManifest = await readBoundedJson(
    path.join(trustedRoot, MANIFEST_FILE),
    limits.maxManifestBytes,
    "trusted snapshot manifest",
  );
  validateStoredManifest(trustedOwner, trustedManifest, limits);
  const approvedTestFixtures = approvedTestFixturePolicy(
    trustedManifest.approved_test_fixtures,
  );
  if (trustedOwner.source_snapshot_sha256 !== expectedSourceSnapshotSha256) {
    fail("trusted snapshot does not match the in-memory locked source hash");
  }
  const trustedFirst = await scanWorkspace({
    sourceRoot: trustedSnapshot,
    limits,
    requireSealed: true,
    rejectCredentialEntries: true,
    approvedTestFixtures,
  });
  const trustedSecond = await scanWorkspace({
    sourceRoot: trustedSnapshot,
    limits,
    requireSealed: true,
    rejectCredentialEntries: true,
    approvedTestFixtures,
  });
  assertSameScan(trustedFirst, trustedSecond);
  if (
    trustedSecond.manifest_sha256 !== trustedManifest.manifest_sha256
    || JSON.stringify(trustedSecond.entries) !== JSON.stringify(trustedManifest.entries)
  ) {
    fail("trusted sealed snapshot contents do not match its manifest");
  }

  const privateRoot = await canonicalOwnedDirectory(workspaceRoot, "--workspace-root");
  assertDisjointRoots(privateRoot, [trustedRoot], "clone workspace root");
  const privateRootStat = await lstat(privateRoot, { bigint: true });
  if (Number(privateRootStat.mode & 0o777n) !== 0o700) fail("clone private root permissions changed");
  const workspaceDir = await canonicalOwnedDirectory(
    path.join(privateRoot, CLONE_DIR),
    "clone workspace",
  );
  if (path.dirname(workspaceDir) !== privateRoot) fail("clone workspace escaped its bound private root");
  if (Number((await lstat(workspaceDir, { bigint: true })).mode & 0o777n) !== 0o700) {
    fail("clone workspace root permissions changed");
  }
  const owner = await readBoundedJson(path.join(privateRoot, OWNER_FILE), 64 * 1024, "clone owner");
  const manifest = await readBoundedJson(
    path.join(privateRoot, MANIFEST_FILE),
    limits.maxManifestBytes,
    "base snapshot manifest",
  );
  validateManifestDocument(manifest, limits);
  assertOwnerBinding(owner, manifest, role);
  if (
    owner.source_ref_sha256 !== trustedOwner.source_ref_sha256
    || owner.manifest_sha256 !== trustedOwner.manifest_sha256
    || owner.source_snapshot_sha256 !== trustedOwner.source_snapshot_sha256
    || owner.exclusion_policy_sha256 !== trustedOwner.exclusion_policy_sha256
    || owner.dynamic_exclusions_sha256 !== trustedOwner.dynamic_exclusions_sha256
    || owner.approved_test_fixtures_sha256 !== trustedOwner.approved_test_fixtures_sha256
    || owner.approved_test_fixture_count !== trustedOwner.approved_test_fixture_count
    || JSON.stringify(owner.approved_test_fixture_context) !== JSON.stringify(trustedOwner.approved_test_fixture_context)
    || JSON.stringify(manifest.entries) !== JSON.stringify(trustedManifest.entries)
    || JSON.stringify(manifest.approved_test_fixtures) !== JSON.stringify(trustedManifest.approved_test_fixtures)
  ) {
    fail("clone provenance does not match the trusted sealed snapshot");
  }

  const first = await scanWorkspace({
    sourceRoot: workspaceDir,
    limits,
    rejectCredentialEntries: true,
    requireMutableApprovedFixturePermissions: true,
    approvedTestFixtures,
  });
  const second = await scanWorkspace({
    sourceRoot: workspaceDir,
    limits,
    rejectCredentialEntries: true,
    requireMutableApprovedFixturePermissions: true,
    approvedTestFixtures,
  });
  assertSameScan(first, second);
  if (JSON.stringify(first.entries) !== JSON.stringify(second.entries)) {
    fail("clone workspace entries changed between audit passes");
  }
  const diff = computeCanonicalDiff(trustedManifest.entries, second.entries);
  assertApprovedTestFixturesUnchanged(
    trustedManifest.entries,
    second.entries,
    approvedTestFixtures,
  );
  if (role === "baseline" && diff.change_stat.paths !== 0) {
    fail("baseline included-source manifest drifted from its sealed source");
  }
  return {
    schema_version: WORKSPACE_AUDIT_SCHEMA,
    role,
    source_ref_sha256: trustedOwner.source_ref_sha256,
    source_snapshot_sha256: trustedOwner.source_snapshot_sha256,
    base_manifest_sha256: trustedOwner.manifest_sha256,
    current_manifest_sha256: second.manifest_sha256,
    ...(role === "candidate" ? { candidate_manifest_sha256: second.manifest_sha256 } : {}),
    exclusion_policy_sha256: trustedOwner.exclusion_policy_sha256,
    dynamic_exclusions_sha256: trustedOwner.dynamic_exclusions_sha256,
    approved_test_fixtures_sha256: trustedOwner.approved_test_fixtures_sha256,
    approved_test_fixture_count: trustedOwner.approved_test_fixture_count,
    approved_test_fixture_context: trustedOwner.approved_test_fixture_context,
    canonical_diff_sha256: diff.canonical_diff_sha256,
    clean: diff.change_stat.paths === 0,
    files: second.files,
    directories: second.directories,
    bytes: second.bytes,
    change_stat: diff.change_stat,
    changes: diff.changes,
    truncated: diff.truncated,
  };
}

function destinationReference(canonicalDestination) {
  return createHash("sha256")
    .update("crashfix-candidate-export-destination/v1\0")
    .update(canonicalDestination)
    .digest("hex");
}

function pinExportDirectory(statValue) {
  return {
    dev: statValue.dev,
    ino: statValue.ino,
    uid: statValue.uid,
  };
}

function assertPinnedExportDirectory(statValue, pinned) {
  if (
    !statValue.isDirectory()
    || statValue.dev !== pinned.dev
    || statValue.ino !== pinned.ino
    || statValue.uid !== pinned.uid
    || statValue.uid !== currentUid()
    || statValue.nlink < 1n
  ) {
    fail("candidate export cleanup identity is no longer trustworthy");
  }
}

async function unlockExportTreeStrict(root) {
  const rootStat = await lstat(root, { bigint: true });
  if (rootStat.isSymbolicLink()) return;
  if (rootStat.isDirectory()) {
    assertOwned(rootStat, "candidate export cleanup entry");
    await chmod(root, 0o700);
    const names = await readdir(root);
    for (const name of names) await unlockExportTreeStrict(path.join(root, name));
  } else {
    assertOwned(rootStat, "candidate export cleanup entry");
    await chmod(root, 0o600);
  }
}

async function cleanupPinnedExportDestination(destination, pinned) {
  let current;
  try {
    current = await lstat(destination, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail("candidate export cleanup state could not be inspected");
  }
  assertPinnedExportDirectory(current, pinned);
  const handle = await open(destination, directoryFlags());
  try {
    const opened = await handle.stat({ bigint: true });
    assertPinnedExportDirectory(opened, pinned);
    assertSameIdentity(current, opened, "candidate export cleanup directory");
    await unlockExportTreeStrict(destination);
    const beforeRemovePath = await lstat(destination, { bigint: true });
    const beforeRemoveHandle = await handle.stat({ bigint: true });
    assertPinnedExportDirectory(beforeRemovePath, pinned);
    assertPinnedExportDirectory(beforeRemoveHandle, pinned);
    assertSameIdentity(beforeRemovePath, beforeRemoveHandle, "candidate export cleanup directory");
    await rm(destination, { recursive: true, force: false, maxRetries: 0 });
  } finally {
    await handle.close().catch(() => undefined);
  }
  try {
    await lstat(destination, { bigint: true });
    fail("candidate export cleanup did not remove its destination");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function verifyPinnedExportDirectory(directory, pinned) {
  const pathStat = await lstat(directory, { bigint: true });
  assertPinnedExportDirectory(pathStat, pinned);
  if (Number(pathStat.mode & 0o777n) !== 0o700) {
    fail("published candidate export directory permissions changed");
  }
  const handle = await open(directory, directoryFlags());
  try {
    const opened = await handle.stat({ bigint: true });
    assertPinnedExportDirectory(opened, pinned);
    assertSameIdentity(pathStat, opened, "published candidate export directory");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function resolveNewPrivateDestination(destination) {
  validateAbsolutePath(destination, "--destination");
  const normalized = path.normalize(destination);
  const basename = path.basename(normalized);
  validatePathSegment(basename);
  const parentPath = path.dirname(normalized);
  let parentBefore;
  let canonicalParent;
  try {
    parentBefore = await lstat(parentPath, { bigint: true });
    if (!parentBefore.isDirectory() && !parentBefore.isSymbolicLink()) {
      fail("candidate export destination parent must resolve to a real directory");
    }
    canonicalParent = await realpath(parentPath);
    const canonicalParentAgain = await realpath(parentPath);
    const parentPathAfter = await lstat(parentPath, { bigint: true });
    const canonicalStat = await lstat(canonicalParent, { bigint: true });
    assertSameIdentity(parentBefore, parentPathAfter, "candidate export destination parent");
    if (canonicalParentAgain !== canonicalParent || !canonicalStat.isDirectory()) {
      fail("candidate export destination parent changed during validation");
    }
    assertOwned(canonicalStat, "candidate export destination parent");
    if ((canonicalStat.mode & 0o022n) !== 0n) {
      fail("candidate export destination parent must not be group/other writable");
    }
    parentBefore = canonicalStat;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("candidate export")) throw error;
    fail("candidate export destination parent could not be validated");
  }
  const canonicalDestination = path.join(canonicalParent, basename);
  try {
    await lstat(canonicalDestination, { bigint: true });
    fail("candidate export destination must not already exist");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (error instanceof Error && error.message.includes("must not already exist")) throw error;
      fail("candidate export destination availability could not be validated");
    }
  }
  return {
    canonicalDestination,
    canonicalParent,
    parentPin: pinExportDirectory(parentBefore),
  };
}

async function assertDestinationAbsent(destination) {
  try {
    await lstat(destination, { bigint: true });
    fail("candidate export destination must remain absent until atomic publication");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (error instanceof Error && error.message.includes("must remain absent")) throw error;
      fail("candidate export destination absence could not be revalidated");
    }
  }
}

async function verifyPinnedParent(parentPath, parentHandle, parentPin) {
  const pathStat = await lstat(parentPath, { bigint: true });
  const handleStat = await parentHandle.stat({ bigint: true });
  assertPinnedExportDirectory(pathStat, parentPin);
  assertPinnedExportDirectory(handleStat, parentPin);
  assertSameIdentity(pathStat, handleStat, "candidate export destination parent");
  if ((pathStat.mode & 0o022n) !== 0n) {
    fail("candidate export destination parent permissions became unsafe");
  }
}

async function verifyPinnedOwnedDirectory(directoryPath, handle, pin, label) {
  const pathStat = await lstat(directoryPath, { bigint: true });
  const handleStat = await handle.stat({ bigint: true });
  assertPinnedExportDirectory(pathStat, pin);
  assertPinnedExportDirectory(handleStat, pin);
  assertSameIdentity(pathStat, handleStat, label);
  if ((pathStat.mode & 0o022n) !== 0n) {
    fail(`${label} permissions became unsafe`);
  }
}

export async function exportCandidateWorkspace({
  workspaceRoot,
  snapshotRoot,
  originalWorkspace,
  expectedSourceSnapshotSha256,
  expectedCandidateManifestSha256,
  expectedCanonicalDiffSha256,
  destination,
  forbidRoot,
  forbidRoots,
  limits: limitOverrides,
} = {}, lifecycle = undefined) {
  validateLifecycle(
    lifecycle,
    ["afterDestinationCreated", "afterFinalVerification"],
    "candidate export",
  );
  for (const [option, value] of [
    ["--expected-source-sha256", expectedSourceSnapshotSha256],
    ["--expected-candidate-manifest-sha256", expectedCandidateManifestSha256],
    ["--expected-canonical-diff-sha256", expectedCanonicalDiffSha256],
  ]) {
    if (typeof value !== "string" || !SHA256_RE.test(value)) {
      fail(`${option} must be a 64-character lowercase SHA-256 hash`);
    }
  }
  const limits = normalizeLimits(limitOverrides);
  let canonicalOriginalWorkspace;
  let originalWorkspacePin;
  try {
    canonicalOriginalWorkspace = await canonicalOwnedDirectory(
      originalWorkspace,
      "--original-workspace",
    );
    originalWorkspacePin = pinExportDirectory(
      await lstat(canonicalOriginalWorkspace, { bigint: true }),
    );
  } catch {
    fail("candidate export original workspace could not be validated");
  }
  const originalSourceRef = sourceReference(canonicalOriginalWorkspace);
  let forbiddenRoots;
  try {
    forbiddenRoots = await canonicalForbidRoots(forbidRoot, forbidRoots);
  } catch {
    fail("candidate export forbidden roots could not be validated");
  }
  if (forbiddenRoots.length < 2) {
    fail("candidate export requires separate original-project and report/viewer forbidden roots");
  }
  let audit;
  try {
    audit = await auditSnapshotWorkspace({
      workspaceRoot,
      snapshotRoot,
      expectedSourceSnapshotSha256,
      role: "candidate",
      limits,
    });
  } catch (error) {
    if (error instanceof WorkspaceCredentialError) throw error;
    fail("candidate export audit failed closed");
  }
  if (audit.source_ref_sha256 !== originalSourceRef) {
    fail("candidate export original workspace does not match the trusted snapshot source reference");
  }
  if (audit.truncated) fail("candidate export refuses a truncated change audit");
  if (audit.candidate_manifest_sha256 !== expectedCandidateManifestSha256) {
    fail("candidate export manifest hash does not match the approved audit");
  }
  if (audit.canonical_diff_sha256 !== expectedCanonicalDiffSha256) {
    fail("candidate export canonical diff hash does not match the approved audit");
  }

  let canonicalWorkspaceRoot;
  let canonicalSnapshotRoot;
  let canonicalDestination;
  let canonicalParent;
  let parentPin;
  let approvedTestFixtures;
  try {
    canonicalWorkspaceRoot = await canonicalOwnedDirectory(workspaceRoot, "candidate workspace root");
    canonicalSnapshotRoot = await canonicalOwnedDirectory(snapshotRoot, "trusted snapshot root");
    const trustedOwner = await readBoundedJson(
      path.join(canonicalSnapshotRoot, OWNER_FILE),
      64 * 1024,
      "snapshot owner",
    );
    const trustedManifest = await readBoundedJson(
      path.join(canonicalSnapshotRoot, MANIFEST_FILE),
      limits.maxManifestBytes,
      "snapshot manifest",
    );
    validateStoredManifest(trustedOwner, trustedManifest, limits);
    if (
      trustedOwner.source_snapshot_sha256 !== expectedSourceSnapshotSha256
      || trustedOwner.approved_test_fixtures_sha256 !== audit.approved_test_fixtures_sha256
      || trustedOwner.approved_test_fixture_count !== audit.approved_test_fixture_count
      || JSON.stringify(trustedOwner.approved_test_fixture_context) !== JSON.stringify(audit.approved_test_fixture_context)
    ) {
      fail("candidate export trusted snapshot approval identity drifted");
    }
    approvedTestFixtures = approvedTestFixturePolicy(
      trustedManifest.approved_test_fixtures,
    );
    ({ canonicalDestination, canonicalParent, parentPin } = await resolveNewPrivateDestination(destination));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("candidate export")) throw error;
    fail("candidate export path validation failed closed");
  }
  assertDisjointRoots(
    canonicalWorkspaceRoot,
    [canonicalOriginalWorkspace, ...forbiddenRoots],
    "candidate workspace root",
  );
  assertDisjointRoots(
    canonicalSnapshotRoot,
    [canonicalOriginalWorkspace, ...forbiddenRoots],
    "trusted snapshot root",
  );
  assertDisjointRoots(
    canonicalDestination,
    [
      canonicalOriginalWorkspace,
      canonicalWorkspaceRoot,
      canonicalSnapshotRoot,
      ...forbiddenRoots,
    ],
    "candidate export destination",
  );

  const candidateWorkspace = path.join(canonicalWorkspaceRoot, CLONE_DIR);
  let originalWorkspaceHandle;
  let parentHandle;
  let stagingPath;
  let published = false;
  let exportPin;
  try {
    originalWorkspaceHandle = await open(canonicalOriginalWorkspace, directoryFlags());
    parentHandle = await open(canonicalParent, directoryFlags());
    await verifyPinnedOwnedDirectory(
      canonicalOriginalWorkspace,
      originalWorkspaceHandle,
      originalWorkspacePin,
      "candidate export original workspace",
    );
    await verifyPinnedParent(canonicalParent, parentHandle, parentPin);
    await assertDestinationAbsent(canonicalDestination);
    stagingPath = await mkdtemp(path.join(canonicalParent, ".crashfix-export-stage-"));
    await chmod(stagingPath, 0o700);
    const stagingStat = await lstat(stagingPath, { bigint: true });
    assertRealDirectory(stagingStat, "candidate export staging directory");
    if (Number(stagingStat.mode & 0o777n) !== 0o700) fail("candidate export staging directory is not private");
    exportPin = pinExportDirectory(stagingStat);

    const preCopy = await scanWorkspace({
      sourceRoot: candidateWorkspace,
      limits,
      rejectCredentialEntries: true,
      approvedTestFixtures,
    });
    const copied = await scanWorkspace({
      sourceRoot: candidateWorkspace,
      destinationRoot: stagingPath,
      limits,
      destinationMutable: true,
      destinationRootPrecreated: true,
      rejectCredentialEntries: true,
      approvedTestFixtures,
    });
    assertSameScan(preCopy, copied);
    if (
      copied.manifest_sha256 !== expectedCandidateManifestSha256
      || JSON.stringify(preCopy.entries) !== JSON.stringify(copied.entries)
    ) {
      fail("candidate changed while its approved source was being exported");
    }
    const exportedFirst = await scanWorkspace({
      sourceRoot: stagingPath,
      limits,
      rejectCredentialEntries: true,
      requireMutableApprovedFixturePermissions: true,
      approvedTestFixtures,
    });
    const exportedSecond = await scanWorkspace({
      sourceRoot: stagingPath,
      limits,
      rejectCredentialEntries: true,
      requireMutableApprovedFixturePermissions: true,
      approvedTestFixtures,
    });
    assertSameScan(exportedFirst, exportedSecond);
    if (
      exportedSecond.manifest_sha256 !== expectedCandidateManifestSha256
      || JSON.stringify(exportedSecond.entries) !== JSON.stringify(copied.entries)
    ) {
      fail("exported candidate does not match its approved included-source manifest");
    }
    await verifyPinnedExportDirectory(stagingPath, exportPin);
    await verifyPinnedOwnedDirectory(
      canonicalOriginalWorkspace,
      originalWorkspaceHandle,
      originalWorkspacePin,
      "candidate export original workspace",
    );
    await verifyPinnedParent(canonicalParent, parentHandle, parentPin);
    await assertDestinationAbsent(canonicalDestination);
    try {
      await rename(stagingPath, canonicalDestination);
    } catch {
      fail("candidate export could not be atomically published without overwrite");
    }
    published = true;
    stagingPath = undefined;
    await verifyPinnedOwnedDirectory(
      canonicalOriginalWorkspace,
      originalWorkspaceHandle,
      originalWorkspacePin,
      "candidate export original workspace",
    );
    await verifyPinnedParent(canonicalParent, parentHandle, parentPin);
    await verifyPinnedExportDirectory(canonicalDestination, exportPin);
    await lifecycle?.afterDestinationCreated?.();
    await verifyPinnedParent(canonicalParent, parentHandle, parentPin);
    await verifyPinnedOwnedDirectory(
      canonicalOriginalWorkspace,
      originalWorkspaceHandle,
      originalWorkspacePin,
      "candidate export original workspace",
    );
    await verifyPinnedExportDirectory(canonicalDestination, exportPin);
    const publishedFirst = await scanWorkspace({
      sourceRoot: canonicalDestination,
      limits,
      rejectCredentialEntries: true,
      requireMutableApprovedFixturePermissions: true,
      approvedTestFixtures,
    });
    const publishedSecond = await scanWorkspace({
      sourceRoot: canonicalDestination,
      limits,
      rejectCredentialEntries: true,
      requireMutableApprovedFixturePermissions: true,
      approvedTestFixtures,
    });
    assertSameScan(publishedFirst, publishedSecond);
    if (
      publishedSecond.manifest_sha256 !== expectedCandidateManifestSha256
      || JSON.stringify(publishedSecond.entries) !== JSON.stringify(copied.entries)
    ) {
      fail("published candidate changed before export completion");
    }
    await verifyPinnedParent(canonicalParent, parentHandle, parentPin);
    await verifyPinnedExportDirectory(canonicalDestination, exportPin);
    if (lifecycle?.afterFinalVerification !== undefined) {
      await lifecycle.afterFinalVerification();
      fail("candidate export lifecycle injected a post-verification failure");
    }
    return {
      schema_version: CANDIDATE_EXPORT_SCHEMA,
      destination_ref_sha256: destinationReference(canonicalDestination),
      source_snapshot_sha256: expectedSourceSnapshotSha256,
      candidate_manifest_sha256: expectedCandidateManifestSha256,
      canonical_diff_sha256: expectedCanonicalDiffSha256,
      exclusion_policy_sha256: EXCLUSION_POLICY_SHA256,
      dynamic_exclusions_sha256: audit.dynamic_exclusions_sha256,
      approved_test_fixtures_sha256: audit.approved_test_fixtures_sha256,
      approved_test_fixture_count: audit.approved_test_fixture_count,
      approved_test_fixture_context: audit.approved_test_fixture_context,
      files: publishedSecond.files,
      directories: publishedSecond.directories,
      bytes: publishedSecond.bytes,
      truncated: false,
      cleanup_requires_confirmation: true,
    };
  } catch (error) {
    if (published) {
      fail("candidate export failed after publication; destination was retained and cleanup is unconfirmed");
    }
    if (stagingPath !== undefined && exportPin === undefined) {
      fail("candidate export failed and staging cleanup identity was never established");
    }
    if (stagingPath !== undefined) {
      try {
        await cleanupPinnedExportDestination(stagingPath, exportPin);
      } catch {
        fail("candidate export failed and private staging cleanup could not be confirmed");
      }
    }
    if (error instanceof WorkspaceCredentialError) throw error;
    fail("candidate export failed closed before publication and removed its private staging directory");
  } finally {
    await originalWorkspaceHandle?.close().catch(() => undefined);
    await parentHandle?.close().catch(() => undefined);
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (
    command !== "probe-test-fixture"
    && command !== "create"
    && command !== "clone"
    && command !== "audit"
    && command !== "verify-source"
    && command !== "export-candidate"
  ) {
    fail("first argument must be probe-test-fixture, create, clone, audit, verify-source, or export-candidate");
  }
  const allowed = command === "probe-test-fixture"
    ? new Set(["--workspace", "--relative-path"])
    : command === "create"
      ? new Set([
        "--workspace", "--forbid-root", "--execution-profile",
        "--project-classification", "--fixture-approval-confirmed",
        "--expected-source-ref-sha256", "--approved-test-fixture",
      ])
    : command === "clone"
      ? new Set([
        "--snapshot-root", "--role", "--expected-source-ref-sha256",
        "--expected-source-sha256", "--forbid-root",
      ])
      : command === "audit"
        ? new Set(["--workspace-root", "--snapshot-root", "--expected-source-sha256", "--role"])
        : command === "verify-source"
          ? new Set([
            "--workspace", "--snapshot-root", "--expected-source-ref-sha256", "--expected-source-sha256",
            "--forbid-root",
          ])
          : new Set([
            "--workspace-root", "--snapshot-root", "--original-workspace",
            "--expected-source-sha256",
            "--expected-candidate-manifest-sha256", "--expected-canonical-diff-sha256",
            "--destination", "--forbid-root",
          ]);
  const result = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (!allowed.has(name)) fail(`unsupported argument for ${command}: ${name}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${name} requires a value`);
    if (name === "--forbid-root") {
      result.forbidRoots ??= [];
      result.forbidRoots.push(value);
      index += 1;
      continue;
    }
    if (name === "--approved-test-fixture") {
      if (Buffer.byteLength(value, "utf8") > 8 * 1024) {
        fail("--approved-test-fixture exceeds its byte limit");
      }
      let entry;
      try {
        entry = JSON.parse(value);
      } catch {
        fail("--approved-test-fixture must be strict JSON");
      }
      assertExactKeys(entry, ["relative_path", "sha256"], "--approved-test-fixture");
      const canonicalEntryJson = JSON.stringify({
        relative_path: entry.relative_path,
        sha256: entry.sha256,
      });
      if (value !== canonicalEntryJson) {
        fail("--approved-test-fixture must be canonical JSON without duplicate keys or whitespace");
      }
      result.approvedTestFixtures ??= [];
      if (result.approvedTestFixtures.length >= MAX_APPROVED_TEST_FIXTURES) {
        fail("too many --approved-test-fixture values");
      }
      result.approvedTestFixtures.push(entry);
      index += 1;
      continue;
    }
    const key = name === "--snapshot-root"
      ? "snapshotRoot"
      : name === "--workspace-root"
        ? "workspaceRoot"
        : name === "--original-workspace"
          ? "originalWorkspace"
          : name === "--expected-source-sha256"
            ? "expectedSourceSnapshotSha256"
            : name === "--expected-source-ref-sha256"
              ? "expectedSourceRefSha256"
              : name === "--expected-candidate-manifest-sha256"
                ? "expectedCandidateManifestSha256"
                : name === "--expected-canonical-diff-sha256"
              ? "expectedCanonicalDiffSha256"
              : name === "--relative-path"
                ? "relativePath"
                : name === "--execution-profile"
                  ? "executionProfile"
                  : name === "--project-classification"
                    ? "projectClassification"
                    : name === "--fixture-approval-confirmed"
                      ? "fixtureApprovalConfirmed"
                : name.slice(2);
    if (result[key] !== undefined) fail(`${name} may only be provided once`);
    result[key] = value;
    index += 1;
  }
  if (command === "create") {
    const approvalValues = [
      result.executionProfile,
      result.projectClassification,
      result.fixtureApprovalConfirmed,
      result.expectedSourceRefSha256,
      result.approvedTestFixtures,
    ];
    const hasAnyApprovalValue = approvalValues.some((value) => value !== undefined);
    if (hasAnyApprovalValue) {
      if (
        result.executionProfile !== "local_trusted"
        || result.projectClassification !== "test"
        || result.fixtureApprovalConfirmed !== "true"
        || typeof result.expectedSourceRefSha256 !== "string"
        || !SHA256_RE.test(result.expectedSourceRefSha256)
        || !Array.isArray(result.approvedTestFixtures)
        || result.approvedTestFixtures.length < 1
      ) {
        fail("test fixture approval create arguments must be supplied as one exact local_trusted test confirmation group");
      }
      result.testFixtureApproval = {
        schema_version: TEST_FIXTURE_APPROVAL_SCHEMA,
        execution_profile: result.executionProfile,
        project_classification: result.projectClassification,
        user_confirmed: true,
        source_ref_sha256: result.expectedSourceRefSha256,
        entries: result.approvedTestFixtures,
      };
      delete result.executionProfile;
      delete result.projectClassification;
      delete result.fixtureApprovalConfirmed;
      delete result.expectedSourceRefSha256;
      delete result.approvedTestFixtures;
    }
  }
  return result;
}

async function main() {
  const { command, ...options } = parseArgs(process.argv.slice(2));
  const result = command === "probe-test-fixture"
    ? await probeTestFixture(options)
    : command === "create"
      ? await materializeWorkspaceSnapshot(options)
    : command === "clone"
      ? await cloneSnapshotWorkspace(options)
      : command === "audit"
        ? await auditSnapshotWorkspace(options)
        : command === "verify-source"
          ? await verifyWorkspaceSource(options)
          : await exportCandidateWorkspace(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function publicHelperDiagnostic() {
  return Object.freeze({
    schema_version: HELPER_DIAGNOSTIC_SCHEMA,
    error_code: HELPER_DIAGNOSTIC_ERROR_CODE,
  });
}

const isEntryPoint = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((error) => {
    if (error instanceof WorkspaceCredentialError) {
      process.stderr.write(`${JSON.stringify(error.diagnostic)}\n`);
    } else {
      process.stderr.write(`${JSON.stringify(publicHelperDiagnostic())}\n`);
    }
    process.exitCode = 1;
  });
}
