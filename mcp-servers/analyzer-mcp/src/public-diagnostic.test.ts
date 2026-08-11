import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PUBLIC_DIAGNOSTIC_CHARS,
  publicDiagnostic,
} from "./public-diagnostic.js";

test("publicDiagnostic removes controls and redacts local paths and URLs", () => {
  for (const secret of [
    "/Users/private/key.json",
    "C:\\Users\\private\\key.json",
    "\\\\server\\share\\key.json",
    "~/private/key.json",
    "file:///Users/private/key.json",
    "https://example.invalid/private?q=secret",
  ]) {
    const output = publicDiagnostic(
      new Error(`\u001b[31mfailed\u001b[0m\nsource ${secret} trailing-secret`),
    );
    assert.equal(output, "failed source <PATH>");
    assert.equal(output.includes("trailing-secret"), false);
    assert.doesNotMatch(output, /[\u0000-\u001f\u007f-\u009f\u200b]/u);
  }
});

test("publicDiagnostic is bounded and never coerces arbitrary objects", () => {
  let coerced = false;
  assert.equal(publicDiagnostic({
    toString() {
      coerced = true;
      return "/private/secret";
    },
  }), "request failed");
  assert.equal(coerced, false);

  const output = publicDiagnostic(new Error("x".repeat(10_000)));
  assert.equal(output.length, MAX_PUBLIC_DIAGNOSTIC_CHARS);
  assert.ok(output.endsWith("…"));
});
