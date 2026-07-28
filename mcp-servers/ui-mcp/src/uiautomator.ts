// Dumps and parses Android uiautomator hierarchy into a flat element list.

import { XMLParser } from "fast-xml-parser";
import { AdbError, adbShell, pickDevice } from "./adb.js";

export interface UiElement {
  index: number;          // sequential index in the dump (depth-first order)
  class: string;          // e.g. "android.widget.TextView"
  package: string;        // e.g. "com.android.settings"
  text: string;
  resource_id: string;    // e.g. "com.android.settings:id/title"
  content_desc: string;
  bounds: { x1: number; y1: number; x2: number; y2: number };
  center: { x: number; y: number };
  width: number;
  height: number;
  clickable: boolean;
  enabled: boolean;
  focused: boolean;
  scrollable: boolean;
  long_clickable: boolean;
  selected: boolean;
  checkable: boolean;
  checked: boolean;
  password: boolean;
  depth: number;
  parent?: number; // parent index
}

export interface HierarchyDump {
  xml: string;
  elements: UiElement[];
  rotation: number;
  device: string;
  capturedAt: string;
}

const BOUNDS_RE = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/;

function parseBounds(b: string | undefined): UiElement["bounds"] {
  if (!b) return { x1: 0, y1: 0, x2: 0, y2: 0 };
  const m = BOUNDS_RE.exec(b);
  if (!m) return { x1: 0, y1: 0, x2: 0, y2: 0 };
  return {
    x1: parseInt(m[1]!, 10),
    y1: parseInt(m[2]!, 10),
    x2: parseInt(m[3]!, 10),
    y2: parseInt(m[4]!, 10),
  };
}

function toBool(v: unknown): boolean {
  return v === true || v === "true";
}

/** XML 1.0 character production. Invalid references must not reach
 * String.fromCodePoint: besides throwing for out-of-range values, surrogate
 * and forbidden control code points are not legal XML characters.
 */
function isValidXmlCodePoint(codePoint: number): boolean {
  return (
    Number.isSafeInteger(codePoint) &&
    (codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff))
  );
}

/**
 * Decode exactly one layer of the five predefined XML entities and numeric
 * character references. uiautomator uses references such as &#10; inside
 * TalkBack labels. Replacing all entity forms in one pass is important:
 * `&amp;#10;` represents the literal text `&#10;` and must not become a newline.
 * Malformed, forbidden or out-of-range numeric references are preserved.
 */
function decodeEntitiesOnce(v: string): string {
  if (!v || v.indexOf("&") === -1) return v;

  return v.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|quot|apos|lt|gt|amp);/g,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal !== undefined || hexadecimal !== undefined) {
        const codePoint = decimal !== undefined
          ? Number(decimal)
          : Number.parseInt(hexadecimal!, 16);
        return isValidXmlCodePoint(codePoint)
          ? String.fromCodePoint(codePoint)
          : entity;
      }

      switch (entity) {
        case "&quot;": return '"';
        case "&apos;": return "'";
        case "&lt;": return "<";
        case "&gt;": return ">";
        case "&amp;": return "&";
        default: return entity;
      }
    },
  );
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false, // keep as strings, we coerce ourselves
  // Decode text/content-desc ourselves in one pass. If fast-xml-parser first
  // decoded &amp;#10; to &#10;, a second numeric pass would corrupt literal text.
  processEntities: false,
  textNodeName: "_text",
});

export function parseHierarchyXml(xml: string): {
  elements: UiElement[];
  rotation: number;
} {
  const parsed = xmlParser.parse(xml) as Record<string, unknown>;
  const hierarchy = parsed["hierarchy"] as Record<string, unknown> | undefined;
  if (!hierarchy) return { elements: [], rotation: 0 };
  const rotation = Number(hierarchy["rotation"] ?? 0);

  const elements: UiElement[] = [];
  // The hierarchy element has child <node> entries. fast-xml-parser nests
  // arrays only when there are >1 siblings; normalize.
  const walk = (
    raw: unknown,
    depth: number,
    parentIdx: number | undefined,
  ): void => {
    if (!raw || typeof raw !== "object") return;
    const node = raw as Record<string, unknown>;
    const idx = elements.length;
    const bounds = parseBounds(node["bounds"] as string | undefined);
    const width = bounds.x2 - bounds.x1;
    const height = bounds.y2 - bounds.y1;
    const el: UiElement = {
      index: idx,
      class: (node["class"] as string) ?? "",
      package: (node["package"] as string) ?? "",
      text: decodeEntitiesOnce((node["text"] as string) ?? ""),
      resource_id: (node["resource-id"] as string) ?? "",
      content_desc: decodeEntitiesOnce((node["content-desc"] as string) ?? ""),
      bounds,
      width,
      height,
      center: {
        x: Math.round(bounds.x1 + width / 2),
        y: Math.round(bounds.y1 + height / 2),
      },
      clickable: toBool(node["clickable"]),
      enabled: toBool(node["enabled"]),
      focused: toBool(node["focused"]),
      scrollable: toBool(node["scrollable"]),
      long_clickable: toBool(node["long-clickable"]),
      selected: toBool(node["selected"]),
      checkable: toBool(node["checkable"]),
      checked: toBool(node["checked"]),
      password: toBool(node["password"]),
      depth,
      ...(parentIdx !== undefined ? { parent: parentIdx } : {}),
    };
    elements.push(el);

    const children = node["node"];
    if (Array.isArray(children)) {
      for (const c of children) walk(c, depth + 1, idx);
    } else if (children) {
      walk(children, depth + 1, idx);
    }
  };

  const rootChildren = hierarchy["node"];
  if (Array.isArray(rootChildren)) {
    for (const c of rootChildren) walk(c, 0, undefined);
  } else if (rootChildren) {
    walk(rootChildren, 0, undefined);
  }
  return { elements, rotation };
}

/** Thrown when uiautomator dump cannot complete because the UI is busy (e.g.
 * Flutter app continuously redrawing). The caller should fall back to vision-
 * driven interaction via mobile-mcp screenshot + click_on_screen_at_coordinates.
 */
export class UiBusyError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly hint = "UI never reached idle (often Flutter / video / animations). Fall back to mobile_take_screenshot + vision-driven click_on_screen_at_coordinates.",
  ) {
    super(message);
    this.name = "UiBusyError";
  }
}

function isIdleStateError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /could not get idle state/i.test(msg);
}

async function tryDumpOnce(device: string, compressed: boolean): Promise<string> {
  const flag = compressed ? "--compressed " : "";
  // Single shell command: dump → cat. If dump fails, cat returns no-such-file.
  await adbShell(device, `uiautomator dump ${flag}/sdcard/window_dump.xml`, {
    timeoutMs: 10_000,
  });
  return adbShell(device, "cat /sdcard/window_dump.xml", { timeoutMs: 10_000 });
}

export async function dumpHierarchy(opts: {
  device?: string;
  /** Default 3. Set 1 to disable retries. */
  retry?: number;
} = {}): Promise<HierarchyDump> {
  const device = await pickDevice(opts.device);
  const maxAttempts = Math.max(1, opts.retry ?? 3);

  let lastErr: unknown;
  let attempt = 0;
  for (; attempt < maxAttempts; attempt++) {
    // 1st pass: standard. 2nd+ pass: --compressed (more permissive idle check).
    const compressed = attempt > 0;
    try {
      const xml = await tryDumpOnce(device, compressed);
      const { elements, rotation } = parseHierarchyXml(xml);
      return {
        xml,
        elements,
        rotation,
        device,
        capturedAt: new Date().toISOString(),
      };
    } catch (err) {
      lastErr = err;
      if (!isIdleStateError(err)) throw err;
      // Backoff: 500ms, 1500ms, 3000ms
      const delayMs = 500 * Math.pow(3, attempt);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  // All retries exhausted on idle-state errors → tell the caller.
  throw new UiBusyError(
    `uiautomator dump failed after ${attempt} attempt(s): ${(lastErr as Error)?.message ?? lastErr}`,
    attempt,
  );
}
