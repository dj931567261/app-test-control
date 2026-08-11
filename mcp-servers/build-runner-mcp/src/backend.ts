import type { RunnerConfig } from "./config.js";
import type { ProcessResult } from "./process-runner.js";

export type BackendKind = "docker" | "local_trusted";
export type NetworkPolicy = "denied" | "not_enforced";
export type VerificationLevel = "strong_isolation" | "trusted_local";
export type ExecutionProfileName = "docker_strict" | "local_trusted";
export type FilesystemIsolation = "enforced" | "not_enforced";
export type ProcessContainment = "container+process_group" | "process_group_best_effort";
export type CacheMode =
  | "sealed_seed_readonly_overlay"
  | "sealed_seed_disposable_copy";

export interface WorkspaceDiskQuota {
  enforced: boolean;
  mechanism: "attested" | "none";
}

export interface DockerIdentity {
  backend: "docker";
  dockerClientVersion: string;
  dockerServerVersion: string;
  dockerCliSha256: string;
  dockerSocketIdentitySha256: string;
  ociRuntime: string;
  ociRuntimeDescriptorSha256: string;
  toolchainProbeSha256: string;
  dockerImageId: string;
  dockerImageDigest: string;
  platform: "linux";
  securityOptionsSha256: string;
}

export interface LocalTrustedIdentity {
  backend: "local_trusted";
  platform: "darwin" | "linux";
  architecture: string;
  javaExecutableSha256: string;
  javaReleaseSha256: string;
  javaRuntimeSha256: string;
  javaVersionSha256: string;
  apkAnalyzerSha256: string;
  apkAnalyzerPackageSha256: string;
  apkAnalyzerImplementationSha256: string;
  apkAnalyzerVersionSha256: string;
  apkSignerSha256: string;
  apkSignerPackageSha256: string;
  apkSignerImplementationSha256: string;
  apkSignerVersionSha256: string;
  executionProfileSha256: string;
}

export type BackendIdentity = DockerIdentity | LocalTrustedIdentity;

export type CapabilityResult =
  | { available: false; backend: BackendKind; reasons: string[]; identity?: never }
  | { available: true; backend: "docker"; reasons: string[]; identity: DockerIdentity }
  | {
      available: true;
      backend: "local_trusted";
      reasons: string[];
      identity: LocalTrustedIdentity;
    };

export interface BuildCommandOptions {
  workspace: string;
  cacheSeed: string;
  projectRelativeDir: string;
  tasks: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export type ArtifactTool = "apkanalyzer" | "apksigner";

/**
 * Common execution contract. A backend must expose its limitations through
 * `probe`; implementing this interface does not itself imply strong isolation.
 */
export interface BuildBackend {
  readonly backend: BackendKind;
  readonly config: RunnerConfig;
  initialize(): Promise<void>;
  close(): Promise<void>;
  probe(): Promise<CapabilityResult>;
  executionProfile(identity: BackendIdentity): Record<string, unknown>;
  runBuildCommand(options: BuildCommandOptions): Promise<ProcessResult>;
  runReadOnlyArtifactCommand(options: {
    artifact: string;
    tool: ArtifactTool;
    argsBeforeArtifact: readonly string[];
    timeoutMs?: number;
  }): Promise<ProcessResult>;
}

export function networkPolicyForBackend(backend: BackendKind): NetworkPolicy {
  return backend === "docker" ? "denied" : "not_enforced";
}

export function verificationLevelForBackend(backend: BackendKind): VerificationLevel {
  return backend === "docker" ? "strong_isolation" : "trusted_local";
}
