import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export const QUICK_SOURCE_MAX_FILES = 3;
export const QUICK_SOURCE_MAX_FILE_BYTES = 512 * 1024;
export const QUICK_SOURCE_MAX_TOTAL_BYTES = 1024 * 1024;

const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".dart", ".h", ".hh", ".hpp",
  ".java", ".js", ".jsx", ".kt", ".kts", ".m", ".mm", ".swift",
  ".ts", ".tsx", ".vue", ".xml",
]);

const BLOCKED_DIRECTORY_NAMES = new Set([
  ".git", ".gradle", ".idea", ".worktrees", "build", "deriveddata",
  "dist", "node_modules", "out", "pods", "secrets", "target", "vendor",
]);

const CREDENTIAL_EXTENSIONS = new Set([
  ".der", ".jks", ".key", ".keystore", ".p12", ".pem", ".pfx",
]);

const CREDENTIAL_NAME_RE = /(?:^|[-_.])(?:auth(?:orized)?|cookie|credential|firebase-admin|keystore|password|private[-_.]?key|secret|service[-_.]?account|token)(?:[-_.]|$)/iu;
const PRIVATE_KEY_BLOCK_RE = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u;
const SENSITIVE_ASSIGNMENT_RE = /\b(?:access[_-]?token|api[_-]?key|client[_-]?secret|password|private[_-]?key|refresh[_-]?token)\b\s*[:=]/iu;

export interface QuickSourceFile {
  relative_path: string;
  bytes: number;
  sha256: string;
  content: string;
}

export interface QuickSourceReadResult {
  schema_version: "quick-source-read/v1";
  files: QuickSourceFile[];
  total_bytes: number;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function normalizeRelativeSourcePath(value: string): string {
  if (
    value.length === 0
    || value.length > 1024
    || value.includes("\0")
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || /^[A-Za-z]:/u.test(value)
  ) {
    throw new Error("quick source path must be a bounded relative POSIX path");
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("quick source path must be normalized and stay inside the project");
  }
  return normalized;
}

function assertSourcePathPolicy(relativePath: string): void {
  const parts = relativePath.split("/");
  const basename = parts.at(-1)!.toLowerCase();
  const extension = path.posix.extname(basename);
  if (!SOURCE_EXTENSIONS.has(extension)) {
    throw new Error("quick source path must use an allowlisted source extension");
  }
  if (
    basename === ".env"
    || basename.startsWith(".env.")
    || CREDENTIAL_EXTENSIONS.has(extension)
    || parts.some((part) => BLOCKED_DIRECTORY_NAMES.has(part.toLowerCase()))
    || parts.some((part) => CREDENTIAL_NAME_RE.test(part))
  ) {
    throw new Error("quick source path is credential-like or generated");
  }
}

async function assertStableAncestorChain(
  canonicalRoot: string,
  relativePath: string,
): Promise<void> {
  const parts = relativePath.split("/");
  let current = canonicalRoot;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("quick source ancestor must be a real directory");
    }
  }
}

async function readOne(
  canonicalRoot: string,
  relativePath: string,
): Promise<QuickSourceFile> {
  assertSourcePathPolicy(relativePath);
  await assertStableAncestorChain(canonicalRoot, relativePath);
  const candidate = path.join(canonicalRoot, ...relativePath.split("/"));
  const [pathBefore, canonicalCandidate] = await Promise.all([
    lstat(candidate),
    realpath(candidate),
  ]);
  if (
    !pathBefore.isFile()
    || pathBefore.isSymbolicLink()
    || pathBefore.nlink !== 1
    || pathBefore.size < 0
    || pathBefore.size > QUICK_SOURCE_MAX_FILE_BYTES
    || !isInside(canonicalRoot, canonicalCandidate)
    || canonicalCandidate !== candidate
  ) {
    throw new Error("quick source must be a bounded single-link regular file");
  }

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(candidate, flags);
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.dev !== pathBefore.dev
      || before.ino !== pathBefore.ino
      || before.size !== pathBefore.size
    ) {
      throw new Error("quick source changed before it was read");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== before.size || bytes.byteLength > QUICK_SOURCE_MAX_FILE_BYTES) {
      throw new Error("quick source changed while it was read");
    }
    const content = bytes.toString("utf8");
    if (Buffer.from(content, "utf8").byteLength !== bytes.byteLength) {
      throw new Error("quick source must be valid UTF-8 text");
    }
    // Never return credential-like content through the quick path. The check
    // happens entirely in memory and errors stay value-free.
    if (PRIVATE_KEY_BLOCK_RE.test(content) || SENSITIVE_ASSIGNMENT_RE.test(content)) {
      throw new Error("quick source content is credential-like");
    }
    const [after, pathAfter, canonicalAfter] = await Promise.all([
      handle.stat(),
      lstat(candidate),
      realpath(candidate),
    ]);
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || pathAfter.dev !== after.dev
      || pathAfter.ino !== after.ino
      || pathAfter.nlink !== 1
      || pathAfter.isSymbolicLink()
      || canonicalAfter !== canonicalCandidate
    ) {
      throw new Error("quick source changed while it was read");
    }
    return {
      relative_path: relativePath,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      content,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Read only the exact source files approved for the quick workflow. This is
 * deliberately not a repository scanner and never follows links.
 */
export async function readQuickSourceFiles(
  projectDir: string,
  rawRelativePaths: readonly string[],
): Promise<QuickSourceReadResult> {
  if (!path.isAbsolute(projectDir) || projectDir.length > 4096 || projectDir.includes("\0")) {
    throw new Error("quick source project_dir must be a bounded absolute path");
  }
  if (rawRelativePaths.length < 1 || rawRelativePaths.length > QUICK_SOURCE_MAX_FILES) {
    throw new Error(`quick source reads require 1-${QUICK_SOURCE_MAX_FILES} files`);
  }
  const relativePaths = rawRelativePaths.map(normalizeRelativeSourcePath);
  if (new Set(relativePaths).size !== relativePaths.length) {
    throw new Error("quick source paths must be distinct");
  }

  const [rootPathMetadata, canonicalRoot] = await Promise.all([
    lstat(projectDir),
    realpath(projectDir),
  ]);
  let canonicalRootMetadata;
  try {
    canonicalRootMetadata = await lstat(canonicalRoot);
  } catch {
    throw new Error("quick source project_dir must be a real directory");
  }
  if (
    !rootPathMetadata.isDirectory()
    || rootPathMetadata.isSymbolicLink()
    || !canonicalRootMetadata.isDirectory()
    || canonicalRootMetadata.isSymbolicLink()
    || rootPathMetadata.dev !== canonicalRootMetadata.dev
    || rootPathMetadata.ino !== canonicalRootMetadata.ino
  ) {
    throw new Error("quick source project_dir must be a real directory");
  }

  const files: QuickSourceFile[] = [];
  let totalBytes = 0;
  for (const relativePath of relativePaths) {
    const file = await readOne(canonicalRoot, relativePath);
    totalBytes += file.bytes;
    if (totalBytes > QUICK_SOURCE_MAX_TOTAL_BYTES) {
      throw new Error("quick source aggregate byte limit exceeded");
    }
    files.push(file);
  }
  return {
    schema_version: "quick-source-read/v1",
    files,
    total_bytes: totalBytes,
  };
}
