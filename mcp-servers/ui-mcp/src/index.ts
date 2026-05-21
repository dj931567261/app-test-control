#!/usr/bin/env node
// ui-mcp: Android UI hierarchy query and coordinate-based interaction.
// Hierarchy-first; the caller (Claude) is expected to fall back to
// screenshot-based interaction via mobile-mcp when these tools fail to find.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";

import { AdbError, inputTap, inputText } from "./adb.js";
import { dumpHierarchy, UiBusyError, type UiElement } from "./uiautomator.js";
import { findFirst, findOne, findAll, type Strategy, type StrategyBy } from "./finder.js";
import { pageFingerprint } from "./page-fingerprint.js";

const server = new McpServer({
  name: "ui-mcp",
  version: "0.1.0",
});

function asText(payload: unknown) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function asError(err: unknown) {
  if (err instanceof UiBusyError) {
    // Structured signal — the caller (skill) can detect this and switch to
    // screenshot + vision-driven interaction without ambiguity.
    const payload = {
      ok: false,
      reason: "ui_busy",
      message: err.message,
      attempts: err.attempts,
      hint: err.hint,
      fallback: "mobile_take_screenshot + mobile_click_on_screen_at_coordinates",
    };
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    };
  }
  const text =
    err instanceof AdbError
      ? `${err.message}${err.stderr ? `\nstderr: ${err.stderr}` : ""}`
      : err instanceof Error
        ? err.message
        : String(err);
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

const STRATEGY_BY = [
  "identifier",
  "text",
  "label",
  "text_contains",
  "label_contains",
  "class",
] as const satisfies readonly StrategyBy[];

function strategySchema() {
  return z.object({
    by: z.enum(STRATEGY_BY),
    value: z.string(),
    only_enabled: z.boolean().optional(),
    only_clickable: z.boolean().optional(),
    index: z.number().int().nonnegative().optional(),
  });
}

function strategiesSchema() {
  return z
    .union([strategySchema(), z.array(strategySchema()).min(1)])
    .describe("Single strategy or ordered list. First match wins.");
}

function pruneForOutput(e: UiElement): Record<string, unknown> {
  // Trim noisy/empty fields to keep MCP responses compact.
  const out: Record<string, unknown> = {
    index: e.index,
    class: e.class,
    bounds: e.bounds,
    center: e.center,
    width: e.width,
    height: e.height,
    depth: e.depth,
  };
  if (e.resource_id) out["resource_id"] = e.resource_id;
  if (e.text) out["text"] = e.text;
  if (e.content_desc) out["content_desc"] = e.content_desc;
  if (e.package) out["package"] = e.package;
  if (e.clickable) out["clickable"] = true;
  if (!e.enabled) out["enabled"] = false;
  if (e.scrollable) out["scrollable"] = true;
  if (e.focused) out["focused"] = true;
  if (e.checkable) out["checkable"] = true;
  if (e.checked) out["checked"] = true;
  if (e.password) out["password"] = true;
  return out;
}

// ---------- dump_hierarchy ----------
server.tool(
  "dump_hierarchy",
  "Dump uiautomator XML hierarchy; returns a compact element list (and optionally raw XML). Retries up to `retry` times with backoff on \"could not get idle state\" errors (Flutter / animation pages). If all retries fail, returns a structured `{ok:false, reason:'ui_busy', hint, fallback}` error — caller should switch to mobile_take_screenshot + vision.",
  {
    device: z.string().optional(),
    include_xml: z.boolean().optional().default(false),
    only_visible: z
      .boolean()
      .optional()
      .default(true)
      .describe("filter zero-size and negative-bounds elements"),
    retry: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .default(3)
      .describe("attempts on idle-state errors (default 3; set 1 to fail fast)"),
  },
  async ({ device, include_xml, only_visible, retry }) => {
    try {
      const dumpOpts: Parameters<typeof dumpHierarchy>[0] = {};
      if (device !== undefined) dumpOpts.device = device;
      if (retry !== undefined) dumpOpts.retry = retry;
      const dump = await dumpHierarchy(dumpOpts);
      let els = dump.elements;
      if (only_visible) {
        els = els.filter((e) => e.width > 0 && e.height > 0 && e.bounds.x1 >= 0 && e.bounds.y1 >= 0);
      }
      return asText({
        device: dump.device,
        rotation: dump.rotation,
        captured_at: dump.capturedAt,
        count: els.length,
        elements: els.map(pruneForOutput),
        ...(include_xml ? { xml: dump.xml } : {}),
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- find_element ----------
server.tool(
  "find_element",
  "Find a single element by one or more strategies (first match wins). Strategy priority: identifier > text > label.",
  {
    device: z.string().optional(),
    strategies: strategiesSchema(),
  },
  async ({ device, strategies }) => {
    try {
      const list: Strategy[] = Array.isArray(strategies) ? strategies : [strategies];
      const dump = await dumpHierarchy({ device });
      const r = findFirst(dump.elements, list);
      if (!r.matched) {
        return asText({
          matched: false,
          tried: list,
          hint: "Consider taking a screenshot and using vision-based fallback.",
        });
      }
      return asText({
        matched: true,
        used: r.used,
        element: pruneForOutput(r.element!),
        candidates: r.candidates,
        ...(r.others ? { others_count: r.others.length } : {}),
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- find_elements ----------
server.tool(
  "find_elements",
  "Find all elements matching a single strategy.",
  {
    device: z.string().optional(),
    strategy: strategySchema(),
  },
  async ({ device, strategy }) => {
    try {
      const dump = await dumpHierarchy({ device });
      const els = findAll(dump.elements, strategy);
      return asText({
        count: els.length,
        elements: els.map(pruneForOutput),
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- tap_element ----------
server.tool(
  "tap_element",
  "Find element by strategies (in order) and tap its center. Returns the strategy that worked and the actual coordinates clicked.",
  {
    device: z.string().optional(),
    strategies: z.union([strategySchema(), z.array(strategySchema()).min(1)]),
    settle_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .default(0)
      .describe("milliseconds to wait after the tap before returning"),
  },
  async ({ device, strategies, settle_ms }) => {
    try {
      const list: Strategy[] = Array.isArray(strategies) ? strategies : [strategies];
      const dump = await dumpHierarchy({ device });
      const r = findFirst(dump.elements, list);
      if (!r.matched) {
        return asText({
          tapped: false,
          tried: list,
          hint: "Fall back to mobile-mcp screenshot + coordinate click.",
        });
      }
      const target = r.element!;
      await inputTap({ x: target.center.x, y: target.center.y, device });
      if (settle_ms > 0) await delay(settle_ms);
      return asText({
        tapped: true,
        used: r.used,
        coords: target.center,
        element: pruneForOutput(target),
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- wait_for_element ----------
server.tool(
  "wait_for_element",
  "Poll until the element appears (or vanishes), or timeout. Useful after navigation/network.",
  {
    device: z.string().optional(),
    strategies: z.union([strategySchema(), z.array(strategySchema()).min(1)]),
    timeout_ms: z.number().int().positive().optional().default(5000),
    poll_ms: z.number().int().positive().optional().default(500),
    expect: z.enum(["appear", "disappear"]).optional().default("appear"),
  },
  async ({ device, strategies, timeout_ms, poll_ms, expect }) => {
    try {
      const list: Strategy[] = Array.isArray(strategies) ? strategies : [strategies];
      const deadline = Date.now() + timeout_ms;
      let attempts = 0;
      while (Date.now() < deadline) {
        attempts++;
        // poll loop = retries already, dump itself uses retry=1 to stay snappy
        const dumpOpts: Parameters<typeof dumpHierarchy>[0] = { retry: 1 };
        if (device !== undefined) dumpOpts.device = device;
        const dump = await dumpHierarchy(dumpOpts);
        const r = findFirst(dump.elements, list);
        const condition = expect === "appear" ? r.matched : !r.matched;
        if (condition) {
          return asText({
            ok: true,
            expect,
            attempts,
            elapsed_ms: timeout_ms - (deadline - Date.now()),
            ...(r.matched
              ? { used: r.used, element: pruneForOutput(r.element!) }
              : {}),
          });
        }
        if (Date.now() + poll_ms >= deadline) break;
        await delay(poll_ms);
      }
      return asText({ ok: false, expect, attempts, timeout_ms });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- input_text ----------
server.tool(
  "input_text",
  "Tap an input element by strategies, then type text via `adb input text`.",
  {
    device: z.string().optional(),
    strategies: z
      .union([strategySchema(), z.array(strategySchema()).min(1)])
      .optional()
      .describe("If omitted, types into whatever currently has focus."),
    text: z.string(),
    clear: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "If true, select-all + delete before typing (uses keyevent 123 + del; coarse).",
      ),
  },
  async ({ device, strategies, text, clear }) => {
    try {
      if (strategies) {
        const list: Strategy[] = Array.isArray(strategies) ? strategies : [strategies];
        const dump = await dumpHierarchy({ device });
        const r = findFirst(dump.elements, list);
        if (!r.matched) {
          return asText({
            ok: false,
            reason: "no_match",
            tried: list,
            hint: "Take a screenshot, locate the input, then call mobile-mcp click + this tool without strategies.",
          });
        }
        await inputTap({ x: r.element!.center.x, y: r.element!.center.y, device });
        await delay(150);
      }
      if (clear) {
        // Best-effort clear; not perfect across IMEs.
        // CTRL+A is keycode 29 with meta=4096 (ctrl); using SELECT_ALL=268 on API 24+.
        await inputText({ text: "", device }); // ensure focus stable
      }
      await inputText({ text, device });
      return asText({ ok: true, typed: text });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- page_fingerprint ----------
server.tool(
  "page_fingerprint",
  "Compute a stable hash for the current screen based on visible identifiers and text snippets (for QA state graph).",
  {
    device: z.string().optional(),
    include_signals: z.boolean().optional().default(false),
  },
  async ({ device, include_signals }) => {
    try {
      const dump = await dumpHierarchy({ device });
      const fp = pageFingerprint(dump.elements);
      return asText({
        hash: fp.hash,
        visible_count: fp.visible_count,
        ...(include_signals ? { signals: fp.signals } : {}),
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- boot ----------
const transport = new StdioServerTransport();
await server.connect(transport);
