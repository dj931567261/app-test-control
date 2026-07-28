import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";

import {
  copyIpsFiles,
  listIpsFiles,
  listIpsFilesWithMeta,
  MAX_IPS_COPY_FILES,
  MAX_IPS_FILE_BYTES,
  MAX_IPS_HEADER_BYTES,
  MAX_IPS_RESULTS,
  type IpsFileSummary,
} from "./ips.js";

const execFileAsync = promisify(execFile);

function ipsContent(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    name: "FixtureApp",
    bundleID: "com.example.fixture",
    timestamp: "2026-07-28 10:00:00.00 +0800",
    bug_type: "309",
    os_version: "iPhone OS 18.0",
    ...overrides,
  })}\n{"payload":"body"}\n`;
}

test("listIpsFiles reads only bounded regular single-link reports", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-ips-list-"));
  const outside = path.join(temp, "outside.txt");
  const fifo = path.join(temp, "blocked.ips");
  try {
    await writeFile(path.join(temp, "valid.ips"), ipsContent(), "utf8");
    await writeFile(
      path.join(temp, "typed.ips"),
      ipsContent({ name: { nested: true }, bundleID: ["bad"] }),
      "utf8",
    );
    await writeFile(
      path.join(temp, "huge-header.ips"),
      `${"x".repeat(MAX_IPS_HEADER_BYTES + 1)}\n`,
      "utf8",
    );
    await writeFile(outside, ipsContent({ name: "Outside" }), "utf8");
    await symlink(outside, path.join(temp, "linked.ips"));
    await writeFile(path.join(temp, "hardlink-source"), ipsContent(), "utf8");
    await link(path.join(temp, "hardlink-source"), path.join(temp, "hardlinked.ips"));
    await execFileAsync("mkfifo", [fifo]);
    const oversized = await open(path.join(temp, "oversized.ips"), "w");
    await oversized.truncate(MAX_IPS_FILE_BYTES + 1);
    await oversized.close();

    const files = await listIpsFiles({ reports_dir: temp });
    assert.deepEqual(
      files.map((entry) => entry.filename).sort(),
      ["typed.ips", "valid.ips"],
    );
    const valid = files.find((entry) => entry.filename === "valid.ips")!;
    assert.equal(valid.proc_name, "FixtureApp");
    assert.equal(valid.bundle_id, "com.example.fixture");
    assert.equal(valid.path, await realpath(path.join(temp, "valid.ips")));

    const typed = files.find((entry) => entry.filename === "typed.ips")!;
    assert.equal(typed.proc_name, "unknown");
    assert.equal(typed.bundle_id, undefined);
    assert.deepEqual(
      (await listIpsFiles({
        reports_dir: temp,
        bundle_id: "EXAMPLE.FIXTURE",
        proc_name: "fixture",
      })).map((entry) => entry.filename),
      ["valid.ips"],
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("copyIpsFiles copies from verified descriptors into private regular files", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-ips-copy-"));
  const reports = path.join(temp, "reports");
  const output = path.join(temp, "output");
  try {
    await mkdir(reports);
    const source = path.join(reports, "Fixture.ips");
    await writeFile(source, ipsContent(), { mode: 0o644 });
    const listed = await listIpsFiles({ reports_dir: reports });
    assert.equal(listed.length, 1);

    const copied = await copyIpsFiles(listed, output);
    assert.equal(copied.length, 1);
    assert.equal(copied[0]?.from, await realpath(source));
    assert.equal(copied[0]?.to, await realpath(path.join(output, "Fixture.ips")));
    assert.equal(await readFile(copied[0]!.to, "utf8"), ipsContent());
    assert.equal((await stat(copied[0]!.to)).mode & 0o777, 0o600);
    assert.equal((await stat(output)).mode & 0o777, 0o700);
    assert.equal((await lstat(copied[0]!.to)).nlink, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("copyIpsFiles rejects replaced sources and forged summaries", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-ips-source-race-"));
  const reports = path.join(temp, "reports");
  const output = path.join(temp, "output");
  try {
    await mkdir(reports);
    const source = path.join(reports, "Race.ips");
    await writeFile(source, ipsContent(), "utf8");
    const listed = await listIpsFiles({ reports_dir: reports });
    await rename(source, path.join(reports, "old.ips"));
    await writeFile(source, ipsContent({ name: "Replacement" }), "utf8");
    await assert.rejects(copyIpsFiles(listed, output), /source changed before copy/i);

    const forged: IpsFileSummary = {
      ...listed[0]!,
      path: path.join(reports, "old.ips"),
    };
    await assert.rejects(
      copyIpsFiles([forged], output),
      /not produced by the current listIpsFiles call/i,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("copyIpsFiles refuses symlink and hardlink destinations without touching victims", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-ips-destination-"));
  const reports = path.join(temp, "reports");
  const output = path.join(temp, "output");
  const victim = path.join(temp, "victim.txt");
  try {
    await Promise.all([mkdir(reports), mkdir(output)]);
    const source = path.join(reports, "Safe.ips");
    const destination = path.join(output, "Safe.ips");
    await writeFile(source, ipsContent(), "utf8");
    await writeFile(victim, "victim\n", { mode: 0o600 });
    let listed = await listIpsFiles({ reports_dir: reports });

    await symlink(victim, destination);
    await assert.rejects(copyIpsFiles(listed, output), /unsafe existing IPS destination/i);
    assert.equal(await readFile(victim, "utf8"), "victim\n");
    await unlink(destination);

    await link(victim, destination);
    await assert.rejects(copyIpsFiles(listed, output), /unsafe existing IPS destination/i);
    assert.equal(await readFile(victim, "utf8"), "victim\n");
    await unlink(destination);

    // A normal legacy destination is atomically replaced and secured.
    await writeFile(destination, "legacy\n", { mode: 0o644 });
    await chmod(destination, 0o644);
    listed = await listIpsFiles({ reports_dir: reports });
    const copied = await copyIpsFiles(listed, output);
    assert.equal(await readFile(copied[0]!.to, "utf8"), ipsContent());
    assert.equal((await stat(copied[0]!.to)).mode & 0o777, 0o600);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("copyIpsFiles enforces a hard per-call file-count limit before I/O", async () => {
  const fake = Array.from({ length: MAX_IPS_COPY_FILES + 1 }, (_, index) => ({
    path: `/tmp/${index}.ips`,
    filename: `${index}.ips`,
    proc_name: "fixture",
    timestamp: "",
    size: 1,
    mtime_ms: 0,
  }));
  await assert.rejects(
    copyIpsFiles(fake, "/tmp/unused-ips-output"),
    new RegExp(`At most ${MAX_IPS_COPY_FILES}`),
  );
});

test("list IPS metadata explicitly reports its bounded result set", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-ips-response-cap-"));
  try {
    await Promise.all(
      Array.from({ length: MAX_IPS_RESULTS + 3 }, (_, index) =>
        writeFile(
          path.join(temp, `${String(index).padStart(3, "0")}.ips`),
          ipsContent({ name: `Fixture-${index}` }),
          "utf8",
        ),
      ),
    );
    const listed = await listIpsFilesWithMeta({ reports_dir: temp });
    assert.equal(listed.files.length, MAX_IPS_RESULTS);
    assert.equal(listed.total_detected, MAX_IPS_RESULTS + 3);
    assert.equal(listed.results_truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(listed), "utf8") < 4 * 1024 * 1024);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
