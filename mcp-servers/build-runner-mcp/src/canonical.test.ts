import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "./canonical.js";

test("canonical JSON sorts keys without dropping __proto__", () => {
  const value = JSON.parse('{"z":1,"__proto__":{"polluted":true},"a":2}') as unknown;

  assert.equal(
    canonicalJson(value),
    '{"__proto__":{"polluted":true},"a":2,"z":1}',
  );
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("canonical JSON rejects undefined and non-finite numbers", () => {
  assert.throws(() => canonicalJson({ value: undefined }), /rejects undefined/i);
  assert.throws(() => canonicalJson({ value: Number.NaN }), /finite numbers/i);
  assert.throws(() => canonicalJson({ value: -0 }), /other than -0/i);
});
