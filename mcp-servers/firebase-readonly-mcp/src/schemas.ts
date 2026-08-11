import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const FIREBASE_REPORTS_GUIDE_URI = "firebase://guides/crashlytics/reports";
export const MAX_UPSTREAM_RESPONSE_BYTES = 1024 * 1024;

const boundedDisplayText = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "control characters are forbidden");

const firebaseAppId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, "invalid Firebase App ID");

const issueId = z
  .string()
  .min(8)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, "invalid Crashlytics issue ID");

const eventResourceName = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u, "invalid Crashlytics event resource name");

// 固定版 firebase-tools 会把这些字段作为 `label (detail)` 形式的
// displayName 传给 Crashlytics API。网关在出网前镜像该约束，避免把
// firstSeenVersion 等裸版本号误当成可用的 versionDisplayName。
const groupedDisplayText = boundedDisplayText.refine(
  (value) => /^[^()]+\s+\([^()]+\)$/u.test(value),
  "display name must use the exact 'label (detail)' format",
);

const groupedDisplayList = z.array(groupedDisplayText).max(8);

const crashlyticsFilterSchema = z
  .object({
    intervalStartTime: z.string().datetime({ offset: true }).optional(),
    intervalEndTime: z.string().datetime({ offset: true }).optional(),
    versionDisplayNames: groupedDisplayList.optional(),
    issueId: issueId.optional(),
    issueVariantId: issueId.optional(),
    issueErrorTypes: z
      .array(z.enum(["FATAL", "NON_FATAL", "ANR"]))
      .max(3)
      .optional(),
    issueSignals: z
      .array(z.enum(["SIGNAL_EARLY", "SIGNAL_FRESH", "SIGNAL_REGRESSED", "SIGNAL_REPETITIVE"]))
      .max(4)
      .optional(),
    operatingSystemDisplayNames: groupedDisplayList.optional(),
    deviceDisplayNames: groupedDisplayList.optional(),
    deviceFormFactors: z
      .array(z.enum(["PHONE", "TABLET", "DESKTOP", "TV", "WATCH"]))
      .max(5)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasStart = value.intervalStartTime !== undefined;
    const hasEnd = value.intervalEndTime !== undefined;
    if (hasStart !== hasEnd) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: hasStart ? ["intervalEndTime"] : ["intervalStartTime"],
        message: "intervalStartTime and intervalEndTime must be supplied together",
      });
      return;
    }
    if (hasStart && hasEnd) {
      const start = Date.parse(value.intervalStartTime!);
      const end = Date.parse(value.intervalEndTime!);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: !Number.isFinite(start) ? ["intervalStartTime"] : ["intervalEndTime"],
          message: "Crashlytics interval timestamps must be valid dates",
        });
      } else if (start > end) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["intervalEndTime"],
          message: "intervalEndTime must not precede intervalStartTime",
        });
      } else if (end - start > 90 * 24 * 60 * 60 * 1000) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["intervalEndTime"],
          message: "Crashlytics intervals are limited to 90 days",
        });
      }
    }
  });

const issueScopedEventFilterSchema = crashlyticsFilterSchema.refine(
  (value) => value.issueId !== undefined || value.issueVariantId !== undefined,
  { message: "list_events requires filter.issueId or filter.issueVariantId" },
);

export const upstreamFirebaseToolSchemas = {
  firebase_get_environment: z.object({}).strict(),
  firebase_get_project: z.object({}).strict(),
  firebase_list_apps: z
    .object({ platform: z.enum(["ios", "android", "web", "all"]).optional() })
    .strict(),
  firebase_read_resources: z
    .object({ uris: z.tuple([z.literal(FIREBASE_REPORTS_GUIDE_URI)]) })
    .strict(),
  crashlytics_get_issue: z
    .object({ appId: firebaseAppId, issueId })
    .strict(),
  crashlytics_list_events: z
    .object({
      appId: firebaseAppId,
      filter: issueScopedEventFilterSchema,
      pageSize: z.number().int().min(1).max(3).default(1),
    })
    .strict(),
  crashlytics_batch_get_events: z
    .object({
      appId: firebaseAppId,
      names: z
        .array(eventResourceName)
        .min(1)
        .max(3)
        .refine((names) => new Set(names).size === names.length, {
          message: "event resource names must be unique",
        }),
    })
    .strict(),
  crashlytics_get_report: z
    .object({
      appId: firebaseAppId,
      report: z.enum([
        "topIssues",
        "topVariants",
        "topVersions",
        "topOperatingSystems",
        "topAppleDevices",
        "topAndroidDevices",
      ]),
      filter: crashlyticsFilterSchema.optional(),
      pageSize: z.number().int().min(1).max(3).default(3),
    })
    .strict(),
} as const;

export type UpstreamFirebaseToolName = keyof typeof upstreamFirebaseToolSchemas;

export const UPSTREAM_FIREBASE_READ_TOOLS = Object.freeze(
  Object.keys(upstreamFirebaseToolSchemas) as UpstreamFirebaseToolName[],
);

export const publicFirebaseToolSchemas = {
  firebase_get_environment: upstreamFirebaseToolSchemas.firebase_get_environment,
  firebase_get_project: upstreamFirebaseToolSchemas.firebase_get_project,
  firebase_list_apps: upstreamFirebaseToolSchemas.firebase_list_apps,
  firebase_get_crashlytics_report_guide: z.object({}).strict(),
  crashlytics_get_issue: upstreamFirebaseToolSchemas.crashlytics_get_issue,
  crashlytics_list_events: upstreamFirebaseToolSchemas.crashlytics_list_events,
  crashlytics_batch_get_events: upstreamFirebaseToolSchemas.crashlytics_batch_get_events,
  crashlytics_get_report: upstreamFirebaseToolSchemas.crashlytics_get_report,
} as const;

export type PublicFirebaseToolName = keyof typeof publicFirebaseToolSchemas;

export const PUBLIC_FIREBASE_READ_TOOLS = Object.freeze(
  Object.keys(publicFirebaseToolSchemas) as PublicFirebaseToolName[],
);

export const publicToUpstreamFirebaseToolName = {
  firebase_get_environment: "firebase_get_environment",
  firebase_get_project: "firebase_get_project",
  firebase_list_apps: "firebase_list_apps",
  firebase_get_crashlytics_report_guide: "firebase_read_resources",
  crashlytics_get_issue: "crashlytics_get_issue",
  crashlytics_list_events: "crashlytics_list_events",
  crashlytics_batch_get_events: "crashlytics_batch_get_events",
  crashlytics_get_report: "crashlytics_get_report",
} as const satisfies Record<PublicFirebaseToolName, UpstreamFirebaseToolName>;

const upstreamTextContentSchema = z
  .object({
    type: z.literal("text"),
    text: z.string().min(1).max(MAX_UPSTREAM_RESPONSE_BYTES),
  })
  .strict();

const upstreamToolResultSchema = z
  .object({
    content: z.array(upstreamTextContentSchema).min(1).max(16),
    isError: z.boolean().optional(),
    // 固定版官方 MCP 会同时返回等价的 structuredContent。网关只校验并丢弃它，
    // 下游仍只接收有界文本，避免把额外元数据面透传给 Agent。
    structuredContent: z.record(z.unknown()).optional(),
    // MCP 协议允许顶层 _meta。只做有界 JSON 校验并丢弃，既避免未来兼容性
    // 漂移，也不把上游元数据面暴露给 Agent。
    _meta: z.record(z.unknown()).optional(),
  })
  .strict();

function boundedJsonObjectBytes(value: Record<string, unknown>, label: string): number {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    throw new Error(`official Firebase MCP ${label} is invalid`);
  }
  if (bytes > MAX_UPSTREAM_RESPONSE_BYTES) {
    throw new Error(`official Firebase MCP ${label} exceeded the byte limit`);
  }
  return bytes;
}

export function sanitizeUpstreamToolResult(value: unknown): CallToolResult {
  const parsed = upstreamToolResultSchema.parse(value);
  if (parsed.isError === true) {
    throw new Error("official Firebase MCP returned an error");
  }
  const bytes = parsed.content.reduce(
    (total, item) => total + Buffer.byteLength(item.text, "utf8"),
    0,
  );
  if (bytes > MAX_UPSTREAM_RESPONSE_BYTES) {
    throw new Error("official Firebase MCP response exceeded the byte limit");
  }
  let aggregateBytes = bytes;
  if (parsed.structuredContent !== undefined) {
    aggregateBytes += boundedJsonObjectBytes(parsed.structuredContent, "structured response");
  }
  if (parsed._meta !== undefined) {
    aggregateBytes += boundedJsonObjectBytes(parsed._meta, "metadata");
  }
  if (aggregateBytes > MAX_UPSTREAM_RESPONSE_BYTES) {
    throw new Error("official Firebase MCP aggregate response exceeded the byte limit");
  }
  return { content: parsed.content };
}

const upstreamGuideResultSchema = z
  .object({
    content: z.tuple([upstreamTextContentSchema]),
    isError: z.boolean().optional(),
    _meta: z.record(z.unknown()).optional(),
  })
  .strict();

/**
 * 固定版上游把资源编码成单个文本 wrapper，而不是 MCP resource content。
 * 这里只接受它针对唯一固定 URI 的精确形状，并仅向公共别名返回正文。
 */
export function sanitizeCrashlyticsReportGuideResult(value: unknown): CallToolResult {
  const parsed = upstreamGuideResultSchema.parse(value);
  if (parsed.isError === true) {
    throw new Error("official Firebase MCP returned an error");
  }
  const wrapped = parsed.content[0].text;
  let aggregateBytes = Buffer.byteLength(wrapped, "utf8");
  if (aggregateBytes > MAX_UPSTREAM_RESPONSE_BYTES) {
    throw new Error("official Firebase MCP response exceeded the byte limit");
  }
  if (parsed._meta !== undefined) {
    aggregateBytes += boundedJsonObjectBytes(parsed._meta, "metadata");
  }
  if (aggregateBytes > MAX_UPSTREAM_RESPONSE_BYTES) {
    throw new Error("official Firebase MCP aggregate response exceeded the byte limit");
  }

  const openingPrefix = `<resource uri="${FIREBASE_REPORTS_GUIDE_URI}" title="`;
  const openingSuffix = `">\n`;
  const closing = `\n</resource>`;
  if (!wrapped.startsWith(openingPrefix) || !wrapped.endsWith(closing)) {
    throw new Error("official Firebase MCP guide wrapper is invalid");
  }
  const titleEnd = wrapped.indexOf(openingSuffix, openingPrefix.length);
  if (titleEnd < 0) {
    throw new Error("official Firebase MCP guide wrapper is invalid");
  }
  const title = wrapped.slice(openingPrefix.length, titleEnd);
  if (
    title.length < 1
    || title.length > 256
    || /["<>\u0000-\u001f\u007f]/u.test(title)
  ) {
    throw new Error("official Firebase MCP guide wrapper title is invalid");
  }
  const bodyStart = titleEnd + openingSuffix.length;
  const body = wrapped.slice(bodyStart, -closing.length);
  if (
    body.trim().length === 0
    || /<\/?resource\b/iu.test(body)
  ) {
    throw new Error("official Firebase MCP guide body is invalid");
  }
  return { content: [{ type: "text", text: body }] };
}
