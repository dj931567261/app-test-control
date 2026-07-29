// Parse crash stack text and compute stable fingerprint.

import { createHash } from "node:crypto";

export type CrashKind = "java" | "anr" | "native" | "ios" | "unknown";

export interface ParsedStack {
  kind: CrashKind;
  exception_class?: string;     // Java: "java.lang.NPE"; iOS: "EXC_BAD_ACCESS"
  message?: string;             // optional message after exception class
  top_frames: string[];         // normalized: "ClassName.method" or "image+offset" / "symbol"
  /** Extra identity-bearing frames, such as the first app-owned iOS frame. */
  identity_frames?: string[];
  root_cause_class?: string;    // innermost "Caused by:" exception class
  signal?: string;              // for native/ios: "SIGSEGV"
  process?: string;             // for ANR: package name; for iOS: bundle id / proc name
}

const IOS_PRIMARY_FRAME_COUNT = 4;

const JAVA_EXCEPTION_RE =
  /(?<exc>[A-Za-z_][\w.$]*(?:Exception|Error|Throwable))(?::\s*(?<msg>.+))?/;
// Java permits Throwable subclasses whose names do not end in Exception/Error.
// Accept a fully-qualified declaration only at the exception payload boundary;
// the stricter expression above remains the first choice for noisy logs.
const JAVA_QUALIFIED_THROWABLE_RE =
  /(?:^|AndroidRuntime:\s+)\s*(?<exc>[A-Za-z_][\w$]*(?:\.[A-Za-z_$][\w$]*)+)(?::\s*(?<msg>.*))?\s*$/;
const FRAME_RE =
  /^\s*at\s+(?<frame>[\w$.<>]+)\s*(?:\((?<src>[^)]+)\))?/;
const CAUSED_BY_RE = /Caused by:\s*(?<exc>[A-Za-z_][\w.$]*)/g;
const ANR_RE = /ANR in\s+(?<pkg>[\w.]+)/;
const NATIVE_SIGNAL_RE = /signal\s+\d+\s+\((?<sig>SIG\w+)\)/;
const TOMBSTONE_RE = /Tombstone written to:\s*(?<path>\S+)/;

/**
 * Strip file:line from a frame, keep `ClassName.method` (or last 2 segments).
 *   "com.example.LoginActivity.onClick(LoginActivity.java:42)" → "com.example.LoginActivity.onClick"
 *   "android.view.View.performClick(View.java:7448)" → "android.view.View.performClick"
 *   Lambda / inner classes: "Foo$1.onClick" → "Foo$1.onClick" (kept)
 */
export function normalizeFrame(frame: string): string {
  // Already normalized (no parens). Just return.
  const lhs = frame.split("(")[0]!.trim();
  return lhs;
}

export function parseStack(stack: string): ParsedStack {
  const lines = stack.split("\n");

  // Canonical iOS block emitted by ipsToStackText(). Keeping this parser here
  // makes a stored report stack round-trip through analyze_session without
  // collapsing every .ips file into the generic "unknown" signature.
  // Apply one normalization rule to every canonical line. Previously only the
  // marker was trimmed, so indenting the whole block selected the iOS parser
  // while silently dropping every identity-bearing field.
  const canonicalLines = lines.map((line) => line.trim());
  const firstNonEmptyLine = canonicalLines.find((line) => line.length > 0);
  if (firstNonEmptyLine === "Normalized Crash Event") {
    const valueFor = (prefix: string): string | undefined => {
      const line = canonicalLines.find((candidate) => candidate.startsWith(prefix));
      const value = line?.slice(prefix.length).trim();
      return value ? value : undefined;
    };
    const kindValue = valueFor("Kind:");
    if (
      kindValue !== "java" &&
      kindValue !== "anr" &&
      kindValue !== "native" &&
      kindValue !== "ios" &&
      kindValue !== "unknown"
    ) {
      throw new Error("Malformed canonical crash event stack: invalid Kind");
    }
    const top_frames = canonicalLines
      .map((line) => /^Frame\s+\d+:\s*(.+)$/.exec(line)?.[1]?.trim())
      .filter((frame): frame is string => Boolean(frame));
    if (top_frames.length === 0) {
      throw new Error("Malformed canonical crash event stack: missing at least one Frame");
    }
    const result: ParsedStack = { kind: kindValue, top_frames };
    const exceptionClass = valueFor("Exception Class:");
    const rootCauseClass = valueFor("Root Cause Class:");
    const signal = valueFor("Signal:");
    const processName = valueFor("Process:");
    const identityFrame = valueFor("Identity Frame:");
    if (exceptionClass !== undefined) result.exception_class = exceptionClass;
    if (rootCauseClass !== undefined) result.root_cause_class = rootCauseClass;
    if (signal !== undefined) result.signal = signal;
    if (processName !== undefined) result.process = processName;
    if (identityFrame !== undefined) result.identity_frames = [identityFrame];
    if (result.kind === "ios") assertUsableIosIdentity(result);
    return result;
  }
  if (firstNonEmptyLine === "iOS Crash") {
    const valueFor = (prefix: string): string | undefined => {
      const line = canonicalLines.find((candidate) => candidate.startsWith(prefix));
      const value = line?.slice(prefix.length).trim();
      return value ? value : undefined;
    };
    const top_frames = canonicalLines
      .map((line) => /^Frame\s+\d+:\s*(.+)$/.exec(line)?.[1]?.trim())
      .filter((frame): frame is string => Boolean(frame));
    const result: ParsedStack = { kind: "ios", top_frames };
    const exceptionClass = valueFor("Exception Type:");
    const signal = valueFor("Signal:");
    const processName = valueFor("Process:");
    const identityFrame = valueFor("Identity Frame:");
    if (exceptionClass !== undefined) result.exception_class = exceptionClass;
    if (signal !== undefined) result.signal = signal;
    if (processName !== undefined) result.process = processName;
    if (identityFrame !== undefined) result.identity_frames = [identityFrame];
    assertUsableIosIdentity(result);
    return result;
  }

  // Detect kind
  let kind: CrashKind = "unknown";
  let process: string | undefined;
  let signal: string | undefined;

  for (const line of lines.slice(0, 20)) {
    if (/FATAL EXCEPTION/.test(line) || /AndroidRuntime/.test(line)) {
      kind = "java";
      break;
    }
    const anr = ANR_RE.exec(line);
    if (anr) {
      kind = "anr";
      process = anr.groups?.["pkg"];
      break;
    }
    const sigm = NATIVE_SIGNAL_RE.exec(line);
    if (sigm) {
      kind = "native";
      signal = sigm.groups?.["sig"];
      // A real tombstone commonly starts with the *** marker and carries the
      // signal several lines later. Keep scanning so marker ordering cannot
      // silently erase the only cross-source native identity; once found, stop
      // before unrelated trailing log lines can reclassify the block.
      break;
    }
    if (/\*\*\* \*\*\* \*\*\* \*\*\*/.test(line) || TOMBSTONE_RE.test(line)) {
      kind = "native";
    }
  }

  // Find exception class + message (first match, not "Caused by")
  let exception_class: string | undefined;
  let message: string | undefined;
  if (kind === "java" || kind === "unknown") {
    for (const line of lines) {
      if (/Caused by/.test(line)) break;
      const m = JAVA_EXCEPTION_RE.exec(line) ?? JAVA_QUALIFIED_THROWABLE_RE.exec(line);
      if (m?.groups) {
        exception_class = m.groups["exc"];
        message = m.groups["msg"]?.trim();
        if (kind === "unknown") kind = "java";
        break;
      }
    }
  }

  // Find root cause (last "Caused by:" exception, innermost)
  let root_cause_class: string | undefined;
  if (kind === "java") {
    CAUSED_BY_RE.lastIndex = 0;
    for (let m; (m = CAUSED_BY_RE.exec(stack)); ) {
      root_cause_class = m.groups?.["exc"];
    }
  }

  // Extract top frames (skip Caused-by section before first 'at '). ANR logcat
  // does not reliably carry the same thread stack as Crashlytics, so its bridge
  // intentionally uses only process below. Preserve legacy `at ...` parsing for
  // native text; standard #00 tombstone frames still fall back to signal.
  const top_frames: string[] = [];
  if (kind !== "anr") {
    let inCausedBy = false;
    for (const line of lines) {
      if (/Caused by:/.test(line)) {
        inCausedBy = true;
        continue;
      }
      if (inCausedBy) continue;
      const fm = FRAME_RE.exec(line);
      if (fm?.groups?.["frame"]) {
        top_frames.push(normalizeFrame(fm.groups["frame"]));
        if (top_frames.length >= 5) break;
      }
    }
  }

  // For native: top "frame" is the signal
  if (kind === "native" && top_frames.length === 0 && signal) {
    top_frames.push(signal);
  }

  // For ANR: process name acts as identity component
  if (kind === "anr" && process && top_frames.length === 0) {
    top_frames.push(`anr:${process}`);
  }

  const result: ParsedStack = {
    kind,
    top_frames,
  };
  if (exception_class !== undefined) result.exception_class = exception_class;
  if (message !== undefined) result.message = message;
  if (root_cause_class !== undefined) result.root_cause_class = root_cause_class;
  if (signal !== undefined) result.signal = signal;
  if (process !== undefined) result.process = process;
  return result;
}

export interface SignatureResult {
  fingerprint: string;    // 12-char sha1 prefix
  /** Fingerprint algorithm used for this result. */
  signature_version: "v1" | "ios-v2";
  /** v1-compatible iOS fingerprint (top 3 frames, no identity frame). */
  legacy_fingerprint?: string;
  kind: CrashKind;
  exception_class?: string;
  top_frames: string[];   // primary frames used for hashing (iOS: up to 4; others: 3)
  identity_frames?: string[];
  root_cause_class?: string;
  /** Human-readable label like "NullPointerException @ LoginActivity.onClick". */
  label: string;
}

/**
 * Compute a stable signature from a parsed stack (or raw stack text).
 * Android hashes up to three primary frames. iOS hashes four primary frames
 * plus the first identified app-owned frame when it is deeper in the stack.
 */
export function computeSignature(input: ParsedStack | string): SignatureResult {
  const parsed = typeof input === "string" ? parseStack(input) : input;
  if (parsed.kind === "ios") assertUsableIosIdentity(parsed);

  const top = parsed.top_frames.slice(
    0,
    parsed.kind === "ios" ? IOS_PRIMARY_FRAME_COUNT : 3,
  );
  // Do not hash the same app frame twice when it is already one of the primary
  // frames. A deeper app frame is appended so it still distinguishes crashes
  // that share a longer prefix of system exception trampolines.
  const rawIdentityFrames = parsed.kind === "ios"
    ? (parsed.identity_frames ?? [])
      .map((frame) => frame.trim())
      .filter((frame) => frame.length > 0)
    : [];
  const identityFramesForHash = rawIdentityFrames.filter(
    (frame) => !top.includes(frame),
  );
  const signatureVersion: SignatureResult["signature_version"] =
    parsed.kind === "ios" &&
      (parsed.top_frames.length > 3 || rawIdentityFrames.length > 0)
      ? "ios-v2"
      : "v1";
  const components = [
    parsed.kind,
    // Domain-separate richer iOS identities even when their explicit Identity
    // Frame duplicates one of the first three frames. External consumers that
    // still key only on fingerprint must never collide v2 with legacy v1.
    ...(signatureVersion === "ios-v2" ? ["ios-v2"] : []),
    parsed.exception_class ?? "",
    top.join("|"),
    parsed.root_cause_class ?? "",
    parsed.signal ?? "",
    parsed.process ?? "",
  ];
  if (identityFramesForHash.length > 0) {
    components.push(identityFramesForHash.join("|"));
  }
  const hash = createHash("sha1").update(components.join("\n")).digest("hex").slice(0, 12);

  const legacyFingerprint = parsed.kind === "ios"
    ? createHash("sha1")
      .update([
        parsed.kind,
        parsed.exception_class ?? "",
        parsed.top_frames.slice(0, 3).join("|"),
        parsed.root_cause_class ?? "",
        parsed.signal ?? "",
        parsed.process ?? "",
      ].join("\n"))
      .digest("hex")
      .slice(0, 12)
    : undefined;
  const label = buildLabel(parsed);
  const result: SignatureResult = {
    fingerprint: hash,
    signature_version: signatureVersion,
    ...(legacyFingerprint !== undefined
      ? { legacy_fingerprint: legacyFingerprint }
      : {}),
    kind: parsed.kind,
    top_frames: top,
    label,
    ...(rawIdentityFrames.length > 0
      ? { identity_frames: rawIdentityFrames }
      : {}),
  };
  if (parsed.exception_class !== undefined) result.exception_class = parsed.exception_class;
  if (parsed.root_cause_class !== undefined) result.root_cause_class = parsed.root_cause_class;
  return result;
}

function assertUsableIosIdentity(parsed: ParsedStack): void {
  const hasCrashClass = Boolean(parsed.exception_class?.trim() || parsed.signal?.trim());
  const hasProcess = Boolean(parsed.process?.trim());
  const hasFrame = parsed.top_frames.some((frame) => frame.trim().length > 0);
  const missing: string[] = [];
  if (!hasCrashClass) missing.push("Exception Type or Signal");
  if (!hasProcess) missing.push("Process");
  if (!hasFrame) missing.push("at least one Frame");
  if (missing.length > 0) {
    throw new Error(
      `Malformed canonical iOS stack: missing ${missing.join(", ")}`,
    );
  }
}

function buildLabel(p: ParsedStack): string {
  if (p.kind === "anr") {
    return `ANR${p.process ? ` in ${p.process}` : ""}`;
  }
  if (p.kind === "native") {
    return `Native crash${p.signal ? ` ${p.signal}` : ""}${p.top_frames[0] && p.top_frames[0] !== p.signal ? ` @ ${p.top_frames[0]}` : ""}`;
  }
  if (p.kind === "ios") {
    const exc = p.exception_class ?? "iOS crash";
    const whereFrame = p.identity_frames?.[0] ?? p.top_frames[0];
    const where = whereFrame ? ` @ ${whereFrame}` : "";
    const proc = p.process ? ` (${p.process})` : "";
    return `${exc}${where}${proc}`;
  }
  const exc = p.exception_class ? shortClass(p.exception_class) : "Crash";
  const where = p.top_frames[0] ? ` @ ${p.top_frames[0]}` : "";
  return `${exc}${where}`;
}

function shortClass(fqn: string): string {
  const idx = fqn.lastIndexOf(".");
  return idx >= 0 ? fqn.slice(idx + 1) : fqn;
}
