// Element matching strategies and selection.
//
// Strategy `by` values (priority high → low when reasoning at the caller):
//   identifier        — exact match on resource-id (most stable across runs)
//   text              — exact match on visible text
//   label             — content-desc match. Exact first; if none, falls back to
//                       a normalized compare (first line only, trimmed). This
//                       recovers Flutter/TalkBack labels that carry accessibility
//                       noise, e.g. content-desc="概览\n第 1 个标签，共 5 个" still
//                       matches by:label="概览".
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
  /** Strategy that produced the match, when matched. */
  used?: Strategy;
  element?: UiElement;
  /** Total candidates seen before applying index. */
  candidates: number;
  /** When matched, secondary matches (omit if only one). */
  others?: UiElement[];
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

  // label is special-cased: try exact content-desc first, then fall back to a
  // normalized (first-line, trimmed) compare so Flutter/TalkBack noise labels
  // still match. Exact matches are always ordered before normalized-only ones.
  if (s.by === "label") {
    const pool = elements.filter((e) => passesFilters(e, onlyEnabled, onlyClickable));
    const exact = pool.filter((e) => e.content_desc === v);
    if (exact.length > 0) return exact;
    const nv = normalizeLabel(v);
    if (nv === "") return [];
    return pool.filter((e) => normalizeLabel(e.content_desc) === nv);
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
  const wantIndex = strategy.index ?? 0;
  const picked = matches[wantIndex] ?? matches[0]!;
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
  for (const s of strategies) {
    const r = findOne(elements, s);
    if (r.matched) return r;
  }
  return { matched: false, candidates: 0 };
}

export function findAll(elements: UiElement[], strategy: Strategy): UiElement[] {
  return elementsByStrategy(elements, strategy);
}
