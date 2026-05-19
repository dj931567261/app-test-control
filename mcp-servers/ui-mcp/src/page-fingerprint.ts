// Page fingerprinting for QA state graph (Phase 2).
// Hash visible identifiers + text snippets so the same screen produces
// the same id across runs.

import { createHash } from "node:crypto";
import type { UiElement } from "./uiautomator.js";

export interface Fingerprint {
  hash: string;          // sha1, 12 chars
  visible_count: number; // elements considered
  signals: string[];     // the strings hashed, for debugging
}

export function pageFingerprint(elements: UiElement[]): Fingerprint {
  const signals: string[] = [];
  for (const e of elements) {
    // Skip zero-sized or off-screen elements
    if (e.width === 0 || e.height === 0) continue;
    if (e.bounds.x1 < 0 || e.bounds.y1 < 0) continue;
    const id = e.resource_id || "";
    const text = e.text.slice(0, 20);
    const label = e.content_desc.slice(0, 20);
    if (!id && !text && !label) continue;
    signals.push(`${id}|${text}|${label}`);
  }
  signals.sort();
  const h = createHash("sha1");
  for (const s of signals) h.update(s);
  return {
    hash: h.digest("hex").slice(0, 12),
    visible_count: signals.length,
    signals,
  };
}
