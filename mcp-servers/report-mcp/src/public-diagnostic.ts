/** Maximum public error length returned over MCP. */
export const MAX_PUBLIC_DIAGNOSTIC_CHARS = 512;

const MAX_RAW_DIAGNOSTIC_CHARS = 4 * 1024;
const ANSI_ESCAPE_RE = /\x1b(?:[@-_][0-?]*[ -/]*[@-~]|[ -/]*[@-~])/g;
const CONTROL_OR_FORMAT_RE = /[\u0000-\u001f\u007f-\u009f]|\p{Cf}/gu;
const PATH_START_RE =
  /(?:\b(?:file|https?):\/\/|(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\|\/\/|~[\\/]|\/(?!\/)))/i;

/**
 * Convert an internal failure into one bounded, single-line public diagnostic.
 * Once a path-like token starts, the remainder is discarded so paths with
 * spaces, credentials in filenames, and trailing tool suggestions cannot leak.
 */
export function publicDiagnostic(error: unknown): string {
  const raw = error instanceof Error && typeof error.message === "string"
    ? error.message
    : typeof error === "string"
      ? error
      : "request failed";
  let sanitized = raw
    .slice(0, MAX_RAW_DIAGNOSTIC_CHARS)
    .replace(ANSI_ESCAPE_RE, "")
    .replace(CONTROL_OR_FORMAT_RE, " ")
    .replace(/\s+/g, " ")
    .trim();

  const pathStart = PATH_START_RE.exec(sanitized);
  if (pathStart !== null) {
    const prefix = sanitized.slice(0, pathStart.index).trimEnd();
    sanitized = `${prefix}${prefix.length > 0 ? " " : ""}<PATH>`;
  }
  if (sanitized.length === 0) sanitized = "request failed";
  if (sanitized.length > MAX_PUBLIC_DIAGNOSTIC_CHARS) {
    sanitized = `${sanitized.slice(0, MAX_PUBLIC_DIAGNOSTIC_CHARS - 1)}…`;
  }
  return sanitized;
}
