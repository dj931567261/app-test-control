import { createHash } from "node:crypto";

import type { CrashSignatureVersion } from "./sessions.js";

/**
 * Report MCP intentionally verifies Analyzer's persisted canonical stack
 * independently. Keeping this parser small and canonical-only avoids trusting
 * caller-supplied identity fields while also avoiding a runtime dependency on
 * the Analyzer MCP server process.
 */
export interface CanonicalAnalyzerIdentity {
  kind: "java" | "anr" | "native" | "ios" | "unknown";
  signature_version: CrashSignatureVersion;
  fingerprint: string;
}

const CANONICAL_MARKER = "Normalized Crash Event";
const CANONICAL_KINDS = new Set<CanonicalAnalyzerIdentity["kind"]>([
  "java",
  "anr",
  "native",
  "ios",
  "unknown",
]);
const VALUE_LINE_RE = /^(Kind|Exception Class|Root Cause Class|Signal|Process|Identity Frame): (\S(?:.*\S)?)$/;
const FRAME_LINE_RE = /^Frame (\d+): (\S(?:.*\S)?)$/;
const MAX_CANONICAL_LINES = 272;
const MAX_CANONICAL_STACK_BYTES = 512 * 1024;

interface ParsedCanonicalStack {
  kind: CanonicalAnalyzerIdentity["kind"];
  exceptionClass?: string;
  rootCauseClass?: string;
  signal?: string;
  process?: string;
  identityFrame?: string;
  frames: string[];
}

export function computeCanonicalAnalyzerIdentity(
  stack: string,
): CanonicalAnalyzerIdentity {
  const parsed = parseCanonicalAnalyzerStack(stack);
  const primaryFrameCount = parsed.kind === "ios" ? 4 : 3;
  const primaryFrames = parsed.frames.slice(0, primaryFrameCount);
  const identityFrames = parsed.kind === "ios" && parsed.identityFrame !== undefined
    && !primaryFrames.includes(parsed.identityFrame)
    ? [parsed.identityFrame]
    : [];
  const signatureVersion: CrashSignatureVersion = parsed.kind === "java"
    ? "java-v2"
    : parsed.kind === "ios"
      && (parsed.frames.length > 3 || parsed.identityFrame !== undefined)
      ? "ios-v2"
      : "v1";
  const components = [
    parsed.kind,
    ...(signatureVersion === "v1" ? [] : [signatureVersion]),
    parsed.exceptionClass ?? "",
    primaryFrames.join("|"),
    parsed.rootCauseClass ?? "",
    parsed.signal ?? "",
    parsed.process ?? "",
    ...(identityFrames.length > 0 ? [identityFrames.join("|")] : []),
  ];
  return {
    kind: parsed.kind,
    signature_version: signatureVersion,
    fingerprint: createHash("sha1")
      .update(components.join("\n"), "utf8")
      .digest("hex")
      .slice(0, 12),
  };
}

export function assertCanonicalAnalyzerIdentity(
  stack: string,
  expected: {
    signature: string;
    signature_version: CrashSignatureVersion;
    kind?: string;
  },
): CanonicalAnalyzerIdentity {
  const actual = computeCanonicalAnalyzerIdentity(stack);
  if (
    actual.signature_version !== expected.signature_version
    || actual.fingerprint !== expected.signature
  ) {
    throw new Error(
      "canonical stack does not match the declared analyzer signature_version and fingerprint",
    );
  }
  if (expected.kind !== undefined && actual.kind !== expected.kind) {
    throw new Error("canonical stack kind does not match the declared crash kind");
  }
  return actual;
}

function parseCanonicalAnalyzerStack(stack: string): ParsedCanonicalStack {
  if (typeof stack !== "string" || stack.length === 0) {
    throw new TypeError("canonical analyzer stack must be a non-empty string");
  }
  if (Buffer.byteLength(stack, "utf8") > MAX_CANONICAL_STACK_BYTES) {
    throw new RangeError(
      `canonical analyzer stack exceeds ${MAX_CANONICAL_STACK_BYTES} byte size limit`,
    );
  }
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(stack)) {
    throw new Error("canonical analyzer stack contains forbidden control characters");
  }
  const lines = stack.split("\n");
  if (lines.length > MAX_CANONICAL_LINES) {
    throw new RangeError(
      `canonical analyzer stack exceeds ${MAX_CANONICAL_LINES} line limit`,
    );
  }
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== CANONICAL_MARKER) {
    throw new Error(
      "Firebase CrashFix evidence must use Analyzer's canonical crash stack",
    );
  }
  if (lines.some((line) => line.length === 0 || line !== line.trim())) {
    throw new Error("canonical analyzer stack contains blank or untrimmed lines");
  }

  const scalarOrder = new Map([
    ["Kind", 0],
    ["Exception Class", 1],
    ["Root Cause Class", 2],
    ["Signal", 3],
    ["Process", 4],
    ["Identity Frame", 5],
  ]);
  const scalars = new Map<string, string>();
  const frames: string[] = [];
  let lastScalarOrder = -1;
  let inFrames = false;
  for (const [offset, line] of lines.slice(1).entries()) {
    const frame = FRAME_LINE_RE.exec(line);
    if (frame !== null) {
      inFrames = true;
      const index = Number(frame[1]);
      if (!Number.isSafeInteger(index) || index !== frames.length) {
        throw new Error(
          `canonical analyzer stack frame index must be contiguous at line ${offset + 2}`,
        );
      }
      frames.push(frame[2]!);
      continue;
    }
    if (inFrames) {
      throw new Error("canonical analyzer stack contains metadata after its first frame");
    }
    const scalar = VALUE_LINE_RE.exec(line);
    if (scalar === null) {
      throw new Error(`canonical analyzer stack contains an unsupported line at ${offset + 2}`);
    }
    const key = scalar[1]!;
    const order = scalarOrder.get(key);
    if (order === undefined || order <= lastScalarOrder || scalars.has(key)) {
      throw new Error("canonical analyzer stack metadata is duplicated or out of order");
    }
    lastScalarOrder = order;
    scalars.set(key, scalar[2]!);
  }

  const rawKind = scalars.get("Kind");
  if (rawKind === undefined || !CANONICAL_KINDS.has(rawKind as never)) {
    throw new Error("canonical analyzer stack has an invalid or missing Kind");
  }
  if (frames.length === 0) {
    throw new Error("canonical analyzer stack requires at least one Frame");
  }
  const kind = rawKind as CanonicalAnalyzerIdentity["kind"];
  if (kind === "java" && scalars.get("Exception Class") === undefined) {
    throw new Error("canonical Java stack requires Exception Class");
  }
  if (
    kind === "ios"
    && scalars.get("Exception Class") === undefined
    && scalars.get("Signal") === undefined
  ) {
    throw new Error("canonical iOS stack requires Exception Class or Signal");
  }
  if (kind === "ios" && scalars.get("Process") === undefined) {
    throw new Error("canonical iOS stack requires Process");
  }

  return {
    kind,
    ...(scalars.get("Exception Class") !== undefined
      ? { exceptionClass: scalars.get("Exception Class")! }
      : {}),
    ...(scalars.get("Root Cause Class") !== undefined
      ? { rootCauseClass: scalars.get("Root Cause Class")! }
      : {}),
    ...(scalars.get("Signal") !== undefined
      ? { signal: scalars.get("Signal")! }
      : {}),
    ...(scalars.get("Process") !== undefined
      ? { process: scalars.get("Process")! }
      : {}),
    ...(scalars.get("Identity Frame") !== undefined
      ? { identityFrame: scalars.get("Identity Frame")! }
      : {}),
    frames,
  };
}
