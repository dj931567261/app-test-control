import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  QUICK_SOURCE_MAX_FILES,
  readQuickSourceFiles,
} from "./quick-source-reader.js";

describe("readQuickSourceFiles", () => {
  it("reads only approved source files and returns bounded hashes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quick-source-reader-"));
    try {
      await mkdir(path.join(root, "app"), { recursive: true });
      await writeFile(path.join(root, "app", "Main.kt"), "class Main\n");
      const result = await readQuickSourceFiles(root, ["app/Main.kt"]);
      assert.equal(result.schema_version, "quick-source-read/v1");
      assert.equal(result.files.length, 1);
      assert.equal(result.files[0]?.content, "class Main\n");
      assert.match(result.files[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces the three-file budget and rejects traversal/generated/credential paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quick-source-reader-policy-"));
    try {
      await mkdir(path.join(root, "app"), { recursive: true });
      for (const name of ["A.kt", "B.kt", "C.kt", "D.kt"]) {
        await writeFile(path.join(root, "app", name), "class Fixture\n");
      }
      await assert.rejects(
        readQuickSourceFiles(root, ["app/A.kt", "app/B.kt", "app/C.kt", "app/D.kt"]),
        /1-3 files/,
      );
      await assert.rejects(readQuickSourceFiles(root, ["../outside.kt"]), /relative POSIX|inside/);
      await assert.rejects(readQuickSourceFiles(root, ["app/Main.gradle"]), /credential-like|allowlisted/);
      await assert.rejects(readQuickSourceFiles(root, [".env.json"]), /credential-like|allowlisted/);
      assert.equal(QUICK_SOURCE_MAX_FILES, 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinks, hardlinks and credential-like content without returning it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quick-source-reader-links-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "quick-source-reader-outside-"));
    try {
      await mkdir(path.join(root, "app"), { recursive: true });
      await writeFile(path.join(outside, "Outside.kt"), "class Outside\n");
      await symlink(path.join(outside, "Outside.kt"), path.join(root, "app", "Link.kt"));
      await assert.rejects(readQuickSourceFiles(root, ["app/Link.kt"]), /regular file|changed/);

      await writeFile(path.join(root, "app", "Original.kt"), "class Original\n");
      await link(path.join(root, "app", "Original.kt"), path.join(root, "app", "Alias.kt"));
      await assert.rejects(readQuickSourceFiles(root, ["app/Alias.kt"]), /single-link/);

      await writeFile(
        path.join(root, "app", "Embedded.kt"),
        "const val value = \"-----BEGIN PRIVATE KEY-----\"\n",
      );
      await assert.rejects(readQuickSourceFiles(root, ["app/Embedded.kt"]), /credential-like/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
