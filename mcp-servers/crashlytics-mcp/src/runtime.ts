import { loadConfig, type CrashlyticsConfig } from "./config.js";
import type { CrashProvider } from "./model.js";
import { CloudLoggingProvider } from "./providers/cloud-logging.js";
import { FixtureProvider } from "./providers/fixture.js";
import { CrashlyticsService } from "./service.js";

export function createProvider(config: CrashlyticsConfig): CrashProvider {
  if (config.provider === "fixture") {
    // loadConfig guarantees this field for fixture mode.
    if (!config.fixturePath) throw new Error("fixturePath invariant violated");
    return new FixtureProvider(config.fixturePath);
  }
  return new CloudLoggingProvider({
    allowedApps: config.allowedApps,
    requestTimeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
  });
}
export function createServiceFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CrashlyticsService {
  const config = loadConfig(env);
  return new CrashlyticsService(config, createProvider(config));
}

/** Keeps config parsing, fixture I/O and ADC resolution outside startup. */
export function createLazyService(
  factory: () => CrashlyticsService = () => createServiceFromEnvironment(),
): () => CrashlyticsService {
  let service: CrashlyticsService | undefined;
  return () => {
    service ??= factory();
    return service;
  };
}
