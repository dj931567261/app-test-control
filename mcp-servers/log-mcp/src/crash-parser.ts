// Parses logcat output for crash / ANR / native-crash blocks.
// Strategy: scan line-by-line, when a crash marker is hit, capture lines
// belonging to the same pid/tid until another tag boundary or empty gap.

export type CrashKind = "java" | "anr" | "native";

export interface CrashRecord {
  kind: CrashKind;
  time?: string;        // "MM-DD HH:MM:SS.mmm" if present
  pid?: string;
  tid?: string;
  process?: string;     // app process name if extractable
  signature: string;    // top-line, used as a short identifier
  stack: string;        // full captured stack/block text
}

export const MAX_PARSED_CRASH_RECORDS = 256;
export const MAX_CRASH_RESPONSE_RECORDS = 64;
export const MAX_CRASH_STACK_BYTES = 64 * 1024;
// 512 KiB leaves room for worst-case JSON escaping while keeping the complete
// MCP text response below the server-wide 4 MiB transport budget.
export const MAX_CRASH_TOTAL_STACK_BYTES = 512 * 1024;
export const MAX_CRASH_SIGNATURE_BYTES = 4 * 1024;
export const MAX_CRASH_PROCESS_BYTES = 1024;

export interface BoundedCrashRecord extends Omit<CrashRecord, "signature" | "stack" | "process"> {
  process?: string;
  signature: string;
  stack: string;
  stack_truncated: boolean;
  original_stack_bytes: number;
  signature_truncated: boolean;
}

export interface BoundedCrashResult {
  crashes: BoundedCrashRecord[];
  total_detected: number;
  results_truncated: boolean;
  parse_limit_reached: boolean;
  stack_bytes: number;
  stack_byte_limit: number;
}

export interface ParsedCrashResult {
  crashes: CrashRecord[];
  totalDetected: number;
  limitReached: boolean;
}

const JAVA_MARKER = /FATAL EXCEPTION:\s*(\S+)/;
const ANR_MARKER = /ANR in ([\w.]+)/;
const NATIVE_MARKER = /\*\*\* \*\*\* \*\*\* \*\*\* \*\*\* \*\*\*/;
const TOMBSTONE_MARKER = /Tombstone written to:/;
const LOG_LINE = /^(?<time>\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(?<pid>\d+)\s+(?<tid>\d+)\s+(?<level>[VDIWEFA])\s+(?<tag>[^:]+):\s?(?<msg>.*)$/;

interface ParsedLine {
  time?: string;
  pid?: string;
  tid?: string;
  level?: string;
  tag?: string;
  msg: string;
  raw: string;
}

function parseLine(line: string): ParsedLine {
  const m = LOG_LINE.exec(line);
  if (!m?.groups) return { msg: line, raw: line };
  return {
    time: m.groups["time"],
    pid: m.groups["pid"],
    tid: m.groups["tid"],
    level: m.groups["level"],
    tag: m.groups["tag"]?.trim(),
    msg: m.groups["msg"] ?? "",
    raw: line,
  };
}

export function parseCrashes(
  logcat: string,
  options: { maxRecords?: number; predicate?: (record: CrashRecord) => boolean } = {},
): CrashRecord[] {
  return parseCrashesWithMeta(logcat, options).crashes;
}

export function parseCrashesWithMeta(
  logcat: string,
  options: { maxRecords?: number; predicate?: (record: CrashRecord) => boolean } = {},
): ParsedCrashResult {
  const maxRecords = options.maxRecords ?? MAX_PARSED_CRASH_RECORDS;
  if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0) {
    throw new RangeError("maxRecords must be a positive safe integer");
  }
  const lines = logcat.split("\n");
  const records: CrashRecord[] = [];
  let totalDetected = 0;

  const accept = (record: CrashRecord): void => {
    if (options.predicate && !options.predicate(record)) return;
    totalDetected += 1;
    if (records.length < maxRecords) records.push(record);
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine === undefined) continue;
    const parsed = parseLine(rawLine);

    // Java crash
    const javaMatch = JAVA_MARKER.exec(parsed.msg);
    if (javaMatch) {
      const collected = collectBlock(lines, i, parsed.pid);
      accept({
        kind: "java",
        time: parsed.time,
        pid: parsed.pid,
        tid: parsed.tid,
        process: javaMatch[1],
        signature: firstException(collected) ?? parsed.msg.trim(),
        stack: collected,
      });
      i += blockSpan(collected);
      continue;
    }

    // ANR
    const anrMatch = ANR_MARKER.exec(parsed.msg);
    if (anrMatch) {
      const collected = collectBlock(lines, i, parsed.pid, 200);
      accept({
        kind: "anr",
        time: parsed.time,
        pid: parsed.pid,
        tid: parsed.tid,
        process: anrMatch[1],
        signature: parsed.msg.trim(),
        stack: collected,
      });
      i += blockSpan(collected);
      continue;
    }

    // Native crash
    if (NATIVE_MARKER.test(parsed.msg) || NATIVE_MARKER.test(rawLine)) {
      const collected = collectBlock(lines, i, parsed.pid, 120);
      accept({
        kind: "native",
        time: parsed.time,
        pid: parsed.pid,
        tid: parsed.tid,
        signature: extractNativeSignature(collected),
        stack: collected,
      });
      i += blockSpan(collected);
      continue;
    }

    // Tombstone reference (often follows native crash) — record as native if not already
    if (TOMBSTONE_MARKER.test(parsed.msg)) {
      accept({
        kind: "native",
        time: parsed.time,
        pid: parsed.pid,
        tid: parsed.tid,
        signature: parsed.msg.trim(),
        stack: parsed.raw,
      });
    }
  }

  return {
    crashes: records,
    totalDetected,
    limitReached: totalDetected > maxRecords,
  };
}

function utf8Prefix(value: string, maxBytes: number): {
  value: string;
  bytes: number;
  originalBytes: number;
  truncated: boolean;
} {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) {
    return {
      value,
      bytes: encoded.length,
      originalBytes: encoded.length,
      truncated: false,
    };
  }
  let end = maxBytes;
  // Never end inside a UTF-8 continuation sequence. If the leading byte just
  // before `end` starts a longer sequence, TextDecoder replacement would make
  // the response larger and obscure the exact truncation boundary.
  while (end > 0 && (encoded[end] ?? 0) >> 6 === 0b10) end -= 1;
  const prefix = encoded.subarray(0, end).toString("utf8");
  return {
    value: prefix,
    bytes: Buffer.byteLength(prefix, "utf8"),
    originalBytes: encoded.length,
    truncated: true,
  };
}

/** Bound crash count and stack payload before serializing it into MCP JSON. */
export function boundCrashRecords(
  records: CrashRecord[],
  options: {
    includeFullStack?: boolean;
    parseLimitReached?: boolean;
    totalDetected?: number;
  } = {},
): BoundedCrashResult {
  const includeFullStack = options.includeFullStack ?? true;
  const selected = records.slice(0, MAX_CRASH_RESPONSE_RECORDS);
  const crashes: BoundedCrashRecord[] = [];
  let remainingStackBytes = MAX_CRASH_TOTAL_STACK_BYTES;
  let emittedStackBytes = 0;

  for (const record of selected) {
    const lineLimitedStack = includeFullStack
      ? record.stack
      : record.stack.split("\n").slice(0, 5).join("\n");
    const allowedStackBytes = Math.min(MAX_CRASH_STACK_BYTES, remainingStackBytes);
    const boundedStack = utf8Prefix(lineLimitedStack, allowedStackBytes);
    const originalStackBytes = Buffer.byteLength(record.stack, "utf8");
    const boundedSignature = utf8Prefix(record.signature, MAX_CRASH_SIGNATURE_BYTES);
    const boundedProcess =
      record.process === undefined
        ? undefined
        : utf8Prefix(record.process, MAX_CRASH_PROCESS_BYTES).value;
    remainingStackBytes -= boundedStack.bytes;
    emittedStackBytes += boundedStack.bytes;
    crashes.push({
      kind: record.kind,
      ...(record.time !== undefined ? { time: record.time } : {}),
      ...(record.pid !== undefined ? { pid: record.pid } : {}),
      ...(record.tid !== undefined ? { tid: record.tid } : {}),
      ...(boundedProcess !== undefined ? { process: boundedProcess } : {}),
      signature: boundedSignature.value,
      stack: boundedStack.value,
      stack_truncated:
        boundedStack.truncated || lineLimitedStack !== record.stack,
      original_stack_bytes: originalStackBytes,
      signature_truncated: boundedSignature.truncated,
    });
  }

  const totalDetected = Math.max(records.length, options.totalDetected ?? records.length);
  return {
    crashes,
    total_detected: totalDetected,
    results_truncated:
      totalDetected > crashes.length ||
      crashes.some((record) => record.stack_truncated || record.signature_truncated) ||
      options.parseLimitReached === true,
    parse_limit_reached: options.parseLimitReached === true,
    stack_bytes: emittedStackBytes,
    stack_byte_limit: MAX_CRASH_TOTAL_STACK_BYTES,
  };
}

function collectBlock(
  lines: string[],
  startIdx: number,
  pid: string | undefined,
  maxLines = 80,
): string {
  const collected: string[] = [];
  let blanks = 0;
  for (let j = startIdx; j < Math.min(lines.length, startIdx + maxLines); j++) {
    const ln = lines[j];
    if (ln === undefined) break;
    if (!ln.trim()) {
      blanks++;
      if (blanks > 1) break;
      continue;
    }
    blanks = 0;
    if (pid) {
      const lp = parseLine(ln);
      // Only include lines from the same pid once we're past the marker.
      if (j > startIdx && lp.pid && lp.pid !== pid) {
        // Allow some related "AndroidRuntime"/"DEBUG" tag noise; skip otherwise
        if (!/AndroidRuntime|DEBUG|libc|ActivityManager/.test(lp.tag ?? "")) {
          break;
        }
      }
    }
    collected.push(ln);
  }
  return collected.join("\n");
}

function blockSpan(block: string): number {
  return Math.max(0, block.split("\n").length - 1);
}

function firstException(block: string): string | null {
  const re = /([\w.$]+(?:Exception|Error|Throwable))(?::\s*(.+))?/;
  for (const line of block.split("\n")) {
    const m = re.exec(line);
    if (m) {
      return m[2] ? `${m[1]}: ${m[2].trim()}` : m[1]!;
    }
  }
  return null;
}

function extractNativeSignature(block: string): string {
  for (const line of block.split("\n")) {
    if (/signal\s+\d+\s+\(SIG\w+\)/.test(line)) return line.trim();
    if (/Build fingerprint/.test(line)) return line.trim();
  }
  return "native crash";
}
