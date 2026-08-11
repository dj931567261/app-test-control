import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeSession } from "../mcp-servers/analyzer-mcp/src/analyze.ts";
import { analyzeCrashEvent } from "../mcp-servers/analyzer-mcp/src/crash-event.ts";
import { createServiceFromEnvironment } from "../mcp-servers/crashlytics-mcp/src/runtime.ts";
import { renderMarkdown } from "../mcp-servers/report-mcp/src/report.ts";
import {
  createSession,
  EMPTY_APPROVED_TEST_FIXTURES_SHA256 as REPORT_EMPTY_APPROVED_TEST_FIXTURES_SHA256,
  loadMeta,
  readCrashes,
  recordCrashEvidence,
} from "../mcp-servers/report-mcp/src/sessions.ts";
import {
  EMPTY_APPROVED_TEST_FIXTURES_SHA256 as HELPER_EMPTY_APPROVED_TEST_FIXTURES_SHA256,
} from "../skills/crashfix/scripts/materialize-workspace-snapshot.mjs";
import {
  OFFICIAL_FIREBASE_READ_TOOLS,
} from "./firebase-mcp-config.mjs";

test("CrashFix defaults to the project-local official read-only gateway and never mixes sources", async () => {
  const [skill, contract, policy] = await Promise.all([
    readFile(new URL("../skills/crashfix/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/crashfix/references/evidence-contract.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/crashfix/references/automation-policy.md", import.meta.url), "utf8"),
  ]);

  assert.match(skill, /source=official\|cloud_logging/);
  assert.match(skill, /未指定时固定为 `official`/);
  assert.match(skill, /项目内 `firebase-readonly` MCP/);
  assert.match(skill, /只缩小工具面，不隔离宿主或凭据/);
  assert.match(skill, /固定 preload[\s\S]*隐式启用 Google API/);
  assert.match(skill, /Billing 能力被保守钳制为 `false`[\s\S]*安全\s*抑制值/);
  assert.match(skill, /唯一 Crashlytics feature discovery[\s\S]*宿主 `PATH`/);
  assert.match(skill, /firebase_get_environment\/firebase_get_project\/firebase_list_apps/);
  assert.match(skill, /八个只读工具/);
  assert.match(skill, /生产隐私 fail-closed/);
  assert.match(skill, /切换来源必须由当前用户显式选择并新建 session/);
  assert.match(skill, /source_lock/);
  assert.match(skill, /acquisition_route=<锁定 route>/);

  const officialContract = contract.match(
    /### 1\.1 项目内官方 Firebase 只读网关（默认）([\s\S]*?)### 1\.2 本仓 `crashlytics` MCP/,
  )?.[1];
  assert.ok(officialContract, "missing bounded project-local Firebase gateway contract");
  assert.match(officialContract, /客户端只能连接本项目的 `firebase-readonly` MCP/);
  assert.match(officialContract, /不得直连底层官方进程/);
  assert.match(officialContract, /不提供宿主文件、凭据或网络隔离/);
  assert.match(officialContract, /`checkBillingEnabled`[\s\S]*`bestEffortEnsure`[\s\S]*`trackGA4`/);
  assert.match(officialContract, /`detectActiveFeatures`[\s\S]*同一精确 package root/);
  assert.match(officialContract, /`mcpListTools`[\s\S]*`getAuthenticatedUser`[\s\S]*真实工具调用的官方认证/);
  assert.match(officialContract, /不得通过[\s\S]*跳过\s*`tools\/list`[\s\S]*直连官方进程绕过/);
  const declaredTools = [...officialContract.matchAll(/^- `([^`]+)`\s*$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(declaredTools, OFFICIAL_FIREBASE_READ_TOOLS);
  assert.deepEqual(declaredTools, [
    "firebase_get_environment",
    "firebase_get_project",
    "firebase_list_apps",
    "firebase_get_crashlytics_report_guide",
    "crashlytics_get_issue",
    "crashlytics_list_events",
    "crashlytics_batch_get_events",
    "crashlytics_get_report",
  ]);

  assert.match(officialContract, /无参数 `firebase_get_crashlytics_report_guide`/);
  assert.match(officialContract, /report\s+session 已成功建立且[\s\S]*source_lock\.acquisition_route=official_firebase_mcp/);
  assert.match(officialContract, /客户端不能列举、提供或改变 URI/);
  assert.match(officialContract, /只有本 session[\s\S]*`topIssues` 或 `topVersions` report[\s\S]*调用该别名恰好一次/);
  assert.match(officialContract, /进程的 guide 缓存[\s\S]*不能证明当前 session 的调用顺序/);
  assert.match(officialContract, /不需要[\s\S]*report 时不得调用别名/);
  assert.match(officialContract, /不得归档原文、转交其他[\s\S]*skill\/agent/);

  assert.match(skill, /无参数 `firebase_get_crashlytics_report_guide` 只允许在 `report\.start_session` 已成功建立/);
  assert.match(skill, /客户端不能列举、提供或改变 URI/);
  assert.match(skill, /返回内容不符合固定 guide 契约时[\s\S]*禁止调用 `topIssues`\/`topVersions` report/);
  assert.match(skill, /不需要这两类 report 时不得调用别名/);
  assert.match(skill, /读取事件详情前调用 `topVersions`/);
  assert.match(skill, /`versionDisplayNames` 必须原样来自[\s\S]*`version\.displayName`/);
  assert.match(skill, /严禁把[\s\S]*`firstSeenVersion`[\s\S]*`lastSeenVersion`[\s\S]*首条 event/);
  assert.match(skill, /目标绑定\s*成功后[\s\S]*`crashlytics_list_events\(pageSize<=3\)`/);
  assert.match(contract, /不自动 fallback/);
  assert.match(contract, /不得保存原始响应/);
  assert.match(contract, /`topVersions`[\s\S]*`version\.displayName`[\s\S]*省略独立 displayVersion\/buildVersion/);
  assert.match(contract, /`displayVersion \(buildVersion\)`[\s\S]*机械拆分 target/);
  assert.match(contract, /失败不得通过移除[\s\S]*过滤条件在同 session 重试/);
  assert.match(contract, /`provider` 是固定的逻辑 provider `firebase-crashlytics`/);
  assert.match(policy, /八个只读工具/);
  assert.match(policy, /`firebase_get_crashlytics_report_guide` 只可按证据契约作为当前 session 首次[\s\S]*`topIssues`\/`topVersions` report 的单次精确前置/);
  assert.match(policy, /不得为继续\s*patch\/pr 调用登录、授权、配置、环境变更或 Firebase 写工具/);
  assert.match(policy, /一个确认不得同时承担读取与写入两种授权/);
});

test("CrashFix exposes explicit quick_test and strict workflows without weakening strict gates", async () => {
  const documents = await Promise.all([
    readFile(new URL("../skills/crashfix/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../.claude/skills/crashfix/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/crashfix/references/automation-policy.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/crashfix/references/evidence-contract.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/crashfix/references/build-runner-contract.md", import.meta.url), "utf8"),
  ]);
  const [skill, distributed, policy, evidence, runner] = documents;
  for (const [name, document] of [
    ["SKILL.md", skill],
    ["distributed SKILL.md", distributed],
    ["automation-policy.md", policy],
    ["evidence-contract.md", evidence],
    ["build-runner-contract.md", runner],
  ]) {
    assert.match(document, /quick_test/ , `${name}: missing quick_test workflow`);
    assert.match(document, /strict/, `${name}: missing strict workflow`);
  }
  assert.match(skill, /`workflow`[^\n]{0,120}独立于 `requested_mode`/);
  assert.match(skill, /`quick_test`[^\n]{0,240}低敏/);
  assert.match(skill, /`strict`[^\n]{0,260}完整流程/);
  assert.match(skill, /requested_workflow="quick_test"/);
  assert.match(skill, /provenance_status="unavailable"/);
  assert.match(skill, /crashlytics_list_events\(pageSize=1\)/);
  assert.match(skill, /record_crashfix_analysis/);
  assert.match(skill, /quick 父 session[\s\S]{0,180}`locations=\[\]`/);
  assert.match(skill, /最多 3 个[^\n]{0,80}源码文件/);
  assert.match(skill, /不执行 `reset`、`stash`、`clean`、`git init`/);
  assert.match(skill, /`--scope`[^\n]{0,80}`--plan`[^\n]{0,160}不要求[\s\S]{0,40}Git/);
  assert.match(skill, /不自动 fallback/);
  assert.match(policy, /父 session[\s\S]{0,180}普通 `devtest` 子 session/);
  assert.match(policy, /不得依赖[\s\S]{0,20}Git diff[\s\S]{0,40}无 Git 项目仍可走 quick/);
  assert.match(evidence, /pageSize` 必须为 1/);
  assert.match(evidence, /crashfix-analysis\/v1/);
  assert.match(evidence, /candidate\/build\/验证\/导出状态/);
  assert.match(evidence, /private_key_block[\s\S]{0,180}不读取/);
  assert.match(runner, /`workflow=quick_test` 不调用 Runner/);
  assert.match(runner, /不得调用[^\n]{0,80}`run_gradle`/);
});

test("CrashFix test-fixture approval stays explicit, narrow and provenance-bound", async () => {
  assert.equal(
    REPORT_EMPTY_APPROVED_TEST_FIXTURES_SHA256,
    HELPER_EMPTY_APPROVED_TEST_FIXTURES_SHA256,
    "helper and Report must share the canonical empty approval-set identity",
  );
  const hasBoundedTokenGroup = (document, tokens, span) => {
    let anchor = document.indexOf(tokens[0]);
    while (anchor !== -1) {
      const window = document.slice(anchor, anchor + span);
      if (tokens.every((token) => window.includes(token))) return true;
      anchor = document.indexOf(tokens[0], anchor + 1);
    }
    return false;
  };
  const assertFixtureProvenanceLanguage = (name, document) => {
    assert.match(
      document,
      /crashfix-workspace-source-snapshot\/v2[\s\S]{0,700}approved_test_fixtures_sha256|approved_test_fixtures_sha256[\s\S]{0,700}crashfix-workspace-source-snapshot\/v2/,
      `${name}: fixture approval digest must be bound into source snapshot identity`,
    );
    assert.match(
      document,
      /report\.record_snapshot_provenance[\s\S]{0,700}approved_test_fixtures_sha256[\s\S]{0,240}approved_test_fixture_count|approved_test_fixtures_sha256[\s\S]{0,240}approved_test_fixture_count[\s\S]{0,700}report\.record_snapshot_provenance/,
      `${name}: report provenance must bind the approval digest and count`,
    );
    assert.match(
      document,
      /(?:12\s*位|12-character|12 char)[\s\S]{0,120}(?:前缀|prefix)[\s\S]{0,240}(?:approved_test_fixture_count|fixture\s*count|数量|计数)|(?:approved_test_fixture_count|fixture\s*count|数量|计数)[\s\S]{0,240}(?:12\s*位|12-character|12 char)[\s\S]{0,120}(?:前缀|prefix)/i,
      `${name}: public output must expose only a 12-character digest prefix and count`,
    );
  };
  const documentEntries = await Promise.all([
    ["canonical SKILL.md", new URL("../skills/crashfix/SKILL.md", import.meta.url)],
    ["distributed SKILL.md", new URL("../.claude/skills/crashfix/SKILL.md", import.meta.url)],
    ["AGENTS.md aggregate", new URL("../AGENTS.md", import.meta.url)],
    ["automation-policy.md", new URL("../skills/crashfix/references/automation-policy.md", import.meta.url)],
    ["evidence-contract.md", new URL("../skills/crashfix/references/evidence-contract.md", import.meta.url)],
    ["build-runner-contract.md", new URL("../skills/crashfix/references/build-runner-contract.md", import.meta.url)],
  ].map(async ([name, url]) => [name, await readFile(url, "utf8")]));
  const documents = new Map(documentEntries);
  const workflowSurfaces = [
    ["canonical SKILL.md", documents.get("canonical SKILL.md")],
    ["distributed SKILL.md", documents.get("distributed SKILL.md")],
    ["AGENTS.md aggregate", documents.get("AGENTS.md aggregate")],
  ];

  for (const [name, document] of workflowSurfaces) {
    assert.ok(document, `${name}: document is missing`);
    for (const token of [
      "probe-test-fixture",
      "--approved-test-fixture",
      "relative_path",
      "sha256",
      "--execution-profile local_trusted",
      "--project-classification test",
      "--fixture-approval-confirmed true",
      "--expected-source-ref-sha256",
      "approved_test_fixtures_sha256",
      "approved_test_fixture_count",
      "crashfix-workspace-source-snapshot/v2",
    ]) {
      assert.ok(document.includes(token), `${name}: missing fixture contract token ${token}`);
    }

    assert.match(
      document,
      /(?:测试\s*fixture|test[- ]fixture)[\s\S]{0,360}(?:默认关闭|默认禁用|default[^\n]{0,40}disabled)|(?:默认关闭|默认禁用|default[^\n]{0,40}disabled)[\s\S]{0,360}(?:测试\s*fixture|test[- ]fixture)|未(?:传|提供)[^。\n]{0,100}(?:批准|approved-test-fixture)[^。\n]{0,100}(?:保持)?关闭/i,
      `${name}: test-fixture approval must be disabled by default`,
    );
    assert.match(
      document,
      /(?:仅|只(?:有|允许)?)[\s\S]{0,180}local_trusted[\s\S]{0,220}(?:低敏[^。\n]{0,40}(?:测试|test)|(?:测试|test)[^。\n]{0,40}低敏)/i,
      `${name}: approval must be limited to local_trusted low-sensitivity test projects`,
    );
    assert.match(
      document,
      /当前用户[^。\n]{0,120}(?:独立|单独|显式)[^。\n]{0,40}确认|(?:独立|单独|显式)[^。\n]{0,40}当前用户[^。\n]{0,80}确认/,
      `${name}: approval must require a separate confirmation from the current user`,
    );
    assert.match(
      document,
      /probe(?:-test-fixture)?[\s\S]{0,420}(?:不|不得|不能|绝不)[^。\n]{0,60}(?:返回|输出|回显)[^。\n]{0,40}(?:文件)?内容/,
      `${name}: fixture probe must not return file contents`,
    );
    assert.match(
      document,
      /relative_path[\s\S]{0,320}(?:完整|full|64\s*位)[^。\n]{0,80}(?:SHA-?256|sha256)|(?:完整|full|64\s*位)[^。\n]{0,80}(?:SHA-?256|sha256)[\s\S]{0,320}relative_path/i,
      `${name}: approval must bind an exact relative path and full SHA-256`,
    );
    assert.match(
      document,
      /(?:精确|exact)[^。\n]{0,60}(?:相对路径|relative_path)|(?:相对路径|relative_path)[^。\n]{0,60}(?:精确|exact)/i,
      `${name}: the approved relative path must be exact`,
    );
    assert.match(
      document,
      /(?:仅|只(?:有|允许)?)[\s\S]{0,120}`?create`?[\s\S]{0,160}(?:接收|输入|传入|消费)[\s\S]{0,100}(?:批准|approval|approved-test-fixture)|(?:批准|approval|approved-test-fixture)[\s\S]{0,160}(?:仅|只(?:有|允许)?)[\s\S]{0,100}`?create`?[\s\S]{0,100}(?:接收|输入|传入|消费)/i,
      `${name}: only create may accept fixture approval input`,
    );
    for (const downstream of ["verify-source", "clone", "audit", "export-candidate"]) {
      assert.ok(document.includes(downstream), `${name}: missing downstream command ${downstream}`);
    }
    assert.match(
      document,
      /(?:verify-source|clone|audit|export-candidate)[\s\S]{0,700}(?:sealed manifest|密封[^。\n]{0,40}manifest)[^。\n]{0,120}(?:继承|读取)|(?:sealed manifest|密封[^。\n]{0,40}manifest)[^。\n]{0,120}(?:继承|读取)[\s\S]{0,700}(?:verify-source|clone|audit|export-candidate)/i,
      `${name}: downstream commands must inherit approvals from the sealed manifest`,
    );
    assert.match(
      document,
      /fixture[^。\n]{0,100}只用于本地契约测试[^。\n]{0,100}不是\s*CrashFix\s*运行时\s*source/i,
      `${name}: Crashlytics runtime source must not accept fixture data`,
    );
    assertFixtureProvenanceLanguage(name, document);
  }

  const safetyContracts = [
    ["canonical SKILL.md", documents.get("canonical SKILL.md")],
    ["automation-policy.md", documents.get("automation-policy.md")],
    ["evidence-contract.md", documents.get("evidence-contract.md")],
    ["build-runner-contract.md", documents.get("build-runner-contract.md")],
  ];
  for (const [name, document] of safetyContracts) {
    assert.ok(document, `${name}: document is missing`);
    for (const token of [
      "override_eligible=true",
      "structured_sensitive_value",
      "private_key_block",
      "high_confidence_token_or_sensitive_assignment",
      "credential_file_name",
      "credential_directory_name",
      "service_account",
      "authorized_user",
      "opaque_or_high_confidence_secret",
      "approved_test_fixtures_sha256",
      "approved_test_fixture_count",
    ]) {
      assert.ok(document.includes(token), `${name}: missing narrow fixture gate token ${token}`);
    }
    assert.match(
      document,
      /(?:只有|仅)[\s\S]{0,120}structured_sensitive_value[\s\S]{0,120}override_eligible=true[\s\S]{0,100}(?:才可|可由|可进入|可被)/,
      `${name}: only an internally eligible structured-sensitive finding may be approved`,
    );
    assert.ok(
      hasBoundedTokenGroup(document, [
        "private_key_block",
        "high_confidence_token_or_sensitive_assignment",
        "credential_file_name",
        "credential_directory_name",
        "service_account",
        "authorized_user",
        "opaque_or_high_confidence_secret",
      ], 900) && /opaque_or_high_confidence_secret[\s\S]{0,120}(?:override_eligible=false|(?:永不|不得|不能)[^。\n]{0,60}(?:豁免|批准|放行))/.test(document),
      `${name}: hard credential findings must remain non-overridable`,
    );
  }

  const provenanceContracts = [
    ["canonical SKILL.md", documents.get("canonical SKILL.md")],
    ["evidence-contract.md", documents.get("evidence-contract.md")],
    ["automation-policy.md", documents.get("automation-policy.md")],
  ];
  for (const [name, document] of provenanceContracts) {
    assert.ok(document, `${name}: document is missing`);
    assertFixtureProvenanceLanguage(name, document);
  }
});

test("checked-in Claude/OpenCode CrashFix bundle exactly mirrors the canonical skill", async () => {
  const canonical = new URL("../skills/crashfix/", import.meta.url);
  const distributed = new URL("../.claude/skills/crashfix/", import.meta.url);
  const canonicalFiles = await listBundleFiles(canonical);
  const distributedFiles = await listBundleFiles(distributed);
  assert.deepEqual(distributedFiles, canonicalFiles);
  for (const relativePath of canonicalFiles) {
    assert.equal(
      await readFile(new URL(relativePath, distributed), "utf8"),
      await readFile(new URL(relativePath, canonical), "utf8"),
      `distributed CrashFix bundle drifted at ${relativePath}`,
    );
  }
});

test("CrashFix keeps Git and Docker optional while preserving exact provenance and honest execution gates", async () => {
  const documents = await Promise.all([
    readFile(new URL("../skills/crashfix/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/crashfix/references/automation-policy.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/crashfix/references/evidence-contract.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/crashfix/references/build-runner-contract.md", import.meta.url), "utf8"),
  ]);
  const [skill, policy, contract, buildRunnerContract] = documents;
  const namedDocuments = [
    ["SKILL.md", skill],
    ["automation-policy.md", policy],
    ["evidence-contract.md", contract],
  ];

  // 三份 source-of-truth 必须声明同一个封闭枚举，避免自然语言被解释成可以使用任意
  // checkout，或在失败后静默降低 Git 路径的门槛。
  for (const [name, document] of namedDocuments) {
    assert.ok(
      document.includes("provenance_status=resolved|unavailable"),
      `${name}: must declare the closed provenance statuses`,
    );
    assert.ok(
      document.includes("provenance_mode=git_release_exact|snapshot_repro_equivalent"),
      `${name}: must declare the closed provenance modes`,
    );
    assert.match(
      document,
      /(?:(?:源码身份|provenance_mode)[\s\S]{0,120}(?:锁定|固定|一次 session\s*只允许)|(?:锁定|固定|一次 session\s*只允许)[\s\S]{0,120}(?:源码身份|provenance_mode))/,
      `${name}: must lock exactly one provenance mode per session`,
    );
    assert.match(
      document,
      /(?:Git[\s\S]{0,120}(?:可选|is optional|is not[\s\S]{0,60}(?:required|a prerequisite)|不是[\s\S]{0,60}(?:必需|前置(?:条件)?))|(?:可选|非必需)[^\n]{0,40}Git|Git 项目[\s\S]{0,160}非 Git 项目)/i,
      `${name}: must explicitly say that Git is optional`,
    );
    assert.ok(
      document.includes("provenance=auto|git|snapshot"),
      `${name}: must expose the closed user-selectable provenance modes`,
    );
    assert.match(
      document,
      /signature_version[^\n]{0,80}(?:\+|,|与)[^\n]{0,40}fingerprint|\(signature_version, fingerprint\)/,
      `${name}: analyzer identity must include signature version and fingerprint`,
    );
    assert.match(
      document,
      /legacy_fingerprint[\s\S]{0,180}(?:不能|不得)[\s\S]{0,100}(?:替代|证明|验证|合并|计入)/,
      `${name}: legacy fingerprint must not authorize primary grouping or verification`,
    );
  }

  for (const [name, document] of namedDocuments.slice(0, 2)) {
    assert.match(document, /(?:sealed source snapshot|密封(?:的)?源码快照)/i, `${name}: missing sealed source snapshot`);
    assert.match(document, /(?:source_snapshot_sha256|snapshot_manifest_sha256)/, `${name}: missing content-addressed snapshot identity`);
    assert.match(document, /(?:baseline artifact|基线产物)/i, `${name}: missing baseline artifact`);
    assert.match(
      document,
      /(?:真机[^\n]{0,160}(?:同一|相同)[^\n]{0,60}fingerprint|(?:同一|相同)[^\n]{0,60}fingerprint[^\n]{0,160}真机|real-device same fingerprint)/i,
      `${name}: no-Git patch must reproduce the same fingerprint on a real device`,
    );
    assert.match(document, /(?:禁止|不得)(?:自动)?(?:执行|运行)?\s*`git init`/, `${name}: must prohibit automatic git init`);
    assert.match(
      document,
      /(?:不得直接(?:扫描或)?修改(?:用户)?(?:的)?原(?:始)?(?:项目)?目录|(?:不得|禁止)[^\n]{0,40}(?:修改|写回)[^\n]{0,40}原(?:始)?(?:项目)?目录|不得在[^\n]{0,120}原项目[^\n]{0,120}修改|不自动回写原项目)/,
      `${name}: must prohibit editing the original project directory`,
    );
    assert.match(
      document,
      /(?:(?:非 Git|no-Git)[^\n]{0,180}`pr`[^\n]{0,180}(?:禁止|不支持|不能|不得|失败|停止)|`pr`[^\n]{0,180}(?:非 Git|no-Git)[^\n]{0,180}(?:禁止|不支持|不能|不得|失败|停止)|`pr`[^\n]{0,100}仅[^\n]{0,80}(?:Git|git_release_exact)|`snapshot_repro_equivalent`[^\n]{0,160}(?:永不|不能|不得)[^\n]{0,80}(?:PR|`pr`))/i,
      `${name}: no-Git pr mode must be rejected`,
    );
    assert.match(document, /(?:不得|禁止|不能)静默\s*降级/, `${name}: no-Git pr must not silently downgrade`);
    assert.match(document, /`git_release_exact`/, `${name}: must name the exact Git provenance path`);
    assert.match(document, /(?:release SHA|Git SHA)/i, `${name}: Git path must retain the exact release SHA gate`);
    assert.match(document, /worktree/i, `${name}: Git patch path must retain worktree isolation`);
  }

  // 非 Git 证据身份必须不可变且内容寻址；复制当前目录不能冒充来源证明。
  assert.match(contract, /snapshot_repro_equivalent/, "evidence contract must name snapshot provenance");
  assert.match(contract, /(?:不可变|内容寻址|manifest[^\n]{0,80}(?:哈希|hash))/i, "evidence contract must bind snapshot identity to immutable content");

  // 非 Git baseline 会执行不可信项目构建，必须把 clone/build/install 拆成独立、可审计的
  // 审批，并将 mutable clone 的审计重新绑定到 create 返回的可信 sealed snapshot。
  assert.match(skill, /独立的\*\*baseline 构建确认\*\*/);
  assert.match(policy, /baseline 构建审批（(?:仅 )?snapshot(?: patch| 路径)）/);
  assert.match(policy, /创建\*\*一次\*\*绑定的[\s\S]{0,120}baseline 私有 clone/);
  for (const requiredArg of [
    "--workspace-root",
    "--snapshot-root",
    "--expected-source-ref-sha256",
    "--expected-source-sha256",
    "--role baseline",
    "--role candidate",
  ]) {
    assert.ok(skill.includes(requiredArg), `SKILL.md: missing bounded audit argument ${requiredArg}`);
  }
  assert.match(skill, /--forbid-root <绝对项目目录>[\s\S]{0,120}--forbid-root <绝对 report\/viewer root>/);
  assert.match(
    skill,
    /clone --snapshot-root <内存 snapshot_root>[\s\S]{0,180}--expected-source-ref-sha256 <内存 source_ref_sha256>[\s\S]{0,180}--expected-source-sha256 <内存 source_snapshot_sha256>/,
  );
  assert.match(skill, /canonical_diff_sha256[\s\S]{0,100}candidate_manifest_sha256/);
  assert.match(skill, /truncated=false/);

  // Git-only PR 能力不匹配也必须先建报告再统一 finalize，但不得读取 Firebase 详情。
  assert.match(skill, /preflight_abort=capability_mismatch/);
  assert.match(skill, /若已锁存[\s\S]{0,80}`preflight_abort`/);
  assert.match(skill, /不进入 Phase 1/);
  assert.match(skill, /不调用任何 Firebase 身份或详情工具/);

  // 有效或损坏的 Git 元数据不能剥夺用户显式选择 snapshot 的能力；但 auto 仍不得把
  // Git 错误悄悄降级成 snapshot，且任何切换必须开启新 session。
  assert.match(skill, /`snapshot`：即使有有效或损坏 `\.git`[\s\S]{0,100}排除 VCS 元数据/);
  assert.match(skill, /auto 损坏\/不可用 Git[\s\S]{0,100}必须省略 mode/);
  assert.match(skill, /unavailable 的[\s\S]{0,80}`analyze`[\s\S]{0,80}remote-only/);
  assert.match(skill, /`patch\/pr`[\s\S]{0,100}preflight abort/);
  assert.match(contract, /损坏\/不可读\/不可用 Git[\s\S]{0,100}`unavailable`/);
  assert.match(contract, /失败不得自动 fallback/);
  assert.match(contract, /改变\s*provenance 必须新建 session/);

  // 构建前后既审计 clone，也有界复核原项目未被不可信构建脚本旁路写回。
  assert.match(skill, /verify-source --workspace <绝对项目目录>/);
  assert.match(skill, /--expected-source-ref-sha256 <内存 source_ref_sha256>/);
  assert.match(
    skill,
    /verify-source --workspace <绝对项目目录>[\s\S]{0,260}--forbid-root <session_dir>[\s\S]{0,120}--forbid-root <绝对 report\/viewer root>/,
  );
  assert.match(skill, /构建前后还必须各调用一次[\s\S]{0,80}`verify-source`/);
  assert.match(skill, /dynamic_exclusions_sha256/);
  assert.match(skill, /signature_version=<analyzer 主 signature_version>/);
  assert.match(
    contract,
    /新的 Firebase 证据缺任一字段必须拒绝[\s\S]{0,160}signature_degraded=false && cross_source_comparable=true/,
  );
  for (const analyzerField of [
    "signature_version",
    "signature_degraded",
    "cross_source_comparable",
  ]) {
    assert.ok(contract.includes(analyzerField), `evidence contract: missing ${analyzerField}`);
  }
  assert.match(contract, /signature_version[\s\S]{0,80}fingerprint[\s\S]{0,120}绑定进 key/);
  assert.match(
    contract,
    /report\.record_snapshot_provenance[\s\S]{0,120}完整 64 位[\s\S]{0,300}meta\.extra[\s\S]{0,300}只公开 12 位哈希前缀/,
  );
  assert.match(skill, /report\.record_snapshot_provenance/);
  assert.match(contract, /report\.record_snapshot_provenance/);
  assert.match(policy, /report\.record_snapshot_provenance/);
  for (const document of [skill, contract, policy]) {
    assert.match(document, /report\.record_candidate_provenance/);
  }
  assert.match(contract, /stage="candidate"[\s\S]*stage="verification"[\s\S]*stage="export"/);
  assert.match(contract, /candidate\/verification\/export[\s\S]{0,160}组不完整时[\s\S]{0,40}整组不公开/);
  for (const document of [skill, contract, policy]) {
    assert.match(document, /(?:禁止|不得)[^。\n]{0,24}直接修改\s*`meta\.json`/);
  }
  assert.match(
    policy,
    /所有 `verify-source` 调用[\s\S]{0,260}复用 create[\s\S]{0,120}完全相同的 `--forbid-root`/,
  );
  assert.match(policy, /两遍 manifest[\s\S]{0,120}不承诺抵御[\s\S]{0,80}同 UID/);
  assert.match(policy, /构建进程组完全退出/);
  assert.match(policy, /导出 parent[\s\S]{0,120}不可 group\/other 写入/);
  assert.match(skill, /构建 profile 必须诚实且单路由/);
  assert.match(skill, /execution_profile=local_trusted\|docker_strict/);
  assert.match(skill, /未指定时选择 `local_trusted`/);
  assert.match(skill, /禁止自动 fallback 或混用证据/);
  assert.match(skill, /requested_execution_profile=<锁定 profile>/);
  assert.match(skill, /`execution_profile` 是候选构建后的派生证据/);
  assert.match(skill, /requested_execution_profile` 一致/);
  assert.match(policy, /build_environment\/v2/);
  assert.match(policy, /network_policy:"denied"/);
  assert.match(policy, /network_policy:"not_enforced"/);
  assert.match(policy, /strong_isolation:false/);
  assert.match(policy, /local_trusted_execution_eligible=true/);
  for (const document of [policy, buildRunnerContract]) {
    assert.match(document, /workspace_disk_quota:\{enforced:false, mechanism:"none"\}/);
    assert.match(document, /workspace_disk_quota:\{enforced:true, mechanism:"attested"\}/);
    assert.match(
      document,
      /workspace_disk_quota_enforced = build_environment\.workspace_disk_quota\.enforced/,
    );
  }

  // 随机临时 candidate 不能冒充已交付结果；snapshot patch 必须经独立审批导出到用户
  // 选择的全新目录，并重新绑定已接受的 manifest/diff。
  assert.match(policy, /候选导出审批（snapshot 路径）/);
  assert.match(skill, /export-candidate/);
  for (const requiredArg of [
    "--original-workspace",
    "--expected-candidate-manifest-sha256",
    "--expected-canonical-diff-sha256",
    "--destination",
  ]) {
    assert.ok(skill.includes(requiredArg), `SKILL.md: missing candidate export argument ${requiredArg}`);
  }
  assert.match(skill, /--original-workspace <绝对项目目录>/);
  assert.match(skill, /`--original-workspace`[\s\S]{0,140}不能用 `--forbid-root`[\s\S]{0,80}替代/);
  assert.match(skill, /尚不存在[\s\S]{0,160}不授权覆盖或回写原项目/);
  assert.match(skill, /返回值不得含目标绝对路径/);
  assert.match(skill, /一旦 publish[\s\S]{0,160}cleanup_unconfirmed[\s\S]{0,160}不得[\s\S]{0,80}recursive/);
});

test("CrashFix user docs disclose snapshot export and platform capability limits", async () => {
  const [readme, crashlytics, setup, clients] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/CRASHLYTICS.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/SETUP.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/CLIENTS.md", import.meta.url), "utf8"),
  ]);

  assert.match(
    crashlytics,
    /snapshot `patch`[\s\S]{0,240}真机 3\/3[\s\S]{0,240}单独批准一次候选导出/,
  );
  assert.match(crashlytics, /选择一个尚不存在[\s\S]{0,180}全新私有目录/);
  assert.match(crashlytics, /拒绝导出[\s\S]{0,80}`aborted`/);
  assert.match(readme, /snapshot 候选通过 3\/3[\s\S]{0,180}单独批准\s*导出/);
  assert.match(readme, /Firebase 修复视图[\s\S]{0,320}浏览器不会直连 Firebase/);
  assert.match(
    crashlytics,
    /`npm run sessions`[\s\S]{0,360}strict 的 3 个验证 child/,
  );
  for (const [name, document] of [
    ["README.md", readme],
    ["CRASHLYTICS.md", crashlytics],
    ["SETUP.md", setup],
    ["CLIENTS.md", clients],
  ]) {
    assert.match(document, /local_trusted/, `${name}: must document the default trusted-host profile`);
    assert.match(document, /docker_strict|Docker 严格/, `${name}: must document optional strict Docker`);
    assert.match(
      document,
      /(?:不提供强隔离|未强制隔离|没有进程级 sandbox|not_enforced)/,
      `${name}: must not present local_trusted as strong isolation`,
    );
  }

  for (const primitive of ["POSIX", "O_NOFOLLOW", "O_NONBLOCK", "O_DIRECTORY"]) {
    assert.ok(crashlytics.includes(primitive), `CRASHLYTICS.md must disclose ${primitive}`);
  }
  assert.match(crashlytics, /Windows 目前不能使用 snapshot provenance/);
  assert.match(crashlytics, /不代表改走 Git 就能自动[\s\S]{0,120}Git 路径仍须/);
  assert.match(setup, /Windows 当前 fail-closed/);
  assert.match(setup, /不承诺 Windows 上的 Git\s*\n路径能够进入自动补丁/);
  assert.match(clients, /Windows[\s\S]{0,120}fail-closed[\s\S]{0,180}不[\s\S]{0,20}保证[\s\S]{0,40}Git patch 可用/);
  assert.match(readme, /Windows 会 fail-closed[\s\S]{0,120}不能[\s\S]{0,40}Windows 自动补丁兜底/);
});

test("CrashFix fixture pipeline normalizes, fingerprints, archives and deduplicates one event", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "crashfix-pipeline-"));
  try {
    const projectId = "demo-project";
    const appId = "1:1234567890:android:abc123";
    const issueId = "issue-private-123";
    const eventId = "event-private-456";
    const fixturePath = path.join(temporaryRoot, "events.fixture.json");
    await writeFile(fixturePath, JSON.stringify({
      schema_version: "crashlytics-fixture/v1",
      apps: [{
        project_id: projectId,
        firebase_app_id: appId,
        platform: "android",
        package_name: "com.example.demo",
      }],
      events: [{
        resource: { labels: { project_id: projectId, firebase_app_id: appId } },
        jsonPayload: {
          platform: "ANDROID",
          bundleOrPackage: "com.example.demo",
          eventId,
          eventTime: "2026-07-29T01:00:00Z",
          issue: { id: issueId, type: "FATAL" },
          issueTitle: "java.lang.IllegalStateException",
          version: { displayVersion: "2.4.0", buildVersion: "240" },
          exceptions: [{
            type: "java.lang.IllegalStateException",
            frames: [{
              function: "com.example.demo.HomeViewModel.load",
              file: "/Users/private-user/repo/app/src/main/HomeViewModel.kt",
              line: 42,
              blamed: true,
            }],
          }],
        },
      }],
    }), { mode: 0o600 });

    const service = createServiceFromEnvironment({
      CRASHLYTICS_PROVIDER: "fixture",
      CRASHLYTICS_PROJECT_ALLOWLIST: projectId,
      CRASHLYTICS_APP_ALLOWLIST: `${projectId}=${appId}`,
      CRASHLYTICS_FIXTURE_PATH: fixturePath,
      CRASHLYTICS_MAX_WINDOW_HOURS: "24",
    });
    const event = await service.getEvent({
      project_id: projectId,
      firebase_app_id: appId,
      event_id: eventId,
      start_time: "2026-07-29T00:00:00Z",
      end_time: "2026-07-29T02:00:00Z",
      frame_limit: 80,
    });
    assert.equal(event.issue.id, issueId);
    assert.equal(event.kind, "java");
    assert.equal(event.app.build_version, "240");
    assert.doesNotMatch(event.frames[0]?.file ?? "", /private-user/);

    const analysis = analyzeCrashEvent(event);
    assert.match(analysis.fingerprint, /^[a-f0-9]{12}$/);
    assert.equal(analysis.signature_version, "java-v2");
    assert.match(analysis.canonical_stack, /^Normalized Crash Event/m);
    assert.equal(analysis.signature_degraded, false);
    assert.equal(analysis.cross_source_comparable, true);

    const session = await createSession({
      name: "crashfix-e2e",
      workspaceRoot: path.join(temporaryRoot, "sessions"),
      sourceLock: {
        provider: "firebase-crashlytics",
        acquisition_route: "official_firebase_mcp",
      },
      extra: {
        origin: "remote",
        provider: "firebase-crashlytics",
        acquisition_route: "official_firebase_mcp",
        source_locked: true,
        raw_evidence_archived: false,
      },
    });
    const externalKey = createHash("sha256")
      .update([
        event.provider,
        event.project_id,
        event.firebase_app_id,
        event.issue.id,
        event.event.id,
        analysis.signature_version,
        analysis.fingerprint,
      ].join("\0"), "utf8")
      .digest("hex");
    const source = {
      provider: event.provider,
      external_key: externalKey,
      project: event.project_id,
      app: event.firebase_app_id,
      issue: event.issue.id,
      event: event.event.id,
      occurred: event.event.occurred_at,
    };
    const first = await recordCrashEvidence(session.dir, {
      signature: analysis.fingerprint,
      signature_version: analysis.signature_version,
      stack: analysis.canonical_stack,
      kind: analysis.kind,
      repro_path: [],
      source,
      acquisition_route: "official_firebase_mcp",
    });
    const retry = await recordCrashEvidence(session.dir, {
      signature: analysis.fingerprint,
      signature_version: analysis.signature_version,
      stack: analysis.canonical_stack,
      kind: analysis.kind,
      repro_path: [],
      source,
      acquisition_route: "official_firebase_mcp",
    });
    assert.equal(first.deduplicated, false);
    assert.equal(retry.deduplicated, true);

    const sessionAnalysis = await analyzeSession(session.dir);
    assert.equal(sessionAnalysis.total, 1);
    assert.equal(sessionAnalysis.unique, 1);
    assert.equal(sessionAnalysis.groups[0]?.fingerprint, analysis.fingerprint);
    assert.equal(sessionAnalysis.groups[0]?.sources?.[0]?.external_key, externalKey);

    const crashes = await readCrashes(session.dir);
    assert.equal(crashes[0]?.signature_version, analysis.signature_version);
    const markdown = renderMarkdown({
      meta: await loadMeta(session.dir),
      steps: [],
      crashes,
      summary: "CrashFix fixture contract pipeline",
    });
    assert.match(markdown, /firebase-crashlytics/);
    assert.match(markdown, /签名版本\*\*：\s*`java-v2`/);
    assert.match(markdown, /引用 sha256:[a-f0-9]{10}/);
    assert.doesNotMatch(markdown, new RegExp([
      projectId,
      appId,
      issueId,
      eventId,
      externalKey,
    ].map(escapeRegExp).join("|")));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function listBundleFiles(rootUrl, relativeDirectory = "") {
  const entries = await readdir(new URL(relativeDirectory || ".", rootUrl), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listBundleFiles(rootUrl, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      assert.fail(`skill bundle contains a non-regular entry: ${relativePath}`);
    }
  }
  return files;
}
