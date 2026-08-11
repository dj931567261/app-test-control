import assert from "node:assert/strict";
import test from "node:test";

import { cleanDiagnostic } from "./diagnostic.js";

test("diagnostics fail closed on POSIX, Windows, UNC, tilde and socket paths", () => {
  const cases: Array<[string, string]> = [
    ["audit failed at /tmp/测试 project/private file: denied", "audit failed at <PATH>"],
    ["spawn C:\\Users\\Example User\\private.exe ENOENT", "spawn <PATH>"],
    ["open \\Users\\Example User\\private.exe denied", "open <PATH>"],
    ["read \\\\server\\share\\private folder\\file failed", "read <PATH>"],
    ["read ~/private folder/file failed", "read <PATH>"],
    ["read=>/private/测试 folder/file failed", "read=><PATH>"],
    ["daemon unix:///Users/example/Docker Socket/docker.sock unavailable", "daemon <DOCKER_SOCKET>"],
  ];
  for (const [input, expected] of cases) assert.equal(cleanDiagnostic(input), expected);
});

test("diagnostics remove terminal controls and discard unterminated control payloads", () => {
  assert.equal(
    cleanDiagnostic("\u001b[31mfailed\u001b[0m at /private/测试 path\nnext"),
    "failed at <PATH>",
  );
  assert.equal(
    cleanDiagnostic("prefix\u001b]8;;file:///private/secret\u0007link\u001b]8;;\u0007 suffix"),
    "prefix <PATH>",
  );
  assert.equal(cleanDiagnostic("\u001b[/Users/private suffix"), "<PATH>");
  assert.equal(
    cleanDiagnostic("failed\u001bA/Users/alice/Secret Folder/key.txt"),
    "failed <PATH>",
  );
  assert.equal(cleanDiagnostic("safe prefix\u001b]unterminated /private/secret"), "safe prefix <PATH>");
  assert.equal(cleanDiagnostic("left\u202Eright\u0000done"), "leftright done");
});

test("diagnostics are bounded and tolerate hostile string conversion", () => {
  assert.equal(cleanDiagnostic("abcdefgh", 4), "abcd");
  assert.equal(cleanDiagnostic("abcdefgh", 0), "abcdefgh");
  assert.equal(cleanDiagnostic({ toString: () => { throw new Error("nope"); } }), "unknown error");
});
