import { z } from "zod";
import { GoogleAuth, type AnyAuthClient } from "google-auth-library";

import {
  CLOUD_LOGGING_ENDPOINT,
  MAX_PAGE_TOKEN_LENGTH,
  MAX_UPSTREAM_RESPONSE_BYTES,
} from "../constants.js";
import { CrashlyticsError } from "../errors.js";
import type {
  CrashApp,
  CrashEvent,
  CrashProvider,
  Page,
  ProviderEventQuery,
} from "../model.js";
import { normalizeCrashEvent } from "../normalize.js";
import type { AllowedApp } from "../config.js";

const responseSchema = z.object({
  entries: z.array(z.record(z.unknown())).max(1_000).optional(),
  nextPageToken: z.string().max(MAX_PAGE_TOKEN_LENGTH).optional(),
}).passthrough();

export interface CloudLoggingRequest {
  url: typeof CLOUD_LOGGING_ENDPOINT;
  body: Readonly<Record<string, unknown>>;
  timeoutMs: number;
}

export interface CloudLoggingRequester {
  request(input: CloudLoggingRequest): Promise<unknown>;
}

/** ADC is resolved only when the first Cloud Logging operation is executed. */
export class GoogleAuthRequester implements CloudLoggingRequester {
  private clientPromise?: Promise<AnyAuthClient>;

  private async client(): Promise<AnyAuthClient> {
    if (!this.clientPromise) {
      const auth = new GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/logging.read"],
      });
      this.clientPromise = auth.getClient();
    }
    return this.clientPromise;
  }

  async request(input: CloudLoggingRequest): Promise<unknown> {
    if (input.url !== CLOUD_LOGGING_ENDPOINT) {
      throw new CrashlyticsError("UPSTREAM_ERROR", "Cloud Logging endpoint is not allowed");
    }
    const client = await this.client();
    const response = await client.request({
      url: CLOUD_LOGGING_ENDPOINT,
      method: "POST",
      data: input.body,
      timeout: input.timeoutMs,
      // Enforce the response budget while bytes are being received, not only
      // after Gaxios has parsed and allocated the complete JSON document.
      maxContentLength: MAX_UPSTREAM_RESPONSE_BYTES,
      // The security boundary is the exact allowlisted endpoint; do not let an
      // HTTP redirect silently widen it or forward authenticated requests.
      maxRedirects: 0,
      retry: false,
    });
    return response.data;
  }
}

export interface CloudLoggingProviderOptions {
  allowedApps: readonly AllowedApp[];
  requestTimeoutMs: number;
  maxRetries: number;
  requester?: CloudLoggingRequester;
  sleep?: (milliseconds: number) => Promise<void>;
}

function escapeFilterLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildLoggingFilter(query: ProviderEventQuery): string {
  const projectId = escapeFilterLiteral(query.projectId);
  const appId = escapeFilterLiteral(query.appId);
  const clauses = [
    `logName="projects/${projectId}/logs/firebasecrashlytics.googleapis.com%2Fevents"`,
    `timestamp>="${query.startTime}"`,
    `timestamp<="${query.endTime}"`,
    "(" + [
      `resource.labels.firebase_app_id="${appId}"`,
      `labels.firebase_app_id="${appId}"`,
      `jsonPayload.firebase_app_id="${appId}"`,
      `jsonPayload.app_id="${appId}"`,
      `jsonPayload.appId="${appId}"`,
      `jsonPayload.name:"/apps/${appId}/"`,
    ].join(" OR ") + ")",
  ];
  if (query.issueId !== undefined) {
    const issue = escapeFilterLiteral(query.issueId);
    clauses.push("(" + [
      `resource.labels.issue_id="${issue}"`,
      `labels.issue_id="${issue}"`,
      `jsonPayload.issue.id="${issue}"`,
      `jsonPayload.issue_id="${issue}"`,
      `jsonPayload.issueId="${issue}"`,
    ].join(" OR ") + ")");
  }
  if (query.eventId !== undefined) {
    const event = escapeFilterLiteral(query.eventId);
    clauses.push("(" + [
      `labels.event_id="${event}"`,
      `jsonPayload.event_id="${event}"`,
      `jsonPayload.eventId="${event}"`,
      `insertId="${event}"`,
    ].join(" OR ") + ")");
  }
  if (query.versionName !== undefined) {
    const version = escapeFilterLiteral(query.versionName);
    clauses.push(`jsonPayload.version.displayVersion="${version}"`);
  }
  if (query.buildVersion !== undefined) {
    const build = escapeFilterLiteral(query.buildVersion);
    clauses.push(`jsonPayload.version.buildVersion="${build}"`);
  }
  return clauses.join(" AND ");
}

function statusFrom(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const object = error as Record<string, unknown>;
  const response = object.response;
  if (response && typeof response === "object") {
    const status = (response as Record<string, unknown>).status;
    if (typeof status === "number") return status;
  }
  const code = object.code;
  if (typeof code === "number") return code;
  if (typeof code === "string" && /^\d{3}$/.test(code)) return Number(code);
  return undefined;
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const object = error as Record<string, unknown>;
  return object.name === "AbortError"
    || object.code === "ETIMEDOUT"
    || object.code === "ESOCKETTIMEDOUT"
    || object.code === "ECONNABORTED";
}

function timeoutPromise<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CrashlyticsError(
        "UPSTREAM_TIMEOUT",
        "Cloud Logging request timed out",
        { retryable: true },
      ));
    }, milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class CloudLoggingProvider implements CrashProvider {
  readonly kind = "cloud_logging" as const;
  private readonly requester: CloudLoggingRequester;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: CloudLoggingProviderOptions) {
    this.requester = options.requester ?? new GoogleAuthRequester();
    this.sleep = options.sleep ?? defaultSleep;
  }

  async listApps(projectId: string): Promise<CrashApp[]> {
    // Cloud Logging has no Firebase-app discovery endpoint. Return only the
    // deployer-controlled allowlist; importantly, this operation needs no ADC call.
    return this.options.allowedApps
      .filter((app) => app.projectId === projectId)
      .map((app) => ({
        project_id: projectId,
        firebase_app_id: app.appId,
        app: { platform: "unknown" },
      }));
  }

  private async requestWithRetry(body: Readonly<Record<string, unknown>>): Promise<unknown> {
    let lastStatus: number | undefined;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        return await timeoutPromise(
          this.requester.request({
            url: CLOUD_LOGGING_ENDPOINT,
            body,
            timeoutMs: this.options.requestTimeoutMs,
          }),
          this.options.requestTimeoutMs,
        );
      } catch (error) {
        if (
          (error instanceof CrashlyticsError && error.code === "UPSTREAM_TIMEOUT")
          || isTimeoutError(error)
        ) {
          if (attempt < this.options.maxRetries) {
            await this.sleep(Math.min(100 * (2 ** attempt), 1_000));
            continue;
          }
          throw new CrashlyticsError(
            "UPSTREAM_TIMEOUT",
            "Cloud Logging request timed out",
            { retryable: true, cause: error },
          );
        }
        const status = statusFrom(error);
        lastStatus = status;
        const retryable = status === 429 || (status !== undefined && status >= 500 && status <= 599);
        if (retryable && attempt < this.options.maxRetries) {
          await this.sleep(Math.min(100 * (2 ** attempt), 1_000));
          continue;
        }
        if (status === 429) {
          throw new CrashlyticsError(
            "UPSTREAM_RATE_LIMITED",
            "Cloud Logging rate limit exceeded",
            { retryable: true, details: { status } },
          );
        }
        throw new CrashlyticsError(
          "UPSTREAM_ERROR",
          "Cloud Logging request failed",
          {
            retryable,
            ...(status !== undefined ? { details: { status } } : {}),
            cause: error,
          },
        );
      }
    }
    throw new CrashlyticsError(
      "UPSTREAM_ERROR",
      "Cloud Logging request failed",
      {
        retryable: true,
        ...(lastStatus !== undefined ? { details: { status: lastStatus } } : {}),
      },
    );
  }

  async listEvents(query: ProviderEventQuery): Promise<Page<CrashEvent>> {
    const body: Record<string, unknown> = {
      resourceNames: [`projects/${query.projectId}`],
      filter: buildLoggingFilter(query),
      orderBy: "timestamp desc",
      pageSize: query.pageSize,
    };
    if (query.pageToken !== undefined) body.pageToken = query.pageToken;

    const rawResponse = await this.requestWithRetry(body);
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(rawResponse), "utf8");
    } catch {
      throw new CrashlyticsError("UPSTREAM_ERROR", "Cloud Logging returned invalid JSON data");
    }
    if (bytes > MAX_UPSTREAM_RESPONSE_BYTES) {
      throw new CrashlyticsError(
        "RESPONSE_TOO_LARGE",
        "Cloud Logging response exceeded the upstream byte limit",
        { details: { response_bytes: bytes, limit_bytes: MAX_UPSTREAM_RESPONSE_BYTES } },
      );
    }
    const parsed = responseSchema.safeParse(rawResponse);
    if (!parsed.success) {
      throw new CrashlyticsError("UPSTREAM_ERROR", "Cloud Logging response schema is invalid");
    }
    const fetchedAt = new Date().toISOString();
    const entries = parsed.data.entries ?? [];
    const normalized = entries.map((entry) => normalizeCrashEvent(entry, {
        projectId: query.projectId,
        firebaseAppId: query.appId,
        frameLimit: query.frameLimit,
        fetchedAt,
      }));
    const rejectedEntries = normalized.filter((event) => event === undefined).length;
    if (rejectedEntries > 0) {
      throw new CrashlyticsError(
        "UPSTREAM_ERROR",
        "Cloud Logging returned Crashlytics entries that could not be safely normalized",
        {
          details: {
            entries_received: entries.length,
            entries_rejected: rejectedEntries,
          },
        },
      );
    }
    const startMs = Date.parse(query.startTime);
    const endMs = Date.parse(query.endTime);
    const items = normalized
      .filter((event): event is CrashEvent => event !== undefined)
      // The Logging filter constrains LogEntry.timestamp, while the public API
      // is defined in terms of the crash occurrence timestamp carried by the
      // normalized event. A delayed or malformed entry must not escape the
      // caller's approved event window.
      .filter((event) => {
        const occurredMs = Date.parse(event.event.occurred_at);
        return occurredMs >= startMs && occurredMs <= endMs;
      })
      .filter((event) => query.issueId === undefined || event.issue.id === query.issueId)
      .filter((event) => query.eventId === undefined || event.event.id === query.eventId)
      .filter((event) => query.versionName === undefined || event.app.version_name === query.versionName)
      .filter((event) => query.buildVersion === undefined || event.app.build_version === query.buildVersion);

    return {
      items,
      ...(parsed.data.nextPageToken ? { nextPageToken: parsed.data.nextPageToken } : {}),
    };
  }
}
