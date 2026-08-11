#!/usr/bin/env node
// report-mcp: sessions and markdown report generation.
// See PLAN.md §4.2 for the tool surface.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import path from "node:path";
import { lstat, unlink, writeFile } from "node:fs/promises";

import {
  appendStep,
  assertStoredCrashfixAnalysis,
  assertCrashfixReportInput,
  assertCrashfixStepEvidence,
  candidateBuildProvenanceShape,
  candidateExportProvenanceSchema,
  candidateProvenanceSchema,
  candidateVerificationProvenanceSchema,
  childVerificationCompletionSchema,
  copyRegularFilePrivate,
  crashAcquisitionRouteSchema,
  crashSignatureVersionSchema,
  crashSourceSchema,
  crashfixAnalysisSchema,
  crashfixTargetSchema,
  createSession,
  finalizeSession,
  listSessions,
  loadMeta,
  readCrashes,
  readSteps,
  recordCrashEvidence,
  recordCrashfixAnalysis,
  recordCrashfixTarget,
  recordCandidateProvenance,
  recordSnapshotProvenance,
  resolveSessionDir,
  resolveWorkspaceRoot,
  remoteSourceLockSchema,
  sessionExtraSchema,
  sessionNameSchema,
  snapshotProvenanceObjectSchema,
  snapshotProvenanceSchema,
  withSessionLock,
  type StepRecord,
  MAX_CRASH_KIND_CHARS,
  MAX_CRASH_SIGNATURE_CHARS,
  MAX_CRASH_STACK_BYTES,
  MAX_REPRO_PATH_ENTRIES,
  MAX_SESSION_ID_CHARS,
  MAX_SESSION_PATH_CHARS,
} from "./sessions.js";
import { renderMarkdown, writeReport } from "./report.js";
import { renderHtml, writeHtmlReport } from "./html-report.js";
import {
  DEFAULT_REPORT_LANGUAGE,
  reportLanguageSchema,
} from "./report-i18n.js";
import { publicDiagnostic } from "./public-diagnostic.js";
import {
  graphSummary,
  listSeenElements,
  markElementSeen,
  pickNextUnseen,
  recordEdge,
  recordPage,
} from "./graph.js";

const server = new McpServer({
  name: "report-mcp",
  version: "0.2.0",
});

const MAX_STEP_ACTION_CHARS = 16 * 1024;
const MAX_STEP_NOTES_CHARS = 64 * 1024;
const MAX_STEP_SCREENSHOT_BYTES = 32 * 1024 * 1024;
const MAX_STEP_LOG_BYTES = 16 * 1024 * 1024;
const SCREENSHOT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

type InternalRequestHandler = (
  request: unknown,
  extra: unknown,
) => unknown | Promise<unknown>;

type ToolInputSchema = Tool["inputSchema"];
type ToolInputSchemaOverride = (inputSchema: ToolInputSchema) => ToolInputSchema;
type ToolAnnotations = NonNullable<Tool["annotations"]>;

const READ_ONLY_LOCAL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const satisfies ToolAnnotations;
const ADDITIVE_LOCAL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const satisfies ToolAnnotations;
const IDEMPOTENT_LOCAL_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const satisfies ToolAnnotations;
const DESTRUCTIVE_LOCAL_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const satisfies ToolAnnotations;

/**
 * SDK 1.x validates these schemas correctly, but tools/list only recognizes
 * schemas exposing an object `shape`. Its JSON-schema converter already
 * supports ZodEffects and unions, so this marker preserves the strict runtime
 * parser while allowing the complete contract to reach the client.
 */
function exposeObjectShapeForToolList<T extends z.ZodTypeAny>(
  schema: T,
  shape: z.ZodRawShape,
): T {
  if (!("shape" in schema)) {
    Object.defineProperty(schema, "shape", {
      value: shape,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return schema;
}

const sessionSelectorConstraint = {
  oneOf: [
    {
      required: ["session_id"],
      not: { required: ["session_dir"] },
    },
    {
      required: ["session_dir"],
      not: {
        anyOf: [
          { required: ["session_id"] },
          { required: ["workspace_root"] },
        ],
      },
    },
  ],
} as const;

const candidateExecutionProfileConstraint = {
  if: {
    properties: { stage: { const: "candidate" } },
    required: ["stage"],
  },
  then: {
    oneOf: [
      {
        properties: {
          execution_profile: { const: "local_trusted" },
          strong_isolation: { const: false },
          workspace_disk_quota_enforced: { const: false },
          network_policy: { const: "not_enforced" },
          filesystem_write_isolation: { const: "not_enforced" },
          secret_filesystem_isolation: { const: "not_enforced" },
          process_containment: { const: "process_group_best_effort" },
        },
        required: [
          "execution_profile",
          "strong_isolation",
          "workspace_disk_quota_enforced",
          "network_policy",
          "filesystem_write_isolation",
          "secret_filesystem_isolation",
          "process_containment",
        ],
      },
      {
        properties: {
          execution_profile: { const: "docker_strict" },
          strong_isolation: { const: true },
          workspace_disk_quota_enforced: { const: true },
          network_policy: { const: "denied" },
          filesystem_write_isolation: { const: "enforced" },
          secret_filesystem_isolation: { const: "enforced" },
          process_containment: { const: "container+process_group" },
        },
        required: [
          "execution_profile",
          "strong_isolation",
          "workspace_disk_quota_enforced",
          "network_policy",
          "filesystem_write_isolation",
          "secret_filesystem_isolation",
          "process_containment",
        ],
      },
    ],
  },
} as const;

function withConstraint(
  inputSchema: ToolInputSchema,
  constraint: Readonly<Record<string, unknown>>,
): ToolInputSchema {
  const existing = Array.isArray(inputSchema.allOf) ? inputSchema.allOf : [];
  return { ...inputSchema, allOf: [...existing, constraint] };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function advertiseCandidateSchema(inputSchema: ToolInputSchema): ToolInputSchema {
  const branches = Array.isArray(inputSchema.anyOf)
    ? inputSchema.anyOf.map(asRecord).filter((value) => value !== undefined)
    : [];
  if (branches.length !== 3) {
    throw new Error("candidate provenance schema must advertise exactly three stages");
  }

  const properties: Record<string, object> = {};
  for (const branch of branches) {
    const branchProperties = asRecord(branch.properties);
    if (branchProperties === undefined) {
      throw new Error("candidate provenance stage is missing properties");
    }
    for (const [name, schema] of Object.entries(branchProperties)) {
      const propertySchema = asRecord(schema);
      if (propertySchema === undefined) {
        throw new Error(`candidate provenance property ${name} has an invalid schema`);
      }
      if (!(name in properties)) properties[name] = propertySchema;
    }
  }
  properties.stage = {
    type: "string",
    enum: ["candidate", "verification", "export"],
  };

  return {
    ...inputSchema,
    type: "object",
    properties,
    required: ["stage"],
    additionalProperties: false,
    allOf: [sessionSelectorConstraint, candidateExecutionProfileConstraint],
  };
}

/**
 * Wrap only tools/list so cross-field constraints remain machine-readable.
 * tools/call continues to validate against the original strict Zod schemas.
 */
function installToolListSchemaOverrides(
  mcpServer: McpServer,
  overrides: Readonly<Record<string, ToolInputSchemaOverride>>,
  annotationOverrides: Readonly<Record<string, ToolAnnotations>>,
): void {
  const protocol = mcpServer.server as unknown as {
    _requestHandlers: Map<string, InternalRequestHandler>;
  };
  const baseListTools = protocol._requestHandlers.get("tools/list");
  if (baseListTools === undefined) {
    throw new Error("tools/list handler is not installed");
  }
  mcpServer.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await baseListTools(request, extra) as ListToolsResult;
    return {
      ...result,
      tools: result.tools.map((tool) => {
        const override = overrides[tool.name];
        const annotations = annotationOverrides[tool.name];
        return {
          ...tool,
          ...(override === undefined
            ? {}
            : { inputSchema: override(tool.inputSchema) }),
          ...(annotations === undefined ? {} : { annotations }),
        };
      }),
    };
  });
}

function asText(payload: unknown) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function asError(err: unknown) {
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: publicDiagnostic(err),
      },
    ],
  };
}

// ---------- start_session ----------
server.tool(
  "start_session",
  "Create a new test session directory and return its id/path. Report language is immutable for the session and defaults to Simplified Chinese. Remote Firebase sessions must set source_lock before any acquisition; subsequent calls reference the session via session_id.",
  {
    name: sessionNameSchema.describe(
      "human-readable single-line session name, e.g. 'devtest-login'",
    ),
    workspace_root: z
      .string()
      .optional()
      .describe(
        "absolute path; defaults to APP_TEST_CTRL_WORKSPACE or <cwd>/workspace/sessions",
      ),
    extra: sessionExtraSchema.optional(),
    report_language: reportLanguageSchema
      .optional()
      .default(DEFAULT_REPORT_LANGUAGE)
      .describe(
        "immutable report display language; use en-US only when selected from the current user's language/request, otherwise zh-CN",
      ),
    source_lock: remoteSourceLockSchema
      .optional()
      .describe("strict immutable remote provider/acquisition route lock"),
  },
  async ({ name, workspace_root, extra, report_language, source_lock }) => {
    try {
      const created = await createSession({
        name,
        workspaceRoot: workspace_root,
        reportLanguage: report_language,
        sourceLock: source_lock,
        extra,
      });
      return asText({
        session_id: created.id,
        session_dir: created.dir,
        meta_path: created.meta_path,
      });
    } catch (err) {
      return asError(err);
    }
  },
);

const crashfixTargetToolObjectSchema = z
  .object({
    session_id: z.string().min(1).max(MAX_SESSION_ID_CHARS).optional(),
    session_dir: z.string().min(1).max(MAX_SESSION_PATH_CHARS).optional(),
    workspace_root: z.string().min(1).max(MAX_SESSION_PATH_CHARS).optional(),
    ...crashfixTargetSchema.shape,
  })
  .strict();

const crashfixTargetToolSchema = crashfixTargetToolObjectSchema.superRefine(
  (value, ctx) => {
    const selectors = Number(value.session_id !== undefined)
      + Number(value.session_dir !== undefined);
    if (selectors !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exactly one of session_id or session_dir is required",
      });
    }
    if (value.workspace_root !== undefined && value.session_id === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspace_root"],
        message: "workspace_root is only valid with session_id",
      });
    }
  },
);

// ---------- record_crashfix_target ----------
server.registerTool(
  "record_crashfix_target",
  {
    description:
      "Bind one user-selected Firebase project/app/issue/platform/version/build to a running CrashFix session before record_crash. The server persists and returns only domain-separated SHA-256 references; exact retries are idempotent.",
    inputSchema: exposeObjectShapeForToolList(
      crashfixTargetToolSchema,
      crashfixTargetToolObjectSchema.shape,
    ),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      const result = await recordCrashfixTarget(sessionDir, {
        project: input.project,
        app: input.app,
        issue: input.issue,
        app_build: input.app_build,
      });
      return asText({ ok: true, ...result });
    } catch (err) {
      return asError(err);
    }
  },
);

const crashfixAnalysisToolObjectSchema = z
  .object({
    session_id: z.string().min(1).max(MAX_SESSION_ID_CHARS).optional(),
    session_dir: z.string().min(1).max(MAX_SESSION_PATH_CHARS).optional(),
    workspace_root: z.string().min(1).max(MAX_SESSION_PATH_CHARS).optional(),
    ...crashfixAnalysisSchema.shape,
  })
  .strict();

const crashfixAnalysisToolSchema = crashfixAnalysisToolObjectSchema.superRefine(
  (value, ctx) => {
    const selectors = Number(value.session_id !== undefined)
      + Number(value.session_dir !== undefined);
    if (selectors !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exactly one of session_id or session_dir is required",
      });
    }
    if (value.workspace_root !== undefined && value.session_id === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspace_root"],
        message: "workspace_root is only valid with session_id",
      });
    }
  },
);

// ---------- record_crashfix_analysis ----------
server.registerTool(
  "record_crashfix_analysis",
  {
    description:
      "Atomically bind one privacy-bounded root-cause analysis to a running CrashFix session after its target and matching canonical analyzer evidence are archived. The top-level record is immutable; exact retries are idempotent and conflicting retries fail. This tool records no caller-declared build or verification success.",
    inputSchema: exposeObjectShapeForToolList(
      crashfixAnalysisToolSchema,
      crashfixAnalysisToolObjectSchema.shape,
    ),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      const result = await recordCrashfixAnalysis(sessionDir, {
        schema_version: input.schema_version,
        target_signature_version: input.target_signature_version,
        target_fingerprint: input.target_fingerprint,
        root_cause_summary: input.root_cause_summary,
        confidence: input.confidence,
        category: input.category,
        locations: input.locations,
        remediation_summary: input.remediation_summary,
        limitations: input.limitations,
      });
      return asText({ ok: true, ...result });
    } catch (err) {
      return asError(err);
    }
  },
);

const snapshotProvenanceToolObjectSchema = z
  .object({
    session_id: z.string().min(1).max(MAX_SESSION_ID_CHARS).optional(),
    session_dir: z.string().min(1).max(MAX_SESSION_PATH_CHARS).optional(),
    workspace_root: z.string().min(1).max(MAX_SESSION_PATH_CHARS).optional(),
    ...snapshotProvenanceObjectSchema.shape,
  })
  .strict();

const snapshotProvenanceToolSchema = snapshotProvenanceToolObjectSchema
  .superRefine((value, ctx) => {
    const selectors = Number(value.session_id !== undefined)
      + Number(value.session_dir !== undefined);
    if (selectors !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exactly one of session_id or session_dir is required",
      });
    }
    if (value.workspace_root !== undefined && value.session_id === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspace_root"],
        message: "workspace_root is only valid with session_id",
      });
    }
  });

// ---------- record_snapshot_provenance ----------
server.registerTool(
  "record_snapshot_provenance",
  {
    description:
      "Atomically bind a running CrashFix snapshot session to one sealed source identity and its approved-test-fixture set digest/count. The private manifest hash and all other identity fields are required and mechanically cross-checked; exact retries are idempotent, and no path/full hash is returned.",
    inputSchema: exposeObjectShapeForToolList(
      snapshotProvenanceToolSchema,
      snapshotProvenanceToolObjectSchema.shape,
    ),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      const result = await recordSnapshotProvenance(sessionDir, {
        manifest_sha256: input.manifest_sha256,
        source_snapshot_sha256: input.source_snapshot_sha256,
        exclusion_policy_sha256: input.exclusion_policy_sha256,
        dynamic_exclusions_sha256: input.dynamic_exclusions_sha256,
        approved_test_fixtures_sha256: input.approved_test_fixtures_sha256,
        approved_test_fixture_count: input.approved_test_fixture_count,
        files: input.files,
        directories: input.directories,
        bytes: input.bytes,
      });
      return asText({ ok: true, ...result });
    } catch (err) {
      return asError(err);
    }
  },
);

const candidateSessionSelectorShape = {
  session_id: z.string().min(1).max(MAX_SESSION_ID_CHARS).optional(),
  session_dir: z.string().min(1).max(MAX_SESSION_PATH_CHARS).optional(),
  workspace_root: z.string().min(1).max(MAX_SESSION_PATH_CHARS).optional(),
};

// Reuse the strict, bounded stage schemas in the advertised MCP contract.
// This avoids first accepting arbitrary-length optional fields and only
// rejecting them in a second validation pass.
const candidateProvenanceToolSchema = z
  .union([
    z.object({
      ...candidateBuildProvenanceShape,
      ...candidateSessionSelectorShape,
    }).strict(),
    candidateVerificationProvenanceSchema.extend(candidateSessionSelectorShape),
    candidateExportProvenanceSchema.extend(candidateSessionSelectorShape),
  ])
  .superRefine((value, ctx) => {
    const selectors = Number(value.session_id !== undefined)
      + Number(value.session_dir !== undefined);
    if (selectors !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exactly one of session_id or session_dir is required",
      });
    }
    if (value.workspace_root !== undefined && value.session_id === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspace_root"],
        message: "workspace_root is only valid with session_id",
      });
    }
    const {
      session_id: _sessionId,
      session_dir: _sessionDir,
      workspace_root: _workspaceRoot,
      ...rawProvenance
    } = value;
    const provenance = candidateProvenanceSchema.safeParse(rawProvenance);
    if (!provenance.success) {
      for (const issue of provenance.error.issues) {
        ctx.addIssue({ ...issue, path: issue.path });
      }
    }
  });

const candidateProvenanceToolObjectSchema = z
  .object({
    ...candidateSessionSelectorShape,
    ...z.object(candidateBuildProvenanceShape).partial().shape,
    ...candidateVerificationProvenanceSchema.partial().shape,
    ...candidateExportProvenanceSchema.partial().shape,
    stage: z.enum(["candidate", "verification", "export"]),
  })
  .strict();

// ---------- record_candidate_provenance ----------
server.registerTool(
  "record_candidate_provenance",
  {
    description:
      "Atomically advance a bound CrashFix snapshot candidate through candidate, structured child-session evidence, and export identity stages. Candidate creation requires an immutable confidence=high CrashFix analysis bound to the same archived analyzer identity. The candidate stage binds an honest execution profile: local_trusted is explicitly not strongly isolated, has no enforced workspace disk quota, and provides only best-effort process-group containment; docker_strict requires an enforced workspace disk quota, denied networking, enforced workspace-write and secret-filesystem isolation, and container plus process-group containment. The server derives 3/3 only after inspecting three distinct finalized children whose immutable contexts declare type=real; it validates stored steps/crashes but does not independently attest hardware or installation receipts. Callers cannot assert verification_runs. Only running resolved snapshot sessions with sealed source provenance are accepted; exact retries are idempotent and responses contain no paths or full hashes.",
    inputSchema: exposeObjectShapeForToolList(
      candidateProvenanceToolSchema,
      candidateProvenanceToolObjectSchema.shape,
    ),
  },
  async (input) => {
    try {
      const {
        session_id,
        session_dir,
        workspace_root,
        ...rawProvenance
      } = input;
      const provenance = candidateProvenanceSchema.parse(rawProvenance);
      const sessionDir = resolveSessionDir({
        sessionId: session_id,
        sessionDir: session_dir,
        workspaceRoot: workspace_root,
      });
      const result = await recordCandidateProvenance(sessionDir, provenance);
      return asText({ ok: true, ...result });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- record_step ----------
server.tool(
  "record_step",
  "Append one bounded step while the session is running. Step indexing and finalize are serialized by the session lock; imported screenshots/logs must be regular bounded files.",
  {
    session_id: z.string().optional(),
    session_dir: z.string().optional(),
    workspace_root: z.string().optional(),
    action: z.string().min(1).max(MAX_STEP_ACTION_CHARS),
    result: z.enum(["ok", "fail", "skip"]).optional(),
    screenshot_src: z
      .string()
      .min(1)
      .max(MAX_SESSION_PATH_CHARS)
      .optional()
      .describe("absolute path of an existing screenshot to import"),
    log_excerpt: z
      .string()
      .max(MAX_STEP_LOG_BYTES)
      .optional()
      .describe("inline log text; will be saved into steps/<idx>.log"),
    log_excerpt_src: z
      .string()
      .min(1)
      .max(MAX_SESSION_PATH_CHARS)
      .optional()
      .describe("absolute path of an existing log snippet to import"),
    notes: z.string().max(MAX_STEP_NOTES_CHARS).optional(),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      if (
        input.log_excerpt !== undefined
        && Buffer.byteLength(input.log_excerpt, "utf8") > MAX_STEP_LOG_BYTES
      ) {
        throw new RangeError(`log_excerpt exceeds ${MAX_STEP_LOG_BYTES} byte size limit`);
      }
      const step = await withSessionLock(sessionDir, async () => {
        const meta = await loadMeta(sessionDir);
        if (meta.status !== "running") {
          throw new Error(
            `cannot record step: session is not running (status=${meta.status})`,
          );
        }
        assertCrashfixStepEvidence(meta, {
          action: input.action,
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          has_screenshot: input.screenshot_src !== undefined,
          has_log_excerpt:
            input.log_excerpt !== undefined
            || input.log_excerpt_src !== undefined,
        });
        const stepsDir = path.join(sessionDir, "steps");
        const stepsMetadata = await lstat(stepsDir);
        if (!stepsMetadata.isDirectory() || stepsMetadata.isSymbolicLink()) {
          throw new Error("session steps directory must be a real directory");
        }
        const existing = await readSteps(sessionDir);
        const index = existing.length + 1;
        const stepNum = String(index).padStart(3, "0");
        const created: string[] = [];
        try {
          let screenshotRel: string | undefined;
          if (input.screenshot_src) {
            const ext = path.extname(input.screenshot_src).toLowerCase();
            if (!SCREENSHOT_EXTENSIONS.has(ext)) {
              throw new TypeError("screenshot_src must use png, jpg, jpeg, or webp");
            }
            const dest = path.join(stepsDir, `${stepNum}${ext}`);
            await copyRegularFilePrivate(
              input.screenshot_src,
              dest,
              MAX_STEP_SCREENSHOT_BYTES,
            );
            created.push(dest);
            screenshotRel = path.relative(sessionDir, dest);
          }

          let logRel: string | undefined;
          if (input.log_excerpt_src) {
            const dest = path.join(stepsDir, `${stepNum}.log`);
            await copyRegularFilePrivate(input.log_excerpt_src, dest, MAX_STEP_LOG_BYTES);
            created.push(dest);
            logRel = path.relative(sessionDir, dest);
          } else if (input.log_excerpt) {
            const dest = path.join(stepsDir, `${stepNum}.log`);
            await writeFile(dest, input.log_excerpt, {
              encoding: "utf8",
              flag: "wx",
              mode: 0o600,
            });
            created.push(dest);
            logRel = path.relative(sessionDir, dest);
          }

          const record: StepRecord = {
            index,
            ts: new Date().toISOString(),
            action: input.action,
            ...(input.result !== undefined ? { result: input.result } : {}),
            ...(screenshotRel ? { screenshot: screenshotRel } : {}),
            ...(logRel ? { log_excerpt: logRel } : {}),
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
          };
          await appendStep(sessionDir, record);
          return record;
        } catch (error) {
          await Promise.all(created.map((file) => unlink(file).catch(() => undefined)));
          throw error;
        }
      });
      return asText({ ok: true, step });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- record_crash ----------
server.tool(
  "record_crash",
  "Append a crash record while the session is running. Remote sources are idempotent by external_key. New CrashFix Firebase evidence requires a prior record_crashfix_target plus project/app/issue/event/app_build, signature_version, signature_degraded, cross_source_comparable, a server-verified SHA-256 external_key bound to signature_version + signature, and acquisition_route matching start_session.source_lock. stack is required as inline text; log_full_src (optional) imports a bounded full log file.",
  {
    session_id: z.string().min(1).max(MAX_SESSION_ID_CHARS).optional(),
    session_dir: z.string().min(1).max(MAX_SESSION_PATH_CHARS).optional(),
    workspace_root: z.string().min(1).max(MAX_SESSION_PATH_CHARS).optional(),
    signature: z
      .string()
      .min(1)
      .max(MAX_CRASH_SIGNATURE_CHARS)
      .describe(
        "must be a 12-character lowercase hexadecimal analyzer fingerprint when signature_version is present",
      ),
    signature_version: crashSignatureVersionSchema
      .optional()
      .describe("required for new firebase-crashlytics evidence"),
    signature_degraded: z
      .boolean()
      .optional()
      .describe("required Analyzer attestation for CrashFix Firebase evidence"),
    cross_source_comparable: z
      .boolean()
      .optional()
      .describe("required Analyzer attestation for CrashFix Firebase evidence"),
    stack: z
      .string()
      .min(1)
      .max(MAX_CRASH_STACK_BYTES)
      .describe("the captured stack/block text"),
    kind: z.string().min(1).max(MAX_CRASH_KIND_CHARS).optional(),
    step_index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    repro_path: z
      .array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))
      .max(MAX_REPRO_PATH_ENTRIES)
      .default([])
      .describe("ordered step indices required to reproduce"),
    log_full_src: z
      .string()
      .min(1)
      .max(MAX_SESSION_PATH_CHARS)
      .optional()
      .describe("absolute path of a full log file to archive"),
    source: crashSourceSchema
      .optional()
      .describe(
        "strict normalized remote origin; new firebase-crashlytics external_key must equal SHA-256(provider\\0project\\0app\\0issue\\0event\\0signature_version\\0signature)",
      ),
    acquisition_route: crashAcquisitionRouteSchema
      .optional()
      .describe(
        "required for firebase-crashlytics evidence and must match start_session.source_lock",
      ),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      const result = await recordCrashEvidence(sessionDir, {
        signature: input.signature,
        ...(input.signature_version !== undefined
          ? { signature_version: input.signature_version }
          : {}),
        ...(input.signature_degraded !== undefined
          ? { signature_degraded: input.signature_degraded }
          : {}),
        ...(input.cross_source_comparable !== undefined
          ? { cross_source_comparable: input.cross_source_comparable }
          : {}),
        stack: input.stack,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.step_index !== undefined ? { step_index: input.step_index } : {}),
        repro_path: input.repro_path,
        ...(input.log_full_src !== undefined
          ? { log_full_src: input.log_full_src }
          : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
        ...(input.acquisition_route !== undefined
          ? { acquisition_route: input.acquisition_route }
          : {}),
      });
      return asText({
        ok: true,
        deduplicated: result.deduplicated,
        crash: result.crash,
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- finalize ----------
server.tool(
  "finalize",
  "Set session status + end time, render report.md and report.html. A CrashFix verification child can be passed only with strict caller-supplied completion facts; Report independently validates stored steps/crashes and seals a structured zero-crash record, but does not attest device hardware or installation receipts. Returns both paths.",
  {
    session_id: z.string().optional(),
    session_dir: z.string().optional(),
    workspace_root: z.string().optional(),
    status: z.enum(["passed", "failed", "aborted"]),
    summary: z.string().optional().describe("optional summary block at the top of the report"),
    html: z.boolean().optional().default(true).describe("also emit report.html (default true)"),
    verification_evidence: childVerificationCompletionSchema
      .optional()
      .describe(
        "required only for a passed crashfix-child-verification/v1 session; all fields are closed literal completion facts",
      ),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      assertCrashfixReportInput(await loadMeta(sessionDir), input.summary);
      const finalized = await finalizeSession(
        sessionDir,
        input.status,
        async ({ meta, steps, crashes }) => {
          const renderInput = {
            meta,
            steps,
            crashes,
            ...(input.summary !== undefined ? { summary: input.summary } : {}),
          };
          const md = renderMarkdown(renderInput);
          const reportPath = await writeReport(sessionDir, md);
          let htmlPath: string | undefined;
          if (input.html !== false) {
            htmlPath = await writeHtmlReport(sessionDir, renderHtml(renderInput));
          }
          return { reportPath, htmlPath };
        },
        {
          ...(input.verification_evidence !== undefined
            ? { verificationEvidence: input.verification_evidence }
            : {}),
        },
      );
      const { meta, steps, crashes, already_finalized } = finalized.context;
      const { reportPath, htmlPath } = finalized.value;
      return asText({
        ok: true,
        session_id: meta.id,
        status: meta.status,
        already_finalized,
        report_path: reportPath,
        ...(htmlPath ? { html_path: htmlPath } : {}),
        steps: steps.length,
        crashes: crashes.length,
        verification_evidence_bound: meta.verification !== undefined,
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- get_session_path ----------
server.tool(
  "get_session_path",
  "Resolve the absolute directory of a session.",
  {
    session_id: z.string(),
    workspace_root: z.string().optional(),
  },
  async ({ session_id, workspace_root }) => {
    try {
      const dir = resolveSessionDir({ sessionId: session_id, workspaceRoot: workspace_root });
      return asText({ session_dir: dir });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- list_sessions ----------
server.tool(
  "list_sessions",
  "List sessions in the workspace, newest first.",
  {
    workspace_root: z.string().optional(),
    limit: z.number().int().positive().optional(),
  },
  async ({ workspace_root, limit }) => {
    try {
      const all = await listSessions(workspace_root);
      const trimmed = limit ? all.slice(0, limit) : all;
      return asText({ count: trimmed.length, root: resolveWorkspaceRoot(workspace_root), sessions: trimmed });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- regenerate_report (utility) ----------
server.tool(
  "regenerate_report",
  "Re-render report.md (and report.html unless html=false) from current jsonl + meta (no status change).",
  {
    session_id: z.string().optional(),
    session_dir: z.string().optional(),
    workspace_root: z.string().optional(),
    summary: z.string().optional(),
    html: z.boolean().optional().default(true),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      const { reportPath, htmlPath } = await withSessionLock(
        sessionDir,
        async () => {
          const meta = await loadMeta(sessionDir);
          await assertStoredCrashfixAnalysis(sessionDir, meta);
          const steps = await readSteps(sessionDir);
          const crashes = await readCrashes(sessionDir);
          const renderInput = {
            meta,
            steps,
            crashes,
            ...(input.summary !== undefined ? { summary: input.summary } : {}),
          };
          const md = renderMarkdown(renderInput);
          const reportPath = await writeReport(sessionDir, md);
          let htmlPath: string | undefined;
          if (input.html !== false) {
            htmlPath = await writeHtmlReport(sessionDir, renderHtml(renderInput));
          }
          return { reportPath, htmlPath };
        },
      );
      return asText({
        ok: true,
        report_path: reportPath,
        ...(htmlPath ? { html_path: htmlPath } : {}),
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// =========================
//   QA state graph tools
// =========================

// ---------- graph_record_page ----------
server.tool(
  "graph_record_page",
  "QA: record visiting a page (by fingerprint hash). Creates the page if new, otherwise bumps visit_count/last_seen.",
  {
    session_id: z.string().optional(),
    session_dir: z.string().optional(),
    workspace_root: z.string().optional(),
    page_hash: z.string(),
    summary: z.string().optional().describe("short human description of the page"),
    screenshot: z.string().optional().describe("relative path of screenshot inside session"),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      const opts: { summary?: string; screenshot?: string } = {};
      if (input.summary !== undefined) opts.summary = input.summary;
      if (input.screenshot !== undefined) opts.screenshot = input.screenshot;
      const page = await recordPage(sessionDir, input.page_hash, opts);
      return asText({ ok: true, page });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- graph_record_edge ----------
server.tool(
  "graph_record_edge",
  "QA: record a transition (from page_hash, action) → to page_hash.",
  {
    session_id: z.string().optional(),
    session_dir: z.string().optional(),
    workspace_root: z.string().optional(),
    from_hash: z.string(),
    action: z.string().describe("human description of the action that caused the transition"),
    to_hash: z.string(),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      const edge = await recordEdge(sessionDir, input.from_hash, input.action, input.to_hash);
      return asText({ ok: true, edge });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- graph_mark_element_seen ----------
server.tool(
  "graph_mark_element_seen",
  "QA: mark an element on a page as already interacted with (so the explorer skips it next time).",
  {
    session_id: z.string().optional(),
    session_dir: z.string().optional(),
    workspace_root: z.string().optional(),
    page_hash: z.string(),
    element_key: z
      .string()
      .describe(
        "stable element identifier — prefer resource_id; fall back to 'text:<text>' or 'bounds:x1,y1,x2,y2'",
      ),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      const r = await markElementSeen(sessionDir, input.page_hash, input.element_key);
      return asText({ ok: true, ...r });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- graph_pick_next_unseen ----------
server.tool(
  "graph_pick_next_unseen",
  "QA: given current candidate element_keys (in priority order), return the first one not yet seen on this page. Returns null when everything has been tried.",
  {
    session_id: z.string().optional(),
    session_dir: z.string().optional(),
    workspace_root: z.string().optional(),
    page_hash: z.string(),
    candidate_keys: z.array(z.string()),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      const picked = await pickNextUnseen(sessionDir, input.page_hash, input.candidate_keys);
      const seen = await listSeenElements(sessionDir, input.page_hash);
      return asText({
        picked,
        seen_count: seen.length,
        candidates_count: input.candidate_keys.length,
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- graph_summary ----------
server.tool(
  "graph_summary",
  "QA: stats over the current state graph (pages, edges, isolated pages, most-visited, least-explored).",
  {
    session_id: z.string().optional(),
    session_dir: z.string().optional(),
    workspace_root: z.string().optional(),
  },
  async (input) => {
    try {
      const sessionDir = resolveSessionDir({
        sessionId: input.session_id,
        sessionDir: input.session_dir,
        workspaceRoot: input.workspace_root,
      });
      const s = await graphSummary(sessionDir);
      return asText(s);
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- boot ----------
installToolListSchemaOverrides(server, {
  record_crashfix_target: (inputSchema) =>
    withConstraint(inputSchema, sessionSelectorConstraint),
  record_crashfix_analysis: (inputSchema) =>
    withConstraint(inputSchema, sessionSelectorConstraint),
  record_snapshot_provenance: (inputSchema) =>
    withConstraint(inputSchema, sessionSelectorConstraint),
  record_candidate_provenance: advertiseCandidateSchema,
  record_step: (inputSchema) => withConstraint(inputSchema, sessionSelectorConstraint),
  record_crash: (inputSchema) => withConstraint(inputSchema, sessionSelectorConstraint),
  finalize: (inputSchema) => withConstraint(inputSchema, sessionSelectorConstraint),
  regenerate_report: (inputSchema) => withConstraint(inputSchema, sessionSelectorConstraint),
  graph_record_page: (inputSchema) => withConstraint(inputSchema, sessionSelectorConstraint),
  graph_record_edge: (inputSchema) => withConstraint(inputSchema, sessionSelectorConstraint),
  graph_mark_element_seen: (inputSchema) =>
    withConstraint(inputSchema, sessionSelectorConstraint),
  graph_pick_next_unseen: (inputSchema) =>
    withConstraint(inputSchema, sessionSelectorConstraint),
  graph_summary: (inputSchema) => withConstraint(inputSchema, sessionSelectorConstraint),
}, {
  start_session: ADDITIVE_LOCAL_ANNOTATIONS,
  record_crashfix_target: IDEMPOTENT_LOCAL_WRITE_ANNOTATIONS,
  record_crashfix_analysis: IDEMPOTENT_LOCAL_WRITE_ANNOTATIONS,
  record_snapshot_provenance: IDEMPOTENT_LOCAL_WRITE_ANNOTATIONS,
  record_candidate_provenance: IDEMPOTENT_LOCAL_WRITE_ANNOTATIONS,
  record_step: ADDITIVE_LOCAL_ANNOTATIONS,
  record_crash: ADDITIVE_LOCAL_ANNOTATIONS,
  finalize: DESTRUCTIVE_LOCAL_WRITE_ANNOTATIONS,
  get_session_path: READ_ONLY_LOCAL_ANNOTATIONS,
  list_sessions: READ_ONLY_LOCAL_ANNOTATIONS,
  regenerate_report: DESTRUCTIVE_LOCAL_WRITE_ANNOTATIONS,
  graph_record_page: ADDITIVE_LOCAL_ANNOTATIONS,
  graph_record_edge: ADDITIVE_LOCAL_ANNOTATIONS,
  graph_mark_element_seen: IDEMPOTENT_LOCAL_WRITE_ANNOTATIONS,
  graph_pick_next_unseen: READ_ONLY_LOCAL_ANNOTATIONS,
  graph_summary: READ_ONLY_LOCAL_ANNOTATIONS,
});

const transport = new StdioServerTransport();
await server.connect(transport);
