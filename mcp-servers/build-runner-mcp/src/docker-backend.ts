import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  BackendIdentity,
  BuildBackend,
  BuildCommandOptions,
  CapabilityResult,
  DockerIdentity,
} from "./backend.js";
import { domainHashJson, shortHash } from "./canonical.js";
import { imageDigest, type DockerRunnerConfig } from "./config.js";
import { cleanDiagnostic } from "./diagnostic.js";
import { ProcessRunner, type ProcessResult } from "./process-runner.js";
import {
  assertSafeAncestorChain,
  canonicalTrustedExecutable,
  readStableRegularFile,
} from "./safe-fs.js";
import {
  TOOLCHAIN_PROBE,
  TOOLCHAIN_PROBE_SCRIPT_SHA256,
  verifyToolchainProbeOutput,
} from "./toolchain-probe.js";

const INTERNAL_TIMEOUT_MS = 8_000;
const INTERNAL_OUTPUT_BYTES = 256 * 1024;
const CONTAINER_ID_RE = /^[a-f0-9]{64}$/;
const OWNER_LABEL = "io.app-test-ctrl.build-runner.owner";
const RUN_LABEL = "io.app-test-ctrl.build-runner.run";
const PURPOSE_LABEL = "io.app-test-ctrl.build-runner.purpose";
const CONTAINER_NAME_PREFIX = "app-test-ctrl-";
const CLOSE_WAIT_MS = 30_000;
const PRODUCTION_OWNED_SWEEP_SETTLE_MS = 500;
const MAX_OWNED_CONTAINERS = 256;
const OWNED_CONTAINER_CLEANUP_UNPROVEN = "DOCKER_OWNED_CONTAINER_CLEANUP_UNPROVEN";

export const GRADLE_ENTRYPOINT = `#!/bin/sh
set -eu
umask 077
cache_seed_root=/cache-seed
if [ -d "$cache_seed_root/wrapper" ]; then
  mkdir -p "$GRADLE_USER_HOME/wrapper"
  cp -R "$cache_seed_root/wrapper/." "$GRADLE_USER_HOME/wrapper/"
  chmod -R u+rwX "$GRADLE_USER_HOME/wrapper"
fi
exec "$@"
`;

export const ISOLATION_PROBE = `#!/bin/sh
set -eu
umask 077
test ! -e /var/run/docker.sock
test ! -e /run/docker.sock
grep -Eq '^Seccomp:[[:space:]]*2$' /proc/self/status
if env | grep -E '^(GOOGLE_APPLICATION_CREDENTIALS|FIREBASE_TOKEN|GH_TOKEN|SSH_AUTH_SOCK|AWS_SECRET_ACCESS_KEY|APP_TEST_CTRL_PROBE_CANARY)=' >/dev/null; then
  exit 70
fi
if cat /workspace/forbidden-link >/dev/null 2>&1; then
  exit 71
fi
if printf 'forbidden' > /app-test-ctrl-forbidden 2>/dev/null; then
  exit 72
fi
if printf 'changed' > /cache-seed/sentinel 2>/dev/null; then
  exit 74
fi
for interface in /sys/class/net/*; do
  test "$(basename "$interface")" = lo || exit 73
done
printf '%s' "$1" > /workspace/allowed
(sleep 30) &
printf 'probe-ok'
`;

export type {
  BuildBackend,
  CapabilityResult,
  DockerIdentity,
} from "./backend.js";

interface BindMountPlan {
  source: string;
  target: string;
  readOnly: boolean;
}

interface TmpfsPlan {
  target: string;
  options: string;
}

interface ContainerPlan {
  name: string;
  labels: Readonly<Record<string, string>>;
  purpose: "probe" | "toolchain" | "gradle" | "artifact";
  image: string;
  imageId: string;
  runtime: string;
  user: string;
  workdir: string;
  environment: readonly string[];
  mounts: readonly BindMountPlan[];
  tmpfs: readonly TmpfsPlan[];
  entrypoint: string;
  command: readonly string[];
  pidsLimit: number;
  memoryMb: number;
  cpus: number;
}

type JsonObject = Record<string, unknown>;

export interface SocketIdentity {
  device: number;
  inode: number;
  uid: number;
  gid: number;
  mode: number;
}

export interface DockerBackendDependencies {
  /**
   * Host-runtime attestation dependency. Production callers must use the
   * default; the injectable form exists so unit tests can run in sandboxes
   * where creating a Unix-domain socket is forbidden.
   */
  readSocketIdentity?(socketPath: string): Promise<SocketIdentity>;
  /**
   * Test-only positive-path seam. Production construction deliberately omits
   * this dependency until the host workspace mount has an enforceable and
   * independently verifiable disk quota.
   */
  testOnlyAttestHostWorkspaceDiskQuota?(): Promise<boolean>;
  /**
   * Test-only lifecycle seam. Production construction must omit this so every
   * Docker CLI process is owned by the backend's private ProcessRunner.
   */
  testOnlyProcessRunner?: Pick<ProcessRunner, "run" | "cleanup" | "close">;
  /**
   * Test-only timing seam for fake-daemon cleanup tests. Production callers
   * must omit it; it is deliberately absent from RunnerConfig and MCP inputs.
   */
  testOnlyOwnedSweepSettleMs?: number;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function dockerEnvironment(config: DockerRunnerConfig, configDirectory: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/var/empty",
    DOCKER_CONFIG: configDirectory,
    DOCKER_HOST: config.dockerHost,
    LANG: "C",
    LC_ALL: "C",
  };
}

function jsonObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function emptyArrayOrNull(value: unknown): boolean {
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}

function emptyObjectOrNull(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const object = jsonObject(value);
  return object !== undefined && Object.keys(object).length === 0;
}

function normalizedOptionSet(value: string): string[] {
  return value.split(",").filter(Boolean).sort();
}

function environmentName(value: string): string {
  return value.slice(0, value.indexOf("="));
}

function hasUniqueEnvironmentNames(values: readonly string[]): boolean {
  const names = values.map(environmentName);
  return names.every(Boolean) && new Set(names).size === names.length;
}

function inspectAssertion(condition: boolean, code: string): asserts condition {
  if (!condition) throw new Error(`docker inspect rejected container: ${code}`);
}

class DockerCleanupRuntimeIdentityError extends Error {
  constructor(cause: unknown) {
    super("Docker cleanup runtime identity drifted from its initialized proof", { cause });
    this.name = "DockerCleanupRuntimeIdentityError";
  }
}

async function hashBoundedRegularFile(file: string, label: string): Promise<string> {
  return (await readStableRegularFile(file, label, {
    maxBytes: 512 * 1024 * 1024,
    allowRootOwner: true,
  })).sha256;
}

export class DockerBackend implements BuildBackend {
  readonly backend = "docker" as const;
  readonly config: DockerRunnerConfig;
  #dockerBin?: string;
  #configDirectory?: string;
  #ownerId?: string;
  #dockerCliSha256?: string;
  #dockerSocketPath?: string;
  #dockerSocketIdentity?: SocketIdentity;
  readonly #readSocketIdentityOverride?: DockerBackendDependencies["readSocketIdentity"];
  readonly #testOnlyHostWorkspaceDiskQuotaAttestor?:
    DockerBackendDependencies["testOnlyAttestHostWorkspaceDiskQuota"];
  readonly #processRunner: Pick<ProcessRunner, "run" | "cleanup" | "close">;
  readonly #ownedSweepSettleMs: number;
  #verifiedImageId?: string;
  readonly #activeContainers = new Set<string>();
  readonly #activeRunControllers = new Map<string, AbortController>();
  #activeRuns = 0;
  #initializing = false;
  #closing = false;
  #containerCleanupPoisoned = false;
  #containerCleanupComplete = false;
  #closePromise?: Promise<void>;
  readonly #idleWaiters = new Set<() => void>();

  constructor(config: DockerRunnerConfig, dependencies: DockerBackendDependencies = {}) {
    // The caller may retain its input object. Copy and freeze it so an await in
    // probe/container setup cannot execute one path and attest a later mutation.
    this.config = Object.freeze({ ...config });
    const testOnlyOwnedSweepSettleMs = dependencies.testOnlyOwnedSweepSettleMs;
    this.#ownedSweepSettleMs = positiveSafeInteger(
      testOnlyOwnedSweepSettleMs === undefined
        ? PRODUCTION_OWNED_SWEEP_SETTLE_MS
        : testOnlyOwnedSweepSettleMs,
      "testOnlyOwnedSweepSettleMs",
    );
    this.#readSocketIdentityOverride = dependencies.readSocketIdentity;
    this.#testOnlyHostWorkspaceDiskQuotaAttestor =
      dependencies.testOnlyAttestHostWorkspaceDiskQuota;
    this.#processRunner = dependencies.testOnlyProcessRunner ?? new ProcessRunner();
  }

  async initialize(): Promise<void> {
    if (this.#closing) throw new Error("Docker backend is closing or closed");
    if (this.#configDirectory || this.#initializing) {
      throw new Error("Docker backend is already initialized or initializing");
    }
    this.#initializing = true;
    let configDirectory: string | undefined;
    try {
      const dockerBin = await canonicalTrustedExecutable(
        this.config.dockerBin,
        "Docker executable",
      );
      const dockerCliSha256 = await hashBoundedRegularFile(dockerBin, "Docker executable");
      const socketUrl = new URL(this.config.dockerHost);
      if (socketUrl.protocol !== "unix:" || socketUrl.hostname || !socketUrl.pathname.startsWith("/")) {
        throw new Error("Docker host must identify one local Unix socket");
      }
      const dockerSocketPath = decodeURIComponent(socketUrl.pathname);
      const dockerSocketIdentity = await this.#attestSocket(dockerSocketPath);
      configDirectory = await mkdtemp(path.join(os.tmpdir(), "app-test-ctrl-docker-config-"));
      await writeFile(path.join(configDirectory, "config.json"), "{}\n", { mode: 0o600, flag: "wx" });
      if (this.#closing) throw new Error("Docker backend closed during initialization");
      this.#dockerBin = dockerBin;
      this.#dockerCliSha256 = dockerCliSha256;
      this.#dockerSocketPath = dockerSocketPath;
      this.#dockerSocketIdentity = dockerSocketIdentity;
      this.#configDirectory = configDirectory;
      this.#ownerId = randomBytes(16).toString("hex");
      configDirectory = undefined;
    } finally {
      this.#initializing = false;
      if (configDirectory) {
        await rm(configDirectory, { recursive: true, force: false }).catch(() => undefined);
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (!this.#configDirectory) {
      this.#closing = true;
      await this.#processRunner.close();
      return;
    }
    this.#closing = true;
    const closing = this.#closeInternal();
    this.#closePromise = closing;
    try {
      await closing;
    } finally {
      if (this.#closePromise === closing) this.#closePromise = undefined;
    }
  }

  async #closeInternal(): Promise<void> {
    // Stop every admitted Docker CLI process before attempting removal. In
    // particular this closes the race where `docker create` was admitted but
    // the daemon had not registered its pre-generated name yet.
    if (!this.#containerCleanupComplete) {
      for (const controller of this.#activeRunControllers.values()) {
        controller.abort(new Error("Docker backend is closing"));
      }
      for (const name of [...this.#activeContainers]) {
        await this.#removeAndConfirmAbsent(name, false).catch(() => undefined);
      }

      if (this.#activeRuns > 0) {
        let idleResolver: (() => void) | undefined;
        const idle = new Promise<boolean>((resolve) => {
          idleResolver = () => resolve(true);
          this.#idleWaiters.add(idleResolver);
        });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), CLOSE_WAIT_MS);
        });
        const becameIdle = await Promise.race([idle, timedOut]);
        if (timeout) clearTimeout(timeout);
        if (idleResolver) this.#idleWaiters.delete(idleResolver);
        if (!becameIdle || this.#activeRuns > 0) {
          // Do one last removal pass before reporting failure. The caller must
          // not intentionally terminate the process when this proof fails.
          for (const name of [...this.#activeContainers]) {
            await this.#removeAndConfirmAbsent(name, false).catch(() => undefined);
          }
          throw new Error("Docker backend close timed out waiting for active runs");
        }
      }

      // A timed-out Docker CLI is not forgotten by run(). Recover or retain
      // its poison before admitting the cleanup commands below. A failed proof
      // keeps every Docker identity intact so a later close() can retry.
      await this.#processRunner.cleanup();

      // A killed Docker CLI does not prove that the daemon abandoned an already
      // accepted create request. Once every admitted run has settled, sweep by
      // the unguessable process-owner label and require repeated empty listings
      // across a short quiescence window before forgetting any generated name.
      await this.#sweepOwnedContainersAndConfirmNone();

      const cleanupErrors: unknown[] = [];
      for (const name of [...this.#activeContainers]) {
        try {
          await this.#removeAndConfirmAbsent(name, true);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length > 0 || this.#activeContainers.size > 0) {
        throw new Error("Docker backend close could not prove all owned containers were removed", {
          cause: cleanupErrors[0],
        });
      }
      await this.#sweepOwnedContainersAndConfirmNone();
      await this.#assertCleanupRuntimeIdentity();
      this.#containerCleanupPoisoned = false;
      this.#containerCleanupComplete = true;
    }

    // No Docker command is admitted after this point. close() is retryable and
    // proves that the backend retains no child or process-group residue.
    await this.#processRunner.close();
    const target = this.#configDirectory;
    if (!target) throw new Error("Docker config staging identity disappeared during close");
    await rm(target, { recursive: true, force: false });
    this.#configDirectory = undefined;
    this.#ownerId = undefined;
    this.#dockerCliSha256 = undefined;
    this.#dockerSocketPath = undefined;
    this.#dockerSocketIdentity = undefined;
    this.#verifiedImageId = undefined;
    this.#dockerBin = undefined;
  }

  #finishRun(): void {
    this.#activeRuns -= 1;
    if (this.#activeRuns !== 0) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }

  #assertContainerAdmission(): void {
    if (this.#containerCleanupPoisoned) {
      throw new Error(
        "Docker owned-container cleanup is unproven; close must prove absence before another container operation",
      );
    }
    if (this.#closing) throw new Error("Docker backend is closing");
  }

  #poisonContainerAdmission(): void {
    this.#containerCleanupPoisoned = true;
    this.#verifiedImageId = undefined;
    const reason = new Error(
      "Docker owned-container cleanup is unproven; no further container operation is admitted",
    );
    for (const controller of this.#activeRunControllers.values()) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
  }

  #runtime(): { dockerBin: string; env: NodeJS.ProcessEnv } {
    if (!this.#dockerBin || !this.#configDirectory) {
      throw new Error("Docker backend has not been initialized");
    }
    return {
      dockerBin: this.#dockerBin,
      env: dockerEnvironment(this.config, this.#configDirectory),
    };
  }

  async #readSocketIdentity(socketPath: string): Promise<SocketIdentity> {
    const [linkStatus, targetStatus] = await Promise.all([lstat(socketPath), stat(socketPath)]);
    if (linkStatus.isSymbolicLink() || !linkStatus.isSocket() || !targetStatus.isSocket()) {
      throw new Error("Docker host path must be a non-symlink Unix socket");
    }
    if (linkStatus.dev !== targetStatus.dev || linkStatus.ino !== targetStatus.ino) {
      throw new Error("Docker socket link and target identity differ");
    }
    const uid = process.getuid?.();
    if (uid === undefined || linkStatus.uid !== uid) {
      throw new Error("Docker socket must be owned by the current user");
    }
    const mode = linkStatus.mode & 0o777;
    if (mode !== 0o600) {
      throw new Error("Docker socket permissions must be exactly 0600");
    }
    return {
      device: linkStatus.dev,
      inode: linkStatus.ino,
      uid: linkStatus.uid,
      gid: linkStatus.gid,
      mode,
    };
  }

  async #attestSocket(socketPath: string): Promise<SocketIdentity> {
    const socketParent = path.dirname(socketPath);
    await assertSafeAncestorChain(socketParent, "Docker socket");
    const identity = await (this.#readSocketIdentityOverride
      ? this.#readSocketIdentityOverride(socketPath)
      : this.#readSocketIdentity(socketPath));
    // Recheck after reading the socket identity so an ancestor swapped by a
    // concurrent local actor cannot bridge the validation/use boundary.
    await assertSafeAncestorChain(socketParent, "Docker socket");
    const uid = process.getuid?.();
    if (uid === undefined
      || identity.uid !== uid
      || identity.mode !== 0o600
      || ![identity.device, identity.inode, identity.uid, identity.gid, identity.mode]
        .every((value) => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error("Docker socket attestation returned an invalid identity");
    }
    return { ...identity };
  }

  async #verifyRuntimeFiles(): Promise<void> {
    if (!this.#dockerBin
      || !this.#dockerCliSha256
      || !this.#dockerSocketPath
      || !this.#dockerSocketIdentity) {
      throw new Error("Docker runtime identity is unavailable");
    }
    const cliHash = await hashBoundedRegularFile(this.#dockerBin, "Docker executable");
    if (cliHash !== this.#dockerCliSha256) throw new Error("Docker CLI content changed after initialization");
    const socketIdentity = await this.#attestSocket(this.#dockerSocketPath);
    if (!jsonEqual(socketIdentity, this.#dockerSocketIdentity)) {
      throw new Error("Docker socket identity changed after initialization");
    }
  }

  async #assertCleanupRuntimeIdentity(): Promise<void> {
    try {
      await this.#verifyRuntimeFiles();
    } catch (error) {
      throw new DockerCleanupRuntimeIdentityError(error);
    }
  }

  async #runCleanupDockerCommand(args: readonly string[]): Promise<ProcessResult> {
    const runtime = this.#runtime();
    await this.#assertCleanupRuntimeIdentity();
    let result: ProcessResult;
    try {
      result = await this.#processRunner.run(runtime.dockerBin, args, {
        env: runtime.env,
        timeoutMs: INTERNAL_TIMEOUT_MS,
        maxOutputBytes: INTERNAL_OUTPUT_BYTES,
      });
    } catch (error) {
      // A command failure does not relax the identity binding. Prefer an
      // observed identity drift over retrying against a different daemon.
      await this.#assertCleanupRuntimeIdentity();
      throw error;
    }
    await this.#assertCleanupRuntimeIdentity();
    return result;
  }

  async #exec(
    args: readonly string[],
    timeoutMs = INTERNAL_TIMEOUT_MS,
    allowDuringClose = false,
  ): Promise<ProcessResult> {
    if (this.#closing && !allowDuringClose) {
      throw new Error("Docker backend is closing");
    }
    if (this.#containerCleanupPoisoned && !allowDuringClose) {
      throw new Error("Docker owned-container cleanup is unproven");
    }
    const runtime = this.#runtime();
    return this.#processRunner.run(runtime.dockerBin, args, {
      env: runtime.env,
      timeoutMs,
      maxOutputBytes: INTERNAL_OUTPUT_BYTES,
    });
  }

  async #hostWorkspaceDiskQuotaEnforced(): Promise<boolean> {
    try {
      return this.#testOnlyHostWorkspaceDiskQuotaAttestor !== undefined
        && await this.#testOnlyHostWorkspaceDiskQuotaAttestor() === true;
    } catch {
      return false;
    }
  }

  async #assertHostWorkspaceDiskQuota(): Promise<void> {
    if (await this.#hostWorkspaceDiskQuotaEnforced()) return;
    this.#verifiedImageId = undefined;
    throw new Error("HOST_WORKSPACE_DISK_QUOTA_UNENFORCED");
  }

  async probe(): Promise<CapabilityResult> {
    const reasons: string[] = [];
    let toolchainProbeSha256: string | undefined;
    this.#verifiedImageId = undefined;
    if (this.#containerCleanupPoisoned) {
      return {
        available: false,
        backend: "docker",
        reasons: [OWNED_CONTAINER_CLEANUP_UNPROVEN],
      };
    }
    if (!(await this.#hostWorkspaceDiskQuotaEnforced())) {
      return {
        available: false,
        backend: "docker",
        reasons: ["HOST_WORKSPACE_DISK_QUOTA_UNENFORCED"],
      };
    }
    try {
      await this.#verifyRuntimeFiles();
      const version = await this.#exec([
        "version",
        "--format",
        "{{.Client.Version}}|{{.Server.Version}}",
      ]);
      const versionParts = version.stdout.trim().split("|");
      if (version.exitCode !== 0
        || versionParts.length !== 2
        || versionParts.some((entry) => !entry)) {
        reasons.push(`DOCKER_DAEMON_UNAVAILABLE:${cleanDiagnostic(version.stderr || version.stdout)}`);
        return { available: false, backend: "docker", reasons };
      }
      const [dockerClientVersion, dockerServerVersion] = versionParts as [string, string];
      const info = await this.#exec([
        "info",
        "--format",
        "{\"os\":{{json .OSType}},\"security_options\":{{json .SecurityOptions}},\"runtimes\":{{json .Runtimes}}}",
      ]);
      if (info.exitCode !== 0) {
        reasons.push(`DOCKER_INFO_FAILED:${cleanDiagnostic(info.stderr || info.stdout)}`);
        return { available: false, backend: "docker", reasons };
      }
      let infoObject: JsonObject | undefined;
      try {
        infoObject = jsonObject(JSON.parse(info.stdout));
      } catch {
        // The bounded template must round-trip as one JSON object.
      }
      if (!infoObject) {
        reasons.push("DOCKER_INFO_INVALID");
        return { available: false, backend: "docker", reasons };
      }
      const osType = infoObject.os;
      if (osType !== "linux") reasons.push("DOCKER_OS_MUST_BE_LINUX");
      const securityOptions = infoObject.security_options;
      const parsedSecurityOptions = stringArray(securityOptions);
      if (!parsedSecurityOptions) {
        reasons.push("DOCKER_SECURITY_OPTIONS_INVALID");
      } else {
        const seccompOptions = parsedSecurityOptions.filter((entry) =>
          entry.toLowerCase().startsWith("name=seccomp"));
        if (seccompOptions.some((entry) => /(?:^|,)profile=unconfined(?:,|$)/i.test(entry))) {
          reasons.push("DOCKER_SECCOMP_UNCONFINED");
        }
        if (seccompOptions.length !== 1
          || seccompOptions[0]?.toLowerCase() !== "name=seccomp,profile=builtin") {
          reasons.push("DOCKER_SECCOMP_BUILTIN_REQUIRED");
        }
      }
      const runtimes = jsonObject(infoObject.runtimes);
      const runtimeDescriptor = runtimes?.[this.config.ociRuntime];
      if (!runtimes || !Object.prototype.hasOwnProperty.call(runtimes, this.config.ociRuntime)) {
        reasons.push("DOCKER_OCI_RUNTIME_NOT_REGISTERED");
      } else if (!jsonObject(runtimeDescriptor)) {
        reasons.push("DOCKER_OCI_RUNTIME_DESCRIPTOR_INVALID");
      }

      const inspected = await this.#exec([
        "image",
        "inspect",
        "--format",
        "{{.Id}}|{{join .RepoDigests \",\"}}|{{.Os}}",
        this.config.image,
      ]);
      if (inspected.exitCode !== 0) {
        reasons.push(`PINNED_IMAGE_UNAVAILABLE:${cleanDiagnostic(inspected.stderr || inspected.stdout)}`);
        return { available: false, backend: "docker", reasons };
      }
      const [id = "", repoDigests = "", imageOs = ""] = inspected.stdout.trim().split("|");
      const expectedDigest = imageDigest(this.config.image);
      if (!/^sha256:[a-f0-9]{64}$/.test(id)) reasons.push("DOCKER_IMAGE_ID_INVALID");
      if (!repoDigests.split(",").some((entry) => entry.endsWith(`@sha256:${expectedDigest}`))) {
        reasons.push("DOCKER_IMAGE_DIGEST_MISMATCH");
      }
      if (imageOs !== "linux") reasons.push("DOCKER_IMAGE_OS_MUST_BE_LINUX");
      if (reasons.length === 0) {
        this.#verifiedImageId = id.slice("sha256:".length);
        try {
          await this.#runIsolationProbe();
        } catch (error) {
          reasons.push(`DOCKER_ISOLATION_PROBE_FAILED:${cleanDiagnostic(error instanceof Error ? error.message : String(error))}`);
        }
        if (reasons.length === 0) {
          try {
            toolchainProbeSha256 = await this.#runToolchainProbe();
          } catch (error) {
            reasons.push(`DOCKER_TOOLCHAIN_PROBE_FAILED:${cleanDiagnostic(error instanceof Error ? error.message : String(error))}`);
          }
        }
      }
      if (reasons.length > 0) {
        this.#verifiedImageId = undefined;
        return { available: false, backend: "docker", reasons };
      }
      return {
        available: true,
        backend: "docker",
        reasons: [],
        identity: {
          backend: "docker",
          dockerClientVersion,
          dockerServerVersion,
          dockerCliSha256: this.#dockerCliSha256!,
          dockerSocketIdentitySha256: domainHashJson(
            "crashfix-docker-socket-identity/v1",
            this.#dockerSocketIdentity,
          ),
          ociRuntime: this.config.ociRuntime,
          ociRuntimeDescriptorSha256: domainHashJson(
            "crashfix-docker-oci-runtime-descriptor/v1",
            {
              name: this.config.ociRuntime,
              descriptor: runtimeDescriptor,
            },
          ),
          toolchainProbeSha256: toolchainProbeSha256!,
          dockerImageId: id.slice("sha256:".length),
          dockerImageDigest: expectedDigest,
          platform: "linux",
          securityOptionsSha256: domainHashJson(
            "crashfix-docker-security-options/v1",
            securityOptions,
          ),
        },
      };
    } catch (error) {
      this.#verifiedImageId = undefined;
      reasons.push(`DOCKER_PROBE_FAILED:${cleanDiagnostic(error instanceof Error ? error.message : String(error))}`);
      return { available: false, backend: "docker", reasons };
    }
  }

  executionProfile(identity: BackendIdentity): Record<string, unknown> {
    if (identity.backend !== "docker") {
      throw new Error("Docker execution profile requires a Docker identity");
    }
    return {
      schema_version: "crashfix-docker-sandbox-profile/v1",
      backend: "docker",
      docker_identity: { ...identity },
      oci_runtime: identity.ociRuntime,
      oci_runtime_descriptor_ref: identity.ociRuntimeDescriptorSha256,
      image_digest: identity.dockerImageDigest,
      image_id: identity.dockerImageId,
      network: "none",
      root_filesystem: "read-only",
      capabilities: "drop-all",
      no_new_privileges: true,
      seccomp_profile: "daemon-builtin+runtime-canary",
      init: true,
      pull_policy: "never",
      log_driver: "none",
      healthcheck: "disabled",
      user: "non-root-host-identity",
      pids_limit: this.config.maxPids,
      memory_mb: this.config.maxMemoryMb,
      cpus: this.config.maxCpus,
      mounts: [
        { source: "<WORKSPACE>", target: "/workspace", mode: "rw" },
        { source: "<SEALED_CACHE_SEED>", target: "/cache-seed", mode: "ro" },
        { source: "<RUNNER_ENTRYPOINT>", target: "/app-test-ctrl-entrypoint", mode: "ro" },
      ],
      tmpfs: [
        { target: "/tmp", size_mb: this.config.tmpMb, noexec: true },
        { target: "/home/build", size_mb: 64, noexec: true },
        { target: "/gradle-home", size_mb: this.config.gradleHomeMb, noexec: false },
      ],
      cache_model: "sealed-read-only-dependency-seed+fresh-bounded-private-overlay",
      isolation_probe_sha256: domainHashJson(
        "crashfix-docker-isolation-probe/v1",
        ISOLATION_PROBE,
      ),
      toolchain_probe_script_sha256: TOOLCHAIN_PROBE_SCRIPT_SHA256,
      toolchain_probe_ref: identity.toolchainProbeSha256,
    };
  }

  /** @deprecated Test compatibility alias; generic callers use executionProfile. */
  sandboxProfile(identity: DockerIdentity): Record<string, unknown> {
    return this.executionProfile(identity);
  }

  #nonRootIdentity(): { uid: number; gid: number; user: string } {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined) {
      throw new Error("Docker runner requires numeric uid/gid");
    }
    if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid <= 0 || gid <= 0) {
      throw new Error("Docker runner requires a non-root numeric uid/gid");
    }
    return { uid, gid, user: `${uid}:${gid}` };
  }

  #containerPlan(options: {
    purpose: ContainerPlan["purpose"];
    workdir: string;
    environment: readonly string[];
    mounts: readonly BindMountPlan[];
    tmpfs: readonly TmpfsPlan[];
    entrypoint: string;
    command: readonly string[];
    pidsLimit: number;
    memoryMb: number;
    cpus: number;
  }): ContainerPlan {
    this.#assertContainerAdmission();
    if (!this.#ownerId || !this.#verifiedImageId) {
      throw new Error("Docker image and isolation capabilities must be probed before container creation");
    }
    const { user } = this.#nonRootIdentity();
    const runId = randomBytes(16).toString("hex");
    const name = `${CONTAINER_NAME_PREFIX}${runId}`;
    const labels: Record<string, string> = {
      [OWNER_LABEL]: this.#ownerId,
      [RUN_LABEL]: runId,
      [PURPOSE_LABEL]: options.purpose,
    };
    const mountTargets = new Set<string>();
    for (const mount of options.mounts) {
      if (!path.isAbsolute(mount.source)
        || !mount.target.startsWith("/")
        || /[\u0000-\u001f\u007f,]/.test(mount.source)
        || /[\u0000-\u001f\u007f,]/.test(mount.target)
        || mountTargets.has(mount.target)) {
        throw new Error("Docker bind mount plan is invalid");
      }
      mountTargets.add(mount.target);
    }
    const tmpfsTargets = new Set<string>();
    for (const tmpfs of options.tmpfs) {
      if (!tmpfs.target.startsWith("/")
        || /[\u0000-\u001f\u007f,:]/.test(tmpfs.target)
        || /[\u0000-\u001f\u007f:]/.test(tmpfs.options)
        || mountTargets.has(tmpfs.target)
        || tmpfsTargets.has(tmpfs.target)) {
        throw new Error("Docker tmpfs plan is invalid");
      }
      tmpfsTargets.add(tmpfs.target);
    }
    if (!options.workdir.startsWith("/") || !options.entrypoint.startsWith("/")) {
      throw new Error("Docker workdir and entrypoint must be absolute container paths");
    }
    if (options.environment.some((entry) =>
      !/^[A-Z][A-Z0-9_]*=[^\u0000\r\n]*$/.test(entry))
      || !hasUniqueEnvironmentNames(options.environment)) {
      throw new Error("Docker environment plan is invalid");
    }
    return {
      name,
      labels,
      purpose: options.purpose,
      image: this.config.image,
      imageId: this.#verifiedImageId,
      runtime: this.config.ociRuntime,
      user,
      workdir: options.workdir,
      environment: [...options.environment],
      mounts: options.mounts.map((mount) => ({ ...mount })),
      tmpfs: options.tmpfs.map((tmpfs) => ({ ...tmpfs })),
      entrypoint: options.entrypoint,
      command: [...options.command],
      pidsLimit: options.pidsLimit,
      memoryMb: options.memoryMb,
      cpus: options.cpus,
    };
  }

  #containerCreateArgs(plan: ContainerPlan): string[] {
    const args = [
      "create",
      "--name", plan.name,
      "--pull", "never",
      "--runtime", plan.runtime,
      "--network", "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(plan.pidsLimit),
      "--memory", `${plan.memoryMb}m`,
      "--memory-swap", `${plan.memoryMb}m`,
      "--cpus", String(plan.cpus),
      "--init",
      "--stop-timeout", "1",
      "--user", plan.user,
      "--workdir", plan.workdir,
      "--log-driver", "none",
      "--no-healthcheck",
      "--restart", "no",
    ];
    for (const [key, value] of Object.entries(plan.labels)) {
      args.push("--label", `${key}=${value}`);
    }
    for (const environment of plan.environment) args.push("--env", environment);
    for (const tmpfs of plan.tmpfs) args.push("--tmpfs", `${tmpfs.target}:${tmpfs.options}`);
    for (const mount of plan.mounts) {
      args.push(
        "--mount",
        `type=bind,src=${mount.source},dst=${mount.target},${mount.readOnly ? "ro" : "rw"}`,
      );
    }
    args.push("--entrypoint", plan.entrypoint, plan.image, ...plan.command);
    return args;
  }

  async #inspectAndVerifyContainer(plan: ContainerPlan, createdId: string): Promise<void> {
    const inspected = await this.#exec(["container", "inspect", plan.name]);
    if (inspected.exitCode !== 0) {
      throw new Error(`docker inspect failed: ${cleanDiagnostic(inspected.stderr || inspected.stdout)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(inspected.stdout);
    } catch {
      throw new Error("docker inspect returned invalid JSON");
    }
    inspectAssertion(Array.isArray(parsed) && parsed.length === 1, "TOP_LEVEL");
    const container = jsonObject(parsed[0]);
    inspectAssertion(container !== undefined, "CONTAINER_OBJECT");
    inspectAssertion(container.Id === createdId, "CONTAINER_ID");
    inspectAssertion(container.Name === `/${plan.name}`, "CONTAINER_NAME");
    inspectAssertion(container.Image === `sha256:${plan.imageId}`, "IMAGE_ID");

    const state = jsonObject(container.State);
    inspectAssertion(state !== undefined, "STATE_OBJECT");
    inspectAssertion(state.Status === "created" && state.Running === false, "STATE_NOT_CREATED");

    const config = jsonObject(container.Config);
    inspectAssertion(config !== undefined, "CONFIG_OBJECT");
    inspectAssertion(config.Image === plan.image, "IMAGE_REFERENCE");
    inspectAssertion(config.User === plan.user && !plan.user.startsWith("0:"), "NON_ROOT_USER");
    inspectAssertion(config.WorkingDir === plan.workdir, "WORKDIR");
    inspectAssertion(jsonEqual(config.Entrypoint, [plan.entrypoint]), "ENTRYPOINT");
    inspectAssertion(jsonEqual(config.Cmd, plan.command), "COMMAND");
    const labels = jsonObject(config.Labels);
    inspectAssertion(labels !== undefined, "LABELS");
    for (const [key, value] of Object.entries(plan.labels)) {
      inspectAssertion(labels[key] === value, `LABEL_${key}`);
    }
    const healthcheck = jsonObject(config.Healthcheck);
    inspectAssertion(
      healthcheck !== undefined && jsonEqual(healthcheck.Test, ["NONE"]),
      "HEALTHCHECK_NOT_DISABLED",
    );
    const actualEnvironment = stringArray(config.Env);
    inspectAssertion(actualEnvironment !== undefined, "ENVIRONMENT");
    inspectAssertion(hasUniqueEnvironmentNames(actualEnvironment), "ENVIRONMENT_DUPLICATE");
    inspectAssertion(
      actualEnvironment.length === plan.environment.length
        && jsonEqual([...actualEnvironment].sort(), [...plan.environment].sort()),
      "ENVIRONMENT_DRIFT",
    );
    inspectAssertion(
      !actualEnvironment.some((entry) =>
        /^(?:GOOGLE_APPLICATION_CREDENTIALS|FIREBASE_TOKEN|GH_TOKEN|SSH_AUTH_SOCK|AWS_SECRET_ACCESS_KEY|APP_TEST_CTRL_PROBE_CANARY|[A-Z0-9_]*(?:_TOKEN|_SECRET|_PASSWORD|_PASSWD|_CREDENTIAL|_CREDENTIALS|PRIVATE_KEY|ACCESS_KEY|AUTH_TOKEN))=/.test(entry)),
      "SECRET_ENVIRONMENT",
    );

    const hostConfig = jsonObject(container.HostConfig);
    inspectAssertion(hostConfig !== undefined, "HOST_CONFIG_OBJECT");
    inspectAssertion(hostConfig.Runtime === plan.runtime, "OCI_RUNTIME");
    inspectAssertion(hostConfig.NetworkMode === "none", "NETWORK_MODE");
    inspectAssertion(hostConfig.ReadonlyRootfs === true, "ROOT_FILESYSTEM");
    inspectAssertion(hostConfig.Privileged === false, "PRIVILEGED");
    inspectAssertion(jsonEqual(hostConfig.CapDrop, ["ALL"]), "CAP_DROP");
    inspectAssertion(emptyArrayOrNull(hostConfig.CapAdd), "CAP_ADD");
    const securityOptions = stringArray(hostConfig.SecurityOpt);
    inspectAssertion(
      securityOptions !== undefined
        && securityOptions.length === 1
        && /^no-new-privileges(?:(?:=|:)true)?$/i.test(securityOptions[0] ?? ""),
      "SECURITY_OPTIONS",
    );
    inspectAssertion(hostConfig.PidsLimit === plan.pidsLimit, "PIDS_LIMIT");
    inspectAssertion(hostConfig.Memory === plan.memoryMb * 1024 * 1024, "MEMORY_LIMIT");
    inspectAssertion(hostConfig.MemorySwap === plan.memoryMb * 1024 * 1024, "MEMORY_SWAP_LIMIT");
    inspectAssertion(hostConfig.NanoCpus === plan.cpus * 1_000_000_000, "CPU_LIMIT");
    inspectAssertion(hostConfig.Init === true, "INIT");
    const logConfig = jsonObject(hostConfig.LogConfig);
    inspectAssertion(
      logConfig !== undefined && logConfig.Type === "none" && emptyObjectOrNull(logConfig.Config),
      "LOG_DRIVER",
    );
    const restartPolicy = jsonObject(hostConfig.RestartPolicy);
    inspectAssertion(
      restartPolicy !== undefined
        && restartPolicy.Name === "no"
        && (restartPolicy.MaximumRetryCount === 0 || restartPolicy.MaximumRetryCount === undefined),
      "RESTART_POLICY",
    );
    inspectAssertion(emptyArrayOrNull(hostConfig.Binds), "LEGACY_BINDS");
    inspectAssertion(emptyArrayOrNull(hostConfig.VolumesFrom), "VOLUMES_FROM");
    inspectAssertion(emptyArrayOrNull(hostConfig.Devices), "DEVICES");
    inspectAssertion(emptyArrayOrNull(hostConfig.DeviceRequests), "DEVICE_REQUESTS");
    inspectAssertion(emptyObjectOrNull(hostConfig.PortBindings), "PORT_BINDINGS");
    inspectAssertion(hostConfig.PublishAllPorts === false, "PUBLISH_ALL_PORTS");
    inspectAssertion(
      hostConfig.PidMode === undefined || hostConfig.PidMode === null || hostConfig.PidMode === "",
      "PID_NAMESPACE",
    );
    inspectAssertion(
      hostConfig.IpcMode === undefined || hostConfig.IpcMode === null
        || hostConfig.IpcMode === "" || hostConfig.IpcMode === "private",
      "IPC_NAMESPACE",
    );
    inspectAssertion(
      hostConfig.UTSMode === undefined || hostConfig.UTSMode === null || hostConfig.UTSMode === "",
      "UTS_NAMESPACE",
    );
    inspectAssertion(
      hostConfig.CgroupnsMode === undefined || hostConfig.CgroupnsMode === null
        || hostConfig.CgroupnsMode === "" || hostConfig.CgroupnsMode === "private",
      "CGROUP_NAMESPACE",
    );
    inspectAssertion(emptyArrayOrNull(hostConfig.GroupAdd), "SUPPLEMENTARY_GROUPS");
    inspectAssertion(emptyArrayOrNull(hostConfig.DeviceCgroupRules), "DEVICE_CGROUP_RULES");

    const actualTmpfs = jsonObject(hostConfig.Tmpfs);
    inspectAssertion(actualTmpfs !== undefined, "TMPFS_OBJECT");
    inspectAssertion(Object.keys(actualTmpfs).length === plan.tmpfs.length, "TMPFS_COUNT");
    for (const expected of plan.tmpfs) {
      const actual = actualTmpfs[expected.target];
      inspectAssertion(typeof actual === "string", "TMPFS_TARGET");
      inspectAssertion(
        jsonEqual(normalizedOptionSet(actual), normalizedOptionSet(expected.options)),
        "TMPFS_OPTIONS",
      );
    }

    const actualMounts = Array.isArray(container.Mounts) ? container.Mounts : undefined;
    inspectAssertion(actualMounts !== undefined, "MOUNT_LIST");
    const mountsByTarget = new Map<string, JsonObject>();
    for (const value of actualMounts) {
      const mount = jsonObject(value);
      inspectAssertion(mount !== undefined && typeof mount.Destination === "string", "MOUNT_OBJECT");
      if (mount.Type === "tmpfs") {
        inspectAssertion(
          plan.tmpfs.some((entry) => entry.target === mount.Destination),
          "UNPLANNED_TMPFS_MOUNT",
        );
      } else {
        inspectAssertion(mount.Type === "bind", "UNPLANNED_MOUNT_TYPE");
        inspectAssertion(!mountsByTarget.has(mount.Destination), "MOUNT_DUPLICATE");
        mountsByTarget.set(mount.Destination, mount);
      }
    }
    inspectAssertion(mountsByTarget.size === plan.mounts.length, "MOUNT_COUNT");
    for (const expected of plan.mounts) {
      const actual = mountsByTarget.get(expected.target);
      inspectAssertion(actual !== undefined, "MOUNT_TARGET");
      inspectAssertion(actual.Type === "bind", "MOUNT_TYPE");
      inspectAssertion(actual.Source === expected.source, "MOUNT_SOURCE");
      inspectAssertion(actual.RW === !expected.readOnly, "MOUNT_ACCESS");
      inspectAssertion(
        actual.Mode === "" || actual.Mode === (expected.readOnly ? "ro" : "rw"),
        "MOUNT_MODE",
      );
      inspectAssertion(actual.Propagation === "rprivate", "MOUNT_PROPAGATION");
    }
    const declaredVolumes = jsonObject(config.Volumes);
    if (declaredVolumes) {
      const plannedTargets = new Set(plan.mounts.map((mount) => mount.target));
      inspectAssertion(
        Object.keys(declaredVolumes).every((target) => plannedTargets.has(target)),
        "UNPLANNED_VOLUME_DECLARATION",
      );
    }
  }

  async #removeAndConfirmAbsent(name: string, forget: boolean): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let removalFailed = false;
      try {
        const removed = await this.#runCleanupDockerCommand([
          "rm",
          "--force",
          "--volumes",
          name,
        ]);
        if (removed.exitCode !== 0) {
          removalFailed = true;
          lastError = new Error("docker container removal command failed");
        }
      } catch (error) {
        if (error instanceof DockerCleanupRuntimeIdentityError) throw error;
        removalFailed = true;
        lastError = error;
      }
      let remaining: ProcessResult;
      try {
        remaining = await this.#runCleanupDockerCommand(["container", "inspect", name]);
      } catch (error) {
        if (error instanceof DockerCleanupRuntimeIdentityError) throw error;
        lastError = error;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
          continue;
        }
        break;
      }
      const absent = remaining.exitCode !== 0
        && /no such (?:container|object)/i.test(`${remaining.stderr}\n${remaining.stdout}`);
      if (absent && !removalFailed) {
        if (forget) this.#activeContainers.delete(name);
        return;
      }
      if (absent && removalFailed && attempt === 2) {
        // Three spaced proofs cover the create-output timeout race without
        // trusting the failed rm result itself.
        if (forget) this.#activeContainers.delete(name);
        return;
      }
      if (!absent && remaining.exitCode !== 0) {
        lastError = new Error("container absence could not be proven after cleanup");
      } else if (remaining.exitCode === 0) {
        lastError = new Error("container survived forced cleanup");
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
    throw new Error("container absence could not be proven after repeated cleanup", {
      cause: lastError,
    });
  }

  async #listOwnedContainerIds(): Promise<string[]> {
    if (!this.#ownerId) throw new Error("Docker owner identity is unavailable during cleanup");
    const listed = await this.#runCleanupDockerCommand([
      "container",
      "ls",
      "--all",
      "--no-trunc",
      "--quiet",
      "--filter",
      `label=${OWNER_LABEL}=${this.#ownerId}`,
    ]);
    if (listed.exitCode !== 0) {
      throw new Error("Docker owner-label container listing failed");
    }
    const ids = listed.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    if (ids.length > MAX_OWNED_CONTAINERS
      || ids.some((id) => !CONTAINER_ID_RE.test(id))
      || new Set(ids).size !== ids.length) {
      throw new Error("Docker owner-label container listing returned invalid identities");
    }
    return ids;
  }

  async #sweepOwnedContainersAndConfirmNone(): Promise<void> {
    // Three empty snapshots separated by a settle window cover a daemon create
    // which completes just after the aborted CLI process disappears. A found
    // container resets the empty-proof count and is forcibly removed by ID.
    let consecutiveEmpty = 0;
    for (let round = 0; round < 8; round += 1) {
      const ids = await this.#listOwnedContainerIds();
      if (ids.length === 0) {
        consecutiveEmpty += 1;
        if (consecutiveEmpty === 3) return;
      } else {
        consecutiveEmpty = 0;
        for (const id of ids) await this.#removeAndConfirmAbsent(id, false);
      }
      await new Promise((resolve) => setTimeout(resolve, this.#ownedSweepSettleMs));
    }
    throw new Error("Docker owner-label cleanup did not reach a stable empty state");
  }

  async #runCreatedContainer(
    plan: ContainerPlan,
    options: { timeoutMs: number; maxOutputBytes: number },
  ): Promise<ProcessResult> {
    this.#assertContainerAdmission();
    await this.#assertHostWorkspaceDiskQuota();
    this.#assertContainerAdmission();
    this.#activeRuns += 1;
    const controller = new AbortController();
    this.#activeRunControllers.set(plan.name, controller);
    try {
      const runtime = this.#runtime();
      let result: ProcessResult | undefined;
      let primaryError: unknown;
      let createAttempted = false;
      let trustedContainerIdAcquired = false;
      this.#activeContainers.add(plan.name);
      try {
        await this.#verifyRuntimeFiles();
        if (this.#closing || controller.signal.aborted) {
          throw new Error("Docker backend started closing before container creation");
        }
        createAttempted = true;
        const created = await this.#processRunner.run(runtime.dockerBin, this.#containerCreateArgs(plan), {
          env: runtime.env,
          timeoutMs: INTERNAL_TIMEOUT_MS,
          maxOutputBytes: INTERNAL_OUTPUT_BYTES,
          signal: controller.signal,
        });
        if (created.exitCode !== 0) {
          throw new Error(`docker create failed: ${cleanDiagnostic(created.stderr || created.stdout)}`);
        }
        const containerId = created.stdout.trim();
        if (!CONTAINER_ID_RE.test(containerId)) {
          throw new Error("docker create returned an invalid container id");
        }
        trustedContainerIdAcquired = true;
        await this.#inspectAndVerifyContainer(plan, containerId);
        if (this.#closing || controller.signal.aborted) {
          throw new Error("Docker backend started closing before container start");
        }
        result = await this.#processRunner.run(runtime.dockerBin, ["start", "--attach", plan.name], {
          env: runtime.env,
          timeoutMs: options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes,
          signal: controller.signal,
        });
      } catch (error) {
        primaryError = error;
        if (createAttempted && !trustedContainerIdAcquired) {
          // Until create returns one valid ID, neither a failed CLI result nor
          // a temporary name miss proves that the daemon rejected the request.
          this.#poisonContainerAdmission();
        }
      }
      let cleanupError: unknown;
      try {
        // The name is generated before `docker create`, so cleanup never relies on
        // possibly missing, truncated, or attacker-controlled create stdout.
        await this.#removeAndConfirmAbsent(
          plan.name,
          !this.#closing && (!createAttempted || trustedContainerIdAcquired),
        );
      } catch (error) {
        cleanupError = error;
      }
      if (cleanupError) {
        this.#poisonContainerAdmission();
        throw new Error("Docker containment cleanup failed", { cause: cleanupError });
      }
      if (createAttempted && !trustedContainerIdAcquired) {
        throw new Error("Docker create outcome is unproven; close must complete owner-label cleanup", {
          cause: primaryError,
        });
      }
      if (primaryError) throw primaryError;
      if (!result) throw new Error("Docker container did not produce a result");
      return result;
    } finally {
      this.#activeRunControllers.delete(plan.name);
      this.#finishRun();
    }
  }

  async #runToolchainProbe(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "app-test-ctrl-toolchain-probe-"));
    const script = path.join(root, "probe.sh");
    let primaryError: unknown;
    let fingerprint: string | undefined;
    try {
      await writeFile(script, TOOLCHAIN_PROBE, { mode: 0o500, flag: "wx" });
      const { uid, gid } = this.#nonRootIdentity();
      const executables = Object.freeze({
        java: `${this.config.javaHome}/bin/java`,
        apkAnalyzer: this.config.apkAnalyzer,
        apkSigner: this.config.apkSigner,
      });
      const containerPath = `${this.config.javaHome}/bin:${this.config.androidSdkRoot}/platform-tools:${this.config.androidSdkRoot}/cmdline-tools/latest/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
      const plan = this.#containerPlan({
        purpose: "toolchain",
        workdir: "/",
        environment: [
          "HOME=/home/build",
          `JAVA_HOME=${this.config.javaHome}`,
          `ANDROID_HOME=${this.config.androidSdkRoot}`,
          `ANDROID_SDK_ROOT=${this.config.androidSdkRoot}`,
          `PATH=${containerPath}`,
          "LANG=C.UTF-8",
          "LC_ALL=C.UTF-8",
        ],
        mounts: [
          {
            source: await realpath(script),
            target: "/app-test-ctrl-toolchain-probe",
            readOnly: true,
          },
        ],
        tmpfs: [
          {
            target: "/tmp",
            options: `rw,nosuid,nodev,noexec,size=32m,mode=0700,uid=${uid},gid=${gid}`,
          },
          {
            target: "/home/build",
            options: `rw,nosuid,nodev,noexec,size=16m,mode=0700,uid=${uid},gid=${gid}`,
          },
        ],
        entrypoint: "/app-test-ctrl-toolchain-probe",
        command: [
          executables.java,
          executables.apkAnalyzer,
          executables.apkSigner,
        ],
        pidsLimit: 32,
        memoryMb: 512,
        cpus: 1,
      });
      const result = await this.#runCreatedContainer(plan, {
        timeoutMs: 15_000,
        maxOutputBytes: 16 * 1024,
      });
      if (result.exitCode !== 0 || !result.stdout.trim()) {
        throw new Error("pinned image toolchain probe failed");
      }
      fingerprint = verifyToolchainProbeOutput(result.stdout, executables).sha256;
    } catch (error) {
      primaryError = error;
    }
    let cleanupError: unknown;
    try {
      await rm(root, { recursive: true, force: false });
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError) {
      throw new Error("Docker toolchain-probe staging cleanup failed", { cause: cleanupError });
    }
    if (primaryError) throw primaryError;
    if (!fingerprint) throw new Error("Docker toolchain probe did not produce an identity");
    return fingerprint;
  }

  async #runIsolationProbe(): Promise<void> {
    const root = await mkdtemp(path.join(os.tmpdir(), "app-test-ctrl-sandbox-probe-"));
    const workspace = path.join(root, "workspace");
    const cacheSeed = path.join(root, "cache-seed");
    const secret = path.join(root, "secret");
    const script = path.join(root, "probe.sh");
    const token = randomBytes(16).toString("hex");
    try {
      await mkdir(workspace, { mode: 0o700 });
      await mkdir(cacheSeed, { mode: 0o700 });
      await writeFile(path.join(cacheSeed, "sentinel"), `cache-${token}`, { mode: 0o600, flag: "wx" });
      await chmod(path.join(cacheSeed, "sentinel"), 0o400);
      await chmod(cacheSeed, 0o500);
      await writeFile(secret, `secret-${token}`, { mode: 0o600, flag: "wx" });
      await symlink(secret, path.join(workspace, "forbidden-link"));
      await writeFile(script, ISOLATION_PROBE, { mode: 0o500, flag: "wx" });
      const { uid, gid } = this.#nonRootIdentity();
      const plan = this.#containerPlan({
        purpose: "probe",
        workdir: "/workspace",
        environment: [
          "HOME=/home/build",
          "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          "LANG=C.UTF-8",
          "LC_ALL=C.UTF-8",
        ],
        mounts: [
          { source: await realpath(workspace), target: "/workspace", readOnly: false },
          { source: await realpath(cacheSeed), target: "/cache-seed", readOnly: true },
          { source: await realpath(script), target: "/app-test-ctrl-probe", readOnly: true },
        ],
        tmpfs: [
          {
            target: "/tmp",
            options: `rw,nosuid,nodev,noexec,size=32m,mode=0700,uid=${uid},gid=${gid}`,
          },
          {
            target: "/home/build",
            options: `rw,nosuid,nodev,noexec,size=16m,mode=0700,uid=${uid},gid=${gid}`,
          },
        ],
        entrypoint: "/app-test-ctrl-probe",
        command: [token],
        pidsLimit: 32,
        memoryMb: 256,
        cpus: 1,
      });
      const result = await this.#runCreatedContainer(plan, {
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024,
      });
      if (result.exitCode !== 0 || result.stdout !== "probe-ok") {
        throw new Error("sandbox canary process reported a containment failure");
      }
      const allowed = await readFile(path.join(workspace, "allowed"), "utf8");
      const secretAfter = await readFile(secret, "utf8");
      const cacheAfter = await readFile(path.join(cacheSeed, "sentinel"), "utf8");
      if (allowed !== token || secretAfter !== `secret-${token}` || cacheAfter !== `cache-${token}`) {
        throw new Error("sandbox canary side effects did not match the parent expectation");
      }
      try {
        await lstat(path.join(root, "app-test-ctrl-forbidden"));
        throw new Error("sandbox wrote a forbidden host file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } finally {
      await chmod(cacheSeed, 0o700).catch(() => undefined);
      await chmod(path.join(cacheSeed, "sentinel"), 0o600).catch(() => undefined);
      await rm(root, { recursive: true, force: false });
    }
  }

  async runBuildCommand(options: BuildCommandOptions): Promise<ProcessResult> {
    const workdir = options.projectRelativeDir === "."
      ? "/workspace"
      : `/workspace/${options.projectRelativeDir}`;
    return this.#runContainer({
      workspace: options.workspace,
      cacheSeed: options.cacheSeed,
      workdir,
      command: [
        "./gradlew",
        "--offline",
        "--no-daemon",
        "--console=plain",
        ...options.tasks,
      ],
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    });
  }

  /** @deprecated Test compatibility alias; generic callers use runBuildCommand. */
  async runContainer(options: {
    workspace: string;
    cacheSeed: string;
    workdir: string;
    command: readonly string[];
    timeoutMs: number;
    maxOutputBytes: number;
  }): Promise<ProcessResult> {
    return this.#runContainer(options);
  }

  async #runContainer(options: {
    workspace: string;
    cacheSeed: string;
    workdir: string;
    command: readonly string[];
    timeoutMs: number;
    maxOutputBytes: number;
  }): Promise<ProcessResult> {
    this.#assertContainerAdmission();
    if ([options.workspace, options.cacheSeed].some((value) => value.includes(","))) {
      throw new Error("Docker bind mount paths must not contain commas");
    }
    const { uid, gid } = this.#nonRootIdentity();
    const entryRoot = await mkdtemp(path.join(os.tmpdir(), "app-test-ctrl-build-entry-"));
    const entrypoint = path.join(entryRoot, "entrypoint.sh");
    await writeFile(entrypoint, GRADLE_ENTRYPOINT, { mode: 0o500, flag: "wx" });
    let primaryError: unknown;
    let result: ProcessResult | undefined;
    try {
      const containerPath = `${this.config.javaHome}/bin:${this.config.androidSdkRoot}/platform-tools:${this.config.androidSdkRoot}/cmdline-tools/latest/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
      const plan = this.#containerPlan({
        purpose: "gradle",
        workdir: options.workdir,
        environment: [
          "HOME=/home/build",
          "GRADLE_USER_HOME=/gradle-home",
          "GRADLE_RO_DEP_CACHE=/cache-seed/caches",
          `JAVA_HOME=${this.config.javaHome}`,
          `ANDROID_HOME=${this.config.androidSdkRoot}`,
          `ANDROID_SDK_ROOT=${this.config.androidSdkRoot}`,
          `PATH=${containerPath}`,
          "LANG=C.UTF-8",
          "LC_ALL=C.UTF-8",
          "TZ=UTC",
        ],
        mounts: [
          { source: await realpath(options.workspace), target: "/workspace", readOnly: false },
          { source: await realpath(options.cacheSeed), target: "/cache-seed", readOnly: true },
          {
            source: await realpath(entrypoint),
            target: "/app-test-ctrl-entrypoint",
            readOnly: true,
          },
        ],
        tmpfs: [
          {
            target: "/tmp",
            options: `rw,nosuid,nodev,noexec,size=${this.config.tmpMb}m,mode=0700,uid=${uid},gid=${gid}`,
          },
          {
            target: "/home/build",
            options: `rw,nosuid,nodev,noexec,size=64m,mode=0700,uid=${uid},gid=${gid}`,
          },
          {
            target: "/gradle-home",
            options: `rw,nosuid,nodev,size=${this.config.gradleHomeMb}m,mode=0700,uid=${uid},gid=${gid}`,
          },
        ],
        entrypoint: "/app-test-ctrl-entrypoint",
        command: options.command,
        pidsLimit: this.config.maxPids,
        memoryMb: this.config.maxMemoryMb,
        cpus: this.config.maxCpus,
      });
      result = await this.#runCreatedContainer(plan, {
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
      });
    } catch (error) {
      primaryError = error;
    } finally {
      let cleanupError: unknown;
      try {
        await rm(entryRoot, { recursive: true, force: false });
      } catch (error) {
        cleanupError ??= error;
      }
      if (cleanupError) {
        throw new Error(
          `Docker staging cleanup failed for safe ref ${shortHash(imageDigest(this.config.image))}`,
          { cause: cleanupError },
        );
      }
    }
    if (primaryError) throw primaryError;
    if (!result) throw new Error("Docker build did not produce a result");
    return result;
  }

  async runReadOnlyArtifactCommand(options: {
    artifact: string;
    tool: "apkanalyzer" | "apksigner";
    argsBeforeArtifact: readonly string[];
    timeoutMs?: number;
  }): Promise<ProcessResult> {
    this.#assertContainerAdmission();
    if (options.artifact.includes(",")) throw new Error("artifact path must not contain commas");
    const { uid, gid } = this.#nonRootIdentity();
    const plan = this.#containerPlan({
      purpose: "artifact",
      workdir: "/",
      environment: [
        "HOME=/home/build",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "LANG=C.UTF-8",
        "LC_ALL=C.UTF-8",
      ],
      mounts: [
        { source: await realpath(options.artifact), target: "/artifact/app.apk", readOnly: true },
      ],
      tmpfs: [
        {
          target: "/tmp",
          options: `rw,nosuid,nodev,noexec,size=64m,mode=0700,uid=${uid},gid=${gid}`,
        },
        {
          target: "/home/build",
          options: `rw,nosuid,nodev,noexec,size=16m,mode=0700,uid=${uid},gid=${gid}`,
        },
      ],
      entrypoint: options.tool === "apkanalyzer"
        ? this.config.apkAnalyzer
        : this.config.apkSigner,
      command: [...options.argsBeforeArtifact, "/artifact/app.apk"],
      pidsLimit: 64,
      memoryMb: 512,
      cpus: 1,
    });
    return this.#runCreatedContainer(plan, {
      timeoutMs: options.timeoutMs ?? 30_000,
      maxOutputBytes: INTERNAL_OUTPUT_BYTES,
    });
  }
}
