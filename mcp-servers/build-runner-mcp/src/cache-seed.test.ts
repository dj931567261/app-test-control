import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  disposeGradleCacheSeed,
  sealGradleCache,
  verifyGradleCacheSeed,
} from "./cache-seed.js";
import { GRADLE_ENTRYPOINT } from "./docker-backend.js";

const execFileAsync = promisify(execFile);

async function removeRetained(root: string): Promise<void> {
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
  await rm(root, { recursive: true, force: true });
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "build-runner-gradle-cache-"));
  const moduleDir = path.join(root, "caches/modules-2/files-2.1/com.example/demo/1.0");
  const wrapperDir = path.join(root, "wrapper/dists/gradle-8.8-bin/fixture");
  const wrapperBinDir = path.join(wrapperDir, "gradle-8.8/bin");
  const decoyBinDir = path.join(wrapperDir, "gradle-8.8/tools/bin");
  await mkdir(moduleDir, { recursive: true, mode: 0o700 });
  await mkdir(wrapperBinDir, { recursive: true, mode: 0o700 });
  await mkdir(decoyBinDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(moduleDir, "demo-1.0.jar"), "dependency", { mode: 0o600 });
  await writeFile(path.join(moduleDir, "demo-1.0.jar.part"), "incomplete", { mode: 0o600 });
  await writeFile(path.join(wrapperDir, "gradle-8.8-bin.zip.ok"), "", { mode: 0o600 });
  await writeFile(path.join(wrapperDir, "gradle-8.8-bin.zip.lck"), "lock", { mode: 0o600 });
  await writeFile(path.join(wrapperBinDir, "gradle"), "#!/bin/sh\nprintf wrapper\n", { mode: 0o700 });
  await writeFile(path.join(decoyBinDir, "gradle"), "#!/bin/sh\nprintf decoy\n", { mode: 0o700 });
  await writeFile(path.join(root, "gradle.properties"), "repoPassword=must-not-copy", { mode: 0o600 });
  await mkdir(path.join(root, "init.d"), { mode: 0o700 });
  await writeFile(path.join(root, "init.d/unsafe.gradle"), "throw new Error()", { mode: 0o600 });
  return realpath(root);
}

test("Gradle cache sealer copies only fixed dependency roots and detects drift", async (t) => {
  const source = await fixture();
  t.after(async () => rm(source, { recursive: true, force: true }));
  const sealed = await sealGradleCache(source);
  t.after(async () => removeRetained(sealed.root));

  assert.equal(sealed.files, 4);
  assert.ok(sealed.bytes > 0);
  const verified = await verifyGradleCacheSeed(sealed.root, sealed.manifestSha256);
  assert.equal(verified.manifestSha256, sealed.manifestSha256);
  await assert.rejects(readFile(path.join(sealed.cacheDir, "gradle.properties")), /ENOENT/);
  await assert.rejects(readFile(path.join(sealed.cacheDir, "init.d/unsafe.gradle")), /ENOENT/);
  await assert.rejects(
    readFile(path.join(sealed.cacheDir, "caches/modules-2/files-2.1/com.example/demo/1.0/demo-1.0.jar.part")),
    /ENOENT/,
  );
  await assert.rejects(
    readFile(path.join(sealed.cacheDir, "wrapper/dists/gradle-8.8-bin/fixture/gradle-8.8-bin.zip.lck")),
    /ENOENT/,
  );

  const dependency = path.join(
    sealed.cacheDir,
    "caches/modules-2/files-2.1/com.example/demo/1.0/demo-1.0.jar",
  );
  await chmod(dependency, 0o600);
  await writeFile(dependency, "changed");
  await assert.rejects(
    verifyGradleCacheSeed(sealed.root, sealed.manifestSha256),
    /drift|identity|match|permissions/i,
  );
});

test("Gradle cache sealer rejects unfinished wrapper distributions", async (t) => {
  const source = await fixture();
  t.after(async () => rm(source, { recursive: true, force: true }));
  const incomplete = path.join(source, "wrapper/dists/gradle-9.0-bin/incomplete");
  await mkdir(incomplete, { recursive: true, mode: 0o700 });
  const lock = path.join(incomplete, "gradle-9.0-bin.zip.lck");
  const partial = path.join(incomplete, "gradle-9.0-bin.zip.part");
  await writeFile(lock, "lock", { mode: 0o600 });
  await writeFile(partial, "partial", { mode: 0o600 });

  await assert.rejects(sealGradleCache(source), /wrapper distribution.*incomplete/i);

  await rm(partial);
  await assert.rejects(sealGradleCache(source), /wrapper distribution is incomplete/i);

  await writeFile(path.join(incomplete, "gradle-9.0-bin.zip"), "not-a-proven-distribution", {
    mode: 0o600,
  });
  await assert.rejects(sealGradleCache(source), /wrapper distribution.*incomplete/i);
});

test("Gradle cache sealer permits only the standard completion marker to be empty", async (t) => {
  const source = await fixture();
  t.after(async () => rm(source, { recursive: true, force: true }));
  await writeFile(
    path.join(source, "caches/modules-2/files-2.1/com.example/demo/1.0/empty.pom"),
    "",
    { mode: 0o600 },
  );

  await assert.rejects(sealGradleCache(source), /empty\.pom exceeds its byte limit/i);
});

test("Gradle cache sealer requires a non-empty standard wrapper launcher", async (t) => {
  const source = await fixture();
  t.after(async () => rm(source, { recursive: true, force: true }));
  const falseComplete = path.join(source, "wrapper/dists/gradle-9.1-bin/readme-only");
  await mkdir(path.join(falseComplete, "gradle-9.1"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(falseComplete, "gradle-9.1-bin.zip.ok"), "", { mode: 0o600 });
  await writeFile(path.join(falseComplete, "gradle-9.1/README"), "not a launcher", { mode: 0o600 });

  await assert.rejects(sealGradleCache(source), /wrapper distribution is incomplete/i);
});

test("Gradle entrypoint copies the sealed wrapper into a writable private overlay", async (t) => {
  const source = await fixture();
  t.after(async () => rm(source, { recursive: true, force: true }));
  const sealed = await sealGradleCache(source);
  t.after(async () => removeRetained(sealed.root));
  const root = await mkdtemp(path.join(os.tmpdir(), "build-runner-gradle-overlay-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const overlay = path.join(root, "gradle-home");
  await mkdir(overlay, { mode: 0o700 });

  const assignment = "cache_seed_root=/cache-seed";
  assert.equal(GRADLE_ENTRYPOINT.split(assignment).length, 2);
  const quotedCacheDir = `'${sealed.cacheDir.replaceAll("'", `'"'"'`)}'`;
  const script = GRADLE_ENTRYPOINT.replace(assignment, `cache_seed_root=${quotedCacheDir}`);
  const entrypoint = path.join(root, "entrypoint.sh");
  await writeFile(entrypoint, script, { mode: 0o700 });
  const relativeLauncher = "wrapper/dists/gradle-8.8-bin/fixture/gradle-8.8/bin/gradle";
  const result = await execFileAsync(entrypoint, [
    "/bin/sh",
    "-eu",
    "-c",
    [
      `"$GRADLE_USER_HOME/${relativeLauncher}"`,
      `printf '\\nchanged\\n' >> "$GRADLE_USER_HOME/${relativeLauncher}"`,
      "mkdir \"$GRADLE_USER_HOME/wrapper/dists/gradle-8.8-bin/fixture/generated\"",
      "printf writable > \"$GRADLE_USER_HOME/wrapper/dists/gradle-8.8-bin/fixture/generated/value\"",
    ].join("\n"),
  ], {
    env: {
      GRADLE_USER_HOME: overlay,
      PATH: "/usr/bin:/bin",
    },
    timeout: 10_000,
  });

  assert.match(String(result.stdout), /wrapper/);
  assert.match(await readFile(path.join(overlay, relativeLauncher), "utf8"), /changed/);
  assert.equal(
    await readFile(
      path.join(overlay, "wrapper/dists/gradle-8.8-bin/fixture/generated/value"),
      "utf8",
    ),
    "writable",
  );
  assert.equal(
    await readFile(
      path.join(sealed.cacheDir, "wrapper/dists/gradle-8.8-bin/fixture/gradle-8.8/bin/gradle"),
      "utf8",
    ),
    "#!/bin/sh\nprintf wrapper\n",
  );
  const decoy = "wrapper/dists/gradle-8.8-bin/fixture/gradle-8.8/tools/bin/gradle";
  assert.equal((await lstat(path.join(sealed.cacheDir, relativeLauncher))).mode & 0o777, 0o500);
  assert.equal((await lstat(path.join(sealed.cacheDir, decoy))).mode & 0o777, 0o400);
  assert.equal((await lstat(path.join(overlay, relativeLauncher))).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(overlay, decoy))).mode & 0o777, 0o600);
  const verified = await verifyGradleCacheSeed(sealed.root, sealed.manifestSha256);
  assert.equal(verified.manifestSha256, sealed.manifestSha256);
});

test("Gradle cache sealer rejects credential-like files inside allowlisted roots", async (t) => {
  const source = await fixture();
  t.after(async () => rm(source, { recursive: true, force: true }));
  const forbidden = path.join(source, "caches/modules-2/files-2.1/service-account.json");
  await writeFile(forbidden, "{}", { mode: 0o600 });
  await assert.rejects(sealGradleCache(source), /credential-like/i);
});

test("Gradle cache sealer rejects credentials embedded in dependency metadata", async (t) => {
  const source = await fixture();
  t.after(async () => rm(source, { recursive: true, force: true }));
  const metadata = path.join(source, "caches/modules-2/files-2.1/com.example/demo.pom");
  await writeFile(metadata, "<repository>https://build-user:top-secret@example.invalid/repo</repository>", {
    mode: 0o600,
  });
  await assert.rejects(sealGradleCache(source), /secret material/i);
});

test("retained Gradle cache seed is removed only through verified disposal", async (t) => {
  const source = await fixture();
  t.after(async () => rm(source, { recursive: true, force: true }));
  const sealed = await sealGradleCache(source);
  await disposeGradleCacheSeed(sealed.root, sealed.manifestSha256);
  await assert.rejects(readFile(path.join(sealed.root, ".manifest.json")), /ENOENT/);
});
