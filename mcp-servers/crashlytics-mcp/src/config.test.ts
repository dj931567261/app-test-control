import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAllowedApp,
  loadConfig,
} from "./config.js";
import { CrashlyticsError } from "./errors.js";

const baseEnv = {
  CRASHLYTICS_PROVIDER: "cloud_logging",
  CRASHLYTICS_PROJECT_ALLOWLIST: "demo-project,second-project",
  CRASHLYTICS_APP_ALLOWLIST:
    "demo-project=1:123:android:abc,second-project=com.example.ios",
};

test("loadConfig builds project-scoped app allowlists and bounded defaults", () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.provider, "cloud_logging");
  assert.deepEqual([...config.projects], ["demo-project", "second-project"]);
  assert.deepEqual([...config.appsByProject.get("demo-project") ?? []], ["1:123:android:abc"]);
  assert.equal(config.maxWindowHours, 24);
  assert.equal(config.requestTimeoutMs, 8_000);
  assert.equal(config.maxRetries, 2);
});
test("app allowlist cannot grant an app across projects", () => {
  const config = loadConfig(baseEnv);
  assert.throws(
    () => assertAllowedApp(config, "demo-project", "com.example.ios"),
    (error) => error instanceof CrashlyticsError && error.code === "FORBIDDEN_APP",
  );
});

test("loadConfig rejects missing and malformed allowlists", () => {
  assert.throws(
    () => loadConfig({}),
    (error) => error instanceof CrashlyticsError && error.code === "CONFIG_INVALID",
  );
  assert.throws(
    () => loadConfig({
      ...baseEnv,
      CRASHLYTICS_APP_ALLOWLIST: "demo-project/*",
    }),
    (error) => error instanceof CrashlyticsError && error.code === "CONFIG_INVALID",
  );
});

test("fixture path must be absolute and bounds cannot be enlarged", () => {
  assert.throws(
    () => loadConfig({
      ...baseEnv,
      CRASHLYTICS_PROVIDER: "fixture",
      CRASHLYTICS_FIXTURE_PATH: "relative.json",
    }),
    (error) => error instanceof CrashlyticsError && error.code === "CONFIG_INVALID",
  );
  assert.throws(
    () => loadConfig({
      ...baseEnv,
      CRASHLYTICS_MAX_RETRIES: "99",
    }),
    (error) => error instanceof CrashlyticsError && error.code === "CONFIG_INVALID",
  );
});
