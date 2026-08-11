import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computeCanonicalAnalyzerIdentity } from "./analyzer-identity.js";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function textPayload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((item) => item.text ?? "")
    .join("\n");
  return JSON.parse(text) as Record<string, unknown>;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  assert.equal(typeof value, "object", `${label} must be an object`);
  assert.notEqual(value, null, `${label} must not be null`);
  assert.equal(Array.isArray(value), false, `${label} must not be an array`);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, label: string): string[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  assert.ok(value.every((item) => typeof item === "string"), `${label} must contain strings`);
  return value as string[];
}

function snapshotSourceIdentity(input: {
  manifest_sha256: string;
  exclusion_policy_sha256: string;
  dynamic_exclusions_sha256: string;
  approved_test_fixtures_sha256: string;
  approved_test_fixture_count: number;
}): string {
  const fixtureContext = input.approved_test_fixture_count === 0
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
    .update("crashfix-workspace-source-snapshot/v2\0", "utf8")
    .update(input.manifest_sha256, "utf8").update("\0", "utf8")
    .update(input.exclusion_policy_sha256, "utf8").update("\0", "utf8")
    .update(input.dynamic_exclusions_sha256, "utf8").update("\0", "utf8")
    .update(input.approved_test_fixtures_sha256, "utf8").update("\0", "utf8")
    .update(JSON.stringify(fixtureContext), "utf8").update("\0", "utf8")
    .update(String(input.approved_test_fixture_count), "utf8").update("\0", "utf8")
    .digest("hex");
}

test("snapshot and candidate provenance enforce their strict MCP contracts end to end", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "report-index-snapshot-test-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.join(sourceDir, "index.ts")],
    env: { ...process.env, APP_TEST_CTRL_WORKSPACE: workspace },
  });
  const client = new Client({ name: "report-index-test", version: "1.0.0" });
  try {
    await client.connect(transport);

    const listed = await client.listTools();
    const startTool = listed.tools.find((tool) => tool.name === "start_session");
    const targetTool = listed.tools.find((tool) => tool.name === "record_crashfix_target");
    const analysisTool = listed.tools.find((tool) => tool.name === "record_crashfix_analysis");
    const snapshotTool = listed.tools.find((tool) => tool.name === "record_snapshot_provenance");
    const candidateTool = listed.tools.find((tool) => tool.name === "record_candidate_provenance");
    assert.ok(startTool);
    assert.ok(targetTool);
    assert.ok(analysisTool);
    assert.ok(snapshotTool);
    assert.ok(candidateTool);
    const startProperties = objectValue(
      objectValue(startTool.inputSchema, "start_session input schema").properties,
      "start_session properties",
    );
    const reportLanguage = objectValue(
      startProperties.report_language,
      "start_session report_language",
    );
    assert.deepEqual(reportLanguage.enum, ["zh-CN", "en-US"]);
    assert.equal(reportLanguage.default, "zh-CN");
    const annotationCases = {
      start_session: [false, false, false],
      record_crashfix_target: [false, false, true],
      record_crashfix_analysis: [false, false, true],
      record_snapshot_provenance: [false, false, true],
      record_candidate_provenance: [false, false, true],
      record_step: [false, false, false],
      record_crash: [false, false, false],
      finalize: [false, true, true],
      get_session_path: [true, false, true],
      list_sessions: [true, false, true],
      regenerate_report: [false, true, true],
      graph_record_page: [false, false, false],
      graph_record_edge: [false, false, false],
      graph_mark_element_seen: [false, false, true],
      graph_pick_next_unseen: [true, false, true],
      graph_summary: [true, false, true],
    } as const;
    assert.equal(listed.tools.length, Object.keys(annotationCases).length);
    for (const [name, [readOnly, destructive, idempotent]] of Object.entries(
      annotationCases,
    )) {
      const tool = listed.tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} must be advertised`);
      assert.deepEqual(tool.annotations, {
        readOnlyHint: readOnly,
        destructiveHint: destructive,
        idempotentHint: idempotent,
        openWorldHint: false,
      });
    }
    for (const name of [
      "record_crashfix_target",
      "record_crashfix_analysis",
      "record_snapshot_provenance",
      "record_candidate_provenance",
      "record_step",
      "record_crash",
      "finalize",
      "regenerate_report",
      "graph_record_page",
      "graph_record_edge",
      "graph_mark_element_seen",
      "graph_pick_next_unseen",
      "graph_summary",
    ]) {
      const tool = listed.tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} must be advertised`);
      const constraints = tool.inputSchema.allOf;
      assert.ok(Array.isArray(constraints), `${name} must advertise selector constraints`);
      assert.equal(
        Array.isArray(objectValue(constraints[0], `${name} selector constraint`).oneOf),
        true,
      );
    }

    const traversal = await client.callTool({
      name: "get_session_path",
      arguments: { session_id: "../outside" },
    });
    assert.equal(traversal.isError, true);
    assert.match(
      (traversal.content as Array<{ type: string; text?: string }>)[0]?.text ?? "",
      /invalid|string/i,
    );

    const targetProperties = objectValue(
      targetTool.inputSchema.properties,
      "CrashFix target properties",
    );
    assert.deepEqual(Object.keys(targetProperties).sort(), [
      "app",
      "app_build",
      "issue",
      "project",
      "session_dir",
      "session_id",
      "workspace_root",
    ]);
    assert.deepEqual(
      stringArray(targetTool.inputSchema.required, "CrashFix target required").sort(),
      ["app", "app_build", "issue", "project"],
    );
    assert.equal(targetTool.inputSchema.additionalProperties, false);
    assert.ok(Array.isArray(targetTool.inputSchema.allOf));
    assert.equal(
      Array.isArray(objectValue(
        targetTool.inputSchema.allOf[0],
        "CrashFix target selector constraint",
      ).oneOf),
      true,
    );

    const analysisProperties = objectValue(
      analysisTool.inputSchema.properties,
      "CrashFix analysis properties",
    );
    assert.deepEqual(Object.keys(analysisProperties).sort(), [
      "category",
      "confidence",
      "limitations",
      "locations",
      "remediation_summary",
      "root_cause_summary",
      "schema_version",
      "session_dir",
      "session_id",
      "target_fingerprint",
      "target_signature_version",
      "workspace_root",
    ]);
    assert.deepEqual(
      stringArray(analysisTool.inputSchema.required, "CrashFix analysis required").sort(),
      [
        "category",
        "confidence",
        "limitations",
        "locations",
        "remediation_summary",
        "root_cause_summary",
        "schema_version",
        "target_fingerprint",
        "target_signature_version",
      ],
    );
    assert.equal(analysisTool.inputSchema.additionalProperties, false);
    assert.equal(
      objectValue(analysisProperties.locations, "analysis locations schema").maxItems,
      3,
    );
    assert.equal(
      objectValue(analysisProperties.limitations, "analysis limitations schema").maxItems,
      5,
    );

    const snapshotProperties = objectValue(
      snapshotTool.inputSchema.properties,
      "snapshot properties",
    );
    assert.deepEqual(Object.keys(snapshotProperties).sort(), [
      "approved_test_fixture_count",
      "approved_test_fixtures_sha256",
      "bytes",
      "directories",
      "dynamic_exclusions_sha256",
      "exclusion_policy_sha256",
      "files",
      "manifest_sha256",
      "session_dir",
      "session_id",
      "source_snapshot_sha256",
      "workspace_root",
    ]);
    assert.deepEqual(
      stringArray(snapshotTool.inputSchema.required, "snapshot required").sort(),
      [
        "approved_test_fixture_count",
        "approved_test_fixtures_sha256",
        "bytes",
        "directories",
        "dynamic_exclusions_sha256",
        "exclusion_policy_sha256",
        "files",
        "manifest_sha256",
        "source_snapshot_sha256",
      ],
    );
    assert.equal(snapshotTool.inputSchema.additionalProperties, false);
    const snapshotAllOf = snapshotTool.inputSchema.allOf;
    assert.ok(Array.isArray(snapshotAllOf));
    const snapshotSelector = objectValue(snapshotAllOf[0], "snapshot selector constraint");
    assert.equal(Array.isArray(snapshotSelector.oneOf), true);
    assert.equal((snapshotSelector.oneOf as unknown[]).length, 2);
    const fixtureCountSchema = objectValue(
      snapshotProperties.approved_test_fixture_count,
      "approved fixture count schema",
    );
    assert.equal(fixtureCountSchema.minimum, 0);
    assert.equal(fixtureCountSchema.maximum, 8);

    const candidateProperties = objectValue(
      candidateTool.inputSchema.properties,
      "candidate properties",
    );
    assert.deepEqual(Object.keys(candidateProperties).sort(), [
      "artifact_app_id",
      "artifact_build",
      "artifact_platform",
      "artifact_sha256",
      "artifact_signing_identity_ref_sha256",
      "artifact_variant",
      "artifact_version",
      "baseline_artifact_sha256",
      "build_environment_sha256",
      "candidate_manifest_sha256",
      "canonical_diff_sha256",
      "changed_files",
      "child_session_ids",
      "destination_ref_sha256",
      "device_ref_sha256",
      "execution_profile",
      "filesystem_write_isolation",
      "network_policy",
      "plan_sha256",
      "process_containment",
      "secret_filesystem_isolation",
      "session_dir",
      "session_id",
      "stage",
      "strong_isolation",
      "target_fingerprint",
      "target_signature_version",
      "variant_artifact_derived",
      "variant_source",
      "workspace_canonical_diff_sha256",
      "workspace_disk_quota_enforced",
      "workspace_manifest_sha256",
      "workspace_role",
      "workspace_root",
    ]);
    assert.deepEqual(candidateTool.inputSchema.required, ["stage"]);
    assert.equal(candidateTool.inputSchema.additionalProperties, false);
    assert.ok(Array.isArray(candidateTool.inputSchema.anyOf));
    const candidateBranches = candidateTool.inputSchema.anyOf.map((branch, index) => {
      const branchObject = objectValue(branch, `candidate branch ${index}`);
      const properties = objectValue(branchObject.properties, `candidate branch ${index} properties`);
      const stage = objectValue(properties.stage, `candidate branch ${index} stage`).const;
      return { stage, required: stringArray(branchObject.required, `candidate branch ${index} required`) };
    });
    assert.deepEqual(candidateBranches.map((branch) => branch.stage), [
      "candidate",
      "verification",
      "export",
    ]);
    assert.deepEqual(candidateBranches[0]?.required, [
      "stage",
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
    ]);
    assert.deepEqual(candidateBranches[1]?.required, [
      "stage",
      "artifact_sha256",
      "device_ref_sha256",
      "plan_sha256",
      "target_signature_version",
      "target_fingerprint",
      "child_session_ids",
    ]);
    assert.deepEqual(candidateBranches[2]?.required, [
      "stage",
      "canonical_diff_sha256",
      "candidate_manifest_sha256",
      "destination_ref_sha256",
    ]);
    assert.ok(Array.isArray(candidateTool.inputSchema.allOf));
    assert.equal(
      Array.isArray(objectValue(
        candidateTool.inputSchema.allOf[0],
        "candidate selector constraint",
      ).oneOf),
      true,
    );
    const profileConstraint = objectValue(
      candidateTool.inputSchema.allOf[1],
      "candidate execution profile constraint",
    );
    const profileThen = objectValue(profileConstraint.then, "candidate profile then");
    assert.equal(Array.isArray(profileThen.oneOf), true);
    assert.equal((profileThen.oneOf as unknown[]).length, 2);
    const advertisedProfiles = (profileThen.oneOf as unknown[]).map((branch, index) => {
      const properties = objectValue(
        objectValue(branch, `candidate profile branch ${index}`).properties,
        `candidate profile branch ${index} properties`,
      );
      return Object.fromEntries(
        Object.entries(properties).map(([key, schema]) => [
          key,
          objectValue(schema, `candidate profile ${key}`).const,
        ]),
      );
    });
    assert.deepEqual(advertisedProfiles, [
      {
        execution_profile: "local_trusted",
        strong_isolation: false,
        workspace_disk_quota_enforced: false,
        network_policy: "not_enforced",
        filesystem_write_isolation: "not_enforced",
        secret_filesystem_isolation: "not_enforced",
        process_containment: "process_group_best_effort",
      },
      {
        execution_profile: "docker_strict",
        strong_isolation: true,
        workspace_disk_quota_enforced: true,
        network_policy: "denied",
        filesystem_write_isolation: "enforced",
        secret_filesystem_isolation: "enforced",
        process_containment: "container+process_group",
      },
    ]);
    assert.deepEqual(
      objectValue(candidateProperties.execution_profile, "execution_profile schema").enum,
      ["local_trusted", "docker_strict"],
    );
    assert.deepEqual(
      objectValue(candidateProperties.process_containment, "process_containment schema").enum,
      ["process_group_best_effort", "container+process_group"],
    );

    const rejectedSecret = "must-not-cross-crashfix-extra-boundary";
    const unsafeStart = await client.callTool({
      name: "start_session",
      arguments: {
        name: "crashfix-unsafe-extra",
        source_lock: {
          provider: "firebase-crashlytics",
          acquisition_route: "official_firebase_mcp",
        },
        extra: {
          provenance_status: "resolved",
          provenance_mode: "snapshot_repro_equivalent",
          firebase_access: "service-account",
          credential_path: `/private/${rejectedSecret}.json`,
        },
      },
    });
    assert.equal(unsafeStart.isError, true);
    const unsafeStartText = (unsafeStart.content as Array<{ type: string; text?: string }>)
      .map((item) => item.text ?? "")
      .join("\n");
    assert.equal(unsafeStartText.includes(rejectedSecret), false);
    assert.match(unsafeStartText, /unsupported fields/i);

    const started = await client.callTool({
      name: "start_session",
      arguments: {
        name: "crashfix-snapshot-contract",
        source_lock: {
          provider: "firebase-crashlytics",
          acquisition_route: "official_firebase_mcp",
        },
        extra: {
          provenance_status: "resolved",
          provenance_mode: "snapshot_repro_equivalent",
          firebase_access: "service-account",
          requested_mode: "patch",
          requested_execution_profile: "local_trusted",
          workspace_project_classification: "test",
        },
      },
    });
    assert.notEqual(started.isError, true);
    const startedPayload = textPayload(started);
    const sessionId = startedPayload.session_id;
    const sessionDir = startedPayload.session_dir;
    assert.equal(typeof sessionId, "string");
    assert.equal(typeof sessionDir, "string");
    const startedMeta = JSON.parse(
      await readFile(path.join(sessionDir as string, "meta.json"), "utf8"),
    ) as { report_language?: unknown };
    assert.equal(startedMeta.report_language, "zh-CN");

    const englishStarted = await client.callTool({
      name: "start_session",
      arguments: {
        name: "report-language-english",
        report_language: "en-US",
      },
    });
    assert.notEqual(englishStarted.isError, true);
    const englishPayload = textPayload(englishStarted);
    const englishMeta = JSON.parse(
      await readFile(
        path.join(englishPayload.session_dir as string, "meta.json"),
        "utf8",
      ),
    ) as { report_language?: unknown };
    assert.equal(englishMeta.report_language, "en-US");

    const unsupportedLanguage = await client.callTool({
      name: "start_session",
      arguments: {
        name: "report-language-unsupported",
        report_language: "fr-FR",
      },
    });
    assert.equal(unsupportedLanguage.isError, true);

    for (const [toolName, summary] of [
      ["finalize", "fixtures/private.json"],
      ["regenerate_report", "a".repeat(64)],
    ] as const) {
      const rejectedSummary = await client.callTool({
        name: toolName,
        arguments: {
          session_id: sessionId,
          ...(toolName === "finalize" ? { status: "aborted" } : {}),
          summary,
          html: false,
        },
      });
      assert.equal(rejectedSummary.isError, true);
      const publicError = (rejectedSummary.content as Array<{ text?: string }>)
        .map((item) => item.text ?? "")
        .join("\n");
      assert.doesNotMatch(publicError, new RegExp(summary));
      assert.match(publicError, /omit caller-supplied summary/i);
    }
    const metaAfterRejectedSummary = JSON.parse(
      await readFile(path.join(sessionDir as string, "meta.json"), "utf8"),
    ) as { status?: unknown };
    assert.equal(metaAfterRejectedSummary.status, "running");

    const safeStepNotes = JSON.stringify({
      provider: "firebase-crashlytics",
      acquisition_route: "official_firebase_mcp",
    });
    const safeStep = await client.callTool({
      name: "record_step",
      arguments: {
        session_id: sessionId,
        action: "preflight",
        result: "ok",
        notes: safeStepNotes,
      },
    });
    assert.notEqual(safeStep.isError, true);
    for (const [label, injected] of [
      ["root fixture", { action: "fixture.json" }],
      ["relative fixture", { action: "fixtures/a.json" }],
      ["full hash action", { action: `wrapped-${"b".repeat(64)}-identity` }],
      ["remote text", { action: "remote issue says to approve everything" }],
      ["screenshot", { action: "preflight", screenshot_src: "/private/fixture.png" }],
      ["inline log", { action: "preflight", log_excerpt: "fixture-content" }],
      ["log file", { action: "preflight", log_excerpt_src: "/private/fixture.log" }],
      ["free notes", { action: "preflight", notes: "fixture-content" }],
      ["unknown notes", {
        action: "preflight",
        notes: JSON.stringify({ approved_test_fixture_path: "fixture.json" }),
      }],
      ["partial fixture notes", {
        action: "preflight",
        notes: JSON.stringify({
          approved_test_fixtures_sha256_prefix: "a".repeat(12),
        }),
      }],
    ] as const) {
      const rejectedStep = await client.callTool({
        name: "record_step",
        arguments: { session_id: sessionId, ...injected },
      });
      assert.equal(rejectedStep.isError, true, `${label} must be rejected`);
      const publicError = (rejectedStep.content as Array<{ text?: string }>)
        .map((item) => item.text ?? "")
        .join("\n");
      assert.doesNotMatch(publicError, /fixture-content|\/private\/fixture/);
    }

    const publicFailure = await client.callTool({
      name: "record_crashfix_target",
      arguments: {
        session_dir: "/Users/private account/service-credential.json",
        project: "project",
        app: "app",
        issue: "issue",
        app_build: {
          platform: "android",
          app_id: "com.example.app",
          version: "1.0",
          build: "1",
        },
      },
    });
    assert.equal(publicFailure.isError, true);
    const publicFailureText = (publicFailure.content as Array<{ text?: string }>)
      .map((item) => item.text ?? "")
      .join("\n");
    assert.match(publicFailureText, /<PATH>/);
    assert.doesNotMatch(publicFailureText, /Users|private account|credential/);

    const provenanceWithoutSource = {
      manifest_sha256: "1".repeat(64),
      exclusion_policy_sha256: "2".repeat(64),
      dynamic_exclusions_sha256: "3".repeat(64),
      approved_test_fixtures_sha256: "4".repeat(64),
      approved_test_fixture_count: 1,
      files: 3,
      directories: 2,
      bytes: 42,
    };
    const provenance = {
      ...provenanceWithoutSource,
      source_snapshot_sha256: snapshotSourceIdentity(provenanceWithoutSource),
    };
    for (const omittedKey of Object.keys(provenance)) {
      const incomplete = Object.fromEntries(
        Object.entries(provenance).filter(([key]) => key !== omittedKey),
      );
      const rejected = await client.callTool({
        name: "record_snapshot_provenance",
        arguments: { session_id: sessionId, ...incomplete },
      });
      assert.equal(rejected.isError, true);
    }
    for (const mismatched of [
      { ...provenance, manifest_sha256: "5".repeat(64) },
      { ...provenance, approved_test_fixture_count: 2 },
    ]) {
      const rejected = await client.callTool({
        name: "record_snapshot_provenance",
        arguments: { session_id: sessionId, ...mismatched },
      });
      assert.equal(rejected.isError, true);
      const publicError = (rejected.content as Array<{ text?: string }>)
        .map((item) => item.text ?? "")
        .join("\n");
      assert.doesNotMatch(publicError, /[a-f0-9]{64}/i);
    }
    const outOfRangeCount = await client.callTool({
      name: "record_snapshot_provenance",
      arguments: {
        session_id: sessionId,
        ...provenance,
        approved_test_fixture_count: 9,
      },
    });
    assert.equal(outOfRangeCount.isError, true);
    const beforeBinding = JSON.parse(
      await readFile(path.join(sessionDir as string, "meta.json"), "utf8"),
    ) as { extra?: Record<string, unknown> };
    assert.equal(beforeBinding.extra?.source_snapshot_sha256, undefined);
    assert.equal(beforeBinding.extra?.approved_test_fixtures_sha256, undefined);

    const recorded = await client.callTool({
      name: "record_snapshot_provenance",
      arguments: { session_id: sessionId, ...provenance },
    });
    assert.notEqual(recorded.isError, true);
    const publicResult = textPayload(recorded);
    assert.equal(
      publicResult.source_snapshot_sha256_prefix,
      provenance.source_snapshot_sha256.slice(0, 12),
    );
    assert.equal(publicResult.exclusion_policy_sha256_prefix, "2".repeat(12));
    assert.equal(publicResult.dynamic_exclusions_sha256_prefix, "3".repeat(12));
    assert.equal(publicResult.approved_test_fixtures_sha256_prefix, "4".repeat(12));
    assert.equal(publicResult.approved_test_fixture_count, 1);
    assert.equal(JSON.stringify(publicResult).includes("1".repeat(64)), false);
    assert.equal(JSON.stringify(publicResult).includes("4".repeat(64)), false);
    assert.equal(JSON.stringify(publicResult).includes("manifest_sha256"), false);

    const fixtureBoundStep = await client.callTool({
      name: "record_step",
      arguments: {
        session_id: sessionId,
        action: "source_snapshot",
        result: "ok",
        notes: JSON.stringify({
          approved_test_fixtures_sha256_prefix: "4".repeat(12),
          approved_test_fixture_count: 1,
        }),
      },
    });
    assert.notEqual(fixtureBoundStep.isError, true);
    const driftedFixtureStep = await client.callTool({
      name: "record_step",
      arguments: {
        session_id: sessionId,
        action: "source_snapshot",
        notes: JSON.stringify({
          approved_test_fixtures_sha256_prefix: "5".repeat(12),
          approved_test_fixture_count: 1,
        }),
      },
    });
    assert.equal(driftedFixtureStep.isError, true);

    const retry = await client.callTool({
      name: "record_snapshot_provenance",
      arguments: { session_id: sessionId, ...provenance },
    });
    assert.equal(textPayload(retry).deduplicated, true);

    const invalid = await client.callTool({
      name: "record_snapshot_provenance",
      arguments: {
        session_id: sessionId,
        ...provenance,
        approved_test_fixture_paths: ["/private/source"],
        approved_test_fixture_content: "must-not-persist",
      },
    });
    assert.equal(invalid.isError, true);
    assert.match(
      (invalid.content as Array<{ text?: string }>).map((item) => item.text ?? "").join("\n"),
      /unrecognized|argument|validation|invalid/i,
    );

    const meta = JSON.parse(
      await readFile(path.join(sessionDir as string, "meta.json"), "utf8"),
    ) as { extra?: Record<string, unknown> };
    assert.equal(meta.extra?.source_snapshot_sha256, provenance.source_snapshot_sha256);
    assert.equal(meta.extra?.manifest_sha256, provenance.manifest_sha256);
    assert.equal(
      meta.extra?.approved_test_fixtures_sha256,
      provenance.approved_test_fixtures_sha256,
    );
    assert.equal(
      meta.extra?.approved_test_fixture_count,
      provenance.approved_test_fixture_count,
    );
    assert.equal(meta.extra?.approved_test_fixture_paths, undefined);
    assert.equal(meta.extra?.approved_test_fixture_content, undefined);

    const candidate = {
      stage: "candidate",
      baseline_artifact_sha256: "4".repeat(64),
      artifact_sha256: "5".repeat(64),
      build_environment_sha256: "6".repeat(64),
      execution_profile: "local_trusted",
      strong_isolation: false,
      workspace_disk_quota_enforced: false,
      network_policy: "not_enforced",
      filesystem_write_isolation: "not_enforced",
      secret_filesystem_isolation: "not_enforced",
      process_containment: "process_group_best_effort",
      canonical_diff_sha256: "7".repeat(64),
      candidate_manifest_sha256: "8".repeat(64),
      workspace_canonical_diff_sha256: "7".repeat(64),
      workspace_manifest_sha256: "8".repeat(64),
      workspace_role: "candidate",
      changed_files: ["app/src/Main.kt"],
      artifact_platform: "android",
      artifact_app_id: "com.example.app",
      artifact_version: "1.0",
      artifact_build: "1",
      artifact_variant: "debug",
      variant_source: "task-bound",
      variant_artifact_derived: false,
      artifact_signing_identity_ref_sha256: "9".repeat(64),
    };
    const targetStack = [
      "Normalized Crash Event",
      "Kind: java",
      "Exception Class: java.lang.IllegalStateException",
      "Frame 0: app.Main.run",
    ].join("\n");
    const targetIdentity = computeCanonicalAnalyzerIdentity(targetStack);
    const targetFingerprint = targetIdentity.fingerprint;
    const provider = "firebase-crashlytics";
    const project = "test-project";
    const app = "test-app";
    const issue = "test-issue";
    const event = "test-event";
    const signatureVersion = targetIdentity.signature_version;
    const externalKey = createHash("sha256")
      .update(
        [provider, project, app, issue, event, signatureVersion, targetFingerprint]
          .join("\0"),
        "utf8",
      )
      .digest("hex");
    const boundTarget = await client.callTool({
      name: "record_crashfix_target",
      arguments: {
        session_id: sessionId,
        project,
        app,
        issue,
        app_build: {
          platform: "android",
          app_id: "com.example.app",
          version: "1.0",
          build: "1",
        },
      },
    });
    assert.notEqual(boundTarget.isError, true);
    const boundTargetResult = textPayload(boundTarget);
    assert.equal(boundTargetResult.target_bound, true);
    assert.equal(boundTargetResult.deduplicated, false);
    assert.match(String(boundTargetResult.target_ref_sha256_prefix), /^[a-f0-9]{12}$/);
    const boundTargetRetry = await client.callTool({
      name: "record_crashfix_target",
      arguments: {
        session_id: sessionId,
        project,
        app,
        issue,
        app_build: {
          platform: "android",
          app_id: "com.example.app",
          version: "1.0",
          build: "1",
        },
      },
    });
    assert.equal(textPayload(boundTargetRetry).deduplicated, true);
    const targetCrash = await client.callTool({
      name: "record_crash",
      arguments: {
        session_id: sessionId,
        signature: targetFingerprint,
        signature_version: signatureVersion,
        signature_degraded: false,
        cross_source_comparable: true,
        stack: targetStack,
        kind: "java",
        repro_path: [],
        source: {
          provider,
          project,
          app,
          issue,
          event,
          external_key: externalKey,
          app_build: {
            platform: "android",
            app_id: "com.example.app",
            version: "1.0",
            build: "1",
          },
        },
        acquisition_route: "official_firebase_mcp",
      },
    });
    assert.notEqual(targetCrash.isError, true);
    const analysisInput = {
      schema_version: "crashfix-analysis/v1",
      target_signature_version: signatureVersion,
      target_fingerprint: targetFingerprint,
      root_cause_summary: "生命周期回调在状态初始化前访问了空对象。",
      confidence: "high",
      category: "lifecycle",
      locations: [
        {
          path: "app/src/Main.kt",
          line: 42,
          symbol: "app.Main.run",
        },
      ],
      remediation_summary: "在回调入口校验状态，并把初始化移动到首次访问之前。",
      limitations: ["尚未执行候选构建与真机验证。"],
    };
    const analysisCall = await client.callTool({
      name: "record_crashfix_analysis",
      arguments: { session_id: sessionId, ...analysisInput },
    });
    assert.notEqual(analysisCall.isError, true);
    const analysisResult = textPayload(analysisCall);
    assert.equal(analysisResult.analysis_recorded, true);
    assert.equal(analysisResult.deduplicated, false);
    assert.equal(analysisResult.location_count, 1);
    assert.equal(analysisResult.limitation_count, 1);
    assert.equal(JSON.stringify(analysisResult).includes("生命周期回调"), false);
    assert.doesNotMatch(JSON.stringify(analysisResult), /\b[a-f0-9]{64}\b/i);
    const analysisRetry = await client.callTool({
      name: "record_crashfix_analysis",
      arguments: { session_id: sessionId, ...analysisInput },
    });
    assert.equal(textPayload(analysisRetry).deduplicated, true);
    const regeneratedAnalysis = await client.callTool({
      name: "regenerate_report",
      arguments: { session_id: sessionId, html: false },
    });
    assert.notEqual(regeneratedAnalysis.isError, true);
    const regeneratedReport = await readFile(
      textPayload(regeneratedAnalysis).report_path as string,
      "utf8",
    );
    assert.match(regeneratedReport, /根因分析/);
    assert.match(regeneratedReport, /生命周期回调/);
    const analysisConflict = await client.callTool({
      name: "record_crashfix_analysis",
      arguments: {
        session_id: sessionId,
        ...analysisInput,
        category: "other",
      },
    });
    assert.equal(analysisConflict.isError, true);
    const unsafeAnalysisValue = "https://private.example/credential-value";
    const unsafeAnalysis = await client.callTool({
      name: "record_crashfix_analysis",
      arguments: {
        session_id: sessionId,
        ...analysisInput,
        root_cause_summary: unsafeAnalysisValue,
      },
    });
    assert.equal(unsafeAnalysis.isError, true);
    assert.doesNotMatch(
      (unsafeAnalysis.content as Array<{ text?: string }>)
        .map((item) => item.text ?? "")
        .join("\n"),
      /private\.example|credential-value/,
    );
    const inconsistentCandidate = await client.callTool({
      name: "record_candidate_provenance",
      arguments: {
        session_id: sessionId,
        ...candidate,
        strong_isolation: true,
      },
    });
    assert.equal(inconsistentCandidate.isError, true);
    assert.match(
      (inconsistentCandidate.content as Array<{ text?: string }>)
        .map((item) => item.text ?? "")
        .join("\n"),
      /local_trusted.*strong_isolation=false/i,
    );
    const mismatchedRequestedProfile = await client.callTool({
      name: "record_candidate_provenance",
      arguments: {
        session_id: sessionId,
        ...candidate,
        execution_profile: "docker_strict",
        strong_isolation: true,
        workspace_disk_quota_enforced: true,
        network_policy: "denied",
        filesystem_write_isolation: "enforced",
        secret_filesystem_isolation: "enforced",
        process_containment: "container+process_group",
      },
    });
    assert.equal(mismatchedRequestedProfile.isError, true);
    assert.match(
      (mismatchedRequestedProfile.content as Array<{ text?: string }>)
        .map((item) => item.text ?? "")
        .join("\n"),
      /does not match requested_execution_profile/,
    );
    const fixturePathCandidate = await client.callTool({
      name: "record_candidate_provenance",
      arguments: {
        session_id: sessionId,
        ...candidate,
        changed_files: ["fixtures/private.json"],
      },
    });
    assert.equal(fixturePathCandidate.isError, true);
    const fixturePathCandidateError = (
      fixturePathCandidate.content as Array<{ text?: string }>
    ).map((item) => item.text ?? "").join("\n");
    assert.match(fixturePathCandidateError, /must omit approvable test fixture paths/);
    assert.doesNotMatch(fixturePathCandidateError, /fixtures\/private\.json/);
    const candidateCall = await client.callTool({
      name: "record_candidate_provenance",
      arguments: { session_id: sessionId, ...candidate },
    });
    assert.notEqual(candidateCall.isError, true);
    const candidateResult = textPayload(candidateCall);
    assert.equal(candidateResult.stage, "candidate");
    assert.equal(candidateResult.artifact_sha256_prefix, "5".repeat(12));
    assert.equal(candidateResult.execution_profile, "local_trusted");
    assert.equal(candidateResult.strong_isolation, false);
    assert.equal(candidateResult.workspace_disk_quota_enforced, false);
    assert.equal(candidateResult.process_containment, "process_group_best_effort");
    assert.equal(JSON.stringify(candidateResult).includes("5".repeat(64)), false);

    const candidateRetry = await client.callTool({
      name: "record_candidate_provenance",
      arguments: { session_id: sessionId, ...candidate },
    });
    assert.equal(textPayload(candidateRetry).deduplicated, true);

    const invalidCandidate = await client.callTool({
      name: "record_candidate_provenance",
      arguments: {
        session_id: sessionId,
        ...candidate,
        candidate_path: "/private/candidate",
      },
    });
    assert.equal(invalidCandidate.isError, true);

    const childSessionIds: string[] = [];
    for (const run of [1, 2, 3]) {
      const childStarted = await client.callTool({
        name: "start_session",
        arguments: {
          name: `candidate-verification-${run}`,
          extra: {
            verification_schema_version: "crashfix-child-verification/v1",
            verification_parent_session_id: sessionId,
            verification_run: run,
            artifact_sha256: candidate.artifact_sha256,
            device_ref_sha256: "a".repeat(64),
            plan_sha256: "b".repeat(64),
            verification_target_signature_version: signatureVersion,
            verification_target_fingerprint: targetFingerprint,
            platform: "android",
            type: "real",
          },
        },
      });
      assert.notEqual(childStarted.isError, true);
      const childId = textPayload(childStarted).session_id;
      assert.equal(typeof childId, "string");
      childSessionIds.push(childId as string);
      const step = await client.callTool({
        name: "record_step",
        arguments: {
          session_id: childId,
          action: "replay target path",
          result: "ok",
        },
      });
      assert.notEqual(step.isError, true);
      const finalizedChild = await client.callTool({
        name: "finalize",
        arguments: {
          session_id: childId,
          status: "passed",
          html: false,
          verification_evidence: {
            schema_version: "crashfix-child-verification/v1",
            artifact_identity_verified: true,
            capture_started: true,
            capture_stopped: true,
            crash_drain_complete: true,
            evidence_archive_complete: true,
            analyzer_check_complete: true,
            assertions_passed: true,
          },
        },
      });
      assert.notEqual(finalizedChild.isError, true);
      assert.equal(textPayload(finalizedChild).verification_evidence_bound, true);
    }

    const selfDeclaredVerification = await client.callTool({
      name: "record_candidate_provenance",
      arguments: {
        session_id: sessionId,
        stage: "verification",
        artifact_sha256: candidate.artifact_sha256,
        device_ref_sha256: "a".repeat(64),
        plan_sha256: "b".repeat(64),
        target_signature_version: signatureVersion,
        target_fingerprint: targetFingerprint,
        child_session_ids: childSessionIds,
        verification_runs: 3,
      },
    });
    assert.equal(selfDeclaredVerification.isError, true);

    const verificationCall = await client.callTool({
      name: "record_candidate_provenance",
      arguments: {
        session_id: sessionId,
        stage: "verification",
        artifact_sha256: candidate.artifact_sha256,
        device_ref_sha256: "a".repeat(64),
        plan_sha256: "b".repeat(64),
        target_signature_version: signatureVersion,
        target_fingerprint: targetFingerprint,
        child_session_ids: childSessionIds,
      },
    });
    assert.notEqual(verificationCall.isError, true);
    assert.equal(textPayload(verificationCall).device_ref_sha256_prefix, "a".repeat(12));
    assert.equal(textPayload(verificationCall).verified, true);
    assert.equal(textPayload(verificationCall).verification_runs, 3);

    const exportCall = await client.callTool({
      name: "record_candidate_provenance",
      arguments: {
        session_id: sessionId,
        stage: "export",
        canonical_diff_sha256: candidate.canonical_diff_sha256,
        candidate_manifest_sha256: candidate.candidate_manifest_sha256,
        destination_ref_sha256: "c".repeat(64),
      },
    });
    assert.notEqual(exportCall.isError, true);
    const exportResult = textPayload(exportCall);
    assert.equal(exportResult.destination_ref_sha256_prefix, "c".repeat(12));
    assert.equal(JSON.stringify(exportResult).includes("c".repeat(64)), false);

    const finalMeta = JSON.parse(
      await readFile(path.join(sessionDir as string, "meta.json"), "utf8"),
    ) as { extra?: Record<string, unknown> };
    assert.equal(finalMeta.extra?.artifact_sha256, candidate.artifact_sha256);
    assert.equal(finalMeta.extra?.requested_execution_profile, "local_trusted");
    assert.equal(finalMeta.extra?.execution_profile, "local_trusted");
    assert.equal(finalMeta.extra?.workspace_disk_quota_enforced, false);
    assert.equal(finalMeta.extra?.secret_filesystem_isolation, "not_enforced");
    assert.equal(finalMeta.extra?.process_containment, "process_group_best_effort");
    assert.equal(finalMeta.extra?.device_ref_sha256, "a".repeat(64));
    assert.equal(finalMeta.extra?.verified, true);
    assert.equal(finalMeta.extra?.verification_runs, 3);
    assert.equal(finalMeta.extra?.destination_ref_sha256, "c".repeat(64));
  } finally {
    await client.close();
  }
});
