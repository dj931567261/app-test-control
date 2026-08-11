import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PUBLIC_DIAGNOSTIC_CHARS,
  publicDiagnostic,
} from "./public-diagnostic.js";

test("publicDiagnostic strips controls and truncates every supported path form", () => {
  const cases = [
    "failed at /Users/private account/service.json token=must-not-leak",
    "failed at C:\\Users\\private\\service.json token=must-not-leak",
    "failed at \\\\server\\private\\service.json token=must-not-leak",
    "failed at ~/private/service.json token=must-not-leak",
    "failed at file:///private/service.json token=must-not-leak",
    "failed at https://example.invalid/private token=must-not-leak",
  ];
  for (const value of cases) {
    const diagnostic = publicDiagnostic(
      new Error(`\u001b[31m${value}\u001b[0m\n\u0000\u200bafter-control`),
    );
    assert.match(diagnostic, /^failed at <PATH>$/);
    assert.doesNotMatch(diagnostic, /private|service|token|\u001b|\u0000|\u200b/);
  }
});

test("publicDiagnostic is bounded and never invokes arbitrary object toString", () => {
  assert.equal(publicDiagnostic({ toString: () => assert.fail("must not run") }), "request failed");
  const diagnostic = publicDiagnostic(new Error("x".repeat(10_000)));
  assert.equal(diagnostic.length, MAX_PUBLIC_DIAGNOSTIC_CHARS);
  assert.match(diagnostic, /…$/);
});
