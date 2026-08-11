import path from "node:path";
import { createHash } from "node:crypto";
import {
  assertCrashfixReportInput,
  assertCrashfixAnalysisForReport,
  assertCrashfixStepEvidence,
  buildRunnerExecutionProfileSchema,
  crashfixWorkspaceProjectClassificationSchema,
  crashfixRequestedModeSchema,
  crashfixRequestedWorkflowSchema,
  candidateBuildProvenanceSchema,
  candidateExportProvenanceSchema,
  isCrashfixSessionMeta,
  MAX_CRASHES_PER_SESSION,
  MAX_STEPS_PER_SESSION,
  publicTextContainsSourceIdentifier,
  storedCandidateVerificationProvenanceSchema,
  type CrashRecord,
  type CrashSignatureVersion,
  type CrashSource,
  type SessionMeta,
  type StepRecord,
  snapshotProvenanceSchema,
  readBoundedRegularTextFile,
  writePrivateTextFile,
  type BoundedTextReadOptions,
} from "./sessions.js";
import {
  formatReportDuration,
  formatReportStatus,
  formatStepAction,
  getReportCopy,
  resolveReportLanguage,
  type ReportLanguage,
} from "./report-i18n.js";

/** A generated report is intentionally bounded even when session JSONL is larger. */
export const MAX_REPORT_BYTES = 32 * 1024 * 1024;

export interface RenderInput {
  meta: SessionMeta;
  steps: StepRecord[];
  crashes: CrashRecord[];
  /** Free-form summary the agent wants to surface at the top. */
  summary?: string;
}

// The report/viewer projections have a closed shape. These limits cover the
// maximum 10,000 step objects, 1,000 crash objects (including source/metrics
// containers), analysis/lifecycle metadata, and generous schema headroom.
// Numeric repro-path entries are traversed but do not consume a string budget.
const MAX_PUBLIC_PROJECTION_CONTAINERS =
  MAX_STEPS_PER_SESSION * 3 + MAX_CRASHES_PER_SESSION * 8 + 4_096;
const MAX_PUBLIC_PROJECTION_STRINGS =
  MAX_STEPS_PER_SESSION * 8 + MAX_CRASHES_PER_SESSION * 24 + 4_096;
const MAX_PUBLIC_PROJECTION_DEPTH = 16;

/**
 * Recheck the exact fields about to cross a report/viewer boundary.  Firebase
 * ids remain available in the private CrashRecord source for mechanical
 * binding, but no public string value may repeat them. Object keys belong to
 * the fixed projection schema and are deliberately not treated as source data.
 */
export function assertCrashfixPublicProjectionOmitsSourceIdentifiers(
  _meta: SessionMeta,
  crashes: readonly CrashRecord[],
  projection: unknown,
): void {
  const identifiers = new Set<string>();
  for (const crash of crashes) {
    if (crash.source?.provider !== "firebase-crashlytics") continue;
    for (const identifier of [
      crash.source.external_key,
      crash.source.project,
      crash.source.app,
      crash.source.issue,
      crash.source.event,
    ]) {
      if (typeof identifier === "string" && identifier.length > 0) {
        identifiers.add(identifier);
      }
    }
  }
  if (identifiers.size === 0) return;

  const sourceIdentifiers = [...identifiers];
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: projection, depth: 0 },
  ];
  const seenContainers = new WeakSet<object>();
  let containers = 0;
  let strings = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > MAX_PUBLIC_PROJECTION_DEPTH) {
      throw new Error("CrashFix public projection exceeds its privacy scan budget");
    }
    if (typeof current.value === "string") {
      strings += 1;
      if (strings > MAX_PUBLIC_PROJECTION_STRINGS) {
        throw new Error("CrashFix public projection exceeds its privacy scan budget");
      }
      if (sourceIdentifiers.some((identifier) =>
        publicTextContainsSourceIdentifier(current.value as string, identifier)
      )) {
        throw new Error(
          "CrashFix public projection must not repeat Firebase target or event identifiers",
        );
      }
      continue;
    }
    if (current.value === null || typeof current.value !== "object") continue;
    if (seenContainers.has(current.value)) continue;
    seenContainers.add(current.value);
    containers += 1;
    if (containers > MAX_PUBLIC_PROJECTION_CONTAINERS) {
      throw new Error("CrashFix public projection exceeds its privacy scan budget");
    }

    // Public field names come from a fixed schema and cannot carry source
    // data. Inspect enumerable values only; scanning keys makes a private id
    // such as `id` collide with the fixed public `id` key.
    for (const value of Array.isArray(current.value)
      ? current.value
      : Object.values(current.value)) {
      pending.push({ value, depth: current.depth + 1 });
    }
  }
}

/** Build and validate only the fields that Markdown/HTML actually render. */
export function assertCrashfixPublicReportFields(
  meta: SessionMeta,
  steps: readonly StepRecord[],
  crashes: readonly CrashRecord[],
  publicExtra: Record<string, string | number | boolean | string[]>,
  summary?: string,
): void {
  const analysis = meta.crashfix_analysis;
  assertCrashfixPublicProjectionOmitsSourceIdentifiers(meta, crashes, {
    id: meta.id,
    name: meta.name,
    ...(summary === undefined ? {} : { summary }),
    extra: publicExtra,
    ...(analysis === undefined
      ? {}
      : {
          analysis: {
            target_signature_version: analysis.target_signature_version,
            target_fingerprint: analysis.target_fingerprint,
            root_cause_summary: analysis.root_cause_summary,
            confidence: analysis.confidence,
            category: analysis.category,
            locations: analysis.locations,
            remediation_summary: analysis.remediation_summary,
            limitations: analysis.limitations,
          },
        }),
    steps: steps.map((step) => ({
      action: step.action,
      ...(step.notes === undefined ? {} : { notes: step.notes }),
      ...(step.screenshot === undefined ? {} : { screenshot: step.screenshot }),
      ...(step.log_excerpt === undefined ? {} : { log_excerpt: step.log_excerpt }),
    })),
    crashes: crashes.map((crash) => ({
      id: crash.id,
      signature: crash.signature,
      ...(crash.kind === undefined ? {} : { kind: crash.kind }),
      stack_path: crash.stack_path,
      ...(crash.log_path === undefined ? {} : { log_path: crash.log_path }),
      ...(crash.source === undefined
        ? {}
        : { source: renderSourceSummary(crash.source, meta.report_language) }),
    })),
  });
}

const STATUS_ICON: Record<SessionMeta["status"], string> = {
  running: "🟡",
  passed: "✅",
  failed: "❌",
  aborted: "⚪",
};

const PUBLIC_EXTRA_KEYS = new Set([
  "artifact_sha256",
  "artifact_app_id",
  "artifact_build",
  "artifact_platform",
  "artifact_signing_identity_ref_sha256",
  "artifact_variant",
  "variant_source",
  "variant_artifact_derived",
  "artifact_version",
  "baseline_artifact_sha256",
  "build_environment_sha256",
  "execution_profile",
  "strong_isolation",
  "workspace_disk_quota_enforced",
  "network_policy",
  "filesystem_write_isolation",
  "secret_filesystem_isolation",
  "process_containment",
  "candidate_base_sha",
  "candidate_manifest_sha256",
  "canonical_diff_sha256",
  "workspace_manifest_sha256",
  "workspace_canonical_diff_sha256",
  "workspace_role",
  "changed_files",
  "commit",
  "device_ref_sha256",
  "destination_ref_sha256",
  "diff_sha256",
  "dynamic_exclusions_sha256",
  "approved_test_fixtures_sha256",
  "approved_test_fixture_count",
  "directories",
  "duration_min",
  "exclusion_policy_sha256",
  "files",
  "bytes",
  "max_steps",
  "origin",
  "package",
  "plan_sha256",
  "platform",
  "proc_name",
  "project_alias",
  "provenance_mode",
  "provenance_status",
  "provider",
  "raw_evidence_archived",
  "requested_execution_profile",
  "workspace_project_classification",
  "repo_alias",
  "requested_mode",
  "requested_workflow",
  "source_snapshot_sha256",
  "strategy",
  "target_fingerprint",
  "target_signature_version",
  "type",
]);
const RAW_DEVICE_KEYS = new Set([
  "device",
  "device_id",
  "device_name",
  "serial",
  "serial_number",
  "udid",
]);
const PUBLIC_PREFIXED_SHA256_KEYS = new Set([
  "artifact_sha256",
  "artifact_signing_identity_ref_sha256",
  "baseline_artifact_sha256",
  "build_environment_sha256",
  "candidate_manifest_sha256",
  "canonical_diff_sha256",
  "workspace_manifest_sha256",
  "workspace_canonical_diff_sha256",
  "destination_ref_sha256",
  "diff_sha256",
  "dynamic_exclusions_sha256",
  "approved_test_fixtures_sha256",
  "exclusion_policy_sha256",
  "plan_sha256",
  "source_snapshot_sha256",
]);
const SNAPSHOT_SOURCE_HASH_KEYS = [
  "source_snapshot_sha256",
  "exclusion_policy_sha256",
  "dynamic_exclusions_sha256",
  "approved_test_fixtures_sha256",
] as const;
const SNAPSHOT_SOURCE_COUNT_KEYS = [
  "approved_test_fixture_count",
  "files",
  "directories",
  "bytes",
] as const;
const APPROVED_TEST_FIXTURE_PUBLIC_BINDING_KEYS = new Set([
  "approved_test_fixtures_sha256",
  "approved_test_fixture_count",
]);
const SNAPSHOT_ONLY_HASH_KEYS = new Set([
  ...SNAPSHOT_SOURCE_HASH_KEYS,
  "candidate_manifest_sha256",
  "canonical_diff_sha256",
  "workspace_manifest_sha256",
  "workspace_canonical_diff_sha256",
  "destination_ref_sha256",
]);
const GIT_ONLY_KEYS = new Set(["candidate_base_sha", "commit"]);
const CANDIDATE_EXECUTION_PROFILE_KEYS = new Set([
  "execution_profile",
  "strong_isolation",
  "workspace_disk_quota_enforced",
  "network_policy",
  "filesystem_write_isolation",
  "secret_filesystem_isolation",
  "process_containment",
]);
const SNAPSHOT_CANDIDATE_LIFECYCLE_KEYS = new Set([
  "artifact_sha256",
  "artifact_app_id",
  "artifact_build",
  "artifact_platform",
  "artifact_signing_identity_ref_sha256",
  "artifact_variant",
  "variant_source",
  "variant_artifact_derived",
  "artifact_version",
  "baseline_artifact_sha256",
  "build_environment_sha256",
  "execution_profile",
  "strong_isolation",
  "workspace_disk_quota_enforced",
  "network_policy",
  "filesystem_write_isolation",
  "secret_filesystem_isolation",
  "process_containment",
  "candidate_manifest_sha256",
  "canonical_diff_sha256",
  "workspace_manifest_sha256",
  "workspace_canonical_diff_sha256",
  "workspace_role",
  "changed_files",
  "destination_ref_sha256",
  "device_ref_sha256",
  "plan_sha256",
  "target_fingerprint",
  "target_signature_version",
  "verification_runs",
  "verified",
]);
const GIT_CANDIDATE_KEYS = new Set([
  "artifact_sha256",
  "build_environment_sha256",
  "candidate_base_sha",
  "changed_files",
  "diff_sha256",
]);
const SHA256_LOWER_HEX_RE = /^[a-f0-9]{64}$/;
const GIT_OID_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_PUBLIC_ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const APPROVABLE_TEST_FIXTURE_CHANGED_FILE_RE =
  /\.(?:json|properties|conf|config|cfg|ini|toml|ya?ml|xml|auth)$/i;

function publicSha256Prefix(value: unknown): string | undefined {
  if (typeof value !== "string" || !SHA256_LOWER_HEX_RE.test(value)) return undefined;
  return value.slice(0, 12);
}

function publicAliasValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (
    !SAFE_PUBLIC_ALIAS_RE.test(value)
    || /[\/\\\u0000-\u001f\u007f]/.test(value)
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
  ) {
    return undefined;
  }
  return value;
}

function publicGitOidPrefix(value: unknown): string | undefined {
  if (typeof value !== "string" || !GIT_OID_RE.test(value)) return undefined;
  return value.slice(0, 12);
}

function publicChangedFiles(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const result: string[] = [];
  let totalChars = 0;
  for (const entry of value) {
    if (
      typeof entry !== "string"
      || entry.length === 0
      || entry.length > 4_096
      || /[\\\u0000-\u001f\u007f]/.test(entry)
      || path.posix.isAbsolute(entry)
      || path.win32.isAbsolute(entry)
      || /^[a-zA-Z]:/.test(entry)
      || path.posix.normalize(entry) !== entry
      || entry.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      return undefined;
    }
    totalChars += entry.length;
    if (totalChars > 32_768) return undefined;
    result.push(entry);
  }
  return result;
}

type PublicProvenance =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "unavailable" }
  | { status: "resolved"; mode: "git_release_exact" | "snapshot_repro_equivalent" };

function publicProvenance(extra: Record<string, unknown>): PublicProvenance {
  if (!Object.prototype.hasOwnProperty.call(extra, "provenance_status")) {
    return { status: "absent" };
  }
  if (extra.provenance_status === "unavailable") return { status: "unavailable" };
  if (extra.provenance_status !== "resolved") return { status: "invalid" };
  if (
    extra.provenance_mode !== "git_release_exact"
    && extra.provenance_mode !== "snapshot_repro_equivalent"
  ) {
    return { status: "invalid" };
  }
  return { status: "resolved", mode: extra.provenance_mode };
}

function publicSnapshotSource(
  extra: Record<string, unknown>,
): Record<string, string | number> | undefined {
  if (
    Object.keys(extra).some(
      (key) =>
        key.startsWith("approved_test_fixture")
        && !APPROVED_TEST_FIXTURE_PUBLIC_BINDING_KEYS.has(key),
    )
  ) {
    return undefined;
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
  if (!parsed.success) return undefined;
  const value = parsed.data;
  return {
    source_snapshot_sha256: value.source_snapshot_sha256.slice(0, 12),
    exclusion_policy_sha256: value.exclusion_policy_sha256.slice(0, 12),
    dynamic_exclusions_sha256: value.dynamic_exclusions_sha256.slice(0, 12),
    approved_test_fixtures_sha256:
      value.approved_test_fixtures_sha256.slice(0, 12),
    approved_test_fixture_count: value.approved_test_fixture_count,
    files: value.files,
    directories: value.directories,
    bytes: value.bytes,
  };
}

function publicSnapshotCandidate(
  extra: Record<string, unknown>,
): Record<string, string | number | boolean | string[]> | undefined {
  const hasRequestedExecutionProfile = Object.prototype.hasOwnProperty.call(
    extra,
    "requested_execution_profile",
  );
  const requestedExecutionProfile = buildRunnerExecutionProfileSchema.safeParse(
    extra.requested_execution_profile,
  );
  if (!hasRequestedExecutionProfile || !requestedExecutionProfile.success) {
    return undefined;
  }
  const candidate = candidateBuildProvenanceSchema.safeParse({
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
  if (!candidate.success) return undefined;
  const value = candidate.data;
  if (
    typeof extra.approved_test_fixture_count === "number"
    && extra.approved_test_fixture_count > 0
    && value.changed_files.some((relativePath) =>
      APPROVABLE_TEST_FIXTURE_CHANGED_FILE_RE.test(relativePath)
    )
  ) {
    return undefined;
  }
  if (
    value.execution_profile !== requestedExecutionProfile.data
  ) {
    return undefined;
  }
  const result: Record<string, string | number | boolean | string[]> = {
    baseline_artifact_sha256: value.baseline_artifact_sha256.slice(0, 12),
    artifact_sha256: value.artifact_sha256.slice(0, 12),
    build_environment_sha256: value.build_environment_sha256.slice(0, 12),
    execution_profile: value.execution_profile,
    strong_isolation: value.strong_isolation,
    workspace_disk_quota_enforced: value.workspace_disk_quota_enforced,
    network_policy: value.network_policy,
    filesystem_write_isolation: value.filesystem_write_isolation,
    secret_filesystem_isolation: value.secret_filesystem_isolation,
    process_containment: value.process_containment,
    canonical_diff_sha256: value.canonical_diff_sha256.slice(0, 12),
    candidate_manifest_sha256: value.candidate_manifest_sha256.slice(0, 12),
    workspace_canonical_diff_sha256:
      value.workspace_canonical_diff_sha256.slice(0, 12),
    workspace_manifest_sha256: value.workspace_manifest_sha256.slice(0, 12),
    workspace_role: value.workspace_role,
    changed_files: [...value.changed_files],
    artifact_platform: value.artifact_platform,
    artifact_app_id: value.artifact_app_id,
    artifact_version: value.artifact_version,
    artifact_build: value.artifact_build,
    artifact_variant: value.artifact_variant,
    variant_source: value.variant_source,
    variant_artifact_derived: value.variant_artifact_derived,
    artifact_signing_identity_ref_sha256:
      value.artifact_signing_identity_ref_sha256.slice(0, 12),
  };

  const verification = storedCandidateVerificationProvenanceSchema.safeParse({
    stage: "verification",
    artifact_sha256: value.artifact_sha256,
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
  if (!verification.success) return result;
  result.device_ref_sha256 = verification.data.device_ref_sha256.slice(0, 12);
  result.plan_sha256 = verification.data.plan_sha256.slice(0, 12);
  result.target_signature_version = verification.data.target_signature_version;
  result.target_fingerprint = verification.data.target_fingerprint;
  result.verification_runs = verification.data.verification_runs;
  result.verified = verification.data.verified;

  const exported = candidateExportProvenanceSchema.safeParse({
    stage: "export",
    canonical_diff_sha256: value.canonical_diff_sha256,
    candidate_manifest_sha256: value.candidate_manifest_sha256,
    destination_ref_sha256: extra.destination_ref_sha256,
  });
  if (exported.success) {
    result.destination_ref_sha256 = exported.data.destination_ref_sha256.slice(0, 12);
  }
  return result;
}

function publicGitCandidate(
  extra: Record<string, unknown>,
): Record<string, string | string[]> | undefined {
  const candidateBase = publicGitOidPrefix(extra.candidate_base_sha);
  const diff = publicSha256Prefix(extra.diff_sha256);
  const artifact = publicSha256Prefix(extra.artifact_sha256);
  const buildEnvironment = publicSha256Prefix(extra.build_environment_sha256);
  const changedFiles = publicChangedFiles(extra.changed_files);
  if (
    candidateBase === undefined
    || diff === undefined
    || artifact === undefined
    || buildEnvironment === undefined
    || changedFiles === undefined
    || changedFiles.length === 0
  ) {
    return undefined;
  }
  return {
    candidate_base_sha: candidateBase,
    diff_sha256: diff,
    artifact_sha256: artifact,
    build_environment_sha256: buildEnvironment,
    changed_files: changedFiles,
  };
}

function publicExtraValue(value: unknown): string | number | boolean | string[] | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
    const normalized = value.trim().slice(0, 512);
    if (
      normalized.length === 0
      || path.posix.isAbsolute(normalized)
      || path.win32.isAbsolute(normalized)
      || /^[a-zA-Z]:/.test(normalized)
    ) {
      return undefined;
    }
    return normalized;
  }
  if (Array.isArray(value) && value.length <= 100) {
    const strings = value.map((entry) => publicExtraValue(entry));
    if (strings.every((entry): entry is string => typeof entry === "string")) {
      return strings;
    }
  }
  return undefined;
}

/** Produce the bounded allowlisted view used by Markdown/HTML and viewers. */
export function publicSessionExtra(
  extra: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | string[]> {
  const result: Record<string, string | number | boolean | string[]> = {};
  if (!extra) return result;
  const provenance = publicProvenance(extra);
  const requestedExecutionProfile = buildRunnerExecutionProfileSchema.safeParse(
    extra.requested_execution_profile,
  );
  const requestedMode = crashfixRequestedModeSchema.safeParse(extra.requested_mode);
  const requestedWorkflow = crashfixRequestedWorkflowSchema.safeParse(
    extra.requested_workflow,
  );
  const workspaceProjectClassification =
    crashfixWorkspaceProjectClassificationSchema.safeParse(
      extra.workspace_project_classification,
    );
  const publicWorkflow = requestedWorkflow.success
    && (
      requestedWorkflow.data === "strict"
      || (
        requestedWorkflow.data === "quick_test"
        && provenance.status === "unavailable"
        && extra.requested_mode === "analyze"
        && extra.requested_execution_profile === "local_trusted"
        && extra.workspace_project_classification === "test"
      )
    )
    ? requestedWorkflow.data
    : undefined;
  if (provenance.status === "unavailable") {
    return {
      provenance_status: "unavailable",
      ...(requestedExecutionProfile.success
        ? { requested_execution_profile: requestedExecutionProfile.data }
        : {}),
      ...(requestedMode.success ? { requested_mode: requestedMode.data } : {}),
      ...(publicWorkflow !== undefined
        ? { requested_workflow: publicWorkflow }
        : {}),
      ...(workspaceProjectClassification.success
        ? { workspace_project_classification: workspaceProjectClassification.data }
        : {}),
    };
  }
  let snapshotSource: Record<string, string | number> | undefined;
  if (provenance.status === "resolved") {
    result.provenance_status = "resolved";
    result.provenance_mode = provenance.mode;
    if (requestedExecutionProfile.success) {
      result.requested_execution_profile = requestedExecutionProfile.data;
    }
    if (requestedMode.success) result.requested_mode = requestedMode.data;
    if (publicWorkflow !== undefined) {
      result.requested_workflow = publicWorkflow;
    }
    if (workspaceProjectClassification.success) {
      result.workspace_project_classification =
        workspaceProjectClassification.data;
    }
    if (provenance.mode === "snapshot_repro_equivalent") {
      snapshotSource = publicSnapshotSource(extra);
      if (snapshotSource !== undefined) {
        Object.assign(result, snapshotSource);
        const snapshotCandidate = publicSnapshotCandidate(extra);
        if (snapshotCandidate !== undefined) Object.assign(result, snapshotCandidate);
      }
    } else {
      const gitCandidate = publicGitCandidate(extra);
      if (gitCandidate !== undefined) Object.assign(result, gitCandidate);
    }
  }
  for (const [key, rawValue] of Object.entries(extra)) {
    if (RAW_DEVICE_KEYS.has(key) && typeof rawValue === "string" && rawValue.length > 0) {
      if (provenance.status === "absent") {
        result.device_ref_sha256 = createHash("sha256")
          .update(rawValue, "utf8")
          .digest("hex");
      }
      continue;
    }
    if (!PUBLIC_EXTRA_KEYS.has(key)) continue;
    // This initial CrashFix control is surfaced only through the validated
    // provenance branch above, never as an arbitrary generic string.
    if (
      key === "requested_execution_profile"
      || key === "requested_mode"
      || key === "requested_workflow"
      || key === "workspace_project_classification"
    ) continue;
    // Execution claims are public only as one cross-validated candidate group;
    // never surface an isolated claim from generic or damaged metadata.
    if (CANDIDATE_EXECUTION_PROFILE_KEYS.has(key)) continue;
    if (
      provenance.status !== "absent"
      && (SNAPSHOT_CANDIDATE_LIFECYCLE_KEYS.has(key) || GIT_CANDIDATE_KEYS.has(key))
    ) {
      continue;
    }
    if (key === "device_ref_sha256") {
      if (typeof rawValue === "string" && /^[a-f0-9]{64}$/.test(rawValue)) {
        result[key] = rawValue;
      }
      continue;
    }
    if (key === "provenance_mode" || key === "provenance_status") continue;
    if (SNAPSHOT_SOURCE_HASH_KEYS.includes(key as typeof SNAPSHOT_SOURCE_HASH_KEYS[number])) {
      continue;
    }
    if (SNAPSHOT_SOURCE_COUNT_KEYS.includes(key as typeof SNAPSHOT_SOURCE_COUNT_KEYS[number])) {
      continue;
    }
    if (SNAPSHOT_ONLY_HASH_KEYS.has(key)) {
      if (
        provenance.status !== "resolved"
        || provenance.mode !== "snapshot_repro_equivalent"
        || snapshotSource === undefined
      ) {
        continue;
      }
    }
    if (GIT_ONLY_KEYS.has(key)) {
      if (
        provenance.status === "invalid"
        || (provenance.status === "resolved" && provenance.mode !== "git_release_exact")
      ) {
        continue;
      }
      const prefix = publicGitOidPrefix(rawValue);
      if (prefix !== undefined) result[key] = prefix;
      continue;
    }
    if (key === "project_alias" || key === "repo_alias") {
      const alias = publicAliasValue(rawValue);
      if (alias !== undefined) result[key] = alias;
      continue;
    }
    if (PUBLIC_PREFIXED_SHA256_KEYS.has(key)) {
      if (provenance.status === "invalid") continue;
      const prefix = publicSha256Prefix(rawValue);
      if (prefix !== undefined) result[key] = prefix;
      continue;
    }
    if (key === "changed_files") {
      if (provenance.status === "invalid") continue;
      const files = publicChangedFiles(rawValue);
      if (files !== undefined) result[key] = files;
      continue;
    }
    const value = publicExtraValue(rawValue);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export interface PublicCrashfixLifecycle {
  workflow: "quick_test" | "strict";
  mode: "analyze" | "patch" | "pr";
  acquisitionRoute: "official_firebase_mcp" | "cloud_logging_mcp";
  provenanceStatus: "resolved" | "unavailable";
  provenanceMode?: "git_release_exact" | "snapshot_repro_equivalent";
  candidatePrepared: boolean;
  artifactSha256Prefix?: string;
  changedFiles: string[];
  verified: boolean;
  verificationRuns: 0 | 3;
  exported: boolean;
  destinationRefSha256Prefix?: string;
}

/**
 * Derive display-only CrashFix lifecycle facts from the already validated
 * public projection. It never accepts caller-declared verification in
 * isolation and never returns private target identifiers or full hashes.
 */
export function publicCrashfixLifecycle(
  meta: SessionMeta,
  publicExtra: Record<string, string | number | boolean | string[]>,
): PublicCrashfixLifecycle | undefined {
  if (!isCrashfixSessionMeta(meta) || meta.source_lock === undefined) {
    return undefined;
  }
  const workflow = publicExtra.requested_workflow;
  const mode = publicExtra.requested_mode;
  const provenanceStatus = publicExtra.provenance_status;
  if (
    (workflow !== "quick_test" && workflow !== "strict")
    || (mode !== "analyze" && mode !== "patch" && mode !== "pr")
    || (provenanceStatus !== "resolved" && provenanceStatus !== "unavailable")
  ) {
    return undefined;
  }
  const provenanceMode = publicExtra.provenance_mode;
  if (
    provenanceMode !== undefined
    && provenanceMode !== "git_release_exact"
    && provenanceMode !== "snapshot_repro_equivalent"
  ) {
    return undefined;
  }
  const artifactSha256Prefix = typeof publicExtra.artifact_sha256 === "string"
    ? publicExtra.artifact_sha256
    : undefined;
  const changedFiles = Array.isArray(publicExtra.changed_files)
    ? [...publicExtra.changed_files]
    : [];
  const candidatePrepared = artifactSha256Prefix !== undefined;
  const verified = candidatePrepared
    && publicExtra.verified === true
    && publicExtra.verification_runs === 3;
  const destinationRefSha256Prefix = verified
    && typeof publicExtra.destination_ref_sha256 === "string"
    ? publicExtra.destination_ref_sha256
    : undefined;
  return {
    workflow,
    mode,
    acquisitionRoute: meta.source_lock.acquisition_route,
    provenanceStatus,
    ...(provenanceMode === undefined ? {} : { provenanceMode }),
    candidatePrepared,
    ...(artifactSha256Prefix === undefined ? {} : { artifactSha256Prefix }),
    changedFiles,
    verified,
    verificationRuns: verified ? 3 : 0,
    exported: destinationRefSha256Prefix !== undefined,
    ...(destinationRefSha256Prefix === undefined
      ? {}
      : { destinationRefSha256Prefix }),
  };
}

function markdownSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/`/g, "\\u0060");
}

export function renderMarkdown(input: RenderInput): string {
  const { meta, steps, crashes, summary } = input;
  const language = resolveReportLanguage(meta.report_language);
  const copy = getReportCopy(language);
  const separator = language === "zh-CN" ? "：" : ":";
  const localizeCrashfixActions = isCrashfixSessionMeta(meta);
  assertCrashfixReportInput(meta, summary);
  assertCrashfixAnalysisForReport(meta, crashes);
  for (const step of steps) {
    assertCrashfixStepEvidence(meta, {
      action: step.action,
      ...(step.notes !== undefined ? { notes: step.notes } : {}),
      has_screenshot: step.screenshot !== undefined,
      has_log_excerpt: step.log_excerpt !== undefined,
    });
  }
  const passed = steps.filter((s) => s.result === "ok").length;
  const failed = steps.filter((s) => s.result === "fail").length;
  const duration = meta.ended_at
    ? formatReportDuration(
        new Date(meta.ended_at).getTime() - new Date(meta.started_at).getTime(),
        language,
      )
    : copy.inProgress;

  const lines: string[] = [];
  lines.push(`# ${STATUS_ICON[meta.status]} ${copy.session}${separator} ${meta.name}`);
  lines.push("");
  lines.push(`- **${copy.id}**${separator} \`${meta.id}\``);
  lines.push(`- **${copy.status}**${separator} ${formatReportStatus(meta.status, language)}`);
  lines.push(`- **${copy.started}**${separator} ${meta.started_at}`);
  if (meta.ended_at) lines.push(`- **${copy.ended}**${separator} ${meta.ended_at}`);
  lines.push(`- **${copy.duration}**${separator} ${duration}`);
  lines.push(`- **${copy.steps}**${separator} ${steps.length} (✅ ${passed}, ❌ ${failed})`);
  lines.push(`- **${copy.crashes}**${separator} ${crashes.length}`);
  const publicExtra = publicSessionExtra(meta.extra);
  assertCrashfixPublicReportFields(meta, steps, crashes, publicExtra, summary);
  const crashfixLifecycle = publicCrashfixLifecycle(meta, publicExtra);
  if (Object.keys(publicExtra).length > 0) {
    lines.push(`- **${copy.extra}**${separator} \`${markdownSafeJson(publicExtra)}\``);
  }
  if (
    publicExtra.execution_profile === "local_trusted"
    || publicExtra.requested_execution_profile === "local_trusted"
  ) {
    lines.push(
      `- **${copy.buildRunnerIsolation}**${separator} ⚠️ ${copy.localTrustedIsolationNotice.replace("local_trusted", "`local_trusted`")}`,
    );
  }
  lines.push("");

  if (summary) {
    lines.push(`## ${copy.summary}`);
    lines.push("");
    lines.push(summary.trim());
    lines.push("");
  }

  if (localizeCrashfixActions && meta.crashfix_analysis !== undefined) {
    const analysis = meta.crashfix_analysis;
    lines.push(`## 🔍 ${copy.rootCauseAnalysis}`);
    lines.push("");
    lines.push(`- **${copy.rootCause}**${separator} ${markdownPlainText(analysis.root_cause_summary)}`);
    lines.push(`- **${copy.confidence}**${separator} \`${analysis.confidence}\``);
    lines.push(`- **${copy.category}**${separator} \`${analysis.category}\``);
    if (analysis.locations.length > 0) {
      lines.push(`- **${copy.locations}**${separator}`);
      for (const location of analysis.locations) {
        const suffix = location.line === undefined ? "" : `:${location.line}`;
        const symbol = location.symbol === undefined
          ? ""
          : ` — <code>${htmlSafeText(location.symbol)}</code>`;
        lines.push(
          `  - <code>${htmlSafeText(`${location.path}${suffix}`)}</code>${symbol}`,
        );
      }
    }
    lines.push(`- **${copy.remediation}**${separator} ${markdownPlainText(analysis.remediation_summary)}`);
    if (analysis.limitations.length > 0) {
      lines.push(`- **${copy.limitations}**${separator}`);
      for (const limitation of analysis.limitations) {
        lines.push(`  - ${markdownPlainText(limitation)}`);
      }
    }
    lines.push("");
  }

  if (crashfixLifecycle !== undefined) {
    const provenance = crashfixLifecycle.provenanceMode === undefined
      ? crashfixLifecycle.provenanceStatus
      : `${crashfixLifecycle.provenanceStatus} / ${crashfixLifecycle.provenanceMode}`;
    const candidate = crashfixLifecycle.candidatePrepared
      ? `${copy.candidatePrepared}${crashfixLifecycle.artifactSha256Prefix === undefined
        ? ""
        : ` (artifact sha256:${crashfixLifecycle.artifactSha256Prefix})`}`
      : copy.candidateMissing;
    const exported = crashfixLifecycle.exported
      ? `${copy.exported}${crashfixLifecycle.destinationRefSha256Prefix === undefined
        ? ""
        : ` (destination sha256:${crashfixLifecycle.destinationRefSha256Prefix})`}`
      : copy.notExported;
    lines.push(`## 🛠️ ${copy.crashfixLifecycle}`);
    lines.push("");
    lines.push(`- **${copy.workflow}**${separator} \`${crashfixLifecycle.workflow}\``);
    lines.push(`- **${copy.mode}**${separator} \`${crashfixLifecycle.mode}\``);
    lines.push(`- **${copy.acquisitionRoute}**${separator} \`${crashfixLifecycle.acquisitionRoute}\``);
    lines.push(`- **${copy.provenance}**${separator} \`${provenance}\``);
    lines.push(`- **${copy.candidate}**${separator} ${candidate}`);
    if (crashfixLifecycle.changedFiles.length > 0) {
      lines.push(`- **${copy.changedFiles}**${separator}`);
      for (const relativePath of crashfixLifecycle.changedFiles) {
        lines.push(`  - <code>${htmlSafeText(relativePath)}</code>`);
      }
    }
    lines.push(
      `- **${copy.verification}**${separator} ${crashfixLifecycle.verified
        ? copy.verificationPassed
        : copy.verificationMissing}`,
    );
    lines.push(`- **${copy.exportStatus}**${separator} ${exported}`);
    lines.push("");
  }

  if (crashes.length > 0) {
    lines.push(`## 🐛 ${copy.crashes}`);
    lines.push("");
    for (const c of crashes) {
      lines.push(`### ${c.id} · ${c.kind ?? copy.unknown} · ${escape(c.signature)}`);
      lines.push("");
      lines.push(`- **${copy.at}**${separator} ${c.ts}`);
      lines.push(`- **${copy.signatureVersion}**${separator} \`${publicCrashSignatureVersion(c.signature_version)}\``);
      if (
        c.signature_degraded !== undefined
        || c.cross_source_comparable !== undefined
      ) {
        lines.push(
          `- **${copy.analyzerIdentity}**${separator} degraded=\`${String(c.signature_degraded ?? copy.unknown)}\`, cross-source-comparable=\`${String(c.cross_source_comparable ?? copy.unknown)}\``,
        );
      }
      if (c.step_index !== undefined) {
        lines.push(`- **${copy.detectedAfterStep}**${separator} #${c.step_index}`);
      }
      if (c.repro_path.length > 0) {
        lines.push(`- **${copy.reproPathSteps}**${separator} ${c.repro_path.map((i) => `#${i}`).join(" → ")}`);
      }
      if (c.source) {
        lines.push(`- **${copy.source}**${separator} ${renderSourceSummary(c.source, language)}`);
      }
      lines.push(`- **${copy.stack}**${separator} [\`${c.stack_path}\`](${c.stack_path})`);
      if (c.log_path) {
        lines.push(`- **${copy.fullLog}**${separator} [\`${c.log_path}\`](${c.log_path})`);
      }
      lines.push("");
    }
  }

  lines.push(`## ${copy.steps}`);
  lines.push("");
  if (steps.length === 0) {
    lines.push(`_${copy.noStepsRecorded}_`);
  } else {
    for (const s of steps) {
      const icon =
        s.result === "ok" ? "✅" : s.result === "fail" ? "❌" : s.result === "skip" ? "⏭️" : "·";
      const displayedAction = localizeCrashfixActions
        ? formatStepAction(s.action, language)
        : s.action;
      lines.push(`### ${icon} ${copy.step} #${s.index} — ${escape(displayedAction)}`);
      lines.push("");
      lines.push(`- **${copy.at}**${separator} ${s.ts}`);
      if (s.screenshot) {
        lines.push(`- **${copy.screenshot}**${separator} ![](${s.screenshot})`);
      }
      if (s.log_excerpt) {
        lines.push(`- **${copy.log}**${separator} [\`${s.log_excerpt}\`](${s.log_excerpt})`);
      }
      if (s.notes) {
        lines.push("");
        lines.push("> " + s.notes.replace(/\n/g, "\n> "));
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

/** Closed public label; invalid direct renderer input never reaches the report. */
export function publicCrashSignatureVersion(
  value: unknown,
): CrashSignatureVersion | "unversioned" {
  switch (value) {
    case "v1":
    case "java-v2":
    case "ios-v2":
      return value;
    default:
      return "unversioned";
  }
}

/** Render only a provider, an opaque correlation ref, and occurrence time. */
export function renderSourceSummary(
  source: CrashSource,
  language?: ReportLanguage,
): string {
  const copy = getReportCopy(language);
  const opaqueRef = createHash("sha256")
    // external_key is the provider-neutral idempotency identity. Hashing it
    // again avoids exposing or correlating low-entropy provider issue ids.
    .update(source.external_key, "utf8")
    .digest("hex")
    .slice(0, 10);
  return [
    escape(source.provider),
    `${copy.referenceSha256}:${opaqueRef}`,
    ...(source.occurred ? [`${copy.occurred} ${escape(source.occurred)}`] : []),
  ].join(" · ");
}

function escape(s: string): string {
  return s.replace(/[\r\n]+/g, " ").slice(0, 200);
}

function htmlSafeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Keep accepted analysis prose plain when a Markdown viewer interprets it. */
function markdownPlainText(value: string): string {
  return htmlSafeText(value).replace(/[\\`*_{}\[\]()#+.!|>~-]/g, "\\$&");
}

export async function writeReport(
  sessionDir: string,
  content: string,
): Promise<string> {
  if (typeof content !== "string") {
    throw new TypeError("report content must be a string");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_REPORT_BYTES) {
    throw new RangeError(`report.md exceeds ${MAX_REPORT_BYTES} byte size limit`);
  }
  return writePrivateTextFile(sessionDir, "report.md", content);
}

export async function readReport(
  sessionDir: string,
  options: BoundedTextReadOptions = {},
): Promise<string> {
  return readBoundedRegularTextFile(
    sessionDir,
    "report.md",
    MAX_REPORT_BYTES,
    "report.md",
    options,
  );
}
