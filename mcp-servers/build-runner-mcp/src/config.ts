import { opendirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PINNED_IMAGE_RE = /^[a-z0-9][a-z0-9./:_-]{0,255}@sha256:[a-f0-9]{64}$/;
const CONTAINER_PATH_RE = /^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/;
const OCI_RUNTIME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number, label: string): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${label} must be an integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return parsed;
}

function containerPath(raw: string | undefined, fallback: string, label: string): string {
  const value = raw || fallback;
  if (!CONTAINER_PATH_RE.test(value) || value.includes("..")) {
    throw new Error(`${label} must be a normalized absolute container path`);
  }
  return value;
}

function localPath(raw: string | undefined, label: string): string {
  if (!raw) throw new Error(`${label} could not be discovered for the local_trusted backend`);
  if (CONTROL_RE.test(raw) || !path.isAbsolute(raw) || path.normalize(raw) !== raw) {
    throw new Error(`${label} must be a normalized absolute host path`);
  }
  return raw;
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function firstExistingDirectory(candidates: readonly string[]): string | undefined {
  return candidates.find(isDirectory);
}

function compareNumericVersionsDescending(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return Buffer.from(right).compare(Buffer.from(left));
}

function boundedVersionDirectories(root: string, maxEntries: number): string[] {
  let directory: ReturnType<typeof opendirSync> | undefined;
  try {
    directory = opendirSync(root);
    const names: string[] = [];
    let entries = 0;
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      entries += 1;
      if (entries > maxEntries) return [];
      if (
        entry.isDirectory()
        && /^[0-9]+(?:\.[0-9]+)*$/.test(entry.name)
      ) {
        names.push(entry.name);
      }
    }
    return names.sort(compareNumericVersionsDescending);
  } catch {
    return [];
  } finally {
    directory?.closeSync();
  }
}

function discoverJavaHome(env: NodeJS.ProcessEnv): string | undefined {
  if (env.APP_TEST_CTRL_BUILD_RUNNER_LOCAL_JAVA_HOME) {
    return env.APP_TEST_CTRL_BUILD_RUNNER_LOCAL_JAVA_HOME;
  }
  if (env.JAVA_HOME) return env.JAVA_HOME;
  const home = os.userInfo().homedir;
  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
        "/Applications/Android Studio.app/Contents/jre/Contents/Home",
        path.join(home, "Applications/Android Studio.app/Contents/jbr/Contents/Home"),
      ]
    : process.platform === "linux"
      ? [
          "/opt/android-studio/jbr",
          "/usr/local/android-studio/jbr",
          path.join(home, "android-studio/jbr"),
        ]
      : [];
  return firstExistingDirectory(candidates);
}

function discoverAndroidSdkRoot(env: NodeJS.ProcessEnv): string | undefined {
  if (env.APP_TEST_CTRL_BUILD_RUNNER_LOCAL_ANDROID_SDK_ROOT) {
    return env.APP_TEST_CTRL_BUILD_RUNNER_LOCAL_ANDROID_SDK_ROOT;
  }
  if (env.ANDROID_SDK_ROOT) return env.ANDROID_SDK_ROOT;
  if (env.ANDROID_HOME) return env.ANDROID_HOME;
  const home = os.userInfo().homedir;
  return firstExistingDirectory(process.platform === "darwin"
    ? [path.join(home, "Library/Android/sdk")]
    : process.platform === "linux"
      ? [path.join(home, "Android/Sdk"), "/opt/android-sdk"]
      : []);
}

function discoverApkAnalyzer(sdkRoot: string): string | undefined {
  const cmdlineRoot = path.join(sdkRoot, "cmdline-tools");
  const versions = boundedVersionDirectories(cmdlineRoot, 128);
  const latest = path.join(cmdlineRoot, "latest", "bin", "apkanalyzer");
  if (isFile(latest)) return latest;
  for (const version of versions) {
    const candidate = path.join(cmdlineRoot, version, "bin", "apkanalyzer");
    if (isFile(candidate)) return candidate;
  }
  const legacy = path.join(sdkRoot, "tools", "bin", "apkanalyzer");
  return isFile(legacy) ? legacy : undefined;
}

function discoverApkSigner(sdkRoot: string): string | undefined {
  const buildToolsRoot = path.join(sdkRoot, "build-tools");
  const versions = boundedVersionDirectories(buildToolsRoot, 128);
  for (const version of versions) {
    const candidate = path.join(buildToolsRoot, version, "apksigner");
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

export function defaultDockerHost(
  platform: NodeJS.Platform = process.platform,
  homedir?: string,
  uid?: number,
): string {
  if (platform === "darwin") {
    const currentHome = homedir ?? os.userInfo().homedir;
    if (!path.isAbsolute(currentHome)) {
      throw new Error("the current user's home directory must be absolute");
    }
    return `unix://${path.join(currentHome, ".docker", "run", "docker.sock")}`;
  }
  if (platform === "linux") {
    const currentUid = uid ?? process.getuid?.();
    if (currentUid === undefined || !Number.isSafeInteger(currentUid) || currentUid < 0) {
      throw new Error("the current numeric uid is required for the Docker socket default");
    }
    return `unix:///run/user/${currentUid}/docker.sock`;
  }
  throw new Error(`no local-user Docker socket default exists for ${platform}`);
}

function dockerHost(raw: string | undefined): string {
  const value = raw || defaultDockerHost();
  if (
    !value.startsWith("unix:///")
    || /[\u0000-\u001f\u007f\\%]/.test(value)
  ) {
    throw new Error("APP_TEST_CTRL_BUILD_RUNNER_DOCKER_HOST must be an absolute unix socket URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("APP_TEST_CTRL_BUILD_RUNNER_DOCKER_HOST must be a normalized unix socket URL");
  }
  if (
    parsed.protocol !== "unix:"
    || parsed.username
    || parsed.password
    || parsed.hostname
    || parsed.port
    || parsed.search
    || parsed.hash
    || !parsed.pathname.startsWith("/")
    || parsed.pathname.includes("//")
    || parsed.pathname.split("/").some((part) => part === "." || part === "..")
    || `unix://${parsed.pathname}` !== value
  ) {
    throw new Error("APP_TEST_CTRL_BUILD_RUNNER_DOCKER_HOST must be a normalized local unix socket URL");
  }
  return `unix://${parsed.pathname}`;
}

function ociRuntime(raw: string | undefined): string {
  const value = raw || "runc";
  if (!OCI_RUNTIME_RE.test(value)) {
    throw new Error(
      "APP_TEST_CTRL_BUILD_RUNNER_OCI_RUNTIME must be a normalized lowercase runtime name",
    );
  }
  return value;
}

export interface CommonRunnerConfig {
  backend: "docker" | "local_trusted";
  javaHome: string;
  androidSdkRoot: string;
  apkAnalyzer: string;
  apkSigner: string;
  maxOutputBytes: number;
}

export interface DockerRunnerConfig extends CommonRunnerConfig {
  backend: "docker";
  dockerBin: string;
  dockerHost: string;
  ociRuntime: string;
  image: string;
  maxMemoryMb: number;
  maxCpus: number;
  maxPids: number;
  gradleHomeMb: number;
  tmpMb: number;
}

export interface LocalTrustedRunnerConfig extends CommonRunnerConfig {
  backend: "local_trusted";
}

export type RunnerConfig = DockerRunnerConfig | LocalTrustedRunnerConfig;

export interface ConfigResult {
  config?: RunnerConfig;
  requestedBackend: "docker" | "local_trusted" | "invalid";
  errors: string[];
}

export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const errors: string[] = [];
  let config: RunnerConfig | undefined;
  const requested = env.APP_TEST_CTRL_BUILD_RUNNER_BACKEND || "docker";
  const requestedBackend = requested === "docker" || requested === "local_trusted"
    ? requested
    : "invalid";
  try {
    const backend = requested;
    if (backend !== "docker" && backend !== "local_trusted") {
      throw new Error("APP_TEST_CTRL_BUILD_RUNNER_BACKEND must be docker or local_trusted");
    }
    const maxOutputBytes = boundedInteger(
      env.APP_TEST_CTRL_BUILD_RUNNER_MAX_OUTPUT_BYTES,
      1024 * 1024,
      4096,
      4 * 1024 * 1024,
      "APP_TEST_CTRL_BUILD_RUNNER_MAX_OUTPUT_BYTES",
    );
    if (backend === "local_trusted") {
      const javaHome = discoverJavaHome(env);
      const androidSdkRoot = discoverAndroidSdkRoot(env);
      const apkAnalyzer = env.APP_TEST_CTRL_BUILD_RUNNER_LOCAL_APKANALYZER
        ?? (androidSdkRoot ? discoverApkAnalyzer(androidSdkRoot) : undefined);
      const apkSigner = env.APP_TEST_CTRL_BUILD_RUNNER_LOCAL_APKSIGNER
        ?? (androidSdkRoot ? discoverApkSigner(androidSdkRoot) : undefined);
      config = {
        backend,
        javaHome: localPath(
          javaHome,
          "APP_TEST_CTRL_BUILD_RUNNER_LOCAL_JAVA_HOME",
        ),
        androidSdkRoot: localPath(
          androidSdkRoot,
          "APP_TEST_CTRL_BUILD_RUNNER_LOCAL_ANDROID_SDK_ROOT",
        ),
        apkAnalyzer: localPath(
          apkAnalyzer,
          "APP_TEST_CTRL_BUILD_RUNNER_LOCAL_APKANALYZER",
        ),
        apkSigner: localPath(
          apkSigner,
          "APP_TEST_CTRL_BUILD_RUNNER_LOCAL_APKSIGNER",
        ),
        maxOutputBytes,
      };
      return { config, requestedBackend, errors };
    }
    const dockerBin = env.APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN || "";
    if (!dockerBin) throw new Error("APP_TEST_CTRL_BUILD_RUNNER_DOCKER_BIN is required");
    const image = env.APP_TEST_CTRL_BUILD_RUNNER_IMAGE || "";
    if (!PINNED_IMAGE_RE.test(image)) {
      throw new Error("APP_TEST_CTRL_BUILD_RUNNER_IMAGE must use name@sha256:<64 lowercase hex>");
    }
    config = {
      backend,
      dockerBin,
      dockerHost: dockerHost(env.APP_TEST_CTRL_BUILD_RUNNER_DOCKER_HOST),
      ociRuntime: ociRuntime(env.APP_TEST_CTRL_BUILD_RUNNER_OCI_RUNTIME),
      image,
      javaHome: containerPath(
        env.APP_TEST_CTRL_BUILD_RUNNER_JAVA_HOME,
        "/opt/java/openjdk",
        "APP_TEST_CTRL_BUILD_RUNNER_JAVA_HOME",
      ),
      androidSdkRoot: containerPath(
        env.APP_TEST_CTRL_BUILD_RUNNER_ANDROID_SDK_ROOT,
        "/opt/android-sdk",
        "APP_TEST_CTRL_BUILD_RUNNER_ANDROID_SDK_ROOT",
      ),
      apkAnalyzer: containerPath(
        env.APP_TEST_CTRL_BUILD_RUNNER_APKANALYZER,
        "/opt/android-sdk/cmdline-tools/latest/bin/apkanalyzer",
        "APP_TEST_CTRL_BUILD_RUNNER_APKANALYZER",
      ),
      apkSigner: containerPath(
        env.APP_TEST_CTRL_BUILD_RUNNER_APKSIGNER,
        "/opt/android-sdk/build-tools/latest/apksigner",
        "APP_TEST_CTRL_BUILD_RUNNER_APKSIGNER",
      ),
      maxMemoryMb: boundedInteger(
        env.APP_TEST_CTRL_BUILD_RUNNER_MEMORY_MB,
        4096,
        512,
        16_384,
        "APP_TEST_CTRL_BUILD_RUNNER_MEMORY_MB",
      ),
      maxCpus: boundedInteger(
        env.APP_TEST_CTRL_BUILD_RUNNER_CPUS,
        2,
        1,
        16,
        "APP_TEST_CTRL_BUILD_RUNNER_CPUS",
      ),
      maxPids: boundedInteger(
        env.APP_TEST_CTRL_BUILD_RUNNER_PIDS,
        256,
        32,
        1024,
        "APP_TEST_CTRL_BUILD_RUNNER_PIDS",
      ),
      gradleHomeMb: boundedInteger(
        env.APP_TEST_CTRL_BUILD_RUNNER_GRADLE_HOME_MB,
        4096,
        512,
        16_384,
        "APP_TEST_CTRL_BUILD_RUNNER_GRADLE_HOME_MB",
      ),
      tmpMb: boundedInteger(
        env.APP_TEST_CTRL_BUILD_RUNNER_TMP_MB,
        512,
        64,
        4096,
        "APP_TEST_CTRL_BUILD_RUNNER_TMP_MB",
      ),
      maxOutputBytes,
    };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { ...(config ? { config } : {}), requestedBackend, errors };
}

export function imageDigest(image: string): string {
  const marker = "@sha256:";
  const index = image.lastIndexOf(marker);
  if (index < 1) throw new Error("build image is not pinned");
  return image.slice(index + marker.length);
}
