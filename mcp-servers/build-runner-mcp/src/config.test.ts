import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultDockerHost, imageDigest, loadRunnerConfig } from "./config.js";

const DIGEST = "a".repeat(64);

test("runner config requires an absolute executable and digest-pinned image", () => {
  const missing = loadRunnerConfig({});
  assert.equal(missing.config, undefined);
  assert.match(missing.errors.join(" "), /DOCKER_BIN|required/i);

  const tagOnly = loadRunnerConfig({
    APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN: "/usr/bin/docker",
    APP_TEST_CTRL_BUILD_RUNNER_IMAGE: "example/android:latest",
  });
  assert.equal(tagOnly.config, undefined);
  assert.match(tagOnly.errors.join(" "), /sha256/i);

  const loaded = loadRunnerConfig({
    APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN: "/usr/bin/docker",
    APP_TEST_CTRL_BUILD_RUNNER_DOCKER_HOST: "unix:///private/tmp/docker.sock",
    APP_TEST_CTRL_BUILD_RUNNER_IMAGE: `example/android@sha256:${DIGEST}`,
  });
  assert.equal(loaded.errors.length, 0);
  assert.equal(loaded.config?.dockerHost, "unix:///private/tmp/docker.sock");
  assert.equal(loaded.config?.ociRuntime, "runc");
  assert.equal(loaded.config?.maxMemoryMb, 4096);
  assert.equal(imageDigest(loaded.config!.image), DIGEST);
});

test("runner config defaults to the current user's platform socket without Docker env fallback", () => {
  assert.equal(
    defaultDockerHost("darwin", "/Users/local-user", 999),
    "unix:///Users/local-user/.docker/run/docker.sock",
  );
  assert.equal(
    defaultDockerHost("linux", "/ignored", 1234),
    "unix:///run/user/1234/docker.sock",
  );
  assert.throws(() => defaultDockerHost("win32", "C:\\Users\\local-user", 1234), /no local-user/i);

  const loaded = loadRunnerConfig({
    DOCKER_HOST: "tcp://remote.example:2375",
    DOCKER_CONTEXT: "production-remote",
    APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN: "/usr/bin/docker",
    APP_TEST_CTRL_BUILD_RUNNER_IMAGE: `example/android@sha256:${DIGEST}`,
  });
  assert.equal(loaded.errors.length, 0);
  assert.equal(loaded.config?.dockerHost, defaultDockerHost());
});

test("runner config rejects remote Docker daemons and unbounded resources", () => {
  const remote = loadRunnerConfig({
    APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN: "/usr/bin/docker",
    APP_TEST_CTRL_BUILD_RUNNER_DOCKER_HOST: "tcp://example.test:2375",
    APP_TEST_CTRL_BUILD_RUNNER_IMAGE: `example/android@sha256:${DIGEST}`,
  });
  assert.equal(remote.config, undefined);
  assert.match(remote.errors.join(" "), /unix socket/i);

  const oversized = loadRunnerConfig({
    APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN: "/usr/bin/docker",
    APP_TEST_CTRL_BUILD_RUNNER_IMAGE: `example/android@sha256:${DIGEST}`,
    APP_TEST_CTRL_BUILD_RUNNER_MEMORY_MB: "999999",
  });
  assert.equal(oversized.config, undefined);
  assert.match(oversized.errors.join(" "), /MEMORY_MB/i);
});

test("runner config rejects ambiguous or encoded Docker socket URLs", () => {
  for (const dockerHost of [
    "unix:///tmp/../run/docker.sock",
    "unix:///tmp/%2e%2e/run/docker.sock",
    "unix:////tmp/docker.sock",
    "unix:///tmp/docker.sock?x=1",
    "tcp://127.0.0.1:2375",
  ]) {
    const loaded = loadRunnerConfig({
      APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN: "/usr/bin/docker",
      APP_TEST_CTRL_BUILD_RUNNER_IMAGE: `example/android@sha256:${DIGEST}`,
      APP_TEST_CTRL_BUILD_RUNNER_DOCKER_HOST: dockerHost,
    });
    assert.equal(loaded.config, undefined, dockerHost);
  }
});

test("runner config validates the fixed OCI runtime name", () => {
  const configured = loadRunnerConfig({
    APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN: "/usr/bin/docker",
    APP_TEST_CTRL_BUILD_RUNNER_IMAGE: `example/android@sha256:${DIGEST}`,
    APP_TEST_CTRL_BUILD_RUNNER_OCI_RUNTIME: "kata-runtime",
  });
  assert.equal(configured.errors.length, 0);
  assert.equal(configured.config?.ociRuntime, "kata-runtime");

  for (const runtime of ["RUNC", "../runc", "runc/path", "runc --debug", "x".repeat(65)]) {
    const loaded = loadRunnerConfig({
      APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN: "/usr/bin/docker",
      APP_TEST_CTRL_BUILD_RUNNER_IMAGE: `example/android@sha256:${DIGEST}`,
      APP_TEST_CTRL_BUILD_RUNNER_OCI_RUNTIME: runtime,
    });
    assert.equal(loaded.config, undefined, runtime);
    assert.match(loaded.errors.join(" "), /OCI_RUNTIME/i);
  }
});

test("local_trusted config is explicit, never falls back to Docker, and preserves invalid identity", () => {
  const explicit = loadRunnerConfig({
    APP_TEST_CTRL_BUILD_RUNNER_BACKEND: "local_trusted",
    APP_TEST_CTRL_BUILD_RUNNER_LOCAL_JAVA_HOME: "/trusted/java",
    APP_TEST_CTRL_BUILD_RUNNER_LOCAL_ANDROID_SDK_ROOT: "/trusted/android-sdk",
    APP_TEST_CTRL_BUILD_RUNNER_LOCAL_APKANALYZER: "/trusted/android-sdk/cmdline-tools/13.0/bin/apkanalyzer",
    APP_TEST_CTRL_BUILD_RUNNER_LOCAL_APKSIGNER: "/trusted/android-sdk/build-tools/36.0.0/apksigner",
    APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN: "/must/not/be/read",
  });
  assert.equal(explicit.errors.length, 0);
  assert.equal(explicit.requestedBackend, "local_trusted");
  assert.equal(explicit.config?.backend, "local_trusted");
  assert.equal("dockerBin" in explicit.config!, false);

  const invalid = loadRunnerConfig({ APP_TEST_CTRL_BUILD_RUNNER_BACKEND: "unexpected" });
  assert.equal(invalid.config, undefined);
  assert.equal(invalid.requestedBackend, "invalid");
  assert.match(invalid.errors.join(" "), /docker or local_trusted/i);
});

test("local tool discovery is bounded and selects the highest numeric stable SDK directory", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "local-config-discovery-")));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sdk = path.join(root, "sdk");
  for (const version of ["9.0", "36.0.0", "37.0.0-rc1", "preview"]) {
    await mkdir(path.join(sdk, "cmdline-tools", version, "bin"), { recursive: true });
    await writeFile(path.join(sdk, "cmdline-tools", version, "bin", "apkanalyzer"), "tool\n");
    await mkdir(path.join(sdk, "build-tools", version), { recursive: true });
    await writeFile(path.join(sdk, "build-tools", version, "apksigner"), "tool\n");
  }
  const loaded = loadRunnerConfig({
    APP_TEST_CTRL_BUILD_RUNNER_BACKEND: "local_trusted",
    JAVA_HOME: path.join(root, "java"),
    ANDROID_SDK_ROOT: sdk,
  });
  assert.equal(loaded.errors.length, 0);
  assert.equal(
    loaded.config?.apkAnalyzer,
    path.join(sdk, "cmdline-tools", "36.0.0", "bin", "apkanalyzer"),
  );
  assert.equal(
    loaded.config?.apkSigner,
    path.join(sdk, "build-tools", "36.0.0", "apksigner"),
  );

  await mkdir(path.join(sdk, "cmdline-tools", "latest", "bin"), { recursive: true });
  await writeFile(path.join(sdk, "cmdline-tools", "latest", "bin", "apkanalyzer"), "latest\n");
  const latest = loadRunnerConfig({
    APP_TEST_CTRL_BUILD_RUNNER_BACKEND: "local_trusted",
    JAVA_HOME: path.join(root, "java"),
    ANDROID_SDK_ROOT: sdk,
  });
  assert.equal(
    latest.config?.apkAnalyzer,
    path.join(sdk, "cmdline-tools", "latest", "bin", "apkanalyzer"),
  );
});

test("local tool discovery fails closed when a version directory exceeds its bound", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "local-config-bound-")));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sdk = path.join(root, "sdk");
  for (let index = 0; index < 129; index += 1) {
    const directory = path.join(sdk, "cmdline-tools", `1.${index}`, "bin");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "apkanalyzer"), "tool\n");
  }
  const loaded = loadRunnerConfig({
    APP_TEST_CTRL_BUILD_RUNNER_BACKEND: "local_trusted",
    APP_TEST_CTRL_BUILD_RUNNER_LOCAL_JAVA_HOME: path.join(root, "java"),
    APP_TEST_CTRL_BUILD_RUNNER_LOCAL_ANDROID_SDK_ROOT: sdk,
    APP_TEST_CTRL_BUILD_RUNNER_LOCAL_APKSIGNER: path.join(sdk, "build-tools", "1.0", "apksigner"),
  });
  assert.equal(loaded.config, undefined);
  assert.equal(loaded.requestedBackend, "local_trusted");
  assert.match(loaded.errors.join(" "), /APKANALYZER.*could not be discovered/i);
});
