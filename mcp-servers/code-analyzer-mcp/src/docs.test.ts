import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { discoverDocs } from "./docs.js";

async function makeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "code-analyzer-"));
  await writeFile(
    join(dir, "PRD.md"),
    "# PRD\n\n用户故事：\n- 用户A 登录后能看到订单\n",
  );
  await writeFile(
    join(dir, "README.md"),
    "# Project\nSimple readme content.\n".repeat(10),
  );
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(
    join(dir, "docs", "requirements.md"),
    "# requirements\n验收标准:\n- xxx\n",
  );
  await writeFile(
    join(dir, "docs", "test_plan.md"),
    "# test plan\n测试用例 TC-1\n",
  );
  await writeFile(
    join(dir, "docs", "random.md"),
    "no meaningful content " + "x".repeat(500),
  );
  await mkdir(join(dir, "node_modules", "some-dep"), { recursive: true });
  await writeFile(join(dir, "node_modules", "some-dep", "README.md"), "ignored dep readme");
  return dir;
}

describe("discoverDocs", () => {
  it("classifies prd, requirements, test-plan, readme and skips node_modules", async () => {
    const dir = await makeFixture();
    try {
      const hits = await discoverDocs(dir);
      const byKind = new Map<string, string[]>();
      for (const h of hits) {
        (byKind.get(h.kind) ?? byKind.set(h.kind, []).get(h.kind)!).push(h.path);
      }
      assert.ok(byKind.get("prd")?.includes("PRD.md"), "PRD.md classified as prd");
      assert.ok(byKind.get("readme")?.includes("README.md"), "README classified");
      assert.ok(
        byKind.get("requirements")?.some((p) => p.endsWith("requirements.md")),
        "requirements found",
      );
      assert.ok(
        byKind.get("test-plan")?.some((p) => p.endsWith("test_plan.md")),
        "test_plan classified",
      );
      // node_modules excluded
      for (const h of hits) {
        assert.ok(!h.path.startsWith("node_modules/"), "should skip node_modules");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("classifies docs by content keywords when filename is generic", async () => {
    const dir = await mkdtemp(join(tmpdir(), "code-analyzer-"));
    try {
      await writeFile(
        join(dir, "notes.md"),
        "# Some notes\n我们要写 test case：登录 → 首页 → 退出\n",
      );
      const hits = await discoverDocs(dir);
      const notes = hits.find((h) => h.path === "notes.md");
      assert.ok(notes);
      assert.equal(notes!.kind, "test-plan");
      assert.ok(notes!.signal.some((s) => s.startsWith("content:")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
