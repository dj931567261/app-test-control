// Element matching strategies and selection.
//
// Strategy `by` values (priority high → low when reasoning at the caller):
//   identifier        — exact match on resource-id (most stable across runs)
//   text              — exact match on visible text
//   label             — content-desc match. Exact first; a clean, single-line
//                       query may fall back to a normalized compare (first line
//                       only, trimmed). Any multi-match result requires an
//                       explicit index and is never selected by DOM order.
//   text_contains     — substring on text
//   label_contains    — substring on content-desc
//   class             — exact match on class name (rarely unique alone)
//
// Optional modifiers:
//   only_clickable    — require clickable=true
//   only_enabled      — require enabled=true (default true)
//   index             — when multiple match, pick this index (0-based)

import type { UiElement } from "./uiautomator.js";
import { MAX_EXPLICIT_CANDIDATE_INDEX } from "./limits.js";

/**
 * Normalize a content-desc for Flutter/TalkBack tolerant matching.
 * Flutter widgets often expose accessibility noise appended after a newline,
 * e.g. "概览\n第 1 个标签，共 5 个" or a metric card "RPM\n12\nTPM\n111.4k".
 * We keep only the first line and trim surrounding whitespace so a clean
 * caller value ("概览") can still hit.
 */
export function normalizeLabel(v: string): string {
  const firstLine = v.split(/[\r\n]/, 1)[0] ?? "";
  return firstLine.trim();
}

export type StrategyBy =
  | "identifier"
  | "text"
  | "label"
  | "text_contains"
  | "label_contains"
  | "class";

export interface Strategy {
  by: StrategyBy;
  value: string;
  /** Default true; set false to allow disabled elements. */
  only_enabled?: boolean;
  /** Default false. */
  only_clickable?: boolean;
  /** If multiple match, explicitly pick this 0-based candidate index. */
  index?: number;
}

export interface FindResult {
  matched: boolean;
  /** Strategy that produced the match, or the ambiguous candidate set. */
  used?: Strategy;
  element?: UiElement;
  /** Total candidates seen before applying index. */
  candidates: number;
  /** True when any strategy found multiple candidates without an explicit index. */
  ambiguous?: boolean;
  /** Secondary matches when matched, or all candidates when ambiguous. */
  others?: UiElement[];
}

export interface ElementAnchor {
  resourceId: string;
  contentDesc: string;
  text: string;
  className: string;
  bounds: UiElement["bounds"];
}

/** Capture identity-bearing fields before a focus/text mutation. */
export function elementAnchor(element: UiElement): ElementAnchor {
  return {
    resourceId: element.resource_id,
    contentDesc: element.content_desc,
    text: element.text,
    className: element.class,
    bounds: element.bounds,
  };
}

/** Whether an anchor can survive clearing the element's mutable text value. */
export function hasStableAnchor(anchor: ElementAnchor): boolean {
  return anchor.resourceId.length > 0 || anchor.contentDesc.length > 0;
}

function sameBounds(left: UiElement["bounds"], right: UiElement["bounds"]): boolean {
  return left.x1 === right.x1 && left.y1 === right.y1 &&
    left.x2 === right.x2 && left.y2 === right.y2;
}

/**
 * Relocate the exact logical target after tapping/clearing. Prefer a unique
 * resource-id, then a unique exact content-desc; mutable text is permitted
 * only before a clear. All available stable fields are intersected and exact
 * bounds provide cross-generation continuity; ambiguity or drift fails closed.
 */
export function locateElementByAnchor(
  elements: UiElement[],
  anchor: ElementAnchor,
  allowMutableText: boolean,
  requireBoundsContinuity = true,
): UiElement | undefined {
  if (!hasStableAnchor(anchor) && !(allowMutableText && anchor.text)) {
    return undefined;
  }
  let candidates = elements.filter((element) =>
    element.class === anchor.className && element.width > 0 && element.height > 0
  );
  if (anchor.resourceId) {
    candidates = candidates.filter((element) =>
      element.resource_id === anchor.resourceId
    );
  }
  if (anchor.contentDesc) {
    candidates = candidates.filter((element) =>
      element.content_desc === anchor.contentDesc
    );
  }
  if (allowMutableText && anchor.text) {
    candidates = candidates.filter((element) =>
      element.text === anchor.text
    );
  }

  // A unique id/label is not sufficient across hierarchy generations: if the
  // original field disappeared, a sibling/recycled row with the same metadata
  // could become the sole match. Require the original bounds as an additional
  // continuity check and fail closed if layout changed.
  if (requireBoundsContinuity) {
    candidates = candidates.filter((element) => sameBounds(element.bounds, anchor.bounds));
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Whether the strategy still identifies one or more present elements. */
export function hasPresentCandidates(result: FindResult): boolean {
  return result.matched || result.ambiguous === true;
}

function passesFilters(
  e: UiElement,
  onlyEnabled: boolean,
  onlyClickable: boolean,
): boolean {
  if (onlyEnabled && !e.enabled) return false;
  if (onlyClickable && !e.clickable) return false;
  if (e.width === 0 || e.height === 0) return false;
  return true;
}

function elementsByStrategy(
  elements: UiElement[],
  s: Strategy,
): UiElement[] {
  const onlyEnabled = s.only_enabled !== false;
  const onlyClickable = s.only_clickable === true;
  const v = s.value;

  // Empty exact values commonly occur on container nodes, while every string
  // contains "". Treating an empty selector as valid could make tap/input pick
  // an arbitrary element even if a caller bypasses the MCP schema.
  if (v.length === 0) {
    return [];
  }

  // label is special-cased: try exact content-desc first, then fall back to a
  // normalized (first-line, trimmed) compare so Flutter/TalkBack noise labels
  // still match. Exact matches are always ordered before normalized-only ones.
  if (s.by === "label") {
    const pool = elements.filter((e) => passesFilters(e, onlyEnabled, onlyClickable));
    const exact = pool.filter((e) => e.content_desc === v);
    if (exact.length > 0) {
      return exact;
    }

    // A multi-line value carries semantics beyond its first line. If exact
    // matching failed, truncating the query could incorrectly match a different
    // label such as "Status\nOffline" for "Status\nOnline". Likewise, trimming
    // a caller's query hides accidental input. Only a clean single-line query
    // is eligible for the tolerant Flutter/TalkBack fallback.
    const cleanSingleLine = v === v.trim() && !/[\r\n]/.test(v);
    if (!cleanSingleLine) {
      return [];
    }

    return pool.filter((e) => normalizeLabel(e.content_desc) === v);
  }

  return elements.filter((e) => {
    if (!passesFilters(e, onlyEnabled, onlyClickable)) return false;
    switch (s.by) {
      case "identifier":
        return e.resource_id === v;
      case "text":
        return e.text === v;
      case "text_contains":
        return e.text.includes(v);
      case "label_contains":
        return e.content_desc.includes(v);
      case "class":
        return e.class === v;
      default:
        return false;
    }
  });
}

export function findOne(elements: UiElement[], strategy: Strategy): FindResult {
  const matches = elementsByStrategy(elements, strategy);
  if (matches.length === 0) return { matched: false, candidates: 0 };

  // Never operate on a candidate that a bounded ambiguity response could not
  // have shown to the caller, even when this helper is invoked outside MCP.
  if (
    strategy.index !== undefined &&
    (!Number.isSafeInteger(strategy.index) ||
      strategy.index < 0 ||
      strategy.index > MAX_EXPLICIT_CANDIDATE_INDEX)
  ) {
    return { matched: false, used: strategy, candidates: matches.length };
  }

  // Exact text/resource-id/content-desc can also legitimately appear more than
  // once. Silently choosing DOM order is unsafe for tap/input callers no matter
  // which strategy produced the candidates. The caller must inspect them and
  // pass the candidate-array index explicitly.
  if (matches.length > 1 && strategy.index === undefined) {
    return {
      matched: false,
      used: strategy,
      candidates: matches.length,
      ambiguous: true,
      others: matches,
    };
  }

  const wantIndex = strategy.index ?? 0;
  const picked = matches[wantIndex];
  if (!picked) {
    return { matched: false, used: strategy, candidates: matches.length };
  }
  const others = matches.length > 1 ? matches.filter((m) => m.index !== picked.index) : undefined;
  return {
    matched: true,
    used: strategy,
    element: picked,
    candidates: matches.length,
    ...(others ? { others } : {}),
  };
}

/**
 * Try strategies in order; return the first match.
 * Useful when caller wants "prefer resource-id, fall back to text, fall back to label".
 */
export function findFirst(
  elements: UiElement[],
  strategies: Strategy[],
): FindResult {
  let ambiguous: FindResult | undefined;
  let ambiguousCandidates: Set<UiElement> | undefined;
  for (const s of strategies) {
    const r = findOne(elements, s);
    if (r.ambiguous) {
      if (!ambiguous) {
        ambiguous = r;
        ambiguousCandidates = new Set(r.others ?? []);
      }
      continue;
    }
    if (r.matched) {
      // A later strategy may safely resolve an earlier multi-match ambiguity
      // only when its selected element belongs to that earlier candidate set.
      // Otherwise an unrelated unique fallback could make tap/input operate on
      // a completely different control. Object identity is stable within this
      // one hierarchy dump and avoids trusting caller-visible index values.
      if (!ambiguous) return r;
      if (
        (r.candidates === 1 || s.index !== undefined) &&
        ambiguousCandidates?.has(r.element!)
      ) {
        return r;
      }
    }
  }
  return ambiguous ?? { matched: false, candidates: 0 };
}

export function findAll(elements: UiElement[], strategy: Strategy): UiElement[] {
  return elementsByStrategy(elements, strategy);
}
