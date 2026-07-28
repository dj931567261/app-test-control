// Group crashes by signature; surface representative + count per unique bug.

import { computeSignature, parseStack, type CrashKind, type SignatureResult } from "./signature.js";

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
  legacy_fingerprint?: string;
  /** An old iOS signature matched this sole v2 group via legacy_fingerprint. */
  compatibility_merged?: boolean;
  /** More than one v2 group shared this v1 identity, so old records stayed separate. */
  compatibility_ambiguous?: boolean;
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

function groupKey(
  kind: CrashKind,
  fingerprint: string,
  signatureVersion: SignatureResult["signature_version"],
): string {
  // A short ios-v2 record can intentionally retain the same hash as its v1
  // legacy prefix when Identity Frame duplicates one of the first 3 frames.
  // Keep information levels in separate map namespaces so an ambiguous v1
  // record cannot collide with and silently merge into that v2 group before
  // the compatibility analysis below has a chance to reject the merge.
  return kind === "ios"
    ? `${kind}:${signatureVersion}:${fingerprint}`
    : `${kind}:${fingerprint}`;
}

export function dedupCrashes(crashes: CrashInput[]): DedupResult {
  // Keep enforcement here rather than only at MCP schemas/call sites. This
  // function is also called directly by session analysis and tests.
  assertDedupBudget(crashes);
  const byFp = new Map<string, CrashGroup>();
  const legacyIos: Array<{ crash: CrashInput; sig: SignatureResult }> = [];
  for (const c of crashes) {
    const parsed = parseStack(c.stack);
    const sig = computeSignature(parsed);
    if (sig.kind === "ios" && sig.signature_version === "v1") {
      legacyIos.push({ crash: c, sig });
      continue;
    }
    const key = groupKey(sig.kind, sig.fingerprint, sig.signature_version);
    const existing = byFp.get(key);
    if (existing) {
      mergeInstance(existing, c);
    } else {
      const grp: CrashGroup = makeGroup(sig, c);
      byFp.set(key, grp);
    }
  }

  // A v1 iOS stack lacks the fourth/app-owned identity frame. Merge it into a
  // v2 group only when its legacy fingerprint identifies exactly one group in
  // this dataset. If several richer crashes share that prefix, keeping v1
  // records separate is safer than reviving the old collision.
  const v2ByLegacy = new Map<string, CrashGroup[]>();
  for (const group of byFp.values()) {
    if (group.signature_version !== "ios-v2" || !group.legacy_fingerprint) continue;
    const groups = v2ByLegacy.get(group.legacy_fingerprint) ?? [];
    groups.push(group);
    v2ByLegacy.set(group.legacy_fingerprint, groups);
  }
  for (const { crash, sig } of legacyIos) {
    const compatible = v2ByLegacy.get(sig.fingerprint) ?? [];
    if (compatible.length === 1) {
      mergeInstance(compatible[0]!, crash);
      compatible[0]!.compatibility_merged = true;
      continue;
    }
    const key = groupKey(sig.kind, sig.fingerprint, sig.signature_version);
    const existing = byFp.get(key);
    if (existing) {
      mergeInstance(existing, crash);
      if (compatible.length > 1) existing.compatibility_ambiguous = true;
    } else {
      const group = makeGroup(sig, crash);
      if (compatible.length > 1) group.compatibility_ambiguous = true;
      byFp.set(key, group);
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
