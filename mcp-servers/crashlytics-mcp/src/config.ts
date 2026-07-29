import path from "node:path";

import {
  ABSOLUTE_MAX_WINDOW_HOURS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_WINDOW_HOURS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
  MAX_RETRIES,
  MIN_REQUEST_TIMEOUT_MS,
} from "./constants.js";
import { CrashlyticsError } from "./errors.js";

export type ProviderKind = "cloud_logging" | "fixture";

export interface AllowedApp {
  projectId: string;
  appId: string;
}
export interface CrashlyticsConfig {
  provider: ProviderKind;
  projects: ReadonlySet<string>;
  appsByProject: ReadonlyMap<string, ReadonlySet<string>>;
  allowedApps: readonly AllowedApp[];
  fixturePath?: string;
  maxWindowHours: number;
  requestTimeoutMs: number;
  maxRetries: number;
}

const PROJECT_PATTERN = /^[a-z][a-z0-9.-]{3,62}$/;
const APP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function readInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new CrashlyticsError("CONFIG_INVALID", `${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new CrashlyticsError(
      "CONFIG_INVALID",
      `${name} must be between ${min} and ${max}`,
    );
  }
  return value;
}

function parseCsv(raw: string | undefined, name: string): string[] {
  if (!raw?.trim()) {
    throw new CrashlyticsError("CONFIG_INVALID", `${name} is required`);
  }
  const values = raw.split(",").map((value) => value.trim());
  if (values.some((value) => value.length === 0)) {
    throw new CrashlyticsError("CONFIG_INVALID", `${name} contains an empty entry`);
  }
  return [...new Set(values)];
}

export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CrashlyticsConfig {
  const providerRaw = env.CRASHLYTICS_PROVIDER?.trim() || "cloud_logging";
  if (providerRaw !== "cloud_logging" && providerRaw !== "fixture") {
    throw new CrashlyticsError(
      "CONFIG_INVALID",
      "CRASHLYTICS_PROVIDER must be cloud_logging or fixture",
    );
  }

  const projects = parseCsv(
    env.CRASHLYTICS_PROJECT_ALLOWLIST,
    "CRASHLYTICS_PROJECT_ALLOWLIST",
  );
  for (const projectId of projects) {
    if (!PROJECT_PATTERN.test(projectId)) {
      throw new CrashlyticsError(
        "CONFIG_INVALID",
        "CRASHLYTICS_PROJECT_ALLOWLIST contains an invalid project id",
      );
    }
  }

  // Each entry is project_id=app_id. Requiring the project on every entry avoids
  // accidentally granting one app id access in every allowed project.
  const appEntries = parseCsv(
    env.CRASHLYTICS_APP_ALLOWLIST,
    "CRASHLYTICS_APP_ALLOWLIST",
  );
  const allowedApps: AllowedApp[] = [];
  const mutableApps = new Map<string, Set<string>>();
  for (const entry of appEntries) {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new CrashlyticsError(
        "CONFIG_INVALID",
        "CRASHLYTICS_APP_ALLOWLIST entries must use project_id=app_id",
      );
    }
    const projectId = entry.slice(0, separator);
    const appId = entry.slice(separator + 1);
    if (!projects.includes(projectId) || !APP_PATTERN.test(appId)) {
      throw new CrashlyticsError(
        "CONFIG_INVALID",
        "CRASHLYTICS_APP_ALLOWLIST contains an invalid or unapproved project/app pair",
      );
    }
    const apps = mutableApps.get(projectId) ?? new Set<string>();
    apps.add(appId);
    mutableApps.set(projectId, apps);
  }

  for (const [projectId, apps] of mutableApps) {
    for (const appId of apps) allowedApps.push({ projectId, appId });
  }

  let fixturePath: string | undefined;
  if (providerRaw === "fixture") {
    const rawPath = env.CRASHLYTICS_FIXTURE_PATH?.trim();
    if (!rawPath || !path.isAbsolute(rawPath) || rawPath.includes("\0")) {
      throw new CrashlyticsError(
        "CONFIG_INVALID",
        "CRASHLYTICS_FIXTURE_PATH must be an absolute path for fixture provider",
      );
    }
    fixturePath = path.normalize(rawPath);
  }

  const appsByProject = new Map<string, ReadonlySet<string>>();
  for (const projectId of projects) {
    appsByProject.set(projectId, new Set(mutableApps.get(projectId) ?? []));
  }

  return {
    provider: providerRaw,
    projects: new Set(projects),
    appsByProject,
    allowedApps,
    ...(fixturePath ? { fixturePath } : {}),
    maxWindowHours: readInteger(
      env.CRASHLYTICS_MAX_WINDOW_HOURS,
      DEFAULT_MAX_WINDOW_HOURS,
      1,
      ABSOLUTE_MAX_WINDOW_HOURS,
      "CRASHLYTICS_MAX_WINDOW_HOURS",
    ),
    requestTimeoutMs: readInteger(
      env.CRASHLYTICS_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      MIN_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS,
      "CRASHLYTICS_REQUEST_TIMEOUT_MS",
    ),
    maxRetries: readInteger(
      env.CRASHLYTICS_MAX_RETRIES,
      DEFAULT_MAX_RETRIES,
      0,
      MAX_RETRIES,
      "CRASHLYTICS_MAX_RETRIES",
    ),
  };
}

export function assertAllowedProject(
  config: CrashlyticsConfig,
  projectId: string,
): void {
  if (!config.projects.has(projectId)) {
    throw new CrashlyticsError(
      "FORBIDDEN_PROJECT",
      "Project is not in CRASHLYTICS_PROJECT_ALLOWLIST",
    );
  }
}

export function assertAllowedApp(
  config: CrashlyticsConfig,
  projectId: string,
  appId: string,
): void {
  assertAllowedProject(config, projectId);
  if (!config.appsByProject.get(projectId)?.has(appId)) {
    throw new CrashlyticsError(
      "FORBIDDEN_APP",
      "App is not in CRASHLYTICS_APP_ALLOWLIST for this project",
    );
  }
}
