import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import {
  FIREBASE_REPORTS_GUIDE_URI,
  PUBLIC_FIREBASE_READ_TOOLS,
  publicFirebaseToolSchemas,
  publicToUpstreamFirebaseToolName,
  sanitizeCrashlyticsReportGuideResult,
  sanitizeUpstreamToolResult,
  upstreamFirebaseToolSchemas,
  type PublicFirebaseToolName,
} from "./schemas.js";
import {
  createOfficialFirebaseUpstream,
  FirebaseUpstreamCleanupError,
  FirebaseUpstreamStageError,
  isFirebaseUpstreamFailureStage,
  type FirebaseUpstreamFailureStage,
  type FirebaseRuntimeOptions,
  type FirebaseUpstream,
} from "./upstream.js";

const MAX_PENDING_CALLS = 4;

export const FIREBASE_GATEWAY_DIAGNOSTIC_SCHEMA =
  "app-test-ctrl/firebase-readonly-diagnostic/v1" as const;

export type FirebaseGatewayFailureStage =
  | FirebaseUpstreamFailureStage
  | "gateway_unavailable"
  | "gateway_busy"
  | "response_sanitize";

function safeGatewayFailure(stage: FirebaseGatewayFailureStage): CallToolResult {
  const diagnostic = {
    schema_version: FIREBASE_GATEWAY_DIAGNOSTIC_SCHEMA,
    error_code: "gateway_rejected" as const,
    stage,
  };
  return {
    isError: true,
    content: [{
      type: "text",
      // 某些 MCP 客户端会丢弃 isError 结果上的 structuredContent。
      // 文本面同步返回同一个闭合 JSON，保证调用方仍只能看到三字段诊断。
      text: JSON.stringify(diagnostic),
    }],
    structuredContent: diagnostic,
  };
}

export type FirebaseUpstreamFactory = () => Promise<FirebaseUpstream>;

export interface ReadonlyFirebaseServer {
  server: McpServer;
  close(): Promise<void>;
}

export function createReadonlyFirebaseServer(
  upstreamFactory: FirebaseUpstreamFactory,
): ReadonlyFirebaseServer {
  const server = new McpServer({ name: "firebase-readonly-mcp", version: "0.1.0" });
  let upstreamPromise: Promise<FirebaseUpstream> | undefined;
  let queue = Promise.resolve();
  let closing = false;
  let cleanupFailure: unknown;
  let pendingCalls = 0;
  let shutdownPromise: Promise<void> | undefined;

  const getUpstream = (): Promise<FirebaseUpstream> => {
    upstreamPromise ??= upstreamFactory().catch((error) => {
      upstreamPromise = undefined;
      if (error instanceof FirebaseUpstreamCleanupError) {
        cleanupFailure ??= error;
        closing = true;
      }
      throw error;
    });
    return upstreamPromise;
  };

  const call = async (
    name: PublicFirebaseToolName,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> => {
    if (closing) return safeGatewayFailure("gateway_unavailable");
    if (pendingCalls >= MAX_PENDING_CALLS) return safeGatewayFailure("gateway_busy");
    pendingCalls += 1;
    let resolveQueue!: () => void;
    const previous = queue;
    queue = new Promise<void>((resolve) => {
      resolveQueue = resolve;
    });
    await previous;
    let failureStage: FirebaseGatewayFailureStage = "preflight";
    try {
      if (closing) throw new Error("Firebase read-only gateway is closing");
      // The name is selected from a closed registration table and is checked
      // again immediately before the untrusted upstream boundary.
      if (!PUBLIC_FIREBASE_READ_TOOLS.includes(name)) {
        throw new Error("Firebase tool is not in the read-only allowlist");
      }
      const validated = publicFirebaseToolSchemas[name].parse(args) as Record<string, unknown>;
      const upstreamName = publicToUpstreamFirebaseToolName[name];
      const upstreamArgs = name === "firebase_get_crashlytics_report_guide"
        ? { uris: [FIREBASE_REPORTS_GUIDE_URI] }
        : validated;
      const validatedUpstreamArgs = upstreamFirebaseToolSchemas[upstreamName].parse(
        upstreamArgs,
      ) as Record<string, unknown>;
      failureStage = "preflight";
      const upstream = await getUpstream();
      failureStage = "tool_call";
      const result = await upstream.callTool(upstreamName, validatedUpstreamArgs);
      failureStage = "response_sanitize";
      return name === "firebase_get_crashlytics_report_guide"
        ? sanitizeCrashlyticsReportGuideResult(result)
        : sanitizeUpstreamToolResult(result);
    } catch (error) {
      if (error instanceof FirebaseUpstreamStageError) {
        let upstreamStage: unknown;
        try {
          upstreamStage = error.stage;
        } catch {
          upstreamStage = undefined;
        }
        if (isFirebaseUpstreamFailureStage(upstreamStage)) {
          failureStage = upstreamStage;
        } else {
          // A corrupted diagnostic carrier is itself an unsafe boundary state.
          // Poison the instance rather than reflecting attacker-controlled text.
          failureStage = "gateway_unavailable";
          closing = true;
        }
      } else if (closing && failureStage === "preflight") {
        failureStage = "gateway_unavailable";
      }
      const current = upstreamPromise;
      upstreamPromise = undefined;
      if (current) {
        try {
          await current.then((value) => value.close());
        } catch (error) {
          cleanupFailure ??= error;
          closing = true;
          failureStage = "cleanup";
        }
      }
      return safeGatewayFailure(failureStage);
    } finally {
      pendingCalls -= 1;
      resolveQueue();
    }
  };

  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  } as const;

  for (const name of PUBLIC_FIREBASE_READ_TOOLS) {
    const schema = publicFirebaseToolSchemas[name];
    server.registerTool(
      name,
      {
        description: `Read-only bounded Firebase gateway tool ${name}`,
        inputSchema: schema as z.ZodTypeAny,
        annotations,
      },
      async (args: unknown) => call(name, args as Record<string, unknown>),
    );
  }

  const closeOnce = async (): Promise<void> => {
    closing = true;
    await queue;
    const current = upstreamPromise;
    upstreamPromise = undefined;
    if (current) {
      try {
        await current.then((value) => value.close());
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    try {
      await server.close();
    } catch (error) {
      cleanupFailure ??= error;
    }
    if (cleanupFailure) throw cleanupFailure;
  };

  return {
    server,
    close() {
      shutdownPromise ??= closeOnce();
      return shutdownPromise;
    },
  };
}

export function createProductionReadonlyFirebaseServer(
  options: FirebaseRuntimeOptions,
): ReadonlyFirebaseServer {
  return createReadonlyFirebaseServer(() => createOfficialFirebaseUpstream(options));
}
