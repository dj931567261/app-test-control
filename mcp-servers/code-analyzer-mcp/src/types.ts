// Shared types used by docs / platform / extractors.

export type Platform =
  | "android-native"
  | "flutter"
  | "react-native"
  | "ios-native"
  | "unknown";

export interface DocHit {
  path: string;            // relative to project root
  abs: string;             // absolute path
  kind: "prd" | "requirements" | "readme" | "spec" | "test-plan" | "other";
  size: number;
  head: string;            // first ~30 non-blank lines, joined
  signal: string[];        // keywords that classified it
}

export interface PageInfo {
  name: string;            // "MainActivity", "LoginScreen", "OrderListPage"
  kind: "activity" | "fragment" | "compose-screen" | "flutter-page" | "view-controller";
  file: string;            // relative
  line: number;
  // optional UI hints:
  resource_layout?: string;          // "activity_main" for Android XML-based
  is_launcher?: boolean;             // android.intent.action.MAIN
  hits?: number;                     // navigation incoming references
}

export interface RouteInfo {
  name: string;                      // "/login", "MainActivity", "LoginPage"
  kind: "intent-class" | "named-route" | "dart-class-route" | "compose-route" | "other";
  target_page?: string;              // page name if resolvable
  file: string;
  line: number;
}

export interface ApiInfo {
  method: string;                    // GET / POST / PUT / DELETE / WS
  path?: string;                     // "/api/login"
  function_name?: string;            // login() on Retrofit interface or Dart method
  source: "retrofit" | "okhttp" | "ktor" | "dio" | "http-dart" | "urlsession" | "fetch" | "axios" | "other";
  file: string;
  line: number;
}

export interface HandlerInfo {
  page?: string;                     // owning page if known
  // Identifier of the tapped element:
  target_id?: string;                // "R.id.btn", widget identifier, etc
  target_widget?: string;            // "ElevatedButton", "TextButton", "TextView"
  text?: string;                     // human-visible label if statically known
  // Action gist (first ~100 chars of body, trimmed of whitespace runs):
  action_snippet: string;
  file: string;
  line: number;
}

export interface ProjectSignals {
  platform: Platform;
  platform_signals: string[];        // raw signals that drove detection
  project_dir: string;
  app_name?: string;                 // best-effort
  package_or_bundle?: string;        // android applicationId / iOS bundle id / Flutter package
  pages: PageInfo[];
  routes: RouteInfo[];
  apis: ApiInfo[];
  handlers: HandlerInfo[];
  stats: {
    files_scanned: number;
    files_skipped: number;
    elapsed_ms: number;
  };
}

export interface StackFrameInput {
  index: number;
  symbol: string;
  module?: string;
  file?: string;
  line?: number;
  app_owned?: boolean;
}

export interface StackFrameCandidate {
  frame_index: number;
  file: string;
  line?: number;
  symbol?: string;
  match_type: "path-suffix" | "basename" | "type-name" | "symbol";
  confidence: "high" | "medium" | "low";
  snippet?: string;
}
