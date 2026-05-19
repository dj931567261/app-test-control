// Parse crash stack text and compute stable fingerprint.

import { createHash } from "node:crypto";

export type CrashKind = "java" | "anr" | "native" | "ios" | "unknown";

export interface ParsedStack {
  kind: CrashKind;
  exception_class?: string;     // Java: "java.lang.NPE"; iOS: "EXC_BAD_ACCESS"
  message?: string;             // optional message after exception class
  top_frames: string[];         // normalized: "ClassName.method" or "image+offset" / "symbol"
  root_cause_class?: string;    // innermost "Caused by:" exception class
  signal?: string;              // for native/ios: "SIGSEGV"
  process?: string;             // for ANR: package name; for iOS: bundle id / proc name
}

const JAVA_EXCEPTION_RE =
  /(?<exc>[A-Za-z_][\w.$]*(?:Exception|Error|Throwable))(?::\s*(?<msg>.+))?/;
const FRAME_RE =
  /^\s*at\s+(?<frame>[\w$.<>]+)\s*(?:\((?<src>[^)]+)\))?/;
const CAUSED_BY_RE = /Caused by:\s*(?<exc>[A-Za-z_][\w.$]*(?:Exception|Error|Throwable))/g;
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
      break;
    }
    if (/\*\*\* \*\*\* \*\*\* \*\*\*/.test(line) || TOMBSTONE_RE.test(line)) {
      kind = "native";
      break;
    }
  }

  // Find exception class + message (first match, not "Caused by")
  let exception_class: string | undefined;
  let message: string | undefined;
  for (const line of lines) {
    if (/Caused by/.test(line)) break;
    const m = JAVA_EXCEPTION_RE.exec(line);
    if (m?.groups) {
      exception_class = m.groups["exc"];
      message = m.groups["msg"]?.trim();
      if (kind === "unknown") kind = "java";
      break;
    }
  }

  // Find root cause (last "Caused by:" exception, innermost)
  let root_cause_class: string | undefined;
  CAUSED_BY_RE.lastIndex = 0;
  for (let m; (m = CAUSED_BY_RE.exec(stack)); ) {
    root_cause_class = m.groups?.["exc"];
  }

  // Extract top frames (skip Caused-by section before first 'at ')
  const top_frames: string[] = [];
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
  kind: CrashKind;
  exception_class?: string;
  top_frames: string[];   // the frames used for hashing (up to 3)
  root_cause_class?: string;
  /** Human-readable label like "NullPointerException @ LoginActivity.onClick". */
  label: string;
}

/**
 * Compute a stable signature from a parsed stack (or raw stack text).
 * Hashes: exception_class + top-3 normalized frames + root_cause_class + kind.
 */
export function computeSignature(input: ParsedStack | string): SignatureResult {
  const parsed = typeof input === "string" ? parseStack(input) : input;
  const top = parsed.top_frames.slice(0, 3);
  const components = [
    parsed.kind,
    parsed.exception_class ?? "",
    top.join("|"),
    parsed.root_cause_class ?? "",
    parsed.signal ?? "",
    parsed.process ?? "",
  ];
  const hash = createHash("sha1").update(components.join("\n")).digest("hex").slice(0, 12);

  const label = buildLabel(parsed);
  const result: SignatureResult = {
    fingerprint: hash,
    kind: parsed.kind,
    top_frames: top,
    label,
  };
  if (parsed.exception_class !== undefined) result.exception_class = parsed.exception_class;
  if (parsed.root_cause_class !== undefined) result.root_cause_class = parsed.root_cause_class;
  return result;
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
    const where = p.top_frames[0] ? ` @ ${p.top_frames[0]}` : "";
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
