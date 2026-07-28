// Element matching strategies and selection.
//
// Strategy `by` values (priority high → low when reasoning at the caller):
//   identifier        — exact match on resource-id (most stable across runs)
//   text              — exact match on visible text
//   label             — content-desc match. Exact first; a clean, single-line
//                       query may fall back to a normalized compare (first line
//                       only, trimmed). Ambiguous normalized matches are never
//                       selected implicitly by findOne.
//   text_contains     — substring on text
//   label_contains    — substring on content-desc
//   class             — exact match on class name (rarely unique alone)
//
// Optional modifiers:
//   only_clickable    — require clickable=true
//   only_enabled      — require enabled=true (default true)
//   index             — when multiple match, pick this index (0-based)

import type { UiElement } from "./uiautomator.js";

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
  /** If multiple match, pick this index. Default 0 (first). */
  index?: number;
}

export interface FindResult {
  matched: boolean;
  /** Strategy that produced the match, or the ambiguous candidate set. */
  used?: Strategy;
  element?: UiElement;
  /** Total candidates seen before applying index. */
  candidates: number;
  /** True when normalized label fallback found multiple candidates without index. */
  ambiguous?: boolean;
  /** Secondary matches when matched, or all candidates when ambiguous. */
  others?: UiElement[];
}

/** Whether the strategy still identifies one or more present elements. */
export function hasPresentCandidates(result: FindResult): boolean {
  return result.matched || result.ambiguous === true;
}

interface StrategyMatches {
  elements: UiElement[];
  /** Only normalized label matches require ambiguity protection. */
  normalizedLabelFallback: boolean;
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
): StrategyMatches {
  const onlyEnabled = s.only_enabled !== false;
  const onlyClickable = s.only_clickable === true;
  const v = s.value;

  // Empty exact values commonly occur on container nodes, while every string
  // contains "". Treating an empty selector as valid could make tap/input pick
  // an arbitrary element even if a caller bypasses the MCP schema.
  if (v.length === 0) {
    return { elements: [], normalizedLabelFallback: false };
  }

  // label is special-cased: try exact content-desc first, then fall back to a
  // normalized (first-line, trimmed) compare so Flutter/TalkBack noise labels
  // still match. Exact matches are always ordered before normalized-only ones.
  if (s.by === "label") {
    const pool = elements.filter((e) => passesFilters(e, onlyEnabled, onlyClickable));
    const exact = pool.filter((e) => e.content_desc === v);
    if (exact.length > 0) {
      return { elements: exact, normalizedLabelFallback: false };
    }

    // A multi-line value carries semantics beyond its first line. If exact
    // matching failed, truncating the query could incorrectly match a different
    // label such as "Status\nOffline" for "Status\nOnline". Likewise, trimming
    // a caller's query hides accidental input. Only a clean single-line query
    // is eligible for the tolerant Flutter/TalkBack fallback.
    const cleanSingleLine = v === v.trim() && !/[\r\n]/.test(v);
    if (!cleanSingleLine) {
      return { elements: [], normalizedLabelFallback: false };
    }

    return {
      elements: pool.filter((e) => normalizeLabel(e.content_desc) === v),
      normalizedLabelFallback: true,
    };
  }

  return { elements: elements.filter((e) => {
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
  }), normalizedLabelFallback: false };
}

export function findOne(elements: UiElement[], strategy: Strategy): FindResult {
  const resolution = elementsByStrategy(elements, strategy);
  const matches = resolution.elements;
  if (matches.length === 0) return { matched: false, candidates: 0 };

  // Normalization deliberately discards content after the first line. When
  // several labels collapse to the same value, silently choosing DOM order is
  // unsafe for tap/input callers. An explicit index remains available when the
  // caller has inspected candidates (for example through findAll).
  if (
    resolution.normalizedLabelFallback &&
    matches.length > 1 &&
    strategy.index === undefined
  ) {
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
  for (const s of strategies) {
    const r = findOne(elements, s);
    if (r.ambiguous) {
      ambiguous ??= r;
      continue;
    }
    if (r.matched) {
      // A later strategy may safely resolve an earlier normalized-label
      // ambiguity when it identifies exactly one candidate, or when the caller
      // explicitly chose an index. Do not let an implicit multi-candidate
      // fallback (for example label_contains) silently pick DOM order.
      if (!ambiguous || r.candidates === 1 || s.index !== undefined) return r;
    }
  }
  return ambiguous ?? { matched: false, candidates: 0 };
}

export function findAll(elements: UiElement[], strategy: Strategy): UiElement[] {
  return elementsByStrategy(elements, strategy).elements;
}
