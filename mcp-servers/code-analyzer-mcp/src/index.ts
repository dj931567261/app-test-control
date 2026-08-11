#!/usr/bin/env node
// code-analyzer-mcp: static analysis of mobile projects.
// Exposes tools that smart-qa skill uses to infer business flows before driving the app.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { discoverDocs } from "./docs.js";
import { detectPlatform } from "./platform.js";
import { extractAndroid } from "./android.js";
import { extractFlutter } from "./flutter.js";
import { analyzeProject } from "./analyze.js";
import { locateStackFrames } from "./stack-locator.js";
import { publicDiagnostic } from "./public-diagnostic.js";
import { readQuickSourceFiles } from "./quick-source-reader.js";

const server = new McpServer({
  name: "code-analyzer-mcp",
  version: "0.1.0",
});

function asText(payload: unknown) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function asError(err: unknown) {
  const text = publicDiagnostic(err);
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

// ---------- discover_docs ----------
server.tool(
  "discover_docs",
  "Find PRD / requirements / README / spec / test-plan docs in the project. Returns ordered list with kind classification and a head snippet for each.",
  {
    project_dir: z.string().describe("Absolute path of the project root."),
  },
  async ({ project_dir }) => {
    try {
      const hits = await discoverDocs(project_dir);
      return asText({
        project_dir,
        count: hits.length,
        docs: hits,
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- detect_platform ----------
server.tool(
  "detect_platform",
  "Detect mobile platform (android-native / flutter / react-native / ios-native / unknown) from config files. Also reports app name and package/bundle id when easy.",
  {
    project_dir: z.string(),
  },
  async ({ project_dir }) => {
    try {
      const r = await detectPlatform(project_dir);
      return asText(r);
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- extract_signals ----------
server.tool(
  "extract_signals",
  "Extract pages / routes / apis / handlers from source. Auto-detects platform if not specified. Each entry includes file:line for verification.",
  {
    project_dir: z.string(),
    platform: z
      .enum(["android-native", "flutter", "react-native", "ios-native", "auto"])
      .optional()
      .default("auto"),
  },
  async ({ project_dir, platform }) => {
    try {
      const resolved =
        platform === "auto" || !platform
          ? (await detectPlatform(project_dir)).platform
          : platform;
      if (resolved === "android-native") {
        return asText({ platform: resolved, ...(await extractAndroid(project_dir)) });
      }
      if (resolved === "flutter") {
        const flutter = await extractFlutter(project_dir);
        const android = await extractAndroid(project_dir);
        return asText({
          platform: resolved,
          pages: [...flutter.pages, ...android.pages],
          routes: [...flutter.routes, ...android.routes],
          apis: [...flutter.apis, ...android.apis],
          handlers: [...flutter.handlers, ...android.handlers],
          scanned: flutter.scanned + android.scanned,
        });
      }
      return asText({
        platform: resolved,
        note: "v1: extraction only supports android-native and flutter. Doc discovery still works for any platform.",
        pages: [],
        routes: [],
        apis: [],
        handlers: [],
        scanned: 0,
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- analyze_project ----------
server.tool(
  "analyze_project",
  "One-shot pipeline: detect platform + discover docs + extract signals. Best entry point for smart-qa skill.",
  {
    project_dir: z.string(),
    include_docs: z.boolean().optional().default(true),
  },
  async ({ project_dir, include_docs }) => {
    try {
      const r = await analyzeProject(project_dir, { include_docs });
      return asText(r);
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- locate_stack_frames ----------
server.tool(
  "locate_stack_frames",
  "Map bounded, untrusted crash frames to candidate source files inside a mobile project. Returns relative paths and confidence-ranked evidence; it never opens paths supplied by the crash.",
  {
    project_dir: z.string().max(4096).describe("Absolute path of the project root."),
    frames: z.array(z.object({
      index: z.number().int().nonnegative(),
      symbol: z.string().min(1).max(1024),
      module: z.string().max(512).optional(),
      file: z.string().max(2048).optional(),
      line: z.number().int().positive().max(10_000_000).optional(),
      app_owned: z.boolean().optional(),
    })).min(1).max(64),
    context_lines: z.number().int().min(0).max(5).optional().default(2),
    max_candidates: z.number().int().min(1).max(200).optional().default(64),
  },
  async ({ project_dir, frames, context_lines, max_candidates }) => {
    try {
      return asText(await locateStackFrames(project_dir, frames, {
        contextLines: context_lines,
        maxCandidates: max_candidates,
      }));
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- read_quick_source_files ----------
server.tool(
  "read_quick_source_files",
  "Read at most three explicitly approved source files for CrashFix quick_test. The reader rejects links, hardlinks, generated/credential-like paths and credential-like content; it never scans the repository.",
  {
    project_dir: z.string().max(4096).describe("Absolute project directory."),
    relative_paths: z
      .array(z.string().min(1).max(1024))
      .min(1)
      .max(3)
      .describe("One to three normalized POSIX source paths, relative to project_dir."),
  },
  async ({ project_dir, relative_paths }) => {
    try {
      return asText(await readQuickSourceFiles(project_dir, relative_paths));
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- boot ----------
const transport = new StdioServerTransport();
await server.connect(transport);
