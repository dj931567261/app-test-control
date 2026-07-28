// Page fingerprinting for QA state graph (Phase 2).
// Hash visible identifiers + text snippets so the same screen produces
// the same id across runs.

import { createHash } from "node:crypto";
import type { UiElement } from "./uiautomator.js";
import { boundedOutputField } from "./element-output.js";
import { MAX_FINGERPRINT_OUTPUT_SIGNALS } from "./limits.js";

export interface Fingerprint {
  hash: string;          // sha1, 12 chars
  visible_count: number; // elements considered
  signals: string[];     // bounded samples for debugging; not the hash encoding
  signals_truncated: boolean;
  signal_fields_truncated: boolean;
}

export function pageFingerprint(elements: UiElement[]): Fingerprint {
  const hashSignals: string[] = [];
  const debugSignals: string[] = [];
  let signalFieldsTruncated = false;
  for (const e of elements) {
    // Skip zero-sized or off-screen elements
    if (e.width === 0 || e.height === 0) continue;
    if (e.bounds.x1 < 0 || e.bounds.y1 < 0) continue;
    const id = e.resource_id || "";
    if (e.password) {
      // Password values must neither leak through include_signals nor make the
      // same page oscillate between state hashes as the user types.
      hashSignals.push(JSON.stringify([id, "[password-redacted]", ""]));
      const boundedId = boundedOutputField(id);
      signalFieldsTruncated ||= boundedId.truncated;
      debugSignals.push(`${boundedId.value}|[password-redacted]|`);
      continue;
    }
    const text = e.text.slice(0, 20);
    const label = e.content_desc.slice(0, 20);
    if (!id && !text && !label) continue;
    // Encode a tuple rather than concatenating raw fields. Otherwise separators
    // and adjacent records can create deterministic collisions between visibly
    // different pages (for example one record versus two records).
    hashSignals.push(JSON.stringify([id, text, label]));
    const boundedId = boundedOutputField(id);
    const boundedText = boundedOutputField(text);
    const boundedLabel = boundedOutputField(label);
    signalFieldsTruncated ||=
      boundedId.truncated || boundedText.truncated || boundedLabel.truncated;
    debugSignals.push(`${boundedId.value}|${boundedText.value}|${boundedLabel.value}`);
  }
  hashSignals.sort();
  debugSignals.sort();
  const h = createHash("sha1");
  for (const signal of hashSignals) {
    const encoded = Buffer.from(signal, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(encoded.length);
    h.update(length);
    h.update(encoded);
  }
  const signals = debugSignals.slice(0, MAX_FINGERPRINT_OUTPUT_SIGNALS);
  return {
    hash: h.digest("hex").slice(0, 12),
    visible_count: hashSignals.length,
    signals,
    signals_truncated: debugSignals.length > signals.length,
    signal_fields_truncated: signalFieldsTruncated,
  };
}
