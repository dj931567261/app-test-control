import { lstat, readFile } from "node:fs/promises";

import { z } from "zod";

import {
  MAX_FIXTURE_BYTES,
  MAX_FIXTURE_EVENTS,
} from "../constants.js";
import { CrashlyticsError } from "../errors.js";
import type {
  CrashApp,
  CrashEvent,
  CrashProvider,
  Page,
  Platform,
  ProviderEventQuery,
} from "../model.js";
import { normalizeCrashEvent } from "../normalize.js";
import { redactText } from "../redact.js";

const fixtureAppSchema = z.object({
  project_id: z.string().min(4).max(63).regex(/^[a-z][a-z0-9.-]+$/),
  firebase_app_id: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/),
  platform: z.enum(["android", "ios", "unknown"]),
  package_name: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
  bundle_id: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
  display_name: z.string().max(1024).optional(),
}).strict();

const fixtureSchema = z.object({
  schema_version: z.literal("crashlytics-fixture/v1"),
  apps: z.array(fixtureAppSchema).max(1_000),
  events: z.array(z.record(z.unknown())).max(MAX_FIXTURE_EVENTS),
}).strict();

type Fixture = z.infer<typeof fixtureSchema>;

export interface FixtureIo {
  lstat: typeof lstat;
  readFile: typeof readFile;
}

function encodeCursor(offset: number): string {
  return Buffer.from(`fixture:${offset}`, "utf8").toString("base64url");
}

function decodeCursor(token: string | undefined): number {
  if (token === undefined) return 0;
  let value: string;
  try {
    value = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    throw new CrashlyticsError("INVALID_PAGE_TOKEN", "Fixture page token is invalid");
  }
  const match = /^fixture:(\d{1,9})$/.exec(value);
  if (!match) {
    throw new CrashlyticsError("INVALID_PAGE_TOKEN", "Fixture page token is invalid");
  }
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_FIXTURE_EVENTS) {
    throw new CrashlyticsError("INVALID_PAGE_TOKEN", "Fixture page token is out of range");
  }
  return offset;
}

export class FixtureProvider implements CrashProvider {
  readonly kind = "fixture" as const;
  private fixturePromise?: Promise<Fixture>;

  constructor(
    private readonly fixturePath: string,
    private readonly io: FixtureIo = { lstat, readFile },
  ) {}

  private load(): Promise<Fixture> {
    this.fixturePromise ??= this.loadOnce();
    return this.fixturePromise;
  }

  private async loadOnce(): Promise<Fixture> {
    try {
      const metadata = await this.io.lstat(this.fixturePath);
      if (!metadata.isFile()) {
        throw new CrashlyticsError(
          "FIXTURE_INVALID",
          "Crashlytics fixture path must reference a regular file",
        );
      }
      if (metadata.size > MAX_FIXTURE_BYTES) {
        throw new CrashlyticsError(
          "FIXTURE_INVALID",
          `Crashlytics fixture exceeds ${MAX_FIXTURE_BYTES} bytes`,
        );
      }
      const bytes = await this.io.readFile(this.fixturePath);
      if (bytes.byteLength > MAX_FIXTURE_BYTES) {
        throw new CrashlyticsError(
          "FIXTURE_INVALID",
          `Crashlytics fixture exceeds ${MAX_FIXTURE_BYTES} bytes`,
        );
      }
      let json: unknown;
      try {
        json = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new CrashlyticsError("FIXTURE_INVALID", "Crashlytics fixture is not valid JSON");
      }
      const parsed = fixtureSchema.safeParse(json);
      if (!parsed.success) {
        throw new CrashlyticsError(
          "FIXTURE_INVALID",
          "Crashlytics fixture does not match crashlytics-fixture/v1",
        );
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof CrashlyticsError) throw error;
      throw new CrashlyticsError(
        "FIXTURE_INVALID",
        "Unable to load Crashlytics fixture",
        { cause: error },
      );
    }
  }

  async listApps(projectId: string): Promise<CrashApp[]> {
    const fixture = await this.load();
    return fixture.apps
      .filter((item) => item.project_id === projectId)
      .map((item) => {
        const displayName = redactText(item.display_name)?.value
          .replace(/[\u0000-\u001f\u007f]+/gu, " ")
          .trim();
        const app: CrashApp = {
          project_id: item.project_id,
          firebase_app_id: item.firebase_app_id,
          app: { platform: item.platform as Platform },
        };
        if (item.package_name !== undefined) app.app.package_name = item.package_name;
        if (item.bundle_id !== undefined) app.app.bundle_id = item.bundle_id;
        if (displayName !== undefined) app.app.display_name = displayName;
        return app;
      });
  }

  async listEvents(query: ProviderEventQuery): Promise<Page<CrashEvent>> {
    const fixture = await this.load();
    const startMs = Date.parse(query.startTime);
    const endMs = Date.parse(query.endTime);
    const fetchedAt = new Date().toISOString();
    const normalized = fixture.events
      .map((raw) => normalizeCrashEvent(raw, {
        projectId: query.projectId,
        firebaseAppId: query.appId,
        frameLimit: query.frameLimit,
        fetchedAt,
      }))
      .filter((event): event is CrashEvent => event !== undefined)
      .filter((event) => {
        const time = Date.parse(event.event.occurred_at);
        return time >= startMs && time <= endMs;
      })
      .filter((event) => query.issueId === undefined || event.issue.id === query.issueId)
      .filter((event) => query.eventId === undefined || event.event.id === query.eventId)
      .filter((event) => query.versionName === undefined || event.app.version_name === query.versionName)
      .filter((event) => query.buildVersion === undefined || event.app.build_version === query.buildVersion)
      .sort((left, right) => right.event.occurred_at.localeCompare(left.event.occurred_at));

    const offset = decodeCursor(query.pageToken);
    if (offset > normalized.length) {
      throw new CrashlyticsError("INVALID_PAGE_TOKEN", "Fixture page token is out of range");
    }
    const items = normalized.slice(offset, offset + query.pageSize);
    const nextOffset = offset + items.length;
    return {
      items,
      ...(nextOffset < normalized.length ? { nextPageToken: encodeCursor(nextOffset) } : {}),
    };
  }
}
