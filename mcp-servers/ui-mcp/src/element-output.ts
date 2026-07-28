import type { FindResult } from "./finder.js";
import type { UiElement } from "./uiautomator.js";
import {
  MAX_AMBIGUITY_ELEMENTS,
  MAX_ELEMENT_OUTPUT_FIELD_BYTES,
} from "./limits.js";

/** Keep ambiguity responses bounded so one noisy accessibility tree cannot flood MCP. */
export { MAX_AMBIGUITY_ELEMENTS } from "./limits.js";

export function boundedOutputField(value: string): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= MAX_ELEMENT_OUTPUT_FIELD_BYTES) {
    return { value, truncated: false };
  }
  let end = MAX_ELEMENT_OUTPUT_FIELD_BYTES;
  while (end > 0 && (encoded[end] ?? 0) >> 6 === 0b10) end -= 1;
  return {
    value: encoded.subarray(0, end).toString("utf8"),
    truncated: true,
  };
}

export function pruneForOutput(e: UiElement): Record<string, unknown> {
  // Trim noisy/empty fields to keep MCP responses compact.
  let fieldsTruncated = false;
  const addField = (out: Record<string, unknown>, key: string, value: string) => {
    if (!value) return;
    const bounded = boundedOutputField(value);
    out[key] = bounded.value;
    fieldsTruncated ||= bounded.truncated;
  };
  const out: Record<string, unknown> = {
    index: e.index,
    bounds: e.bounds,
    center: e.center,
    width: e.width,
    height: e.height,
    depth: e.depth,
  };
  addField(out, "class", e.class);
  addField(out, "resource_id", e.resource_id);
  if (e.password) {
    // Accessibility trees sometimes expose the actual password/token value in
    // text or content-desc. Internal matching still uses the original element,
    // but no MCP-facing representation may echo those fields.
    out["sensitive_text_redacted"] = true;
  } else {
    addField(out, "text", e.text);
    addField(out, "content_desc", e.content_desc);
  }
  addField(out, "package", e.package);
  if (e.clickable) out["clickable"] = true;
  if (!e.enabled) out["enabled"] = false;
  if (e.scrollable) out["scrollable"] = true;
  if (e.focused) out["focused"] = true;
  if (e.checkable) out["checkable"] = true;
  if (e.checked) out["checked"] = true;
  if (e.password) out["password"] = true;
  if (fieldsTruncated) out["output_fields_truncated"] = true;
  return out;
}

export function ambiguityForOutput(r: FindResult): Record<string, unknown> | undefined {
  if (!r.ambiguous) return undefined;
  const all = r.others ?? [];
  const elements = all.slice(0, MAX_AMBIGUITY_ELEMENTS).map((element, candidateIndex) => ({
    // Strategy.index selects this candidate-array ordinal. UiElement.index below
    // remains the hierarchy-global diagnostic index and must not be passed back.
    candidate_index: candidateIndex,
    ...pruneForOutput(element),
  }));
  return {
    reason: "ambiguous",
    used: r.used,
    candidates: r.candidates,
    elements,
    elements_truncated: all.length > elements.length,
    hint:
      "Multiple elements matched. Refine filters (for example only_clickable), add a later unique strategy, or pass an explicit strategy index equal to a returned candidate_index; do not reuse the hierarchy-global element index.",
  };
}

/** Preserve mutation uncertainty when the shared clear deadline expires. */
export function clearDeadlineForOutput(
  deleteEvents: number,
  inputStarted: boolean,
  inputCompleted: boolean,
  deleteMayHaveApplied = false,
): Record<string, unknown> {
  if (inputStarted) {
    return {
      ok: false,
      reason: "clear_timeout",
      delete_events: deleteEvents,
      delete_may_have_applied: deleteMayHaveApplied,
      field_may_have_changed: deleteEvents > 0 || deleteMayHaveApplied || inputStarted,
      input_may_have_applied: true,
      input_sent: inputCompleted,
      verification: "timed_out",
      hint: inputCompleted
        ? "The replacement input command completed, but post-input verification exceeded the shared deadline. Do not blindly retry; inspect the field first."
        : "The replacement input command started and may have applied before the shared deadline interrupted it. Do not blindly retry; inspect the field first.",
    };
  }
  return {
    ok: false,
    reason: "clear_timeout",
    delete_events: deleteEvents,
    delete_may_have_applied: deleteMayHaveApplied,
    field_may_have_changed: deleteEvents > 0 || deleteMayHaveApplied,
    input_may_have_applied: false,
    input_sent: false,
    verification: "not_started",
    hint: "The shared clear deadline interrupted an ADB or hierarchy operation before replacement input started; no replacement input was sent.",
  };
}

/** Cancellation can race with a device-side delete or input command. Never
 * imply that retrying is safe when a mutation may already have reached adb. */
export function cancellationForOutput(
  deleteEvents: number,
  inputStarted: boolean,
  inputCompleted: boolean,
  deleteMayHaveApplied = false,
): Record<string, unknown> {
  const mayHaveChanged = deleteEvents > 0 || deleteMayHaveApplied || inputStarted;
  return {
    ok: false,
    reason: "cancelled",
    delete_events: deleteEvents,
    delete_may_have_applied: deleteMayHaveApplied,
    field_may_have_changed: mayHaveChanged,
    input_may_have_applied: inputStarted,
    input_sent: inputCompleted,
    verification: inputStarted ? "cancelled" : "not_started",
    hint: mayHaveChanged
      ? "The request was cancelled after a device mutation may have started. Inspect the field before retrying; do not blindly repeat the input."
      : "The request was cancelled before any delete or replacement input was sent.",
  };
}
