// Group crashes by signature; surface representative + count per unique bug.

import { computeSignature, parseStack, type CrashKind, type SignatureResult } from "./signature.js";

export interface CrashInput {
  id: string;
  /** Free-form signature already produced by log-mcp (used as fallback for human-readable label). */
  signature?: string;
  /** Full stack/block text — required for re-hashing. */
  stack: string;
  kind?: string;
  step_index?: number;
}

export interface CrashGroup {
  fingerprint: string;
  kind: CrashKind;
  label: string;                    // human-readable
  exception_class?: string;
  top_frames: string[];
  occurrences: number;
  instance_ids: string[];           // sorted
  first_step_index?: number;        // earliest step_index across instances
}

export interface DedupResult {
  total: number;            // total crash records
  unique: number;           // number of distinct groups
  groups: CrashGroup[];     // sorted by occurrences desc
}

export function dedupCrashes(crashes: CrashInput[]): DedupResult {
  const byFp = new Map<string, CrashGroup>();
  for (const c of crashes) {
    const parsed = parseStack(c.stack);
    const sig = computeSignature(parsed);
    const existing = byFp.get(sig.fingerprint);
    if (existing) {
      existing.occurrences += 1;
      existing.instance_ids.push(c.id);
      if (c.step_index !== undefined) {
        existing.first_step_index =
          existing.first_step_index === undefined
            ? c.step_index
            : Math.min(existing.first_step_index, c.step_index);
      }
    } else {
      const grp: CrashGroup = makeGroup(sig, c);
      byFp.set(sig.fingerprint, grp);
    }
  }
  for (const g of byFp.values()) g.instance_ids.sort();
  const groups = Array.from(byFp.values()).sort((a, b) => b.occurrences - a.occurrences);
  return {
    total: crashes.length,
    unique: groups.length,
    groups,
  };
}

function makeGroup(sig: SignatureResult, c: CrashInput): CrashGroup {
  const g: CrashGroup = {
    fingerprint: sig.fingerprint,
    kind: sig.kind,
    label: sig.label,
    top_frames: sig.top_frames,
    occurrences: 1,
    instance_ids: [c.id],
  };
  if (sig.exception_class !== undefined) g.exception_class = sig.exception_class;
  if (c.step_index !== undefined) g.first_step_index = c.step_index;
  return g;
}
