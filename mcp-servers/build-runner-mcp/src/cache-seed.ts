import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assertSha256, canonicalJson, domainHashJson } from "./canonical.js";
import {
  assertDisjointRoots,
  canonicalOwnedDirectory,
  copyStableRegularFile,
  hashSelectedFiles,
  listFilesRecursively,
  readStableRegularFile,
  type HashedEntry,
} from "./safe-fs.js";

const OWNER_FILE = ".owner.json";
const MANIFEST_FILE = ".manifest.json";
const CACHE_DIR = "cache";
const MAX_FILES = 250_000;
const MAX_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const ALLOWED_ROOTS = ["caches/modules-2", "wrapper/dists"] as const;
const REJECTED_CREDENTIAL_RE = /(?:^|\/)(?:credentials?(?:\.[^/]*)?|service[-_]?account(?:\.[^/]*)?|[^/]+\.(?:pem|key|p12|pfx|jks|keystore))$/i;
const TEXT_METADATA_RE = /\.(?:json|module|pom|properties|txt|xml)$/i;
const HIGH_CONFIDENCE_SECRET_RE = /-----BEGIN [^-]{1,64}PRIVATE KEY-----|(?:password|passwd|client[_-]?secret|private[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9_+./=-]{8,}|<(?:password|passwd|clientSecret|privateKey|accessToken)>[^<\s]{8,}<\/|https?:\/\/[^/@\s:]+:[^/@\s]+@|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/i;
const EPHEMERAL_SUFFIXES = [".lock", ".lck", ".part", ".partial", ".tmp"] as const;

export interface CacheSeedIdentity {
  root: string;
  cacheDir: string;
  manifestSha256: string;
  files: number;
  bytes: number;
}

interface CacheManifest {
  schema_version: "crashfix-gradle-cache-manifest/v1";
  allowed_roots: readonly string[];
  entries: HashedEntry[];
  files: number;
  bytes: number;
  cache_seed_manifest_sha256: string;
}

function isEphemeral(relative: string): boolean {
  const name = path.posix.basename(relative);
  return EPHEMERAL_SUFFIXES.some((suffix) => name.endsWith(suffix))
    || name === "gc.properties"
    || name === ".DS_Store";
}

interface WrapperDistributionPath {
  key: string;
  distribution: string;
  nested: string[];
}

function parseWrapperDistributionPath(relative: string): WrapperDistributionPath | undefined {
  const prefix = "wrapper/dists/";
  if (!relative.startsWith(prefix)) return undefined;
  const segments = relative.slice(prefix.length).split("/");
  if (segments.length < 3) return undefined;
  const [distribution, hash] = segments;
  if (!distribution || !hash) return undefined;
  return {
    key: `${distribution}/${hash}`,
    distribution,
    nested: segments.slice(2),
  };
}

function standardGradleRoot(distribution: string): string | undefined {
  return /^(gradle-[A-Za-z0-9][A-Za-z0-9._+-]*)-(?:bin|all)$/.exec(distribution)?.[1];
}

function isStandardWrapperCompletionMarker(relative: string): boolean {
  const location = parseWrapperDistributionPath(relative);
  const extractedRoot = location ? standardGradleRoot(location.distribution) : undefined;
  return location !== undefined
    && extractedRoot !== undefined
    && location.nested.length === 1
    && location.nested[0] === `${location.distribution}.zip.ok`;
}

function isStandardWrapperLauncher(relative: string): boolean {
  const location = parseWrapperDistributionPath(relative);
  const extractedRoot = location ? standardGradleRoot(location.distribution) : undefined;
  return location !== undefined
    && extractedRoot !== undefined
    && location.nested.length === 3
    && location.nested[0] === extractedRoot
    && location.nested[1] === "bin"
    && location.nested[2] === "gradle";
}

function inspectWrapperSource(files: readonly string[]): Set<string> {
  const groups = new Set<string>();
  for (const file of files) {
    const location = parseWrapperDistributionPath(`wrapper/dists/${file}`);
    if (location) groups.add(location.key);
    const leaf = path.posix.basename(file);
    if (leaf.endsWith(".part") || leaf.endsWith(".partial") || leaf.endsWith(".tmp")) {
      throw new Error(`Gradle wrapper distribution contains an incomplete artifact: ${file}`);
    }
  }
  return groups;
}

function assertCompleteWrapperDistributions(
  entries: readonly HashedEntry[],
  expectedGroups: ReadonlySet<string>,
): void {
  const distributions = new Map<string, {
    completionMarker: boolean;
    launcher: boolean;
  }>();
  for (const entry of entries) {
    const location = parseWrapperDistributionPath(entry.path);
    if (!location) continue;
    const state = distributions.get(location.key) ?? {
      completionMarker: false,
      launcher: false,
    };
    if (isStandardWrapperCompletionMarker(entry.path)) {
      state.completionMarker = true;
    } else if (entry.bytes > 0 && isStandardWrapperLauncher(entry.path)) {
      state.launcher = true;
    }
    distributions.set(location.key, state);
  }
  for (const key of expectedGroups) {
    const state = distributions.get(key);
    if (!state?.completionMarker || !state.launcher) {
      throw new Error(`Gradle wrapper distribution is incomplete: ${key}`);
    }
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function scanAllowed(source: string): Promise<HashedEntry[]> {
  const relativeFiles: string[] = [];
  const wrapperDistributionGroups = new Set<string>();
  for (const allowedRoot of ALLOWED_ROOTS) {
    const absolute = path.join(source, ...allowedRoot.split("/"));
    if (!(await pathExists(absolute))) continue;
    const canonical = await realpath(absolute);
    if (canonical !== absolute) throw new Error(`cache allowlist root traverses a symlink: ${allowedRoot}`);
    const files = await listFilesRecursively(canonical, {
      maxFiles: MAX_FILES,
      maxBytes: MAX_BYTES,
      maxFileBytes: MAX_FILE_BYTES,
    });
    if (allowedRoot === "wrapper/dists") {
      for (const group of inspectWrapperSource(files)) wrapperDistributionGroups.add(group);
    }
    for (const file of files) {
      const relative = `${allowedRoot}/${file}`;
      if (isEphemeral(relative)) continue;
      if (REJECTED_CREDENTIAL_RE.test(relative)) {
        throw new Error(`cache seed contains a forbidden credential-like path: ${relative}`);
      }
      relativeFiles.push(relative);
    }
  }
  if (relativeFiles.length === 0) {
    throw new Error("Gradle cache does not contain allowlisted dependency/wrapper files");
  }
  const hashed = await hashSelectedFiles(source, relativeFiles, {
    maxFiles: MAX_FILES,
    maxTotalBytes: MAX_BYTES,
    maxFileBytes: MAX_FILE_BYTES,
    allowEmpty: isStandardWrapperCompletionMarker,
  });
  assertCompleteWrapperDistributions(hashed, wrapperDistributionGroups);
  for (const entry of hashed) {
    if (!TEXT_METADATA_RE.test(entry.path) || entry.bytes > 1024 * 1024) continue;
    const metadata = await readStableRegularFile(
      path.join(source, ...entry.path.split("/")),
      `cache metadata ${entry.path}`,
      {
        maxBytes: 1024 * 1024,
        allowEmpty: true,
        expectedSize: entry.bytes,
        expectedSha256: entry.sha256,
        capture: true,
      },
    );
    if (HIGH_CONFIDENCE_SECRET_RE.test(metadata.content!.toString("utf8"))) {
      throw new Error(`cache seed contains high-confidence secret material: ${entry.path}`);
    }
  }
  return hashed;
}

function manifestFor(entries: HashedEntry[]): CacheManifest {
  const files = entries.length;
  const bytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  const base = {
    schema_version: "crashfix-gradle-cache-manifest/v1" as const,
    allowed_roots: ALLOWED_ROOTS,
    entries,
    files,
    bytes,
  };
  return {
    ...base,
    cache_seed_manifest_sha256: domainHashJson(
      "crashfix-gradle-cache-seed/v1",
      base,
    ),
  };
}

function manifestsEqual(left: CacheManifest, right: CacheManifest): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

async function copyEntries(source: string, destination: string, entries: readonly HashedEntry[]): Promise<void> {
  for (const entry of entries) {
    const target = path.join(destination, ...entry.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyStableRegularFile({
      source: path.join(source, ...entry.path.split("/")),
      destination: target,
      label: `Gradle cache entry ${entry.path}`,
      maxBytes: MAX_FILE_BYTES,
      expectedSize: entry.bytes,
      expectedSha256: entry.sha256,
      destinationMode: isStandardWrapperLauncher(entry.path) ? 0o700 : 0o600,
      allowEmpty: isStandardWrapperCompletionMarker(entry.path),
    });
  }
}

async function sealTree(root: string): Promise<void> {
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(absolute, relative);
      else await chmod(absolute, isStandardWrapperLauncher(relative) ? 0o500 : 0o400);
    }
    await chmod(directory, 0o500);
  };
  await visit(root, "");
}

async function assertSealedTree(root: string): Promise<void> {
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || (directoryStat.mode & 0o777) !== 0o500) {
      throw new Error("sealed cache directory permissions changed");
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const value = await lstat(absolute);
      if (value.isDirectory()) await visit(absolute, relative);
      else if (
        !value.isFile()
        || value.nlink !== 1
        || (value.mode & 0o777) !== (isStandardWrapperLauncher(relative) ? 0o500 : 0o400)
      ) {
        throw new Error("sealed cache file type or permissions changed");
      }
    }
  };
  await visit(root, "");
}

async function cleanupUnpublishedRoot(root: string): Promise<void> {
  const temporaryRoot = await realpath(os.tmpdir());
  if (
    path.dirname(root) !== temporaryRoot
    || !path.basename(root).startsWith("app-test-ctrl-gradle-seed-")
  ) {
    throw new Error("refusing to clean an unowned cache staging root");
  }
  const makeWritable = async (entry: string): Promise<void> => {
    const value = await lstat(entry);
    if (value.isDirectory()) {
      await chmod(entry, 0o700);
      for (const child of await readdir(entry)) await makeWritable(path.join(entry, child));
    } else if (!value.isSymbolicLink()) {
      await chmod(entry, 0o600);
    }
  };
  await makeWritable(root);
  await rm(root, { recursive: true, force: false });
}

async function readBoundedJson(file: string, maxBytes: number, label: string): Promise<unknown> {
  const before = await lstat(file);
  if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > maxBytes) {
    throw new Error(`${label} is not a bounded regular file`);
  }
  const handle = await open(file, "r");
  try {
    const content = await handle.readFile("utf8");
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
      throw new Error(`${label} changed while reading`);
    }
    return JSON.parse(content) as unknown;
  } finally {
    await handle.close();
  }
}

function validateManifest(value: unknown): CacheManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("cache manifest must be an object");
  }
  const candidate = value as Partial<CacheManifest> & Record<string, unknown>;
  const exactKeys = [
    "allowed_roots", "bytes", "cache_seed_manifest_sha256", "entries", "files", "schema_version",
  ];
  if (canonicalJson(Object.keys(candidate).sort()) !== canonicalJson(exactKeys)) {
    throw new Error("cache manifest has unsupported or missing fields");
  }
  if (candidate.schema_version !== "crashfix-gradle-cache-manifest/v1") {
    throw new Error("unsupported cache manifest schema");
  }
  if (canonicalJson(candidate.allowed_roots) !== canonicalJson(ALLOWED_ROOTS)) {
    throw new Error("cache manifest allowlist does not match the runner");
  }
  if (!Array.isArray(candidate.entries) || candidate.entries.length < 1 || candidate.entries.length > MAX_FILES) {
    throw new Error("cache manifest entries are invalid");
  }
  const entries: HashedEntry[] = [];
  let previous = "";
  let bytes = 0;
  for (const raw of candidate.entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("cache entry is invalid");
    const entry = raw as Partial<HashedEntry> & Record<string, unknown>;
    if (canonicalJson(Object.keys(entry).sort()) !== canonicalJson(["bytes", "path", "sha256"])) {
      throw new Error("cache entry has unsupported fields");
    }
    if (
      typeof entry.path !== "string"
      || entry.path <= previous
      || !ALLOWED_ROOTS.some((root) => entry.path!.startsWith(`${root}/`))
      || isEphemeral(entry.path)
      || REJECTED_CREDENTIAL_RE.test(entry.path)
    ) {
      throw new Error("cache entry path is invalid or unsorted");
    }
    if (!Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0 || (entry.bytes as number) > MAX_FILE_BYTES) {
      throw new Error("cache entry byte count is invalid");
    }
    if (typeof entry.sha256 !== "string") throw new Error("cache entry hash is invalid");
    assertSha256(entry.sha256, "cache entry hash");
    previous = entry.path;
    bytes += entry.bytes as number;
    entries.push({ path: entry.path, bytes: entry.bytes as number, sha256: entry.sha256 });
  }
  if (candidate.files !== entries.length || candidate.bytes !== bytes || bytes > MAX_BYTES) {
    throw new Error("cache manifest counts do not match entries");
  }
  const recomputed = manifestFor(entries);
  if (candidate.cache_seed_manifest_sha256 !== recomputed.cache_seed_manifest_sha256) {
    throw new Error("cache manifest identity mismatch");
  }
  return recomputed;
}

export async function sealGradleCache(sourceGradleHome: string): Promise<CacheSeedIdentity> {
  const source = await canonicalOwnedDirectory(sourceGradleHome, "Gradle cache source");
  const first = manifestFor(await scanAllowed(source));
  const privateRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "app-test-ctrl-gradle-seed-")));
  await chmod(privateRoot, 0o700);
  assertDisjointRoots([source, privateRoot]);
  const cacheDir = path.join(privateRoot, CACHE_DIR);
  try {
    await mkdir(cacheDir, { mode: 0o700 });
    await copyEntries(source, cacheDir, first.entries);
    const sourceAfter = manifestFor(await scanAllowed(source));
    if (!manifestsEqual(first, sourceAfter)) {
      throw new Error("Gradle cache changed while the seed was being sealed");
    }
    const copied = manifestFor(await scanAllowed(cacheDir));
    if (!manifestsEqual(first, copied)) throw new Error("sealed cache copy does not match its source");
    await sealTree(cacheDir);
    const owner = {
      schema_version: "crashfix-gradle-cache-owner/v1",
      kind: "sealed-gradle-cache",
      cache_seed_manifest_sha256: first.cache_seed_manifest_sha256,
    };
    await writeFile(path.join(privateRoot, OWNER_FILE), `${canonicalJson(owner)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    const manifestJson = `${canonicalJson(first)}\n`;
    if (Buffer.byteLength(manifestJson, "utf8") > MAX_MANIFEST_BYTES) {
      throw new Error("cache manifest exceeds its byte limit");
    }
    await writeFile(path.join(privateRoot, MANIFEST_FILE), manifestJson, { mode: 0o600, flag: "wx" });
    return {
      root: privateRoot,
      cacheDir,
      manifestSha256: first.cache_seed_manifest_sha256,
      files: first.files,
      bytes: first.bytes,
    };
  } catch (error) {
    await cleanupUnpublishedRoot(privateRoot);
    throw error;
  }
}

export async function verifyGradleCacheSeed(
  rootInput: string,
  expectedManifestSha256: string,
): Promise<CacheSeedIdentity> {
  assertSha256(expectedManifestSha256, "expected cache seed hash");
  const root = await canonicalOwnedDirectory(rootInput, "Gradle cache seed root", { exactMode: 0o700 });
  const cacheDir = await canonicalOwnedDirectory(path.join(root, CACHE_DIR), "sealed Gradle cache", {
    exactMode: 0o500,
  });
  if (path.dirname(cacheDir) !== root) throw new Error("sealed Gradle cache escaped its private root");
  const owner = await readBoundedJson(path.join(root, OWNER_FILE), 64 * 1024, "cache owner");
  const manifest = validateManifest(await readBoundedJson(
    path.join(root, MANIFEST_FILE),
    MAX_MANIFEST_BYTES,
    "cache manifest",
  ));
  if (
    !owner
    || typeof owner !== "object"
    || Array.isArray(owner)
    || canonicalJson(Object.keys(owner).sort()) !== canonicalJson([
      "cache_seed_manifest_sha256", "kind", "schema_version",
    ])
  ) {
    throw new Error("cache owner is invalid");
  }
  const ownerRecord = owner as Record<string, unknown>;
  if (
    ownerRecord.schema_version !== "crashfix-gradle-cache-owner/v1"
    || ownerRecord.kind !== "sealed-gradle-cache"
    || ownerRecord.cache_seed_manifest_sha256 !== manifest.cache_seed_manifest_sha256
    || manifest.cache_seed_manifest_sha256 !== expectedManifestSha256
  ) {
    throw new Error("cache owner/manifest identity mismatch");
  }
  await assertSealedTree(cacheDir);
  const actual = manifestFor(await scanAllowed(cacheDir));
  if (!manifestsEqual(manifest, actual)) throw new Error("sealed Gradle cache content drifted");
  return {
    root,
    cacheDir,
    manifestSha256: manifest.cache_seed_manifest_sha256,
    files: manifest.files,
    bytes: manifest.bytes,
  };
}

export async function disposeGradleCacheSeed(
  root: string,
  expectedManifestSha256: string,
): Promise<void> {
  await verifyGradleCacheSeed(root, expectedManifestSha256);
  await cleanupUnpublishedRoot(root);
}
