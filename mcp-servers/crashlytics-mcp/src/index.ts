#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { MAX_MCP_RESPONSE_BYTES } from "./constants.js";
import { CrashlyticsError, toPublicError } from "./errors.js";
import { createLazyService } from "./runtime.js";
import {
  getContextInputSchema,
  getEventInputSchema,
  getIssueInputSchema,
  getSymbolicationStatusInputSchema,
  listAppsInputSchema,
  listEventsInputSchema,
  listIssuesInputSchema,
} from "./schemas.js";
import type { CrashlyticsService } from "./service.js";

type ToolTextResult = {
  isError?: true;
  content: [{ type: "text"; text: string }];
};

function textResult(payload: unknown, isError = false): ToolTextResult {
  let text: string;
  try {
    text = JSON.stringify(payload, null, 2);
  } catch {
    text = JSON.stringify(toPublicError(new CrashlyticsError(
      "INTERNAL_ERROR",
      "Tool result could not be serialized",
    )));
    return { isError: true, content: [{ type: "text", text }] };
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_MCP_RESPONSE_BYTES) {
    const error = toPublicError(new CrashlyticsError(
      "RESPONSE_TOO_LARGE",
      "Tool response exceeded the MCP byte limit",
      { details: { response_bytes: bytes, limit_bytes: MAX_MCP_RESPONSE_BYTES } },
    ));
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(error) }],
    };
  }
  return {
    ...(isError ? { isError: true as const } : {}),
    content: [{ type: "text", text }],
  };
}

async function execute(operation: () => unknown | Promise<unknown>): Promise<ToolTextResult> {
  try {
    return textResult(await operation());
  } catch (error) {
    return textResult(toPublicError(error), true);
  }
}

const localReadOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const remoteReadOnlyAnnotations = {
  ...localReadOnlyAnnotations,
  // In cloud_logging mode these tools contact the fixed Google Cloud Logging
  // endpoint. Read-only does not mean closed-world.
  openWorldHint: true,
} as const;

export function createCrashlyticsMcpServer(
  serviceFactory: () => CrashlyticsService = createLazyService(),
): McpServer {
  const server = new McpServer({ name: "crashlytics-mcp", version: "0.1.0" });

  server.registerTool("get_context", {
    description: "Return the fixed Crashlytics provider, project/app allowlist, privacy policy and safety limits. Does not contact Firebase.",
    inputSchema: getContextInputSchema,
    annotations: localReadOnlyAnnotations,
  }, async () => execute(() => serviceFactory().getContext()));

  server.registerTool("list_apps", {
    description: "List only allowlisted Firebase apps for one allowlisted project.",
    inputSchema: listAppsInputSchema,
    annotations: localReadOnlyAnnotations,
  }, async ({ project_id }) => execute(() => serviceFactory().listApps(project_id)));

  server.registerTool("list_issues", {
    description: "List bounded Crashlytics issue summaries aggregated from one bounded event page.",
    inputSchema: listIssuesInputSchema,
    annotations: remoteReadOnlyAnnotations,
  }, async (input) => execute(() => serviceFactory().listIssues(input)));

  server.registerTool("get_issue", {
    description: "Get a bounded issue summary and a normalized representative event.",
    inputSchema: getIssueInputSchema,
    annotations: remoteReadOnlyAnnotations,
  }, async (input) => execute(() => serviceFactory().getIssue(input)));

  server.registerTool("list_events", {
    description: "List redacted, normalized Crashlytics events with bounded pagination and frames.",
    inputSchema: listEventsInputSchema,
    annotations: remoteReadOnlyAnnotations,
  }, async (input) => execute(() => serviceFactory().listEvents(input)));

  server.registerTool("get_event", {
    description: "Get one redacted normalized crash-event/v1 event by exact event id.",
    inputSchema: getEventInputSchema,
    annotations: remoteReadOnlyAnnotations,
  }, async (input) => execute(() => serviceFactory().getEvent(input)));

  server.registerTool("get_symbolication_status", {
    description: "Report bounded frame-symbol coverage for exactly one event or one exact issue build. This does not verify mapping, dSYM, or native-symbol artifact identity.",
    inputSchema: getSymbolicationStatusInputSchema,
    annotations: remoteReadOnlyAnnotations,
  }, async (input) => execute(() => serviceFactory().getSymbolicationStatus(input)));

  return server;
}

async function main(): Promise<void> {
  const server = createCrashlyticsMcpServer();
  await server.connect(new StdioServerTransport());
}

const isEntryPoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown startup failure";
    process.stderr.write(`crashlytics-mcp: ${message}\n`);
    process.exitCode = 1;
  });
}
