#!/usr/bin/env node
// analyzer-mcp: crash signature + dedup + session-level analysis.
// See PLAN.md §4.4 for the tool surface.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { computeSignature, parseStack } from "./signature.js";
import { dedupCrashes } from "./dedup.js";
import { analyzeSession, suggestMinimalPath } from "./analyze.js";
import { ipsToStackText, parseIpsContent, parseIpsFile } from "./ips.js";

const server = new McpServer({
  name: "analyzer-mcp",
  version: "0.1.0",
});

function asText(payload: unknown) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function asError(err: unknown) {
  return {
    isError: true as const,
    content: [
      { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
    ],
  };
}

// ---------- compute_signature ----------
server.tool(
  "compute_signature",
  "Parse a crash stack and return its stable 12-char fingerprint + extracted fields.",
  {
    stack: z.string().describe("Raw stack/block text"),
  },
  async ({ stack }) => {
    try {
      const parsed = parseStack(stack);
      const sig = computeSignature(parsed);
      return asText({
        fingerprint: sig.fingerprint,
        label: sig.label,
        kind: sig.kind,
        exception_class: sig.exception_class,
        top_frames: sig.top_frames,
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
        id: z.string(),
        stack: z.string(),
        signature: z.string().optional(),
        kind: z.string().optional(),
        step_index: z.number().int().nonnegative().optional(),
      }),
    ),
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
    session_dir: z.string().describe("Absolute path of the session directory"),
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
    session_dir: z.string(),
    repro_path: z.array(z.number().int().nonnegative()),
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

// =========================
//   iOS .ips support
// =========================

// ---------- parse_ips_file ----------
server.tool(
  "parse_ips_file",
  "Parse an Apple .ips crash file. Returns parsed fields, a report-ready canonical stack block, and the computed signature (kind='ios').",
  {
    file_path: z.string().describe("absolute path to a .ips file"),
  },
  async ({ file_path }) => {
    try {
      const parsed = await parseIpsFile(file_path);
      const stack = ipsToStackText(parsed);
      const sig = computeSignature(stack);
      return asText({
        fingerprint: sig.fingerprint,
        label: sig.label,
        kind: sig.kind,
        exception_type: parsed.exception_type,
        signal: parsed.signal,
        subtype: parsed.subtype,
        top_frames: parsed.top_frames,
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
    content: z.string(),
  },
  async ({ content }) => {
    try {
      const parsed = parseIpsContent(content);
      const stack = ipsToStackText(parsed);
      const sig = computeSignature(stack);
      return asText({
        fingerprint: sig.fingerprint,
        label: sig.label,
        kind: sig.kind,
        exception_type: parsed.exception_type,
        signal: parsed.signal,
        subtype: parsed.subtype,
        top_frames: parsed.top_frames,
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
