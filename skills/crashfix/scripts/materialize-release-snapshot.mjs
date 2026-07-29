#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

export const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 20_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxTreeBytes: 64 * 1024 * 1024,
  maxPathChars: 4_096,
});

const COMMIT_RE = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
const TREE_RECORD_RE = /^(\d{6}) (blob|commit) ([0-9a-f]{40}|[0-9a-f]{64}) +(-|\d+)\t([\s\S]+)$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const LFS_PREFIX = "version https://git-lfs.github.com/spec/v1\n";

function fail(message) {
  throw new Error(message);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function validateRepoPath(repo) {
  if (typeof repo !== "string" || !path.isAbsolute(repo) || repo.includes("\0")) {
    fail("--repo must be a bounded absolute path");
  }
  if (repo.length > DEFAULT_LIMITS.maxPathChars) fail("--repo is too long");
}

export function validateSnapshotPath(rawPath, seenPortablePaths, maxPathChars) {
  if (
    rawPath.length === 0
    || rawPath.length > maxPathChars
    || rawPath.startsWith("/")
    || rawPath.includes("\\")
    || CONTROL_RE.test(rawPath)
  ) {
    fail("release tree contains an unsafe path");
  }
  const segments = rawPath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("release tree contains a traversal or ambiguous path segment");
  }
  const portableKey = rawPath.normalize("NFC").toLocaleLowerCase("en-US");
  if (seenPortablePaths.has(portableKey)) {
    fail("release tree contains a case-insensitive or Unicode-normalized path collision");
  }
  seenPortablePaths.add(portableKey);
  return rawPath;
}

export function parseReleaseTree(buffer, limits = DEFAULT_LIMITS) {
  if (!Buffer.isBuffer(buffer)) fail("git ls-tree output must be bytes");
  if (buffer.byteLength > limits.maxTreeBytes) fail("release tree metadata exceeds byte limit");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const seenPortablePaths = new Set();
  const entries = [];
  let totalBytes = 0;
  for (const rawRecord of buffer.subarray(0, buffer.at(-1) === 0 ? -1 : undefined).toString("binary").split("\0")) {
    let record;
    try {
      record = decoder.decode(Buffer.from(rawRecord, "binary"));
    } catch {
      fail("release tree contains a non-UTF-8 path");
    }
    const match = TREE_RECORD_RE.exec(record);
    if (!match) fail("git ls-tree returned an unsupported record");
    const [, mode, type, oid, rawSize, rawPath] = match;
    if ((mode !== "100644" && mode !== "100755") || type !== "blob" || rawSize === "-") {
      fail("release tree contains a symlink, submodule, or other unsupported entry");
    }
    const size = Number(rawSize);
    if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileBytes) {
      fail("release tree contains a file outside the per-file byte limit");
    }
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
      fail("release tree exceeds the aggregate byte limit");
    }
    if (entries.length >= limits.maxFiles) fail("release tree exceeds the file-count limit");
    const safePath = validateSnapshotPath(rawPath, seenPortablePaths, limits.maxPathChars);
    entries.push({ mode, oid, size, path: safePath });
  }
  if (entries.length === 0) fail("release tree has no materializable files");
  return { entries, totalBytes };
}

async function runGit(repo, args, maxBytes) {
  const child = spawn("git", ["-C", repo, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > maxBytes) child.kill("SIGKILL");
    else stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes <= 64 * 1024) stderr.push(chunk);
  });
  const [code, signal] = await once(child, "exit");
  if (stdoutBytes > maxBytes) fail("git output exceeded the configured byte limit");
  if (code !== 0) {
    const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 1_024);
    fail(`git ${args[0]} failed (${code ?? signal})${detail ? `: ${detail}` : ""}`);
  }
  return Buffer.concat(stdout);
}

export class AsyncByteReader {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.chunks = [];
    this.chunkIndex = 0;
    this.headOffset = 0;
    this.bufferedBytes = 0;
    this.ended = false;
  }

  async fill(minimum) {
    while (this.bufferedBytes < minimum && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) this.ended = true;
      else {
        const chunk = Buffer.isBuffer(next.value)
          ? next.value
          : Buffer.from(next.value);
        if (chunk.byteLength > 0) {
          this.chunks.push(chunk);
          this.bufferedBytes += chunk.byteLength;
        }
      }
    }
  }

  async readExact(bytes) {
    await this.fill(bytes);
    if (this.bufferedBytes < bytes) fail("git cat-file ended before the declared object size");
    if (bytes === 0) return Buffer.alloc(0);

    const head = this.chunks[this.chunkIndex];
    const headBytes = head.byteLength - this.headOffset;
    if (headBytes >= bytes) {
      const value = head.subarray(this.headOffset, this.headOffset + bytes);
      this.consume(bytes);
      return value;
    }

    // A blob spanning stream chunks is copied exactly once into its final
    // buffer. Keeping chunks queued avoids repeatedly copying all prior bytes
    // on every stdout event, which made large blobs quadratic.
    const value = Buffer.allocUnsafe(bytes);
    let written = 0;
    while (written < bytes) {
      const chunk = this.chunks[this.chunkIndex];
      const available = chunk.byteLength - this.headOffset;
      const copyBytes = Math.min(available, bytes - written);
      chunk.copy(
        value,
        written,
        this.headOffset,
        this.headOffset + copyBytes,
      );
      written += copyBytes;
      this.consume(copyBytes);
    }
    return value;
  }

  async readLine(maxBytes = 512) {
    while (true) {
      const newline = this.indexOf(0x0a);
      if (newline >= 0) {
        if (newline > maxBytes) fail("git cat-file header exceeded byte limit");
        const value = (await this.readExact(newline)).toString("ascii");
        await this.readExact(1);
        return value;
      }
      if (this.bufferedBytes > maxBytes) fail("git cat-file header exceeded byte limit");
      const before = this.bufferedBytes;
      await this.fill(before + 1);
      if (this.ended && this.bufferedBytes === before) fail("git cat-file ended before its header");
    }
  }

  indexOf(byte) {
    let distance = 0;
    for (let index = this.chunkIndex; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index];
      const start = index === this.chunkIndex ? this.headOffset : 0;
      const found = chunk.indexOf(byte, start);
      if (found >= 0) return distance + found - start;
      distance += chunk.byteLength - start;
    }
    return -1;
  }

  consume(bytes) {
    let remaining = bytes;
    while (remaining > 0) {
      const chunk = this.chunks[this.chunkIndex];
      const available = chunk.byteLength - this.headOffset;
      const consumed = Math.min(available, remaining);
      this.headOffset += consumed;
      this.bufferedBytes -= consumed;
      remaining -= consumed;
      if (this.headOffset === chunk.byteLength) {
        this.chunkIndex += 1;
        this.headOffset = 0;
      }
    }

    if (this.chunkIndex === this.chunks.length) {
      this.chunks = [];
      this.chunkIndex = 0;
    } else if (this.chunkIndex >= 1_024 && this.chunkIndex * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.chunkIndex);
      this.chunkIndex = 0;
    }
  }
}

async function writeBatchSnapshot(repo, snapshotDir, entries) {
  const child = spawn("git", ["-C", repo, "cat-file", "--batch"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
  });
  const reader = new AsyncByteReader(child.stdout);
  const exitPromise = once(child, "exit");
  try {
    for (const entry of entries) {
      if (!child.stdin.write(`${entry.oid}\n`, "ascii")) await once(child.stdin, "drain");
      const header = await reader.readLine();
      const expectedHeader = `${entry.oid} blob ${entry.size}`;
      if (header !== expectedHeader) fail("git cat-file returned unexpected object identity");
      const content = await reader.readExact(entry.size);
      const terminator = await reader.readExact(1);
      if (terminator[0] !== 0x0a) fail("git cat-file object was not newline-terminated");
      if (content.subarray(0, LFS_PREFIX.length).toString("utf8") === LFS_PREFIX) {
        fail("release tree contains a Git LFS pointer instead of immutable file content");
      }
      const destination = path.resolve(snapshotDir, ...entry.path.split("/"));
      if (!isInside(snapshotDir, destination)) fail("snapshot destination escaped its private root");
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, content, { flag: "wx", mode: 0o600 });
    }
    child.stdin.end();
    const [code, signal] = await exitPromise;
    if (code !== 0) fail(`git cat-file failed (${code ?? signal}): ${stderr.trim().slice(0, 1_024)}`);
  } catch (error) {
    child.stdin.destroy();
    child.kill("SIGKILL");
    await exitPromise.catch(() => undefined);
    throw error;
  }
}

function manifestDigest(entries) {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.mode).update("\0");
    hash.update(entry.oid).update("\0");
    hash.update(String(entry.size)).update("\0");
    hash.update(entry.path).update("\0");
  }
  return hash.digest("hex");
}

export async function materializeReleaseSnapshot({
  repo,
  commit,
  forbidRoot,
  limits = DEFAULT_LIMITS,
} = {}) {
  validateRepoPath(repo);
  if (typeof commit !== "string" || !COMMIT_RE.test(commit)) {
    fail("--commit must be a full 40- or 64-character hexadecimal commit id");
  }
  const canonicalRepo = await realpath(repo);
  if (!(await stat(canonicalRepo)).isDirectory()) fail("--repo must resolve to a directory");
  const resolved = (await runGit(
    canonicalRepo,
    ["rev-parse", "--verify", `${commit}^{commit}`],
    1_024,
  )).toString("ascii").trim();
  if (resolved !== commit.toLowerCase()) fail("--commit did not resolve to the exact immutable id");

  const tree = await runGit(
    canonicalRepo,
    ["ls-tree", "-r", "-z", "-l", "--full-tree", resolved],
    limits.maxTreeBytes,
  );
  const { entries, totalBytes } = parseReleaseTree(tree, limits);

  const privateRoot = await mkdtemp(path.join(tmpdir(), "app-test-ctrl-crashfix-"));
  await chmod(privateRoot, 0o700);
  const canonicalPrivateRoot = await realpath(privateRoot);
  const snapshotDir = path.join(canonicalPrivateRoot, "snapshot");
  try {
    await mkdir(snapshotDir, { mode: 0o700 });
    if (forbidRoot !== undefined) {
      if (typeof forbidRoot !== "string" || !path.isAbsolute(forbidRoot)) {
        fail("--forbid-root must be an absolute path");
      }
      const canonicalForbidden = await realpath(forbidRoot);
      if (isInside(canonicalForbidden, snapshotDir)) {
        fail("private snapshot must stay outside the forbidden session/viewer root");
      }
    }
    await writeFile(
      path.join(privateRoot, ".owner.json"),
      `${JSON.stringify({ schema: "crashfix-snapshot-owner/v1", commit: resolved })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await writeBatchSnapshot(canonicalRepo, snapshotDir, entries);
    return {
      schema_version: "crashfix-release-snapshot/v1",
      commit: resolved,
      snapshot_dir: snapshotDir,
      manifest_sha256: manifestDigest(entries),
      files: entries.length,
      bytes: totalBytes,
      cleanup_requires_confirmation: true,
    };
  } catch (error) {
    await rm(privateRoot, { recursive: true, force: true });
    throw error;
  }
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name !== "--repo" && name !== "--commit" && name !== "--forbid-root") {
      fail(`unsupported argument: ${name}`);
    }
    const value = argv[index + 1];
    if (value === undefined) fail(`${name} requires a value`);
    index += 1;
    if (name === "--repo") result.repo = value;
    else if (name === "--commit") result.commit = value;
    else result.forbidRoot = value;
  }
  return result;
}

async function main() {
  const result = await materializeReleaseSnapshot(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isEntryPoint = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((error) => {
    process.stderr.write(`materialize-release-snapshot: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
