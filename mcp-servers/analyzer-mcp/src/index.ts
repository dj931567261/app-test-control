#!/usr/bin/env node
// analyzer-mcp: crash signature + dedup + session-level analysis.
// See PLAN.md §4.4 for the tool surface.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { computeSignature, parseStack } from "./signature.js";
import {
  MAX_CRASH_STACK_BYTES,
  MAX_DEDUP_CRASHES,
  dedupCrashes,
} from "./dedup.js";
import { analyzeSession, suggestMinimalPath } from "./analyze.js";
import {
  MAX_IPS_FILE_BYTES,
  ipsToStackText,
  parseIpsContent,
  parseIpsFile,
} from "./ips.js";
import {
  analyzeCrashEvent,
  normalizedCrashEventSchema,
} from "./crash-event.js";
import { publicDiagnostic } from "./public-diagnostic.js";

const server = new McpServer({
  name: "analyzer-mcp",
  version: "0.2.0",
});

const MAX_PATH_CHARS = 4096;

const stackSchema = z
  .string()
  .max(MAX_CRASH_STACK_BYTES, "stack is too large");

function assertStackBytes(stack: string): number {
  const bytes = Buffer.byteLength(stack, "utf8");
  if (bytes > MAX_CRASH_STACK_BYTES) {
    throw new Error(`stack exceeds ${MAX_CRASH_STACK_BYTES} byte size limit`);
  }
  return bytes;
}

function asText(payload: unknown) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function asError(err: unknown) {
  return {
    isError: true as const,
    content: [
      { type: "text" as const, text: publicDiagnostic(err) },
    ],
  };
}

// ---------- compute_signature ----------
server.tool(
  "compute_signature",
  "Parse a crash stack and return its stable 12-char fingerprint + extracted fields.",
  {
    stack: stackSchema.describe("Raw stack/block text"),
  },
  async ({ stack }) => {
    try {
      assertStackBytes(stack);
      // Hash the raw stack so Java's exact historical parser can produce the
      // explicit legacy_fingerprint; reconstructing from ParsedStack loses it.
      const sig = computeSignature(stack);
      const parsed = parseStack(stack);
      return asText({
        fingerprint: sig.fingerprint,
        signature_version: sig.signature_version,
        legacy_fingerprint: sig.legacy_fingerprint,
        label: sig.label,
        kind: sig.kind,
        exception_class: sig.exception_class,
        top_frames: sig.top_frames,
        identity_frames: sig.identity_frames,
        root_cause_class: sig.root_cause_class,
        parsed,
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- dedup_crashes ----------
server.tool(
  "dedup_crashes",
  "Group crash records by computed signature. Input: list of {id, stack, step_index?, kind?}. Output: groups[] sorted by occurrences.",
  {
    crashes: z.array(
      z.object({
        id: z.string().max(1024),
        stack: stackSchema,
        signature: z.string().max(4096).optional(),
        kind: z.string().max(128).optional(),
        step_index: z.number().int().nonnegative().optional(),
      }),
    ).max(MAX_DEDUP_CRASHES),
  },
  async ({ crashes }) => {
    try {
      const result = dedupCrashes(crashes);
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- analyze_session ----------
server.tool(
  "analyze_session",
  "Read a session directory, hydrate crash records from disk, dedup them, and return the grouped analysis (includes per-instance repro_paths for downstream minimization).",
  {
    session_dir: z.string().max(MAX_PATH_CHARS).describe("Absolute path of the session directory"),
  },
  async ({ session_dir }) => {
    try {
      const result = await analyzeSession(session_dir);
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- suggest_minimal_path ----------
server.tool(
  "suggest_minimal_path",
  "Static heuristic to suggest a shorter repro path: keeps target step + page transitions + explicit failures; drops 'skip' steps. Confidence is at most 'medium' — for verified minimization, run the 'minimize' skill (live replay).",
  {
    session_dir: z.string().max(MAX_PATH_CHARS),
    repro_path: z.array(z.number().int().nonnegative()).max(10_000),
    target_step_index: z.number().int().nonnegative(),
  },
  async ({ session_dir, repro_path, target_step_index }) => {
    try {
      const result = await suggestMinimalPath(session_dir, repro_path, target_step_index);
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- analyze_crash_event ----------
server.tool(
  "analyze_crash_event",
  "Validate and analyze a normalized Firebase Crashlytics crash-event/v1 object. Structured frames are canonicalized before computing a stable fingerprint; volatile addresses and source line numbers do not affect identity.",
  {
    event: normalizedCrashEventSchema.describe("normalized crash-event/v1 payload"),
  },
  async ({ event }) => {
    try {
      return asText(analyzeCrashEvent(event));
    } catch (err) {
      return asError(err);
    }
  },
);

// =========================
//   iOS .ips support
// =========================

// ---------- parse_ips_file ----------
server.tool(
  "parse_ips_file",
  "Parse an Apple .ips crash file. Returns parsed fields, a report-ready canonical stack block, and the computed signature (kind='ios').",
  {
    file_path: z.string().max(MAX_PATH_CHARS).describe("absolute path to a .ips file"),
  },
  async ({ file_path }) => {
    try {
      const parsed = await parseIpsFile(file_path);
      const stack = ipsToStackText(parsed);
      const sig = computeSignature(stack);
      return asText({
        fingerprint: sig.fingerprint,
        signature_version: sig.signature_version,
        legacy_fingerprint: sig.legacy_fingerprint,
        label: sig.label,
        kind: sig.kind,
        exception_type: parsed.exception_type,
        signal: parsed.signal,
        subtype: parsed.subtype,
        top_frames: parsed.top_frames,
        identity_frame: parsed.identity_frame,
        proc_name: parsed.proc_name,
        bundle_id: parsed.bundle_id,
        timestamp: parsed.header.timestamp,
        bug_type: parsed.header.bug_type,
        stack,
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- parse_ips_content ----------
server.tool(
  "parse_ips_content",
  "Parse raw .ips text (header line + body JSON). Same output shape as parse_ips_file, including a report-ready canonical stack block. Useful for synthesized fixtures.",
  {
    // zod's string max counts UTF-16 code units. parseIpsContent additionally
    // enforces the authoritative UTF-8 byte limit for multibyte content.
    content: z.string().max(MAX_IPS_FILE_BYTES),
  },
  async ({ content }) => {
    try {
      const parsed = parseIpsContent(content);
      const stack = ipsToStackText(parsed);
      const sig = computeSignature(stack);
      return asText({
        fingerprint: sig.fingerprint,
        signature_version: sig.signature_version,
        legacy_fingerprint: sig.legacy_fingerprint,
        label: sig.label,
        kind: sig.kind,
        exception_type: parsed.exception_type,
        signal: parsed.signal,
        subtype: parsed.subtype,
        top_frames: parsed.top_frames,
        identity_frame: parsed.identity_frame,
        proc_name: parsed.proc_name,
        bundle_id: parsed.bundle_id,
        timestamp: parsed.header.timestamp,
        bug_type: parsed.header.bug_type,
        stack,
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- boot ----------
const transport = new StdioServerTransport();
await server.connect(transport);
