import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";

import { pullViaBugreport, quoteAdbShellArg } from "./adb.js";

test("adb shell quoting preserves a package/process value as one literal argument", () => {
  assert.equal(quoteAdbShellArg("com.example.app"), "'com.example.app'");
  assert.equal(
    quoteAdbShellArg("com.example';id\nnext"),
    `'com.example'"'"';id\nnext'`,
  );
  assert.throws(() => quoteAdbShellArg("bad\0value"), /NUL/);

  const payload = "com.example;printf INJECTED&whoami|cat\nnext '$HOME'";
  const command = `set -- ${quoteAdbShellArg(payload)}; test "$#" -eq 1; printf %s "$1"`;
  assert.equal(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" }), payload);
});

test("bugreport uses a private staging file and never overwrites old evidence", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-bugreport-"));
  const adbBin = path.join(temp, "fake-adb");
  const output = path.join(temp, "reports", "bugreport.zip");
  const victim = path.join(temp, "victim.txt");
  const linkedOutput = path.join(temp, "reports", "linked.zip");
  const oldAdb = process.env.ADB_BIN;
  try {
    await writeFile(
      adbBin,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "const args = process.argv.slice(2);",
        "if (args.includes('devices')) {",
        "  process.stdout.write('List of devices attached\\ntest-device device model:Fixture product:Fixture\\n');",
        "} else if (args.includes('bugreport')) {",
        "  fs.writeFileSync(args.at(-1), 'private bugreport');",
        "}",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(adbBin, 0o700);
    process.env.ADB_BIN = adbBin;
    const published = await pullViaBugreport({
      device: "test-device",
      outZipPath: output,
    });
    assert.equal(await readFile(published, "utf8"), "private bugreport");
    assert.equal((await stat(published)).mode & 0o777, 0o600);

    await writeFile(victim, "victim", "utf8");
    await symlink(victim, linkedOutput);
    await assert.rejects(
      pullViaBugreport({ device: "test-device", outZipPath: linkedOutput }),
      /EEXIST|file exists/i,
    );
    assert.equal(await readFile(victim, "utf8"), "victim");
  } finally {
    if (oldAdb === undefined) delete process.env.ADB_BIN;
    else process.env.ADB_BIN = oldAdb;
    await rm(temp, { recursive: true, force: true });
  }
});
