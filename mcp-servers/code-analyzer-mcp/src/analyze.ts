// One-shot pipeline: detect platform → discover docs → extract signals.

import { resolve } from "node:path";
import { detectPlatform } from "./platform.js";
import { discoverDocs } from "./docs.js";
import { extractAndroid } from "./android.js";
import { extractFlutter } from "./flutter.js";
import type { DocHit, ProjectSignals, Platform } from "./types.js";

export interface AnalyzeResult {
  project_dir: string;
  platform: Platform;
  platform_signals: string[];
  app_name?: string;
  package_or_bundle?: string;
  docs: DocHit[];
  signals: ProjectSignals;
}

export async function analyzeProject(
  project_dir_input: string,
  opts: { include_docs?: boolean } = {},
): Promise<AnalyzeResult> {
  const project_dir = resolve(project_dir_input);
  const t0 = Date.now();

  const platformInfo = await detectPlatform(project_dir);
  const docs = opts.include_docs !== false ? await discoverDocs(project_dir) : [];

  let signals: ProjectSignals = {
    platform: platformInfo.platform,
    platform_signals: platformInfo.signals,
    project_dir,
    pages: [],
    routes: [],
    apis: [],
    handlers: [],
    stats: { files_scanned: 0, files_skipped: 0, elapsed_ms: 0 },
  };
  if (platformInfo.app_name) signals.app_name = platformInfo.app_name;
  if (platformInfo.package_or_bundle) signals.package_or_bundle = platformInfo.package_or_bundle;

  if (platformInfo.platform === "android-native") {
    const r = await extractAndroid(project_dir);
    signals.pages = r.pages;
    signals.routes = r.routes;
    signals.apis = r.apis;
    signals.handlers = r.handlers;
    signals.stats.files_scanned = r.scanned;
  } else if (platformInfo.platform === "flutter") {
    // Flutter projects often have a real Android module under android/; run both.
    const flutter = await extractFlutter(project_dir);
    const android = await extractAndroid(project_dir);
    signals.pages = [...flutter.pages, ...android.pages];
    signals.routes = [...flutter.routes, ...android.routes];
    signals.apis = [...flutter.apis, ...android.apis];
    signals.handlers = [...flutter.handlers, ...android.handlers];
    signals.stats.files_scanned = flutter.scanned + android.scanned;
  }
  // RN / iOS-native: leave signals empty in v1; doc discovery still works.

  signals.stats.elapsed_ms = Date.now() - t0;
  return {
    project_dir,
    platform: platformInfo.platform,
    platform_signals: platformInfo.signals,
    ...(platformInfo.app_name ? { app_name: platformInfo.app_name } : {}),
    ...(platformInfo.package_or_bundle ? { package_or_bundle: platformInfo.package_or_bundle } : {}),
    docs,
    signals,
  };
}
