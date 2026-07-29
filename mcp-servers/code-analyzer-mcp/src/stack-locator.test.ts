import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { locateStackFrames } from "./stack-locator.js";

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stack-locator-"));
  await mkdir(join(dir, "app/src/main/java/com/example"), { recursive: true });
  await writeFile(
    join(dir, "app/src/main/java/com/example/LoginActivity.kt"),
    [
      "package com.example",
      "class LoginActivity {",
      "  fun submitLogin() {",
      "    error(\"fixture\")",
      "  }",
      "}",
    ].join("\n"),
  );
  await mkdir(join(dir, "lib"), { recursive: true });
  await writeFile(
    join(dir, "lib/profile_page.dart"),
    "class ProfilePage { void loadProfile() {} }\n",
  );
  return dir;
}

describe("locateStackFrames", () => {
  it("prefers an exact in-repo path suffix and preserves the reported line", async () => {
    const dir = await fixtureDir();
    try {
      const result = await locateStackFrames(dir, [{
        index: 0,
        symbol: "com.example.LoginActivity.submitLogin",
        file: "/build/agent/app/src/main/java/com/example/LoginActivity.kt",
        line: 4,
        app_owned: true,
      }]);
      assert.equal(result.candidates[0]?.file, "app/src/main/java/com/example/LoginActivity.kt");
      assert.equal(result.candidates[0]?.match_type, "path-suffix");
      assert.equal(result.candidates[0]?.confidence, "high");
      assert.equal(result.candidates[0]?.line, 4);
      assert.match(result.candidates[0]?.snippet ?? "", /fixture/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to type and symbol names without opening stack-supplied paths", async () => {
    const dir = await fixtureDir();
    const outside = await mkdtemp(join(tmpdir(), "stack-locator-secret-"));
    try {
      await writeFile(join(outside, "Secret.kt"), "class Secret { fun stealToken() {} }");
      await symlink(outside, join(dir, "linked-outside"));
      const result = await locateStackFrames(dir, [
        { index: 1, symbol: "com.example.LoginActivity.submitLogin", file: "../../Secret.kt" },
        { index: 2, symbol: "ProfilePage.loadProfile" },
      ]);
      assert.ok(result.candidates.some((c) => c.frame_index === 1 && c.file.endsWith("LoginActivity.kt")));
      assert.ok(result.candidates.some((c) => c.frame_index === 2 && c.file === "lib/profile_page.dart"));
      assert.ok(result.candidates.every((c) => !c.file.includes("Secret.kt")));
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("treats a plain basename as medium rather than an exact path", async () => {
    const dir = await fixtureDir();
    try {
      const result = await locateStackFrames(dir, [{
        index: 0,
        symbol: "com.example.LoginActivity.submitLogin",
        file: "LoginActivity.kt",
        line: 4,
      }]);
      assert.equal(result.candidates[0]?.match_type, "basename");
      assert.equal(result.candidates[0]?.confidence, "medium");
      assert.ok(result.source_bytes_scanned > 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not promote package words or a matching type without a real method declaration", async () => {
    const dir = await fixtureDir();
    const sourceDir = join(dir, "app/src/main/java/com/example");
    try {
      await writeFile(
        join(sourceDir, "PackageOnlyActivity.kt"),
        [
          "package com.example",
          "class PackageOnlyActivity {",
          "  fun wrapper() {",
          "    missingMethod() // a call is not declaration evidence",
          "  }",
          "}",
        ].join("\n"),
      );

      const result = await locateStackFrames(dir, [{
        index: 0,
        symbol: "com.example.PackageOnlyActivity.missingMethod",
        file: "/build/agent/app/src/main/java/com/example/PackageOnlyActivity.kt",
        line: 4,
      }]);
      const candidate = result.candidates.find(
        (item) => item.file.endsWith("PackageOnlyActivity.kt"),
      );
      assert.ok(candidate);
      assert.equal(candidate.match_type, "path-suffix");
      assert.equal(candidate.confidence, "medium");
      assert.ok(result.candidates.every((item) => item.confidence !== "high"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("requires a valid reported line before an exact path and method can be high", async () => {
    const dir = await fixtureDir();
    try {
      const result = await locateStackFrames(dir, [{
        index: 0,
        symbol: "com.example.LoginActivity.submitLogin",
        file: "/build/agent/app/src/main/java/com/example/LoginActivity.kt",
        line: 9_999,
      }]);
      assert.equal(result.candidates[0]?.file, "app/src/main/java/com/example/LoginActivity.kt");
      assert.equal(result.candidates[0]?.match_type, "path-suffix");
      assert.equal(result.candidates[0]?.confidence, "medium");
      assert.equal(result.candidates[0]?.line, 3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not promote an unrelated valid line elsewhere in the same source file", async () => {
    const dir = await fixtureDir();
    const source = join(dir, "app/src/main/java/com/example/LoginActivity.kt");
    try {
      await writeFile(
        source,
        [
          "package com.example",
          "class LoginActivity {",
          "  fun submitLogin() {",
          "    error(\"fixture\")",
          "  }",
          "",
          "  fun unrelated() {",
          "    val unrelatedValue = 42",
          "  }",
          "}",
        ].join("\n"),
      );

      const result = await locateStackFrames(dir, [{
        index: 0,
        symbol: "com.example.LoginActivity.submitLogin",
        file: "/build/agent/app/src/main/java/com/example/LoginActivity.kt",
        line: 8,
      }]);
      assert.equal(result.candidates[0]?.match_type, "path-suffix");
      assert.equal(result.candidates[0]?.confidence, "medium");
      assert.equal(result.candidates[0]?.line, 8);
      assert.match(result.candidates[0]?.snippet ?? "", /unrelatedValue/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores method-shaped text in comments and strings for high confidence", async () => {
    const dir = await fixtureDir();
    const sourceDir = join(dir, "app/src/main/java/com/example");
    try {
      await writeFile(
        join(sourceDir, "CommentOnlyActivity.kt"),
        [
          "package com.example",
          "class CommentOnlyActivity {",
          "  // fun missingMethod() {",
          "  val example = \"fun missingMethod() {\"",
          "  fun unrelated() {",
          "    error(\"fixture\")",
          "  }",
          "}",
        ].join("\n"),
      );

      const result = await locateStackFrames(dir, [{
        index: 0,
        symbol: "com.example.CommentOnlyActivity.missingMethod",
        file: "/build/agent/app/src/main/java/com/example/CommentOnlyActivity.kt",
        line: 6,
      }]);
      assert.equal(result.candidates[0]?.match_type, "path-suffix");
      assert.equal(result.candidates[0]?.confidence, "medium");
      assert.ok(result.candidates.every((item) => item.confidence !== "high"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("requires the reported method to belong to the stack owner type", async () => {
    const dir = await fixtureDir();
    const source = join(dir, "app/src/main/java/com/example/LoginActivity.kt");
    try {
      await writeFile(
        source,
        [
          "package com.example",
          "class LoginActivity {}",
          "class OtherClass {",
          "  fun submitLogin() {",
          "    error(\"wrong owner\")",
          "  }",
          "}",
        ].join("\n"),
      );

      const result = await locateStackFrames(dir, [{
        index: 0,
        symbol: "com.example.LoginActivity.submitLogin",
        file: "/build/agent/app/src/main/java/com/example/LoginActivity.kt",
        line: 5,
      }]);
      assert.equal(result.candidates[0]?.match_type, "path-suffix");
      assert.equal(result.candidates[0]?.confidence, "medium");
      assert.match(result.candidates[0]?.snippet ?? "", /wrong owner/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not treat a Kotlin trailing-lambda call as a method declaration", async () => {
    const dir = await fixtureDir();
    const source = join(dir, "app/src/main/java/com/example/LoginActivity.kt");
    try {
      await writeFile(
        source,
        [
          "package com.example",
          "class LoginActivity {",
          "  fun wrapper() {",
          "    submitLogin() {",
          "      error(\"callback\")",
          "    }",
          "  }",
          "}",
        ].join("\n"),
      );

      const result = await locateStackFrames(dir, [{
        index: 0,
        symbol: "com.example.LoginActivity.submitLogin",
        file: "/build/agent/app/src/main/java/com/example/LoginActivity.kt",
        line: 5,
      }]);
      assert.equal(result.candidates[0]?.confidence, "medium");
      assert.ok(result.candidates.every((item) => item.confidence !== "high"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("supports owner-bound Swift and Java declarations", async () => {
    const dir = await fixtureDir();
    try {
      const swiftDir = join(dir, "ios/Sources/App");
      await mkdir(swiftDir, { recursive: true });
      await writeFile(
        join(swiftDir, "LoginViewController.swift"),
        [
          "final class LoginViewController {",
          "  func submitLogin() {",
          "    fatalError(\"fixture\")",
          "  }",
          "}",
        ].join("\n"),
      );
      const javaDir = join(dir, "android/src/main/java/com/example");
      await mkdir(javaDir, { recursive: true });
      await writeFile(
        join(javaDir, "LoginActivity.java"),
        [
          "package com.example;",
          "final class LoginActivity {",
          "  void submitLogin() {",
          "    throw new IllegalStateException();",
          "  }",
          "}",
        ].join("\n"),
      );

      const result = await locateStackFrames(dir, [
        {
          index: 0,
          symbol: "App.LoginViewController.submitLogin",
          file: "/build/ios/Sources/App/LoginViewController.swift",
          line: 3,
        },
        {
          index: 1,
          symbol: "com.example.LoginActivity.submitLogin",
          file: "/build/android/src/main/java/com/example/LoginActivity.java",
          line: 4,
        },
      ]);
      assert.equal(result.candidates.find((item) => item.frame_index === 0)?.confidence, "high");
      assert.equal(result.candidates.find((item) => item.frame_index === 1)?.confidence, "high");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses the named nested owner and rejects an outer-owner mismatch", async () => {
    const dir = await fixtureDir();
    const sourceDir = join(dir, "app/src/main/java/com/example");
    try {
      await writeFile(
        join(sourceDir, "Outer.kt"),
        [
          "package com.example",
          "class Outer {",
          "  class Inner {",
          "    fun crashNow() {",
          "      error(\"nested\")",
          "    }",
          "  }",
          "}",
        ].join("\n"),
      );
      const file = "/build/agent/app/src/main/java/com/example/Outer.kt";
      const result = await locateStackFrames(dir, [
        { index: 0, symbol: "com.example.Outer$Inner.crashNow", file, line: 5 },
        { index: 1, symbol: "com.example.Outer.crashNow", file, line: 5 },
        { index: 2, symbol: "com.example.Outer$1.crashNow", file, line: 5 },
      ]);
      assert.equal(result.candidates.find((item) => item.frame_index === 0)?.confidence, "high");
      assert.equal(result.candidates.find((item) => item.frame_index === 1)?.confidence, "medium");
      assert.equal(result.candidates.find((item) => item.frame_index === 2)?.confidence, "medium");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps unsupported languages below automatic-patch confidence", async () => {
    const dir = await fixtureDir();
    try {
      const result = await locateStackFrames(dir, [{
        index: 0,
        symbol: "ProfilePage.loadProfile",
        file: "/build/agent/lib/profile_page.dart",
        line: 1,
      }]);
      assert.equal(result.candidates[0]?.match_type, "path-suffix");
      assert.equal(result.candidates[0]?.confidence, "medium");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not scan retained worktrees as release source", async () => {
    const dir = await fixtureDir();
    try {
      const retained = join(
        dir,
        ".worktrees/old-release/app/src/main/java/com/example",
      );
      await mkdir(retained, { recursive: true });
      await writeFile(
        join(retained, "ShadowActivity.kt"),
        "package com.example\nclass ShadowActivity { fun crashNow() {} }\n",
      );

      const result = await locateStackFrames(dir, [{
        index: 0,
        symbol: "com.example.ShadowActivity.crashNow",
        file: "/build/agent/app/src/main/java/com/example/ShadowActivity.kt",
        line: 2,
      }]);
      assert.equal(result.candidates.length, 0);
      assert.deepEqual(result.unmatched_frames, [0]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("downgrades exact matches when the candidate result set is truncated", async () => {
    const dir = await fixtureDir();
    try {
      const duplicateDir = join(
        dir,
        "feature/app/src/main/java/com/example",
      );
      await mkdir(duplicateDir, { recursive: true });
      await writeFile(
        join(duplicateDir, "LoginActivity.kt"),
        [
          "package com.example",
          "class LoginActivity {",
          "  fun submitLogin() {",
          "    error(\"duplicate\")",
          "  }",
          "}",
        ].join("\n"),
      );

      const result = await locateStackFrames(
        dir,
        [{
          index: 0,
          symbol: "com.example.LoginActivity.submitLogin",
          file: "/build/agent/app/src/main/java/com/example/LoginActivity.kt",
          line: 4,
        }],
        { maxCandidates: 1 },
      );
      assert.equal(result.results_truncated, true);
      assert.equal(result.candidates.length, 1);
      assert.equal(result.candidates[0]?.confidence, "medium");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caps returned candidates", async () => {
    const dir = await fixtureDir();
    try {
      const result = await locateStackFrames(
        dir,
        [{ index: 0, symbol: "Unknown.loadProfile" }],
        { maxCandidates: 1 },
      );
      assert.equal(result.candidates.length, 1);
      assert.equal(result.results_truncated, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
