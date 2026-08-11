import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const MANAGED_MARKER_NAME = "APP_TEST_CTRL_FIREBASE_READONLY_PRELOAD";
const MANAGED_MARKER_VALUE = "official-v1";
const PACKAGE_ROOT_ENV = "APP_TEST_CTRL_FIREBASE_READONLY_PACKAGE_ROOT";
const PINNED_FIREBASE_TOOLS_VERSION = "15.24.0";
const RESOURCE_MANAGER_ORIGIN = "https://cloudresourcemanager.googleapis.com";
const FIREBASE_PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const FORWARD_PROXY_ENV_NAMES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
] as const;

type MutableModule = Record<string, unknown>;

function requireMutableFunction(
  moduleValue: unknown,
  exportName: string,
  moduleLabel: string,
): { module: MutableModule; enumerable: boolean } {
  if (!moduleValue || typeof moduleValue !== "object" || Array.isArray(moduleValue)) {
    throw new Error(`pinned Firebase ${moduleLabel} module contract drifted`);
  }
  const module = moduleValue as MutableModule;
  const descriptor = Object.getOwnPropertyDescriptor(module, exportName);
  if (
    !descriptor
    || typeof descriptor.value !== "function"
    || descriptor.writable !== true
    || descriptor.configurable !== true
  ) {
    throw new Error(`pinned Firebase ${moduleLabel} export contract drifted`);
  }
  return { module, enumerable: descriptor.enumerable ?? true };
}

function sealReplacement(
  moduleValue: unknown,
  exportName: string,
  moduleLabel: string,
  replacement: (...args: never[]) => unknown,
): void {
  const verified = requireMutableFunction(moduleValue, exportName, moduleLabel);
  Object.defineProperty(verified.module, exportName, {
    value: replacement,
    enumerable: verified.enumerable,
    configurable: false,
    writable: false,
  });
  if (verified.module[exportName] !== replacement) {
    throw new Error(`pinned Firebase ${moduleLabel} guard installation failed`);
  }
}

if (process.env[MANAGED_MARKER_NAME] !== MANAGED_MARKER_VALUE) {
  throw new Error("Firebase read-only preload requires the managed gateway");
}

const configuredPackageRoot = process.env[PACKAGE_ROOT_ENV];
if (
  !configuredPackageRoot
  || configuredPackageRoot.length > 4096
  || configuredPackageRoot.includes("\0")
  || !path.isAbsolute(configuredPackageRoot)
  || path.normalize(configuredPackageRoot) !== configuredPackageRoot
) {
  throw new Error("Firebase read-only preload package root is invalid");
}
const packageRoot = realpathSync(configuredPackageRoot);
const packageRootMetadata = lstatSync(packageRoot);
if (
  packageRoot !== configuredPackageRoot
  || !packageRootMetadata.isDirectory()
  || packageRootMetadata.isSymbolicLink()
) {
  throw new Error("Firebase read-only preload package root contract drifted");
}

const requireFromPackage = createRequire(path.join(packageRoot, "package.json"));

function requireExactPackageModule(relativePath: string, label: string): unknown {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(relativePath)
    || relativePath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`pinned Firebase ${label} path contract drifted`);
  }
  const expected = path.join(packageRoot, ...relativePath.split("/"));
  const resolved = requireFromPackage.resolve(`./${relativePath}`);
  const metadata = lstatSync(resolved);
  if (
    resolved !== expected
    || realpathSync(resolved) !== expected
    || !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || (
      process.platform !== "win32"
      && (
        typeof process.getuid !== "function"
        || metadata.uid !== process.getuid()
        || (metadata.mode & 0o022) !== 0
      )
    )
  ) {
    throw new Error(`pinned Firebase ${label} file contract drifted`);
  }
  return requireFromPackage(expected) as unknown;
}

function hasConfiguredForwardProxy(): boolean {
  const candidate = FORWARD_PROXY_ENV_NAMES
    .map((name) => process.env[name])
    .find((value) => value !== undefined && value !== "");
  if (candidate === undefined) return false;
  if (
    candidate.length > 4096
    || /[\u0000\r\n]/u.test(candidate)
  ) {
    throw new Error("Firebase read-only proxy configuration is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Firebase read-only proxy configuration is invalid");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.hostname.length === 0
  ) {
    throw new Error("Firebase read-only proxy configuration is invalid");
  }
  return true;
}

const manifest = requireExactPackageModule("package.json", "manifest") as {
  version?: unknown;
};
if (manifest.version !== PINNED_FIREBASE_TOOLS_VERSION) {
  throw new Error("Firebase read-only preload version contract drifted");
}

const apiTransport = requireExactPackageModule("lib/apiv2.js", "API transport");
const verifiedNoKeepAliveAgent = requireMutableFunction(
  apiTransport,
  "noKeepAliveAgent",
  "API transport",
);
const originalNoKeepAliveAgent =
  verifiedNoKeepAliveAgent.module.noKeepAliveAgent;

// firebase-tools@15.24.0 把 noKeepAliveAgent 作为 GoogleAuth/gaxios 的显式
// transporter agent。只要该字段为 truthy，gaxios 就完全跳过 HTTP(S)_PROXY，
// 导致受管子进程绕过宿主代理并在 ADC token 交换中长时间直连等待。
// 有受支持的代理时将默认值锁为 null，让 gaxios 按自身优先级和 NO_PROXY
// 规则选择代理；没有代理时保留固定上游的原行为。两种路径都把精确导出
// 封存为不可写，版本或 CJS 导出形状漂移时仍 fail-closed。
const guardedTransportAgent = hasConfiguredForwardProxy()
  ? null
  : originalNoKeepAliveAgent;
Object.defineProperty(verifiedNoKeepAliveAgent.module, "noKeepAliveAgent", {
  value: guardedTransportAgent,
  enumerable: verifiedNoKeepAliveAgent.enumerable,
  configurable: false,
  writable: false,
});
if (
  verifiedNoKeepAliveAgent.module.noKeepAliveAgent
  !== guardedTransportAgent
) {
  throw new Error("pinned Firebase API transport guard installation failed");
}

const ensureApi = requireExactPackageModule(
  "lib/ensureApiEnabled.js",
  "API enablement",
);
const cloudBilling = requireExactPackageModule(
  "lib/gcp/cloudbilling.js",
  "Cloud Billing",
);
const track = requireExactPackageModule("lib/track.js", "telemetry");

// firebase-tools@15.24.0 会在 MCP tools/list 的 Billing 探测中调用
// services:enable。只读网关不允许这种隐式远端写入，因此将 Billing
// 能力保守视为不可用；这不是项目真实计费状态的证明。
sealReplacement(
  cloudBilling,
  "checkBillingEnabled",
  "Cloud Billing",
  async () => false,
);

const rejectApiEnablement = async (): Promise<never> => {
  throw new Error("Firebase API enablement is blocked by the read-only gateway");
};

// firebase_get_project 在真正执行 Cloud Resource Manager GET 之前，会先调用
// bestEffortEnsure。原实现可能继续进入 services:enable，因此不能直接放行；但若
// 一概抛错，官方只读项目身份工具也永远无法执行。这里只对固定版本已核验的
// 精确调用形状做无副作用短路，随后仍由官方工具完成真实认证与 GET。其他 API、
// 参数或调用形状全部 fail-closed，ensure 本身也始终保持阻断。
const allowReadOnlyProjectIdentityLookup = async (
  ...args: unknown[]
): Promise<void> => {
  if (
    args.length !== 4
    || typeof args[0] !== "string"
    || !FIREBASE_PROJECT_ID_RE.test(args[0])
    || args[1] !== RESOURCE_MANAGER_ORIGIN
    || args[2] !== "firebase"
    || args[3] !== true
  ) {
    return rejectApiEnablement();
  }
};

// 两个导出必须分别覆盖：官方 bestEffortEnsure 使用模块内词法绑定，
// 只替换 exported ensure 不能阻止其原始启用链路。bestEffortEnsure 仅对上面的
// 项目身份 GET 前置调用做精确无副作用短路。
sealReplacement(
  ensureApi,
  "ensure",
  "API enablement",
  rejectApiEnablement,
);
sealReplacement(
  ensureApi,
  "bestEffortEnsure",
  "best-effort API enablement",
  allowReadOnlyProjectIdentityLookup,
);

// 私有 configstore 已默认丢弃 usage opt-in；这里再锁死 GA4 调用，避免
// 固定上游实现或宿主环境变化导致遥测网络请求。
sealReplacement(
  track,
  "trackGA4",
  "telemetry",
  async () => undefined,
);

const firebaseMcp = requireExactPackageModule("lib/mcp/index.js", "MCP server");
if (!firebaseMcp || typeof firebaseMcp !== "object" || Array.isArray(firebaseMcp)) {
  throw new Error("pinned Firebase MCP server module contract drifted");
}
const FirebaseMcpServer = (firebaseMcp as MutableModule).FirebaseMcpServer;
if (typeof FirebaseMcpServer !== "function") {
  throw new Error("pinned Firebase MCP server class contract drifted");
}
const firebaseMcpPrototype = (FirebaseMcpServer as { prototype?: unknown }).prototype;
const verifiedListToolsMethod = requireMutableFunction(
  firebaseMcpPrototype,
  "mcpListTools",
  "tool listing",
);
const originalMcpListTools = verifiedListToolsMethod.module.mcpListTools as (
  this: MutableModule,
  ...args: never[]
) => unknown;
const verifiedAuthenticationMethod = requireMutableFunction(
  firebaseMcpPrototype,
  "getAuthenticatedUser",
  "authentication discovery",
);
const originalGetAuthenticatedUser =
  verifiedAuthenticationMethod.module.getAuthenticatedUser;
const toolListingAuthenticationScope = new AsyncLocalStorage<"list_tools">();

// firebase-tools@15.24.0 authenticates while answering tools/list even though
// authentication is not needed to describe the fixed local tool contracts.
// A cold service-account token exchange can therefore consume the whole MCP
// startup budget.  Suppress authentication only for the single list call;
// every real tool call immediately falls back to the original method and must
// authenticate normally before any Firebase API request.
sealReplacement(
  firebaseMcpPrototype,
  "getAuthenticatedUser",
  "authentication discovery",
  function authenticationOutsideToolListing(
    this: MutableModule,
    ...args: never[]
  ): unknown {
    if (
      Object.getPrototypeOf(this) !== firebaseMcpPrototype
    ) {
      throw new Error("Firebase read-only authentication receiver contract drifted");
    }
    if (toolListingAuthenticationScope.getStore() === "list_tools") {
      return Promise.resolve(null);
    }
    return Reflect.apply(
      originalGetAuthenticatedUser as (...parameters: never[]) => unknown,
      this,
      args,
    );
  },
);
sealReplacement(
  firebaseMcpPrototype,
  "mcpListTools",
  "tool listing",
  function listToolsWithoutAuthentication(
    this: MutableModule,
    ...args: never[]
  ): unknown {
    if (
      Object.getPrototypeOf(this) !== firebaseMcpPrototype
      || toolListingAuthenticationScope.getStore() !== undefined
    ) {
      throw new Error("Firebase read-only tool listing receiver contract drifted");
    }
    return toolListingAuthenticationScope.run(
      "list_tools",
      () => Reflect.apply(originalMcpListTools, this, args),
    );
  },
);

// 即使 CLI 已显式传入 --only crashlytics，15.24.0 的 mcpListTools 仍会无条件
// 调 detectActiveFeatures，触发所有 feature 的 Service Usage GET。这里把发现结果
// 锁定为已验证的唯一 active feature，既避免无关网络探测，也保留官方 tools/list
// 与后续完整工具契约核验。
sealReplacement(
  firebaseMcpPrototype,
  "detectActiveFeatures",
  "active feature discovery",
  async function restrictActiveFeatureDiscovery(this: {
    activeFeatures?: unknown;
    detectedFeatures?: string[];
  }): Promise<string[]> {
    if (
      !Array.isArray(this.activeFeatures)
      || this.activeFeatures.length !== 1
      || this.activeFeatures[0] !== "crashlytics"
    ) {
      throw new Error("Firebase read-only active feature contract drifted");
    }
    this.detectedFeatures = ["crashlytics"];
    return this.detectedFeatures;
  },
);

// _createMcpContext 会无条件调用该方法；原实现通过继承的 PATH 同步执行
// `firebase --version`。只读网关只允许固定项目内 CLI 进程本身，不能再执行
// 任意宿主 launcher，因此返回不执行的稳定展示值。
sealReplacement(
  firebaseMcpPrototype,
  "_getFirebaseCliCommand",
  "CLI command discovery",
  function fixedFirebaseCliDisplayName(): string {
    return "firebase";
  },
);
