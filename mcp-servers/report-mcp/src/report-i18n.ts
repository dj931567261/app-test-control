import { z } from "zod";

export const REPORT_LANGUAGES = ["zh-CN", "en-US"] as const;

export const reportLanguageSchema = z.enum(REPORT_LANGUAGES);

export type ReportLanguage = z.infer<typeof reportLanguageSchema>;

export const DEFAULT_REPORT_LANGUAGE: ReportLanguage = "zh-CN";

/**
 * 报告语言来自会话控制元数据，而不是远端证据或报告正文。
 * 缺失、未知或类型错误的值统一回退为简体中文。
 */
export function resolveReportLanguage(value?: unknown): ReportLanguage {
  const parsed = reportLanguageSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_REPORT_LANGUAGE;
}

export interface ReportMessages {
  session: string;
  id: string;
  status: string;
  started: string;
  ended: string;
  duration: string;
  steps: string;
  crashes: string;
  extra: string;
  buildRunnerIsolation: string;
  localTrustedIsolationNotice: string;
  summary: string;
  rootCauseAnalysis: string;
  rootCause: string;
  confidence: string;
  category: string;
  locations: string;
  remediation: string;
  limitations: string;
  crashfixLifecycle: string;
  workflow: string;
  mode: string;
  acquisitionRoute: string;
  provenance: string;
  candidate: string;
  candidatePrepared: string;
  candidateMissing: string;
  verification: string;
  verificationPassed: string;
  verificationMissing: string;
  exportStatus: string;
  exported: string;
  notExported: string;
  changedFiles: string;
  at: string;
  signatureVersion: string;
  analyzerIdentity: string;
  detectedAfterStep: string;
  afterStep: string;
  reproPathSteps: string;
  reproPath: string;
  source: string;
  stack: string;
  fullLog: string;
  noStepsRecorded: string;
  step: string;
  screenshot: string;
  log: string;
  totalSteps: string;
  passed: string;
  failed: string;
  skipped: string;
  generatedBy: string;
  inProgress: string;
  unknown: string;
  referenceSha256: string;
  occurred: string;
}

export const REPORT_MESSAGES: Readonly<
  Record<ReportLanguage, Readonly<ReportMessages>>
> = {
  "zh-CN": {
    session: "会话",
    // ID、SHA-256、provider、signature_version 等技术标识保持原样。
    id: "ID",
    status: "状态",
    started: "开始时间",
    ended: "结束时间",
    duration: "耗时",
    steps: "步骤",
    crashes: "崩溃",
    extra: "附加信息",
    buildRunnerIsolation: "构建 Runner 隔离",
    localTrustedIsolationNotice:
      "已请求或绑定的 local_trusted 执行不具备强隔离；未强制限制工作区磁盘配额、网络访问、文件系统写入和敏感文件系统访问，进程约束也仅为尽力而为。",
    summary: "摘要",
    rootCauseAnalysis: "根因分析",
    rootCause: "根因",
    confidence: "置信度",
    category: "分类",
    locations: "位置",
    remediation: "修复建议",
    limitations: "限制",
    crashfixLifecycle: "修复状态",
    workflow: "流程",
    mode: "模式",
    acquisitionRoute: "数据源",
    provenance: "源码身份",
    candidate: "候选修复",
    candidatePrepared: "已生成候选",
    candidateMissing: "尚未生成候选",
    verification: "验证",
    verificationPassed: "已完成 3/3 严格验证",
    verificationMissing: "尚未完成 3/3 严格验证",
    exportStatus: "导出",
    exported: "已导出候选",
    notExported: "尚未导出候选",
    changedFiles: "变更文件",
    at: "时间",
    signatureVersion: "签名版本",
    analyzerIdentity: "分析器身份",
    detectedAfterStep: "检测于步骤之后",
    afterStep: "发生于步骤之后",
    reproPathSteps: "复现路径（步骤）",
    reproPath: "复现路径",
    source: "来源",
    stack: "堆栈",
    fullLog: "完整日志",
    noStepsRecorded: "暂无步骤记录",
    step: "步骤",
    screenshot: "截图",
    log: "日志",
    totalSteps: "步骤总数",
    passed: "通过",
    failed: "失败",
    skipped: "跳过",
    generatedBy: "生成工具",
    inProgress: "进行中",
    unknown: "未知",
    referenceSha256: "引用 sha256",
    occurred: "发生于",
  },
  "en-US": {
    session: "Session",
    id: "ID",
    status: "Status",
    started: "Started",
    ended: "Ended",
    duration: "Duration",
    steps: "Steps",
    crashes: "Crashes",
    extra: "Extra",
    buildRunnerIsolation: "Build Runner isolation",
    localTrustedIsolationNotice:
      "requested or bound local_trusted execution is not strongly isolated; workspace disk quota, network access, filesystem writes, and secret-filesystem access are not enforced, and process containment is best-effort only.",
    summary: "Summary",
    rootCauseAnalysis: "Root cause analysis",
    rootCause: "Root cause",
    confidence: "Confidence",
    category: "Category",
    locations: "Locations",
    remediation: "Remediation",
    limitations: "Limitations",
    crashfixLifecycle: "Repair status",
    workflow: "Workflow",
    mode: "Mode",
    acquisitionRoute: "Acquisition route",
    provenance: "Source provenance",
    candidate: "Candidate",
    candidatePrepared: "Candidate prepared",
    candidateMissing: "No candidate prepared",
    verification: "Verification",
    verificationPassed: "Strict verification completed (3/3)",
    verificationMissing: "Strict verification not completed (3/3)",
    exportStatus: "Export",
    exported: "Candidate exported",
    notExported: "Candidate not exported",
    changedFiles: "Changed files",
    at: "At",
    signatureVersion: "Signature version",
    analyzerIdentity: "Analyzer identity",
    detectedAfterStep: "Detected after step",
    afterStep: "After step",
    reproPathSteps: "Repro path (steps)",
    reproPath: "Repro path",
    source: "Source",
    stack: "Stack",
    fullLog: "Full log",
    noStepsRecorded: "no steps recorded",
    step: "Step",
    screenshot: "Screenshot",
    log: "Log",
    totalSteps: "Total steps",
    passed: "Passed",
    failed: "Failed",
    skipped: "Skipped",
    generatedBy: "Generated by",
    inProgress: "in progress",
    unknown: "unknown",
    referenceSha256: "ref sha256",
    occurred: "occurred",
  },
};

export function getReportCopy(language?: unknown): Readonly<ReportMessages> {
  return REPORT_MESSAGES[resolveReportLanguage(language)];
}

export const REPORT_STATUSES = ["running", "passed", "failed", "aborted"] as const;

export type ReportStatus = typeof REPORT_STATUSES[number];

export const REPORT_STATUS_LABELS: Readonly<
  Record<ReportLanguage, Readonly<Record<ReportStatus, string>>>
> = {
  "zh-CN": {
    running: "进行中",
    passed: "通过",
    failed: "失败",
    aborted: "已中止",
  },
  "en-US": {
    running: "RUNNING",
    passed: "PASSED",
    failed: "FAILED",
    aborted: "ABORTED",
  },
};

/** 只本地化展示文本；持久化的 status 技术值保持不变。 */
export function formatReportStatus(
  status: ReportStatus,
  language?: unknown,
): string {
  return REPORT_STATUS_LABELS[resolveReportLanguage(language)][status];
}

/**
 * 保持既有的四舍五入和分段规则，仅本地化展示单位。
 */
export function formatReportDuration(
  milliseconds: number,
  language?: unknown,
): string {
  if (milliseconds < 0 || !Number.isFinite(milliseconds)) return "—";

  const seconds = Math.round(milliseconds / 1_000);
  const resolvedLanguage = resolveReportLanguage(language);
  if (seconds < 60) {
    return resolvedLanguage === "zh-CN" ? `${seconds}秒` : `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return resolvedLanguage === "zh-CN"
      ? `${minutes}分 ${remainingSeconds}秒`
      : `${minutes}m ${remainingSeconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return resolvedLanguage === "zh-CN"
    ? `${hours}小时 ${remainingMinutes}分`
    : `${hours}h ${remainingMinutes}m`;
}

const CRASHFIX_ACTION_LABELS_ZH_CN = {
  preflight: "预检",
  remote_scope_verification: "远程范围核验",
  remote_issue_triage: "远程问题分诊",
  remote_evidence_archival: "远程证据归档",
  crash_identity_analysis: "崩溃身份分析",
  source_provenance_binding: "源码来源绑定",
  test_fixture_probe: "测试夹具探测",
  test_fixture_approval: "测试夹具审批",
  source_snapshot: "源码快照",
  source_location: "源码定位",
  baseline_validation: "基线验证",
  candidate_preparation: "候选修复准备",
  candidate_validation: "候选修复验证",
  real_device_verification: "真机验证",
  candidate_export: "候选修复导出",
  abort: "中止",
} as const;

export type KnownCrashfixAction = keyof typeof CRASHFIX_ACTION_LABELS_ZH_CN;

function isKnownCrashfixAction(action: string): action is KnownCrashfixAction {
  return Object.prototype.hasOwnProperty.call(CRASHFIX_ACTION_LABELS_ZH_CN, action);
}

/**
 * 英文报告保留原 action code；中文报告增加可读名称，同时保留原 code 供审计。
 * 未知 action 始终原样返回，不尝试翻译技术标识。
 */
export function formatStepAction(
  action: string,
  language?: unknown,
): string {
  if (resolveReportLanguage(language) === "en-US" || !isKnownCrashfixAction(action)) {
    return action;
  }
  return `${CRASHFIX_ACTION_LABELS_ZH_CN[action]} (${action})`;
}
