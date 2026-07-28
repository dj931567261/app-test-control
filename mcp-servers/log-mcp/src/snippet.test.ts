import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";

import {
  MAX_SNIPPET_LINE_BYTES,
  MAX_SNIPPET_OUTPUT_BYTES,
  MAX_SNIPPET_SOURCE_BYTES,
  saveSnippetFromFile,
  saveSnippetFromText,
} from "./snippet.js";

const execFileAsync = promisify(execFile);

test("saveSnippetFromFile streams a large source and keeps only the requested tail", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-snippet-tail-"));
  const source = path.join(temp, "capture.log");
  const output = path.join(temp, "snippet.log");
  try {
    const lines = Array.from(
      { length: 8_000 },
      (_, index) => `${String(index).padStart(5, "0")}:${"x".repeat(1_000)}\n`,
    );
    await writeFile(source, lines.join(""), { mode: 0o600 });
    const saved = await saveSnippetFromFile({
      captureFile: source,
      outPath: output,
      lastLines: 3,
    });

    assert.equal(saved.sourceBytes > MAX_SNIPPET_OUTPUT_BYTES, true);
    assert.equal(saved.selectedLines, 3);
    assert.equal(saved.truncated, false);
    assert.equal(
      await readFile(saved.outPath, "utf8"),
      lines.slice(-3).join(""),
    );
    assert.equal((await stat(saved.outPath)).mode & 0o777, 0o600);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("saveSnippetFromFile rejects symlink, hardlink, FIFO, and oversized sources", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-snippet-source-"));
  const source = path.join(temp, "source.log");
  const output = path.join(temp, "snippet.log");
  try {
    await writeFile(source, "safe\n", { mode: 0o600 });
    await symlink(source, path.join(temp, "linked.log"));
    await assert.rejects(
      saveSnippetFromFile({
        captureFile: path.join(temp, "linked.log"),
        outPath: output,
      }),
      /ELOOP|symbolic|single-link regular/i,
    );

    await link(source, path.join(temp, "hardlinked.log"));
    await assert.rejects(
      saveSnippetFromFile({ captureFile: source, outPath: output }),
      /single-link regular/i,
    );
    await unlink(path.join(temp, "hardlinked.log"));

    const fifo = path.join(temp, "blocked.log");
    await execFileAsync("mkfifo", [fifo]);
    await assert.rejects(
      saveSnippetFromFile({ captureFile: fifo, outPath: output }),
      /single-link regular/i,
    );

    const oversizedPath = path.join(temp, "oversized.log");
    const oversized = await open(oversizedPath, "w", 0o600);
    await oversized.truncate(MAX_SNIPPET_SOURCE_BYTES + 1);
    await oversized.close();
    await assert.rejects(
      saveSnippetFromFile({ captureFile: oversizedPath, outPath: output }),
      /exceeds .* byte safety limit/i,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("snippet selection bounds unfiltered output and reports byte-truncated tails", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-snippet-bounds-"));
  try {
    await assert.rejects(
      saveSnippetFromText({
        content: "x".repeat(MAX_SNIPPET_LINE_BYTES + 1),
        outPath: path.join(temp, "long-line.log"),
      }),
      /line exceeds .* byte safety limit/i,
    );

    const large = `${"a".repeat(1_000)}\n`.repeat(
      Math.ceil(MAX_SNIPPET_OUTPUT_BYTES / 1_001) + 2,
    );
    await assert.rejects(
      saveSnippetFromText({
        content: large,
        outPath: path.join(temp, "too-large.log"),
      }),
      /exceeds .* narrow it/i,
    );

    const saved = await saveSnippetFromText({
      content: large,
      outPath: path.join(temp, "tail.log"),
      lastLines: 10_000,
    });
    assert.equal(saved.bytes <= MAX_SNIPPET_OUTPUT_BYTES, true);
    assert.equal(saved.truncated, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("snippet output rejects symlink/hardlink victims and atomically secures legacy files", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-snippet-output-"));
  const victim = path.join(temp, "victim.log");
  const output = path.join(temp, "snippet.log");
  try {
    await writeFile(victim, "victim\n", { mode: 0o600 });
    await symlink(victim, output);
    await assert.rejects(
      saveSnippetFromText({ content: "capture\n", outPath: output }),
      /unsafe existing snippet output/i,
    );
    assert.equal(await readFile(victim, "utf8"), "victim\n");
    await unlink(output);

    await link(victim, output);
    await assert.rejects(
      saveSnippetFromText({ content: "capture\n", outPath: output }),
      /unsafe existing snippet output/i,
    );
    assert.equal(await readFile(victim, "utf8"), "victim\n");
    await unlink(output);

    await writeFile(output, "legacy\n", { mode: 0o644 });
    await chmod(output, 0o644);
    const saved = await saveSnippetFromText({
      content: "capture\n",
      outPath: output,
    });
    assert.equal(await readFile(saved.outPath, "utf8"), "capture\n");
    assert.equal((await stat(saved.outPath)).mode & 0o777, 0o600);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("snippet output cannot overwrite its capture source", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-snippet-alias-"));
  const source = path.join(temp, "capture.log");
  try {
    await writeFile(source, "preserve\n", { mode: 0o600 });
    await assert.rejects(
      saveSnippetFromFile({ captureFile: source, outPath: source }),
      /must not alias capture_file/i,
    );
    assert.equal(await readFile(source, "utf8"), "preserve\n");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("snippet output rejects symlink and unsafe writable parent directories", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-snippet-parent-"));
  try {
    const realParent = path.join(temp, "real-parent");
    const linkedParent = path.join(temp, "linked-parent");
    await mkdir(realParent);
    await symlink(realParent, linkedParent);
    await assert.rejects(
      saveSnippetFromText({
        content: "capture\n",
        outPath: path.join(linkedParent, "snippet.log"),
      }),
      /must not be a symbolic link/,
    );

    const unsafeParent = path.join(temp, "unsafe-parent");
    await mkdir(unsafeParent);
    await chmod(unsafeParent, 0o777);
    await assert.rejects(
      saveSnippetFromText({
        content: "capture\n",
        outPath: path.join(unsafeParent, "child", "snippet.log"),
      }),
      /group\/world-writable without sticky protection/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
