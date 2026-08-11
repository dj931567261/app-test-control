const ESC = 0x1b;
const BEL = 0x07;
const C1_CSI = 0x9b;
const C1_STRING_CONTROLS = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);

function isCsiFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function skipCsi(value: string, start: number): number | undefined {
  for (let index = start; index < value.length; index += 1) {
    if (isCsiFinal(value.charCodeAt(index))) return index + 1;
  }
  return undefined;
}

function skipControlString(value: string, start: number): number | undefined {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === BEL || code === 0x9c) return index + 1;
    if (code === ESC && value.charCodeAt(index + 1) === 0x5c) return index + 2;
  }
  return undefined;
}

/**
 * Removes terminal control sequences before diagnostics cross the MCP boundary.
 * Unterminated variable-length sequences discard the remaining suffix rather
 * than exposing attacker-controlled payload as ordinary text.
 */
function stripTerminalControls(value: string): string {
  let cleaned = "";
  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index);
    if (code === ESC) {
      const introducer = value.charCodeAt(index + 1);
      // Keep a visible boundary where a terminal command was removed. Without
      // it, `text<ESC-command>/absolute/path` collapses to `text/absolute/path`
      // and can hide the path start from the boundary-based redactor.
      cleaned += " ";
      if (introducer === 0x5b) {
        const end = skipCsi(value, index + 2);
        if (end === undefined) break;
        index = end;
        continue;
      }
      if ([0x50, 0x58, 0x5d, 0x5e, 0x5f].includes(introducer)) {
        const end = skipControlString(value, index + 2);
        if (end === undefined) break;
        index = end;
        continue;
      }
      if (Number.isNaN(introducer)) break;
      index += 2;
      continue;
    }
    if (code === C1_CSI) {
      cleaned += " ";
      const end = skipCsi(value, index + 1);
      if (end === undefined) break;
      index = end;
      continue;
    }
    if (C1_STRING_CONTROLS.has(code)) {
      cleaned += " ";
      const end = skipControlString(value, index + 1);
      if (end === undefined) break;
      index = end;
      continue;
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      cleaned += " ";
      index += 1;
      continue;
    }
    const character = String.fromCodePoint(value.codePointAt(index) ?? code);
    if (!/\p{Cf}/u.test(character)) cleaned += character;
    index += character.length;
  }
  return cleaned;
}

function asDiagnosticText(value: unknown): string {
  try {
    return value instanceof Error ? value.message : String(value);
  } catch {
    return "unknown error";
  }
}

interface SensitiveSuffix {
  start: number;
  token: "<DOCKER_SOCKET>" | "<PATH>";
}

function findSensitiveSuffix(value: string): SensitiveSuffix | undefined {
  const socket = /unix:\/\/\//iu.exec(value);
  // Require a boundary before a path so ordinary relative fragments such as
  // `src/main` remain useful. The broad non-word boundary also covers paths
  // adjacent to punctuation emitted by Docker, Java and Windows tooling.
  const absolutePath = /(^|[^\p{L}\p{N}._~%+&-])(?:\/|\\|[A-Za-z]:[\\/]|~[\\/])/u.exec(value);
  const pathStart = absolutePath?.index === undefined
    ? undefined
    : absolutePath.index + (absolutePath[1]?.length ?? 0);
  if (socket && (pathStart === undefined || socket.index <= pathStart)) {
    return { start: socket.index, token: "<DOCKER_SOCKET>" };
  }
  return pathStart === undefined ? undefined : { start: pathStart, token: "<PATH>" };
}

/**
 * Produces a bounded public diagnostic. Once an absolute path or Docker socket
 * is encountered the suffix is intentionally discarded: paths may contain
 * spaces and Unicode, so trying to infer their endpoint can leak path data.
 */
export function cleanDiagnostic(value: unknown, maxLength = 400): string {
  const boundedMax = Number.isSafeInteger(maxLength) && maxLength > 0 ? maxLength : 400;
  const raw = asDiagnosticText(value);
  const rawSensitive = findSensitiveSuffix(raw);
  let cleaned = stripTerminalControls(
    rawSensitive ? raw.slice(0, rawSensitive.start) : raw,
  )
    .replace(/\s+/gu, " ")
    .trimStart();
  if (rawSensitive) cleaned += rawSensitive.token;

  // A path may be assembled only after bidi/ANSI controls are removed, so run
  // the same fail-closed check over the normalized visible text as well.
  const visibleSensitive = findSensitiveSuffix(cleaned);
  if (visibleSensitive) {
    cleaned = `${cleaned.slice(0, visibleSensitive.start)}${visibleSensitive.token}`;
  }
  return cleaned.trim().slice(0, boundedMax);
}
