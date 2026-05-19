// Detect platform by markers in standard config files.
// Reports raw signals so callers can sanity-check the auto guess.

import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import type { Platform } from "./types.js";

interface Marker {
  file: string;                  // relative path inside project
  test: (content: string) => string | null;   // returns matched signal or null
  platform: Platform;
}

const MARKERS: Marker[] = [
  // Flutter
  {
    file: "pubspec.yaml",
    platform: "flutter",
    test: (c) => /^\s*flutter:\s*$|flutter_sdk|sdk:\s*flutter/m.test(c) ? "pubspec.yaml:flutter" : null,
  },
  // React Native — package.json with react-native dep
  {
    file: "package.json",
    platform: "react-native",
    test: (c) => /"react-native"\s*:/.test(c) ? "package.json:react-native" : null,
  },
  // Android native — top-level build.gradle/build.gradle.kts
  {
    file: "build.gradle.kts",
    platform: "android-native",
    test: (c) => /com\.android\.application|android\s*\{|namespace\s*=/.test(c) ? "build.gradle.kts:android" : null,
  },
  {
    file: "build.gradle",
    platform: "android-native",
    test: (c) => /com\.android\.application|android\s*\{/.test(c) ? "build.gradle:android" : null,
  },
  // iOS native — Podfile / .xcodeproj presence inferred via file existence below
  {
    file: "Podfile",
    platform: "ios-native",
    test: (c) => /platform\s*:ios|use_frameworks/.test(c) ? "Podfile:ios" : null,
  },
];

// Some projects nest the Android module — also probe `app/build.gradle{.kts}`.
const NESTED_PROBES: Array<{ file: string; platform: Platform; signal: string }> = [
  { file: "app/build.gradle.kts", platform: "android-native", signal: "app/build.gradle.kts" },
  { file: "app/build.gradle", platform: "android-native", signal: "app/build.gradle" },
];

async function tryRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function detectPlatform(project_dir: string): Promise<{
  platform: Platform;
  signals: string[];
  app_name?: string;
  package_or_bundle?: string;
}> {
  const signals: string[] = [];
  const platformVotes = new Map<Platform, number>();

  for (const m of MARKERS) {
    const content = await tryRead(join(project_dir, m.file));
    if (content !== null) {
      const s = m.test(content);
      if (s) {
        signals.push(s);
        platformVotes.set(m.platform, (platformVotes.get(m.platform) ?? 0) + 1);
      }
    }
  }

  for (const p of NESTED_PROBES) {
    if (await exists(join(project_dir, p.file))) {
      signals.push(p.signal);
      platformVotes.set(p.platform, (platformVotes.get(p.platform) ?? 0) + 1);
    }
  }

  // .xcodeproj / .xcworkspace as additional iOS evidence.
  for (const probe of ["ios", "."]) {
    const dirPath = probe === "." ? project_dir : join(project_dir, probe);
    // Best-effort: only check whether SOMETHING.xcodeproj is somewhere shallow.
    // We don't recurse here; that's enough to disambiguate Flutter (which has an ios/ subdir).
    if (await exists(join(dirPath, "Runner.xcodeproj"))) {
      signals.push("Runner.xcodeproj");
      // Flutter has Runner.xcodeproj inside ios/; that's not the same as pure iOS.
      if (probe === "ios") {
        platformVotes.set("flutter", (platformVotes.get("flutter") ?? 0) + 1);
      } else {
        platformVotes.set("ios-native", (platformVotes.get("ios-native") ?? 0) + 1);
      }
    }
  }

  // Decide. Flutter > RN > Android > iOS when ties: a Flutter project also looks Android.
  const ranked: Platform[] = ["flutter", "react-native", "android-native", "ios-native"];
  let chosen: Platform = "unknown";
  let bestScore = 0;
  for (const p of ranked) {
    const score = platformVotes.get(p) ?? 0;
    if (score > bestScore) {
      bestScore = score;
      chosen = p;
    }
  }

  // Extract app metadata where easy.
  const extras: { app_name?: string; package_or_bundle?: string } = {};
  if (chosen === "android-native" || chosen === "flutter") {
    const candidates = [
      "app/build.gradle.kts",
      "app/build.gradle",
      "build.gradle.kts",
      "build.gradle",
      "android/app/build.gradle.kts",
      "android/app/build.gradle",
    ];
    for (const c of candidates) {
      const content = await tryRead(join(project_dir, c));
      if (!content) continue;
      const m =
        content.match(/applicationId\s*=?\s*['"]([^'"]+)['"]/) ||
        content.match(/namespace\s*=?\s*['"]([^'"]+)['"]/);
      if (m) {
        extras.package_or_bundle = m[1];
        break;
      }
    }
  }
  if (chosen === "flutter") {
    const pub = await tryRead(join(project_dir, "pubspec.yaml"));
    if (pub) {
      const m = pub.match(/^\s*name:\s*([A-Za-z0-9_\-]+)/m);
      if (m) extras.app_name = m[1];
    }
  }

  return { platform: chosen, signals, ...extras };
}
