import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";

import { openSecureDirectory } from "./secure-directory.js";

test("private directory tightens a current-user leaf but rejects an unsafe ancestor", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-private-dir-"));
  try {
    const legacy = path.join(temp, "legacy");
    await mkdir(legacy);
    await chmod(legacy, 0o777);
    const opened = await openSecureDirectory(legacy);
    assert.equal((await stat(legacy)).mode & 0o777, 0o700);
    await opened.close();

    const unsafeParent = path.join(temp, "shared-parent");
    await mkdir(unsafeParent);
    await chmod(unsafeParent, 0o777);
    await assert.rejects(
      openSecureDirectory(path.join(unsafeParent, "private-child")),
      /group\/world-writable without sticky protection/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("private directory rejects a final symlink and detects rename replacement", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "log-mcp-private-swap-"));
  try {
    const real = path.join(temp, "real");
    const linked = path.join(temp, "linked");
    await mkdir(real);
    await symlink(real, linked);
    await assert.rejects(openSecureDirectory(linked), /must not be a symbolic link/);

    const watched = path.join(temp, "watched");
    const moved = path.join(temp, "moved");
    const identity = await openSecureDirectory(watched);
    await rename(watched, moved);
    await mkdir(watched, { mode: 0o700 });
    await assert.rejects(identity.assertUnchanged(), /changed during use|identity changed/);
    await identity.close();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
