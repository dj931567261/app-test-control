import { z } from "zod";

import {
  computeSignature,
  normalizeFrame,
  type CrashKind,
  type ParsedStack,
  type SignatureResult,
} from "./signature.js";

/** Limits are enforced both by zod and by the pure analyzer entry point. */
export const MAX_CRASH_EVENT_BYTES = 1024 * 1024;
export const MAX_CRASH_EVENT_FRAMES = 256;
export const MAX_CRASH_EVENT_CANONICAL_STACK_BYTES = 512 * 1024;

const MAX_ID_CHARS = 512;
const MAX_TITLE_CHARS = 2_048;
const MAX_SYMBOL_CHARS = 2_048;
const MAX_MODULE_CHARS = 512;
const MAX_FILE_CHARS = 2_048;
const MAX_PROCESS_CHARS = 512;
const MAX_VERSION_CHARS = 256;
const MAX_ADDRESS_CHARS = 128;
const MAX_AGGREGATE_COUNT = Number.MAX_SAFE_INTEGER;

const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const INLINE_CONTROL_RE = /[\u0000-\u001f\u007f]/;
const PROVIDER = "firebase-crashlytics" as const;

function inlineString(maxChars: number) {
  return z
    .string()
    .min(1)
    .max(maxChars)
    .refine((value) => value === value.trim(), "must not have surrounding whitespace")
    .refine((value) => !INLINE_CONTROL_RE.test(value), "must be a single printable line");
}

const timestampSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) => RFC3339_RE.test(value) && Number.isFinite(Date.parse(value)),
    "must be a valid RFC 3339 timestamp",
  );

const offsetSchema = z.union([
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z
    .string()
    .min(1)
    .max(MAX_ADDRESS_CHARS)
    .regex(/^(?:0[xX][0-9a-fA-F]{1,16}|\d{1,20})$/),
]);

export const normalizedCrashFrameSchema = z
  .object({
    index: z.number().int().nonnegative().max(65_535),
    symbol: inlineString(MAX_SYMBOL_CHARS),
    module: inlineString(MAX_MODULE_CHARS).optional(),
    file: inlineString(MAX_FILE_CHARS).optional(),
    line: z.number().int().nonnegative().max(2_147_483_647).optional(),
    app_owned: z.boolean().optional(),
    address: z
      .string()
      .min(1)
      .max(MAX_ADDRESS_CHARS)
      .regex(/^(?:0[xX])?[0-9a-fA-F]+$/)
      .optional(),
    offset: offsetSchema.optional(),
  })
  .strict();

export type NormalizedCrashFrame = z.infer<typeof normalizedCrashFrameSchema>;

const aggregateSchema = z
  .object({
    events: z.number().int().nonnegative().max(MAX_AGGREGATE_COUNT).optional(),
    users: z.number().int().nonnegative().max(MAX_AGGREGATE_COUNT).optional(),
    first_seen: timestampSchema.optional(),
    last_seen: timestampSchema.optional(),
  })
  .strict();

const canonicalStackSchema = z
  .string()
  .min(1)
  .max(MAX_CRASH_EVENT_CANONICAL_STACK_BYTES)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_CRASH_EVENT_CANONICAL_STACK_BYTES,
    `canonical_stack exceeds ${MAX_CRASH_EVENT_CANONICAL_STACK_BYTES} byte size limit`,
  );

export const normalizedCrashEventSchema = z
  .object({
    schema_version: z.literal("crash-event/v1"),
    provider: z.literal(PROVIDER),
    project_id: inlineString(MAX_ID_CHARS),
    firebase_app_id: inlineString(MAX_ID_CHARS),
    app: z
      .object({
        platform: z.enum(["android", "ios"]),
        package_name: inlineString(MAX_ID_CHARS).optional(),
        bundle_id: inlineString(MAX_ID_CHARS).optional(),
        version_name: inlineString(MAX_VERSION_CHARS).optional(),
        build_version: inlineString(MAX_VERSION_CHARS).optional(),
      })
      .strict(),
    issue: z
      .object({
        id: inlineString(MAX_ID_CHARS),
        title: inlineString(MAX_TITLE_CHARS),
        type: inlineString(128),
        state: inlineString(128).optional(),
      })
      .strict(),
    event: z
      .object({
        id: inlineString(MAX_ID_CHARS),
        occurred_at: timestampSchema,
      })
      .strict(),
    fatal: z.boolean(),
    kind: z.enum(["java", "anr", "native", "ios", "unknown"]),
    process: inlineString(MAX_PROCESS_CHARS).optional(),
    thread: inlineString(MAX_PROCESS_CHARS).optional(),
    exception: z
      .object({
        class: inlineString(MAX_ID_CHARS).optional(),
        root_cause_class: inlineString(MAX_ID_CHARS).optional(),
        signal: inlineString(128).optional(),
      })
      .strict(),
    frames: z
      .array(normalizedCrashFrameSchema)
      .min(1)
      .max(MAX_CRASH_EVENT_FRAMES),
    canonical_stack: canonicalStackSchema,
    symbolication: z.enum(["symbolicated", "partial", "unsymbolicated", "unknown"]),
    aggregate: aggregateSchema.optional(),
    redaction: z
      .object({
        fields_removed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        values_masked: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .optional(),
    truncated: z.boolean(),
    fetched_at: timestampSchema,
  })
  .strict();

export type NormalizedCrashEvent = z.infer<typeof normalizedCrashEventSchema>;

export interface CrashEventAnalysis extends SignatureResult {
  canonical_stack: string;
  canonical_frames: string[];
  /**
   * True when the primary fingerprint intentionally uses a coarse identity in
   * order to bridge provider evidence with local device logs. Degraded
   * fingerprints are useful for correlation but must not authorize an
   * automatic patch.
   */
  signature_degraded: boolean;
  /** Whether an equivalent supported local representation hashes identically. */
  cross_source_comparable: boolean;
  degraded_reason?:
    | "anr_process_only_identity"
    | "anr_missing_process"
    | "native_signal_only_identity"
    | "native_missing_signal"
    | "ios_missing_process_identity"
    | "ios_missing_frame_offset"
    | "unknown_crash_kind";
  signal?: string;
  process?: string;
  event_ref: {
    provider: typeof PROVIDER;
    project_id: string;
    firebase_app_id: string;
    issue_id: string;
    event_id: string;
    occurred_at: string;
  };
}

/**
 * Analyze a normalized Crashlytics event without trusting its pre-rendered
 * canonical_stack. Validated structured fields are the identity source; the
 * supplied stack remains bounded evidence. ANR/native use explicitly degraded
 * cross-source bridges, and every emitted stack round-trips through
 * analyze_session.
 */
export function analyzeCrashEvent(input: unknown): CrashEventAnalysis {
  const event = normalizedCrashEventSchema.parse(input);
  assertEventByteBudget(event);
  assertSequentialFrameIndexes(event.frames);
  assertPlatformKind(event);

  const { parsed, canonicalFrames } = eventToParsedStack(event);
  const signature = computeSignature(parsed);
  const canonicalStack = parsedStackToCanonicalEvent(parsed);
  const comparison = crossSourceComparison(event, parsed);

  // This invariant protects stored remote evidence: re-opening a report must
  // yield exactly the signature returned at ingestion time.
  const roundTripSignature = computeSignature(canonicalStack);
  if (
    signature.fingerprint !== roundTripSignature.fingerprint ||
    signature.signature_version !== roundTripSignature.signature_version
  ) {
    throw new Error("canonical crash event stack failed signature round-trip");
  }

  return {
    ...signature,
    canonical_stack: canonicalStack,
    canonical_frames: canonicalFrames,
    signature_degraded: comparison.signatureDegraded,
    cross_source_comparable: comparison.crossSourceComparable,
    ...(comparison.degradedReason !== undefined
      ? { degraded_reason: comparison.degradedReason }
      : {}),
    ...(parsed.signal !== undefined ? { signal: parsed.signal } : {}),
    ...(parsed.process !== undefined ? { process: parsed.process } : {}),
    event_ref: {
      provider: PROVIDER,
      project_id: event.project_id,
      firebase_app_id: event.firebase_app_id,
      issue_id: event.issue.id,
      event_id: event.event.id,
      occurred_at: event.event.occurred_at,
    },
  };
}

function assertEventByteBudget(event: NormalizedCrashEvent): void {
  const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
  if (bytes > MAX_CRASH_EVENT_BYTES) {
    throw new RangeError(
      `crash event exceeds ${MAX_CRASH_EVENT_BYTES} byte size limit`,
    );
  }
}

function assertSequentialFrameIndexes(frames: NormalizedCrashFrame[]): void {
  for (const [position, frame] of frames.entries()) {
    if (frame.index !== position) {
      throw new Error(
        `frames must use ordered contiguous indexes; expected ${position}, received ${frame.index}`,
      );
    }
  }
}

function assertPlatformKind(event: NormalizedCrashEvent): void {
  if (event.kind === "ios" && event.app.platform !== "ios") {
    throw new Error("kind ios requires app.platform ios");
  }
  if ((event.kind === "java" || event.kind === "anr") && event.app.platform !== "android") {
    throw new Error(`kind ${event.kind} requires app.platform android`);
  }
  if (event.kind === "java" && !event.exception.class) {
    throw new Error("java crash event requires exception.class");
  }
  if (
    (event.kind === "native" || event.kind === "ios") &&
    !event.exception.class &&
    !event.exception.signal
  ) {
    throw new Error(`${event.kind} crash event requires exception.class or exception.signal`);
  }
}

function eventToParsedStack(event: NormalizedCrashEvent): {
  parsed: ParsedStack;
  canonicalFrames: string[];
} {
  const ordered = [...event.frames].sort((a, b) => a.index - b.index);
  const byIndex = ordered.map((frame) => ({
    frame,
    canonical: canonicalizeCrashFrame(frame, event.kind),
  }));
  const canonicalFrames = byIndex.map(({ canonical }) => canonical);
  const appFrameIndex = byIndex.findIndex(({ frame }) => frame.app_owned === true);
  const appFrame = appFrameIndex >= 0 ? byIndex[appFrameIndex]?.canonical : undefined;

  const process = resolveProcess(event);
  // Crashlytics ANR thread frames are not present in the ordinary ActivityManager
  // logcat record. Likewise a complete native backtrace is not guaranteed to be
  // present in logcat. Use the only identities shared by both sources and mark
  // them degraded in the public result so they can never qualify auto-patching.
  const signatureFrames = event.kind === "anr" && process
    ? [`anr:${process}`]
    : event.kind === "native" && event.exception.signal
      ? [event.exception.signal]
      : canonicalFrames;
  const parsed: ParsedStack = {
    kind: event.kind as CrashKind,
    top_frames: signatureFrames,
  };
  if (
    event.exception.class !== undefined
    && !(event.kind === "native" && event.exception.signal !== undefined)
  ) {
    parsed.exception_class = event.exception.class;
  }
  if (event.kind === "java" && event.exception.root_cause_class !== undefined) {
    parsed.root_cause_class = event.exception.root_cause_class;
  }
  if (event.exception.signal !== undefined) parsed.signal = event.exception.signal;
  // Existing Java fingerprints intentionally do not include a process. This
  // keeps structured Java events compatible with compute_signature(rawStack).
  // Native signal-only bridging also omits process because the first logcat
  // fatal-signal record frequently lacks it.
  if (
    event.kind !== "java"
    && !(event.kind === "native" && event.exception.signal !== undefined)
    && process !== undefined
  ) parsed.process = process;
  if (event.kind === "ios" && appFrame !== undefined) {
    parsed.identity_frames = [appFrame];
  }

  if (parsed.top_frames.length === 0) {
    throw new Error("crash event requires at least one usable canonical frame");
  }
  return { parsed, canonicalFrames };
}

function crossSourceComparison(
  event: NormalizedCrashEvent,
  parsed: ParsedStack,
): {
  signatureDegraded: boolean;
  crossSourceComparable: boolean;
  degradedReason?: CrashEventAnalysis["degraded_reason"];
} {
  if (event.kind === "anr") {
    return parsed.process
      ? {
          signatureDegraded: true,
          crossSourceComparable: true,
          degradedReason: "anr_process_only_identity",
        }
      : {
          signatureDegraded: true,
          crossSourceComparable: false,
          degradedReason: "anr_missing_process",
        };
  }
  if (event.kind === "native") {
    return event.exception.signal
      ? {
          signatureDegraded: true,
          crossSourceComparable: true,
          degradedReason: "native_signal_only_identity",
        }
      : {
          signatureDegraded: true,
          crossSourceComparable: false,
          degradedReason: "native_missing_signal",
        };
  }
  if (event.kind === "unknown") {
    return {
      signatureDegraded: true,
      crossSourceComparable: false,
      degradedReason: "unknown_crash_kind",
    };
  }
  if (event.kind === "ios" && !event.app.bundle_id && !event.process) {
    return {
      signatureDegraded: true,
      crossSourceComparable: false,
      degradedReason: "ios_missing_process_identity",
    };
  }
  if (event.kind === "ios" && !hasComparableIosFrameOffsets(event)) {
    return {
      signatureDegraded: true,
      crossSourceComparable: false,
      degradedReason: "ios_missing_frame_offset",
    };
  }
  return { signatureDegraded: false, crossSourceComparable: true };
}

function hasComparableIosFrameOffsets(event: NormalizedCrashEvent): boolean {
  const ordered = [...event.frames].sort((a, b) => a.index - b.index);
  const identityFrames = ordered.slice(0, 4);
  const appOwned = ordered.find((frame) => frame.app_owned === true);
  if (appOwned && !identityFrames.some((frame) => frame.index === appOwned.index)) {
    identityFrames.push(appOwned);
  }
  return identityFrames.every((frame) =>
    frame.offset !== undefined || OFFSET_SUFFIX_CAPTURE_RE.test(frame.symbol));
}

function resolveProcess(event: NormalizedCrashEvent): string | undefined {
  if (event.kind === "ios") {
    return event.app.bundle_id ?? event.process ?? event.firebase_app_id;
  }
  return event.process ?? event.app.package_name;
}

const UNKNOWN_SYMBOL_RE = /^(?:\?{1,3}|unknown|<unknown>|\[REDACTED_[A-Z0-9_]+\]|(?:0[xX])?[0-9a-fA-F]+)$/i;
const NATIVE_OFFSET_SUFFIX_RE = /\s*\+\s*(?:0[xX][0-9a-fA-F]+|\d+)$/;
const OFFSET_SUFFIX_CAPTURE_RE = /\s*\+\s*(0[xX][0-9a-fA-F]+|\d+)$/;

/** Canonical frame identity intentionally excludes volatile addresses/lines. */
export function canonicalizeCrashFrame(
  frame: NormalizedCrashFrame,
  kind: CrashKind,
): string {
  let symbol = normalizeWhitespace(frame.symbol.replace(/^\s*at\s+/, ""));
  if (kind === "java" || kind === "anr") {
    return normalizeFrame(symbol);
  }

  const inlineOffset = OFFSET_SUFFIX_CAPTURE_RE.exec(symbol)?.[1];
  symbol = symbol.replace(NATIVE_OFFSET_SUFFIX_RE, "").trim();
  const moduleName = frame.module === undefined
    ? undefined
    : moduleBasename(normalizeWhitespace(frame.module));
  if (kind === "ios") {
    const offset = canonicalDecimalOffset(frame.offset ?? inlineOffset) ?? "0";
    if (!UNKNOWN_SYMBOL_RE.test(symbol)) return `${symbol}+${offset}`;
    if (!moduleName) {
      throw new Error(
        `frame ${frame.index} is unsymbolicated and lacks a stable image name`,
      );
    }
    return `${moduleName}+${offset}`;
  }
  if (!UNKNOWN_SYMBOL_RE.test(symbol)) {
    return moduleName ? `${moduleName}!${symbol}` : symbol;
  }

  const offset = canonicalOffset(frame.offset);
  if (!moduleName || offset === undefined) {
    throw new Error(
      `frame ${frame.index} is unsymbolicated and lacks a stable module-relative offset`,
    );
  }
  return `${moduleName}+${offset}`;
}

function canonicalDecimalOffset(
  value: NormalizedCrashFrame["offset"] | string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  try {
    return BigInt(value).toString(10);
  } catch {
    throw new Error("frame offset is not a valid bounded integer");
  }
}

function canonicalOffset(value: NormalizedCrashFrame["offset"]): string | undefined {
  if (value === undefined) return undefined;
  try {
    const integer = typeof value === "number" ? BigInt(value) : BigInt(value);
    return `0x${integer.toString(16)}`;
  } catch {
    throw new Error("frame offset is not a valid bounded integer");
  }
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function moduleBasename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/** Compact format parsed by signature.parseStack without changing legacy input. */
function parsedStackToCanonicalEvent(parsed: ParsedStack): string {
  const lines = ["Normalized Crash Event", `Kind: ${parsed.kind}`];
  if (parsed.exception_class) lines.push(`Exception Class: ${parsed.exception_class}`);
  if (parsed.root_cause_class) lines.push(`Root Cause Class: ${parsed.root_cause_class}`);
  if (parsed.signal) lines.push(`Signal: ${parsed.signal}`);
  if (parsed.process) lines.push(`Process: ${parsed.process}`);
  if (parsed.identity_frames?.[0]) {
    lines.push(`Identity Frame: ${parsed.identity_frames[0]}`);
  }
  for (const [index, frame] of parsed.top_frames.entries()) {
    lines.push(`Frame ${index}: ${frame}`);
  }
  return lines.join("\n");
}
