import { MAX_CANONICAL_STACK_BYTES, PROVIDER_NAME } from "./constants.js";
import type {
  CrashEvent,
  CrashFrame,
  Platform,
  SymbolicationStatus,
} from "./model.js";
import { boundedIdentifier, redactText } from "./redact.js";

type UnknownRecord = Record<string, unknown>;

export interface NormalizeContext {
  projectId: string;
  firebaseAppId: string;
  frameLimit: number;
  fetchedAt?: string;
}

function record(value: unknown): UnknownRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as UnknownRecord;
}

function atPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    const object = record(current);
    if (!object) return undefined;
    current = object[segment];
  }
  return current;
}

function first(source: unknown, paths: readonly string[]): unknown {
  for (const path of paths) {
    const value = atPath(source, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function firstAcross(sources: readonly unknown[], paths: readonly string[]): unknown {
  for (const source of sources) {
    const value = first(source, paths);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function identifierClaims(
  sources: readonly unknown[],
  paths: readonly string[],
): { values: string[]; invalid: boolean } {
  const values: string[] = [];
  let invalid = false;
  for (const source of sources) {
    for (const path of paths) {
      const raw = atPath(source, path);
      if (raw === undefined || raw === null) continue;
      const value = boundedIdentifier(raw);
      if (value === undefined) invalid = true;
      else values.push(value);
    }
  }
  return { values: [...new Set(values)], invalid };
}

function parseEventResourceName(value: unknown): {
  projectId: string;
  appId: string;
  eventId: string;
} | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 1_024) return undefined;
  const match = /^projects\/([^/]+)\/apps\/([^/]+)\/events\/([^/]+)$/u.exec(value);
  if (!match) return undefined;
  const projectId = boundedIdentifier(match[1]);
  const appId = boundedIdentifier(match[2]);
  const eventId = boundedIdentifier(match[3]);
  return projectId && appId && eventId ? { projectId, appId, eventId } : undefined;
}

function recordArray(source: unknown, paths: readonly string[]): UnknownRecord[] {
  const value = first(source, paths);
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => record(item))
    .filter((item): item is UnknownRecord => item !== undefined);
}

function bool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return undefined;
}

function boundedNumber(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < min || number > max) return undefined;
  return number;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  return new Date(time).toISOString();
}

function platform(value: unknown): Platform {
  if (typeof value !== "string") return "unknown";
  const lowered = value.toLowerCase();
  if (lowered.includes("android")) return "android";
  if (lowered.includes("ios") || lowered.includes("apple")) return "ios";
  return "unknown";
}

function eventPlatform(value: unknown, firebaseAppId: string): Platform {
  const explicit = platform(value);
  if (explicit !== "unknown") return explicit;
  const loweredId = firebaseAppId.toLowerCase();
  if (loweredId.includes(":android:")) return "android";
  if (loweredId.includes(":ios:")) return "ios";
  return "unknown";
}

function appIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(candidate)
    ? candidate
    : undefined;
}

function safeAddress(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  return /^(?:0[xX])?[0-9a-fA-F]{1,32}$/.test(text) ? text : undefined;
}

/**
 * Normalize provider offsets into the analyzer's unambiguous wire format.
 * Decimal strings stay decimal; bare hexadecimal values containing A-F gain
 * a 0x prefix. Values wider than 64 bits are dropped instead of emitting a
 * crash-event/v1 object that the downstream analyzer must reject.
 */
function safeOffset(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  if (/^\d{1,20}$/u.test(text)) {
    const decimal = BigInt(text);
    return decimal <= 0xffff_ffff_ffff_ffffn ? decimal.toString(10) : undefined;
  }
  const hexadecimal = /^(?:0[xX])?([0-9a-fA-F]{1,16})$/u.exec(text);
  if (
    !hexadecimal
    || (!/^0[xX]/u.test(text) && !/[a-fA-F]/u.test(hexadecimal[1] ?? ""))
  ) return undefined;
  return `0x${BigInt(`0x${hexadecimal[1]}`).toString(16)}`;
}

function normalizeFrameFile(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(value)?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== "file") return undefined;
  const normalized = value.replace(/^file:\/\//iu, "").replace(/\\/gu, "/");
  const rawParts = normalized.split("/");
  // Never reinterpret traversal evidence as a trustworthy repository suffix.
  // Leading/trailing empty segments are allowed for absolute paths, but dot
  // segments or repeated separators make the provider path ambiguous.
  if (
    rawParts.some((part) => part === "." || part === "..")
    || rawParts.slice(1, -1).some((part) => part.length === 0)
  ) return undefined;
  let parts = rawParts.filter((part) => part.length > 0);
  if (parts.length === 0) return undefined;

  const lower = parts.map((part) => part.toLowerCase());
  const usersIndex = lower.findIndex((part) => part === "users" || part === "home");
  if (usersIndex >= 0 && parts.length > usersIndex + 2) {
    parts = parts.slice(usersIndex + 2);
  } else {
    const tmpIndex = lower.findIndex((part) => part === "tmp");
    const tempMarkerIndex = lower.lastIndexOf("t");
    if (tmpIndex >= 0 && parts.length > tmpIndex + 1) {
      parts = parts.slice(tmpIndex + 1);
    } else if (lower.includes("folders") && tempMarkerIndex >= 0 && parts.length > tempMarkerIndex + 1) {
      parts = parts.slice(tempMarkerIndex + 1);
    } else if (/^[A-Za-z]:$/u.test(parts[0] ?? "") || normalized.startsWith("/")) {
      parts = parts.slice(-8);
    }
  }
  return parts.join("/") || undefined;
}

function crashedThread(payload: UnknownRecord): UnknownRecord | undefined {
  const threads = recordArray(payload, ["threads", "crash.threads"]);
  return threads.find((item) => bool(first(item, [
    "crashed",
    "is_crashed",
    "isCrashed",
    "triggered",
  ])) === true) ?? threads[0];
}

function firstRecordWithFrames(records: readonly UnknownRecord[]): UnknownRecord | undefined {
  return records.find((item) => Array.isArray(first(item, ["frames", "stack.frames"])));
}

function frameArray(
  payload: UnknownRecord,
  exceptions: readonly UnknownRecord[],
  errors: readonly UnknownRecord[],
  thread: UnknownRecord | undefined,
): unknown[] {
  const direct = first(payload, [
    "frames",
    "exception.frames",
    "stacktrace.frames",
    "stack_trace.frames",
    "crash.frames",
    "crashed_thread.frames",
  ]);
  if (Array.isArray(direct)) return direct;

  for (const owner of [
    firstRecordWithFrames(exceptions),
    firstRecordWithFrames(errors),
    thread,
  ]) {
    const frames = first(owner, ["frames", "stack.frames"]);
    if (Array.isArray(frames)) return frames;
  }

  const blameFrame = record(first(payload, ["blameFrame", "blame_frame"]));
  if (blameFrame) return [blameFrame];
  return [];
}

const UNKNOWN_SYMBOL_RE = /^(?:\?{1,3}|unknown|<unknown>|\[REDACTED_[A-Z0-9_]+\]|(?:0[xX])?[0-9a-fA-F]+)$/iu;

export function hasSymbolicatedFrameSymbol(frame: Pick<CrashFrame, "symbol">): boolean {
  const symbol = frame.symbol.trim();
  return symbol.length > 0 && !UNKNOWN_SYMBOL_RE.test(symbol);
}

function symbolicationFor(
  frames: readonly CrashFrame[],
  explicit: unknown,
): SymbolicationStatus {
  const totalFrames = frames.length;
  const symbolicatedFrames = frames.filter(hasSymbolicatedFrameSymbol).length;
  let observed: SymbolicationStatus;
  if (totalFrames === 0) {
    observed = "unknown";
  } else if (symbolicatedFrames === totalFrames) {
    observed = "symbolicated";
  } else if (symbolicatedFrames === 0) {
    observed = "unsymbolicated";
  } else {
    observed = "partial";
  }

  const normalizedExplicit = typeof explicit === "string" ? explicit.toLowerCase() : undefined;
  if (!normalizedExplicit || ![
    "symbolicated",
    "partial",
    "unsymbolicated",
    "unknown",
  ].includes(normalizedExplicit)) {
    return observed;
  }

  // Provider metadata may conservatively downgrade the evidence, but it must
  // never turn visibly unknown/address-only frames into a symbolicated result.
  const rank: Record<SymbolicationStatus, number> = {
    unknown: 0,
    unsymbolicated: 1,
    partial: 2,
    symbolicated: 3,
  };
  const declared = normalizedExplicit as SymbolicationStatus;
  return rank[declared] < rank[observed] ? declared : observed;
}

function eventKind(
  value: unknown,
  appPlatform: Platform,
  exceptions: readonly UnknownRecord[],
  errors: readonly UnknownRecord[],
): CrashEvent["kind"] {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (appPlatform === "ios") return "ios";
  if (text.includes("anr")) return "anr";
  if (text.includes("native") || text.includes("signal") || text.includes("ndk")) return "native";
  if (text.includes("java") || text.includes("exception")) return "java";
  if (appPlatform === "android" && errors.length > 0 && exceptions.length === 0) return "native";
  if (appPlatform === "android" && exceptions.length > 0) return "java";
  return "unknown";
}

function issueType(value: unknown, fatal: boolean, kind: CrashEvent["kind"]): string {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (text.includes("anr") || kind === "anr") return "anr";
  if (text.includes("nonfatal") || text.includes("non_fatal") || text.includes("non-fatal")) {
    return "non_fatal";
  }
  if (fatal || text.includes("crash") || text.includes("fatal")) return "crash";
  return "unknown";
}

function fatalFor(explicit: unknown, issueTypeValue: unknown, kind: CrashEvent["kind"]): boolean {
  const parsed = bool(explicit);
  if (parsed !== undefined) return parsed;
  const text = typeof issueTypeValue === "string" ? issueTypeValue.toLowerCase() : "";
  if (text.includes("nonfatal") || text.includes("non_fatal") || text.includes("non-fatal")) {
    return false;
  }
  return kind === "anr" || text.includes("fatal") || text.includes("crash");
}

function sameBlameFrame(frame: UnknownRecord, blame: UnknownRecord | undefined): boolean {
  if (!blame) return false;
  const frameSymbol = first(frame, ["symbol", "function", "function_name", "functionName", "method"]);
  const blameSymbol = first(blame, ["symbol", "function", "function_name", "functionName", "method"]);
  if (typeof frameSymbol !== "string" || frameSymbol !== blameSymbol) return false;
  for (const paths of [
    ["file", "file_name", "fileName", "source_file", "sourceFile"],
    ["line", "line_number", "lineNumber"],
    ["module", "library", "binary_name", "binaryName", "image_name", "imageName"],
  ] as const) {
    const left = first(frame, paths);
    const right = first(blame, paths);
    if (left !== undefined && right !== undefined && left !== right) return false;
  }
  return true;
}

export function buildCanonicalStack(
  exceptionClass: string | undefined,
  signal: string | undefined,
  frames: readonly CrashFrame[],
): { value: string; truncated: boolean } {
  const lines: string[] = [];
  if (exceptionClass || signal) {
    lines.push([exceptionClass, signal].filter(Boolean).join(" "));
  }
  for (const frame of frames) {
    const owner = frame.module ? `${frame.module}!` : "";
    const symbol = frame.symbol ?? "<unknown>";
    const source = frame.file
      ? ` (${frame.file}${frame.line !== undefined ? `:${frame.line}` : ""})`
      : "";
    lines.push(`#${frame.index} ${owner}${symbol}${source}`);
  }
  const bounded = redactText(lines.join("\n"), MAX_CANONICAL_STACK_BYTES);
  return { value: bounded?.value ?? "", truncated: bounded?.truncated ?? false };
}

/**
 * Converts a Cloud Logging entry or fixture event into the public allowlisted
 * schema. Unknown properties (customKeys, user ids, installation ids, logs and
 * breadcrumbs included) are intentionally never copied.
 */
export function normalizeCrashEvent(
  raw: unknown,
  context: NormalizeContext,
): CrashEvent | undefined {
  const root = record(raw);
  if (!root) return undefined;
  const payload = record(root.jsonPayload) ?? record(root.payload) ?? root;
  const resourceLabels = record(first(root, ["resource.labels"])) ?? {};
  const labels = record(root.labels) ?? {};
  const sources = [payload, resourceLabels, labels, root];
  const rawName = first(payload, ["name"]);
  const nameIdentity = parseEventResourceName(rawName);
  if (rawName !== undefined && nameIdentity === undefined) return undefined;

  const projectClaims = identifierClaims(sources, ["project_id", "projectId"]);
  if (nameIdentity) projectClaims.values.push(nameIdentity.projectId);
  if (
    projectClaims.invalid
    || projectClaims.values.length === 0
    || projectClaims.values.some((value) => value !== context.projectId)
  ) return undefined;

  const appClaims = identifierClaims(
    sources,
    ["firebase_app_id", "firebaseAppId", "app_id", "appId"],
  );
  if (nameIdentity) appClaims.values.push(nameIdentity.appId);
  if (
    appClaims.invalid
    || appClaims.values.length === 0
    || appClaims.values.some((value) => value !== context.firebaseAppId)
  ) return undefined;

  const issueClaims = identifierClaims(sources, ["issue_id", "issueId", "issue.id"]);
  if (issueClaims.invalid || issueClaims.values.length !== 1) return undefined;
  const issueId = issueClaims.values[0];

  const eventClaims = identifierClaims(sources, ["event_id", "eventId", "event.id"]);
  if (nameIdentity) eventClaims.values.push(nameIdentity.eventId);
  if (eventClaims.invalid || new Set(eventClaims.values).size > 1) return undefined;
  const eventId = eventClaims.values[0] ?? boundedIdentifier(root.insertId);
  const occurredAt = timestamp(
    firstAcross(sources, [
      "occurred_at",
      "event_time",
      "eventTime",
      "timestamp",
      "event.occurred_at",
    ]),
  );
  if (!issueId || !eventId || !occurredAt) return undefined;

  const exceptions = recordArray(payload, ["exceptions"]);
  const errors = recordArray(payload, ["errors"]);
  const primaryException = exceptions[0];
  const rootException = exceptions.at(-1);
  const primaryError = errors[0];
  const crashThread = crashedThread(payload);
  const blameFrame = record(first(payload, ["blameFrame", "blame_frame"]));

  let anyTruncated = false;
  const text = (value: unknown, maxChars = 2_048): string | undefined => {
    const result = redactText(value, Math.min(maxChars * 4, 8 * 1024));
    if (!result) return undefined;
    anyTruncated ||= result.truncated;
    const singleLine = result.value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
    if (!singleLine) return undefined;
    if (singleLine.length > maxChars) {
      anyTruncated = true;
      return singleLine.slice(0, maxChars);
    }
    return singleLine;
  };

  const diagnosticToken = (value: unknown, maxChars: number): string | undefined => {
    const candidate = text(value, maxChars);
    return candidate && /^[A-Za-z_][A-Za-z0-9_.$:+-]*$/u.test(candidate)
      ? candidate
      : undefined;
  };

  const exceptionClass = diagnosticToken(
    first(payload, ["exception.class", "exception.type", "exception_class", "exception_type"])
      ?? first(primaryException, ["type", "class", "name", "exceptionType"]),
    512,
  );
  const rootCauseClass = exceptions.length > 1
    ? diagnosticToken(first(rootException, ["type", "class", "name", "exceptionType"]), 512)
    : undefined;
  const signal = diagnosticToken(
    first(payload, ["exception.signal", "signal", "signal_name", "signalName"])
      ?? first(primaryError, [
        "signal",
        "signal_name",
        "signalName",
        "errorType",
        "type",
        "errorCode",
        "code",
      ]),
    128,
  );
  const rawFrames = frameArray(payload, exceptions, errors, crashThread);
  const clippedFrames = rawFrames.slice(0, context.frameLimit);
  if (rawFrames.length > clippedFrames.length) anyTruncated = true;
  const frames: CrashFrame[] = [];
  for (let index = 0; index < clippedFrames.length; index += 1) {
    const source = clippedFrames[index];
    const sourceRecord = record(source);
    if (!sourceRecord) continue;
    const symbol = text(
      first(sourceRecord, ["symbol", "function", "function_name", "functionName", "method"]),
      2_048,
    ) ?? "<unknown>";
    const frame: CrashFrame = { index: frames.length, symbol };
    const moduleName = text(
      first(sourceRecord, [
        "module",
        "library",
        "binary_name",
        "binaryName",
        "image_name",
        "imageName",
      ]),
      512,
    );
    const rawFile = first(sourceRecord, [
      "file",
      "file_name",
      "fileName",
      "source_file",
      "sourceFile",
    ]);
    // Validate the provider path before generic text redaction can turn a
    // forbidden URI/control character into an innocuous-looking placeholder.
    const prevalidatedFile = typeof rawFile === "string"
      ? normalizeFrameFile(rawFile)
      : undefined;
    const file = normalizeFrameFile(text(prevalidatedFile, 2_048));
    const line = boundedNumber(
      first(sourceRecord, ["line", "line_number", "lineNumber"]),
      1,
      2_147_483_647,
    );
    const appOwned = bool(first(sourceRecord, [
      "app_owned",
      "in_app",
      "inApp",
      "is_app",
      "isApp",
      "blamed",
      "isBlamed",
    ])) ?? (sameBlameFrame(sourceRecord, blameFrame) ? true : undefined);
    const address = safeAddress(first(sourceRecord, ["address", "pc"]));
    const offset = safeOffset(first(sourceRecord, ["offset", "symbol_offset", "symbolOffset"]));
    if (moduleName !== undefined) frame.module = moduleName;
    if (file !== undefined) frame.file = file;
    if (line !== undefined) frame.line = line;
    if (appOwned !== undefined) frame.app_owned = appOwned;
    if (address !== undefined) frame.address = address;
    if (offset !== undefined) frame.offset = offset;
    frames.push(frame);
  }

  // Crashlytics issue titles and exception messages are free-form and may
  // contain arbitrary user data. Never expose them from the production
  // boundary; derive a stable diagnostic-only label instead.
  const issueTitle = exceptionClass ?? signal ?? "Crashlytics issue";
  const appPlatform = eventPlatform(
    firstAcross(sources, ["app.platform", "platform", "os"]),
    context.firebaseAppId,
  );
  const rawIssueType = first(payload, ["issue.type", "issue_type", "issueType", "event_type", "type"]);
  const rawKind = first(payload, [
    "kind",
    "runtime",
    "event_type",
    "eventType",
    "issue.type",
    "issue_type",
    "issueType",
  ]);
  const inferredKind = eventKind(rawKind, appPlatform, exceptions, errors);
  const kind = inferredKind === "unknown" && appPlatform === "android" && exceptionClass
    ? "java"
    : inferredKind;
  const fatal = fatalFor(first(payload, ["fatal", "is_fatal", "isFatal"]), rawIssueType, kind);
  const normalizedIssueType = issueType(
    rawIssueType,
    fatal,
    kind,
  );
  const bundleOrPackage = first(payload, ["bundleOrPackage", "bundle_or_package"]);
  const packageName = appIdentifier(
    first(payload, ["app.package_name", "package_name", "packageName"])
      ?? (appPlatform === "android" ? bundleOrPackage : undefined),
  );
  const bundleId = appIdentifier(
    first(payload, ["app.bundle_id", "bundle_id", "bundleId"])
      ?? (appPlatform === "ios" ? bundleOrPackage : undefined),
  );
  const versionName = text(first(payload, [
    "app.version_name",
    "version_name",
    "versionName",
    "version.displayVersion",
    "version.versionName",
  ]), 256);
  const buildVersion = text(first(payload, [
    "app.build_version",
    "build_version",
    "buildVersion",
    "version.buildVersion",
    "build",
  ]), 256);
  // Use only the already-normalized app identity. Provider process/thread
  // names are free-form and can contain user-controlled text.
  const processName = packageName ?? bundleId;
  if (appPlatform === "unknown" || frames.length === 0) return undefined;
  const compatibleKind = kind === "java" && exceptionClass === undefined
    ? "unknown"
    : (kind === "ios" || kind === "native") && exceptionClass === undefined && signal === undefined
      ? "unknown"
      : kind;
  const canonical = buildCanonicalStack(exceptionClass, signal, frames);
  anyTruncated ||= canonical.truncated;

  const event: CrashEvent = {
    schema_version: "crash-event/v1",
    provider: PROVIDER_NAME,
    project_id: context.projectId,
    firebase_app_id: context.firebaseAppId,
    app: { platform: appPlatform },
    issue: { id: issueId, title: issueTitle, type: normalizedIssueType },
    event: { id: eventId, occurred_at: occurredAt },
    fatal,
    kind: compatibleKind,
    exception: {},
    frames,
    canonical_stack: canonical.value,
    symbolication: symbolicationFor(
      frames,
      first(payload, ["symbolication.status", "symbolication_status", "symbolicationStatus"]),
    ),
    truncated: anyTruncated,
    fetched_at: context.fetchedAt ?? new Date().toISOString(),
  };

  if (packageName !== undefined) event.app.package_name = packageName;
  if (bundleId !== undefined) event.app.bundle_id = bundleId;
  if (versionName !== undefined) event.app.version_name = versionName;
  if (buildVersion !== undefined) event.app.build_version = buildVersion;
  if (processName !== undefined) event.process = processName;
  if (exceptionClass !== undefined) event.exception.class = exceptionClass;
  // A nested cause may legitimately have the same class as the wrapper. Keep
  // it so the structured event hashes exactly like a local `Caused by:` stack.
  if (rootCauseClass !== undefined) {
    event.exception.root_cause_class = rootCauseClass;
  }
  if (signal !== undefined) event.exception.signal = signal;

  const occurrences = boundedNumber(first(payload, [
    "aggregate.events",
    "aggregate.occurrences",
    "occurrences",
    "event_count",
    "eventCount",
  ]), 0);
  const affectedUsers = boundedNumber(first(payload, [
    "aggregate.users",
    "aggregate.affected_users",
    "affected_users",
    "affectedUsers",
    "user_count",
    "userCount",
  ]), 0);
  const firstSeen = timestamp(first(payload, [
    "aggregate.first_seen",
    "aggregate.firstSeen",
    "first_seen",
    "firstSeen",
    "issue.firstSeen",
  ]));
  const lastSeen = timestamp(first(payload, [
    "aggregate.last_seen",
    "aggregate.lastSeen",
    "last_seen",
    "lastSeen",
    "issue.lastSeen",
  ]));
  if (occurrences !== undefined || affectedUsers !== undefined || firstSeen !== undefined || lastSeen !== undefined) {
    event.aggregate = {};
    if (occurrences !== undefined) event.aggregate.events = occurrences;
    if (affectedUsers !== undefined) event.aggregate.users = affectedUsers;
    if (firstSeen !== undefined) event.aggregate.first_seen = firstSeen;
    if (lastSeen !== undefined) event.aggregate.last_seen = lastSeen;
  }
  return event;
}
