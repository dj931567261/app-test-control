// Element matching strategies and selection.
//
// Strategy `by` values (priority high → low when reasoning at the caller):
//   identifier        — exact match on resource-id (most stable across runs)
//   text              — exact match on visible text
//   label             — exact match on content-desc
//   text_contains     — substring on text
//   label_contains    — substring on content-desc
//   class             — exact match on class name (rarely unique alone)
//
// Optional modifiers:
//   only_clickable    — require clickable=true
//   only_enabled      — require enabled=true (default true)
//   index             — when multiple match, pick this index (0-based)

import type { UiElement } from "./uiautomator.js";

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

function elementsByStrategy(
  elements: UiElement[],
  s: Strategy,
): UiElement[] {
  const onlyEnabled = s.only_enabled !== false;
  const onlyClickable = s.only_clickable === true;
  const v = s.value;

  return elements.filter((e) => {
    if (onlyEnabled && !e.enabled) return false;
    if (onlyClickable && !e.clickable) return false;
    if (e.width === 0 || e.height === 0) return false;
    switch (s.by) {
      case "identifier":
        return e.resource_id === v;
      case "text":
        return e.text === v;
      case "label":
        return e.content_desc === v;
      case "text_contains":
        return e.text.includes(v);
      case "label_contains":
        return e.content_desc.includes(v);
      case "class":
        return e.class === v;
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
