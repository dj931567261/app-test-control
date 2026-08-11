#!/usr/bin/env node
// scripts/install-skills.mjs
// 把 skills/<name>/SKILL.md 安装到指定 AI 客户端的位置。
//
// 用法：
//   node scripts/install-skills.mjs [--client <name>] [--force]
//
// 支持的 client：
//   claude-code (默认)  → .claude/skills/<name>/ (完整 bundle，frontmatter 原样)
//   cursor             → .cursor/rules/<name>.mdc + <name>/ supporting files
//   codex              → ~/.codex/skills/<name>/ (完整 bundle) + 项目根 AGENTS.md
//                        `--global` / `--project` 可只安装其中一种 scope
//   claude-desktop     → 打印完整 bundle 手动导入清单 (无可自动写入的项目级 skill 目录)
//   opencode           → 复用完整 .claude/skills/，缺失时写全局完整 bundle（兜底）

import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const skillsDir = resolve(projectRoot, "skills");

const SUPPORTED_CLIENTS = ["claude-code", "cursor", "codex", "claude-desktop", "opencode", "antigravity"];
const MAX_SKILL_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_SKILL_BUNDLE_FILES = 256;
const MAX_SKILL_BUNDLE_DIRS = 64;
const MAX_SKILL_BUNDLE_DEPTH = 8;
const BUNDLE_DIRS = new Set(["agents", "references", "scripts", "assets"]);

function usage() {
  console.log(`Usage: install-skills.mjs [--client <name>] [--force] [--global|--project]`);
  console.log(`  --client one of: ${SUPPORTED_CLIENTS.join(", ")} (default claude-code)`);
  console.log(`  --force    exactly synchronize each managed skill/rule bundle (removes stale files)`);
  console.log(`  --global   Codex: only install ~/.codex/skills`);
  console.log(`  --project  Codex: only generate project AGENTS.md`);
}

function parseArgs(argv) {
  const out = { client: "claude-code", force: false, global: null };
  let scopeFlag = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--client") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) throw new Error("--client 缺少客户端名称");
      out.client = value;
    }
    else if (a === "--force" || a === "-f") out.force = true;
    else if (a === "--global" || a === "--project") {
      if (scopeFlag && scopeFlag !== a) {
        throw new Error("--global 与 --project 互斥，不能同时使用");
      }
      scopeFlag = a;
      out.global = a === "--global";
    }
    else if (a === "--help" || a === "-h") {
      out.help = true;
    } else {
      throw new Error(`未知参数：${a}`);
    }
  }
  if (out.global !== null && out.client !== "codex") {
    throw new Error("--global / --project 目前只适用于 --client codex");
  }
  return out;
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

function assertContained(target, boundary) {
  const rel = relative(resolve(boundary), resolve(target));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`目标路径越过允许边界：${target}`);
  }
}

async function ensureSafeDirectory(targetDir, boundary) {
  const base = resolve(boundary);
  const target = resolve(targetDir);
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`目录越过允许边界：${target}`);
  }

  let current = base;
  const parts = rel ? rel.split(sep).filter(Boolean) : [];
  for (const part of parts) {
    current = resolve(current, part);
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new Error(`拒绝经过符号链接或非目录路径：${current}`);
      }
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
        throw new Error(`拒绝经过其他用户拥有的目录：${current}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o755 });
      const st = await lstat(current);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new Error(`创建出的目录不安全：${current}`);
      }
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
        throw new Error(`创建出的目录 owner 不匹配：${current}`);
      }
    }
  }
}

async function inspectManagedDestination(dst) {
  try {
    const st = await lstat(dst);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(`拒绝覆盖符号链接或非普通文件：${dst}`);
    }
    if (st.nlink !== 1) throw new Error(`拒绝覆盖硬链接文件：${dst}`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      throw new Error(`拒绝覆盖其他用户拥有的文件：${dst}`);
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeManagedFile(dst, content, { force, boundary, mode = 0o644 }) {
  assertContained(dst, boundary);
  await ensureSafeDirectory(dirname(dst), boundary);
  const existed = await inspectManagedDestination(dst);
  if (existed && !force) return false;

  const tmp = `${dst}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let handle;
  try {
    handle = await open(tmp, "wx", mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(tmp, mode);
    await inspectManagedDestination(tmp);
    if (force) {
      // rename 替换的是目录项本身，不会跟随目标文件；前面的 lstat 负责拒绝可疑旧目标。
      await rename(tmp, dst);
    } else {
      // hard-link + unlink 是同文件系统内的原子 no-clobber 发布；避免检查后到发布前
      // 目标刚好出现时，默认模式意外覆盖已有文件。
      try {
        await link(tmp, dst);
      } catch (error) {
        if (error?.code === "EEXIST") return false;
        throw error;
      }
      await unlink(tmp);
    }
    await inspectManagedDestination(dst);
    return true;
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(tmp).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function readSkillSource(skillPath) {
  const content = await readStableSourceFile(
    skillPath,
    MAX_SKILL_BYTES,
    "skill 源",
    dirname(skillPath),
  );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error(`skill 源不是合法 UTF-8：${skillPath}`);
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/**
 * 通过 file descriptor 有界读取源文件，拒绝 symlink / hardlink，并在读取前后
 * 核对目录项与 fd 身份。这样源 bundle 在预检后被并发替换时不会把其他文件
 * 静默安装到客户端目录。
 */
async function readStableSourceFile(source, maxBytes, label, boundary) {
  const before = await lstat(source, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
    throw new Error(`${label}必须是无硬链接的普通文件：${source}`);
  }
  if (before.size < 0n || before.size > BigInt(maxBytes)) {
    throw new Error(`${label}超过 ${maxBytes} 字节上限：${source}`);
  }
  const [canonicalBoundary, canonicalBefore] = await Promise.all([
    realpath(boundary),
    realpath(source),
  ]);
  const beforeRelative = relative(canonicalBoundary, canonicalBefore);
  if (
    beforeRelative === ".."
    || beforeRelative.startsWith(`..${sep}`)
    || isAbsolute(beforeRelative)
  ) {
    throw new Error(`${label}越过 skill bundle 边界：${source}`);
  }

  let handle;
  let operationError;
  try {
    handle = await open(
      source,
      fsConstants.O_RDONLY
        | (fsConstants.O_NOFOLLOW ?? 0)
        | (fsConstants.O_NONBLOCK ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFileIdentity(before, opened)) {
      throw new Error(`${label}在打开前发生变化：${source}`);
    }

    const content = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < content.byteLength) {
      const { bytesRead } = await handle.read(
        content,
        offset,
        content.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) throw new Error(`${label}在读取期间被截断：${source}`);
      offset += bytesRead;
    }
    const eofProbe = Buffer.allocUnsafe(1);
    const { bytesRead: trailingBytes } = await handle.read(eofProbe, 0, 1, offset);
    if (trailingBytes !== 0) throw new Error(`${label}在读取期间增长：${source}`);

    const [afterFd, afterPath, canonicalAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(source, { bigint: true }),
      realpath(source),
    ]);
    if (
      !afterPath.isFile()
      || afterPath.isSymbolicLink()
      || afterPath.nlink !== 1n
      || !sameFileIdentity(opened, afterFd)
      || !sameFileIdentity(afterFd, afterPath)
      || canonicalAfter !== canonicalBefore
    ) {
      throw new Error(`${label}在读取期间发生变化：${source}`);
    }
    return content;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        if (operationError) {
          throw new AggregateError(
            [operationError, closeError],
            `${label}读取失败且文件句柄关闭失败`,
          );
        }
        throw closeError;
      }
    }
  }
}

async function readSkillBundle(skillDir) {
  const files = [];
  let totalBytes = 0;
  let totalDirectories = 0;

  async function visit(dir, relativeDir, depth) {
    if (depth > MAX_SKILL_BUNDLE_DEPTH) {
      throw new Error(
        `skill bundle 递归深度超过 ${MAX_SKILL_BUNDLE_DEPTH}：${dir}`,
      );
    }
    totalDirectories += 1;
    if (totalDirectories > MAX_SKILL_BUNDLE_DIRS) {
      throw new Error(
        `skill bundle 目录数超过 ${MAX_SKILL_BUNDLE_DIRS}：${skillDir}`,
      );
    }
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const source = resolve(dir, entry.name);
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`skill bundle 不允许符号链接：${source}`);
      }
      if (entry.isDirectory()) {
        await visit(source, relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`skill bundle 只允许普通文件：${source}`);
      }
      const content = await readStableSourceFile(
        source,
        MAX_SKILL_BYTES,
        "skill bundle 源",
        skillDir,
      );
      totalBytes += content.byteLength;
      if (totalBytes > MAX_SKILL_BUNDLE_BYTES) {
        throw new Error(`skill bundle 总大小超过 ${MAX_SKILL_BUNDLE_BYTES} 字节：${skillDir}`);
      }
      files.push({ relativePath, content });
      if (files.length > MAX_SKILL_BUNDLE_FILES) {
        throw new Error(`skill bundle 文件数超过 ${MAX_SKILL_BUNDLE_FILES}：${skillDir}`);
      }
    }
  }

  for (const name of BUNDLE_DIRS) {
    const dir = resolve(skillDir, name);
    try {
      const st = await lstat(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new Error(`skill bundle 目录不安全：${dir}`);
      }
      await visit(dir, name, 1);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return files.sort((a, b) => compareUtf8(a.relativePath, b.relativePath));
}

function assertSafeRelativePath(relativePath) {
  if (
    typeof relativePath !== "string"
    || relativePath.length === 0
    || relativePath.includes("\\")
    || isAbsolute(relativePath)
  ) {
    throw new Error(`非法 bundle 相对路径：${relativePath}`);
  }
  const normalized = relativePath.split("/");
  if (normalized.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`bundle 相对路径包含越界片段：${relativePath}`);
  }
}

function assertOwned(st, target) {
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`拒绝操作其他用户拥有的路径：${target}`);
  }
}

async function inspectManagedDirectory(targetDir, boundary) {
  assertContained(targetDir, boundary);
  let rootStat;
  try {
    rootStat = await lstat(targetDir);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`拒绝覆盖符号链接或非目录 skill bundle：${targetDir}`);
  }
  assertOwned(rootStat, targetDir);

  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const child = resolve(dir, entry.name);
      assertContained(child, targetDir);
      const st = await lstat(child);
      if (st.isSymbolicLink()) {
        throw new Error(`拒绝操作含符号链接的 skill bundle：${child}`);
      }
      assertOwned(st, child);
      if (st.isDirectory()) {
        await visit(child);
      } else if (!st.isFile()) {
        throw new Error(`skill bundle 目标只能包含普通文件和目录：${child}`);
      } else if (st.nlink !== 1) {
        throw new Error(`拒绝操作含硬链接的 skill bundle：${child}`);
      }
    }
  }

  await visit(targetDir);
  return true;
}

async function inspectArtifactTarget(artifact, boundary) {
  if (artifact.kind === "file") {
    assertContained(artifact.path, boundary);
    return inspectManagedDestination(artifact.path);
  }
  if (artifact.kind === "directory") {
    return inspectManagedDirectory(artifact.path, boundary);
  }
  throw new Error(`未知安装产物类型：${artifact.kind}`);
}

async function writeStagedFile(dst, content, { boundary, mode }) {
  assertContained(dst, boundary);
  await ensureSafeDirectory(dirname(dst), boundary);
  let handle;
  let createdStat;
  try {
    handle = await open(dst, "wx", mode);
    createdStat = await handle.stat();
    if (!createdStat.isFile() || createdStat.nlink !== 1) {
      throw new Error(`创建出的临时文件不安全：${dst}`);
    }
    assertOwned(createdStat, dst);
    await handle.writeFile(content);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = null;
    await inspectManagedDestination(dst);
    const publishedStat = await lstat(dst);
    if (publishedStat.dev !== createdStat.dev || publishedStat.ino !== createdStat.ino) {
      throw new Error(`临时文件在写入期间被替换：${dst}`);
    }
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      handle = null;
    }
    let cleanupError = null;
    if (createdStat) {
      try {
        const current = await lstat(dst);
        if (
          current.isSymbolicLink()
          || !current.isFile()
          || current.nlink !== 1
          || current.dev !== createdStat.dev
          || current.ino !== createdStat.ino
        ) {
          throw new Error(`临时文件在写入期间被替换，拒绝删除：${dst}`);
        }
        assertOwned(current, dst);
        await unlink(dst);
      } catch (cleanupFailure) {
        if (cleanupFailure?.code !== "ENOENT") cleanupError = cleanupFailure;
      }
    }
    if (cleanupError) {
      throw new AggregateError([error, cleanupError], "临时文件写入失败且清理不完整");
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function stageArtifact(artifact, boundary) {
  const parent = dirname(artifact.path);
  await ensureSafeDirectory(parent, boundary);
  const stagePath = resolve(
    parent,
    `.${basename(artifact.path)}.stage-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  assertContained(stagePath, boundary);
  let directoryCreated = false;
  try {
    if (artifact.kind === "file") {
      await writeStagedFile(stagePath, artifact.content, {
        boundary: parent,
        mode: artifact.mode,
      });
      return stagePath;
    }

    await mkdir(stagePath, { mode: artifact.dirMode ?? 0o755 });
    directoryCreated = true;
    const rootStat = await lstat(stagePath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`创建出的临时 skill bundle 不安全：${stagePath}`);
    }
    assertOwned(rootStat, stagePath);
    for (const file of artifact.files) {
      assertSafeRelativePath(file.relativePath);
      const dst = resolve(stagePath, ...file.relativePath.split("/"));
      await writeStagedFile(dst, file.content, {
        boundary: stagePath,
        mode: artifact.mode,
      });
    }
    await inspectManagedDirectory(stagePath, parent);
    return stagePath;
  } catch (error) {
    if (directoryCreated) {
      try {
        await removeManagedArtifact(stagePath, artifact.kind, boundary);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "临时 skill bundle 创建失败且清理不完整");
      }
    }
    throw error;
  }
}

async function removeManagedArtifact(target, kind, boundary) {
  assertContained(target, boundary);
  if (kind === "file") {
    if (await inspectManagedDestination(target)) await unlink(target);
    return;
  }
  if (await inspectManagedDirectory(target, boundary)) {
    await rm(target, { recursive: true, force: false });
  }
}

/**
 * 把一个 skill 的所有目标作为一个事务发布：先完整预检和 staging，再替换目标。
 * 非 force 只要任一目标存在就整项跳过；force 使用 sibling backup 回滚，并以完整
 * staging 目录替换旧 bundle，所以源中已删除的文件和未知旧文件都不会残留。
 */
async function publishManagedArtifactsLocked(artifacts, { force, boundary }) {
  const normalized = artifacts.map((artifact) => ({
    ...artifact,
    path: resolve(artifact.path),
  }));
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      const a = normalized[i].path;
      const b = normalized[j].path;
      const aToB = relative(a, b);
      const bToA = relative(b, a);
      if (
        a === b
        || (aToB && !aToB.startsWith(`..${sep}`) && !isAbsolute(aToB))
        || (bToA && !bToA.startsWith(`..${sep}`) && !isAbsolute(bToA))
      ) {
        throw new Error(`安装产物路径重叠：${a} / ${b}`);
      }
    }
  }

  const existed = [];
  for (const artifact of normalized) {
    await ensureSafeDirectory(dirname(artifact.path), boundary);
    existed.push(await inspectArtifactTarget(artifact, boundary));
  }
  if (!force && existed.some(Boolean)) return false;

  const staged = [];
  const backups = [];
  const published = [];
  try {
    for (const artifact of normalized) {
      staged.push(await stageArtifact(artifact, boundary));
    }

    // 再检查一次，防止预检后并发出现目标；发生变化时不发布任何新产物。
    for (let i = 0; i < normalized.length; i++) {
      const current = await inspectArtifactTarget(normalized[i], boundary);
      if (current !== existed[i]) {
        throw new Error(`安装目标在发布前发生并发变化：${normalized[i].path}`);
      }
    }

    for (let i = 0; i < normalized.length; i++) {
      if (!existed[i]) continue;
      const artifact = normalized[i];
      const backup = resolve(
        dirname(artifact.path),
        `.${basename(artifact.path)}.backup-${process.pid}-${randomBytes(8).toString("hex")}`,
      );
      assertContained(backup, boundary);
      await rename(artifact.path, backup);
      backups.push({ artifact, backup });
    }

    for (let i = 0; i < normalized.length; i++) {
      await rename(staged[i], normalized[i].path);
      published.push(normalized[i]);
      staged[i] = null;
    }
  } catch (error) {
    let rollbackError = null;
    for (const artifact of [...published].reverse()) {
      try {
        await removeManagedArtifact(artifact.path, artifact.kind, boundary);
      } catch (rollbackFailure) {
        rollbackError ??= rollbackFailure;
      }
    }
    for (const { artifact, backup } of [...backups].reverse()) {
      try {
        await rename(backup, artifact.path);
      } catch (rollbackFailure) {
        rollbackError ??= rollbackFailure;
      }
    }
    if (rollbackError) {
      throw new AggregateError([error, rollbackError], "skill 安装失败且回滚不完整");
    }
    throw error;
  } finally {
    for (let i = 0; i < staged.length; i++) {
      if (!staged[i]) continue;
      await removeManagedArtifact(staged[i], normalized[i].kind, boundary).catch(() => {});
    }
  }

  // 新目标已完整发布后再清理旧备份；清理前仍重新做安全检查。
  for (const { artifact, backup } of backups) {
    await removeManagedArtifact(backup, artifact.kind, boundary);
  }
  return true;
}

async function publishManagedArtifacts(artifacts, options) {
  if (artifacts.length === 0) throw new Error("skill 安装产物不能为空");
  const boundary = resolve(options.boundary);
  const firstTarget = resolve(artifacts[0].path);
  const lockPath = `${firstTarget}.install-lock`;
  assertContained(lockPath, boundary);
  await ensureSafeDirectory(dirname(lockPath), boundary);

  let lockHandle;
  let lockStat;
  let result;
  let operationError = null;
  try {
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error(`同一 skill 正在安装或遗留了待审计的安装锁：${lockPath}`);
      }
      throw error;
    }
    lockStat = await lockHandle.stat();
    if (!lockStat.isFile() || lockStat.nlink !== 1) {
      throw new Error(`创建出的 skill 安装锁不安全：${lockPath}`);
    }
    assertOwned(lockStat, lockPath);
    await lockHandle.writeFile(`${process.pid}\n`, "utf8");
    await lockHandle.sync();
    const visibleLock = await lstat(lockPath);
    if (
      visibleLock.isSymbolicLink()
      || !visibleLock.isFile()
      || visibleLock.nlink !== 1
      || visibleLock.dev !== lockStat.dev
      || visibleLock.ino !== lockStat.ino
    ) {
      throw new Error(`skill 安装锁在发布前被替换：${lockPath}`);
    }
    assertOwned(visibleLock, lockPath);
    result = await publishManagedArtifactsLocked(artifacts, options);
  } catch (error) {
    operationError = error;
  } finally {
    if (lockHandle) await lockHandle.close().catch(() => {});
  }

  let cleanupError = null;
  if (lockStat) {
    try {
      const current = await lstat(lockPath);
      if (
        current.isSymbolicLink()
        || !current.isFile()
        || current.nlink !== 1
        || current.dev !== lockStat.dev
        || current.ino !== lockStat.ino
      ) {
        throw new Error(`skill 安装锁在运行期间被替换，拒绝删除：${lockPath}`);
      }
      assertOwned(current, lockPath);
      await unlink(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") cleanupError = error;
    }
  }

  if (operationError && cleanupError) {
    throw new AggregateError([operationError, cleanupError], "skill 安装与安装锁清理均失败");
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return result;
}

async function skillDirectoryFiles(skill) {
  const raw = await readSkillSource(skill.path);
  const bundle = await readSkillBundle(skill.dir);
  return {
    raw,
    bundle,
    files: [
      { relativePath: "SKILL.md", content: Buffer.from(raw, "utf8") },
      ...bundle,
    ],
  };
}

async function managedDirectoryMatches(targetDir, desiredFiles, boundary) {
  if (!(await inspectManagedDirectory(targetDir, boundary))) return false;
  const actual = new Map();

  async function visit(dir, relativeDir = "") {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const child = resolve(dir, entry.name);
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child, relativePath);
      else actual.set(relativePath, await readFile(child));
    }
  }
  await visit(targetDir);

  if (actual.size !== desiredFiles.length) return false;
  for (const file of desiredFiles) {
    assertSafeRelativePath(file.relativePath);
    const content = actual.get(file.relativePath);
    if (!content || !content.equals(Buffer.from(file.content))) return false;
  }
  return true;
}

async function installSkillDirectory(skill, targetDir, options) {
  const { files } = await skillDirectoryFiles(skill);
  return publishManagedArtifacts([
    {
      kind: "directory",
      path: targetDir,
      files,
      mode: options.mode,
      dirMode: options.mode === 0o600 ? 0o700 : 0o755,
    },
  ], options);
}

function rewriteBundleLinks(markdown, prefix, bundle) {
  const available = new Set(bundle.map((file) => file.relativePath));
  return markdown.replace(
    /\]\(((?:\.\/)?(?:agents|references|scripts|assets)\/[^)\s?#]+)([?#][^)\s]*)?\)/g,
    (match, target, suffix = "") => {
      const normalized = target.replace(/^\.\//, "");
      if (!available.has(normalized)) {
        throw new Error(`SKILL.md 引用了 bundle 中不存在的文件：${normalized}`);
      }
      return `](${prefix}${normalized}${suffix})`;
    },
  );
}

// Parse YAML-ish frontmatter at top of file.
// Returns { frontmatter: { name, description, version?, "argument-hint"? }, body: string }
function parseSkill(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: raw };
  const fmRaw = m[1];
  const body = m[2];
  const fm = {};
  // Simple line-based parser: "key: value" (value may be quoted)
  // Multi-line values (folded scalars) not supported; we don't use them.
  for (const line of fmRaw.split("\n")) {
    const k = line.match(/^([\w-]+):\s*(.*)$/);
    if (!k) continue;
    let val = k[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[k[1]] = val;
  }
  return { frontmatter: fm, body };
}

async function listSkills() {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const names = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(e.name)) {
      throw new Error(`非法 skill 目录名：${e.name}`);
    }
    const p = resolve(skillsDir, e.name, "SKILL.md");
    if (await exists(p)) {
      await readSkillSource(p);
      names.push({ name: e.name, path: p, dir: resolve(skillsDir, e.name) });
    }
  }
  return names.sort((a, b) => compareUtf8(a.name, b.name));
}

async function installClaudeCode(skills, force) {
  const targetBase = resolve(projectRoot, ".claude/skills");
  const written = [];
  for (const s of skills) {
    const targetDir = resolve(targetBase, s.name);
    if (!(await installSkillDirectory(s, targetDir, {
      force,
      boundary: projectRoot,
      mode: 0o644,
    }))) {
      console.error(`[install-skills] skip whole skill (target exists): ${targetDir} — use --force to synchronize`);
      continue;
    }
    written.push(resolve(targetDir, "SKILL.md"));
  }
  console.log(`[install-skills] wrote ${written.length} skill(s) for claude-code:`);
  written.forEach((p) => console.log(`  - ${p}`));
}

async function installCursor(skills, force) {
  const targetBase = resolve(projectRoot, ".cursor/rules");
  const written = [];
  for (const s of skills) {
    const { raw, bundle } = await skillDirectoryFiles(s);
    const { frontmatter, body } = parseSkill(raw);
    const desc = (frontmatter.description ?? `Skill: ${s.name}`)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    const dst = resolve(targetBase, `${s.name}.mdc`);
    const bundleDst = resolve(targetBase, s.name);
    const cursorBody = rewriteBundleLinks(body, `./${s.name}/`, bundle);
    const mdc = `---
description: "${desc}"
globs: ["**/*"]
alwaysApply: false
---

<!-- app-test-ctrl-managed-rule:${s.name}:v1 -->

# ${frontmatter.name ?? s.name}

${cursorBody}
`;
    const installed = await publishManagedArtifacts([
      { kind: "file", path: dst, content: mdc, mode: 0o644 },
      {
        kind: "directory",
        path: bundleDst,
        files: bundle,
        mode: 0o644,
        dirMode: 0o755,
      },
    ], { force, boundary: projectRoot });
    if (!installed) {
      console.error(`[install-skills] skip whole rule (target exists): ${dst} — use --force to synchronize`);
      continue;
    }
    written.push(dst);
  }
  console.log(`[install-skills] wrote ${written.length} rule(s) for cursor:`);
  written.forEach((p) => console.log(`  - ${p}`));
  console.log(`[install-skills] don't forget to run: npm run setup -- --client cursor`);
}

async function installCodex(skills, force, globalScope) {
  // 1) 复制每个 skill 到 ~/.codex/skills/<name>/SKILL.md（用户级，所有 codex 会话可见）
  if (globalScope !== false) {
    const globalBase = resolve(homedir(), ".codex/skills");
    const writtenGlobal = [];
    const skipped = [];
    for (const s of skills) {
      const targetDir = resolve(globalBase, s.name);
      if (!(await installSkillDirectory(s, targetDir, {
        force,
        boundary: homedir(),
        mode: 0o600,
      }))) {
        skipped.push(targetDir);
        continue;
      }
      writtenGlobal.push(resolve(targetDir, "SKILL.md"));
    }
    if (writtenGlobal.length) {
      console.log(`[install-skills] wrote ${writtenGlobal.length} skill(s) to ~/.codex/skills/:`);
      writtenGlobal.forEach((p) => console.log(`  - ${p}`));
    }
    if (skipped.length) {
      console.log(`[install-skills] skipped ${skipped.length} existing file(s) — use --force to overwrite:`);
      skipped.forEach((p) => console.log(`  - ${p}`));
    }
  }

  // 2) 项目根 AGENTS.md（聚合 prompt 注入，codex 进入此目录时自动读取）
  if (globalScope !== true) {
    const agentsDst = resolve(projectRoot, "AGENTS.md");
    const agentsExists = await inspectManagedDestination(agentsDst);
    if (agentsExists && !force) {
      console.log(`[install-skills] AGENTS.md exists — use --force to overwrite (project-level aggregate)`);
    } else {
      const header = `# app-test-ctrl — AI Agent Skills

<!-- app-test-ctrl-managed-agents:v1 -->

Aggregated skills for Codex CLI / any AGENTS.md-aware coding agent. Each section is a self-contained workflow. The agent should match user requests to the most relevant skill via its description.

Source of truth: \`skills/<name>/SKILL.md\` in this repo.
Supporting files remain under \`skills/<name>/{agents,references,scripts,assets}/\`; links in this
aggregate are rewritten to those repository-relative paths.
Optional user-level installation: complete bundle under \`~/.codex/skills/<name>/\` (for any project).

---

`;
      const sections = [];
      for (const s of skills) {
        const { raw, bundle } = await skillDirectoryFiles(s);
        const { frontmatter, body } = parseSkill(raw);
        const aggregateBody = rewriteBundleLinks(body, `skills/${s.name}/`, bundle);
        sections.push(`## ${frontmatter.name ?? s.name}

**Description**: ${frontmatter.description ?? "(none)"}

${aggregateBody}

---
`);
      }
      const wroteAgents = await writeManagedFile(agentsDst, header + sections.join("\n"), {
        force,
        boundary: projectRoot,
      });
      if (wroteAgents) {
        console.log(`[install-skills] wrote ${agentsDst} with ${skills.length} skill(s)`);
      } else {
        console.log(`[install-skills] AGENTS.md appeared concurrently; did not overwrite without --force`);
      }
    }
  }

  console.log(`[install-skills] don't forget to set up MCP: npm run setup -- --client codex (then paste TOML)`);
}

async function installClaudeDesktop(skills) {
  console.log(`[install-skills] Claude Desktop 没有可由本脚本写入的项目级 skill 目录；本命令不会自动安装。`);
  console.log(`[install-skills] 要导入完整 bundle（不能只导入存在 references/scripts/assets 的 SKILL.md）：`);
  console.log(``);
  console.log(`  1. 在 Claude Desktop 创建 Project。`);
  console.log(`  2. 把所选 SKILL.md 全文粘进 Project 的 Custom Instructions。`);
  console.log(`  3. 把该 skill 下列 supporting files 上传到同一 Project Knowledge，保留文件名；`);
  console.log(`     若客户端不能按相对路径读取 Project Knowledge，就把被引用的 Markdown 全文追加到 Custom Instructions。`);
  console.log(`  4. 缺少任一被引用文件时，该 skill bundle 不完整，不应声称可直接运行。`);
  console.log(``);
  for (const s of skills) {
    const bundle = await readSkillBundle(s.dir);
    console.log(`  - ${s.name}`);
    console.log(`      Custom Instructions: ${s.path}`);
    if (bundle.length === 0) {
      console.log(`      Supporting files: (none)`);
    } else {
      console.log(`      Project Knowledge / attachments:`);
      for (const file of bundle) {
        console.log(`        - ${resolve(s.dir, ...file.relativePath.split("/"))}`);
      }
    }
  }
  console.log(``);
  console.log(`  5. MCP servers: npm run setup -- --client claude-desktop  （打印待手动合并的 JSON）`);
}

async function installOpencode(skills, force) {
  const compatBase = resolve(projectRoot, ".claude/skills");
  const globalOpencodeSkillsDir = process.platform === "win32"
    ? resolve(process.env.APPDATA || resolve(homedir(), "AppData/Roaming"), "opencode/skills")
    : resolve(homedir(), ".config/opencode/skills");

  const written = [];
  const skippedCompat = [];
  const skippedExists = [];

  for (const s of skills) {
    const claudeSkillDir = resolve(compatBase, s.name);
    const claudeSkillExists = await inspectManagedDirectory(claudeSkillDir, projectRoot);

    if (claudeSkillExists) {
      const { files } = await skillDirectoryFiles(s);
      if (!(await managedDirectoryMatches(claudeSkillDir, files, projectRoot))) {
        throw new Error(
          `OpenCode 拒绝复用不完整或过期的 Claude skill bundle：${claudeSkillDir}；`
          + `请先运行 npm run install:skills -- --force`,
        );
      }
      skippedCompat.push(s.name);
      continue;
    }

    // Claude doesn't have it, copy to global OpenCode skills
    const targetDir = resolve(globalOpencodeSkillsDir, s.name);
    const boundary = process.platform === "win32"
      ? resolve(process.env.APPDATA || resolve(homedir(), "AppData/Roaming"))
      : homedir();
    if (!(await installSkillDirectory(s, targetDir, {
      force,
      boundary,
      mode: 0o600,
    }))) {
      skippedExists.push(targetDir);
      continue;
    }
    written.push(resolve(targetDir, "SKILL.md"));
  }

  if (skippedCompat.length) {
    console.log(`[install-skills] Skipped copying these skills to global OpenCode skills because they are already present in Claude's project skills (.claude/skills/):`);
    skippedCompat.forEach((name) => console.log(`  - ${name}`));
  }
  if (skippedExists.length) {
    console.log(`[install-skills] Skipped copying these skills to global OpenCode skills because they already exist:`);
    skippedExists.forEach((p) => console.log(`  - ${p} (use --force to overwrite)`));
  }
  if (written.length) {
    console.log(`[install-skills] Wrote ${written.length} skill(s) globally for OpenCode:`);
    written.forEach((p) => console.log(`  - ${p}`));
  }
}

async function installAntigravity(skills, force) {
  const targetBase = resolve(homedir(), ".gemini/config/skills");
  const written = [];
  for (const s of skills) {
    const targetDir = resolve(targetBase, s.name);
    if (!(await installSkillDirectory(s, targetDir, {
      force,
      boundary: homedir(),
      mode: 0o600,
    }))) {
      console.error(`[install-skills] skip whole skill (target exists): ${targetDir} — use --force to synchronize`);
      continue;
    }
    written.push(resolve(targetDir, "SKILL.md"));
  }
  console.log(`[install-skills] wrote ${written.length} skill(s) for antigravity:`);
  written.forEach((p) => console.log(`  - ${p}`));
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[install-skills] ${error.message}`);
    usage();
    process.exitCode = 2;
    return;
  }
  const { client, force, global, help } = parsed;
  if (help) {
    usage();
    return;
  }
  if (!SUPPORTED_CLIENTS.includes(client)) {
    console.error(`[install-skills] unknown --client "${client}". Supported: ${SUPPORTED_CLIENTS.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  const skills = await listSkills();
  if (skills.length === 0) {
    console.error(`[install-skills] no skills found under ${skillsDir}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[install-skills] client=${client}, ${skills.length} skill(s): ${skills.map((s) => s.name).join(", ")}`);
  if (client === "claude-code") await installClaudeCode(skills, force);
  else if (client === "cursor") await installCursor(skills, force);
  else if (client === "codex") await installCodex(skills, force, global);
  else if (client === "claude-desktop") await installClaudeDesktop(skills);
  else if (client === "opencode") await installOpencode(skills, force);
  else if (client === "antigravity") await installAntigravity(skills, force);
}

main().catch((err) => {
  console.error("[install-skills] failed:", err);
  process.exit(1);
});
