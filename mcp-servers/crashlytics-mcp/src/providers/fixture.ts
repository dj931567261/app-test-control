import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

import { z } from "zod";

import {
  MAX_FIXTURE_BYTES,
  MAX_FIXTURE_EVENTS,
  MAX_FRAME_LIMIT,
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

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as UnknownRecord;
}

function atPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    const object = record(current);
    if (!object) return undefined;
    current = object[segment];
  }
  return current;
}

function fixtureEventTarget(raw: unknown): { projectId: string; appId: string } | undefined {
  const root = record(raw);
  if (!root) return undefined;
  const payload = record(root.jsonPayload) ?? record(root.payload) ?? root;
  const resourceLabels = record(atPath(root, "resource.labels")) ?? {};
  const labels = record(root.labels) ?? {};
  const sources = [payload, resourceLabels, labels, root];
  const projects = new Set<string>();
  const apps = new Set<string>();
  let invalid = false;
  for (const source of sources) {
    for (const path of ["project_id", "projectId"]) {
      const value = atPath(source, path);
      if (value === undefined || value === null) continue;
      if (typeof value !== "string") invalid = true;
      else projects.add(value);
    }
    for (const path of ["firebase_app_id", "firebaseAppId", "app_id", "appId"]) {
      const value = atPath(source, path);
      if (value === undefined || value === null) continue;
      if (typeof value !== "string") invalid = true;
      else apps.add(value);
    }
  }
  const name = atPath(payload, "name");
  if (name !== undefined && name !== null) {
    if (typeof name !== "string" || name.length > 1_024) {
      invalid = true;
    } else {
      const match = /^projects\/([^/]+)\/apps\/([^/]+)\/events\/([^/]+)$/u.exec(name);
      if (!match?.[1] || !match[2]) invalid = true;
      else {
        projects.add(match[1]);
        apps.add(match[2]);
      }
    }
  }
  const projectId = [...projects][0];
  const appId = [...apps][0];
  return !invalid && projects.size === 1 && apps.size === 1 && projectId && appId
    ? { projectId, appId }
    : undefined;
}

function validateFixtureEvents(fixture: Fixture): void {
  const apps = new Set<string>();
  for (const app of fixture.apps) {
    const key = `${app.project_id}\0${app.firebase_app_id}`;
    if (apps.has(key)) {
      throw new CrashlyticsError(
        "FIXTURE_INVALID",
        "Crashlytics fixture contains a duplicate app identity",
      );
    }
    apps.add(key);
  }

  const fetchedAt = new Date().toISOString();
  for (const raw of fixture.events) {
    const target = fixtureEventTarget(raw);
    if (
      target === undefined
      || !apps.has(`${target.projectId}\0${target.appId}`)
      || normalizeCrashEvent(raw, {
        projectId: target.projectId,
        firebaseAppId: target.appId,
        frameLimit: MAX_FRAME_LIMIT,
        fetchedAt,
      }) === undefined
    ) {
      throw new CrashlyticsError(
        "FIXTURE_INVALID",
        "Crashlytics fixture contains a malformed or conflicting event",
      );
    }
  }
}

export interface FixtureIo {
  readFileSecure(path: string): Promise<Buffer>;
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function identityOf(metadata: Awaited<ReturnType<FileHandle["stat"]>>): FileIdentity {
  // The production calls below request bigint stats. Keep this conversion
  // explicit so a future refactor cannot silently reintroduce lossy inode or
  // nanosecond timestamp comparisons.
  const value = metadata as unknown as {
    dev: bigint;
    ino: bigint;
    mode: bigint;
    nlink: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  };
  return {
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    nlink: value.nlink,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return Object.keys(left).every((key) =>
    left[key as keyof FileIdentity] === right[key as keyof FileIdentity]
  );
}

function assertSafeRegularFile(
  metadata: Awaited<ReturnType<FileHandle["stat"]>>,
): FileIdentity {
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new CrashlyticsError(
      "FIXTURE_INVALID",
      "Crashlytics fixture path must reference a regular file",
    );
  }
  const identity = identityOf(metadata);
  if (identity.nlink !== 1n) {
    throw new CrashlyticsError(
      "FIXTURE_INVALID",
      "Crashlytics fixture hard links are not allowed",
    );
  }
  if (identity.size < 0n || identity.size > BigInt(MAX_FIXTURE_BYTES)) {
    throw new CrashlyticsError(
      "FIXTURE_INVALID",
      `Crashlytics fixture exceeds ${MAX_FIXTURE_BYTES} bytes`,
    );
  }
  return identity;
}

/**
 * Read one bounded fixture through a pinned descriptor. The path is checked
 * before open, the descriptor identity is checked before and after reading,
 * and an exact EOF probe rejects concurrent growth. This prevents a local
 * path/symlink swap from turning fixture mode into an arbitrary file reader.
 */
export async function readFixtureFileSecure(path: string): Promise<Buffer> {
  const beforeMetadata = await lstat(path, { bigint: true });
  const before = assertSafeRegularFile(beforeMetadata);
  const flags = constants.O_RDONLY
    | (constants.O_NOFOLLOW ?? 0)
    | (constants.O_NONBLOCK ?? 0);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, flags);
    const openedMetadata = await handle.stat({ bigint: true });
    const opened = assertSafeRegularFile(openedMetadata);
    if (!sameIdentity(before, opened)) {
      throw new CrashlyticsError(
        "FIXTURE_INVALID",
        "Crashlytics fixture changed while it was being opened",
      );
    }

    const expectedBytes = Number(opened.size);
    const bytes = Buffer.allocUnsafe(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      const result = await handle.read(bytes, offset, expectedBytes - offset, offset);
      if (result.bytesRead === 0) {
        throw new CrashlyticsError(
          "FIXTURE_INVALID",
          "Crashlytics fixture changed while it was being read",
        );
      }
      offset += result.bytesRead;
    }
    const eofProbe = Buffer.allocUnsafe(1);
    if ((await handle.read(eofProbe, 0, 1, expectedBytes)).bytesRead !== 0) {
      throw new CrashlyticsError(
        "FIXTURE_INVALID",
        `Crashlytics fixture exceeds ${MAX_FIXTURE_BYTES} bytes`,
      );
    }
    const after = assertSafeRegularFile(await handle.stat({ bigint: true }));
    if (!sameIdentity(opened, after)) {
      throw new CrashlyticsError(
        "FIXTURE_INVALID",
        "Crashlytics fixture changed while it was being read",
      );
    }
    return bytes;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const DEFAULT_FIXTURE_IO: FixtureIo = { readFileSecure: readFixtureFileSecure };

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
    private readonly io: FixtureIo = DEFAULT_FIXTURE_IO,
  ) {}

  private load(): Promise<Fixture> {
    this.fixturePromise ??= this.loadOnce();
    return this.fixturePromise;
  }

  private async loadOnce(): Promise<Fixture> {
    try {
      const bytes = await this.io.readFileSecure(this.fixturePath);
      if (bytes.byteLength > MAX_FIXTURE_BYTES) {
        throw new CrashlyticsError(
          "FIXTURE_INVALID",
          `Crashlytics fixture exceeds ${MAX_FIXTURE_BYTES} bytes`,
        );
      }
      let json: unknown;
      try {
        json = JSON.parse(UTF8_DECODER.decode(bytes));
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
      validateFixtureEvents(parsed.data);
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
