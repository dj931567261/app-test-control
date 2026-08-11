import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";

import { assertCanonicalAnalyzerIdentity } from "./analyzer-identity.js";
import {
  DEFAULT_REPORT_LANGUAGE,
  reportLanguageSchema,
  type ReportLanguage,
} from "./report-i18n.js";

export const MAX_SESSION_PATH_CHARS = 4_096;
export const MAX_SESSION_ID_CHARS = 512;
export const MAX_CRASH_SIGNATURE_CHARS = 4_096;
export const MAX_CRASH_KIND_CHARS = 128;
export const MAX_CRASH_STACK_BYTES = 4 * 1024 * 1024;
export const MAX_CRASH_LOG_BYTES = 64 * 1024 * 1024;
export const MAX_CRASHES_PER_SESSION = 1_000;
export const MAX_REPRO_PATH_ENTRIES = 10_000;
export const MAX_CRASH_SOURCE_BYTES = 16 * 1024;
export const MAX_CRASH_SOURCE_METRICS = 32;
export const MAX_SESSION_JSONL_BYTES = 16 * 1024 * 1024;
export const MAX_SESSION_META_BYTES = 1024 * 1024;
export const MAX_SESSION_NAME_CHARS = 256;
export const MAX_SESSION_LOCK_OWNER_BYTES = 4 * 1024;
export const MAX_STEPS_PER_SESSION = 10_000;
export const MAX_JSONL_PHYSICAL_LINES = 20_000;
export const SESSION_LOCK_TIMEOUT_MS = 10_000;

const SESSION_LOCK_RETRY_MS = 25;
const SESSION_LOCK_DIRNAME = ".session-write.lock";
const SESSION_LOCK_OWNER_FILENAME = "owner.json";

const MAX_SOURCE_ID_CHARS = 512;
const MAX_SOURCE_PROVIDER_CHARS = 64;
const MAX_SOURCE_METRIC_KEY_CHARS = 64;
const SOURCE_PROVIDER_RE = /^[a-z0-9][a-z0-9._-]*$/;
const SOURCE_METRIC_KEY_RE = /^[a-zA-Z][a-zA-Z0-9._-]*$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const ANALYZER_FINGERPRINT_RE = /^[a-f0-9]{12}$/;
const SESSION_ID_REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ARTIFACT_APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const ARTIFACT_BUILD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._+()-]{0,127}$/;
const FIREBASE_CRASHLYTICS_PROVIDER = "firebase-crashlytics";
const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export const CRASH_ACQUISITION_ROUTES = [
  "official_firebase_mcp",
  "cloud_logging_mcp",
] as const;
export const crashAcquisitionRouteSchema = z.enum(CRASH_ACQUISITION_ROUTES);
export const CRASH_SIGNATURE_VERSIONS = ["v1", "java-v2", "ios-v2"] as const;
export const crashSignatureVersionSchema = z.enum(CRASH_SIGNATURE_VERSIONS);
export const remoteSourceLockSchema = z
  .object({
    provider: z.literal(FIREBASE_CRASHLYTICS_PROVIDER),
    acquisition_route: crashAcquisitionRouteSchema,
  })
  .strict();

export type CrashAcquisitionRoute = z.infer<typeof crashAcquisitionRouteSchema>;
export type CrashSignatureVersion = z.infer<typeof crashSignatureVersionSchema>;
export type RemoteSourceLock = z.infer<typeof remoteSourceLockSchema>;

export const CRASHFIX_ANALYSIS_SCHEMA_VERSION = "crashfix-analysis/v1" as const;
export const CRASHFIX_ANALYSIS_CONFIDENCES = ["low", "medium", "high"] as const;
export const CRASHFIX_ANALYSIS_CATEGORIES = [
  "null_dereference",
  "bounds",
  "lifecycle",
  "concurrency",
  "resource",
  "configuration",
  "dependency",
  "other",
] as const;

const MAX_CRASHFIX_ANALYSIS_SUMMARY_CHARS = 2_048;
const MAX_CRASHFIX_ANALYSIS_LIMITATION_CHARS = 512;
const MAX_CRASHFIX_ANALYSIS_SYMBOL_CHARS = 512;
const MAX_CRASHFIX_ANALYSIS_SOURCE_PATH_CHARS = 1_024;
const MAX_CRASHFIX_ANALYSIS_LINE = 10_000_000;
const MAX_CRASHFIX_ANALYSIS_LOCATIONS = 3;
const MAX_CRASHFIX_ANALYSIS_LIMITATIONS = 5;

const CRASHFIX_ANALYSIS_SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".dart", ".h", ".hh", ".hpp",
  ".java", ".js", ".jsx", ".kt", ".kts", ".m", ".mm", ".swift",
  ".ts", ".tsx", ".vue", ".xml",
]);
const CRASHFIX_ANALYSIS_BLOCKED_PATH_PARTS = new Set([
  ".git", ".gradle", ".idea", ".worktrees", "build", "deriveddata",
  "dist", "node_modules", "out", "pods", "secrets", "target", "vendor",
]);
const CRASHFIX_ANALYSIS_CREDENTIAL_NAME_RE =
  /(?:^|[-_.])(?:auth(?:orized)?|cookie|credential|firebase-admin|keystore|password|private[-_.]?key|secret|service[-_.]?account|token)(?:[-_.]|$)/iu;
const CRASHFIX_ANALYSIS_FULL_SHA256_RE = /\b[a-f0-9]{64}\b/iu;
const CRASHFIX_ANALYSIS_URL_RE =
  /(?:\b(?:https?|ftp|file|mailto|data|javascript):|\bwww\.)/iu;
const CRASHFIX_ANALYSIS_POSIX_ABSOLUTE_PATH_RE =
  /(?:^|[\s("'=:])\/(?:[^\s<>"']+\/)*[^\s<>"']+/u;
const CRASHFIX_ANALYSIS_WINDOWS_ABSOLUTE_PATH_RE =
  /(?:\b[A-Za-z]:[\\/]|(?:^|[\s("'=:])\\\\[^\s<>"']+)/u;
const CRASHFIX_ANALYSIS_PRIVATE_KEY_RE =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/iu;
const CRASHFIX_ANALYSIS_CREDENTIAL_ASSIGNMENT_RE =
  /\b(?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|cookie|password|passwd|private[_-]?key|refresh[_-]?token|secret|token)\b\s*[:=]\s*["']?[A-Za-z0-9+/_~.-]{8,}/iu;
const CRASHFIX_ANALYSIS_BEARER_RE =
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/iu;
const CRASHFIX_ANALYSIS_KNOWN_TOKEN_RE =
  /\b(?:AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[0-9A-Za-z]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/u;
const CRASHFIX_ANALYSIS_EMAIL_RE =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const CRASHFIX_ANALYSIS_PHONE_RE =
  /(?:^|\D)(?:\+\d{1,3}[\s-]?)?(?:\d[\s-]?){10,15}(?:\D|$)/u;
const CRASHFIX_ANALYSIS_UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;
const CRASHFIX_ANALYSIS_APPLE_DEVICE_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{16}\b/iu;
const CRASHFIX_ANALYSIS_IPV4_RE =
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/u;
const CRASHFIX_ANALYSIS_MAC_RE =
  /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/iu;

function crashfixAnalysisSafeTextSchema(label: string, maxChars: number) {
  return z
    .string()
    .min(1)
    .max(maxChars)
    .superRefine((value, ctx) => {
      if (value !== value.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must not have surrounding whitespace`,
        });
      }
      if (value !== value.normalize("NFC")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must use NFC normalization`,
        });
      }
      if (/[\p{Cc}\p{Cf}]/u.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must not contain control characters`,
        });
      }
      if (CRASHFIX_ANALYSIS_URL_RE.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must not contain URLs`,
        });
      }
      if (
        CRASHFIX_ANALYSIS_POSIX_ABSOLUTE_PATH_RE.test(value)
        || CRASHFIX_ANALYSIS_WINDOWS_ABSOLUTE_PATH_RE.test(value)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must not contain absolute paths`,
        });
      }
      if (CRASHFIX_ANALYSIS_FULL_SHA256_RE.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must not contain full SHA-256 values`,
        });
      }
      if (
        CRASHFIX_ANALYSIS_PRIVATE_KEY_RE.test(value)
        || CRASHFIX_ANALYSIS_CREDENTIAL_ASSIGNMENT_RE.test(value)
        || CRASHFIX_ANALYSIS_BEARER_RE.test(value)
        || CRASHFIX_ANALYSIS_KNOWN_TOKEN_RE.test(value)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must not contain credential-like values`,
        });
      }
      if (
        CRASHFIX_ANALYSIS_EMAIL_RE.test(value)
        || CRASHFIX_ANALYSIS_PHONE_RE.test(value)
        || CRASHFIX_ANALYSIS_UUID_RE.test(value)
        || CRASHFIX_ANALYSIS_APPLE_DEVICE_RE.test(value)
        || CRASHFIX_ANALYSIS_IPV4_RE.test(value)
        || CRASHFIX_ANALYSIS_MAC_RE.test(value)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must not contain obvious personal identifiers`,
        });
      }
    });
}

const crashfixAnalysisSourcePathSchema = z
  .string()
  .min(1)
  .max(MAX_CRASHFIX_ANALYSIS_SOURCE_PATH_CHARS)
  .refine((value) => value === value.normalize("NFC"), "source path must use NFC normalization")
  .refine(
    (value) => !/[\\\p{Cc}\p{Cf}]/u.test(value),
    "source path must be a clean POSIX path",
  )
  .refine(
    (value) =>
      !path.posix.isAbsolute(value)
      && !path.win32.isAbsolute(value)
      && !/^[A-Za-z]:/u.test(value)
      && path.posix.normalize(value) === value
      && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "source path must be a normalized relative path",
  )
  .refine(
    (value) => CRASHFIX_ANALYSIS_SOURCE_EXTENSIONS.has(path.posix.extname(value).toLowerCase()),
    "source path must use an allowlisted source extension",
  )
  .refine((value) => {
    const parts = value.split("/");
    return !parts.some((part) =>
      CRASHFIX_ANALYSIS_BLOCKED_PATH_PARTS.has(part.toLowerCase())
      || CRASHFIX_ANALYSIS_CREDENTIAL_NAME_RE.test(part)
      || CRASHFIX_ANALYSIS_FULL_SHA256_RE.test(part)
    );
  }, "source path must not be credential-like, generated, or identity-bearing");

export const crashfixAnalysisLocationSchema = z
  .object({
    path: crashfixAnalysisSourcePathSchema,
    line: z.number().int().positive().max(MAX_CRASHFIX_ANALYSIS_LINE).optional(),
    symbol: crashfixAnalysisSafeTextSchema(
      "analysis location symbol",
      MAX_CRASHFIX_ANALYSIS_SYMBOL_CHARS,
    ).optional(),
  })
  .strict();

function crashfixAnalysisLocationKey(
  location: z.infer<typeof crashfixAnalysisLocationSchema>,
): string {
  return `${location.path}\0${String(location.line ?? "")}\0${location.symbol ?? ""}`;
}

export const crashfixAnalysisSchema = z
  .object({
    schema_version: z.literal(CRASHFIX_ANALYSIS_SCHEMA_VERSION),
    target_signature_version: crashSignatureVersionSchema,
    target_fingerprint: z.string().regex(ANALYZER_FINGERPRINT_RE),
    root_cause_summary: crashfixAnalysisSafeTextSchema(
      "root_cause_summary",
      MAX_CRASHFIX_ANALYSIS_SUMMARY_CHARS,
    ),
    confidence: z.enum(CRASHFIX_ANALYSIS_CONFIDENCES),
    category: z.enum(CRASHFIX_ANALYSIS_CATEGORIES),
    locations: z
      .array(crashfixAnalysisLocationSchema)
      .max(MAX_CRASHFIX_ANALYSIS_LOCATIONS)
      .superRefine((locations, ctx) => {
        const keys = locations.map(crashfixAnalysisLocationKey);
        if (new Set(keys).size !== keys.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "analysis locations must be unique",
          });
        }
        for (let index = 1; index < keys.length; index += 1) {
          if (Buffer.compare(Buffer.from(keys[index - 1]!), Buffer.from(keys[index]!)) >= 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "analysis locations must use canonical bytewise order",
            });
            break;
          }
        }
      }),
    remediation_summary: crashfixAnalysisSafeTextSchema(
      "remediation_summary",
      MAX_CRASHFIX_ANALYSIS_SUMMARY_CHARS,
    ),
    limitations: z
      .array(
        crashfixAnalysisSafeTextSchema(
          "analysis limitation",
          MAX_CRASHFIX_ANALYSIS_LIMITATION_CHARS,
        ),
      )
      .max(MAX_CRASHFIX_ANALYSIS_LIMITATIONS)
      .superRefine((limitations, ctx) => {
        if (new Set(limitations).size !== limitations.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "analysis limitations must be unique",
          });
        }
      }),
  })
  .strict();

export type CrashfixAnalysis = z.infer<typeof crashfixAnalysisSchema>;

const storedCrashfixAnalysisSchema = crashfixAnalysisSchema
  .extend({
    /** Private server-derived binding; renderers never expose this digest. */
    evidence_set_sha256: z.string().regex(SHA256_HEX_RE),
  })
  .strict();

export type StoredCrashfixAnalysis = z.infer<
  typeof storedCrashfixAnalysisSchema
>;

export const CRASHFIX_PROVENANCE_STATUSES = ["resolved", "unavailable"] as const;
export const CRASHFIX_REQUESTED_MODES = ["analyze", "patch", "pr"] as const;
/**
 * CrashFix workflow selection is deliberately orthogonal to requested_mode.
 * `quick_test` is a bounded, low-sensitivity local edit/test path; `strict`
 * keeps the immutable snapshot/candidate lifecycle.  Do not add either value
 * to CRASHFIX_REQUESTED_MODES: the latter describes the public operation and
 * has stronger finalization semantics.
 */
export const CRASHFIX_REQUESTED_WORKFLOWS = ["quick_test", "strict"] as const;
export const CRASHFIX_FIREBASE_ACCESS_METHODS = [
  "service-account",
  "firebaserc",
] as const;
export const CRASHFIX_PREFLIGHT_ABORT_REASONS = [
  "provenance_unavailable",
  "capability_mismatch",
] as const;
export const CRASHFIX_PROVENANCE_MODES = [
  "git_release_exact",
  "snapshot_repro_equivalent",
] as const;
export const CRASHFIX_WORKSPACE_PROJECT_CLASSIFICATIONS = ["test"] as const;
export const crashfixProvenanceStatusSchema = z.enum(CRASHFIX_PROVENANCE_STATUSES);
export const crashfixProvenanceModeSchema = z.enum(CRASHFIX_PROVENANCE_MODES);
export const crashfixRequestedModeSchema = z.enum(CRASHFIX_REQUESTED_MODES);
export const crashfixRequestedWorkflowSchema = z.enum(
  CRASHFIX_REQUESTED_WORKFLOWS,
);
export const crashfixWorkspaceProjectClassificationSchema = z.enum(
  CRASHFIX_WORKSPACE_PROJECT_CLASSIFICATIONS,
);
export const crashfixFirebaseAccessSchema = z.enum(
  CRASHFIX_FIREBASE_ACCESS_METHODS,
);
export const crashfixPreflightAbortReasonSchema = z.enum(
  CRASHFIX_PREFLIGHT_ABORT_REASONS,
);
export type CrashfixRequestedWorkflow = z.infer<
  typeof crashfixRequestedWorkflowSchema
>;

// These limits intentionally mirror materialize-workspace-snapshot.mjs. The
// report server accepts only the bounded identity summary, never a path or a
// manifest supplied by the agent.
export const MAX_SNAPSHOT_PROVENANCE_FILES = 20_000;
export const MAX_SNAPSHOT_PROVENANCE_DIRECTORIES = 10_000;
export const MAX_SNAPSHOT_PROVENANCE_BYTES = 256 * 1024 * 1024;
export const MAX_APPROVED_TEST_FIXTURES = 8;
export const EMPTY_APPROVED_TEST_FIXTURES_SHA256 =
  "bdc2f2840abddf90f142415e49414323b7fc864b8816c3a7df3c039d3f21b5ce";
const SNAPSHOT_SOURCE_IDENTITY_DOMAIN =
  "crashfix-workspace-source-snapshot/v2\0";

function computeSnapshotSourceIdentity(value: {
  manifest_sha256: string;
  exclusion_policy_sha256: string;
  dynamic_exclusions_sha256: string;
  approved_test_fixtures_sha256: string;
  approved_test_fixture_count: number;
}): string {
  const fixtureContext = value.approved_test_fixture_count === 0
    ? {
        schema_version: "crashfix-test-fixture-context/v1",
        enabled: false,
        execution_profile: "none",
        project_classification: "none",
      }
    : {
        schema_version: "crashfix-test-fixture-context/v1",
        enabled: true,
        execution_profile: "local_trusted",
        project_classification: "test",
      };
  return createHash("sha256")
    .update(SNAPSHOT_SOURCE_IDENTITY_DOMAIN, "utf8")
    .update(value.manifest_sha256, "utf8").update("\0", "utf8")
    .update(value.exclusion_policy_sha256, "utf8").update("\0", "utf8")
    .update(value.dynamic_exclusions_sha256, "utf8").update("\0", "utf8")
    .update(value.approved_test_fixtures_sha256, "utf8").update("\0", "utf8")
    .update(JSON.stringify(fixtureContext), "utf8").update("\0", "utf8")
    .update(String(value.approved_test_fixture_count), "utf8").update("\0", "utf8")
    .digest("hex");
}

export const snapshotProvenanceObjectSchema = z
  .object({
    manifest_sha256: z.string().regex(SHA256_HEX_RE),
    source_snapshot_sha256: z.string().regex(SHA256_HEX_RE),
    exclusion_policy_sha256: z.string().regex(SHA256_HEX_RE),
    dynamic_exclusions_sha256: z.string().regex(SHA256_HEX_RE),
    approved_test_fixtures_sha256: z.string().regex(SHA256_HEX_RE),
    approved_test_fixture_count: z
      .number()
      .int()
      .min(0)
      .max(MAX_APPROVED_TEST_FIXTURES),
    files: z.number().int().positive().max(MAX_SNAPSHOT_PROVENANCE_FILES),
    directories: z
      .number()
      .int()
      .min(1)
      .max(MAX_SNAPSHOT_PROVENANCE_DIRECTORIES),
    bytes: z.number().int().positive().max(MAX_SNAPSHOT_PROVENANCE_BYTES),
  })
  .strict();

export const snapshotProvenanceSchema = snapshotProvenanceObjectSchema
  .superRefine((value, context) => {
    const isCanonicalEmptyDigest = value.approved_test_fixtures_sha256
      === EMPTY_APPROVED_TEST_FIXTURES_SHA256;
    if ((value.approved_test_fixture_count === 0) !== isCanonicalEmptyDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approved_test_fixtures_sha256"],
        message: "approved test fixture count and canonical empty-set digest disagree",
      });
    }
    if (value.source_snapshot_sha256 !== computeSnapshotSourceIdentity(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source_snapshot_sha256"],
        message:
          "source_snapshot_sha256 does not match the canonical v2 snapshot identity",
      });
    }
  });

const sha256IdentitySchema = z.string().regex(SHA256_HEX_RE);
const analyzerFingerprintSchema = z.string().regex(ANALYZER_FINGERPRINT_RE);

function assertVersionedAnalyzerFingerprint(
  signature: unknown,
  signatureVersion: CrashSignatureVersion | undefined,
): void {
  if (signatureVersion === undefined) return;
  if (typeof signature !== "string" || !ANALYZER_FINGERPRINT_RE.test(signature)) {
    throw new TypeError(
      "versioned crash signature must be a 12-character lowercase hexadecimal analyzer fingerprint",
    );
  }
}
const sessionIdReferenceSchema = z
  .string()
  .min(1)
  .max(MAX_SESSION_ID_CHARS)
  .regex(SESSION_ID_REFERENCE_RE);
const artifactAppIdSchema = z.string().regex(ARTIFACT_APP_ID_RE);
const artifactBuildIdSchema = z.string().regex(ARTIFACT_BUILD_ID_RE);
export const BUILD_RUNNER_EXECUTION_PROFILES = [
  "local_trusted",
  "docker_strict",
] as const;
export const BUILD_RUNNER_NETWORK_POLICIES = ["not_enforced", "denied"] as const;
export const BUILD_RUNNER_FILESYSTEM_WRITE_ISOLATIONS = [
  "not_enforced",
  "enforced",
] as const;
export const BUILD_RUNNER_SECRET_FILESYSTEM_ISOLATIONS = [
  "not_enforced",
  "enforced",
] as const;
export const BUILD_RUNNER_PROCESS_CONTAINMENTS = [
  "process_group_best_effort",
  "container+process_group",
] as const;
export const buildRunnerExecutionProfileSchema = z.enum(
  BUILD_RUNNER_EXECUTION_PROFILES,
);
export const buildRunnerNetworkPolicySchema = z.enum(BUILD_RUNNER_NETWORK_POLICIES);
export const buildRunnerFilesystemWriteIsolationSchema = z.enum(
  BUILD_RUNNER_FILESYSTEM_WRITE_ISOLATIONS,
);
export const buildRunnerSecretFilesystemIsolationSchema = z.enum(
  BUILD_RUNNER_SECRET_FILESYSTEM_ISOLATIONS,
);
export const buildRunnerProcessContainmentSchema = z.enum(
  BUILD_RUNNER_PROCESS_CONTAINMENTS,
);
const candidateChangedFilesSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => !/[\\\u0000-\u001f\u007f]/.test(value), "must be a clean POSIX path")
      .refine(
        (value) =>
          !path.posix.isAbsolute(value)
          && !path.win32.isAbsolute(value)
          && !/^[a-zA-Z]:/.test(value)
          && path.posix.normalize(value) === value
          && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
        "must be a normalized relative path",
      ),
  )
  .min(1)
  .max(100)
  .superRefine((files, ctx) => {
    if (new Set(files).size !== files.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "changed_files must be unique" });
    }
    const totalChars = files.reduce((total, value) => total + value.length, 0);
    if (totalChars > 32_768) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "changed_files exceeds the aggregate character limit",
      });
    }
    if (files.some((value, index) =>
      index > 0
      && Buffer.compare(
        Buffer.from(files[index - 1]!, "utf8"),
        Buffer.from(value, "utf8"),
      ) >= 0
    )) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "changed_files must be strictly sorted",
      });
    }
  });

/**
 * Closed, ordered identity updates for a snapshot repair candidate.
 *
 * The candidate stage binds the build output to the already-sealed source.
 * Verification and export are deliberately separate later writes so an agent
 * cannot claim device verification or delivery while it is only building.
 */
export const candidateBuildProvenanceShape = {
  stage: z.literal("candidate"),
  baseline_artifact_sha256: sha256IdentitySchema,
  artifact_sha256: sha256IdentitySchema,
  build_environment_sha256: sha256IdentitySchema,
  execution_profile: buildRunnerExecutionProfileSchema,
  strong_isolation: z.boolean(),
  workspace_disk_quota_enforced: z.boolean(),
  network_policy: buildRunnerNetworkPolicySchema,
  filesystem_write_isolation: buildRunnerFilesystemWriteIsolationSchema,
  secret_filesystem_isolation: buildRunnerSecretFilesystemIsolationSchema,
  process_containment: buildRunnerProcessContainmentSchema,
  canonical_diff_sha256: sha256IdentitySchema,
  candidate_manifest_sha256: sha256IdentitySchema,
  workspace_canonical_diff_sha256: sha256IdentitySchema,
  workspace_manifest_sha256: sha256IdentitySchema,
  workspace_role: z.literal("candidate"),
  changed_files: candidateChangedFilesSchema,
  artifact_platform: z.enum(["android", "ios"]),
  artifact_app_id: artifactAppIdSchema,
  artifact_version: artifactBuildIdSchema,
  artifact_build: artifactBuildIdSchema,
  artifact_variant: artifactBuildIdSchema,
  variant_source: z.literal("task-bound"),
  variant_artifact_derived: z.literal(false),
  artifact_signing_identity_ref_sha256: sha256IdentitySchema,
} satisfies z.ZodRawShape;

export const candidateBuildProvenanceSchema = z
  .object(candidateBuildProvenanceShape)
  .strict()
  .superRefine((value, ctx) => {
    if (value.workspace_manifest_sha256 !== value.candidate_manifest_sha256) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspace_manifest_sha256"],
        message: "workspace_manifest_sha256 must match candidate_manifest_sha256",
      });
    }
    if (value.workspace_canonical_diff_sha256 !== value.canonical_diff_sha256) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspace_canonical_diff_sha256"],
        message:
          "workspace_canonical_diff_sha256 must match canonical_diff_sha256",
      });
    }
    const expected = value.execution_profile === "local_trusted"
      ? {
          strong_isolation: false,
          workspace_disk_quota_enforced: false,
          network_policy: "not_enforced",
          filesystem_write_isolation: "not_enforced",
          secret_filesystem_isolation: "not_enforced",
          process_containment: "process_group_best_effort",
        } as const
      : {
          strong_isolation: true,
          workspace_disk_quota_enforced: true,
          network_policy: "denied",
          filesystem_write_isolation: "enforced",
          secret_filesystem_isolation: "enforced",
          process_containment: "container+process_group",
        } as const;
    for (const key of [
      "strong_isolation",
      "workspace_disk_quota_enforced",
      "network_policy",
      "filesystem_write_isolation",
      "secret_filesystem_isolation",
      "process_containment",
    ] as const) {
      if (value[key] !== expected[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message:
            `execution_profile=${value.execution_profile} requires ${key}=${String(expected[key])}`,
        });
      }
    }
  });

export const candidateVerificationProvenanceSchema = z
  .object({
    stage: z.literal("verification"),
    artifact_sha256: sha256IdentitySchema,
    device_ref_sha256: sha256IdentitySchema,
    plan_sha256: sha256IdentitySchema,
    target_signature_version: crashSignatureVersionSchema,
    target_fingerprint: analyzerFingerprintSchema,
    child_session_ids: z
      .array(sessionIdReferenceSchema)
      .length(3)
      .superRefine((ids, ctx) => {
        if (new Set(ids).size !== ids.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "child_session_ids must contain three distinct sessions",
          });
        }
      }),
  })
  .strict();

/**
 * A verification child opts into this immutable context at start_session.
 * Generic devtest sessions are unaffected unless one of the verification
 * control fields is present.
 */
export const childVerificationContextSchema = z
  .object({
    verification_schema_version: z.literal("crashfix-child-verification/v1"),
    verification_parent_session_id: sessionIdReferenceSchema,
    verification_run: z.number().int().min(1).max(3),
    artifact_sha256: sha256IdentitySchema,
    device_ref_sha256: sha256IdentitySchema,
    plan_sha256: sha256IdentitySchema,
    verification_target_signature_version: crashSignatureVersionSchema,
    verification_target_fingerprint: analyzerFingerprintSchema,
    platform: z.enum(["android", "ios"]),
    type: z.literal("real"),
  })
  .strict();

/**
 * Completion facts supplied only at finalize. Identity comes from the child's
 * immutable start context; the report server independently derives the crash
 * and step counts from the finalized session files.
 */
export const childVerificationCompletionSchema = z
  .object({
    schema_version: z.literal("crashfix-child-verification/v1"),
    artifact_identity_verified: z.literal(true),
    capture_started: z.literal(true),
    capture_stopped: z.literal(true),
    crash_drain_complete: z.literal(true),
    evidence_archive_complete: z.literal(true),
    analyzer_check_complete: z.literal(true),
    assertions_passed: z.literal(true),
  })
  .strict();

export const childVerificationRecordSchema = childVerificationContextSchema.extend({
  schema_version: z.literal("crashfix-child-verification/v1"),
  artifact_identity_verified: z.literal(true),
  capture_started: z.literal(true),
  capture_stopped: z.literal(true),
  crash_drain_complete: z.literal(true),
  evidence_archive_complete: z.literal(true),
  analyzer_check_complete: z.literal(true),
  assertions_passed: z.literal(true),
  target_signature_occurrences: z.literal(0),
  crash_records: z.literal(0),
  passed_steps: z.number().int().positive(),
}).strict();

/** Stored parent-side evidence. child ids are hashed before persistence. */
export const storedCandidateVerificationProvenanceSchema = z
  .object({
    stage: z.literal("verification"),
    artifact_sha256: sha256IdentitySchema,
    device_ref_sha256: sha256IdentitySchema,
    plan_sha256: sha256IdentitySchema,
    target_signature_version: crashSignatureVersionSchema,
    target_fingerprint: analyzerFingerprintSchema,
    verification_child_session_ref_sha256s: z
      .array(sha256IdentitySchema)
      .length(3)
      .superRefine((refs, ctx) => {
        if (new Set(refs).size !== refs.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "stored verification child references must be distinct",
          });
        }
      }),
    verification_child_evidence_sha256s: z
      .array(sha256IdentitySchema)
      .length(3),
    verification_runs: z.literal(3),
    verified: z.literal(true),
  })
  .strict();

export const candidateExportProvenanceSchema = z
  .object({
    stage: z.literal("export"),
    canonical_diff_sha256: sha256IdentitySchema,
    candidate_manifest_sha256: sha256IdentitySchema,
    destination_ref_sha256: sha256IdentitySchema,
  })
  .strict();

export const candidateProvenanceSchema = z.union([
  candidateBuildProvenanceSchema,
  candidateVerificationProvenanceSchema,
  candidateExportProvenanceSchema,
]);

export type CrashfixProvenanceStatus = z.infer<typeof crashfixProvenanceStatusSchema>;
export type CrashfixProvenanceMode = z.infer<typeof crashfixProvenanceModeSchema>;
export type CrashfixRequestedMode = z.infer<typeof crashfixRequestedModeSchema>;
export type SnapshotProvenance = z.infer<typeof snapshotProvenanceSchema>;
export type BuildRunnerExecutionProfile = z.infer<
  typeof buildRunnerExecutionProfileSchema
>;
export type BuildRunnerNetworkPolicy = z.infer<typeof buildRunnerNetworkPolicySchema>;
export type BuildRunnerFilesystemWriteIsolation = z.infer<
  typeof buildRunnerFilesystemWriteIsolationSchema
>;
export type BuildRunnerSecretFilesystemIsolation = z.infer<
  typeof buildRunnerSecretFilesystemIsolationSchema
>;
export type BuildRunnerProcessContainment = z.infer<
  typeof buildRunnerProcessContainmentSchema
>;
export type CandidateBuildProvenance = z.infer<typeof candidateBuildProvenanceSchema>;
export type CandidateVerificationProvenance = z.infer<
  typeof candidateVerificationProvenanceSchema
>;
export type ChildVerificationContext = z.infer<typeof childVerificationContextSchema>;
export type ChildVerificationCompletion = z.infer<
  typeof childVerificationCompletionSchema
>;
export type ChildVerificationRecord = z.infer<typeof childVerificationRecordSchema>;
export type StoredCandidateVerificationProvenance = z.infer<
  typeof storedCandidateVerificationProvenanceSchema
>;
export type CandidateExportProvenance = z.infer<typeof candidateExportProvenanceSchema>;
export type CandidateProvenance = z.infer<typeof candidateProvenanceSchema>;

const SNAPSHOT_SOURCE_EXTRA_KEYS = [
  "manifest_sha256",
  "source_snapshot_sha256",
  "exclusion_policy_sha256",
  "dynamic_exclusions_sha256",
  "approved_test_fixtures_sha256",
  "approved_test_fixture_count",
  "files",
  "directories",
  "bytes",
] as const;
const APPROVED_TEST_FIXTURE_BINDING_KEYS = new Set([
  "approved_test_fixtures_sha256",
  "approved_test_fixture_count",
]);
const SNAPSHOT_CANDIDATE_BUILD_EXTRA_KEYS = [
  "baseline_artifact_sha256",
  "artifact_sha256",
  "build_environment_sha256",
  "execution_profile",
  "strong_isolation",
  "workspace_disk_quota_enforced",
  "network_policy",
  "filesystem_write_isolation",
  "secret_filesystem_isolation",
  "process_containment",
  "canonical_diff_sha256",
  "candidate_manifest_sha256",
  "workspace_canonical_diff_sha256",
  "workspace_manifest_sha256",
  "workspace_role",
  "changed_files",
  "artifact_platform",
  "artifact_app_id",
  "artifact_version",
  "artifact_build",
  "artifact_variant",
  "variant_source",
  "variant_artifact_derived",
  "artifact_signing_identity_ref_sha256",
] as const;
const SNAPSHOT_CANDIDATE_VERIFICATION_EXTRA_KEYS = [
  "device_ref_sha256",
  "plan_sha256",
  "target_signature_version",
  "target_fingerprint",
  "verification_child_session_ref_sha256s",
  "verification_child_evidence_sha256s",
  "verification_runs",
  "verified",
] as const;
const SNAPSHOT_CANDIDATE_EXPORT_EXTRA_KEYS = [
  "destination_ref_sha256",
] as const;
const SNAPSHOT_CANDIDATE_EXTRA_KEYS = [
  ...SNAPSHOT_CANDIDATE_BUILD_EXTRA_KEYS,
  ...SNAPSHOT_CANDIDATE_VERIFICATION_EXTRA_KEYS,
  ...SNAPSHOT_CANDIDATE_EXPORT_EXTRA_KEYS,
] as const;
// These names have snapshot-specific meaning and therefore cannot appear in
// an unscoped devtest session. Generic artifact/device/plan fields remain
// available to ordinary devtest sessions that do not opt into CrashFix.
const SNAPSHOT_SCOPED_CANDIDATE_EXTRA_KEYS = [
  "baseline_artifact_sha256",
  "canonical_diff_sha256",
  "candidate_manifest_sha256",
  "workspace_canonical_diff_sha256",
  "workspace_manifest_sha256",
  "workspace_role",
  "artifact_platform",
  "artifact_app_id",
  "artifact_version",
  "artifact_build",
  "artifact_variant",
  "variant_source",
  "variant_artifact_derived",
  "artifact_signing_identity_ref_sha256",
  "execution_profile",
  "strong_isolation",
  "workspace_disk_quota_enforced",
  "network_policy",
  "filesystem_write_isolation",
  "secret_filesystem_isolation",
  "process_containment",
  "destination_ref_sha256",
  "verification_child_session_ref_sha256s",
  "verification_child_evidence_sha256s",
  "verification_runs",
  "verified",
] as const;
const SNAPSHOT_ONLY_EXTRA_KEYS = [
  ...SNAPSHOT_SOURCE_EXTRA_KEYS,
  ...SNAPSHOT_SCOPED_CANDIDATE_EXTRA_KEYS,
] as const;
const GIT_ONLY_PROVENANCE_EXTRA_KEYS = ["commit", "candidate_base_sha"] as const;
const LEGACY_DERIVED_PROVENANCE_EXTRA_KEYS = ["diff_sha256"] as const;
const INITIAL_PROVENANCE_RESULT_KEYS = [
  ...SNAPSHOT_SOURCE_EXTRA_KEYS,
  ...SNAPSHOT_CANDIDATE_EXTRA_KEYS,
  ...LEGACY_DERIVED_PROVENANCE_EXTRA_KEYS,
  "source_ref_sha256",
] as const;
// CrashFix may lock the expected Build Runner profile at session creation.
// This is an initial control value, not a derived provenance result, so it
// must remain outside INITIAL_PROVENANCE_RESULT_KEYS.
const INITIAL_CRASHFIX_CONTROL_EXTRA_KEYS = [
  "requested_execution_profile",
  "workspace_project_classification",
  "requested_mode",
  "requested_workflow",
  "firebase_access",
  "preflight_abort",
] as const;
const INITIAL_CRASHFIX_EXTRA_KEYS = new Set([
  "origin",
  "provider",
  "acquisition_route",
  "source_locked",
  "provenance_status",
  "provenance_mode",
  "provenance_explicit",
  "requested_mode",
  "requested_workflow",
  "requested_execution_profile",
  "workspace_project_classification",
  "firebase_access",
  "preflight_abort",
  "project_alias",
  "repo_alias",
  "raw_evidence_archived",
  // A Git route may record only its independently verified initial HEAD here;
  // candidate/diff identities remain derived fields bound by dedicated tools.
  "commit",
]);
const CRASHFIX_SAFE_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GIT_OBJECT_ID_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CRASHFIX_TARGET_EXTRA_KEYS = [
  "crashfix_target_schema_version",
  "crashfix_target_ref_sha256",
  "crashfix_target_app_build_ref_sha256",
] as const;
const CHILD_VERIFICATION_CONTROL_EXTRA_KEYS = [
  "verification_schema_version",
  "verification_parent_session_id",
  "verification_run",
  "verification_target_signature_version",
  "verification_target_fingerprint",
] as const;

const sourceIdSchema = z
  .string()
  .min(1)
  .max(MAX_SOURCE_ID_CHARS)
  .refine((value) => value === value.trim(), "must not have surrounding whitespace")
  .refine((value) => !/[\r\n\0]/.test(value), "must be a single line");

const crashSourceMetricsSchema = z
  .record(z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER))
  .superRefine((metrics, ctx) => {
    const entries = Object.entries(metrics);
    if (entries.length > MAX_CRASH_SOURCE_METRICS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `metrics exceeds ${MAX_CRASH_SOURCE_METRICS} entry limit`,
      });
    }
    for (const [key] of entries) {
      if (
        key.length === 0 ||
        key.length > MAX_SOURCE_METRIC_KEY_CHARS ||
        !SOURCE_METRIC_KEY_RE.test(key)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key.slice(0, MAX_SOURCE_METRIC_KEY_CHARS)],
          message: "metric key is invalid or too long",
        });
      }
    }
  });

export const crashArtifactTargetSchema = z
  .object({
    platform: z.enum(["android", "ios"]),
    app_id: artifactAppIdSchema,
    version: artifactBuildIdSchema,
    build: artifactBuildIdSchema,
  })
  .strict();

export type CrashArtifactTarget = z.infer<typeof crashArtifactTargetSchema>;

export const crashfixTargetSchema = z
  .object({
    project: sourceIdSchema,
    app: sourceIdSchema,
    issue: sourceIdSchema,
    app_build: crashArtifactTargetSchema,
  })
  .strict();

export type CrashfixTarget = z.infer<typeof crashfixTargetSchema>;

const storedCrashfixTargetBindingSchema = z
  .object({
    crashfix_target_schema_version: z.literal("crashfix-target/v1"),
    crashfix_target_ref_sha256: sha256IdentitySchema,
    crashfix_target_app_build_ref_sha256: sha256IdentitySchema,
  })
  .strict();

type StoredCrashfixTargetBinding = z.infer<
  typeof storedCrashfixTargetBindingSchema
>;

/** Provider metadata is bounded and closed to extra keys. */
export const crashSourceSchema = z
  .object({
    provider: z
      .string()
      .min(1)
      .max(MAX_SOURCE_PROVIDER_CHARS)
      .regex(SOURCE_PROVIDER_RE),
    external_key: sourceIdSchema,
    project: sourceIdSchema.optional(),
    app: sourceIdSchema.optional(),
    issue: sourceIdSchema.optional(),
    event: sourceIdSchema.optional(),
    occurred: z
      .string()
      .min(1)
      .max(64)
      .refine(
        (value) => RFC3339_RE.test(value) && Number.isFinite(Date.parse(value)),
        "must be a valid RFC 3339 timestamp",
      )
      .optional(),
    metrics: crashSourceMetricsSchema.optional(),
    app_build: crashArtifactTargetSchema.optional(),
  })
  .strict()
  .superRefine((source, ctx) => {
    if (source.provider === FIREBASE_CRASHLYTICS_PROVIDER) {
      for (const field of ["project", "app", "issue", "event"] as const) {
        if (source[field] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `firebase-crashlytics source requires ${field}`,
          });
        }
      }
      if (!SHA256_HEX_RE.test(source.external_key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["external_key"],
          message: "firebase-crashlytics external_key must be 64 lowercase SHA-256 hex characters",
        });
      }
    }
    if (Buffer.byteLength(JSON.stringify(source), "utf8") > MAX_CRASH_SOURCE_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `source exceeds ${MAX_CRASH_SOURCE_BYTES} byte size limit`,
      });
    }
  });

export type CrashSource = z.infer<typeof crashSourceSchema>;

export type SessionStatus = "running" | "passed" | "failed" | "aborted";
export type TerminalSessionStatus = Exclude<SessionStatus, "running">;

export interface SessionMeta {
  id: string;
  name: string;
  started_at: string; // ISO
  ended_at?: string;
  status: SessionStatus;
  /** Immutable display language selected when the session is created. */
  report_language?: ReportLanguage;
  /** Immutable, privacy-bounded CrashFix root-cause analysis. */
  crashfix_analysis?: StoredCrashfixAnalysis;
  /** Immutable remote acquisition boundary enforced by recordCrashEvidence. */
  source_lock?: RemoteSourceLock;
  /** Present only after a verification child passes strict finalize checks. */
  verification?: ChildVerificationRecord;
  /** Optional arbitrary key/value collected by the agent. */
  extra?: Record<string, unknown>;
}

export const sessionNameSchema = z
  .string()
  .min(1)
  .max(MAX_SESSION_NAME_CHARS)
  .refine((value) => value.trim().length > 0, "must not be blank")
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "must not contain control characters",
  );

export const sessionExtraSchema = z.record(z.unknown());

export interface StepRecord {
  index: number;
  ts: string; // ISO
  action: string;
  result?: "ok" | "fail" | "skip";
  screenshot?: string; // relative path inside session dir
  log_excerpt?: string; // relative path
  notes?: string;
}

export interface CrashRecord {
  id: string;        // c1, c2, ...
  ts: string;
  step_index?: number; // step where it was detected
  signature: string;
  /** Absent only on legacy records or local evidence that predates versioning. */
  signature_version?: CrashSignatureVersion;
  /** Analyzer attestation; required for CrashFix remote evidence. */
  signature_degraded?: boolean;
  /** Analyzer attestation; required for CrashFix remote evidence. */
  cross_source_comparable?: boolean;
  kind?: string;     // java | anr | native | other
  stack_path: string;  // relative
  log_path?: string;   // relative — full log archived
  repro_path: number[]; // sequence of step indices considered required
  minimized_repro_path?: number[];
  minimized_attempts?: number;
  minimized_confidence?: "low" | "medium" | "high";
  minimized_complete?: boolean;
  /** Optional normalized origin for remote crash evidence. */
  source?: CrashSource;
}

const rfc3339TimestampSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) => RFC3339_RE.test(value) && Number.isFinite(Date.parse(value)),
    "must be a valid RFC 3339 timestamp",
  );
const storedSessionMetaSchema = z
  .object({
    id: sessionIdReferenceSchema,
    name: sessionNameSchema,
    started_at: rfc3339TimestampSchema,
    ended_at: rfc3339TimestampSchema.optional(),
    status: z.enum(["running", "passed", "failed", "aborted"]),
    // Optional only for reading legacy sessions. New sessions always persist
    // the resolved value so finalize/regenerate cannot drift between languages.
    report_language: reportLanguageSchema.optional(),
    crashfix_analysis: storedCrashfixAnalysisSchema.optional(),
    source_lock: remoteSourceLockSchema.optional(),
    verification: childVerificationRecordSchema.optional(),
    extra: sessionExtraSchema.optional(),
  })
  .strict()
  .superRefine((meta, ctx) => {
    if (meta.crashfix_analysis === undefined) return;
    if (meta.extra === undefined || !hasOwn(meta.extra, "provenance_status")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["crashfix_analysis"],
        message: "crashfix_analysis requires a CrashFix session",
      });
      return;
    }
    if (
      meta.extra.provenance_status === "unavailable"
      && meta.crashfix_analysis.locations.length !== 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["crashfix_analysis", "locations"],
        message: "unavailable CrashFix provenance requires empty analysis locations",
      });
    }
  });
const sessionLockOwnerSchema = z
  .object({
    token: z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i),
    pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    acquired_at: rfc3339TimestampSchema,
  })
  .strict();
const sessionRelativePathSchema = z
  .string()
  .min(1)
  .max(MAX_SESSION_PATH_CHARS)
  .refine((value) => !value.includes("\0"), "must not contain NUL")
  .refine(
    (value) => !/[\\:%?#]/.test(value),
    "must not contain URI or platform path metacharacters",
  )
  .refine(
    (value) =>
      !path.posix.isAbsolute(value)
      && !path.win32.isAbsolute(value)
      && !/^[a-zA-Z]:/.test(value)
      && path.posix.normalize(value) === value
      && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "must be a normalized contained relative path",
  );
const storedScreenshotPathSchema = sessionRelativePathSchema.refine(
  (value) => /^steps\/[0-9]+\.(?:png|jpg|jpeg|webp)$/.test(value),
  "must be a generated step screenshot path",
);
const storedStepLogPathSchema = sessionRelativePathSchema.refine(
  (value) => /^steps\/[0-9]+\.log$/.test(value),
  "must be a generated step log path",
);
const storedStepSchema = z
  .object({
    index: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    ts: rfc3339TimestampSchema,
    action: z.string().min(1).max(16 * 1024),
    result: z.enum(["ok", "fail", "skip"]).optional(),
    screenshot: storedScreenshotPathSchema.optional(),
    log_excerpt: storedStepLogPathSchema.optional(),
    notes: z.string().max(64 * 1024).optional(),
  })
  .strict()
  .superRefine((step, ctx) => {
    const stem = String(step.index).padStart(3, "0");
    if (
      step.screenshot !== undefined
      && !new RegExp(`^steps/${stem}\\.(?:png|jpg|jpeg|webp)$`).test(step.screenshot)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["screenshot"],
        message: "screenshot path must match the step index",
      });
    }
    if (step.log_excerpt !== undefined && step.log_excerpt !== `steps/${stem}.log`) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["log_excerpt"],
        message: "log excerpt path must match the step index",
      });
    }
  });
const crashfixStepShortHashSchema = z.string().regex(/^[a-f0-9]{12}$/);
const crashfixStepSafeLabelSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/);
const crashfixStepRedactionSchema = z
  .object({
    fields_removed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    values_masked: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const CRASHFIX_STEP_ACTIONS = [
  "preflight",
  "remote_scope_verification",
  "remote_issue_triage",
  "remote_evidence_archival",
  "crash_identity_analysis",
  "source_provenance_binding",
  "test_fixture_probe",
  "test_fixture_approval",
  "source_snapshot",
  "source_location",
  "baseline_validation",
  "candidate_preparation",
  "candidate_validation",
  "real_device_verification",
  "candidate_export",
  "abort",
] as const;
const crashfixStepActionSchema = z.enum(CRASHFIX_STEP_ACTIONS);
const crashfixStepNotesSchema = z
  .object({
    provider: z.literal(FIREBASE_CRASHLYTICS_PROVIDER).optional(),
    acquisition_route: crashAcquisitionRouteSchema.optional(),
    schema: crashfixStepSafeLabelSchema.optional(),
    app_alias: z.string().regex(CRASHFIX_SAFE_ALIAS_RE).optional(),
    issue_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    event_count: z.number().int().nonnegative().max(3).optional(),
    signature_version: crashSignatureVersionSchema.optional(),
    fingerprint: analyzerFingerprintSchema.optional(),
    symbolication: z
      .enum(["symbolicated", "partial", "unsymbolicated", "unknown"])
      .optional(),
    truncated: z.boolean().optional(),
    provenance_status: crashfixProvenanceStatusSchema.optional(),
    provenance_mode: crashfixProvenanceModeSchema.optional(),
    redaction: crashfixStepRedactionSchema.optional(),
    source_ref_sha256_prefix: crashfixStepShortHashSchema.optional(),
    approved_test_fixtures_sha256_prefix:
      crashfixStepShortHashSchema.optional(),
    approved_test_fixture_count: z
      .number()
      .int()
      .min(0)
      .max(MAX_APPROVED_TEST_FIXTURES)
      .optional(),
    raw_evidence_archived: z.literal(false).optional(),
    execution_profile: buildRunnerExecutionProfileSchema.optional(),
    strong_isolation: z.boolean().optional(),
    workspace_disk_quota_enforced: z.boolean().optional(),
    network_policy: buildRunnerNetworkPolicySchema.optional(),
    filesystem_write_isolation:
      buildRunnerFilesystemWriteIsolationSchema.optional(),
    secret_filesystem_isolation:
      buildRunnerSecretFilesystemIsolationSchema.optional(),
    process_containment: buildRunnerProcessContainmentSchema.optional(),
    role: z.enum(["baseline", "candidate"]).optional(),
    phase: crashfixStepSafeLabelSchema.optional(),
    status: z
      .enum(["running", "ok", "fail", "skip", "passed", "failed", "aborted"])
      .optional(),
    exit_code: z.number().int().min(-1).max(255).optional(),
    variant_source: z.enum(["task-bound", "unavailable"]).optional(),
    build_environment_sha256_prefix: crashfixStepShortHashSchema.optional(),
    command_sha256_prefix: crashfixStepShortHashSchema.optional(),
    cache_seed_sha256_prefix: crashfixStepShortHashSchema.optional(),
    artifact_sha256_prefix: crashfixStepShortHashSchema.optional(),
    image_sha256_prefix: crashfixStepShortHashSchema.optional(),
    sandbox_sha256_prefix: crashfixStepShortHashSchema.optional(),
    quota_sha256_prefix: crashfixStepShortHashSchema.optional(),
  })
  .strict()
  .superRefine((notes, context) => {
    if (Object.keys(notes).length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "CrashFix step notes must not be an empty object",
      });
    }
    const fixtureBindingCount = Number(
      notes.approved_test_fixtures_sha256_prefix !== undefined,
    ) + Number(notes.approved_test_fixture_count !== undefined);
    if (fixtureBindingCount === 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approved_test_fixture_count"],
        message: "CrashFix fixture note prefix and count must be all-or-none",
      });
    }
    if (
      notes.provenance_mode !== undefined
      && notes.provenance_status !== "resolved"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provenance_mode"],
        message: "CrashFix step provenance_mode requires provenance_status=resolved",
      });
    }
    const dockerOnlyFields = [
      notes.image_sha256_prefix,
      notes.sandbox_sha256_prefix,
      notes.quota_sha256_prefix,
    ];
    if (
      dockerOnlyFields.some((value) => value !== undefined)
      && notes.execution_profile !== "docker_strict"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["execution_profile"],
        message: "Docker-only CrashFix note references require docker_strict",
      });
    }
  });

export function isCrashfixSessionMeta(meta: SessionMeta): boolean {
  return meta.extra !== undefined && hasOwn(meta.extra, "provenance_status");
}

const CRASHFIX_SESSION_NAME_RE = /^crashfix-[A-Za-z0-9._-]{1,80}$/;

function assertCrashfixSessionName(
  name: string,
  extra: Record<string, unknown> | undefined,
): void {
  if (extra === undefined || !hasOwn(extra, "provenance_status")) return;
  if (
    !CRASHFIX_SESSION_NAME_RE.test(name)
    || /[a-f0-9]{64}/i.test(name)
    || name.includes("/")
    || name.includes("\\")
  ) {
    throw new Error(
      "CrashFix session name must use crashfix- followed by a bounded safe alias",
    );
  }
}

/**
 * Firebase target identifiers stay private even when they happen to satisfy
 * the syntax of a public session/project alias.  Check the few public aliases
 * owned by Session metadata as soon as a target/event becomes known, and
 * repeat the check while rendering archived evidence so a copied or tampered
 * session also fails closed.
 */
function assertCrashfixPublicAliasesOmitSourceIdentifiers(
  meta: SessionMeta,
  sourceIdentifiers: readonly string[],
): void {
  const aliases = [
    meta.id,
    meta.name,
    ...(typeof meta.extra?.project_alias === "string"
      ? [meta.extra.project_alias]
      : []),
    ...(typeof meta.extra?.repo_alias === "string"
      ? [meta.extra.repo_alias]
      : []),
  ];
  if (
    sourceIdentifiers.some(
      (identifier) =>
        identifier.length > 0
        && aliases.some((alias) =>
          publicTextContainsSourceIdentifier(alias, identifier)
        ),
    )
  ) {
    throw new Error(
      "CrashFix public session aliases must not repeat Firebase target or event identifiers",
    );
  }
}

const SHORT_AMBIGUOUS_SOURCE_IDENTIFIER_RE = /^[A-Za-z0-9]{1,5}$/;
const ASCII_IDENTIFIER_CONTINUATION_RE = /[A-Za-z0-9_]/;

/**
 * Detect a private source identifier in one public string.
 *
 * Source ids are non-empty, single-line and bounded by `sourceIdSchema`. Long
 * or punctuated ids are distinctive enough for an exact substring check. A
 * one-to-five-character ASCII id is inherently ambiguous (for example `id`),
 * so require identifier-token boundaries: this still catches `issue=id`,
 * `id failed`, and adjacent CJK prose, without treating the `id` in `valid`
 * as leaked Firebase data.
 */
export function publicTextContainsSourceIdentifier(
  value: string,
  identifier: string,
): boolean {
  if (identifier.length === 0) return false;
  if (!SHORT_AMBIGUOUS_SOURCE_IDENTIFIER_RE.test(identifier)) {
    return value.includes(identifier);
  }

  let offset = 0;
  while (offset <= value.length - identifier.length) {
    const index = value.indexOf(identifier, offset);
    if (index === -1) return false;
    const before = index === 0 ? "" : value[index - 1]!;
    const afterIndex = index + identifier.length;
    const after = afterIndex >= value.length ? "" : value[afterIndex]!;
    if (
      (before === "" || !ASCII_IDENTIFIER_CONTINUATION_RE.test(before))
      && (after === "" || !ASCII_IDENTIFIER_CONTINUATION_RE.test(after))
    ) {
      return true;
    }
    offset = index + identifier.length;
  }
  return false;
}

/** Fail closed before any caller-controlled report prose reaches a public view. */
export function assertCrashfixReportInput(
  meta: SessionMeta,
  summary: string | undefined,
): void {
  if (!isCrashfixSessionMeta(meta)) return;
  if (summary !== undefined) {
    throw new Error("CrashFix reports must omit caller-supplied summary text");
  }
}

function parseCrashfixStepNotes(
  notes: string,
): z.infer<typeof crashfixStepNotesSchema> {
  if (/[\r\n\0]/.test(notes)) {
    throw new Error("CrashFix step notes must be single-line strict JSON");
  }
  if (/\b[a-f0-9]{64}\b/i.test(notes)) {
    throw new Error("CrashFix step notes must not contain full SHA-256 values");
  }
  if (
    /(?:^|["'\s:=])\/(?:[^\s"']+\/)*[^\s"']+/.test(notes)
    || /[A-Za-z]:[\\/]/.test(notes)
    || /(?:^|["'\s:=])\\\\/.test(notes)
  ) {
    throw new Error("CrashFix step notes must not contain absolute paths");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(notes);
  } catch {
    throw new Error("CrashFix step notes must be single-line strict JSON");
  }
  const parsed = crashfixStepNotesSchema.safeParse(decoded);
  if (!parsed.success || JSON.stringify(parsed.data) !== notes) {
    throw new Error("CrashFix step notes do not match the closed audit schema");
  }
  return parsed.data;
}

function assertCrashfixStepAction(action: string): void {
  if (!crashfixStepActionSchema.safeParse(action).success) {
    throw new Error("CrashFix step action must use the closed action code set");
  }
}

export function assertCrashfixStepEvidence(
  meta: SessionMeta,
  input: {
    action: string;
    notes?: string;
    has_screenshot?: boolean;
    has_log_excerpt?: boolean;
  },
): void {
  if (!isCrashfixSessionMeta(meta)) return;
  if (input.has_screenshot || input.has_log_excerpt) {
    throw new Error(
      "CrashFix steps must omit screenshot and log excerpt evidence",
    );
  }
  assertCrashfixStepAction(input.action);
  if (input.notes === undefined) return;
  const notes = parseCrashfixStepNotes(input.notes);
  const extra = meta.extra!;
  if (
    notes.provider !== undefined
    && notes.provider !== meta.source_lock?.provider
  ) {
    throw new Error("CrashFix step provider does not match the session source lock");
  }
  if (
    notes.acquisition_route !== undefined
    && notes.acquisition_route !== meta.source_lock?.acquisition_route
  ) {
    throw new Error("CrashFix step route does not match the session source lock");
  }
  if (
    notes.provenance_status !== undefined
    && notes.provenance_status !== extra.provenance_status
  ) {
    throw new Error("CrashFix step provenance status does not match the session");
  }
  if (
    notes.provenance_mode !== undefined
    && notes.provenance_mode !== extra.provenance_mode
  ) {
    throw new Error("CrashFix step provenance mode does not match the session");
  }
  if (notes.approved_test_fixture_count !== undefined) {
    const storedDigest = extra.approved_test_fixtures_sha256;
    const storedCount = extra.approved_test_fixture_count;
    if (
      typeof storedDigest !== "string"
      || !SHA256_HEX_RE.test(storedDigest)
      || !Number.isSafeInteger(storedCount)
      || storedCount !== notes.approved_test_fixture_count
      || storedDigest.slice(0, 12)
        !== notes.approved_test_fixtures_sha256_prefix
    ) {
      throw new Error("CrashFix step fixture binding does not match sealed provenance");
    }
  }
  if (notes.execution_profile !== undefined) {
    const storedProfile = extra.execution_profile
      ?? extra.requested_execution_profile;
    if (notes.execution_profile !== storedProfile) {
      throw new Error("CrashFix step execution profile does not match the session");
    }
  }
}
const indexArraySchema = z
  .array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))
  .max(MAX_REPRO_PATH_ENTRIES);
const storedCrashSchema = z
  .object({
    id: z.string().regex(/^c[1-9]\d*$/).max(MAX_SESSION_ID_CHARS),
    ts: rfc3339TimestampSchema,
    step_index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    signature: z.string().min(1).max(MAX_CRASH_SIGNATURE_CHARS),
    signature_version: crashSignatureVersionSchema.optional(),
    signature_degraded: z.boolean().optional(),
    cross_source_comparable: z.boolean().optional(),
    kind: z.string().min(1).max(MAX_CRASH_KIND_CHARS).optional(),
    stack_path: sessionRelativePathSchema,
    log_path: sessionRelativePathSchema.optional(),
    repro_path: indexArraySchema,
    minimized_repro_path: indexArraySchema.optional(),
    minimized_attempts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    minimized_confidence: z.enum(["low", "medium", "high"]).optional(),
    minimized_complete: z.boolean().optional(),
    source: crashSourceSchema.optional(),
  })
  .strict();

const WORKSPACE_ENV = "APP_TEST_CTRL_WORKSPACE";

export function resolveWorkspaceRoot(explicit?: string): string {
  if (explicit !== undefined) {
    if (
      typeof explicit !== "string"
      || explicit.length === 0
      || explicit.length > MAX_SESSION_PATH_CHARS
      || explicit.includes("\0")
      || !path.isAbsolute(explicit)
    ) {
      throw new TypeError("workspace_root must be a bounded absolute path");
    }
    return path.resolve(explicit);
  }
  const env = process.env[WORKSPACE_ENV];
  if (env) return path.resolve(env);
  // Default: cwd/workspace/sessions
  return path.resolve(process.cwd(), "workspace", "sessions");
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40) || "session";
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export interface CreatedSession {
  id: string;
  dir: string;
  meta_path: string;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function presentKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): string[] {
  return keys.filter((key) => hasOwn(record, key));
}

function assertNoStoredApprovedTestFixtureDetails(
  extra: Record<string, unknown>,
): void {
  const hasForbiddenFixtureDetails = Object.keys(extra).some(
    (key) =>
      key.startsWith("approved_test_fixture")
      && !APPROVED_TEST_FIXTURE_BINDING_KEYS.has(key),
  );
  if (hasForbiddenFixtureDetails) {
    throw new Error(
      "stored snapshot provenance must not contain approved fixture paths, entries, or content",
    );
  }
}

/**
 * Validate CrashFix's immutable provenance state before a session exists.
 * Other session types may continue to use arbitrary extra metadata, but any
 * provenance control field opts into this closed state machine.
 */
function assertInitialCrashfixProvenance(
  extra: Record<string, unknown> | undefined,
  sourceLock: RemoteSourceLock | undefined,
): void {
  if (extra === undefined) return;
  const hasStatus = hasOwn(extra, "provenance_status");
  const hasMode = hasOwn(extra, "provenance_mode");
  const initialResultFields = presentKeys(extra, INITIAL_PROVENANCE_RESULT_KEYS);
  if (!hasStatus) {
    // A session without CrashFix status can still be a devtest session with
    // generic commit/artifact metadata. Snapshot-specific identities, however,
    // must never exist without the closed CrashFix state.
    const unscopedSnapshotFields = presentKeys(extra, [
      ...SNAPSHOT_ONLY_EXTRA_KEYS,
      "source_ref_sha256",
      ...INITIAL_CRASHFIX_CONTROL_EXTRA_KEYS,
      ...CRASHFIX_TARGET_EXTRA_KEYS,
    ]);
    if (hasMode || unscopedSnapshotFields.length > 0) {
      throw new Error(
        "CrashFix provenance fields require provenance_status at session creation",
      );
    }
    return;
  }

  if (sourceLock === undefined) {
    throw new Error("CrashFix provenance requires an immutable Firebase source_lock");
  }
  assertClosedInitialCrashfixExtra(extra);
  const initialTargetFields = presentKeys(extra, CRASHFIX_TARGET_EXTRA_KEYS);
  if (initialTargetFields.length > 0) {
    throw new Error(
      "CrashFix target identity must be bound after session creation",
    );
  }
  remoteSourceLockSchema.parse(sourceLock);
  const status = crashfixProvenanceStatusSchema.parse(extra.provenance_status);
  assertCrashfixSourceLockMetadata(extra, sourceLock);
  if (hasOwn(extra, "requested_execution_profile")) {
    buildRunnerExecutionProfileSchema.parse(extra.requested_execution_profile);
  }
  if (hasOwn(extra, "workspace_project_classification")) {
    crashfixWorkspaceProjectClassificationSchema.parse(
      extra.workspace_project_classification,
    );
  }
  const requestedMode = hasOwn(extra, "requested_mode")
    ? crashfixRequestedModeSchema.parse(extra.requested_mode)
    : undefined;
  const requestedWorkflow = hasOwn(extra, "requested_workflow")
    ? crashfixRequestedWorkflowSchema.parse(extra.requested_workflow)
    : undefined;
  const preflightAbort = hasOwn(extra, "preflight_abort")
    ? crashfixPreflightAbortReasonSchema.parse(extra.preflight_abort)
    : undefined;
  if (requestedWorkflow !== undefined && requestedMode === undefined) {
    throw new Error("requested_workflow requires a closed requested_mode");
  }
  if (preflightAbort !== undefined && requestedMode === undefined) {
    throw new Error("preflight_abort requires a closed requested_mode");
  }
  if (
    requestedMode !== undefined
    && requestedMode !== "analyze"
    && !hasOwn(extra, "requested_execution_profile")
  ) {
    throw new Error(
      `requested_mode=${requestedMode} requires requested_execution_profile`,
    );
  }
  if (requestedWorkflow === "quick_test") {
    // Quick is intentionally a test-only, local-trusted edit path.  Keeping
    // these controls in the immutable session metadata prevents a caller
    // from silently turning a strict/production session into direct editing.
    if (requestedMode !== "analyze") {
      throw new Error(
        "requested_workflow=quick_test requires requested_mode=analyze",
      );
    }
    if (status !== "unavailable") {
      throw new Error(
        "requested_workflow=quick_test requires provenance_status=unavailable",
      );
    }
    if (extra.requested_execution_profile !== "local_trusted") {
      throw new Error(
        "requested_workflow=quick_test requires requested_execution_profile=local_trusted",
      );
    }
    if (extra.workspace_project_classification !== "test") {
      throw new Error(
        "requested_workflow=quick_test requires workspace_project_classification=test",
      );
    }
  }
  if (
    preflightAbort === "provenance_unavailable"
    && status !== "unavailable"
  ) {
    throw new Error(
      "preflight_abort=provenance_unavailable requires provenance_status=unavailable",
    );
  }
  if (status === "unavailable") {
    const contradictoryFields = [
      ...presentKeys(extra, GIT_ONLY_PROVENANCE_EXTRA_KEYS),
      ...initialResultFields,
      ...presentKeys(extra, ["provenance_explicit"]),
    ];
    if (hasMode || contradictoryFields.length > 0) {
      throw new Error(
        "unavailable provenance must omit provenance_mode and all local provenance fields",
      );
    }
    assertCrashfixPreflightMatrix({
      status,
      requestedMode,
      requestedWorkflow,
      preflightAbort,
    });
    return;
  }

  if (!hasMode) {
    throw new Error("resolved provenance requires provenance_mode");
  }
  const mode = crashfixProvenanceModeSchema.parse(extra.provenance_mode);
  if (
    hasOwn(extra, "provenance_explicit")
    && (extra.provenance_explicit !== true || mode !== "snapshot_repro_equivalent")
  ) {
    throw new Error(
      "provenance_explicit is only valid as true for snapshot_repro_equivalent",
    );
  }
  const forbiddenInitialFields = mode === "git_release_exact"
    ? initialResultFields
    : [
        ...presentKeys(extra, GIT_ONLY_PROVENANCE_EXTRA_KEYS),
        ...initialResultFields,
      ];
  if (forbiddenInitialFields.length > 0) {
    const label = mode === "git_release_exact"
      ? "git provenance must not contain derived provenance at session creation"
      : "snapshot provenance must be bound after session creation and omit Git identity";
    throw new Error(`${label}: ${forbiddenInitialFields.join(", ")}`);
  }

  assertCrashfixPreflightMatrix({
    status,
    provenanceMode: mode,
    requestedMode,
    requestedWorkflow,
    preflightAbort,
  });

}

/**
 * Keep Phase 0's abort reason as a closed function of the immutable request
 * and provenance identity. PR incompatibility takes precedence over the more
 * general unavailable-provenance rule, so unavailable+pr cannot select either
 * reason opportunistically.
 */
function assertCrashfixPreflightMatrix(input: {
  status: CrashfixProvenanceStatus;
  provenanceMode?: CrashfixProvenanceMode;
  requestedMode?: CrashfixRequestedMode;
  requestedWorkflow?: CrashfixRequestedWorkflow;
  preflightAbort?: z.infer<typeof crashfixPreflightAbortReasonSchema>;
}): void {
  const {
    status,
    provenanceMode,
    requestedMode,
    requestedWorkflow,
    preflightAbort,
  } = input;

  if ((requestedMode === undefined) !== (requestedWorkflow === undefined)) {
    throw new Error(
      "requested_mode and requested_workflow must be provided together",
    );
  }

  let expectedAbort: z.infer<typeof crashfixPreflightAbortReasonSchema> | undefined;
  const prProvenanceCompatible = status === "resolved"
    && provenanceMode === "git_release_exact";
  if (requestedMode === "pr" && !prProvenanceCompatible) {
    expectedAbort = "capability_mismatch";
  } else if (status === "unavailable" && requestedMode === "patch") {
    expectedAbort = "provenance_unavailable";
  }

  if (expectedAbort === undefined) {
    if (preflightAbort !== undefined) {
      throw new Error(
        "preflight_abort is not permitted for this CrashFix request/provenance state",
      );
    }
    return;
  }
  if (requestedWorkflow !== "strict") {
    throw new Error(
      `preflight_abort=${expectedAbort} requires requested_workflow=strict`,
    );
  }
  if (preflightAbort !== expectedAbort) {
    throw new Error(
      `CrashFix preflight requires preflight_abort=${expectedAbort}`,
    );
  }
}

/** Re-parse the immutable controls before any stored session can advance. */
function assertStoredCrashfixPreflightMatrix(
  extra: Record<string, unknown>,
): void {
  const status = crashfixProvenanceStatusSchema.parse(extra.provenance_status);
  const requestedMode = hasOwn(extra, "requested_mode")
    ? crashfixRequestedModeSchema.parse(extra.requested_mode)
    : undefined;
  const requestedWorkflow = hasOwn(extra, "requested_workflow")
    ? crashfixRequestedWorkflowSchema.parse(extra.requested_workflow)
    : undefined;
  const preflightAbort = hasOwn(extra, "preflight_abort")
    ? crashfixPreflightAbortReasonSchema.parse(extra.preflight_abort)
    : undefined;

  let provenanceMode: CrashfixProvenanceMode | undefined;
  if (status === "resolved") {
    provenanceMode = crashfixProvenanceModeSchema.parse(extra.provenance_mode);
  } else if (hasOwn(extra, "provenance_mode")) {
    throw new Error("unavailable CrashFix provenance must omit provenance_mode");
  }

  assertCrashfixPreflightMatrix({
    status,
    ...(provenanceMode === undefined ? {} : { provenanceMode }),
    requestedMode,
    requestedWorkflow,
    preflightAbort,
  });
}

/**
 * CrashFix metadata crosses a remote-evidence trust boundary. Keep its initial
 * extra object closed and scalar-only so tokens, raw events, credentials and
 * path-shaped diagnostics cannot be persisted through the generic devtest API.
 */
function assertClosedInitialCrashfixExtra(extra: Record<string, unknown>): void {
  if (Object.keys(extra).some((key) => !INITIAL_CRASHFIX_EXTRA_KEYS.has(key))) {
    throw new Error("CrashFix start_session.extra contains unsupported fields");
  }
  if (hasOwn(extra, "origin") && extra.origin !== "remote") {
    throw new Error("CrashFix extra.origin must be remote when present");
  }
  if (
    hasOwn(extra, "raw_evidence_archived")
    && extra.raw_evidence_archived !== false
  ) {
    throw new Error("CrashFix extra.raw_evidence_archived must be false");
  }
  for (const key of ["project_alias", "repo_alias"] as const) {
    if (
      hasOwn(extra, key)
      && (typeof extra[key] !== "string" || !CRASHFIX_SAFE_ALIAS_RE.test(extra[key]))
    ) {
      throw new Error(`CrashFix extra.${key} must be a bounded safe alias`);
    }
  }
  if (
    hasOwn(extra, "commit")
    && (typeof extra.commit !== "string" || !GIT_OBJECT_ID_RE.test(extra.commit))
  ) {
    throw new Error("CrashFix extra.commit must be a full lowercase Git object id");
  }
}

function childVerificationContextFromExtra(
  extra: Record<string, unknown> | undefined,
): ChildVerificationContext | undefined {
  if (extra === undefined) return undefined;
  const optedIn = presentKeys(extra, CHILD_VERIFICATION_CONTROL_EXTRA_KEYS);
  if (optedIn.length === 0) return undefined;
  const parsed = childVerificationContextSchema.safeParse({
    verification_schema_version: extra.verification_schema_version,
    verification_parent_session_id: extra.verification_parent_session_id,
    verification_run: extra.verification_run,
    artifact_sha256: extra.artifact_sha256,
    device_ref_sha256: extra.device_ref_sha256,
    plan_sha256: extra.plan_sha256,
    verification_target_signature_version:
      extra.verification_target_signature_version,
    verification_target_fingerprint: extra.verification_target_fingerprint,
    platform: extra.platform,
    type: extra.type,
  });
  if (!parsed.success) {
    throw new Error(
      "verification child context is partial or invalid; all v1 identity fields are required",
    );
  }
  return parsed.data;
}

function assertCrashfixSourceLockMetadata(
  extra: Record<string, unknown>,
  sourceLock: RemoteSourceLock,
): void {
  if (hasOwn(extra, "provider") && extra.provider !== sourceLock.provider) {
    throw new Error("CrashFix extra.provider does not match source_lock");
  }
  if (
    hasOwn(extra, "acquisition_route")
    && extra.acquisition_route !== sourceLock.acquisition_route
  ) {
    throw new Error("CrashFix extra.acquisition_route does not match source_lock");
  }
  if (hasOwn(extra, "source_locked") && extra.source_locked !== true) {
    throw new Error("CrashFix extra.source_locked must be true when present");
  }
  if (sourceLock.acquisition_route === "official_firebase_mcp") {
    if (!hasOwn(extra, "firebase_access")) {
      throw new Error(
        "official_firebase_mcp CrashFix sessions require extra.firebase_access",
      );
    }
    const parsed = crashfixFirebaseAccessSchema.safeParse(extra.firebase_access);
    if (!parsed.success) {
      throw new Error(
        "CrashFix extra.firebase_access must be service-account or firebaserc",
      );
    }
    return;
  }
  if (hasOwn(extra, "firebase_access")) {
    throw new Error(
      "cloud_logging_mcp CrashFix sessions must omit extra.firebase_access",
    );
  }
}

export async function createSession(opts: {
  name: string;
  workspaceRoot?: string;
  sourceLock?: RemoteSourceLock;
  reportLanguage?: ReportLanguage;
  extra?: Record<string, unknown>;
}): Promise<CreatedSession> {
  const name = sessionNameSchema.parse(opts.name);
  const reportLanguage = reportLanguageSchema.parse(
    opts.reportLanguage ?? DEFAULT_REPORT_LANGUAGE,
  );
  const parsedExtra = opts.extra === undefined
    ? undefined
    : sessionExtraSchema.parse(opts.extra);
  // New CrashFix callers select one of the two workflow tiers.  Older clients
  // already send requested_mode but predate requested_workflow; fail them into
  // the more restrictive strict tier instead of leaving an unaudited third
  // state.  quick_test is never inferred because it requires an explicit
  // user-confirmed test classification and direct-worktree risk acceptance.
  const extra = parsedExtra !== undefined
    && hasOwn(parsedExtra, "provenance_status")
    && hasOwn(parsedExtra, "requested_mode")
    && !hasOwn(parsedExtra, "requested_workflow")
    ? { ...parsedExtra, requested_workflow: "strict" }
    : parsedExtra;
  const sourceLock = opts.sourceLock === undefined
    ? undefined
    : remoteSourceLockSchema.parse(opts.sourceLock);
  assertInitialCrashfixProvenance(extra, sourceLock);
  assertCrashfixSessionName(name, extra);
  childVerificationContextFromExtra(extra);
  const root = resolveWorkspaceRoot(opts.workspaceRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("workspace root must be a real directory, not a symlink");
  }
  // The workspace is dedicated to report sessions. Restrict existing roots as
  // well as newly created ones so session names cannot leak to local users.
  await chmod(root, 0o700);
  const id = `${timestamp()}_${sanitizeName(name)}_${randomUUID().slice(0, 8)}`;
  const dir = path.join(root, id);
  const meta: SessionMeta = {
    id,
    name,
    started_at: new Date().toISOString(),
    status: "running",
    report_language: reportLanguage,
    ...(sourceLock !== undefined ? { source_lock: sourceLock } : {}),
    ...(extra !== undefined ? { extra } : {}),
  };
  const serializedMeta = serializeSessionMeta(meta);
  await mkdir(dir, { mode: 0o700 });
  await mkdir(path.join(dir, "steps"), { mode: 0o700 });
  await mkdir(path.join(dir, "crashes"), { mode: 0o700 });
  await mkdir(path.join(dir, "logs"), { mode: 0o700 });
  const metaPath = path.join(dir, "meta.json");
  await writeFile(metaPath, serializedMeta, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(path.join(dir, "steps.jsonl"), "", { flag: "wx", mode: 0o600 });
  await writeFile(path.join(dir, "crashes.jsonl"), "", { flag: "wx", mode: 0o600 });
  return { id, dir, meta_path: metaPath };
}

/** Copy one regular evidence file without following its final symlink. */
export async function copyRegularFilePrivate(
  source: string,
  destination: string,
  maxBytes: number,
  options: {
    /** Optional checkpoint used by callers that must coordinate source quiescence. */
    onSourceValidated?: () => void | Promise<void>;
  } = {},
): Promise<number> {
  if (!path.isAbsolute(source) || source.includes("\0")) {
    throw new TypeError("evidence source must be an absolute path");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("evidence byte limit must be a positive safe integer");
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const sourceHandle = await open(
    source,
    fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | noFollow,
  );
  let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
  let destinationCreated = false;
  try {
    const before = await sourceHandle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      throw new Error("evidence source must be a single-link regular file");
    }
    if (before.size > BigInt(maxBytes)) {
      throw new RangeError(`evidence source exceeds ${maxBytes} byte size limit`);
    }
    destinationHandle = await open(
      destination,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    destinationCreated = true;
    await options.onSourceValidated?.();
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new RangeError(`evidence source exceeds ${maxBytes} byte size limit`);
      }
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          null,
        );
        if (result.bytesWritten <= 0) {
          throw new Error("evidence destination write made no progress");
        }
        written += result.bytesWritten;
      }
    }
    const after = await sourceHandle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || BigInt(total) !== before.size
    ) {
      throw new Error("evidence source changed while it was being copied");
    }
    const destinationMetadata = await destinationHandle.stat({ bigint: true });
    if (
      !destinationMetadata.isFile()
      || destinationMetadata.nlink !== 1n
      || destinationMetadata.size !== BigInt(total)
    ) {
      throw new Error("evidence destination failed its size and file-type check");
    }
    await destinationHandle.sync();
    return total;
  } catch (error) {
    await destinationHandle?.close().catch(() => undefined);
    destinationHandle = undefined;
    if (destinationCreated) {
      await unlink(destination).catch(() => undefined);
    }
    throw error;
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle.close().catch(() => undefined);
  }
}

export async function loadMeta(sessionDir: string): Promise<SessionMeta> {
  assertSessionDir(sessionDir);
  const text = await readBoundedRegularTextFile(
    sessionDir,
    "meta.json",
    MAX_SESSION_META_BYTES,
    "session meta.json",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("session meta.json is invalid JSON");
  }
  const result = storedSessionMetaSchema.safeParse(parsed);
  if (!result.success) {
    throw new TypeError(`session meta.json is invalid: ${result.error.message}`);
  }
  return result.data;
}

export async function writeMeta(sessionDir: string, meta: SessionMeta): Promise<void> {
  const metaPath = path.join(sessionDir, "meta.json");
  const temporaryPath = path.join(
    sessionDir,
    `.meta.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, serializeSessionMeta(meta), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, metaPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function serializeSessionMeta(meta: SessionMeta): string {
  const parsed = storedSessionMetaSchema.parse(meta);
  let serialized: string;
  try {
    serialized = JSON.stringify(parsed, null, 2);
  } catch {
    throw new TypeError("session metadata must be JSON-serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_SESSION_META_BYTES) {
    throw new RangeError(
      `session meta.json exceeds ${MAX_SESSION_META_BYTES} byte size limit`,
    );
  }
  return serialized;
}

export async function writePrivateTextFile(
  directory: string,
  filename: string,
  content: string,
): Promise<string> {
  if (path.basename(filename) !== filename || !/^[a-zA-Z0-9._-]+$/.test(filename)) {
    throw new TypeError("private text filename is invalid");
  }
  const finalPath = path.join(directory, filename);
  const temporaryPath = path.join(
    directory,
    `.${filename}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, finalPath);
    return finalPath;
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export function resolveSessionDir(opts: {
  workspaceRoot?: string;
  sessionId?: string;
  sessionDir?: string;
}): string {
  const hasSessionId = opts.sessionId !== undefined;
  const hasSessionDir = opts.sessionDir !== undefined;
  if (Number(hasSessionId) + Number(hasSessionDir) !== 1) {
    throw new Error("exactly one of session_id or session_dir is required");
  }
  if (hasSessionDir) {
    if (opts.workspaceRoot !== undefined) {
      throw new Error("workspace_root is only valid with session_id");
    }
    const sessionDir = opts.sessionDir!;
    if (
      typeof sessionDir !== "string"
      || sessionDir.length === 0
      || sessionDir.length > MAX_SESSION_PATH_CHARS
      || sessionDir.includes("\0")
      || !path.isAbsolute(sessionDir)
    ) {
      throw new TypeError("session_dir must be a bounded absolute path");
    }
    return path.resolve(sessionDir);
  }
  const sessionId = sessionIdReferenceSchema.parse(opts.sessionId);
  return path.join(resolveWorkspaceRoot(opts.workspaceRoot), sessionId);
}

export async function appendStep(
  sessionDir: string,
  step: StepRecord,
): Promise<void> {
  const validated = storedStepSchema.parse(step);
  const meta = await loadMeta(sessionDir);
  assertCrashfixStepEvidence(meta, {
    action: validated.action,
    ...(validated.notes !== undefined ? { notes: validated.notes } : {}),
    has_screenshot: validated.screenshot !== undefined,
    has_log_excerpt: validated.log_excerpt !== undefined,
  });
  await appendJsonlRecord(sessionDir, "steps.jsonl", validated);
}

async function appendCrash(
  sessionDir: string,
  crash: CrashRecord,
): Promise<void> {
  const validated = storedCrashSchema.parse(crash);
  const signatureVersion = validated.signature_version === undefined
    ? undefined
    : crashSignatureVersionSchema.parse(validated.signature_version);
  assertVersionedAnalyzerFingerprint(validated.signature, signatureVersion);
  if (validated.source !== undefined) {
    validateCrashSourceExternalKey(
      validated.source,
      validated.signature,
      signatureVersion,
    );
  }
  await appendJsonlRecord(sessionDir, "crashes.jsonl", validated);
}

async function appendJsonlRecord(
  sessionDir: string,
  filename: "steps.jsonl" | "crashes.jsonl",
  record: unknown,
): Promise<void> {
  assertSessionDir(sessionDir);
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  const filePath = path.join(sessionDir, filename);
  const flags = fsConstants.O_WRONLY
    | fsConstants.O_APPEND
    | (fsConstants.O_NONBLOCK ?? 0)
    | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(filePath, flags);
  try {
    const before = await handle.stat({ bigint: true });
    const pathBefore = await lstat(filePath, { bigint: true });
    if (
      !before.isFile()
      || before.nlink !== 1n
      || !pathBefore.isFile()
      || pathBefore.isSymbolicLink()
      || pathBefore.nlink !== 1n
      || before.dev !== pathBefore.dev
      || before.ino !== pathBefore.ino
    ) {
      throw new Error(`${filename} must be a single-link regular file`);
    }
    const expectedSize = before.size + BigInt(bytes.byteLength);
    if (expectedSize > BigInt(MAX_SESSION_JSONL_BYTES)) {
      throw new RangeError(
        `${filename} exceeds ${MAX_SESSION_JSONL_BYTES} byte size limit`,
      );
    }

    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (bytesWritten <= 0) {
        throw new Error(`${filename} append made no progress`);
      }
      offset += bytesWritten;
    }
    await handle.sync();

    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(filePath, { bigint: true });
    if (
      !after.isFile()
      || after.nlink !== 1n
      || !pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || pathAfter.nlink !== 1n
      || before.dev !== after.dev
      || before.ino !== after.ino
      || after.dev !== pathAfter.dev
      || after.ino !== pathAfter.ino
      || after.size !== expectedSize
    ) {
      throw new Error(`${filename} changed while a record was being appended`);
    }
  } finally {
    await handle.close();
  }
}

export async function readSteps(sessionDir: string): Promise<StepRecord[]> {
  const steps = await readBoundedJsonl(
    sessionDir,
    "steps.jsonl",
    MAX_STEPS_PER_SESSION,
    (value, line, position) => {
      const parsed = storedStepSchema.safeParse(value);
      if (!parsed.success) {
        throw new TypeError(`steps.jsonl line ${line} is invalid: ${parsed.error.message}`);
      }
      if (parsed.data.index !== position + 1) {
        throw new Error("steps.jsonl indexes must be contiguous and ordered from 1");
      }
      return parsed.data;
    },
  );
  const meta = await loadMeta(sessionDir);
  for (const step of steps) {
    assertCrashfixStepEvidence(meta, {
      action: step.action,
      ...(step.notes !== undefined ? { notes: step.notes } : {}),
      has_screenshot: step.screenshot !== undefined,
      has_log_excerpt: step.log_excerpt !== undefined,
    });
  }
  return steps;
}

export async function readCrashes(sessionDir: string): Promise<CrashRecord[]> {
  return readBoundedJsonl(
    sessionDir,
    "crashes.jsonl",
    MAX_CRASHES_PER_SESSION,
    (value, line, position) => {
      const parsed = storedCrashSchema.safeParse(value);
      if (!parsed.success) {
        throw new TypeError(`crashes.jsonl line ${line} is invalid: ${parsed.error.message}`);
      }
      const record = parsed.data;
      const expectedId = `c${position + 1}`;
      if (record.id !== expectedId) {
        throw new Error(`crashes.jsonl ids must be contiguous; expected ${expectedId}`);
      }
      if (record.stack_path !== `crashes/${record.id}.stack.txt`) {
        throw new Error("crash stack_path does not match its immutable crash id");
      }
      if (
        record.log_path !== undefined
        && record.log_path !== `crashes/${record.id}.log`
      ) {
        throw new Error("crash log_path does not match its immutable crash id");
      }
      assertVersionedAnalyzerFingerprint(record.signature, record.signature_version);
      const source = record.source === undefined
        ? undefined
        : validateCrashSourceExternalKey(
          record.source,
          record.signature,
          record.signature_version,
          { allowLegacyFirebaseKeyWithoutVersion: true },
        );
      return {
        ...record,
        ...(source !== undefined ? { source } : {}),
      };
    },
  );
}

async function readBoundedJsonl<T>(
  sessionDir: string,
  filename: "steps.jsonl" | "crashes.jsonl",
  maxRecords: number,
  validate: (value: unknown, line: number, position: number) => T,
): Promise<T[]> {
  assertSessionDir(sessionDir);
  const filePath = path.join(sessionDir, filename);
  const flags = fsConstants.O_RDONLY
    | (fsConstants.O_NONBLOCK ?? 0)
    | (fsConstants.O_NOFOLLOW ?? 0);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, flags);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new Error(`session ${filename} is missing or was removed during access`);
    }
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    const pathBefore = await lstat(filePath, { bigint: true });
    if (
      !before.isFile()
      || before.nlink !== 1n
      || !pathBefore.isFile()
      || pathBefore.isSymbolicLink()
      || pathBefore.nlink !== 1n
      || before.dev !== pathBefore.dev
      || before.ino !== pathBefore.ino
    ) {
      throw new Error(`${filename} must be a single-link regular file`);
    }
    if (before.size > BigInt(MAX_SESSION_JSONL_BYTES)) {
      throw new RangeError(
        `${filename} exceeds ${MAX_SESSION_JSONL_BYTES} byte size limit`,
      );
    }
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > MAX_SESSION_JSONL_BYTES) {
        throw new RangeError(
          `${filename} exceeds ${MAX_SESSION_JSONL_BYTES} byte size limit`,
        );
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(filePath, { bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || !pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || pathAfter.nlink !== 1n
      || after.dev !== pathAfter.dev
      || after.ino !== pathAfter.ino
    ) {
      throw new Error(`${filename} changed while it was being read`);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
    } catch {
      throw new Error(`${filename} is not valid UTF-8`);
    }
    const physicalLines = text.split("\n");
    if (physicalLines.length > MAX_JSONL_PHYSICAL_LINES + 1) {
      throw new RangeError(
        `${filename} exceeds ${MAX_JSONL_PHYSICAL_LINES} physical line limit`,
      );
    }
    const records: T[] = [];
    for (const [lineIndex, line] of physicalLines.entries()) {
      if (line.length === 0) continue;
      if (line.trim().length === 0) {
        throw new Error(`${filename} line ${lineIndex + 1} must not be whitespace-only`);
      }
      if (records.length >= maxRecords) {
        throw new RangeError(`${filename} exceeds ${maxRecords} record limit`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`${filename} line ${lineIndex + 1} is invalid JSON`);
      }
      records.push(validate(parsed, lineIndex + 1, records.length));
    }
    return records;
  } finally {
    await handle.close();
  }
}

async function readCrashStackAndVerifyIdentity(
  sessionDir: string,
  crash: CrashRecord,
): Promise<string> {
  if (crash.signature_version === undefined) {
    throw new Error("CrashFix remote evidence is missing signature_version");
  }
  const stack = await readBoundedRegularTextFile(
    sessionDir,
    crash.stack_path,
    MAX_CRASH_STACK_BYTES,
    "CrashFix crash stack",
  );
  assertCanonicalAnalyzerIdentity(stack, {
    signature: crash.signature,
    signature_version: crash.signature_version,
    kind: crash.kind,
  });
  return createHash("sha256").update(stack, "utf8").digest("hex");
}

export interface BoundedTextReadOptions {
  /**
   * Test/coordination checkpoint invoked only after the opened file and its
   * path have passed their initial identity, type, link-count, and size
   * checks. The reader still verifies the identity again after all bytes are
   * consumed, so a mutation here must fail closed.
   */
  onFileValidated?: () => void | Promise<void>;
}

export async function readBoundedRegularTextFile(
  sessionDir: string,
  relativePath: string,
  maxBytes: number,
  label: string,
  options: BoundedTextReadOptions = {},
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("text byte limit must be a positive safe integer");
  }
  sessionRelativePathSchema.parse(relativePath);
  const root = await realpath(path.resolve(sessionDir));
  const filePath = path.resolve(root, relativePath);
  const relative = path.relative(root, filePath);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must stay inside session_dir`);
  }
  const initialPathMetadata = await lstat(filePath, { bigint: true });
  if (initialPathMetadata.isSymbolicLink()) {
    throw new Error(`${label} must not contain symbolic links`);
  }
  if (
    !initialPathMetadata.isFile()
    || initialPathMetadata.nlink !== 1n
  ) {
    throw new Error(`${label} must be a single-link regular file`);
  }
  const canonicalPath = await realpath(filePath);
  if (canonicalPath !== filePath) {
    throw new Error(`${label} must not contain symbolic links`);
  }
  const flags = fsConstants.O_RDONLY
    | (fsConstants.O_NONBLOCK ?? 0)
    | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(filePath, flags);
  try {
    const before = await handle.stat({ bigint: true });
    const pathBefore = await lstat(filePath, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      throw new Error(`${label} must be a single-link regular file`);
    }
    if (
      !pathBefore.isFile()
      || pathBefore.isSymbolicLink()
      || pathBefore.nlink !== 1n
      || before.dev !== pathBefore.dev
      || before.ino !== pathBefore.ino
    ) {
      throw new Error(`${label} changed while it was being opened`);
    }
    if (before.size > BigInt(maxBytes)) {
      throw new RangeError(`${label} exceeds ${maxBytes} byte size limit`);
    }
    await options.onFileValidated?.();
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > maxBytes) {
        throw new RangeError(`${label} exceeds ${maxBytes} byte size limit`);
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await handle.stat({ bigint: true });
    const afterCanonicalPath = await realpath(filePath);
    const pathAfter = await lstat(filePath, { bigint: true });
    if (
      afterCanonicalPath !== filePath
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || BigInt(bytes) !== before.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || !pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || pathAfter.nlink !== 1n
      || after.dev !== pathAfter.dev
      || after.ino !== pathAfter.ino
    ) {
      throw new Error(`${label} changed while it was being read`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true })
        .decode(Buffer.concat(chunks, bytes));
    } catch {
      throw new Error(`${label} is not valid UTF-8`);
    }
  } finally {
    await handle.close();
  }
}

export interface CrashEvidenceInput {
  signature: string;
  signature_version?: CrashSignatureVersion;
  signature_degraded?: boolean;
  cross_source_comparable?: boolean;
  stack: string;
  kind?: string;
  step_index?: number;
  repro_path: number[];
  log_full_src?: string;
  source?: CrashSource;
  acquisition_route?: CrashAcquisitionRoute;
}

export interface CrashEvidenceResult {
  crash: CrashRecord;
  /** True means the existing record with this external_key was returned. */
  deduplicated: boolean;
}

export interface CrashfixTargetResult {
  deduplicated: boolean;
  target_bound: true;
  target_ref_sha256_prefix: string;
  target_app_build_ref_sha256_prefix: string;
}

export interface CrashfixAnalysisResult {
  deduplicated: boolean;
  analysis_recorded: true;
  schema_version: typeof CRASHFIX_ANALYSIS_SCHEMA_VERSION;
  target_signature_version: CrashSignatureVersion;
  target_fingerprint: string;
  confidence: CrashfixAnalysis["confidence"];
  category: CrashfixAnalysis["category"];
  location_count: number;
  limitation_count: number;
}

export interface SnapshotProvenanceResult {
  deduplicated: boolean;
  source_snapshot_sha256_prefix: string;
  exclusion_policy_sha256_prefix: string;
  dynamic_exclusions_sha256_prefix: string;
  approved_test_fixtures_sha256_prefix: string;
  approved_test_fixture_count: number;
  files: number;
  directories: number;
  bytes: number;
}

export interface CandidateBuildProvenanceResult {
  stage: "candidate";
  deduplicated: boolean;
  candidate_bound: true;
  baseline_artifact_sha256_prefix: string;
  artifact_sha256_prefix: string;
  build_environment_sha256_prefix: string;
  execution_profile: BuildRunnerExecutionProfile;
  strong_isolation: boolean;
  workspace_disk_quota_enforced: boolean;
  network_policy: BuildRunnerNetworkPolicy;
  filesystem_write_isolation: BuildRunnerFilesystemWriteIsolation;
  secret_filesystem_isolation: BuildRunnerSecretFilesystemIsolation;
  process_containment: BuildRunnerProcessContainment;
  canonical_diff_sha256_prefix: string;
  candidate_manifest_sha256_prefix: string;
  workspace_canonical_diff_sha256_prefix: string;
  workspace_manifest_sha256_prefix: string;
  workspace_role: "candidate";
  artifact_signing_identity_ref_sha256_prefix: string;
  changed_files: string[];
  artifact_platform: "android" | "ios";
  artifact_app_id: string;
  artifact_version: string;
  artifact_build: string;
  artifact_variant: string;
  variant_source: "task-bound";
  variant_artifact_derived: false;
}

export interface CandidateVerificationProvenanceResult {
  stage: "verification";
  deduplicated: boolean;
  candidate_bound: true;
  verified: true;
  verification_runs: 3;
  artifact_sha256_prefix: string;
  device_ref_sha256_prefix: string;
  plan_sha256_prefix: string;
  target_signature_version: CrashSignatureVersion;
  target_fingerprint: string;
  child_session_ref_sha256_prefixes: [string, string, string];
}

export interface CandidateExportProvenanceResult {
  stage: "export";
  deduplicated: boolean;
  candidate_bound: true;
  verified: true;
  verification_runs: 3;
  exported: true;
  canonical_diff_sha256_prefix: string;
  candidate_manifest_sha256_prefix: string;
  destination_ref_sha256_prefix: string;
}

export type CandidateProvenanceResult =
  | CandidateBuildProvenanceResult
  | CandidateVerificationProvenanceResult
  | CandidateExportProvenanceResult;

export interface SessionLockOptions {
  /** Hard upper bound for waiting on a lock owned by another process. */
  timeoutMs?: number;
  /** Poll interval. Exposed for deterministic tests; production uses 25 ms. */
  retryMs?: number;
}

export interface FinalizeSessionContext {
  meta: SessionMeta;
  steps: StepRecord[];
  crashes: CrashRecord[];
  /** True when this exact terminal status had already been persisted. */
  already_finalized: boolean;
}

export interface FinalizeSessionOptions {
  /** Required when a verification child context is finalized as passed. */
  verificationEvidence?: ChildVerificationCompletion;
}

interface AcquiredSessionLock {
  lockDir: string;
  ownerPath: string;
  token: string;
}

/**
 * Bind the user-selected Firebase app/issue/build before any remote event is
 * archived. Only domain-separated hashes are persisted, so later evidence and
 * build artifacts can be checked without copying raw target identifiers into
 * session metadata or public reports.
 */
export async function recordCrashfixTarget(
  sessionDir: string,
  rawTarget: CrashfixTarget,
): Promise<CrashfixTargetResult> {
  assertSessionDir(sessionDir);
  const target = crashfixTargetSchema.parse(rawTarget);
  const binding = crashfixTargetBinding(target);

  return withSessionLock(sessionDir, async () => {
    const meta = await loadMeta(sessionDir);
    assertKnownSessionStatus(meta.status);
    if (meta.status !== "running") {
      throw new Error(
        `cannot bind CrashFix target: session is not running (status=${meta.status})`,
      );
    }
    const extra = meta.extra;
    if (extra?.provenance_status === undefined) {
      throw new Error("CrashFix target binding requires a CrashFix session");
    }
    assertStoredCrashfixPreflightMatrix(extra);
    if (hasOwn(extra, "preflight_abort")) {
      crashfixPreflightAbortReasonSchema.parse(extra.preflight_abort);
      throw new Error("CrashFix target binding is forbidden after a preflight abort");
    }
    if (meta.source_lock === undefined) {
      throw new Error("CrashFix target binding requires an immutable Firebase source_lock");
    }
    const sourceLock = remoteSourceLockSchema.parse(meta.source_lock);
    assertCrashfixSourceLockMetadata(extra, sourceLock);
    assertCrashfixPublicAliasesOmitSourceIdentifiers(meta, [
      target.project,
      target.app,
      target.issue,
    ]);

    const existingKeys = presentKeys(extra, CRASHFIX_TARGET_EXTRA_KEYS);
    if (existingKeys.length !== 0 && existingKeys.length !== CRASHFIX_TARGET_EXTRA_KEYS.length) {
      throw new Error("stored CrashFix target binding is partial and cannot be repaired in place");
    }
    if (existingKeys.length === CRASHFIX_TARGET_EXTRA_KEYS.length) {
      const existing = requireBoundCrashfixTarget(extra);
      if (!sameCrashfixTargetBinding(existing, binding)) {
        throw new Error("CrashFix target is already bound to a different identity");
      }
      return publicCrashfixTargetResult(binding, true);
    }
    if ((await readCrashes(sessionDir)).length !== 0) {
      throw new Error("CrashFix target must be bound before any crash evidence");
    }

    meta.extra = { ...extra, ...binding };
    await writeMeta(sessionDir, meta);
    return publicCrashfixTargetResult(binding, false);
  });
}

function crashfixTargetBinding(target: CrashfixTarget): StoredCrashfixTargetBinding {
  return storedCrashfixTargetBindingSchema.parse({
    crashfix_target_schema_version: "crashfix-target/v1",
    crashfix_target_ref_sha256: hashCrashfixIdentity(
      "crashfix-target/v1",
      [
        FIREBASE_CRASHLYTICS_PROVIDER,
        target.project,
        target.app,
        target.issue,
        target.app_build.platform,
        target.app_build.app_id,
        target.app_build.version,
        target.app_build.build,
      ],
    ),
    crashfix_target_app_build_ref_sha256: hashCrashfixIdentity(
      "crashfix-app-build/v1",
      [
        target.app_build.platform,
        target.app_build.app_id,
        target.app_build.version,
        target.app_build.build,
      ],
    ),
  });
}

function hashCrashfixIdentity(domain: string, fields: readonly string[]): string {
  return createHash("sha256")
    .update([domain, ...fields].join("\0"), "utf8")
    .digest("hex");
}

function requireBoundCrashfixTarget(
  extra: Record<string, unknown>,
): StoredCrashfixTargetBinding {
  const keys = presentKeys(extra, CRASHFIX_TARGET_EXTRA_KEYS);
  if (keys.length === 0) {
    throw new Error("CrashFix session requires a target binding before crash evidence");
  }
  if (keys.length !== CRASHFIX_TARGET_EXTRA_KEYS.length) {
    throw new Error("stored CrashFix target binding is partial");
  }
  const parsed = storedCrashfixTargetBindingSchema.safeParse({
    crashfix_target_schema_version: extra.crashfix_target_schema_version,
    crashfix_target_ref_sha256: extra.crashfix_target_ref_sha256,
    crashfix_target_app_build_ref_sha256:
      extra.crashfix_target_app_build_ref_sha256,
  });
  if (!parsed.success) throw new Error("stored CrashFix target binding is invalid");
  return parsed.data;
}

function sameCrashfixTargetBinding(
  left: StoredCrashfixTargetBinding,
  right: StoredCrashfixTargetBinding,
): boolean {
  return CRASHFIX_TARGET_EXTRA_KEYS.every((key) => left[key] === right[key]);
}

function publicCrashfixTargetResult(
  binding: StoredCrashfixTargetBinding,
  deduplicated: boolean,
): CrashfixTargetResult {
  return {
    deduplicated,
    target_bound: true,
    target_ref_sha256_prefix: binding.crashfix_target_ref_sha256.slice(0, 12),
    target_app_build_ref_sha256_prefix:
      binding.crashfix_target_app_build_ref_sha256.slice(0, 12),
  };
}

function assertCrashSourceMatchesBoundTarget(
  source: CrashSource,
  binding: StoredCrashfixTargetBinding,
): void {
  if (
    source.provider !== FIREBASE_CRASHLYTICS_PROVIDER
    || source.project === undefined
    || source.app === undefined
    || source.issue === undefined
    || source.app_build === undefined
  ) {
    throw new Error("CrashFix target comparison requires normalized Firebase evidence");
  }
  const actual = crashfixTargetBinding({
    project: source.project,
    app: source.app,
    issue: source.issue,
    app_build: source.app_build,
  });
  if (!sameCrashfixTargetBinding(actual, binding)) {
    throw new Error("Firebase crash evidence does not match the bound CrashFix target");
  }
}

function assertCandidateMatchesBoundTarget(
  candidate: CandidateBuildProvenance,
  binding: StoredCrashfixTargetBinding,
): void {
  const candidateAppBuildRef = hashCrashfixIdentity(
    "crashfix-app-build/v1",
    [
      candidate.artifact_platform,
      candidate.artifact_app_id,
      candidate.artifact_version,
      candidate.artifact_build,
    ],
  );
  if (candidateAppBuildRef !== binding.crashfix_target_app_build_ref_sha256) {
    throw new Error("candidate artifact identity does not match the bound CrashFix target");
  }
}

function sameCrashfixAnalysis(
  left: StoredCrashfixAnalysis,
  right: StoredCrashfixAnalysis,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function publicCrashfixAnalysisResult(
  analysis: CrashfixAnalysis,
  deduplicated: boolean,
): CrashfixAnalysisResult {
  return {
    deduplicated,
    analysis_recorded: true,
    schema_version: CRASHFIX_ANALYSIS_SCHEMA_VERSION,
    target_signature_version: analysis.target_signature_version,
    target_fingerprint: analysis.target_fingerprint,
    confidence: analysis.confidence,
    category: analysis.category,
    location_count: analysis.locations.length,
    limitation_count: analysis.limitations.length,
  };
}

function assertCrashfixAnalysisIdentity(
  analysis: CrashfixAnalysis,
  target: ArchivedFirebaseTarget,
): void {
  if (
    analysis.target_signature_version !== target.signatureVersion
    || analysis.target_fingerprint !== target.fingerprint
  ) {
    throw new Error(
      "CrashFix analysis identity does not match the archived analyzer identity",
    );
  }
}

function assertCrashfixAnalysisLocationProvenance(
  analysis: CrashfixAnalysis,
  extra: Record<string, unknown>,
): void {
  if (analysis.locations.length === 0) return;
  if (extra.provenance_status !== "resolved") {
    throw new Error(
      "unavailable CrashFix provenance requires empty analysis locations",
    );
  }
  const mode = crashfixProvenanceModeSchema.parse(extra.provenance_mode);
  if (mode === "snapshot_repro_equivalent") {
    requireStoredSnapshotProvenance(extra);
    return;
  }
  if (typeof extra.commit !== "string" || !GIT_OBJECT_ID_RE.test(extra.commit)) {
    throw new Error(
      "Git-backed analysis locations require an immutable source commit identity",
    );
  }
}

function assertCrashfixAnalysisOmitsSourceIdentifiers(
  analysis: CrashfixAnalysis,
  sourceIdentifiers: readonly string[],
): void {
  const publicText = [
    analysis.root_cause_summary,
    analysis.remediation_summary,
    ...analysis.limitations,
    ...analysis.locations.flatMap((location) => [
      location.path,
      ...(location.symbol === undefined ? [] : [location.symbol]),
    ]),
  ];
  for (const identifier of sourceIdentifiers) {
    const repeatsIdentifier = publicText.some((value) =>
      publicTextContainsSourceIdentifier(value, identifier)
    );
    if (identifier.length > 0 && repeatsIdentifier) {
      throw new Error(
        "CrashFix analysis must not repeat Firebase target or event identifiers",
      );
    }
  }
}

/**
 * Recheck the report-safe analysis against the current in-memory session
 * records. Renderers call this even for data loaded outside the normal MCP
 * lifecycle, so a copied or tampered analysis cannot be shown under another
 * target or analyzer identity.
 */
export function assertCrashfixAnalysisForReport(
  meta: SessionMeta,
  crashes: readonly CrashRecord[],
): void {
  if (meta.crashfix_analysis === undefined) return;
  const analysis = storedCrashfixAnalysisSchema.parse(meta.crashfix_analysis);
  if (!isCrashfixSessionMeta(meta) || meta.extra === undefined) {
    throw new Error("crashfix_analysis requires a CrashFix session");
  }
  const extra = meta.extra;
  const provenanceStatus = crashfixProvenanceStatusSchema.parse(
    extra.provenance_status,
  );
  if (meta.source_lock === undefined) {
    throw new Error("CrashFix analysis requires an immutable Firebase source_lock");
  }
  assertCrashfixSourceLockMetadata(
    extra,
    remoteSourceLockSchema.parse(meta.source_lock),
  );
  const boundTarget = requireBoundCrashfixTarget(extra);
  if (provenanceStatus === "unavailable" && analysis.locations.length !== 0) {
    throw new Error(
      "unavailable CrashFix provenance requires empty analysis locations",
    );
  }
  assertCrashfixAnalysisLocationProvenance(analysis, extra);
  if (crashes.length === 0) {
    throw new Error("CrashFix analysis requires archived Firebase crash evidence");
  }
  const sourceIdentifiers: string[] = [];
  for (const crash of crashes) {
    if (
      crash.source?.provider !== FIREBASE_CRASHLYTICS_PROVIDER
      || crash.source.app_build === undefined
      || crash.signature_version === undefined
    ) {
      throw new Error(
        "CrashFix analysis requires normalized Firebase analyzer evidence",
      );
    }
    assertCrashSourceMatchesBoundTarget(crash.source, boundTarget);
    for (const identifier of [
      crash.source.project,
      crash.source.app,
      crash.source.issue,
      crash.source.event,
    ]) {
      if (identifier !== undefined && !sourceIdentifiers.includes(identifier)) {
        sourceIdentifiers.push(identifier);
      }
    }
    if (
      crash.signature_version !== analysis.target_signature_version
      || crash.signature !== analysis.target_fingerprint
    ) {
      throw new Error(
        "CrashFix analysis does not match every archived analyzer identity",
      );
    }
  }
  assertCrashfixPublicAliasesOmitSourceIdentifiers(meta, sourceIdentifiers);
  assertCrashfixAnalysisOmitsSourceIdentifiers(analysis, sourceIdentifiers);
}

/**
 * Full storage-backed revalidation used before finalize/regenerate. In
 * addition to the renderer checks, this recomputes each canonical analyzer
 * identity from its private archived stack.
 */
export async function assertStoredCrashfixAnalysis(
  sessionDir: string,
  meta: SessionMeta,
): Promise<void> {
  if (meta.crashfix_analysis === undefined) return;
  const crashes = await readCrashes(sessionDir);
  assertCrashfixAnalysisForReport(meta, crashes);
  const target = await loadUniqueArchivedFirebaseTarget(
    sessionDir,
    meta.extra!,
    "CrashFix analysis",
  );
  assertCrashfixAnalysisIdentity(meta.crashfix_analysis, target);
  if (meta.crashfix_analysis.evidence_set_sha256 !== target.evidenceSetSha256) {
    throw new Error(
      "CrashFix analysis evidence set does not match the archived Firebase evidence",
    );
  }
  assertCrashfixAnalysisOmitsSourceIdentifiers(
    meta.crashfix_analysis,
    target.sourceIdentifiers,
  );
}

/**
 * Persist one bounded root-cause analysis after the target and canonical
 * Firebase analyzer evidence have been archived. The top-level record is
 * immutable: exact retries are idempotent and every differing retry fails.
 */
export async function recordCrashfixAnalysis(
  sessionDir: string,
  rawAnalysis: CrashfixAnalysis,
): Promise<CrashfixAnalysisResult> {
  assertSessionDir(sessionDir);
  const analysis = crashfixAnalysisSchema.parse(rawAnalysis);

  return withSessionLock(sessionDir, async () => {
    const meta = await loadMeta(sessionDir);
    assertKnownSessionStatus(meta.status);
    if (meta.status !== "running") {
      throw new Error(
        `cannot record CrashFix analysis: session is not running (status=${meta.status})`,
      );
    }
    if (!isCrashfixSessionMeta(meta) || meta.extra === undefined) {
      throw new Error("CrashFix analysis requires a CrashFix session");
    }
    const extra = meta.extra;
    const provenanceStatus = crashfixProvenanceStatusSchema.parse(
      extra.provenance_status,
    );
    assertStoredCrashfixPreflightMatrix(extra);
    if (hasOwn(extra, "preflight_abort")) {
      crashfixPreflightAbortReasonSchema.parse(extra.preflight_abort);
      throw new Error("CrashFix analysis is forbidden after a preflight abort");
    }
    if (meta.source_lock === undefined) {
      throw new Error("CrashFix analysis requires an immutable Firebase source_lock");
    }
    assertCrashfixSourceLockMetadata(
      extra,
      remoteSourceLockSchema.parse(meta.source_lock),
    );
    requireBoundCrashfixTarget(extra);
    if (provenanceStatus === "unavailable" && analysis.locations.length !== 0) {
      throw new Error(
        "unavailable CrashFix provenance requires empty analysis locations",
      );
    }
    assertCrashfixAnalysisLocationProvenance(analysis, extra);
    const target = await loadUniqueArchivedFirebaseTarget(
      sessionDir,
      extra,
      "CrashFix analysis",
    );
    assertCrashfixAnalysisIdentity(analysis, target);
    assertCrashfixAnalysisOmitsSourceIdentifiers(
      analysis,
      target.sourceIdentifiers,
    );

    const storedAnalysis = storedCrashfixAnalysisSchema.parse({
      ...analysis,
      evidence_set_sha256: target.evidenceSetSha256,
    });

    if (meta.crashfix_analysis !== undefined) {
      const existing = storedCrashfixAnalysisSchema.parse(
        meta.crashfix_analysis,
      );
      if (!sameCrashfixAnalysis(existing, storedAnalysis)) {
        throw new Error("CrashFix analysis is already bound to different content");
      }
      return publicCrashfixAnalysisResult(existing, true);
    }

    meta.crashfix_analysis = storedAnalysis;
    await writeMeta(sessionDir, meta);
    return publicCrashfixAnalysisResult(storedAnalysis, false);
  });
}

/**
 * Persist one crash under an atomic filesystem lock shared by all report-mcp
 * processes. Remote sources are idempotent by external_key, so retries cannot
 * create duplicate records or archive duplicate evidence files. The session
 * lifecycle check intentionally runs before deduplication: a finalized session
 * is immutable even when the caller retries an already archived event.
 */
export async function recordCrashEvidence(
  sessionDir: string,
  input: CrashEvidenceInput,
): Promise<CrashEvidenceResult> {
  assertCrashEvidenceInput(sessionDir, input);
  const signatureVersion = input.signature_version === undefined
    ? undefined
    : crashSignatureVersionSchema.parse(input.signature_version);
  const source = input.source === undefined
    ? undefined
    : validateCrashSourceExternalKey(
      input.source,
      input.signature,
      signatureVersion,
    );

  return withSessionLock(sessionDir, async () => {
    const meta = await loadMeta(sessionDir);
    assertKnownSessionStatus(meta.status);
    if (meta.status !== "running") {
      throw new Error(
        `cannot record crash: session is not running (status=${meta.status})`,
      );
    }
    assertRemoteSourceLock(meta, source, input.acquisition_route);
    assertCrashfixAnalyzerIdentity(meta, input, source);

    const existing = await readCrashes(sessionDir);
    if (source !== undefined) {
      const duplicate = existing.find(
        (crash) => crash.source?.external_key === source.external_key,
      );
      if (duplicate !== undefined) {
        if (
          duplicate.signature !== input.signature
          || duplicate.signature_version !== signatureVersion
          || duplicate.signature_degraded !== input.signature_degraded
          || duplicate.cross_source_comparable !== input.cross_source_comparable
          || duplicate.kind !== input.kind
          || duplicate.source === undefined
          || !sameCrashSource(duplicate.source, source)
        ) {
          throw new Error(
            "source.external_key is already archived with different crash evidence",
          );
        }
        return { crash: duplicate, deduplicated: true };
      }
    }
    if (meta.crashfix_analysis !== undefined) {
      throw new Error(
        "CrashFix analysis is already bound; new crash evidence would change its evidence set",
      );
    }
    // The quick path deliberately archives one representative remote event.
    // Retries of that same event are handled by the idempotent branch above;
    // a second distinct event would silently turn a bounded quick analysis
    // into a multi-event/strict-style session, so reject it before writing
    // any stack or log bytes.
    if (
      meta.extra?.requested_workflow === "quick_test"
      && existing.length >= 1
    ) {
      throw new Error(
        "quick_test CrashFix sessions accept at most one crash event",
      );
    }
    if (existing.length >= MAX_CRASHES_PER_SESSION) {
      throw new RangeError(
        `session exceeds ${MAX_CRASHES_PER_SESSION} crash record limit`,
      );
    }

    const id = `c${existing.length + 1}`;
    const crashDir = path.join(sessionDir, "crashes");
    const crashDirectoryMetadata = await lstat(crashDir);
    if (!crashDirectoryMetadata.isDirectory() || crashDirectoryMetadata.isSymbolicLink()) {
      throw new Error("session crashes directory must be a real directory");
    }

    const stackPath = path.join(crashDir, `${id}.stack.txt`);
    const logDestination = input.log_full_src === undefined
      ? undefined
      : path.join(crashDir, `${id}.log`);
    let logPath: string | undefined;
    let stackHandle: Awaited<ReturnType<typeof open>> | undefined;
    let stackCreated = false;
    let logCreated = false;
    try {
      const noFollow = fsConstants.O_NOFOLLOW ?? 0;
      stackHandle = await open(
        stackPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
        0o600,
      );
      stackCreated = true;
      await stackHandle.writeFile(input.stack, { encoding: "utf8" });
      await stackHandle.close();
      stackHandle = undefined;
      if (input.log_full_src !== undefined && logDestination !== undefined) {
        await copyRegularFilePrivate(
          input.log_full_src,
          logDestination,
          MAX_CRASH_LOG_BYTES,
        );
        logCreated = true;
        logPath = path.relative(sessionDir, logDestination);
      }

      const crash: CrashRecord = {
        id,
        ts: new Date().toISOString(),
        signature: input.signature,
        ...(signatureVersion !== undefined
          ? { signature_version: signatureVersion }
          : {}),
        ...(input.signature_degraded !== undefined
          ? { signature_degraded: input.signature_degraded }
          : {}),
        ...(input.cross_source_comparable !== undefined
          ? { cross_source_comparable: input.cross_source_comparable }
          : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.step_index !== undefined ? { step_index: input.step_index } : {}),
        stack_path: path.relative(sessionDir, stackPath),
        ...(logPath !== undefined ? { log_path: logPath } : {}),
        repro_path: [...input.repro_path],
        ...(source !== undefined ? { source } : {}),
      };
      await appendCrash(sessionDir, crash);
      return { crash, deduplicated: false };
    } catch (error) {
      await stackHandle?.close().catch(() => undefined);
      if (stackCreated) {
        await unlink(stackPath).catch(() => undefined);
      }
      if (logCreated && logDestination !== undefined) {
        await unlink(logDestination).catch(() => undefined);
      }
      throw error;
    }
  });
}

function assertCrashfixAnalyzerIdentity(
  meta: SessionMeta,
  input: CrashEvidenceInput,
  source: CrashSource | undefined,
): void {
  if (meta.extra?.provenance_status === undefined) return;
  const extra = meta.extra;
  assertStoredCrashfixPreflightMatrix(extra);
  if (hasOwn(extra, "preflight_abort")) {
    crashfixPreflightAbortReasonSchema.parse(extra.preflight_abort);
    throw new Error("CrashFix crash evidence is forbidden after a preflight abort");
  }
  // CrashFix evidence is acquired remotely, not from a local replay.  Keep
  // the report boundary honest even if a caller bypasses the Skill wording:
  // never import a full local log or attach local step numbers/repro steps to
  // a Firebase event.  Local reproduction belongs to a separate devtest or
  // verification child session.
  if (input.log_full_src !== undefined) {
    throw new Error(
      "CrashFix Firebase evidence must omit log_full_src; record local logs in a child session",
    );
  }
  if (input.step_index !== undefined || input.repro_path.length !== 0) {
    throw new Error(
      "CrashFix Firebase evidence must use an empty repro_path and no local step_index",
    );
  }
  if (source?.provider !== FIREBASE_CRASHLYTICS_PROVIDER) {
    throw new Error("CrashFix sessions only accept normalized Firebase crash evidence");
  }
  if (source.app_build === undefined) {
    throw new Error(
      "CrashFix Firebase evidence requires normalized platform/app/version/build attestation",
    );
  }
  assertCrashfixPublicAliasesOmitSourceIdentifiers(
    meta,
    [source.project, source.app, source.issue, source.event].filter(
      (value): value is string => value !== undefined,
    ),
  );
  assertCrashSourceMatchesBoundTarget(source, requireBoundCrashfixTarget(extra));
  if (input.signature_version === undefined) {
    throw new Error("CrashFix Firebase evidence requires signature_version");
  }
  if (typeof input.signature_degraded !== "boolean") {
    throw new Error("CrashFix Firebase evidence requires signature_degraded");
  }
  if (typeof input.cross_source_comparable !== "boolean") {
    throw new Error("CrashFix Firebase evidence requires cross_source_comparable");
  }
  if (input.kind === undefined) {
    throw new Error("CrashFix Firebase evidence requires normalized kind");
  }
  assertCanonicalAnalyzerIdentity(input.stack, {
    signature: input.signature,
    signature_version: input.signature_version,
    kind: input.kind,
  });
}

/**
 * Atomically bind a running CrashFix snapshot session to the sealed source
 * identity created after start_session. This is deliberately not a generic
 * meta patch API: status/mode/source lock are immutable, the complete field
 * group is all-or-none, and a retry is idempotent only when every value is
 * identical.
 */
export async function recordSnapshotProvenance(
  sessionDir: string,
  rawInput: SnapshotProvenance,
): Promise<SnapshotProvenanceResult> {
  assertSessionDir(sessionDir);
  const input = snapshotProvenanceSchema.parse(rawInput);

  return withSessionLock(sessionDir, async () => {
    const meta = await loadMeta(sessionDir);
    assertKnownSessionStatus(meta.status);
    if (meta.status !== "running") {
      throw new Error(
        `cannot record snapshot provenance: session is not running (status=${meta.status})`,
      );
    }
    if (meta.source_lock === undefined) {
      throw new Error("snapshot provenance requires an immutable Firebase source_lock");
    }
    const sourceLock = remoteSourceLockSchema.parse(meta.source_lock);

    const extra = meta.extra;
    if (extra === undefined || extra.provenance_status !== "resolved") {
      throw new Error("snapshot provenance requires provenance_status=resolved");
    }
    if (extra.provenance_mode !== "snapshot_repro_equivalent") {
      throw new Error(
        "snapshot provenance requires provenance_mode=snapshot_repro_equivalent",
      );
    }
    assertCrashfixSourceLockMetadata(extra, sourceLock);
    assertNoStoredApprovedTestFixtureDetails(extra);
    assertApprovedTestFixtureSessionControls(extra, input);

    // Git identity and source_ref are incompatible with snapshot provenance at
    // every lifecycle stage. In particular, an exact retry must not legitimize
    // a damaged/legacy meta file that mixed the two provenance routes.
    const contradictoryIdentityKeys = [
      ...presentKeys(extra, GIT_ONLY_PROVENANCE_EXTRA_KEYS),
      ...presentKeys(extra, ["source_ref_sha256"]),
    ];
    if (contradictoryIdentityKeys.length > 0) {
      throw new Error(
        `snapshot provenance contains contradictory identity fields: ${contradictoryIdentityKeys.join(", ")}`,
      );
    }

    const existingKeys = presentKeys(extra, SNAPSHOT_SOURCE_EXTRA_KEYS);
    if (existingKeys.length !== 0 && existingKeys.length !== SNAPSHOT_SOURCE_EXTRA_KEYS.length) {
      throw new Error("stored snapshot provenance is partial and cannot be repaired in place");
    }
    if (existingKeys.length === SNAPSHOT_SOURCE_EXTRA_KEYS.length) {
      const existing = snapshotProvenanceSchema.safeParse({
        manifest_sha256: extra.manifest_sha256,
        source_snapshot_sha256: extra.source_snapshot_sha256,
        exclusion_policy_sha256: extra.exclusion_policy_sha256,
        dynamic_exclusions_sha256: extra.dynamic_exclusions_sha256,
        approved_test_fixtures_sha256: extra.approved_test_fixtures_sha256,
        approved_test_fixture_count: extra.approved_test_fixture_count,
        files: extra.files,
        directories: extra.directories,
        bytes: extra.bytes,
      });
      if (!existing.success) {
        throw new Error("stored snapshot provenance is invalid");
      }
      assertApprovedTestFixtureSessionControls(extra, existing.data);
      if (!sameSnapshotProvenance(existing.data, input)) {
        throw new Error("snapshot provenance is already bound to a different identity");
      }
      return publicSnapshotProvenanceResult(input, true);
    }

    // Candidate and build-derived fields are legitimate only after the sealed
    // source identity exists. Once the complete source group is bound, the exact
    // retry branch above intentionally remains idempotent in their presence.
    const prematureDerivedKeys = presentKeys(extra, [
      ...SNAPSHOT_CANDIDATE_EXTRA_KEYS,
      ...LEGACY_DERIVED_PROVENANCE_EXTRA_KEYS,
    ]);
    if (prematureDerivedKeys.length > 0) {
      throw new Error(
        `snapshot derived provenance exists before source binding: ${prematureDerivedKeys.join(", ")}`,
      );
    }

    meta.extra = { ...extra, ...input };
    await writeMeta(sessionDir, meta);
    return publicSnapshotProvenanceResult(input, false);
  });
}

function sameSnapshotProvenance(
  left: SnapshotProvenance,
  right: SnapshotProvenance,
): boolean {
  return SNAPSHOT_SOURCE_EXTRA_KEYS.every((key) => left[key] === right[key]);
}

function assertApprovedTestFixtureSessionControls(
  extra: Record<string, unknown>,
  provenance: SnapshotProvenance,
): void {
  if (provenance.approved_test_fixture_count === 0) return;
  if (extra.requested_execution_profile !== "local_trusted") {
    throw new Error(
      "approved test fixtures require requested_execution_profile=local_trusted",
    );
  }
  if (extra.workspace_project_classification !== "test") {
    throw new Error(
      "approved test fixtures require workspace_project_classification=test",
    );
  }
}

const APPROVABLE_TEST_FIXTURE_CHANGED_FILE_RE =
  /\.(?:json|properties|conf|config|cfg|ini|toml|ya?ml|xml|auth)$/i;

function assertCandidateChangedFilesDoNotArchiveFixturePaths(
  provenance: SnapshotProvenance,
  candidate: CandidateBuildProvenance,
): void {
  if (provenance.approved_test_fixture_count === 0) return;
  if (
    candidate.changed_files.some((relativePath) =>
      APPROVABLE_TEST_FIXTURE_CHANGED_FILE_RE.test(relativePath)
    )
  ) {
    throw new Error(
      "candidate changed_files must omit approvable test fixture paths",
    );
  }
}

function publicSnapshotProvenanceResult(
  provenance: SnapshotProvenance,
  deduplicated: boolean,
): SnapshotProvenanceResult {
  return {
    deduplicated,
    source_snapshot_sha256_prefix: provenance.source_snapshot_sha256.slice(0, 12),
    exclusion_policy_sha256_prefix: provenance.exclusion_policy_sha256.slice(0, 12),
    dynamic_exclusions_sha256_prefix: provenance.dynamic_exclusions_sha256.slice(0, 12),
    approved_test_fixtures_sha256_prefix:
      provenance.approved_test_fixtures_sha256.slice(0, 12),
    approved_test_fixture_count: provenance.approved_test_fixture_count,
    files: provenance.files,
    directories: provenance.directories,
    bytes: provenance.bytes,
  };
}

/**
 * Atomically advance the private provenance of one snapshot repair candidate.
 * This API is intentionally snapshot-only: Git candidates use their release
 * identity/worktree flow and must never be mixed into this state machine.
 */
export async function recordCandidateProvenance(
  sessionDir: string,
  rawInput: CandidateProvenance,
): Promise<CandidateProvenanceResult> {
  assertSessionDir(sessionDir);
  const input = candidateProvenanceSchema.parse(rawInput);

  return withSessionLock(sessionDir, async () => {
    const meta = await loadMeta(sessionDir);
    assertKnownSessionStatus(meta.status);
    if (meta.status !== "running") {
      throw new Error(
        `cannot record candidate provenance: session is not running (status=${meta.status})`,
      );
    }
    if (meta.source_lock === undefined) {
      throw new Error("candidate provenance requires an immutable Firebase source_lock");
    }
    const sourceLock = remoteSourceLockSchema.parse(meta.source_lock);
    const extra = meta.extra;
    if (extra === undefined || extra.provenance_status !== "resolved") {
      throw new Error("candidate provenance requires provenance_status=resolved");
    }
    if (extra.provenance_mode !== "snapshot_repro_equivalent") {
      throw new Error(
        "candidate provenance requires provenance_mode=snapshot_repro_equivalent",
      );
    }
    assertCrashfixSourceLockMetadata(extra, sourceLock);
    assertCrashfixCandidateLifecycle(extra);
    const requestedExecutionProfile = requestedExecutionProfileFromExtra(extra);

    const contradictoryIdentityKeys = [
      ...presentKeys(extra, GIT_ONLY_PROVENANCE_EXTRA_KEYS),
      ...presentKeys(extra, ["source_ref_sha256"]),
      ...presentKeys(extra, LEGACY_DERIVED_PROVENANCE_EXTRA_KEYS),
    ];
    if (contradictoryIdentityKeys.length > 0) {
      throw new Error(
        `candidate provenance contains contradictory identity fields: ${contradictoryIdentityKeys.join(", ")}`,
      );
    }
    const sourceProvenance = requireStoredSnapshotProvenance(extra);

    if (input.stage === "candidate") {
      assertCandidateChangedFilesDoNotArchiveFixturePaths(sourceProvenance, input);
      assertCandidateMatchesRequestedExecutionProfile(input, requestedExecutionProfile);
      const boundTarget = requireBoundCrashfixTarget(extra);
      assertCandidateMatchesBoundTarget(input, boundTarget);
      const archivedTarget = await assertCandidateMatchesArchivedFirebaseTarget(
        sessionDir,
        input,
        extra,
      );
      await assertStoredCrashfixAnalysis(sessionDir, meta);
      const analysis = meta.crashfix_analysis;
      if (analysis === undefined) {
        throw new Error("candidate provenance requires a bound CrashFix analysis");
      }
      assertCrashfixAnalysisIdentity(analysis, archivedTarget);
      if (analysis.confidence !== "high") {
        throw new Error(
          "candidate provenance requires confidence=high CrashFix analysis",
        );
      }
      return bindCandidateBuildProvenance(sessionDir, meta, extra, input);
    }
    const candidate = requireStoredCandidateBuildProvenance(extra);
    await assertStoredCrashfixAnalysis(sessionDir, meta);
    if (meta.crashfix_analysis === undefined) {
      throw new Error("candidate provenance requires a bound CrashFix analysis");
    }
    if (meta.crashfix_analysis.confidence !== "high") {
      throw new Error(
        "candidate provenance requires confidence=high CrashFix analysis",
      );
    }
    assertCandidateChangedFilesDoNotArchiveFixturePaths(sourceProvenance, candidate);
    assertCandidateMatchesRequestedExecutionProfile(candidate, requestedExecutionProfile);
    const boundTarget = requireBoundCrashfixTarget(extra);
    assertCandidateMatchesBoundTarget(candidate, boundTarget);
    if (input.stage === "verification") {
      return bindCandidateVerificationProvenance(
        sessionDir,
        meta,
        extra,
        candidate,
        input,
      );
    }
    return bindCandidateExportProvenance(sessionDir, meta, extra, candidate, input);
  });
}

interface ArchivedFirebaseTarget {
  signatureVersion: CrashSignatureVersion;
  fingerprint: string;
  kind: string;
  signatureDegraded: boolean;
  crossSourceComparable: boolean;
  appBuild: CrashArtifactTarget;
  sourceIdentifiers: string[];
  evidenceSetSha256: string;
}

function crashfixEvidenceSetIdentity(
  entries: Array<{ externalKey: string; stackSha256: string }>,
): string {
  const sorted = [...entries].sort((left, right) => {
    const leftKey = `${left.externalKey}\0${left.stackSha256}`;
    const rightKey = `${right.externalKey}\0${right.stackSha256}`;
    return Buffer.compare(Buffer.from(leftKey), Buffer.from(rightKey));
  });
  const digest = createHash("sha256").update(
    "crashfix-analysis-evidence-set/v1\0",
    "utf8",
  );
  for (const entry of sorted) {
    digest
      .update(entry.externalKey, "utf8")
      .update("\0", "utf8")
      .update(entry.stackSha256, "utf8")
      .update("\0", "utf8");
  }
  return digest.digest("hex");
}

async function assertCandidateMatchesArchivedFirebaseTarget(
  sessionDir: string,
  candidate: CandidateBuildProvenance,
  extra: Record<string, unknown>,
): Promise<ArchivedFirebaseTarget> {
  const target = await loadUniqueArchivedFirebaseTarget(sessionDir, extra);
  if (target.signatureDegraded || !target.crossSourceComparable) {
    throw new Error(
      "candidate provenance requires non-degraded, cross-source-comparable analyzer evidence",
    );
  }
  if (
    candidate.artifact_platform !== target.appBuild.platform
    || candidate.artifact_app_id !== target.appBuild.app_id
    || candidate.artifact_version !== target.appBuild.version
    || candidate.artifact_build !== target.appBuild.build
  ) {
    throw new Error(
      "candidate artifact identity does not match the archived Firebase app/version/build",
    );
  }
  return target;
}

async function loadUniqueArchivedFirebaseTarget(
  sessionDir: string,
  extra: Record<string, unknown>,
  requirement = "candidate provenance",
): Promise<ArchivedFirebaseTarget> {
  const boundTarget = requireBoundCrashfixTarget(extra);
  const crashes = await readCrashes(sessionDir);
  if (crashes.length === 0) {
    throw new Error(`${requirement} requires archived Firebase crash evidence first`);
  }
  const first = crashes[0]!;
  const source = first.source;
  if (
    source?.provider !== FIREBASE_CRASHLYTICS_PROVIDER
    || source.app_build === undefined
    || first.signature_version === undefined
    || typeof first.signature_degraded !== "boolean"
    || typeof first.cross_source_comparable !== "boolean"
    || first.kind === undefined
  ) {
    throw new Error(
      `${requirement} requires normalized Firebase app/build/analyzer evidence`,
    );
  }
  const target: ArchivedFirebaseTarget = {
    signatureVersion: first.signature_version,
    fingerprint: first.signature,
    kind: first.kind,
    signatureDegraded: first.signature_degraded,
    crossSourceComparable: first.cross_source_comparable,
    appBuild: source.app_build,
    sourceIdentifiers: [
      source.project!,
      source.app!,
      source.issue!,
      source.event!,
    ],
    evidenceSetSha256: "",
  };
  const evidenceSetEntries: Array<{
    externalKey: string;
    stackSha256: string;
  }> = [];
  for (const crash of crashes) {
    if (crash.source !== undefined) {
      assertCrashSourceMatchesBoundTarget(crash.source, boundTarget);
    }
    if (
      crash.source?.provider !== FIREBASE_CRASHLYTICS_PROVIDER
      || crash.source.project !== source.project
      || crash.source.app !== source.app
      || crash.source.issue !== source.issue
      || crash.source.app_build?.platform !== target.appBuild.platform
      || crash.source.app_build?.app_id !== target.appBuild.app_id
      || crash.source.app_build?.version !== target.appBuild.version
      || crash.source.app_build?.build !== target.appBuild.build
      || crash.signature_version !== target.signatureVersion
      || crash.signature !== target.fingerprint
      || crash.kind !== target.kind
      || crash.signature_degraded !== target.signatureDegraded
      || crash.cross_source_comparable !== target.crossSourceComparable
    ) {
      throw new Error(
        `${requirement} requires one unique Firebase app/issue/build/analyzer identity`,
      );
    }
    for (const identifier of [
      crash.source.project,
      crash.source.app,
      crash.source.issue,
      crash.source.event,
    ]) {
      if (identifier !== undefined && !target.sourceIdentifiers.includes(identifier)) {
        target.sourceIdentifiers.push(identifier);
      }
    }
    evidenceSetEntries.push({
      externalKey: crash.source.external_key,
      stackSha256: await readCrashStackAndVerifyIdentity(sessionDir, crash),
    });
  }
  target.evidenceSetSha256 = crashfixEvidenceSetIdentity(evidenceSetEntries);
  return target;
}

function requestedExecutionProfileFromExtra(
  extra: Record<string, unknown>,
): BuildRunnerExecutionProfile {
  if (!hasOwn(extra, "requested_execution_profile")) {
    throw new Error(
      "candidate provenance requires an immutable requested_execution_profile",
    );
  }
  const parsed = buildRunnerExecutionProfileSchema.safeParse(
    extra.requested_execution_profile,
  );
  if (!parsed.success) {
    throw new Error("stored requested_execution_profile is invalid");
  }
  return parsed.data;
}

function assertCrashfixCandidateLifecycle(extra: Record<string, unknown>): void {
  if (extra.requested_workflow === "quick_test") {
    throw new Error(
      "quick_test never uses snapshot candidate provenance; record a local devtest result instead",
    );
  }
  if (!hasOwn(extra, "requested_mode")) {
    throw new Error(
      "candidate provenance is disabled for legacy CrashFix sessions without requested_mode",
    );
  }
  const requestedMode = crashfixRequestedModeSchema.parse(extra.requested_mode);
  if (requestedMode !== "patch") {
    throw new Error(
      `candidate provenance requires requested_mode=patch (received ${requestedMode})`,
    );
  }
  if (hasOwn(extra, "preflight_abort")) {
    crashfixPreflightAbortReasonSchema.parse(extra.preflight_abort);
    throw new Error("candidate provenance is forbidden after a preflight abort");
  }
}

function assertCandidateMatchesRequestedExecutionProfile(
  candidate: CandidateBuildProvenance,
  requestedExecutionProfile: BuildRunnerExecutionProfile,
): void {
  if (candidate.execution_profile !== requestedExecutionProfile) {
    throw new Error(
      "candidate execution_profile does not match requested_execution_profile",
    );
  }
}

function requireStoredSnapshotProvenance(
  extra: Record<string, unknown>,
): SnapshotProvenance {
  assertNoStoredApprovedTestFixtureDetails(extra);
  const keys = presentKeys(extra, SNAPSHOT_SOURCE_EXTRA_KEYS);
  if (keys.length === 0) {
    throw new Error("candidate provenance requires source snapshot provenance first");
  }
  if (keys.length !== SNAPSHOT_SOURCE_EXTRA_KEYS.length) {
    throw new Error("stored snapshot provenance is partial and cannot be used by a candidate");
  }
  const parsed = snapshotProvenanceSchema.safeParse({
    manifest_sha256: extra.manifest_sha256,
    source_snapshot_sha256: extra.source_snapshot_sha256,
    exclusion_policy_sha256: extra.exclusion_policy_sha256,
    dynamic_exclusions_sha256: extra.dynamic_exclusions_sha256,
    approved_test_fixtures_sha256: extra.approved_test_fixtures_sha256,
    approved_test_fixture_count: extra.approved_test_fixture_count,
    files: extra.files,
    directories: extra.directories,
    bytes: extra.bytes,
  });
  if (!parsed.success) throw new Error("stored snapshot provenance is invalid");
  assertApprovedTestFixtureSessionControls(extra, parsed.data);
  return parsed.data;
}

function bindCandidateBuildProvenance(
  sessionDir: string,
  meta: SessionMeta,
  extra: Record<string, unknown>,
  input: CandidateBuildProvenance,
): Promise<CandidateBuildProvenanceResult> {
  const existingKeys = presentKeys(extra, SNAPSHOT_CANDIDATE_BUILD_EXTRA_KEYS);
  if (
    existingKeys.length !== 0
    && existingKeys.length !== SNAPSHOT_CANDIDATE_BUILD_EXTRA_KEYS.length
  ) {
    throw new Error("stored candidate build provenance is partial and cannot be repaired in place");
  }
  if (existingKeys.length === SNAPSHOT_CANDIDATE_BUILD_EXTRA_KEYS.length) {
    const existing = parseStoredCandidateBuildProvenance(extra);
    if (!sameCandidateBuildProvenance(existing, input)) {
      throw new Error("candidate build provenance is already bound to a different identity");
    }
    return Promise.resolve(publicCandidateBuildResult(input, true));
  }

  const prematureLaterKeys = presentKeys(extra, [
    ...SNAPSHOT_CANDIDATE_VERIFICATION_EXTRA_KEYS,
    ...SNAPSHOT_CANDIDATE_EXPORT_EXTRA_KEYS,
  ]);
  if (prematureLaterKeys.length > 0) {
    throw new Error(
      `candidate provenance contains a later stage before candidate binding: ${prematureLaterKeys.join(", ")}`,
    );
  }
  const { stage: _stage, ...stored } = input;
  meta.extra = { ...extra, ...stored };
  return writeMeta(sessionDir, meta).then(() => publicCandidateBuildResult(input, false));
}

async function bindCandidateVerificationProvenance(
  sessionDir: string,
  meta: SessionMeta,
  extra: Record<string, unknown>,
  candidate: CandidateBuildProvenance,
  input: CandidateVerificationProvenance,
): Promise<CandidateVerificationProvenanceResult> {
  if (input.artifact_sha256 !== candidate.artifact_sha256) {
    throw new Error("verification artifact does not match the bound candidate artifact");
  }
  const verifiedChildren = await validateCandidateVerificationChildren(
    sessionDir,
    meta,
    candidate,
    input,
  );
  const existingKeys = presentKeys(extra, SNAPSHOT_CANDIDATE_VERIFICATION_EXTRA_KEYS);
  if (
    existingKeys.length !== 0
    && existingKeys.length !== SNAPSHOT_CANDIDATE_VERIFICATION_EXTRA_KEYS.length
  ) {
    throw new Error("stored candidate verification provenance is partial and cannot be repaired");
  }
  if (existingKeys.length === SNAPSHOT_CANDIDATE_VERIFICATION_EXTRA_KEYS.length) {
    const existing = parseStoredCandidateVerificationProvenance(extra, candidate);
    if (!sameCandidateVerificationProvenance(existing, input, verifiedChildren)) {
      throw new Error("candidate verification provenance is already bound to different evidence");
    }
    return publicCandidateVerificationResult(existing, true);
  }
  const prematureExportKeys = presentKeys(extra, SNAPSHOT_CANDIDATE_EXPORT_EXTRA_KEYS);
  if (prematureExportKeys.length > 0) {
    throw new Error("candidate export provenance exists before verification binding");
  }
  const stored: StoredCandidateVerificationProvenance = {
    stage: "verification",
    artifact_sha256: candidate.artifact_sha256,
    device_ref_sha256: input.device_ref_sha256,
    plan_sha256: input.plan_sha256,
    target_signature_version: input.target_signature_version,
    target_fingerprint: input.target_fingerprint,
    verification_child_session_ref_sha256s: verifiedChildren.references,
    verification_child_evidence_sha256s: verifiedChildren.evidenceDigests,
    verification_runs: 3,
    verified: true,
  };
  const { stage: _stage, artifact_sha256: _artifact, ...storedExtra } = stored;
  meta.extra = { ...extra, ...storedExtra };
  await writeMeta(sessionDir, meta);
  return publicCandidateVerificationResult(stored, false);
}

async function validateCandidateVerificationChildren(
  sessionDir: string,
  parentMeta: SessionMeta,
  candidate: CandidateBuildProvenance,
  input: CandidateVerificationProvenance,
): Promise<ValidatedVerificationChildren> {
  const parentId = sessionIdReferenceSchema.parse(parentMeta.id);
  const resolvedParent = await realpath(path.resolve(sessionDir));
  if (path.basename(resolvedParent) !== parentId) {
    throw new Error("parent session directory does not match its session id");
  }

  const archivedTarget = await assertCandidateMatchesArchivedFirebaseTarget(
    resolvedParent,
    candidate,
    parentMeta.extra ?? {},
  );
  if (
    archivedTarget.signatureVersion !== input.target_signature_version
    || archivedTarget.fingerprint !== input.target_fingerprint
  ) {
    throw new Error(
      "verification target signature identity is not archived in the parent session",
    );
  }

  const workspaceRoot = path.dirname(resolvedParent);
  const workspaceMetadata = await lstat(workspaceRoot);
  if (!workspaceMetadata.isDirectory() || workspaceMetadata.isSymbolicLink()) {
    throw new Error("verification children require a real sibling session root");
  }

  const references: string[] = [];
  const evidenceDigests: string[] = [];
  for (const [index, childId] of input.child_session_ids.entries()) {
    if (childId === parentId) {
      throw new Error("verification child session must differ from its parent");
    }
    const childDir = path.join(workspaceRoot, childId);
    try {
      const childMetadata = await lstat(childDir);
      if (
        !childMetadata.isDirectory()
        || childMetadata.isSymbolicLink()
        || await realpath(childDir) !== childDir
      ) {
        throw new Error("unsafe child directory");
      }
    } catch {
      throw new Error("verification child session is unavailable or unsafe");
    }
    const evidenceDigest = await withSessionLock(childDir, async () => {
      const childMeta = await loadMeta(childDir);
      if (childMeta.id !== childId) {
        throw new Error("verification child metadata id does not match its directory");
      }
      if (childMeta.status !== "passed" || !isValidTerminalTimestamp(childMeta)) {
        throw new Error("verification child session must be finalized as passed");
      }
      if (childMeta.source_lock !== undefined || childMeta.extra?.provenance_status !== undefined) {
        throw new Error("verification child must be a local devtest session");
      }
      if (
        (childMeta.report_language ?? DEFAULT_REPORT_LANGUAGE)
        !== (parentMeta.report_language ?? DEFAULT_REPORT_LANGUAGE)
      ) {
        throw new Error(
          "verification child report language must match its parent session",
        );
      }
      if (Date.parse(childMeta.started_at) < Date.parse(parentMeta.started_at)) {
        throw new Error("verification child session predates its parent");
      }

      const context = childVerificationContextFromExtra(childMeta.extra);
      if (context === undefined) {
        throw new Error("verification child is missing its immutable v1 context");
      }
      assertChildContextMatchesCandidate(
        context,
        parentId,
        index + 1,
        candidate,
        input,
      );
      const record = childVerificationRecordSchema.safeParse(childMeta.verification);
      if (!record.success) {
        throw new Error("verification child is missing valid finalized evidence");
      }
      if (!sameChildVerificationContext(record.data, context)) {
        throw new Error("verification child finalized evidence conflicts with its start context");
      }
      const steps = await readSteps(childDir);
      const crashes = await readCrashes(childDir);
      assertPassedVerificationRun(context, steps, crashes, record.data);
      return childVerificationEvidenceDigest(
        childMeta,
        context,
        record.data,
        steps,
      );
    });
    references.push(
      createHash("sha256")
        .update(["crashfix-child-session/v1", parentId, childId].join("\0"), "utf8")
        .digest("hex"),
    );
    evidenceDigests.push(evidenceDigest);
  }
  return {
    references: references as [string, string, string],
    evidenceDigests: evidenceDigests as [string, string, string],
  };
}

interface ValidatedVerificationChildren {
  references: [string, string, string];
  evidenceDigests: [string, string, string];
}

function childVerificationEvidenceDigest(
  meta: SessionMeta,
  context: ChildVerificationContext,
  record: ChildVerificationRecord,
  steps: StepRecord[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schema: "crashfix-child-evidence/v1",
        session_id: meta.id,
        started_at: meta.started_at,
        ended_at: meta.ended_at,
        status: meta.status,
        context,
        verification: record,
        steps,
      }),
      "utf8",
    )
    .digest("hex");
}

function assertChildContextMatchesCandidate(
  context: ChildVerificationContext,
  parentId: string,
  expectedRun: number,
  candidate: CandidateBuildProvenance,
  input: CandidateVerificationProvenance,
): void {
  if (context.verification_parent_session_id !== parentId) {
    throw new Error("verification child is linked to a different parent session");
  }
  if (context.verification_run !== expectedRun) {
    throw new Error("verification child run order must be exactly 1, 2, 3");
  }
  if (
    context.artifact_sha256 !== candidate.artifact_sha256
    || context.device_ref_sha256 !== input.device_ref_sha256
    || context.plan_sha256 !== input.plan_sha256
    || context.platform !== candidate.artifact_platform
  ) {
    throw new Error(
      "verification children do not share the bound artifact/device/plan/platform identity",
    );
  }
  if (
    context.verification_target_signature_version !== input.target_signature_version
    || context.verification_target_fingerprint !== input.target_fingerprint
  ) {
    throw new Error("verification children do not share the target analyzer signature identity");
  }
}

async function bindCandidateExportProvenance(
  sessionDir: string,
  meta: SessionMeta,
  extra: Record<string, unknown>,
  candidate: CandidateBuildProvenance,
  input: CandidateExportProvenance,
): Promise<CandidateExportProvenanceResult> {
  const verification = requireStoredCandidateVerificationProvenance(extra, candidate);
  await revalidateStoredVerificationChildren(
    sessionDir,
    meta,
    candidate,
    verification,
  );
  if (
    input.canonical_diff_sha256 !== candidate.canonical_diff_sha256
    || input.candidate_manifest_sha256 !== candidate.candidate_manifest_sha256
  ) {
    throw new Error("export identity does not match the bound candidate diff and manifest");
  }
  const existingKeys = presentKeys(extra, SNAPSHOT_CANDIDATE_EXPORT_EXTRA_KEYS);
  if (existingKeys.length === SNAPSHOT_CANDIDATE_EXPORT_EXTRA_KEYS.length) {
    const existing = candidateExportProvenanceSchema.safeParse({
      stage: "export",
      canonical_diff_sha256: candidate.canonical_diff_sha256,
      candidate_manifest_sha256: candidate.candidate_manifest_sha256,
      destination_ref_sha256: extra.destination_ref_sha256,
    });
    if (!existing.success) throw new Error("stored candidate export provenance is invalid");
    if (!sameCandidateExportProvenance(existing.data, input)) {
      throw new Error("candidate export provenance is already bound to a different destination");
    }
    return publicCandidateExportResult(input, true);
  }
  const { stage: _stage, canonical_diff_sha256: _diff, candidate_manifest_sha256: _manifest, ...stored } = input;
  meta.extra = { ...extra, ...stored };
  await writeMeta(sessionDir, meta);
  return publicCandidateExportResult(input, false, verification.verification_runs);
}

async function revalidateStoredVerificationChildren(
  sessionDir: string,
  parentMeta: SessionMeta,
  candidate: CandidateBuildProvenance,
  stored: StoredCandidateVerificationProvenance,
): Promise<void> {
  const parentId = sessionIdReferenceSchema.parse(parentMeta.id);
  const workspaceRoot = path.dirname(await realpath(path.resolve(sessionDir)));
  const entries = await readdir(workspaceRoot);
  if (entries.length > MAX_STEPS_PER_SESSION) {
    throw new RangeError("verification sibling session count exceeds safety limit");
  }
  const expectedRefs = new Set(stored.verification_child_session_ref_sha256s);
  const byRef = new Map<string, string>();
  for (const entry of entries) {
    if (!sessionIdReferenceSchema.safeParse(entry).success) continue;
    const ref = createHash("sha256")
      .update(["crashfix-child-session/v1", parentId, entry].join("\0"), "utf8")
      .digest("hex");
    if (!expectedRefs.has(ref)) continue;
    if (byRef.has(ref)) {
      throw new Error("verification child reference resolves ambiguously");
    }
    byRef.set(ref, entry);
  }
  const childIds = stored.verification_child_session_ref_sha256s.map((ref) => {
    const childId = byRef.get(ref);
    if (childId === undefined) {
      throw new Error("verification child session was removed or is unavailable");
    }
    return childId;
  }) as [string, string, string];
  const current = await validateCandidateVerificationChildren(
    sessionDir,
    parentMeta,
    candidate,
    {
      stage: "verification",
      artifact_sha256: stored.artifact_sha256,
      device_ref_sha256: stored.device_ref_sha256,
      plan_sha256: stored.plan_sha256,
      target_signature_version: stored.target_signature_version,
      target_fingerprint: stored.target_fingerprint,
      child_session_ids: childIds,
    },
  );
  if (
    !stored.verification_child_session_ref_sha256s.every(
      (value, index) => value === current.references[index],
    )
    || !stored.verification_child_evidence_sha256s.every(
      (value, index) => value === current.evidenceDigests[index],
    )
  ) {
    throw new Error("verification child evidence changed after it was bound");
  }
}

function requireStoredCandidateBuildProvenance(
  extra: Record<string, unknown>,
): CandidateBuildProvenance {
  const keys = presentKeys(extra, SNAPSHOT_CANDIDATE_BUILD_EXTRA_KEYS);
  if (keys.length === 0) throw new Error("candidate build provenance must be bound first");
  if (keys.length !== SNAPSHOT_CANDIDATE_BUILD_EXTRA_KEYS.length) {
    throw new Error("stored candidate build provenance is partial and cannot be used");
  }
  return parseStoredCandidateBuildProvenance(extra);
}

function parseStoredCandidateBuildProvenance(
  extra: Record<string, unknown>,
): CandidateBuildProvenance {
  const parsed = candidateBuildProvenanceSchema.safeParse({
    stage: "candidate",
    baseline_artifact_sha256: extra.baseline_artifact_sha256,
    artifact_sha256: extra.artifact_sha256,
    build_environment_sha256: extra.build_environment_sha256,
    execution_profile: extra.execution_profile,
    strong_isolation: extra.strong_isolation,
    workspace_disk_quota_enforced: extra.workspace_disk_quota_enforced,
    network_policy: extra.network_policy,
    filesystem_write_isolation: extra.filesystem_write_isolation,
    secret_filesystem_isolation: extra.secret_filesystem_isolation,
    process_containment: extra.process_containment,
    canonical_diff_sha256: extra.canonical_diff_sha256,
    candidate_manifest_sha256: extra.candidate_manifest_sha256,
    workspace_canonical_diff_sha256: extra.workspace_canonical_diff_sha256,
    workspace_manifest_sha256: extra.workspace_manifest_sha256,
    workspace_role: extra.workspace_role,
    changed_files: extra.changed_files,
    artifact_platform: extra.artifact_platform,
    artifact_app_id: extra.artifact_app_id,
    artifact_version: extra.artifact_version,
    artifact_build: extra.artifact_build,
    artifact_variant: extra.artifact_variant,
    variant_source: extra.variant_source,
    variant_artifact_derived: extra.variant_artifact_derived,
    artifact_signing_identity_ref_sha256: extra.artifact_signing_identity_ref_sha256,
  });
  if (!parsed.success) throw new Error("stored candidate build provenance is invalid");
  return parsed.data;
}

function requireStoredCandidateVerificationProvenance(
  extra: Record<string, unknown>,
  candidate: CandidateBuildProvenance,
): StoredCandidateVerificationProvenance {
  const keys = presentKeys(extra, SNAPSHOT_CANDIDATE_VERIFICATION_EXTRA_KEYS);
  if (keys.length === 0) throw new Error("candidate verification provenance must be bound first");
  if (keys.length !== SNAPSHOT_CANDIDATE_VERIFICATION_EXTRA_KEYS.length) {
    throw new Error("stored candidate verification provenance is partial and cannot be used");
  }
  return parseStoredCandidateVerificationProvenance(extra, candidate);
}

function parseStoredCandidateVerificationProvenance(
  extra: Record<string, unknown>,
  candidate: CandidateBuildProvenance,
): StoredCandidateVerificationProvenance {
  const parsed = storedCandidateVerificationProvenanceSchema.safeParse({
    stage: "verification",
    artifact_sha256: candidate.artifact_sha256,
    device_ref_sha256: extra.device_ref_sha256,
    plan_sha256: extra.plan_sha256,
    target_signature_version: extra.target_signature_version,
    target_fingerprint: extra.target_fingerprint,
    verification_child_session_ref_sha256s:
      extra.verification_child_session_ref_sha256s,
    verification_child_evidence_sha256s:
      extra.verification_child_evidence_sha256s,
    verification_runs: extra.verification_runs,
    verified: extra.verified,
  });
  if (!parsed.success) throw new Error("stored candidate verification provenance is invalid");
  return parsed.data;
}

function sameCandidateBuildProvenance(
  left: CandidateBuildProvenance,
  right: CandidateBuildProvenance,
): boolean {
  return SNAPSHOT_CANDIDATE_BUILD_EXTRA_KEYS.every((key) => {
    const leftValue = left[key];
    const rightValue = right[key];
    if (Array.isArray(leftValue) && Array.isArray(rightValue)) {
      return leftValue.length === rightValue.length
        && leftValue.every((value, index) => value === rightValue[index]);
    }
    return leftValue === rightValue;
  });
}

function sameCandidateVerificationProvenance(
  left: StoredCandidateVerificationProvenance,
  right: CandidateVerificationProvenance,
  children: ValidatedVerificationChildren,
): boolean {
  return left.artifact_sha256 === right.artifact_sha256
    && left.device_ref_sha256 === right.device_ref_sha256
    && left.plan_sha256 === right.plan_sha256
    && left.target_signature_version === right.target_signature_version
    && left.target_fingerprint === right.target_fingerprint
    && left.verification_runs === 3
    && left.verified === true
    && left.verification_child_session_ref_sha256s.length === children.references.length
    && left.verification_child_session_ref_sha256s.every(
      (value, index) => value === children.references[index],
    )
    && left.verification_child_evidence_sha256s.length === children.evidenceDigests.length
    && left.verification_child_evidence_sha256s.every(
      (value, index) => value === children.evidenceDigests[index],
    );
}

function sameCandidateExportProvenance(
  left: CandidateExportProvenance,
  right: CandidateExportProvenance,
): boolean {
  return left.canonical_diff_sha256 === right.canonical_diff_sha256
    && left.candidate_manifest_sha256 === right.candidate_manifest_sha256
    && left.destination_ref_sha256 === right.destination_ref_sha256;
}

function publicCandidateBuildResult(
  input: CandidateBuildProvenance,
  deduplicated: boolean,
): CandidateBuildProvenanceResult {
  return {
    stage: "candidate",
    deduplicated,
    candidate_bound: true,
    baseline_artifact_sha256_prefix: input.baseline_artifact_sha256.slice(0, 12),
    artifact_sha256_prefix: input.artifact_sha256.slice(0, 12),
    build_environment_sha256_prefix: input.build_environment_sha256.slice(0, 12),
    execution_profile: input.execution_profile,
    strong_isolation: input.strong_isolation,
    workspace_disk_quota_enforced: input.workspace_disk_quota_enforced,
    network_policy: input.network_policy,
    filesystem_write_isolation: input.filesystem_write_isolation,
    secret_filesystem_isolation: input.secret_filesystem_isolation,
    process_containment: input.process_containment,
    canonical_diff_sha256_prefix: input.canonical_diff_sha256.slice(0, 12),
    candidate_manifest_sha256_prefix: input.candidate_manifest_sha256.slice(0, 12),
    workspace_canonical_diff_sha256_prefix:
      input.workspace_canonical_diff_sha256.slice(0, 12),
    workspace_manifest_sha256_prefix: input.workspace_manifest_sha256.slice(0, 12),
    workspace_role: input.workspace_role,
    artifact_signing_identity_ref_sha256_prefix:
      input.artifact_signing_identity_ref_sha256.slice(0, 12),
    changed_files: [...input.changed_files],
    artifact_platform: input.artifact_platform,
    artifact_app_id: input.artifact_app_id,
    artifact_version: input.artifact_version,
    artifact_build: input.artifact_build,
    artifact_variant: input.artifact_variant,
    variant_source: input.variant_source,
    variant_artifact_derived: input.variant_artifact_derived,
  };
}

function publicCandidateVerificationResult(
  input: StoredCandidateVerificationProvenance,
  deduplicated: boolean,
): CandidateVerificationProvenanceResult {
  return {
    stage: "verification",
    deduplicated,
    candidate_bound: true,
    verified: true,
    verification_runs: 3,
    artifact_sha256_prefix: input.artifact_sha256.slice(0, 12),
    device_ref_sha256_prefix: input.device_ref_sha256.slice(0, 12),
    plan_sha256_prefix: input.plan_sha256.slice(0, 12),
    target_signature_version: input.target_signature_version,
    target_fingerprint: input.target_fingerprint,
    child_session_ref_sha256_prefixes: input.verification_child_session_ref_sha256s
      .map((value) => value.slice(0, 12)) as [string, string, string],
  };
}

function publicCandidateExportResult(
  input: CandidateExportProvenance,
  deduplicated: boolean,
  verificationRuns: 3 = 3,
): CandidateExportProvenanceResult {
  return {
    stage: "export",
    deduplicated,
    candidate_bound: true,
    verified: true,
    verification_runs: verificationRuns,
    exported: true,
    canonical_diff_sha256_prefix: input.canonical_diff_sha256.slice(0, 12),
    candidate_manifest_sha256_prefix: input.candidate_manifest_sha256.slice(0, 12),
    destination_ref_sha256_prefix: input.destination_ref_sha256.slice(0, 12),
  };
}

/**
 * Transition a session to a terminal status and run report generation while
 * holding the same cross-process lock used by recordCrashEvidence.
 *
 * A retry with the same terminal status is safe and re-runs the callback from
 * the immutable session snapshot. A different terminal status fails closed.
 */
export async function finalizeSession<T>(
  sessionDir: string,
  status: TerminalSessionStatus,
  operation: (context: FinalizeSessionContext) => Promise<T>,
  options: FinalizeSessionOptions = {},
): Promise<{ context: FinalizeSessionContext; value: T }> {
  assertSessionDir(sessionDir);
  if (!isTerminalSessionStatus(status)) {
    throw new TypeError("finalize status must be passed, failed, or aborted");
  }

  return withSessionLock(sessionDir, async () => {
    const meta = await loadMeta(sessionDir);
    assertKnownSessionStatus(meta.status);
    const steps = await readSteps(sessionDir);
    const crashes = await readCrashes(sessionDir);
    const childContext = childVerificationContextFromExtra(meta.extra);
    const completion = options.verificationEvidence === undefined
      ? undefined
      : childVerificationCompletionSchema.parse(options.verificationEvidence);

    await assertCrashfixFinalization(sessionDir, meta, status);

    let alreadyFinalized = false;
    if (meta.status === "running") {
      if (meta.verification !== undefined) {
        throw new Error("running session must not contain finalized verification evidence");
      }
      meta.verification = buildChildVerificationRecord(
        status,
        childContext,
        completion,
        steps,
        crashes,
      );
      meta.status = status;
      meta.ended_at = new Date().toISOString();
      await writeMeta(sessionDir, meta);
    } else if (meta.status === status) {
      if (!isValidTerminalTimestamp(meta)) {
        throw new Error("finalized session metadata is missing ended_at");
      }
      assertFinalizedChildVerificationRetry(
        status,
        meta,
        childContext,
        completion,
        steps,
        crashes,
      );
      alreadyFinalized = true;
    } else {
      throw new Error(
        `cannot finalize session as ${status}: already finalized as ${meta.status}`,
      );
    }

    const context: FinalizeSessionContext = {
      meta,
      steps,
      crashes,
      already_finalized: alreadyFinalized,
    };
    const value = await operation(context);
    return { context, value };
  });
}

async function assertCrashfixFinalization(
  sessionDir: string,
  meta: SessionMeta,
  status: TerminalSessionStatus,
): Promise<void> {
  const extra = meta.extra;
  if (extra?.provenance_status === undefined) return;
  const provenanceStatus = crashfixProvenanceStatusSchema.parse(
    extra.provenance_status,
  );
  if (meta.source_lock === undefined) {
    throw new Error("CrashFix sessions require an immutable Firebase source_lock");
  }
  const sourceLock = remoteSourceLockSchema.parse(meta.source_lock);
  assertCrashfixSourceLockMetadata(extra, sourceLock);
  await assertStoredCrashfixAnalysis(sessionDir, meta);
  if (status !== "passed") return;
  if (!hasOwn(extra, "requested_mode")) {
    throw new Error(
      "legacy CrashFix sessions without requested_mode cannot finalize as passed",
    );
  }
  const requestedMode = crashfixRequestedModeSchema.parse(extra.requested_mode);
  if (hasOwn(extra, "preflight_abort")) {
    crashfixPreflightAbortReasonSchema.parse(extra.preflight_abort);
    throw new Error("a preflight-aborted CrashFix session cannot finalize as passed");
  }
  if (provenanceStatus === "resolved") {
    crashfixProvenanceModeSchema.parse(extra.provenance_mode);
  } else if (hasOwn(extra, "provenance_mode")) {
    throw new Error("unavailable CrashFix provenance must omit provenance_mode");
  }
  await loadUniqueArchivedFirebaseTarget(sessionDir, extra);
  if (meta.status === "running" && meta.crashfix_analysis === undefined) {
    throw new Error(
      "a running CrashFix session requires a bound analysis before passed finalize",
    );
  }

  if (requestedMode === "pr") {
    throw new Error("requested_mode=pr is not passable by the current snapshot-only Runner");
  }
  if (extra.requested_workflow === "quick_test" && requestedMode === "patch") {
    throw new Error(
      "quick_test parent sessions must finalize as analyze; local edits belong to a devtest child",
    );
  }
  if (requestedMode === "analyze") {
    const candidateKeys = presentKeys(extra, SNAPSHOT_CANDIDATE_EXTRA_KEYS);
    if (candidateKeys.length > 0) {
      throw new Error("requested_mode=analyze must not contain candidate provenance");
    }
    if (
      provenanceStatus === "resolved"
      && extra.provenance_mode === "snapshot_repro_equivalent"
    ) {
      requireStoredSnapshotProvenance(extra);
    }
    return;
  }

  if (meta.crashfix_analysis?.confidence !== "high") {
    throw new Error(
      "passed patch sessions require confidence=high CrashFix analysis",
    );
  }

  if (
    provenanceStatus !== "resolved"
    || extra.provenance_mode !== "snapshot_repro_equivalent"
  ) {
    throw new Error(
      "passed patch sessions require resolved snapshot_repro_equivalent provenance",
    );
  }
  assertCrashfixCandidateLifecycle(extra);
  const sourceProvenance = requireStoredSnapshotProvenance(extra);
  const requestedProfile = requestedExecutionProfileFromExtra(extra);
  const candidate = requireStoredCandidateBuildProvenance(extra);
  assertCandidateChangedFilesDoNotArchiveFixturePaths(sourceProvenance, candidate);
  assertCandidateMatchesRequestedExecutionProfile(candidate, requestedProfile);
  assertCandidateMatchesBoundTarget(candidate, requireBoundCrashfixTarget(extra));
  await assertCandidateMatchesArchivedFirebaseTarget(sessionDir, candidate, extra);
  const verification = requireStoredCandidateVerificationProvenance(extra, candidate);
  const exported = candidateExportProvenanceSchema.safeParse({
    stage: "export",
    canonical_diff_sha256: candidate.canonical_diff_sha256,
    candidate_manifest_sha256: candidate.candidate_manifest_sha256,
    destination_ref_sha256: extra.destination_ref_sha256,
  });
  if (!exported.success) {
    throw new Error("passed patch session requires complete export provenance");
  }
  await revalidateStoredVerificationChildren(
    sessionDir,
    meta,
    candidate,
    verification,
  );
}

function buildChildVerificationRecord(
  status: TerminalSessionStatus,
  context: ChildVerificationContext | undefined,
  completion: ChildVerificationCompletion | undefined,
  steps: StepRecord[],
  crashes: CrashRecord[],
): ChildVerificationRecord | undefined {
  if (context === undefined) {
    if (completion !== undefined) {
      throw new Error("verification_evidence requires an immutable child context");
    }
    return undefined;
  }
  if (status !== "passed") {
    if (completion !== undefined) {
      throw new Error("verification_evidence is only valid when finalizing as passed");
    }
    return undefined;
  }
  if (completion === undefined) {
    throw new Error(
      "a passed verification child requires structured verification_evidence",
    );
  }
  assertVerificationRunObservations(context, steps, crashes);
  return childVerificationRecordSchema.parse({
    ...context,
    ...completion,
    target_signature_occurrences: 0,
    crash_records: 0,
    passed_steps: steps.length,
  });
}

function assertFinalizedChildVerificationRetry(
  status: TerminalSessionStatus,
  meta: SessionMeta,
  context: ChildVerificationContext | undefined,
  completion: ChildVerificationCompletion | undefined,
  steps: StepRecord[],
  crashes: CrashRecord[],
): void {
  if (context === undefined) {
    if (completion !== undefined || meta.verification !== undefined) {
      throw new Error("finalized verification evidence has no immutable child context");
    }
    return;
  }
  if (status !== "passed") {
    if (completion !== undefined || meta.verification !== undefined) {
      throw new Error("non-passed verification child must not contain verified evidence");
    }
    return;
  }
  if (completion === undefined) {
    throw new Error("verification child finalize retry requires the same verification_evidence");
  }
  const record = childVerificationRecordSchema.safeParse(meta.verification);
  if (!record.success || !sameChildVerificationContext(record.data, context)) {
    throw new Error("finalized verification child evidence is missing or conflicts with context");
  }
  assertPassedVerificationRun(context, steps, crashes, record.data);
}

function assertVerificationRunObservations(
  context: ChildVerificationContext,
  steps: StepRecord[],
  crashes: CrashRecord[],
): void {
  const targetOccurrences = crashes.filter((crash) =>
    crash.signature_version === context.verification_target_signature_version
    && crash.signature === context.verification_target_fingerprint
  ).length;
  if (targetOccurrences > 0) {
    throw new Error("verification child observed the target analyzer signature identity");
  }
  // A verified CrashFix run is stronger than target-only absence: any archived
  // crash/ANR invalidates the child rather than being hidden behind a different
  // fingerprint.
  if (crashes.length !== 0) {
    throw new Error("verification child contains crash evidence and cannot be verified");
  }
  if (steps.length === 0 || steps.some((step) => step.result !== "ok")) {
    throw new Error("verification child requires at least one step and every step must pass");
  }
}

function assertPassedVerificationRun(
  context: ChildVerificationContext,
  steps: StepRecord[],
  crashes: CrashRecord[],
  record: ChildVerificationRecord,
): void {
  if (!sameChildVerificationContext(record, context)) {
    throw new Error("verification child evidence conflicts with its immutable context");
  }
  assertVerificationRunObservations(context, steps, crashes);
  if (
    record.target_signature_occurrences !== 0
    || record.crash_records !== 0
    || record.passed_steps !== steps.length
  ) {
    throw new Error("verification child derived counters do not match session evidence");
  }
}

function sameChildVerificationContext(
  record: ChildVerificationRecord,
  context: ChildVerificationContext,
): boolean {
  return record.verification_schema_version === context.verification_schema_version
    && record.verification_parent_session_id === context.verification_parent_session_id
    && record.verification_run === context.verification_run
    && record.artifact_sha256 === context.artifact_sha256
    && record.device_ref_sha256 === context.device_ref_sha256
    && record.plan_sha256 === context.plan_sha256
    && record.verification_target_signature_version
      === context.verification_target_signature_version
    && record.verification_target_fingerprint === context.verification_target_fingerprint
    && record.platform === context.platform
    && record.type === "real";
}

function isValidTerminalTimestamp(meta: SessionMeta): boolean {
  if (typeof meta.ended_at !== "string" || meta.ended_at.length === 0) return false;
  const startedAt = Date.parse(meta.started_at);
  const endedAt = Date.parse(meta.ended_at);
  return Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt;
}

function sameCrashSource(left: CrashSource, right: CrashSource): boolean {
  for (const field of [
    "provider",
    "external_key",
    "project",
    "app",
    "issue",
    "event",
    "occurred",
  ] as const) {
    if (left[field] !== right[field]) return false;
  }
  for (const field of ["platform", "app_id", "version", "build"] as const) {
    if (left.app_build?.[field] !== right.app_build?.[field]) return false;
  }
  const leftMetrics = Object.entries(left.metrics ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightMetrics = Object.entries(right.metrics ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return leftMetrics.length === rightMetrics.length
    && leftMetrics.every(([key, value], index) => {
      const other = rightMetrics[index];
      return other?.[0] === key && other[1] === value;
    });
}

function assertRemoteSourceLock(
  meta: SessionMeta,
  source: CrashSource | undefined,
  requestedRoute: CrashAcquisitionRoute | undefined,
): void {
  const lock = meta.source_lock === undefined
    ? undefined
    : remoteSourceLockSchema.parse(meta.source_lock);
  const isFirebaseSource = source?.provider === FIREBASE_CRASHLYTICS_PROVIDER;

  if (lock === undefined) {
    if (requestedRoute !== undefined) {
      throw new Error("acquisition_route requires a session source_lock");
    }
    if (isFirebaseSource) {
      throw new Error(
        "firebase-crashlytics evidence requires a locked remote acquisition route",
      );
    }
    return;
  }

  if (!isFirebaseSource || source?.provider !== lock.provider) {
    throw new Error(
      "source-locked session only accepts evidence from its locked remote provider",
    );
  }
  if (requestedRoute === undefined) {
    throw new Error("source-locked session requires acquisition_route for every crash");
  }
  const route = crashAcquisitionRouteSchema.parse(requestedRoute);
  if (route !== lock.acquisition_route) {
    throw new Error("acquisition_route does not match the session source_lock");
  }
  if (meta.extra?.provenance_status !== undefined) {
    assertCrashfixSourceLockMetadata(meta.extra, lock);
  }
}

function validateCrashSourceExternalKey(
  rawSource: unknown,
  signature: unknown,
  signatureVersion: CrashSignatureVersion | undefined,
  options: { allowLegacyFirebaseKeyWithoutVersion?: boolean } = {},
): CrashSource {
  const source = crashSourceSchema.parse(rawSource);
  if (source.provider !== FIREBASE_CRASHLYTICS_PROVIDER) return source;
  if (typeof signature !== "string" || signature.length === 0) {
    throw new TypeError(
      "firebase-crashlytics external_key validation requires a non-empty signature",
    );
  }

  if (
    signatureVersion === undefined
    && options.allowLegacyFirebaseKeyWithoutVersion !== true
  ) {
    throw new TypeError(
      "new firebase-crashlytics evidence requires signature_version",
    );
  }

  // crashSourceSchema has already established that these four fields exist.
  // Historical records omitted signature_version and used the six-component
  // key. Only readCrashes opts into that compatibility branch; every new write
  // uses the versioned identity tuple.
  const expected = createHash("sha256")
    .update(
      [
        source.provider,
        source.project,
        source.app,
        source.issue,
        source.event,
        ...(signatureVersion === undefined ? [] : [signatureVersion]),
        signature,
      ].join("\0"),
      "utf8",
    )
    .digest("hex");
  if (source.external_key !== expected) {
    throw new Error(
      "firebase-crashlytics external_key does not match the normalized source identity, signature_version, and signature",
    );
  }
  return source;
}

function assertCrashEvidenceInput(sessionDir: string, input: CrashEvidenceInput): void {
  assertSessionDir(sessionDir);
  assertBoundedString(input.signature, "signature", MAX_CRASH_SIGNATURE_CHARS);
  if (input.signature_version !== undefined) {
    const signatureVersion = crashSignatureVersionSchema.parse(input.signature_version);
    assertVersionedAnalyzerFingerprint(input.signature, signatureVersion);
  }
  if (input.kind !== undefined) {
    assertBoundedString(input.kind, "kind", MAX_CRASH_KIND_CHARS);
  }
  if (typeof input.stack !== "string" || input.stack.length === 0) {
    throw new TypeError("stack must be a non-empty string");
  }
  if (Buffer.byteLength(input.stack, "utf8") > MAX_CRASH_STACK_BYTES) {
    throw new RangeError(`stack exceeds ${MAX_CRASH_STACK_BYTES} byte size limit`);
  }
  if (
    input.step_index !== undefined &&
    (!Number.isSafeInteger(input.step_index) || input.step_index < 0)
  ) {
    throw new TypeError("step_index must be a non-negative safe integer");
  }
  if (!Array.isArray(input.repro_path)) throw new TypeError("repro_path must be an array");
  if (input.repro_path.length > MAX_REPRO_PATH_ENTRIES) {
    throw new RangeError(
      `repro_path exceeds ${MAX_REPRO_PATH_ENTRIES} entry limit`,
    );
  }
  for (const [index, step] of input.repro_path.entries()) {
    if (!Number.isSafeInteger(step) || step < 0) {
      throw new TypeError(`repro_path[${index}] must be a non-negative safe integer`);
    }
  }
  if (input.log_full_src !== undefined) {
    if (
      input.log_full_src.length === 0 ||
      input.log_full_src.length > MAX_SESSION_PATH_CHARS ||
      input.log_full_src.includes("\0") ||
      !path.isAbsolute(input.log_full_src)
    ) {
      throw new TypeError("log_full_src must be a bounded absolute path");
    }
  }
}

function assertSessionDir(sessionDir: string): void {
  if (
    typeof sessionDir !== "string" ||
    sessionDir.length === 0 ||
    sessionDir.length > MAX_SESSION_PATH_CHARS ||
    sessionDir.includes("\0")
  ) {
    throw new TypeError("session_dir is invalid or too long");
  }
}

function assertBoundedString(value: unknown, label: string, maxChars: number): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (value.length > maxChars) {
    throw new RangeError(`${label} exceeds ${maxChars} character limit`);
  }
}

/**
 * Serialize one session mutation across processes with atomic mkdir(2).
 * Unknown/stale locks are never removed automatically; callers receive a hard
 * timeout and must inspect the owner metadata before manual recovery.
 */
export async function withSessionLock<T>(
  sessionDir: string,
  operation: () => Promise<T>,
  options: SessionLockOptions = {},
): Promise<T> {
  assertSessionDir(sessionDir);
  const timeoutMs = options.timeoutMs ?? SESSION_LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? SESSION_LOCK_RETRY_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new TypeError("session lock timeoutMs must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(retryMs) || retryMs < 1) {
    throw new TypeError("session lock retryMs must be a positive safe integer");
  }

  const resolvedSessionDir = path.resolve(sessionDir);
  await assertSecureSessionLayout(resolvedSessionDir);
  const lock = await acquireSessionLock(resolvedSessionDir, timeoutMs, retryMs);
  try {
    return await operation();
  } finally {
    await releaseSessionLock(lock);
  }
}

async function assertSecureSessionLayout(sessionDir: string): Promise<void> {
  const directoryNames = ["steps", "crashes", "logs"];
  const fileNames = ["meta.json", "steps.jsonl", "crashes.jsonl"];
  const root = await lstat(sessionDir);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("session_dir must be a real directory");
  }
  for (const name of directoryNames) {
    const metadata = await lstat(path.join(sessionDir, name));
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`session ${name} must be a real directory`);
    }
  }
  for (const name of fileNames) {
    const metadata = await lstat(path.join(sessionDir, name));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error(`session ${name} must be a single-link regular file`);
    }
  }
}

async function acquireSessionLock(
  sessionDir: string,
  timeoutMs: number,
  retryMs: number,
): Promise<AcquiredSessionLock> {
  const lockDir = path.join(sessionDir, SESSION_LOCK_DIRNAME);
  const ownerPath = path.join(lockDir, SESSION_LOCK_OWNER_FILENAME);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      const token = randomUUID();
      try {
        await writeFile(
          ownerPath,
          JSON.stringify({ token, pid: process.pid, acquired_at: new Date().toISOString() }),
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        // The directory was ours, but an incomplete/altered owner file is now
        // ambiguous. Leave it in place for explicit inspection and recovery.
        throw new Error(
          `session lock owner initialization failed; lock left intact at ${lockDir}`,
          { cause: error },
        );
      }
      return { lockDir, ownerPath, token };
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for session lock; `
          + `lock was not removed automatically: ${lockDir}`,
        );
      }
      await delay(Math.min(retryMs, remainingMs));
    }
  }
}

async function releaseSessionLock(lock: AcquiredSessionLock): Promise<void> {
  let owner: unknown;
  try {
    const sessionDir = path.dirname(lock.lockDir);
    const relativeOwnerPath = path.relative(sessionDir, lock.ownerPath);
    const ownerText = await readBoundedRegularTextFile(
      sessionDir,
      relativeOwnerPath,
      MAX_SESSION_LOCK_OWNER_BYTES,
      "session lock owner metadata",
    );
    owner = JSON.parse(ownerText);
  } catch (error) {
    throw new Error(
      `cannot verify session lock ownership; lock left intact at ${lock.lockDir}`,
      { cause: error },
    );
  }
  const parsedOwner = sessionLockOwnerSchema.safeParse(owner);
  if (!parsedOwner.success || parsedOwner.data.token !== lock.token) {
    throw new Error(
      `session lock ownership changed; lock left intact at ${lock.lockDir}`,
    );
  }

  // Rename first so a newly acquired lock can never be removed by this owner.
  const releaseDir = `${lock.lockDir}.release-${lock.token}`;
  await rename(lock.lockDir, releaseDir);
  await unlink(path.join(releaseDir, SESSION_LOCK_OWNER_FILENAME));
  await rmdir(releaseDir);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

function isTerminalSessionStatus(status: unknown): status is TerminalSessionStatus {
  return status === "passed" || status === "failed" || status === "aborted";
}

function assertKnownSessionStatus(status: unknown): asserts status is SessionStatus {
  if (status !== "running" && !isTerminalSessionStatus(status)) {
    throw new Error("session metadata contains an invalid status");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function listSessions(workspaceRoot?: string): Promise<
  Array<{ id: string; dir: string; status: SessionStatus; started_at: string }>
> {
  const root = resolveWorkspaceRoot(workspaceRoot);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: Array<{ id: string; dir: string; status: SessionStatus; started_at: string }> = [];
  for (const name of entries) {
    const dir = path.join(root, name);
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) continue;
      const meta = await loadMeta(dir);
      out.push({ id: meta.id, dir, status: meta.status, started_at: meta.started_at });
    } catch {
      // skip unreadable
    }
  }
  out.sort((a, b) => b.started_at.localeCompare(a.started_at));
  return out;
}
