import { setTimeout as delay } from "node:timers/promises";
import { AdbDeadlineError } from "./adb.js";
import {
  findFirst,
  hasPresentCandidates,
  type FindResult,
  type Strategy,
} from "./finder.js";
import { dumpHierarchy } from "./uiautomator.js";

export interface WaitForElementResult {
  ok: boolean;
  expect: "appear" | "disappear";
  attempts: number;
  elapsedMs: number;
  result?: FindResult;
  lastAmbiguity?: FindResult;
}

/** Poll with one absolute deadline shared by device lookup, every adb command,
 * and every delay. A slow hierarchy dump therefore cannot overrun timeoutMs by
 * starting a fresh per-command timeout near the end of the request. */
export async function waitForElementCore(opts: {
  device?: string;
  strategies: Strategy[];
  timeoutMs: number;
  pollMs: number;
  expect: "appear" | "disappear";
  signal?: AbortSignal;
}): Promise<WaitForElementResult> {
  const startedAt = Date.now();
  const deadlineAtMs = startedAt + opts.timeoutMs;
  let attempts = 0;
  let lastAmbiguity: FindResult | undefined;

  while (Date.now() < deadlineAtMs) {
    attempts++;
    try {
      const dump = await dumpHierarchy({
        ...(opts.device === undefined ? {} : { device: opts.device }),
        retry: 1,
        deadlineAtMs,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      });
      const result = findFirst(dump.elements, opts.strategies);
      lastAmbiguity = result.ambiguous ? result : undefined;
      const present = hasPresentCandidates(result);
      const condition = opts.expect === "appear" ? result.matched : !present;
      if (condition) {
        return {
          ok: true,
          expect: opts.expect,
          attempts,
          elapsedMs: Date.now() - startedAt,
          result,
          ...(lastAmbiguity === undefined ? {} : { lastAmbiguity }),
        };
      }
    } catch (error) {
      if (error instanceof AdbDeadlineError) break;
      throw error;
    }

    const remaining = deadlineAtMs - Date.now();
    if (remaining <= 0) break;
    try {
      await delay(
        Math.min(opts.pollMs, remaining),
        undefined,
        opts.signal === undefined ? undefined : { signal: opts.signal },
      );
    } catch (error) {
      // Request cancellation is not a timeout; preserve the AbortError so the
      // MCP handler can stop immediately rather than report a false poll miss.
      throw error;
    }
  }

  return {
    ok: false,
    expect: opts.expect,
    attempts,
    elapsedMs: Date.now() - startedAt,
    ...(lastAmbiguity === undefined ? {} : { lastAmbiguity }),
  };
}
