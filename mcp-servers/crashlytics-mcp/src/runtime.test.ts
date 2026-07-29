import assert from "node:assert/strict";
import test from "node:test";

import { createLazyService } from "./runtime.js";
import type { CrashlyticsService } from "./service.js";

test("lazy runtime does not construct a provider or resolve ADC at startup", () => {
  let calls = 0;
  const sentinel = {} as CrashlyticsService;
  const getService = createLazyService(() => {
    calls += 1;
    return sentinel;
  });
  assert.equal(calls, 0);
  assert.equal(getService(), sentinel);
  assert.equal(getService(), sentinel);
  assert.equal(calls, 1);
});
