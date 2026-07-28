#!/usr/bin/env node
// ui-mcp: Android UI hierarchy query and coordinate-based interaction.
// Hierarchy-first; the caller (Claude) is expected to fall back to
// screenshot-based interaction via mobile-mcp when these tools fail to find.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";

import {
  AdbAbortError,
  AdbDeadlineError,
  AdbError,
  clearFocusedText,
  inputTap,
  inputText,
  remainingDeadlineMs,
} from "./adb.js";
import {
  dumpHierarchy,
  redactSensitiveHierarchyXml,
  UiBusyError,
} from "./uiautomator.js";
import {
  elementAnchor,
  findFirst,
  findAll,
  hasStableAnchor,
  locateElementByAnchor,
  type Strategy,
  type StrategyBy,
} from "./finder.js";
import { pageFingerprint } from "./page-fingerprint.js";
import {
  ambiguityForOutput,
  cancellationForOutput,
  clearDeadlineForOutput,
  pruneForOutput,
} from "./element-output.js";
import {
  MAX_EXPLICIT_CANDIDATE_INDEX,
  MAX_FIND_ELEMENTS_OUTPUT,
  MAX_HIERARCHY_OUTPUT_ELEMENTS,
  MAX_UI_RESPONSE_BYTES,
} from "./limits.js";
import { waitForElementCore } from "./wait-for-element.js";

const server = new McpServer({
  name: "ui-mcp",
  version: "0.1.0",
});

function asText(payload: unknown) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_UI_RESPONSE_BYTES) {
    throw new RangeError(
      `UI MCP response exceeds ${MAX_UI_RESPONSE_BYTES} byte limit; narrow the query`,
    );
  }
  return { content: [{ type: "text" as const, text }] };
}

function boundedErrorText(value: string): string {
  const maxBytes = 64 * 1024;
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (encoded[end] ?? 0) >> 6 === 0b10) end -= 1;
  return `${encoded.subarray(0, end).toString("utf8")}\n...[UI error truncated]`;
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
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: boundedErrorText(text) }],
  };
}

const STRATEGY_BY = [
  "identifier",
  "text",
  "label",
  "text_contains",
  "label_contains",
  "class",
] as const satisfies readonly StrategyBy[];

const MAX_STRATEGIES = 20;
const MAX_STRATEGY_VALUE_LENGTH = 4096;
const MAX_CLEAR_DELETE_EVENTS = 16;
const CLEAR_DEADLINE_MS = 30_000;
const deviceSchema = z
  .string()
  .trim()
  .min(1, "device must not be empty")
  .max(256, "device is too large")
  .refine(
    (value) => !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value),
    "device contains control characters",
  );

async function delayWithinDeadline(
  ms: number,
  deadlineAtMs?: number,
  signal?: AbortSignal,
): Promise<void> {
  if (deadlineAtMs === undefined) {
    await delay(ms, undefined, signal === undefined ? undefined : { signal });
    return;
  }
  const remaining = remainingDeadlineMs(deadlineAtMs);
  await delay(
    Math.min(ms, remaining),
    undefined,
    signal === undefined ? undefined : { signal },
  );
  remainingDeadlineMs(deadlineAtMs);
}

function isRequestAbort(error: unknown): boolean {
  return error instanceof AdbAbortError ||
    (error instanceof Error && error.name === "AbortError");
}

function strategySchema() {
  return z.object({
    by: z.enum(STRATEGY_BY),
    value: z
      .string()
      .min(1, "strategy value must not be empty")
      .max(MAX_STRATEGY_VALUE_LENGTH, "strategy value is too large"),
    only_enabled: z.boolean().optional(),
    only_clickable: z.boolean().optional(),
    index: z
      .number()
      .int()
      .min(0)
      .max(
        MAX_EXPLICIT_CANDIDATE_INDEX,
        "strategy index must reference a candidate returned in the bounded ambiguity response",
      )
      .optional(),
  });
}

function strategiesSchema() {
  return z
    .union([
      strategySchema(),
      z.array(strategySchema()).min(1).max(MAX_STRATEGIES),
    ])
    .describe(
      "Single strategy or ordered list. First unambiguous match wins; a later unique strategy or explicit candidate index may resolve any multi-match ambiguity.",
    );
}

// ---------- dump_hierarchy ----------
server.tool(
  "dump_hierarchy",
  "Dump uiautomator XML hierarchy; returns a compact element list (and optionally password-redacted XML). Retries up to `retry` times with backoff on \"could not get idle state\" errors (Flutter / animation pages). If all retries fail, returns a structured `{ok:false, reason:'ui_busy', hint, fallback}` error — caller should switch to mobile_take_screenshot + vision.",
  {
    device: deviceSchema.optional(),
    include_xml: z
      .boolean()
      .optional()
      .default(false)
      .describe("include hierarchy XML with password-node text/content-desc redacted"),
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
  async ({ device, include_xml, only_visible, retry }, extra) => {
    try {
      const dumpOpts: Parameters<typeof dumpHierarchy>[0] = {};
      if (device !== undefined) dumpOpts.device = device;
      if (retry !== undefined) dumpOpts.retry = retry;
      dumpOpts.signal = extra.signal;
      const dump = await dumpHierarchy(dumpOpts);
      let els = dump.elements;
      if (only_visible) {
        els = els.filter((e) => e.width > 0 && e.height > 0 && e.bounds.x1 >= 0 && e.bounds.y1 >= 0);
      }
      const outputElements = els.slice(0, MAX_HIERARCHY_OUTPUT_ELEMENTS);
      return asText({
        device: dump.device,
        rotation: dump.rotation,
        captured_at: dump.capturedAt,
        count: els.length,
        elements: outputElements.map(pruneForOutput),
        elements_truncated: els.length > outputElements.length,
        ...(include_xml
          ? {
              xml: redactSensitiveHierarchyXml(dump.xml),
              xml_sensitive_values_redacted: true,
            }
          : {}),
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
    device: deviceSchema.optional(),
    strategies: strategiesSchema(),
  },
  async ({ device, strategies }, extra) => {
    try {
      const list: Strategy[] = Array.isArray(strategies) ? strategies : [strategies];
      const dump = await dumpHierarchy({ device, signal: extra.signal });
      const r = findFirst(dump.elements, list);
      if (!r.matched) {
        const ambiguity = ambiguityForOutput(r);
        return asText({
          matched: false,
          tried: list,
          ...(ambiguity ?? {
            hint: "Consider taking a screenshot and using vision-based fallback.",
          }),
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
    device: deviceSchema.optional(),
    strategy: strategySchema(),
  },
  async ({ device, strategy }, extra) => {
    try {
      const dump = await dumpHierarchy({ device, signal: extra.signal });
      const els = findAll(dump.elements, strategy);
      const outputElements = els.slice(0, MAX_FIND_ELEMENTS_OUTPUT);
      return asText({
        count: els.length,
        elements: outputElements.map(pruneForOutput),
        elements_truncated: els.length > outputElements.length,
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
    device: deviceSchema.optional(),
    strategies: strategiesSchema(),
    settle_ms: z
      .number()
      .int()
      .nonnegative()
      .max(30_000)
      .optional()
      .default(0)
      .describe("milliseconds to wait after the tap before returning (max 30000)"),
  },
  async ({ device, strategies, settle_ms }, extra) => {
    try {
      const list: Strategy[] = Array.isArray(strategies) ? strategies : [strategies];
      const dump = await dumpHierarchy({ device, signal: extra.signal });
      const r = findFirst(dump.elements, list);
      if (!r.matched) {
        const ambiguity = ambiguityForOutput(r);
        return asText({
          tapped: false,
          tried: list,
          ...(ambiguity ?? {
            hint: "Fall back to mobile-mcp screenshot + coordinate click.",
          }),
        });
      }
      const target = r.element!;
      await inputTap({
        x: target.center.x,
        y: target.center.y,
        device,
        signal: extra.signal,
      });
      if (settle_ms > 0) {
        await delay(settle_ms, undefined, { signal: extra.signal });
      }
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
    device: deviceSchema.optional(),
    strategies: strategiesSchema(),
    timeout_ms: z.number().int().positive().max(120_000).optional().default(5000),
    poll_ms: z.number().int().positive().max(10_000).optional().default(500),
    expect: z.enum(["appear", "disappear"]).optional().default("appear"),
  },
  async ({ device, strategies, timeout_ms, poll_ms, expect }, extra) => {
    try {
      const list: Strategy[] = Array.isArray(strategies) ? strategies : [strategies];
      const waited = await waitForElementCore({
        ...(device === undefined ? {} : { device }),
        strategies: list,
        timeoutMs: timeout_ms,
        pollMs: poll_ms,
        expect,
        signal: extra.signal,
      });
      if (waited.ok) {
        const result = waited.result!;
        return asText({
          ok: true,
          expect,
          attempts: waited.attempts,
          elapsed_ms: waited.elapsedMs,
          ...(result.matched
            ? { used: result.used, element: pruneForOutput(result.element!) }
            : {}),
        });
      }
      return asText({
        ok: false,
        expect,
        attempts: waited.attempts,
        timeout_ms,
        elapsed_ms: waited.elapsedMs,
        ...(expect === "appear" && waited.lastAmbiguity
          ? ambiguityForOutput(waited.lastAmbiguity)
          : {}),
      });
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
    device: deviceSchema.optional(),
    strategies: strategiesSchema()
      .optional()
      .describe("If omitted, types into whatever currently has focus."),
    text: z
      .string()
      .max(10_000, "text is too large for a single adb input command"),
    clear: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "If true, requires strategies, deletes the observed current value, and verifies the field is empty before typing.",
      ),
  },
  async ({ device, strategies, text, clear }, extra) => {
    let clearDeadlineAtMs: number | undefined;
    let clearDeleteEvents = 0;
    let clearDeleteAttemptStarted = false;
    let replacementInputStarted = false;
    let replacementInputCompleted = false;
    try {
      if (clear && !strategies) {
        return asText({
          ok: false,
          reason: "clear_requires_target",
          hint: "Pass strategies so ui-mcp can measure and verify the field before typing.",
        });
      }
      if (clear) clearDeadlineAtMs = Date.now() + CLEAR_DEADLINE_MS;
      let observedCharacters: number | undefined;
      let targetAnchor: ReturnType<typeof elementAnchor> | undefined;
      if (strategies) {
        const list: Strategy[] = Array.isArray(strategies) ? strategies : [strategies];
        const dump = await dumpHierarchy({
          device,
          signal: extra.signal,
          ...(clearDeadlineAtMs !== undefined ? { deadlineAtMs: clearDeadlineAtMs } : {}),
        });
        const r = findFirst(dump.elements, list);
        if (!r.matched) {
          const ambiguity = ambiguityForOutput(r);
          return asText({
            ok: false,
            tried: list,
            ...(ambiguity ?? {
              reason: "no_match",
              hint: "Take a screenshot, locate the input, then call mobile-mcp click + this tool without strategies.",
            }),
          });
        }
        targetAnchor = elementAnchor(r.element!);
        if (clear && !hasStableAnchor(targetAnchor)) {
          return asText({
            ok: false,
            reason: "clear_unstable_target",
            hint: "Clearing needs a stable resource-id or exact accessibility label; mutable text/class/bounds alone cannot safely relocate the same field afterwards.",
          });
        }
        if (clear && r.element!.text.length === 0) {
          return asText({
            ok: false,
            reason: r.element!.password
              ? "clear_unverifiable_password"
              : "clear_unverifiable_empty_text",
            hint: "The hierarchy exposes no current value, so ui-mcp cannot prove whether the field is empty or masked. Omit clear only when the caller already knows the field is empty.",
          });
        }
        // This is an upper bound only. The clear loop sends one DEL at a time
        // and re-reads the same target after every event, so a grapheme deleted
        // by one key event never causes extra Backspaces into an OTP sibling.
        observedCharacters = Array.from(r.element!.text).length;
        if (observedCharacters > MAX_CLEAR_DELETE_EVENTS) {
          return asText({
            ok: false,
            reason: "clear_value_too_long",
            observed_characters: observedCharacters,
            max_delete_events: MAX_CLEAR_DELETE_EVENTS,
            hint: "Refuse an excessively long interactive clear; relaunch into a known-empty state or clear it manually.",
          });
        }
        await inputTap({
          x: r.element!.center.x,
          y: r.element!.center.y,
          device,
          signal: extra.signal,
          ...(clearDeadlineAtMs !== undefined ? { deadlineAtMs: clearDeadlineAtMs } : {}),
        });
        await delayWithinDeadline(150, clearDeadlineAtMs, extra.signal);

        const focused = locateElementByAnchor(
          (await dumpHierarchy({
            device,
            signal: extra.signal,
            ...(clearDeadlineAtMs !== undefined ? { deadlineAtMs: clearDeadlineAtMs } : {}),
          })).elements.filter((element) => element.focused),
          targetAnchor,
          true,
          false,
        );
        if (!focused?.focused) {
          return asText({
            ok: false,
            reason: "target_not_focused",
            hint: "The selected element did not become the focused input; no text was typed.",
          });
        }
        // The soft keyboard may pan/resize the window. Once the same unique
        // focused element is verified by stable metadata + current text, use
        // its post-focus bounds as the strict clear/re-focus continuity anchor.
        targetAnchor = elementAnchor(focused);
      }
      if (clear) {
        let verification = locateElementByAnchor(
          (await dumpHierarchy({
            device,
            retry: 1,
            deadlineAtMs: clearDeadlineAtMs!,
            signal: extra.signal,
          })).elements,
          targetAnchor!,
          false,
        );
        while (
          verification &&
          verification.text.length > 0 &&
          clearDeleteEvents < observedCharacters!
        ) {
          if (!verification.focused) {
            return asText({
              ok: false,
              reason: "focus_moved_during_clear",
              hint: "The target lost focus before it became empty; no further delete or replacement input was sent.",
            });
          }
          if (Date.now() >= clearDeadlineAtMs!) {
            return asText(clearDeadlineForOutput(
              clearDeleteEvents,
              replacementInputStarted,
              replacementInputCompleted,
              clearDeleteAttemptStarted,
            ));
          }
          await clearFocusedText({
            device,
            observedCharacters: 1,
            deadlineAtMs: clearDeadlineAtMs!,
            signal: extra.signal,
            onDeleteStarted: () => {
              clearDeleteAttemptStarted = true;
            },
          });
          clearDeleteEvents++;
          clearDeleteAttemptStarted = false;
          verification = locateElementByAnchor(
            (await dumpHierarchy({
              device,
              retry: 1,
              deadlineAtMs: clearDeadlineAtMs!,
              signal: extra.signal,
            })).elements,
            targetAnchor!,
            false,
          );
        }
        if (!verification || verification.text.length !== 0) {
          return asText({
            ok: false,
            reason: "clear_verification_failed",
            remaining_text_length: verification
              ? Array.from(verification.text).length
              : undefined,
            delete_events: clearDeleteEvents,
            hint: "The field was not observably empty, so no replacement text was typed.",
          });
        }

        // Clearing can move focus in segmented OTP/PIN widgets. Re-focus the
        // verified same element and confirm it before entering replacement
        // text, otherwise `adb input text` could mutate an adjacent field.
        await inputTap({
          x: verification.center.x,
          y: verification.center.y,
          device,
          deadlineAtMs: clearDeadlineAtMs!,
          signal: extra.signal,
        });
        await delayWithinDeadline(150, clearDeadlineAtMs, extra.signal);
        const refocused = locateElementByAnchor(
          (await dumpHierarchy({
            device,
            deadlineAtMs: clearDeadlineAtMs!,
            signal: extra.signal,
          })).elements,
          targetAnchor!,
          false,
        );
        if (!refocused?.focused) {
          return asText({
            ok: false,
            reason: "target_not_focused_after_clear",
            hint: "The cleared field could not be safely re-focused; no replacement text was typed.",
          });
        }
      }
      replacementInputStarted = true;
      await inputText({
        text,
        device,
        signal: extra.signal,
        ...(clearDeadlineAtMs !== undefined ? { deadlineAtMs: clearDeadlineAtMs } : {}),
      });
      replacementInputCompleted = true;
      if (!targetAnchor || !hasStableAnchor(targetAnchor)) {
        return asText({
          ok: true,
          verified: false,
          requested_characters: Array.from(text).length,
          hint: "Text was sent to adb, but the target has no stable identity for post-input verification.",
        });
      }

      const afterInput = locateElementByAnchor(
        (await dumpHierarchy({
          device,
          signal: extra.signal,
          ...(clearDeadlineAtMs !== undefined ? { deadlineAtMs: clearDeadlineAtMs } : {}),
        })).elements,
        targetAnchor,
        false,
      );
      const exactValueExpected = clear || targetAnchor.text.length === 0;
      if (exactValueExpected && !afterInput) {
        return asText({
          ok: false,
          reason: "input_target_lost",
          requested_characters: Array.from(text).length,
          hint: "The same stable input target could not be found after typing, so completion cannot be claimed.",
        });
      }
      if (
        exactValueExpected &&
        afterInput &&
        !afterInput.password &&
        afterInput.text !== text
      ) {
        return asText({
          ok: false,
          reason: "input_verification_failed",
          requested_characters: Array.from(text).length,
          observed_characters: Array.from(afterInput.text).length,
          hint: "The observable field value differs from the requested text (possibly maxLength, IME transformation, or unsupported characters).",
        });
      }
      const verified = Boolean(
        exactValueExpected &&
        afterInput &&
        !afterInput.password &&
        afterInput.text === text
      );
      return asText({
        ok: true,
        verified,
        requested_characters: Array.from(text).length,
        ...(verified ? {} : {
          hint: "Text was sent, but the final value could not be verified exactly.",
        }),
      });
    } catch (err) {
      if (clearDeadlineAtMs !== undefined && err instanceof AdbDeadlineError) {
        return asText(clearDeadlineForOutput(
          clearDeleteEvents,
          replacementInputStarted,
          replacementInputCompleted,
          clearDeleteAttemptStarted,
        ));
      }
      if (isRequestAbort(err)) {
        return asText(cancellationForOutput(
          clearDeleteEvents,
          replacementInputStarted,
          replacementInputCompleted,
          clearDeleteAttemptStarted,
        ));
      }
      return asError(err);
    }
  },
);

// ---------- page_fingerprint ----------
server.tool(
  "page_fingerprint",
  "Compute a stable hash for the current screen based on visible identifiers and text snippets (for QA state graph).",
  {
    device: deviceSchema.optional(),
    include_signals: z.boolean().optional().default(false),
  },
  async ({ device, include_signals }, extra) => {
    try {
      const dump = await dumpHierarchy({ device, signal: extra.signal });
      const fp = pageFingerprint(dump.elements);
      return asText({
        hash: fp.hash,
        visible_count: fp.visible_count,
        ...(include_signals ? {
          signals: fp.signals,
          signals_truncated: fp.signals_truncated,
          signal_fields_truncated: fp.signal_fields_truncated,
        } : {}),
      });
    } catch (err) {
      return asError(err);
    }
  },
);

// ---------- boot ----------
const transport = new StdioServerTransport();
await server.connect(transport);
