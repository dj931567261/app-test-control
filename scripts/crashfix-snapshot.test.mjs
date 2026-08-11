import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";

import {
  AsyncByteReader,
  DEFAULT_LIMITS,
  materializeReleaseSnapshot,
  parseReleaseTree,
  validateSnapshotPath,
} from "../skills/crashfix/scripts/materialize-release-snapshot.mjs";

const execFileAsync = promisify(execFile);

async function git(repo, ...args) {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

async function createRepo() {
  const repo = await mkdtemp(path.join(os.tmpdir(), "crashfix-snapshot-repo-"));
  await git(repo, "init", "--quiet");
  await git(repo, "config", "user.email", "snapshot@example.invalid");
  await git(repo, "config", "user.name", "Snapshot Test");
  return repo;
}

async function commitAll(repo, message = "fixture") {
  await git(repo, "add", "--all");
  await git(repo, "commit", "--quiet", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

async function removeSealedRoot(root) {
  const makeWritable = async (entry) => {
    const value = await lstat(entry);
    if (!value.isDirectory()) return;
    await chmod(entry, 0o700);
    for (const child of await readdir(entry)) await makeWritable(path.join(entry, child));
  };
  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
}

test("AsyncByteReader preserves headers and blobs across chunk boundaries", async () => {
  const firstOid = "a".repeat(40);
  const secondOid = "b".repeat(40);
  const firstBlob = Buffer.from("first payload with an embedded\nnewline", "utf8");
  const secondBlob = Buffer.from("second payload", "utf8");
  const wire = Buffer.concat([
    Buffer.from(`${firstOid} blob ${firstBlob.byteLength}\n`, "ascii"),
    firstBlob,
    Buffer.from("\n", "ascii"),
    Buffer.from(`${secondOid} blob ${secondBlob.byteLength}\n`, "ascii"),
    secondBlob,
    Buffer.from("\n", "ascii"),
  ]);
  const chunks = splitBuffer(wire, [1, 2, 3, 5, 8, 13]);
  const reader = new AsyncByteReader({
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  });

  assert.equal(await reader.readLine(), `${firstOid} blob ${firstBlob.byteLength}`);
  assert.deepEqual(await reader.readExact(firstBlob.byteLength), firstBlob);
  assert.equal((await reader.readExact(1))[0], 0x0a);
  assert.equal(await reader.readLine(), `${secondOid} blob ${secondBlob.byteLength}`);
  assert.deepEqual(await reader.readExact(secondBlob.byteLength), secondBlob);
  assert.equal((await reader.readExact(1))[0], 0x0a);
  await assert.rejects(reader.readLine(), /ended before its header/i);
});

test("materializes committed object bytes into a private tracked-only snapshot", async (t) => {
  const repo = await createRepo();
  t.after(async () => rm(repo, { recursive: true, force: true }));
  await writeFile(path.join(repo, "Main.kt"), "fun committed() = 1\n", "utf8");
  await writeFile(path.join(repo, "script.sh"), "#!/bin/sh\necho committed\n", "utf8");
  await chmod(path.join(repo, "script.sh"), 0o755);
  const commit = await commitAll(repo);

  await writeFile(path.join(repo, "Main.kt"), "fun dirty() = 2\n", "utf8");
  await writeFile(path.join(repo, "untracked.secret"), "must not appear\n", "utf8");

  const result = await materializeReleaseSnapshot({ repo, commit, forbidRoot: repo });
  const privateRoot = path.dirname(result.snapshot_dir);
  t.after(async () => removeSealedRoot(privateRoot));

  assert.equal(result.schema_version, "crashfix-release-snapshot/v1");
  assert.equal(result.commit, commit);
  assert.equal(result.files, 2);
  assert.match(result.manifest_sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    await readFile(path.join(result.snapshot_dir, "Main.kt"), "utf8"),
    "fun committed() = 1\n",
  );
  await assert.rejects(readFile(path.join(result.snapshot_dir, "untracked.secret")), /ENOENT/);
  assert.equal((await stat(privateRoot)).mode & 0o077, 0);
  assert.equal((await stat(path.join(result.snapshot_dir, "Main.kt"))).mode & 0o077, 0);
  assert.equal((await stat(result.snapshot_dir)).mode & 0o777, 0o500);
  assert.equal((await stat(path.join(result.snapshot_dir, "Main.kt"))).mode & 0o777, 0o400);
  assert.equal((await stat(path.join(result.snapshot_dir, "script.sh"))).mode & 0o777, 0o500);
});

test("materializes a blob near the per-file limit across cat-file chunks", async (t) => {
  const repo = await createRepo();
  t.after(async () => rm(repo, { recursive: true, force: true }));
  const blobBytes = DEFAULT_LIMITS.maxFileBytes - 257;
  const content = Buffer.alloc(blobBytes, "0123456789abcdef");
  await writeFile(path.join(repo, "Large.bin"), content);
  const commit = await commitAll(repo, "large blob fixture");

  const result = await materializeReleaseSnapshot({ repo, commit });
  const privateRoot = path.dirname(result.snapshot_dir);
  t.after(async () => removeSealedRoot(privateRoot));
  const materialized = await readFile(path.join(result.snapshot_dir, "Large.bin"));

  assert.equal(result.files, 1);
  assert.equal(result.bytes, blobBytes);
  assert.equal(materialized.byteLength, blobBytes);
  assert.equal(sha256(materialized), sha256(content));
});

test("rejects tracked symlinks and Git LFS pointers", async (t) => {
  const symlinkRepo = await createRepo();
  const lfsRepo = await createRepo();
  t.after(async () => {
    await rm(symlinkRepo, { recursive: true, force: true });
    await rm(lfsRepo, { recursive: true, force: true });
  });

  await writeFile(path.join(symlinkRepo, "target.txt"), "safe\n", "utf8");
  await symlink("target.txt", path.join(symlinkRepo, "escape-link"));
  const symlinkCommit = await commitAll(symlinkRepo);
  await assert.rejects(
    materializeReleaseSnapshot({ repo: symlinkRepo, commit: symlinkCommit }),
    /symlink, submodule, or other unsupported entry/i,
  );

  await writeFile(
    path.join(lfsRepo, "Large.kt"),
    "version https://git-lfs.github.com/spec/v1\n"
      + "oid sha256:0000000000000000000000000000000000000000000000000000000000000000\n"
      + "size 10\n",
    "utf8",
  );
  const lfsCommit = await commitAll(lfsRepo);
  await assert.rejects(
    materializeReleaseSnapshot({ repo: lfsRepo, commit: lfsCommit }),
    /Git LFS pointer/i,
  );
});

test("ignores Git replace refs and rejects blob bytes that do not match their object id", async (t) => {
  const replaceRepo = await createRepo();
  const corruptRepo = await createRepo();
  t.after(async () => {
    await rm(replaceRepo, { recursive: true, force: true });
    await rm(corruptRepo, { recursive: true, force: true });
  });

  await writeFile(path.join(replaceRepo, "original.txt"), "original\n", "utf8");
  const originalCommit = await commitAll(replaceRepo, "original");
  await rm(path.join(replaceRepo, "original.txt"));
  await writeFile(path.join(replaceRepo, "replacement.txt"), "replacement\n", "utf8");
  const replacementCommit = await commitAll(replaceRepo, "replacement");
  await git(replaceRepo, "replace", originalCommit, replacementCommit);

  const materialized = await materializeReleaseSnapshot({ repo: replaceRepo, commit: originalCommit });
  const materializedRoot = path.dirname(materialized.snapshot_dir);
  t.after(async () => removeSealedRoot(materializedRoot));
  assert.equal(
    await readFile(path.join(materialized.snapshot_dir, "original.txt"), "utf8"),
    "original\n",
  );
  await assert.rejects(
    readFile(path.join(materialized.snapshot_dir, "replacement.txt")),
    /ENOENT/,
  );

  await writeFile(path.join(corruptRepo, "Main.kt"), "AAAA\n", "utf8");
  const corruptCommit = await commitAll(corruptRepo, "corrupt fixture");
  const blobOid = await git(corruptRepo, "rev-parse", `${corruptCommit}:Main.kt`);
  const objectPath = path.join(
    corruptRepo,
    ".git/objects",
    blobOid.slice(0, 2),
    blobOid.slice(2),
  );
  await chmod(objectPath, 0o600);
  const replacement = Buffer.from("BBBB\n", "utf8");
  await writeFile(
    objectPath,
    deflateSync(Buffer.concat([
      Buffer.from(`blob ${replacement.byteLength}\0`, "ascii"),
      replacement,
    ])),
  );
  await assert.rejects(
    materializeReleaseSnapshot({ repo: corruptRepo, commit: corruptCommit }),
    /does not match its immutable blob id/i,
  );
});

test("tree parser fails closed on traversal, collisions, special entries, and budgets", () => {
  assert.throws(
    () => validateSnapshotPath("src/../secret", new Set(), DEFAULT_LIMITS.maxPathChars),
    /traversal or ambiguous/i,
  );
  const seen = new Set();
  validateSnapshotPath("src/Foo.kt", seen, DEFAULT_LIMITS.maxPathChars);
  assert.throws(
    () => validateSnapshotPath("src/foo.kt", seen, DEFAULT_LIMITS.maxPathChars),
    /collision/i,
  );

  const symlinkTree = Buffer.from(
    `120000 blob ${"a".repeat(40)} 6\tlink\0`,
    "utf8",
  );
  assert.throws(() => parseReleaseTree(symlinkTree), /symlink, submodule/i);

  const oversizedTree = Buffer.from(
    `100644 blob ${"b".repeat(40)} 11\tsrc/Main.kt\0`,
    "utf8",
  );
  assert.throws(
    () => parseReleaseTree(oversizedTree, {
      ...DEFAULT_LIMITS,
      maxFileBytes: 10,
      maxTotalBytes: 10,
    }),
    /per-file byte limit/i,
  );
});

function splitBuffer(buffer, sizes) {
  const chunks = [];
  let offset = 0;
  let index = 0;
  while (offset < buffer.byteLength) {
    const end = Math.min(buffer.byteLength, offset + sizes[index % sizes.length]);
    chunks.push(buffer.subarray(offset, end));
    offset = end;
    index += 1;
  }
  return chunks;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
