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

export function parseCrashes(logcat: string): CrashRecord[] {
  const lines = logcat.split("\n");
  const records: CrashRecord[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine === undefined) continue;
    const parsed = parseLine(rawLine);

    // Java crash
    const javaMatch = JAVA_MARKER.exec(parsed.msg);
    if (javaMatch) {
      const collected = collectBlock(lines, i, parsed.pid);
      records.push({
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
      records.push({
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
      records.push({
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
      records.push({
        kind: "native",
        time: parsed.time,
        pid: parsed.pid,
        tid: parsed.tid,
        signature: parsed.msg.trim(),
        stack: parsed.raw,
      });
    }
  }

  return records;
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
