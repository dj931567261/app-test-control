import { chmod, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  verificationLevelForBackend,
  type ArtifactTool,
  type BackendKind,
  type BuildBackend,
  type ExecutionProfileName,
  type VerificationLevel,
} from "./backend.js";
import { copyStableRegularFile, existingRegularFileInside } from "./safe-fs.js";

const APP_ID_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const SIGNER_CERT_RE = /^[ \t]*Signer #([1-9][0-9]*) certificate SHA-256 digest:[ \t]*([A-Fa-f0-9:]{64,95})[ \t]*$/gim;

function oneLine(value: string, label: string, maxLength = 256): string {
  if (/[\r\n]/.test(value.trimEnd())) throw new Error(`${label} returned multiple lines`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} returned an invalid value`);
  }
  return normalized;
}

async function toolOutput(
  backend: BuildBackend,
  artifact: string,
  tool: ArtifactTool,
  argsBeforeArtifact: readonly string[],
  label: string,
): Promise<string> {
  const result = await backend.runReadOnlyArtifactCommand({
    artifact,
    tool,
    argsBeforeArtifact,
  });
  if (result.exitCode !== 0) throw new Error(`${label} failed inside the trusted inspector`);
  return oneLine(result.stdout, label);
}

function taskBoundVariant(tasks: readonly string[]): string | null {
  const variants = new Set<string>();
  for (const task of tasks) {
    const leaf = task.split(":").filter(Boolean).at(-1) ?? "";
    const match = /^(?:assemble|bundle)([A-Za-z0-9_-]+)$/.exec(leaf);
    if (match?.[1]) variants.add(match[1]);
  }
  return variants.size === 1 ? [...variants][0]! : null;
}

export interface ApkInspection {
  schema_version: "android-apk-inspection/v2";
  inspector_backend: BackendKind;
  execution_profile: ExecutionProfileName;
  inspector_isolated: boolean;
  verification_level: VerificationLevel;
  artifact_sha256: string;
  bytes: number;
  package: string;
  version_name: string;
  version_code: string;
  debuggable: boolean;
  signed: boolean;
  signature_status: "verified";
  signer_certificate_sha256: string[];
  variant: string | null;
  variant_source: "task-bound" | "unavailable";
  variant_artifact_derived: false;
}

export interface StagedApk {
  root: string;
  relativePath: "artifact.apk";
  sha256: string;
  bytes: number;
}

export async function stageApk(options: {
  workspaceDir: string;
  artifactRelativePath: string;
}): Promise<StagedApk> {
  const source = await existingRegularFileInside(
    options.workspaceDir,
    options.artifactRelativePath,
    "bound APK artifact",
    2 * 1024 * 1024 * 1024,
  );
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "app-test-ctrl-apk-stage-")));
  await chmod(root, 0o700);
  const relativePath = "artifact.apk" as const;
  const target = path.join(root, relativePath);
  try {
    await copyStableRegularFile({
      source: source.path,
      destination: target,
      label: "bound APK artifact",
      maxBytes: 2 * 1024 * 1024 * 1024,
      expectedSize: source.size,
      expectedSha256: source.sha256,
      expectedSourceMode: source.mode,
      destinationMode: 0o400,
    });
    const staged = await existingRegularFileInside(
      root,
      relativePath,
      "staged APK artifact",
      2 * 1024 * 1024 * 1024,
    );
    const sourceAfter = await existingRegularFileInside(
      options.workspaceDir,
      options.artifactRelativePath,
      "bound APK artifact",
      2 * 1024 * 1024 * 1024,
    );
    if (
      staged.sha256 !== source.sha256
      || staged.size !== source.size
      || sourceAfter.sha256 !== source.sha256
      || sourceAfter.size !== source.size
    ) {
      throw new Error("APK artifact changed while creating its private inspection copy");
    }
    return { root, relativePath, sha256: staged.sha256, bytes: staged.size };
  } catch (error) {
    await chmod(target, 0o600).catch(() => undefined);
    await rm(root, { recursive: true, force: false });
    throw error;
  }
}

export async function disposeStagedApk(staged: StagedApk): Promise<void> {
  const temporaryRoot = await realpath(os.tmpdir());
  if (
    path.dirname(staged.root) !== temporaryRoot
    || !path.basename(staged.root).startsWith("app-test-ctrl-apk-stage-")
  ) {
    throw new Error("refusing to remove an unowned APK staging root");
  }
  const target = path.join(staged.root, staged.relativePath);
  const value = await lstat(target);
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1) {
    throw new Error("staged APK cleanup target is invalid");
  }
  await chmod(target, 0o600);
  await rm(staged.root, { recursive: true, force: false });
}

export async function inspectApk(options: {
  backend: BuildBackend;
  workspaceDir: string;
  artifactRelativePath: string;
  tasks: readonly string[];
}): Promise<ApkInspection> {
  if (!options.artifactRelativePath.endsWith(".apk")) {
    throw new Error("artifact_relative_path must end with .apk");
  }
  const artifact = await existingRegularFileInside(
    options.workspaceDir,
    options.artifactRelativePath,
    "APK artifact",
    2 * 1024 * 1024 * 1024,
  );
  const handle = await open(artifact.path, "r");
  try {
    const magic = Buffer.alloc(4);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    if (bytesRead !== 4 || magic.toString("hex") !== "504b0304") {
      throw new Error("APK artifact is not a ZIP archive");
    }
  } finally {
    await handle.close();
  }

  const packageName = await toolOutput(
    options.backend,
    artifact.path,
    "apkanalyzer",
    ["manifest", "application-id"],
    "APK application id inspection",
  );
  if (!APP_ID_RE.test(packageName)) throw new Error("APK contains an invalid application id");
  const versionName = await toolOutput(
    options.backend,
    artifact.path,
    "apkanalyzer",
    ["manifest", "version-name"],
    "APK version name inspection",
  );
  const versionCode = await toolOutput(
    options.backend,
    artifact.path,
    "apkanalyzer",
    ["manifest", "version-code"],
    "APK version code inspection",
  );
  if (!/^[0-9]{1,20}$/.test(versionCode)) throw new Error("APK contains an invalid version code");
  const debuggableRaw = await toolOutput(
    options.backend,
    artifact.path,
    "apkanalyzer",
    ["manifest", "debuggable"],
    "APK debuggable inspection",
  );
  if (debuggableRaw !== "true" && debuggableRaw !== "false") {
    throw new Error("APK contains an invalid debuggable value");
  }

  const signing = await options.backend.runReadOnlyArtifactCommand({
    artifact: artifact.path,
    tool: "apksigner",
    argsBeforeArtifact: ["verify", "--print-certs"],
  });
  if (signing.exitCode !== 0) {
    throw new Error("APK signature verification failed inside the trusted inspector");
  }
  const certificatesBySigner = new Map<number, string>();
  for (const match of signing.stdout.matchAll(SIGNER_CERT_RE)) {
    const signer = Number(match[1]);
    const normalized = (match[2] ?? "").replaceAll(":", "").toLowerCase();
    if (!Number.isSafeInteger(signer) || !/^[a-f0-9]{64}$/.test(normalized)) continue;
    if (certificatesBySigner.has(signer)) {
      throw new Error("APK signer verification returned a duplicate signer certificate record");
    }
    certificatesBySigner.set(signer, normalized);
  }
  if (certificatesBySigner.size === 0) {
    throw new Error("APK signer verification omitted certificate identity");
  }
  const signerNumbers = [...certificatesBySigner.keys()].sort((left, right) => left - right);
  if (signerNumbers.some((value, index) => value !== index + 1)) {
    throw new Error("APK signer verification returned a non-contiguous signer sequence");
  }
  const uniqueCertificates = [...new Set(
    signerNumbers.map((signer) => certificatesBySigner.get(signer)!),
  )].sort();
  if (uniqueCertificates.length !== certificatesBySigner.size) {
    throw new Error("APK signer verification returned an ambiguous duplicate certificate identity");
  }
  const artifactAfter = await existingRegularFileInside(
    options.workspaceDir,
    options.artifactRelativePath,
    "APK artifact",
    2 * 1024 * 1024 * 1024,
  );
  if (artifactAfter.sha256 !== artifact.sha256 || artifactAfter.size !== artifact.size) {
    throw new Error("APK artifact changed during inspection");
  }
  const variant = taskBoundVariant(options.tasks);
  return {
    schema_version: "android-apk-inspection/v2",
    inspector_backend: options.backend.backend,
    execution_profile: options.backend.backend === "docker" ? "docker_strict" : "local_trusted",
    inspector_isolated: options.backend.backend === "docker",
    verification_level: verificationLevelForBackend(options.backend.backend),
    artifact_sha256: artifact.sha256,
    bytes: artifact.size,
    package: packageName,
    version_name: versionName,
    version_code: versionCode,
    debuggable: debuggableRaw === "true",
    signed: true,
    signature_status: "verified",
    signer_certificate_sha256: uniqueCertificates,
    variant,
    variant_source: variant ? "task-bound" : "unavailable",
    variant_artifact_derived: false,
  };
}
