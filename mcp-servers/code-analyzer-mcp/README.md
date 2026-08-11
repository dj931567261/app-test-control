# code-analyzer-mcp

Static analysis of a mobile project's source tree — finds docs, detects platform, and extracts pages / routes / API calls / click handlers. Designed for the `smart-qa` skill to infer business flows before driving the app.

This MCP **does not call any LLM** itself. It returns structured signals; the calling skill (or you) synthesizes them.

## Tools

| name | purpose |
|---|---|
| `discover_docs(project_dir)` | Scan for PRD / requirements / README / spec / test-plan files; classify by filename + content keyword. |
| `detect_platform(project_dir)` | `android-native` / `flutter` / `react-native` / `ios-native` / `unknown` based on config markers. Also returns `app_name` and `package_or_bundle` when easy. |
| `extract_signals(project_dir, platform?)` | Pages, routes, APIs, click handlers — each entry with `file:line` for verification. |
| `analyze_project(project_dir)` | One-shot: `detect_platform` + `discover_docs` + `extract_signals` combined. Best entry point for `smart-qa`. |
| `locate_stack_frames(project_dir, frames, ...)` | Map bounded, untrusted crash frames to confidence-ranked source candidates. Only scans regular source files already discovered inside the repository and returns relative paths. |
| `read_quick_source_files(project_dir, relative_paths)` | Quick CrashFix only: read one to three explicitly approved source files with link, credential/generated-file, and size guards; never scans the repository. |

## Coverage

| platform | pages | routes | APIs | click handlers |
|---|---|---|---|---|
| Android (Kotlin/Java) | `*Activity` / `*Fragment` / `@Composable *Screen` | `Intent(... ::class.java)`, `NavController.navigate("foo")` | Retrofit `@GET/@POST(...)`, OkHttp `Request.url(...)`, Ktor (`client.get("/path")`) | `.setOnClickListener { }` resolved back to nearest `R.id.X`; Compose `onClick = { }` / `Modifier.clickable { }` |
| Flutter (Dart) | `class XxxPage|Screen|View extends Stateless\|StatefulWidget` | `Navigator.pushNamed`, `MaterialPageRoute`, **GoRouter (`context.go('/x')`, `GoRoute(path: '/x')`)** | `Dio().get/post(...)`, `http.get(Uri.parse('...'))` | `onPressed:`, `onTap:`, `onLongPress:`, `onChanged:` — paired with parent widget type (`ElevatedButton`, `TextButton`, `IconButton`, `InkWell`, `GestureDetector`) and child `Text('...')` if visible |
| React Native / iOS Native | _doc discovery only_ | — | — | — |

### Why regex instead of an AST

Zero deps, works on partial / non-compilable code, tolerates the dozen Kotlin / Dart syntactic variants in real projects. Each match exposes `file:line` so a caller can verify by reading the source.

## Quick test

```bash
# Build
npm run build -w mcp-servers/code-analyzer-mcp

# Run unit tests
npm test -w mcp-servers/code-analyzer-mcp

# stdio smoke (handshake + tools/list)
node scripts/mcp-smoke.mjs mcp-servers/code-analyzer-mcp/dist/index.js \
  discover_docs,detect_platform,extract_signals,analyze_project,locate_stack_frames,read_quick_source_files
```

## Real-world examples

**SDK805** (single-Activity Native Android, 45 files scanned in ~33 ms):
- 1 page: `MainActivity` (launcher)
- 2 handlers: `R.id.tvText`, `R.id.btn`
- 1 API: `https://ipinfo.io/ip` (OkHttp)

**lend_pal** (Flutter, 25 files scanned in ~41 ms):
- 12 pages: 7 KYC steps + `Home/Login/Splash/Orders/Profile` + Android shim
- 22 routes: `/kyc/personal-info`, `/kyc/face-verify`, ... all GoRouter declarations
- 21 handlers: each with button text — `'Sign In'`, `'Forgot Password?'`, `'Bank Card'`, ...

## Limitations (v1)

- **No iOS / RN signal extraction yet.** Doc discovery still works for any platform.
- **No type resolution** — handlers can't follow `onPressed: _doLogin` to the body of `_doLogin`; only inline closures show their action.
- **Routes ↔ pages mapping is name-based.** Pages.hits counts incoming references when names match exactly; named routes (`/login`) don't auto-map to `LoginPage` (string vs class).
- **Token noise**: full results on a 1000-file repo can run to dozens of KB. The `smart-qa` skill is expected to filter to the top N by relevance before showing to the user.
- **Stack location is evidence, not authority.** Exact path suffixes rank highest; basename/type/symbol fallbacks require caller verification. Stack-supplied paths are never opened directly.
- **`high` is deliberately narrow.** It is currently available only for Kotlin, Swift, and Java when the exact path, language-specific method declaration, reported method body, and innermost owner type all agree. Other languages and ambiguous/nested-anonymous owners stay `medium` or `low`.
