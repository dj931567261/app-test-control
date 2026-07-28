// Session-level analysis: read crashes.jsonl + steps.jsonl from a session
// directory, run dedup, and produce summary structures.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { dedupCrashes, type CrashGroup, type CrashInput, type DedupResult } from "./dedup.js";

interface StoredCrash {
  id: string;
  ts: string;
  step_index?: number;
  signature: string;
  kind?: string;
  stack_path: string;
  log_path?: string;
  repro_path: number[];
}

interface StoredStep {
  index: number;
  ts: string;
  action: string;
  result?: "ok" | "fail" | "skip";
  screenshot?: string;
  log_excerpt?: string;
  notes?: string;
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  try {
    const txt = await readFile(filePath, "utf8");
    return txt
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as T);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

/**
 * Hydrate StoredCrash records with their on-disk stack text and re-run dedup.
 * Each group additionally carries `repro_paths` (one per instance) for downstream
 * minimization workflows.
 */
export interface SessionAnalysis extends DedupResult {
  groups: SessionCrashGroup[];
}

export interface SessionCrashGroup extends CrashGroup {
  repro_paths: number[][];
  instance_step_indices: number[];
}

export async function analyzeSession(sessionDir: string): Promise<SessionAnalysis> {
  const crashes = await readJsonl<StoredCrash>(path.join(sessionDir, "crashes.jsonl"));

  // Build CrashInput[] with stack text loaded
  const inputs: CrashInput[] = [];
  const byId = new Map<string, StoredCrash>();
  for (const c of crashes) {
    const stackPath = path.isAbsolute(c.stack_path)
      ? c.stack_path
      : path.join(sessionDir, c.stack_path);
    let stack = "";
    try {
      stack = await readFile(stackPath, "utf8");
    } catch {
      stack = c.signature; // fallback
    }
    const input: CrashInput = {
      id: c.id,
      signature: c.signature,
      stack,
    };
    if (c.kind !== undefined) input.kind = c.kind;
    if (c.step_index !== undefined) input.step_index = c.step_index;
    inputs.push(input);
    byId.set(c.id, c);
  }

  const dedup = dedupCrashes(inputs);

  // Attach repro_paths per group
  const enriched: SessionCrashGroup[] = dedup.groups.map((g) => {
    const repro_paths: number[][] = [];
    const instance_step_indices: number[] = [];
    for (const id of g.instance_ids) {
      const c = byId.get(id);
      if (!c) continue;
      repro_paths.push(c.repro_path ?? []);
      if (c.step_index !== undefined) instance_step_indices.push(c.step_index);
    }
    return { ...g, repro_paths, instance_step_indices };
  });

  return {
    total: dedup.total,
    unique: dedup.unique,
    groups: enriched,
  };
}

/**
 * Lightweight static minimization. Given the full step sequence and a target crash step,
 * keep steps that look likely to be required:
 *   - last step (the trigger)
 *   - any step whose `notes` indicates a page transition (e.g. "page X → Y" with X != Y)
 *   - any step with result === "fail"
 * Drop steps with result === "skip" (recovery / no-op marker).
 *
 * This is a heuristic — for true minimal repro the user should run the minimize skill,
 * which performs live replay-based delta-debug.
 */
export interface SuggestedMinimalPath {
  original_path: number[];
  suggested_path: number[];
  reasoning: Record<number, string>; // step_index → why kept
  confidence: "low" | "medium";      // never "high" without replay
}

const TRANSITION_RE = /page\s+([0-9a-f]{6,})\s*→\s*([0-9a-f]{6,})/i;

interface StructuredStepNotes {
  page_from?: unknown;
  page_to?: unknown;
  replay?: {
    action_type?: unknown;
  };
}

function parseStructuredNotes(notes: string | undefined): StructuredStepNotes | null {
  if (!notes) return null;
  try {
    const parsed: unknown = JSON.parse(notes);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as StructuredStepNotes)
      : null;
  } catch {
    return null;
  }
}

function pageTransition(notes: string | undefined): [string, string] | null {
  if (!notes) return null;

  const structured = parseStructuredNotes(notes);
  if (
    typeof structured?.page_from === "string" &&
    typeof structured.page_to === "string" &&
    structured.page_from.length > 0 &&
    structured.page_to.length > 0
  ) {
    return [structured.page_from, structured.page_to];
  }

  // Backward compatibility for sessions produced before notes became JSON.
  const legacy = TRANSITION_RE.exec(notes);
  return legacy?.[1] && legacy[2] ? [legacy[1], legacy[2]] : null;
}

export async function suggestMinimalPath(
  sessionDir: string,
  reproPath: number[],
  targetStepIndex: number,
): Promise<SuggestedMinimalPath> {
  const steps = await readJsonl<StoredStep>(path.join(sessionDir, "steps.jsonl"));
  const byIndex = new Map(steps.map((s) => [s.index, s]));

  const reasoning: Record<number, string> = {};
  const kept: number[] = [];

  for (const idx of reproPath) {
    const s = byIndex.get(idx);
    if (!s) continue;

    if (idx === targetStepIndex) {
      kept.push(idx);
      reasoning[idx] = "trigger (crash detected after this step)";
      continue;
    }
    const structuredNotes = parseStructuredNotes(s.notes);
    if (structuredNotes?.replay?.action_type === "launch") {
      kept.push(idx);
      reasoning[idx] = "launch setup";
      continue;
    }
    if (s.result === "skip") {
      // skipped: usually recovery / out-of-scope navigation
      continue;
    }
    if (s.result === "fail") {
      kept.push(idx);
      reasoning[idx] = "explicit failure";
      continue;
    }
    const transition = pageTransition(s.notes);
    if (transition) {
      const [from, to] = transition;
      if (from !== to) {
        kept.push(idx);
        reasoning[idx] = `page transition ${from.slice(0, 6)} → ${to.slice(0, 6)}`;
        continue;
      }
    }
    // otherwise: candidate for removal
  }

  // Ensure target is included even if it wasn't in repro_path
  if (!kept.includes(targetStepIndex)) {
    kept.push(targetStepIndex);
    reasoning[targetStepIndex] = "trigger";
  }
  kept.sort((a, b) => a - b);

  return {
    original_path: reproPath,
    suggested_path: kept,
    reasoning,
    confidence: kept.length < reproPath.length ? "medium" : "low",
  };
}
