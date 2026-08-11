// Group crashes by signature; surface representative + count per unique bug.

import { computeSignature, type CrashKind, type SignatureResult } from "./signature.js";

/** Hard limits shared by every dedup entry point, including analyze_session. */
export const MAX_CRASH_STACK_BYTES = 4 * 1024 * 1024;
export const MAX_DEDUP_CRASHES = 1000;
export const MAX_DEDUP_TOTAL_STACK_BYTES = 64 * 1024 * 1024;

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
  signature_version: SignatureResult["signature_version"];
  /** Historical identity for explicit lookup only; never participates in grouping. */
  legacy_fingerprint?: string;
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

function assertDedupBudget(crashes: CrashInput[]): void {
  if (!Array.isArray(crashes)) {
    throw new TypeError("crashes must be an array");
  }
  if (crashes.length > MAX_DEDUP_CRASHES) {
    throw new RangeError(
      `crashes exceeds ${MAX_DEDUP_CRASHES} record limit`,
    );
  }

  let totalBytes = 0;
  for (let index = 0; index < crashes.length; index++) {
    const stack = crashes[index]?.stack;
    if (typeof stack !== "string") {
      throw new TypeError(`crashes[${index}].stack must be a string`);
    }
    const stackBytes = Buffer.byteLength(stack, "utf8");
    if (stackBytes > MAX_CRASH_STACK_BYTES) {
      throw new RangeError(
        `crashes[${index}].stack exceeds ${MAX_CRASH_STACK_BYTES} byte size limit`,
      );
    }
    totalBytes += stackBytes;
    if (totalBytes > MAX_DEDUP_TOTAL_STACK_BYTES) {
      throw new RangeError(
        `dedup stack input exceeds ${MAX_DEDUP_TOTAL_STACK_BYTES} total byte limit`,
      );
    }
  }
}

export function signatureGroupKey(
  fingerprint: string,
  signatureVersion: SignatureResult["signature_version"],
): string {
  // Version is a mandatory part of the primary identity for every crash kind.
  // legacy_fingerprint is intentionally excluded and is only an explicit
  // historical-query field on the returned group.
  return JSON.stringify([signatureVersion, fingerprint]);
}

export function dedupCrashes(crashes: CrashInput[]): DedupResult {
  // Keep enforcement here rather than only at MCP schemas/call sites. This
  // function is also called directly by session analysis and tests.
  assertDedupBudget(crashes);
  const byFp = new Map<string, CrashGroup>();
  for (const c of crashes) {
    // Keep the raw text available so Java's explicit v1 compatibility key is
    // computed by the exact historical parser rather than reconstructed from
    // the richer java-v2 ParsedStack.
    const sig = computeSignature(c.stack);
    const key = signatureGroupKey(sig.fingerprint, sig.signature_version);
    const existing = byFp.get(key);
    if (existing) {
      mergeInstance(existing, c);
    } else {
      const grp: CrashGroup = makeGroup(sig, c);
      byFp.set(key, grp);
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

function mergeInstance(group: CrashGroup, crash: CrashInput): void {
  group.occurrences += 1;
  group.instance_ids.push(crash.id);
  if (crash.step_index !== undefined) {
    group.first_step_index = group.first_step_index === undefined
      ? crash.step_index
      : Math.min(group.first_step_index, crash.step_index);
  }
}

function makeGroup(sig: SignatureResult, c: CrashInput): CrashGroup {
  const g: CrashGroup = {
    fingerprint: sig.fingerprint,
    signature_version: sig.signature_version,
    ...(sig.legacy_fingerprint !== undefined
      ? { legacy_fingerprint: sig.legacy_fingerprint }
      : {}),
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
