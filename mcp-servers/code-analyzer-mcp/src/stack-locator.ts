import { lstat, open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";

import type { StackFrameCandidate, StackFrameInput } from "./types.js";
import { rel, snippet, walk } from "./walker.js";

const SOURCE_EXTENSIONS = [
  "kt", "kts", "java", "swift", "m", "mm", "c", "cc", "cpp", "cxx",
  "h", "hh", "hpp", "dart", "js", "jsx", "ts", "tsx", "vue",
];
const MAX_SOURCE_FILES = 4_000;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_SYMBOL_CHARS = 1024;

export interface LocateStackFramesOptions {
  contextLines?: number;
  maxCandidates?: number;
}

interface SourceFile {
  rel: string;
  basename: string;
  stem: string;
  extension: string;
  lines: string[];
  codeLines: string[];
}

interface MethodDeclaration {
  line: number;
  column: number;
  name: string;
}

interface TypeScope {
  name: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  bodyDepth?: number;
  objectiveC: boolean;
}

function normalizeStackPath(value: string | undefined): string | undefined {
  if (!value || value.includes("\0")) return undefined;
  const normalized = value.replace(/\\/g, "/").replace(/^file:\/\//i, "");
  const parts = normalized.split("/").filter(Boolean);
  // Stack paths are evidence, never paths to open. Discard traversal segments and
  // retain only a bounded suffix for matching against files already found in-repo.
  const safe = parts.filter((part) => part !== "." && part !== "..").slice(-8);
  return safe.length > 0 ? safe.join("/") : undefined;
}

function matchesPathSuffix(repoPath: string, stackPath: string): boolean {
  if (!stackPath.includes("/")) return false;
  if (repoPath === stackPath || repoPath.endsWith(`/${stackPath}`)) return true;
  const parts = stackPath.split("/");
  // Build machines commonly prefix source paths with an agent/workspace root.
  // Match only suffixes that retain at least a directory plus basename.
  for (let start = 1; start <= parts.length - 2; start++) {
    const suffix = parts.slice(start).join("/");
    if (repoPath === suffix || repoPath.endsWith(`/${suffix}`)) return true;
  }
  return false;
}

function symbolTokens(symbol: string): {
  typeNames: string[];
  methodNames: string[];
  ownerType?: string;
} {
  const compact = symbol
    .slice(0, MAX_SYMBOL_CHARS)
    .replace(/^\s*at\s+/u, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+\+\s+(?:0[xX][0-9a-fA-F]+|\d+)\s*$/u, "");
  const raw = compact.split(/[^A-Za-z0-9_$]+/u).filter(Boolean);
  const hasAnonymousOwner = raw.some((part) =>
    /\$(?:\d+|\$Lambda(?:\$|$)|lambda(?:\$|$))/i.test(part));
  const cleaned = raw
    .flatMap((part) => part.replace(/<.*>$/, "").split("$"))
    .filter(Boolean);
  const typeNames = cleaned.filter((part) => /^[A-Z_][A-Za-z0-9_]*$/.test(part));
  const lastTypeIndex = cleaned.reduce(
    (last, part, index) => (/^[A-Z_][A-Za-z0-9_]*$/.test(part) ? index : last),
    -1,
  );
  const methodPool = lastTypeIndex >= 0
    ? cleaned.slice(lastTypeIndex + 1)
    : cleaned.slice(-1);
  const methodNames = methodPool.filter(
    (part) => /^[a-z_][A-Za-z0-9_$]*$/.test(part) && !LANGUAGE_TYPE_WORDS.has(part),
  );
  return {
    typeNames: [...new Set(typeNames)].slice(-4).reverse(),
    // Keep source order: for selectors such as `tableView:didSelect...`, the
    // first token after the owning type is the declaration name. Importantly,
    // package segments before the type (`com.example`) never become methods.
    methodNames: [...new Set(methodNames)].slice(0, 4),
    ...(!hasAnonymousOwner && typeNames.length > 0
      ? { ownerType: typeNames[typeNames.length - 1] }
      : {}),
  };
}

const LANGUAGE_TYPE_WORDS = new Set([
  "bool", "boolean", "byte", "char", "const", "double", "float", "int",
  "long", "short", "signed", "string", "uint", "ulong", "unsigned", "void",
]);

function lineSnippet(lines: string[], line: number, contextLines: number): string | undefined {
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return undefined;
  const start = Math.max(0, line - 1 - contextLines);
  const end = Math.min(lines.length, line + contextLines);
  const text = lines.slice(start, end).join("\n");
  const out = snippet(text, 500);
  return out || undefined;
}

function findSymbolLine(file: SourceFile, names: string[]): number | undefined {
  for (const name of names) {
    if (name.length < 2) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`);
    const index = file.lines.findIndex((line) => re.test(line));
    if (index >= 0) return index + 1;
  }
  return undefined;
}

/**
 * Require declaration-shaped evidence before a method contributes to `high`.
 * A plain occurrence/call is still useful as a low-confidence fallback, but it
 * must not make an untrusted stack path look like an exact source mapping.
 */
function maskNonCodeLines(lines: string[]): string[] {
  let blockComment = false;
  let quote: "'" | '"' | "`" | "'''" | '\"\"\"' | undefined;

  return lines.map((line) => {
    const output = line.split("");
    for (let index = 0; index < line.length;) {
      if (blockComment) {
        output[index] = " ";
        if (line[index] === "*" && line[index + 1] === "/") {
          output[index + 1] = " ";
          blockComment = false;
          index += 2;
        } else {
          index++;
        }
        continue;
      }

      if (quote) {
        const delimiter = quote;
        const width = delimiter.length;
        if (line.startsWith(delimiter, index)) {
          output.fill(" ", index, index + width);
          quote = undefined;
          index += width;
        } else if (line[index] === "\\" && width === 1) {
          output[index] = " ";
          if (index + 1 < line.length) output[index + 1] = " ";
          index += 2;
        } else {
          output[index] = " ";
          index++;
        }
        continue;
      }

      if (line[index] === "/" && line[index + 1] === "/") {
        output.fill(" ", index);
        break;
      }
      if (line[index] === "/" && line[index + 1] === "*") {
        output[index] = " ";
        output[index + 1] = " ";
        blockComment = true;
        index += 2;
        continue;
      }
      const triple = line.slice(index, index + 3);
      if (triple === '\"\"\"' || triple === "'''") {
        output.fill(" ", index, index + 3);
        quote = triple;
        index += 3;
        continue;
      }
      const current = line[index];
      if (current === "'" || current === '"' || current === "`") {
        output[index] = " ";
        quote = current;
        index++;
        continue;
      }
      index++;
    }
    return output.join("");
  });
}

function findMethodDeclarations(file: SourceFile, names: string[]): MethodDeclaration[] {
  const matches: MethodDeclaration[] = [];
  if (!["kt", "kts", "swift", "java"].includes(file.extension)) return matches;
  for (const name of names) {
    if (name.length < 2) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const declarationPattern = file.extension === "kt" || file.extension === "kts"
      ? new RegExp(
        `\\bfun\\s+(?:<[^>{};]*>\\s*)?(?:[A-Za-z_$][A-Za-z0-9_$<>,?.]*\\s*\\.\\s*)?${escaped}\\s*(?:<[^>{};]*>)?\\s*\\(`,
      )
      : file.extension === "swift"
        ? new RegExp(`\\bfunc\\s+${escaped}\\s*(?:<[^>{};]*>)?\\s*\\(`)
        : new RegExp(
          `^\\s*(?:@[A-Za-z_$][A-Za-z0-9_$.]*(?:\\([^)]*\\))?\\s*)*`
          + `(?:(?:public|private|protected|static|final|abstract|synchronized|native|strictfp|default)\\s+)*`
          + `(?:<[^>{};]+>\\s*)?`
          + `[A-Za-z_$][A-Za-z0-9_$.[\\]<>?,]*(?:\\s*\\[\\])?\\s+`
          + `${escaped}\\s*(?:<[^>{};]*>)?\\s*\\(`,
        );
    file.codeLines.forEach((line, index) => {
      if (!declarationPattern.test(line)) return;
      const column = line.search(new RegExp(`\\b${escaped}\\b`));
      if (column >= 0) matches.push({ line: index + 1, column, name });
    });
  }
  const unique = new Map<string, MethodDeclaration>();
  for (const match of matches) unique.set(`${match.line}\0${match.column}\0${match.name}`, match);
  return [...unique.values()].sort((a, b) => a.line - b.line || a.column - b.column);
}

function methodBodyContainsLine(
  file: SourceFile,
  declaration: MethodDeclaration,
  reportedLine: number,
): boolean {
  const declarationLine = declaration.line;
  if (reportedLine < declarationLine || reportedLine > file.codeLines.length) return false;

  // 表达式体只能可靠关联到声明行；带花括号的方法则要求 reported line
  // 位于该方法闭合花括号之前，避免把同文件的任意有效行误判为 high。
  const maxHeaderLine = Math.min(file.codeLines.length, declarationLine + 8);
  let depth = 0;
  let bodyStarted = false;
  for (let lineNumber = declarationLine; lineNumber <= file.codeLines.length; lineNumber++) {
    let code = file.codeLines[lineNumber - 1] ?? "";
    if (lineNumber === declarationLine) {
      code = code.slice(declaration.column);
    }
    if (!bodyStarted && lineNumber > maxHeaderLine) return false;

    for (const char of code) {
      if (!bodyStarted && char === ";") return false;
      if (char === "{") {
        bodyStarted = true;
        depth++;
      } else if (char === "}" && bodyStarted) {
        depth--;
        if (depth === 0) return reportedLine <= lineNumber;
        if (depth < 0) return false;
      }
    }
  }

  return false;
}

function positionBeforeOrEqual(
  leftLine: number,
  leftColumn: number,
  rightLine: number,
  rightColumn: number,
): boolean {
  return leftLine < rightLine || (leftLine === rightLine && leftColumn <= rightColumn);
}

function findBracedScope(
  file: SourceFile,
  startLine: number,
  startColumn: number,
): Omit<TypeScope, "name" | "startLine" | "startColumn" | "objectiveC"> | undefined {
  const maxHeaderLine = Math.min(file.codeLines.length, startLine + 8);
  let openingLine: number | undefined;
  let openingColumn: number | undefined;
  for (let lineNumber = startLine; lineNumber <= maxHeaderLine; lineNumber++) {
    const code = file.codeLines[lineNumber - 1] ?? "";
    const from = lineNumber === startLine ? startColumn : 0;
    for (let column = from; column < code.length; column++) {
      if (code[column] === ";") return undefined;
      if (code[column] === "{") {
        openingLine = lineNumber;
        openingColumn = column;
        break;
      }
    }
    if (openingLine !== undefined) break;
  }
  if (openingLine === undefined || openingColumn === undefined) return undefined;

  let depth = 0;
  for (let lineNumber = openingLine; lineNumber <= file.codeLines.length; lineNumber++) {
    const code = file.codeLines[lineNumber - 1] ?? "";
    const from = lineNumber === openingLine ? openingColumn : 0;
    for (let column = from; column < code.length; column++) {
      if (code[column] === "{") depth++;
      if (code[column] !== "}") continue;
      depth--;
      if (depth === 0) {
        return {
          endLine: lineNumber,
          endColumn: column,
          bodyDepth: braceDepthAtPosition(file, openingLine, openingColumn) + 1,
        };
      }
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}

function braceDepthAtPosition(file: SourceFile, targetLine: number, targetColumn: number): number {
  let depth = 0;
  for (let lineNumber = 1; lineNumber <= targetLine; lineNumber++) {
    const code = file.codeLines[lineNumber - 1] ?? "";
    const end = lineNumber === targetLine ? Math.min(targetColumn, code.length) : code.length;
    for (let column = 0; column < end; column++) {
      if (code[column] === "{") depth++;
      else if (code[column] === "}") depth = Math.max(0, depth - 1);
    }
  }
  return depth;
}

function findTypeScopes(file: SourceFile): TypeScope[] {
  const scopes: TypeScope[] = [];
  const typePattern = /\b(?:class|struct|enum|object|interface|actor|extension|protocol|trait|record)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
  const objectiveCPattern = /^\s*@(implementation|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/;

  file.codeLines.forEach((line, index) => {
    typePattern.lastIndex = 0;
    for (let match = typePattern.exec(line); match !== null; match = typePattern.exec(line)) {
      const name = match[1];
      if (!name) continue;
      const startColumn = match.index;
      const range = findBracedScope(file, index + 1, startColumn + match[0].length);
      if (range) {
        scopes.push({
          name,
          startLine: index + 1,
          startColumn,
          ...range,
          objectiveC: false,
        });
      }
    }

    const objectiveC = objectiveCPattern.exec(line);
    const name = objectiveC?.[2];
    if (!name) return;
    const endOffset = file.codeLines.slice(index + 1).findIndex((candidate) => /^\s*@end\b/.test(candidate));
    if (endOffset < 0) return;
    const endLine = index + endOffset + 2;
    scopes.push({
      name,
      startLine: index + 1,
      startColumn: objectiveC?.index ?? 0,
      endLine,
      endColumn: (file.codeLines[endLine - 1] ?? "").length,
      objectiveC: true,
    });
  });
  return scopes;
}

function methodBelongsToExpectedType(
  file: SourceFile,
  declaration: MethodDeclaration,
  ownerType: string | undefined,
): boolean {
  if (!ownerType) return false;
  const declarationCode = file.codeLines[declaration.line - 1] ?? "";
  const escapedType = ownerType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedMethod = declaration.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\b${escapedType}\\s*(?:::|\\.)\\s*${escapedMethod}\\b`).test(declarationCode)) {
    return true;
  }

  const scopes = findTypeScopes(file).filter((scope) =>
    positionBeforeOrEqual(scope.startLine, scope.startColumn, declaration.line, declaration.column)
    && positionBeforeOrEqual(declaration.line, declaration.column, scope.endLine, scope.endColumn));
  const owner = scopes.sort((a, b) =>
    b.startLine - a.startLine || b.startColumn - a.startColumn)[0];
  if (!owner || owner.name !== ownerType) return false;
  if (owner.objectiveC) return true;
  return owner.bodyDepth === braceDepthAtPosition(file, declaration.line, declaration.column);
}

async function loadSources(projectDir: string): Promise<{
  root: string;
  files: SourceFile[];
  truncated: boolean;
  skippedLargeFiles: number;
  sourceBytesScanned: number;
}> {
  if (!isAbsolute(projectDir)) throw new Error("project_dir must be absolute");
  const root = await realpath(projectDir);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("project_dir must resolve to a real directory");
  }
  const walked = await walk(root, {
    extensions: SOURCE_EXTENSIONS,
    maxFiles: MAX_SOURCE_FILES,
  });
  const files: SourceFile[] = [];
  let skippedLargeFiles = 0;
  let sourceBytesScanned = 0;
  let byteBudgetReached = false;
  for (const abs of walked.files) {
    const loaded = await readBoundedSource(abs);
    if (!loaded) {
      skippedLargeFiles++;
      continue;
    }
    if (sourceBytesScanned + loaded.bytes > MAX_TOTAL_SOURCE_BYTES) {
      byteBudgetReached = true;
      break;
    }
    sourceBytesScanned += loaded.bytes;
    const relative = rel(root, abs);
    const name = basename(relative);
    const extension = extname(name).slice(1).toLowerCase();
    const lines = loaded.content.split(/\r?\n/);
    files.push({
      rel: relative,
      basename: name,
      stem: name.slice(0, Math.max(0, name.length - extname(name).length)),
      extension,
      lines,
      codeLines: maskNonCodeLines(lines),
    });
  }
  return {
    root,
    files,
    truncated: walked.truncated || byteBudgetReached,
    skippedLargeFiles,
    sourceBytesScanned,
  };
}

async function readBoundedSource(
  absolutePath: string,
): Promise<{ content: string; bytes: number } | undefined> {
  let handle;
  try {
    handle = await open(absolutePath, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_SOURCE_BYTES) {
      return undefined;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_SOURCE_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_SOURCE_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_SOURCE_BYTES) return undefined;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (total === 0) return undefined;
    return { content: Buffer.concat(chunks, total).toString("utf8"), bytes: total };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function locateStackFrames(
  projectDir: string,
  frames: StackFrameInput[],
  options: LocateStackFramesOptions = {},
): Promise<{
  project_dir: string;
  candidates: StackFrameCandidate[];
  unmatched_frames: number[];
  files_scanned: number;
  scan_truncated: boolean;
  skipped_large_files: number;
  source_bytes_scanned: number;
  results_truncated: boolean;
}> {
  const contextLines = Math.max(0, Math.min(5, options.contextLines ?? 2));
  const maxCandidates = Math.max(1, Math.min(200, options.maxCandidates ?? 64));
  const loaded = await loadSources(projectDir);
  const candidates: StackFrameCandidate[] = [];
  const unmatched: number[] = [];
  let resultsTruncated = false;

  for (const frame of frames) {
    const before = candidates.length;
    const stackPath = normalizeStackPath(frame.file);
    const stackBase = stackPath ? basename(stackPath) : undefined;
    const tokens = symbolTokens(frame.symbol);
    const perFrame = new Map<string, StackFrameCandidate>();

    for (const file of loaded.files) {
      let matchType: StackFrameCandidate["match_type"] | undefined;
      let confidence: StackFrameCandidate["confidence"] | undefined;
      const symbolLine = findSymbolLine(file, [...tokens.methodNames, ...tokens.typeNames]);
      const methodDeclarations = findMethodDeclarations(file, tokens.methodNames);
      const methodDeclarationLine = methodDeclarations[0]?.line;
      const hasValidReportedLine = frame.line !== undefined
        && Number.isInteger(frame.line)
        && frame.line >= 1
        && frame.line <= file.lines.length;
      const reportedLineMatchesMethod = hasValidReportedLine
        && methodDeclarations.some((declaration) =>
          methodBodyContainsLine(file, declaration, frame.line!)
          && methodBelongsToExpectedType(file, declaration, tokens.ownerType));
      if (stackPath && matchesPathSuffix(file.rel, stackPath)) {
        matchType = "path-suffix";
        confidence = stackPath.includes("/")
          && reportedLineMatchesMethod
          ? "high"
          : "medium";
      } else if (stackBase && file.basename === stackBase) {
        matchType = "basename";
        confidence = "medium";
      } else if (tokens.typeNames.includes(file.stem)) {
        matchType = "type-name";
        confidence = "medium";
      }

      let line = hasValidReportedLine ? frame.line : undefined;
      if (!matchType) {
        const methodLine = findSymbolLine(file, tokens.methodNames);
        if (methodLine !== undefined) {
          matchType = "symbol";
          confidence = "low";
          line = methodLine;
        }
      } else if (line === undefined) {
        line = methodDeclarationLine ?? symbolLine;
      }

      if (!matchType || !confidence) continue;
      const key = `${frame.index}\0${file.rel}`;
      perFrame.set(key, {
        frame_index: frame.index,
        file: file.rel,
        ...(line !== undefined ? { line } : {}),
        ...(frame.symbol ? { symbol: frame.symbol.slice(0, MAX_SYMBOL_CHARS) } : {}),
        match_type: matchType,
        confidence,
        ...(line !== undefined
          ? { snippet: lineSnippet(file.lines, line, contextLines) }
          : {}),
      });
    }

    const rank = { high: 0, medium: 1, low: 2 } as const;
    const ordered = [...perFrame.values()].sort(
      (a, b) => rank[a.confidence] - rank[b.confidence] || a.file.localeCompare(b.file),
    );
    for (const candidate of ordered) {
      if (candidates.length >= maxCandidates) {
        resultsTruncated = true;
        break;
      }
      candidates.push(candidate);
    }
    if (candidates.length === before) unmatched.push(frame.index);
    if (resultsTruncated) break;
  }

  // A partial scan cannot prove that a returned high-confidence match is
  // unique. Downgrade instead of letting callers mistake incomplete evidence
  // for an auto-patch qualification signal.
  if (loaded.truncated || resultsTruncated) {
    for (const candidate of candidates) {
      if (candidate.confidence === "high") candidate.confidence = "medium";
    }
  }

  return {
    project_dir: loaded.root,
    candidates,
    unmatched_frames: unmatched,
    files_scanned: loaded.files.length,
    scan_truncated: loaded.truncated,
    skipped_large_files: loaded.skippedLargeFiles,
    source_bytes_scanned: loaded.sourceBytesScanned,
    results_truncated: resultsTruncated,
  };
}
