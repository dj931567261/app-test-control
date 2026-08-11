import { isIP } from "node:net";

import { MAX_TEXT_FIELD_BYTES } from "./constants.js";

export interface RedactedText {
  value: string;
  count: number;
  truncated: boolean;
}

const RULES: readonly [RegExp, string][] = [
  [/https?:\/\/[^\s)\]}>'"]+/giu, "[REDACTED_URL]"],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[REDACTED_EMAIL]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, "[REDACTED_IP]"],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, "[REDACTED_AUTH]"],
  [/\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]+/giu, "[REDACTED_COOKIE]"],
  [/((?<![\w])["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|session(?:[_-]?(?:id|uuid))?|otp|password|passwd|secret|user(?:[_-]?id|name)?|account[_-]?(?:id|name)|installation[_-]?(?:id|uuid)|device[_-]?(?:id|uuid)|advertising[_-]?(?:id|uuid)|gaid|idfa|location|latitude|longitude)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;}\]]+)/giu, "$1[REDACTED_SECRET]"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, "[REDACTED_UUID]"],
  [/(?<![\d.])[-+]?(?:[0-8]?\d(?:\.\d+)?|90(?:\.0+)?)\s*,\s*[-+]?(?:(?:1[0-7]\d|[0-9]?\d)(?:\.\d+)?|180(?:\.0+)?)(?![\d.])/gu, "[REDACTED_LOCATION]"],
  [/(?<![\w.])(?:\+?\d[\d .()-]{7,}\d)(?![\w.])/gu, "[REDACTED_PHONE]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED_JWT]"],
  [/\/(Users|home)\/[^/\s]+/gu, "/$1/[REDACTED_USER]"],
  [/[A-Za-z]:\\Users\\[^\\\s]+/gu, "C:\\Users\\[REDACTED_USER]"],
  [/(?:\/private)?\/var\/folders\/[^\s)\]}>'"]+/gu, "[REDACTED_TEMP_PATH]"],
  [/\/tmp\/[^\s)\]}>'"]+/gu, "[REDACTED_TEMP_PATH]"],
  [/[A-Za-z]:\\(?:Temp|TMP)\\[^\s)\]}>'"]+/giu, "[REDACTED_TEMP_PATH]"],
];

const UTF8_ENCODER = new TextEncoder();

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }

  // TextEncoder.encodeInto stops before an incomplete Unicode scalar. This is
  // linear in the byte budget and avoids the former repeated slice/byteLength
  // loop, which became quadratic for large multi-byte provider fields.
  const marker = ".".repeat(Math.min(3, maxBytes));
  const contentBudget = maxBytes - marker.length;
  const encoded = new Uint8Array(contentBudget);
  const { written } = UTF8_ENCODER.encodeInto(value, encoded);
  const prefix = Buffer.from(encoded.buffer, encoded.byteOffset, written).toString("utf8");
  return { value: `${prefix}${marker}`, truncated: true };
}

export function redactText(
  input: unknown,
  maxBytes = MAX_TEXT_FIELD_BYTES,
): RedactedText | undefined {
  if (typeof input !== "string") return undefined;
  let value = input.replace(/\0/g, "");
  let count = 0;
  for (const [pattern, replacement] of RULES) {
    value = value.replace(pattern, (...args: unknown[]) => {
      const matched = args[0];
      if (typeof matched === "string") count += 1;
      // String.replace does not expand $1/$2 inside a callback return value.
      // Expand only numeric capture references used by our static rules.
      return replacement.replace(/\$(\d+)/gu, (_reference, rawIndex: string) => {
        const capture = args[Number(rawIndex)];
        return typeof capture === "string" ? capture : "";
      });
    });
  }
  value = value.replace(/[0-9A-Fa-f:.]{2,}/gu, (candidate) => {
    if (isIP(candidate) !== 6) return candidate;
    count += 1;
    return "[REDACTED_IP]";
  });
  const bounded = truncateUtf8(value, maxBytes);
  return { value: bounded.value, count, truncated: bounded.truncated };
}

export function boundedIdentifier(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const value = input.replace(/\0/g, "").trim();
  if (!value || value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(value)) {
    return undefined;
  }
  return value;
}
