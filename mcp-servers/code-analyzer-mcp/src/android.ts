// Android signal extraction — Kotlin + Java.
//
// We use regex-based matching rather than a real Kotlin/Java parser. Trade-off:
// occasionally misses or false-positives, but zero deps and works on partial /
// non-compilable code. Each match records file:line so downstream callers can
// verify by reading the source.

import { join } from "node:path";
import { walk, rel, readUtf8, snippet, lineOf } from "./walker.js";
import type { PageInfo, RouteInfo, ApiInfo, HandlerInfo } from "./types.js";

interface Acc {
  pages: PageInfo[];
  routes: RouteInfo[];
  apis: ApiInfo[];
  handlers: HandlerInfo[];
  manifest_launcher?: string;
}

// AndroidManifest.xml — get launcher Activity name (best effort).
async function parseManifest(project_dir: string, acc: Acc): Promise<void> {
  const candidates = [
    "app/src/main/AndroidManifest.xml",
    "src/main/AndroidManifest.xml",
    "AndroidManifest.xml",
    "android/app/src/main/AndroidManifest.xml",
  ];
  for (const c of candidates) {
    const abs = join(project_dir, c);
    const content = await readUtf8(abs);
    if (!content) continue;
    // <activity android:name=".MainActivity"> ... <category android:name="android.intent.category.LAUNCHER" /> ...
    const activityBlocks = content.split(/<activity\b/);
    for (let i = 1; i < activityBlocks.length; i++) {
      const block = activityBlocks[i]!;
      const endIdx = block.indexOf("</activity>");
      const head = endIdx >= 0 ? block.slice(0, endIdx) : block;
      if (/android\.intent\.category\.LAUNCHER/.test(head)) {
        const m = head.match(/android:name="([^"]+)"/);
        if (m && m[1]) {
          // Strip leading '.' (Android shorthand); leave fully qualified as-is.
          acc.manifest_launcher = m[1].replace(/^\./, "");
          return;
        }
      }
    }
  }
}

// Class declarations matching "class X(Activity|Fragment|ComposeFun)".
const CLASS_RE_KT = /(?:^|\n)\s*(?:open\s+|abstract\s+|sealed\s+|internal\s+|private\s+|public\s+)*class\s+(\w+)\s*(?:\([^)]*\))?\s*:\s*([A-Za-z0-9_<>?, .]+)/g;
const CLASS_RE_JAVA = /(?:^|\n)\s*(?:public\s+|abstract\s+|final\s+)*class\s+(\w+)\s+extends\s+([A-Za-z0-9_<>?, .]+)/g;

const KT_FUN_RE = /@Composable[^\n]*\n\s*(?:internal\s+|private\s+|public\s+)*fun\s+(\w+)\s*\(/g;

// Any `.setOnClickListener { ... }` — we'll resolve the R.id.X by looking back.
const SET_LISTENER_ANY = /\.setOnClickListener\s*\{/g;
// Compose-style.
const COMPOSE_ON_CLICK = /onClick\s*=\s*\{/g;
const COMPOSE_CLICKABLE = /\.clickable\s*\(\s*[^)]*\)\s*\{/g;

// Retrofit / OkHttp / Ktor.
// Allow fully-qualified annotation: @retrofit2.http.POST(...) or @POST(...)
const RETROFIT_RE = /@(?:[\w.]*\.)?(GET|POST|PUT|DELETE|PATCH|HEAD)\s*\(\s*"([^"]+)"\s*\)\s*[^\n]*\n\s*(?:suspend\s+)?fun\s+(\w+)\s*\(/g;
const OKHTTP_RE = /Request\.Builder\s*\(\s*\)\s*\.\s*url\s*\(\s*["']([^"']+)["']\s*\)/g;
// Ktor — require path to start with `/` or `http` so we don't match every `.get("foo")` call.
const KTOR_RE = /\b(?:client|httpClient|_client)\.(get|post|put|delete|patch)\s*\(\s*["']((?:\/|https?:)[^"']+)["']\s*\)/gi;

// Intent navigation.
const INTENT_RE = /Intent\s*\(\s*(?:this\s*,\s*)?(\w+)::class\.java/g;
const NAV_NAMED_RE = /navController\.navigate\s*\(\s*["']([^"']+)["']\s*\)/g;

function classKind(parent: string): PageInfo["kind"] | null {
  if (/Activity\b/.test(parent)) return "activity";
  if (/Fragment\b/.test(parent)) return "fragment";
  return null;
}

async function scanFile(abs: string, project_dir: string, acc: Acc): Promise<void> {
  const content = await readUtf8(abs);
  if (!content) return;
  const r = rel(project_dir, abs);
  const isKotlin = r.endsWith(".kt");
  const isJava = r.endsWith(".java");
  if (!isKotlin && !isJava) return;

  const pageByLine = new Map<number, string>();

  // Class-based pages
  const classRe = isKotlin ? CLASS_RE_KT : CLASS_RE_JAVA;
  classRe.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = classRe.exec(content)); ) {
    const name = m[1]!;
    const parent = m[2]!;
    const kind = classKind(parent);
    if (kind) {
      const line = lineOf(content, m.index);
      acc.pages.push({
        name,
        kind,
        file: r,
        line,
        is_launcher: acc.manifest_launcher === name || (acc.manifest_launcher?.endsWith("." + name) ?? false),
      });
      pageByLine.set(line, name);
    }
  }

  // Compose screen functions: @Composable fun XxxScreen() — heuristic: ends with "Screen" or "Page".
  if (isKotlin) {
    KT_FUN_RE.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = KT_FUN_RE.exec(content)); ) {
      const name = m[1]!;
      if (/Screen$|Page$/.test(name)) {
        acc.pages.push({
          name,
          kind: "compose-screen",
          file: r,
          line: lineOf(content, m.index),
        });
      }
    }
  }

  // Resolve owning page for a given line by scanning back to nearest class header.
  // For performance, build a sorted array of class starts.
  const classStarts: Array<{ line: number; name: string }> = acc.pages
    .filter((p) => p.file === r)
    .map((p) => ({ line: p.line, name: p.name }))
    .sort((a, b) => a.line - b.line);

  function pageAt(lineNo: number): string | undefined {
    let best: string | undefined;
    for (const c of classStarts) {
      if (c.line <= lineNo) best = c.name;
      else break;
    }
    return best;
  }

  // Handlers — Android view (R.id.xxx). Match any `.setOnClickListener {` and
  // resolve which view by looking ~400 chars back for an R.id.X token (covers
  // both `findViewById<...>(R.id.btn).setOnClickListener` and the
  // `val x = findViewById<...>(R.id.btn); x.setOnClickListener` pattern).
  SET_LISTENER_ANY.lastIndex = 0;
  const seenLines = new Set<number>();
  for (let m: RegExpExecArray | null; (m = SET_LISTENER_ANY.exec(content)); ) {
    const line = lineOf(content, m.index);
    if (seenLines.has(line)) continue;
    seenLines.add(line);
    const after = content.slice(m.index + m[0].length, m.index + m[0].length + 200);
    const lookbackStart = Math.max(0, m.index - 400);
    const lookback = content.slice(lookbackStart, m.index);
    const idMatches = [...lookback.matchAll(/R\.id\.(\w+)/g)];
    const nearestId = idMatches.length > 0 ? idMatches[idMatches.length - 1]![1] : undefined;
    const handler: HandlerInfo = {
      target_widget: "Android View",
      action_snippet: snippet(after, 120),
      file: r,
      line,
    };
    if (nearestId) handler.target_id = `R.id.${nearestId}`;
    const ownPage = pageAt(line);
    if (ownPage) handler.page = ownPage;
    acc.handlers.push(handler);
  }
  // Compose / Modifier.clickable.
  if (isKotlin) {
    COMPOSE_ON_CLICK.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = COMPOSE_ON_CLICK.exec(content)); ) {
      const line = lineOf(content, m.index);
      const after = content.slice(m.index + m[0].length, m.index + m[0].length + 200);
      // Try to find a sibling 'text = "..."' or 'Text("...")' just before — a few lines back.
      const ctxStart = Math.max(0, m.index - 300);
      const ctx = content.slice(ctxStart, m.index);
      const txtMatch = ctx.match(/Text\(\s*"([^"]{1,50})"/) || ctx.match(/text\s*=\s*"([^"]{1,50})"/);
      const handler: HandlerInfo = {
        target_widget: "Compose onClick",
        action_snippet: snippet(after, 120),
        file: r,
        line,
      };
      const ownPage = pageAt(line);
      if (ownPage) handler.page = ownPage;
      if (txtMatch && txtMatch[1]) handler.text = txtMatch[1];
      acc.handlers.push(handler);
    }
    COMPOSE_CLICKABLE.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = COMPOSE_CLICKABLE.exec(content)); ) {
      const line = lineOf(content, m.index);
      const after = content.slice(m.index + m[0].length, m.index + m[0].length + 200);
      const handler: HandlerInfo = {
        target_widget: "Modifier.clickable",
        action_snippet: snippet(after, 120),
        file: r,
        line,
      };
      const ownPage = pageAt(line);
      if (ownPage) handler.page = ownPage;
      acc.handlers.push(handler);
    }
  }

  // APIs — Retrofit.
  RETROFIT_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = RETROFIT_RE.exec(content)); ) {
    acc.apis.push({
      method: m[1]!,
      path: m[2]!,
      function_name: m[3]!,
      source: "retrofit",
      file: r,
      line: lineOf(content, m.index),
    });
  }
  // OkHttp manual.
  OKHTTP_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = OKHTTP_RE.exec(content)); ) {
    acc.apis.push({
      method: "GET",  // unknown; will be refined if a .post(...) follows nearby
      path: m[1]!,
      source: "okhttp",
      file: r,
      line: lineOf(content, m.index),
    });
  }
  // Ktor — usually with HttpClient.get/post.
  KTOR_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = KTOR_RE.exec(content)); ) {
    // Avoid double-matching Retrofit annotations (already captured).
    const around = content.slice(Math.max(0, m.index - 5), m.index);
    if (/@/.test(around)) continue;
    acc.apis.push({
      method: m[1]!.toUpperCase(),
      path: m[2]!,
      source: "ktor",
      file: r,
      line: lineOf(content, m.index),
    });
  }

  // Routes — Intent + NavController.
  INTENT_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = INTENT_RE.exec(content)); ) {
    const target = m[1]!;
    // Skip self-refs like Intent(this, MainActivity::class.java) launching outside a class.
    acc.routes.push({
      name: target,
      kind: "intent-class",
      target_page: target,
      file: r,
      line: lineOf(content, m.index),
    });
  }
  NAV_NAMED_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = NAV_NAMED_RE.exec(content)); ) {
    acc.routes.push({
      name: m[1]!,
      kind: "named-route",
      file: r,
      line: lineOf(content, m.index),
    });
  }
}

export async function extractAndroid(project_dir: string): Promise<{
  pages: PageInfo[];
  routes: RouteInfo[];
  apis: ApiInfo[];
  handlers: HandlerInfo[];
  scanned: number;
}> {
  const acc: Acc = { pages: [], routes: [], apis: [], handlers: [] };
  await parseManifest(project_dir, acc);
  const { files } = await walk(project_dir, { extensions: ["kt", "java"] });
  for (const abs of files) {
    await scanFile(abs, project_dir, acc);
  }

  // After all files done, mark hits (incoming nav references) on pages.
  const incoming = new Map<string, number>();
  for (const route of acc.routes) {
    if (route.target_page) {
      incoming.set(route.target_page, (incoming.get(route.target_page) ?? 0) + 1);
    }
  }
  for (const p of acc.pages) {
    const h = incoming.get(p.name) ?? 0;
    if (h > 0) p.hits = h;
  }

  return { ...acc, scanned: files.length };
}
