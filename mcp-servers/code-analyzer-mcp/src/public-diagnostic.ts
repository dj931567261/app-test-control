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

function stripTerminalControls(value: string): string {
  let cleaned = "";
  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index);
    if (code === ESC) {
      cleaned += " ";
      const introducer = value.charCodeAt(index + 1);
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

function diagnosticText(value: unknown): string {
  try {
    return value instanceof Error ? value.message : String(value);
  } catch {
    return "request failed";
  }
}

function sensitiveStart(value: string): number | undefined {
  const match = /(?:\b(?:file|https?):\/\/|(^|[^\p{L}\p{N}._~%+&-])(?:\/|\\|[A-Za-z]:[\\/]|~[\\/]))/iu.exec(
    value,
  );
  if (!match) return undefined;
  return match.index + (match[1]?.length ?? 0);
}

/**
 * 返回有界、单行且不含绝对路径的公共错误。路径可能包含空格与凭据文件名，
 * 因此一旦检测到路径起点便丢弃整个后缀，而不是猜测路径终点。
 */
export function publicDiagnostic(value: unknown, maxLength = 400): string {
  const boundedMax = Number.isSafeInteger(maxLength) && maxLength > 0 ? maxLength : 400;
  const raw = diagnosticText(value);
  const rawStart = sensitiveStart(raw);
  let cleaned = stripTerminalControls(rawStart === undefined ? raw : raw.slice(0, rawStart))
    .replace(/\s+/gu, " ")
    .trim();
  if (rawStart !== undefined) cleaned = `${cleaned}${cleaned ? " " : ""}<PATH>`;

  // 控制字符移除后可能新拼出路径边界，再做一次闭合检查。
  const visibleStart = sensitiveStart(cleaned);
  if (visibleStart !== undefined) {
    cleaned = `${cleaned.slice(0, visibleStart).trimEnd()} <PATH>`.trim();
  }
  return (cleaned || "request failed").slice(0, boundedMax);
}
