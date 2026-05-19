// Flutter signal extraction — Dart only.
//
// Strategy: regex over *.dart files. We deliberately ignore the underlying
// AST to keep this dependency-free and tolerant of partial files.

import { walk, rel, readUtf8, snippet, lineOf } from "./walker.js";
import type { PageInfo, RouteInfo, ApiInfo, HandlerInfo } from "./types.js";

interface Acc {
  pages: PageInfo[];
  routes: RouteInfo[];
  apis: ApiInfo[];
  handlers: HandlerInfo[];
}

// class XxxPage extends StatelessWidget|StatefulWidget — heuristic name ends Page/Screen/View.
const CLASS_RE = /class\s+(\w+)\s+extends\s+(StatelessWidget|StatefulWidget)\b/g;

// Routes — Navigator.pushNamed + MaterialPageRoute + GoRouter (context.go / GoRoute).
const PUSH_NAMED_RE = /Navigator\.(?:of\([^)]*\)\.)?pushNamed\s*\(\s*[^,]*,\s*['"]([^'"]+)['"]/g;
// MaterialPageRoute(builder: (context) => XxxPage(...))  — allow nested parens via [^>]*
const PUSH_CLASS_RE = /MaterialPageRoute\s*\(\s*builder\s*:\s*[^>]*=>\s*(\w+)\s*\(/g;
// GoRouter: context.go('/path'), context.push('/path'), context.goNamed('home'), GoRoute(path: '/foo')
const GO_ROUTER_NAV_RE = /context\.(?:go|push|goNamed|pushNamed|replace)\s*\(\s*['"]([^'"]+)['"]/g;
const GO_ROUTE_DECL_RE = /GoRoute\s*\(\s*[^)]*?path\s*:\s*['"]([^'"]+)['"]/g;

// Handlers — onPressed:/onTap: assigned to inline closure or callable.
const ON_PRESSED_RE = /(onPressed|onTap|onLongPress|onChanged)\s*:\s*(?:\(\)\s*=>\s*|\(\)\s*\{|\w+\s*\(|\(.*?\)\s*\{)/g;

// Button text — try to extract child: Text('Foo') near the same widget instance.
const BUTTON_WIDGETS = ["ElevatedButton", "TextButton", "OutlinedButton", "FilledButton", "IconButton", "InkWell", "GestureDetector"];

// API — Dio
const DIO_RE = /(?:Dio\(\)|_dio|dio|_client|client)\.(?:request|get|post|put|delete|patch)\s*(?:<[^>]*>)?\s*\(\s*['"]([^'"]+)['"]/g;
const DIO_METHOD_RE = /(?:Dio\(\)|_dio|dio|_client|client)\.(get|post|put|delete|patch|request)\s*(?:<[^>]*>)?\s*\(/g;

// API — http package
const HTTP_RE = /http\.(get|post|put|delete|patch|head)\s*\(\s*Uri\.parse\s*\(\s*['"]([^'"]+)['"]/g;

function pageKindOf(name: string): PageInfo["kind"] | null {
  if (/Page$|Screen$|View$/.test(name)) return "flutter-page";
  return null;
}

async function scanFile(abs: string, project_dir: string, acc: Acc): Promise<void> {
  const content = await readUtf8(abs);
  if (!content) return;
  const r = rel(project_dir, abs);
  if (!r.endsWith(".dart")) return;

  // Skip generated / test files for noise reduction.
  if (r.endsWith(".g.dart") || r.endsWith(".freezed.dart") || r.includes("/generated/")) return;

  // Classes
  CLASS_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = CLASS_RE.exec(content)); ) {
    const name = m[1]!;
    if (pageKindOf(name)) {
      acc.pages.push({
        name,
        kind: "flutter-page",
        file: r,
        line: lineOf(content, m.index),
      });
    }
  }

  // Owning page resolver
  const classStarts: Array<{ line: number; name: string }> = acc.pages
    .filter((p) => p.file === r)
    .map((p) => ({ line: p.line, name: p.name }))
    .sort((a, b) => a.line - b.line);
  function pageAt(line: number): string | undefined {
    let best: string | undefined;
    for (const c of classStarts) {
      if (c.line <= line) best = c.name;
      else break;
    }
    return best;
  }

  // Handlers
  ON_PRESSED_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = ON_PRESSED_RE.exec(content)); ) {
    const line = lineOf(content, m.index);
    // Look backwards within ~250 chars for the parent widget name.
    const ctxStart = Math.max(0, m.index - 250);
    const ctx = content.slice(ctxStart, m.index);
    let target_widget: string | undefined;
    for (const w of BUTTON_WIDGETS) {
      if (new RegExp(`\\b${w}\\b`).test(ctx)) {
        target_widget = w;
      }
    }
    // Look ahead ~250 chars for an associated Text('...') child.
    const after = content.slice(m.index, m.index + 400);
    const txt =
      after.match(/Text\(\s*['"]([^'"]{1,60})['"]/) ||
      after.match(/label\s*:\s*Text\(\s*['"]([^'"]{1,60})['"]/);
    const handler: HandlerInfo = {
      target_widget: target_widget ?? `Dart ${m[1]!}`,
      action_snippet: snippet(after, 120),
      file: r,
      line,
    };
    const ownPage = pageAt(line);
    if (ownPage) handler.page = ownPage;
    if (txt && txt[1]) handler.text = txt[1];
    acc.handlers.push(handler);
  }

  // Routes
  PUSH_NAMED_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = PUSH_NAMED_RE.exec(content)); ) {
    acc.routes.push({
      name: m[1]!,
      kind: "named-route",
      file: r,
      line: lineOf(content, m.index),
    });
  }
  PUSH_CLASS_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = PUSH_CLASS_RE.exec(content)); ) {
    acc.routes.push({
      name: m[1]!,
      kind: "dart-class-route",
      target_page: m[1]!,
      file: r,
      line: lineOf(content, m.index),
    });
  }
  // GoRouter navigation calls
  GO_ROUTER_NAV_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = GO_ROUTER_NAV_RE.exec(content)); ) {
    acc.routes.push({
      name: m[1]!,
      kind: "named-route",
      file: r,
      line: lineOf(content, m.index),
    });
  }
  // GoRouter route declarations
  GO_ROUTE_DECL_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = GO_ROUTE_DECL_RE.exec(content)); ) {
    acc.routes.push({
      name: m[1]!,
      kind: "named-route",
      file: r,
      line: lineOf(content, m.index),
    });
  }

  // APIs — Dio
  DIO_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = DIO_RE.exec(content)); ) {
    // Need to inspect leading verb. Re-extract from the broader context.
    const lookbackStart = Math.max(0, m.index - 60);
    const lookback = content.slice(lookbackStart, m.index + m[0].length);
    const verb = lookback.match(/\.(get|post|put|delete|patch|request)\s*(?:<[^>]*>)?\s*\(\s*['"][^'"]+['"]/);
    acc.apis.push({
      method: verb && verb[1] ? verb[1].toUpperCase() : "REQUEST",
      path: m[1]!,
      source: "dio",
      file: r,
      line: lineOf(content, m.index),
    });
  }
  // http package
  HTTP_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = HTTP_RE.exec(content)); ) {
    acc.apis.push({
      method: m[1]!.toUpperCase(),
      path: m[2]!,
      source: "http-dart",
      file: r,
      line: lineOf(content, m.index),
    });
  }
}

export async function extractFlutter(project_dir: string): Promise<{
  pages: PageInfo[];
  routes: RouteInfo[];
  apis: ApiInfo[];
  handlers: HandlerInfo[];
  scanned: number;
}> {
  const acc: Acc = { pages: [], routes: [], apis: [], handlers: [] };
  const { files } = await walk(project_dir, { extensions: ["dart"] });
  for (const abs of files) {
    await scanFile(abs, project_dir, acc);
  }
  const incoming = new Map<string, number>();
  for (const route of acc.routes) {
    if (route.target_page) incoming.set(route.target_page, (incoming.get(route.target_page) ?? 0) + 1);
  }
  for (const p of acc.pages) {
    const h = incoming.get(p.name) ?? 0;
    if (h > 0) p.hits = h;
  }
  return { ...acc, scanned: files.length };
}
