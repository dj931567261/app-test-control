import {
  assertAllowedApp,
  assertAllowedProject,
  type CrashlyticsConfig,
} from "./config.js";
import { CrashlyticsError } from "./errors.js";
import type {
  CrashEvent,
  CrashProvider,
  ProviderEventQuery,
  SymbolicationStatus,
} from "./model.js";
import type {
  GetEventInput,
  GetIssueInput,
  GetSymbolicationStatusInput,
  ListEventsInput,
  ListIssuesInput,
} from "./schemas.js";
import { hasSymbolicatedFrameSymbol } from "./normalize.js";

interface ResolvedRange {
  startTime: string;
  endTime: string;
}

export interface CrashlyticsServiceOptions {
  now?: () => Date;
}

function mergedSymbolication(events: readonly CrashEvent[]): {
  status: SymbolicationStatus;
  total_frames: number;
  symbolicated_frames: number;
} {
  const total = events.reduce((sum, event) => sum + event.frames.length, 0);
  const symbolicated = events.reduce(
    (sum, event) => sum + event.frames.filter(hasSymbolicatedFrameSymbol).length,
    0,
  );
  const states = new Set(events.map((event) => event.symbolication));
  let status: SymbolicationStatus;
  if (states.size === 1) status = events[0]?.symbolication ?? "unknown";
  else if (states.size === 0 || (states.size === 1 && states.has("unknown"))) status = "unknown";
  else status = "partial";
  return { status, total_frames: total, symbolicated_frames: symbolicated };
}

function eventMatches(
  event: CrashEvent,
  options: {
    fatal_only?: boolean;
    kind?: CrashEvent["kind"];
    version_name?: string;
    build_version?: string;
  },
): boolean {
  if (options.fatal_only && !event.fatal) return false;
  if (options.kind !== undefined && event.kind !== options.kind) return false;
  if (options.version_name !== undefined && event.app.version_name !== options.version_name) {
    return false;
  }
  if (options.build_version !== undefined && event.app.build_version !== options.build_version) {
    return false;
  }
  return true;
}

export class CrashlyticsService {
  private readonly now: () => Date;

  constructor(
    private readonly config: CrashlyticsConfig,
    private readonly provider: CrashProvider,
    options: CrashlyticsServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  getContext(): Readonly<Record<string, unknown>> {
    return {
      provider: this.config.provider,
      auth: this.config.provider === "cloud_logging" ? "application_default_credentials" : "fixture",
      projects: [...this.config.projects].sort(),
      apps: this.config.allowedApps
        .map((app) => ({ project_id: app.projectId, firebase_app_id: app.appId }))
        .sort((a, b) => `${a.project_id}/${a.firebase_app_id}`.localeCompare(`${b.project_id}/${b.firebase_app_id}`)),
      limits: {
        max_window_hours: this.config.maxWindowHours,
        max_page_size: 100,
        max_frames: 200,
        request_timeout_ms: this.config.requestTimeoutMs,
        max_retries: this.config.maxRetries,
      },
      privacy: {
        custom_keys_returned: false,
        user_returned: false,
        installation_id_returned: false,
        logs_returned: false,
        breadcrumbs_returned: false,
        redaction_enabled: true,
      },
      capabilities: {
        event_schema: "crash-event/v1",
        symbolication_evidence: "frame_coverage_only",
        symbol_artifact_identity_available: false,
      },
      read_only: true,
    };
  }

  private resolveRange(startTime?: string, endTime?: string): ResolvedRange {
    const nowMs = this.now().getTime();
    const endMs = endTime === undefined ? nowMs : Date.parse(endTime);
    const startMs = startTime === undefined
      ? endMs - this.config.maxWindowHours * 60 * 60 * 1_000
      : Date.parse(startTime);
    const maxWindowMs = this.config.maxWindowHours * 60 * 60 * 1_000;
    if (
      !Number.isFinite(startMs)
      || !Number.isFinite(endMs)
      || startMs > endMs
      || endMs - startMs > maxWindowMs
    ) {
      throw new CrashlyticsError(
        "INVALID_TIME_RANGE",
        `Time range must be ordered and no wider than ${this.config.maxWindowHours} hours`,
      );
    }
    return {
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(endMs).toISOString(),
    };
  }

  private query(
    input: {
      project_id: string;
      firebase_app_id: string;
      start_time?: string;
      end_time?: string;
      page_size: number;
      page_token?: string;
      frame_limit: number;
      issue_id?: string;
      event_id?: string;
      version_name?: string;
      build_version?: string;
    },
  ): ProviderEventQuery {
    assertAllowedApp(this.config, input.project_id, input.firebase_app_id);
    const range = this.resolveRange(input.start_time, input.end_time);
    return {
      projectId: input.project_id,
      appId: input.firebase_app_id,
      startTime: range.startTime,
      endTime: range.endTime,
      pageSize: input.page_size,
      frameLimit: input.frame_limit,
      ...(input.page_token !== undefined ? { pageToken: input.page_token } : {}),
      ...(input.issue_id !== undefined ? { issueId: input.issue_id } : {}),
      ...(input.event_id !== undefined ? { eventId: input.event_id } : {}),
      ...(input.version_name !== undefined ? { versionName: input.version_name } : {}),
      ...(input.build_version !== undefined ? { buildVersion: input.build_version } : {}),
    };
  }

  async listApps(projectId: string): Promise<Readonly<Record<string, unknown>>> {
    assertAllowedProject(this.config, projectId);
    const allowed = this.config.appsByProject.get(projectId) ?? new Set<string>();
    const apps = (await this.provider.listApps(projectId))
      .filter((app) => allowed.has(app.firebase_app_id));
    return { project_id: projectId, apps, count: apps.length };
  }

  async listEvents(input: ListEventsInput): Promise<Readonly<Record<string, unknown>>> {
    const page = await this.provider.listEvents(this.query(input));
    const events = page.items.filter((event) => eventMatches(event, input));
    return {
      events,
      count: events.length,
      ...(page.nextPageToken ? { next_page_token: page.nextPageToken } : {}),
    };
  }

  async getEvent(input: GetEventInput): Promise<CrashEvent> {
    const page = await this.provider.listEvents(this.query({
      ...input,
      page_size: 2,
    }));
    if (page.nextPageToken !== undefined || page.items.length > 1) {
      throw new CrashlyticsError(
        "UPSTREAM_ERROR",
        "Crashlytics event lookup did not return one unique bounded event",
      );
    }
    const event = page.items[0];
    if (event === undefined) {
      throw new CrashlyticsError("NOT_FOUND", "Crashlytics event was not found");
    }
    if (
      event.project_id !== input.project_id
      || event.firebase_app_id !== input.firebase_app_id
      || event.event.id !== input.event_id
    ) {
      throw new CrashlyticsError(
        "UPSTREAM_ERROR",
        "Crashlytics event lookup returned a conflicting target identity",
      );
    }
    return event;
  }

  async listIssues(input: ListIssuesInput): Promise<Readonly<Record<string, unknown>>> {
    const page = await this.provider.listEvents(this.query(input));
    const events = page.items.filter((event) => eventMatches(event, input));
    const groups = new Map<string, CrashEvent[]>();
    for (const event of events) {
      const group = groups.get(event.issue.id) ?? [];
      group.push(event);
      groups.set(event.issue.id, group);
    }
    const issues = [...groups.values()].map((group) => {
      group.sort((a, b) => b.event.occurred_at.localeCompare(a.event.occurred_at));
      const representative = group[0];
      if (!representative) throw new CrashlyticsError("INTERNAL_ERROR", "Issue group is empty");
      const occurrenceSum = group.reduce(
        (sum, event) => sum + (event.aggregate?.events ?? 1),
        0,
      );
      return {
        project_id: representative.project_id,
        firebase_app_id: representative.firebase_app_id,
        issue: representative.issue,
        fatal: group.some((event) => event.fatal),
        kind: representative.kind,
        first_seen: group.at(-1)?.event.occurred_at,
        last_seen: representative.event.occurred_at,
        representative_event_id: representative.event.id,
        aggregate: {
          events_in_page: group.length,
          occurrences_in_page: occurrenceSum,
        },
        symbolication: mergedSymbolication(group),
        truncated: group.some((event) => event.truncated),
      };
    });
    return {
      issues: issues.slice(0, input.page_size),
      count: Math.min(issues.length, input.page_size),
      aggregation_scope: "current_event_page",
      ...(page.nextPageToken ? { next_page_token: page.nextPageToken } : {}),
    };
  }

  async getIssue(input: GetIssueInput): Promise<Readonly<Record<string, unknown>>> {
    const page = await this.provider.listEvents(this.query({
      ...input,
      page_size: 100,
    }));
    const events = page.items
      .filter((event) => event.issue.id === input.issue_id)
      .filter((event) => eventMatches(event, input));
    if (events.length === 0) {
      throw new CrashlyticsError("NOT_FOUND", "Crashlytics issue was not found");
    }
    events.sort((a, b) => b.event.occurred_at.localeCompare(a.event.occurred_at));
    const representative = events[0];
    if (!representative) throw new CrashlyticsError("INTERNAL_ERROR", "Issue group is empty");
    return {
      project_id: representative.project_id,
      firebase_app_id: representative.firebase_app_id,
      issue: representative.issue,
      fatal: events.some((event) => event.fatal),
      kind: representative.kind,
      first_seen: events.at(-1)?.event.occurred_at,
      last_seen: representative.event.occurred_at,
      representative_event: representative,
      aggregate: {
        events_in_page: events.length,
        occurrences_in_page: events.reduce(
          (sum, event) => sum + (event.aggregate?.events ?? 1),
          0,
        ),
        partial: page.nextPageToken !== undefined,
      },
      symbolication: mergedSymbolication(events),
      truncated: events.some((event) => event.truncated),
      build_scope: input.version_name && input.build_version
        ? { version_name: input.version_name, build_version: input.build_version }
        : { exact: false },
    };
  }

  async getSymbolicationStatus(
    input: GetSymbolicationStatusInput,
  ): Promise<Readonly<Record<string, unknown>>> {
    const page = await this.provider.listEvents(this.query({
      ...input,
      page_size: input.event_id ? 2 : 100,
    }));
    const events = page.items
      .filter((event) =>
        input.event_id !== undefined
          ? event.event.id === input.event_id
          : event.issue.id === input.issue_id,
      )
      .filter((event) => eventMatches(event, input));
    if (events.length === 0) {
      throw new CrashlyticsError("NOT_FOUND", "Crashlytics event or issue was not found");
    }
    return {
      project_id: input.project_id,
      firebase_app_id: input.firebase_app_id,
      target: input.event_id
        ? { event_id: input.event_id }
        : { issue_id: input.issue_id },
      symbolication: mergedSymbolication(events),
      events_checked: events.length,
      partial: page.nextPageToken !== undefined,
      evidence_kind: "frame_symbolication_coverage",
      build_scope: input.version_name && input.build_version
        ? { version_name: input.version_name, build_version: input.build_version }
        : {
            version_name: events[0]?.app.version_name,
            build_version: events[0]?.app.build_version,
          },
      artifact_identity: {
        verified: false,
        reason: "Cloud Logging events do not prove mapping, dSYM, or native-symbol artifact identity",
      },
    };
  }
}
