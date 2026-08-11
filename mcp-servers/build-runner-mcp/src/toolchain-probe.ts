import { domainHash, domainHashJson } from "./canonical.js";

export const TOOLCHAIN_PROBE_SCHEMA_VERSION =
  "app-test-ctrl/android-toolchain-probe/v2" as const;

const JAVA_BEGIN = "app-test-ctrl:java-version:begin";
const JAVA_END = "app-test-ctrl:java-version:end";
const REVISION_BEGIN = "app-test-ctrl:cmdline-tools-pkg-revision:begin";
const REVISION_END = "app-test-ctrl:cmdline-tools-pkg-revision:end";
const APKANALYZER_CONTRACT_BEGIN = "app-test-ctrl:apkanalyzer-help-contract:begin";
const APKANALYZER_CONTRACT_END = "app-test-ctrl:apkanalyzer-help-contract:end";
const APKSIGNER_BEGIN = "app-test-ctrl:apksigner-version:begin";
const APKSIGNER_END = "app-test-ctrl:apksigner-version:end";
const PROBE_END = "app-test-ctrl:android-toolchain-probe:end";
const MAX_PROBE_OUTPUT_BYTES = 16 * 1024;
const REVISION_RE = /^[0-9]+(?:\.[0-9]+)*$/;
const CONTAINER_EXECUTABLE_RE = /^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/;

/**
 * 该脚本只把 `source.properties` 中的 Pkg.Revision 当作 cmdline-tools
 * 版本。`apkanalyzer --help` 仅用于证明命令可启动且仍暴露预期命令契约。
 */
export const TOOLCHAIN_PROBE = `#!/bin/sh
set -eu
umask 077

test "$#" -eq 3
java_executable="$1"
apkanalyzer_executable="$2"
apksigner_executable="$3"

test -x "$java_executable"
test -x "$apkanalyzer_executable"
test -x "$apksigner_executable"

# latest 和 bin 都可能是包内 symlink。先解析最终 executable 的
# canonical path，再从真实包目录定位 source.properties；不能从 alias
# 的相邻目录读取一个与实际 executable 无关的伪版本。
canonical_apkanalyzer="$(readlink -f -- "$apkanalyzer_executable")"
test -n "$canonical_apkanalyzer"
test -x "$canonical_apkanalyzer"
test "\${canonical_apkanalyzer##*/}" = "apkanalyzer"
apkanalyzer_bin_dir="\${canonical_apkanalyzer%/*}"
test "$apkanalyzer_bin_dir" != "$canonical_apkanalyzer"
test "\${apkanalyzer_bin_dir##*/}" = "bin"
cmdline_tools_package_dir="\${apkanalyzer_bin_dir%/*}"
test "$cmdline_tools_package_dir" != "$apkanalyzer_bin_dir"
source_properties="$cmdline_tools_package_dir/source.properties"
test -f "$source_properties"
test ! -L "$source_properties"

cmdline_tools_revision="$(awk '
  BEGIN { matches = 0; revision = "" }
  /^[[:space:]]*Pkg[.]Revision[[:space:]]*=/ {
    matches += 1
    candidate = $0
    sub(/^[[:space:]]*Pkg[.]Revision[[:space:]]*=[[:space:]]*/, "", candidate)
    sub(/[[:space:]]*$/, "", candidate)
    revision = candidate
  }
  END {
    if (matches != 1 || revision !~ /^[0-9]+([.][0-9]+)*$/) exit 65
    print revision
  }
' "$source_properties")"
test -n "$cmdline_tools_revision"

java_version="$($java_executable -version 2>&1)"
test -n "$java_version"

# --help 的输出是能力探针，不是版本号。只有同一条帮助文本同时包含
# 顶层命令名与 manifest subject 才接受该 apkanalyzer。
apkanalyzer_help="$($apkanalyzer_executable --help 2>&1)"
test -n "$apkanalyzer_help"
printf '%s\n' "$apkanalyzer_help" | awk '
  BEGIN { usage = 0; manifest = 0 }
  {
    lower = tolower($0)
    if (lower ~ /^[[:space:]]*usage[[:space:]]*:/ &&
        lower ~ /(^|[^[:alnum:]_-])apkanalyzer([^[:alnum:]_-]|$)/) usage = 1
    if (lower ~ /(^|[^[:alnum:]_-])manifest([^[:alnum:]_-]|$)/) manifest = 1
  }
  END {
    if (!usage) exit 66
    if (!manifest) exit 67
  }
'

apksigner_version="$($apksigner_executable version 2>&1)"
test -n "$apksigner_version"

printf '%s\n' '${TOOLCHAIN_PROBE_SCHEMA_VERSION}' '${JAVA_BEGIN}'
printf '%s\n' "$java_version"
printf '%s\n' '${JAVA_END}' '${REVISION_BEGIN}' "$cmdline_tools_revision" '${REVISION_END}'
printf '%s\n' '${APKANALYZER_CONTRACT_BEGIN}' 'apkanalyzer' 'manifest' '${APKANALYZER_CONTRACT_END}'
printf '%s\n' '${APKSIGNER_BEGIN}'
printf '%s\n' "$apksigner_version"
printf '%s\n' '${APKSIGNER_END}' '${PROBE_END}'
`;

export const TOOLCHAIN_PROBE_SCRIPT_SHA256 = domainHash(
  "crashfix-android-toolchain-probe-script/v2",
  TOOLCHAIN_PROBE,
);

export interface ToolchainProbeExecutables {
  java: string;
  apkAnalyzer: string;
  apkSigner: string;
}

export interface AndroidToolchainProbeIdentity {
  schema_version: typeof TOOLCHAIN_PROBE_SCHEMA_VERSION;
  probe_script_sha256: string;
  java: {
    executable: string;
    version_output: string;
  };
  cmdline_tools: {
    apkanalyzer_executable: string;
    pkg_revision: string;
    help_option: "--help";
    required_help_terms: ["apkanalyzer", "manifest"];
  };
  apksigner: {
    executable: string;
    version_output: string;
  };
}

export interface VerifiedToolchainProbe {
  identity: AndroidToolchainProbeIdentity;
  sha256: string;
}

function assertContainerExecutable(value: string, label: string): string {
  if (!CONTAINER_EXECUTABLE_RE.test(value)
    || value.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(`${label} must be a normalized absolute container executable path`);
  }
  return value;
}

function uniqueMarkerIndex(lines: readonly string[], marker: string): number {
  const index = lines.indexOf(marker);
  if (index < 0 || lines.lastIndexOf(marker) !== index) {
    throw new Error(`toolchain probe marker is missing or duplicated: ${marker}`);
  }
  return index;
}

function nonEmptySection(
  lines: readonly string[],
  beginMarker: string,
  endMarker: string,
): { begin: number; end: number; value: string } {
  const begin = uniqueMarkerIndex(lines, beginMarker);
  const end = uniqueMarkerIndex(lines, endMarker);
  if (end <= begin + 1) throw new Error(`toolchain probe section is empty: ${beginMarker}`);
  const section = lines.slice(begin + 1, end);
  if (section.some((line) => line.length === 0)) {
    throw new Error(`toolchain probe section contains an empty record: ${beginMarker}`);
  }
  return { begin, end, value: section.join("\n") };
}

/**
 * 校验容器探针的有界线协议，并对结构化身份做 canonical JSON 哈希。
 * 调用方继续沿用现有 `toolchainProbeSha256` 字段即可，无需扩展 Docker identity。
 */
export function verifyToolchainProbeOutput(
  output: string,
  executables: ToolchainProbeExecutables,
): VerifiedToolchainProbe {
  if (Buffer.byteLength(output, "utf8") < 1
    || Buffer.byteLength(output, "utf8") > MAX_PROBE_OUTPUT_BYTES) {
    throw new Error("toolchain probe output is empty or exceeds its bound");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(output)) {
    throw new Error("toolchain probe output contains forbidden control characters");
  }
  const normalized = output.replace(/\r\n/g, "\n");
  if (normalized.includes("\r")) {
    throw new Error("toolchain probe output contains an invalid carriage return");
  }
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== TOOLCHAIN_PROBE_SCHEMA_VERSION || lines.at(-1) !== PROBE_END) {
    throw new Error("toolchain probe protocol envelope is invalid");
  }

  const java = nonEmptySection(lines, JAVA_BEGIN, JAVA_END);
  const revisionBegin = uniqueMarkerIndex(lines, REVISION_BEGIN);
  const revisionEnd = uniqueMarkerIndex(lines, REVISION_END);
  const contractBegin = uniqueMarkerIndex(lines, APKANALYZER_CONTRACT_BEGIN);
  const contractEnd = uniqueMarkerIndex(lines, APKANALYZER_CONTRACT_END);
  const apkSigner = nonEmptySection(lines, APKSIGNER_BEGIN, APKSIGNER_END);
  const end = uniqueMarkerIndex(lines, PROBE_END);

  if (
    java.begin !== 1
    || revisionBegin !== java.end + 1
    || revisionEnd !== revisionBegin + 2
    || contractBegin !== revisionEnd + 1
    || contractEnd !== contractBegin + 3
    || apkSigner.begin !== contractEnd + 1
    || end !== apkSigner.end + 1
    || end !== lines.length - 1
  ) {
    throw new Error("toolchain probe sections are missing, reordered, or contain extra records");
  }

  const revision = lines[revisionBegin + 1] ?? "";
  if (!REVISION_RE.test(revision)) {
    throw new Error("toolchain probe Pkg.Revision is invalid");
  }
  if (lines[contractBegin + 1] !== "apkanalyzer"
    || lines[contractBegin + 2] !== "manifest") {
    throw new Error("toolchain probe apkanalyzer help contract is invalid");
  }

  const identity: AndroidToolchainProbeIdentity = {
    schema_version: TOOLCHAIN_PROBE_SCHEMA_VERSION,
    probe_script_sha256: TOOLCHAIN_PROBE_SCRIPT_SHA256,
    java: {
      executable: assertContainerExecutable(executables.java, "java"),
      version_output: java.value,
    },
    cmdline_tools: {
      apkanalyzer_executable: assertContainerExecutable(
        executables.apkAnalyzer,
        "apkanalyzer",
      ),
      pkg_revision: revision,
      help_option: "--help",
      required_help_terms: ["apkanalyzer", "manifest"],
    },
    apksigner: {
      executable: assertContainerExecutable(executables.apkSigner, "apksigner"),
      version_output: apkSigner.value,
    },
  };
  return {
    identity,
    sha256: domainHashJson("crashfix-android-toolchain-probe/v2", identity),
  };
}
