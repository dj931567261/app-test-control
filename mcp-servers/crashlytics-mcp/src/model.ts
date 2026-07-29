import { PROVIDER_NAME } from "./constants.js";

export type Platform = "android" | "ios" | "unknown";
export type SymbolicationStatus =
  | "symbolicated"
  | "partial"
  | "unsymbolicated"
  | "unknown";

export interface CrashApp {
  project_id: string;
  firebase_app_id: string;
  app: {
    platform: Platform;
    package_name?: string;
    bundle_id?: string;
    display_name?: string;
  };
}

export interface CrashFrame {
  index: number;
  symbol: string;
  module?: string;
  file?: string;
  line?: number;
  app_owned?: boolean;
  address?: string;
  offset?: string;
}

export interface CrashEvent {
  schema_version: "crash-event/v1";
  provider: typeof PROVIDER_NAME;
  project_id: string;
  firebase_app_id: string;
  app: {
    platform: Exclude<Platform, "unknown">;
    package_name?: string;
    bundle_id?: string;
    version_name?: string;
    build_version?: string;
  };
  issue: {
    id: string;
    title: string;
    type: string;
    state?: string;
  };
  event: {
    id: string;
    occurred_at: string;
  };
  fatal: boolean;
  kind: "java" | "anr" | "native" | "ios" | "unknown";
  process?: string;
  thread?: string;
  exception: {
    class?: string;
    root_cause_class?: string;
    signal?: string;
  };
  frames: CrashFrame[];
  canonical_stack: string;
  symbolication: SymbolicationStatus;
  aggregate?: {
    events?: number;
    users?: number;
    first_seen?: string;
    last_seen?: string;
  };
  truncated: boolean;
  fetched_at: string;
}

export interface ProviderEventQuery {
  projectId: string;
  appId: string;
  startTime: string;
  endTime: string;
  pageSize: number;
  pageToken?: string;
  issueId?: string;
  eventId?: string;
  versionName?: string;
  buildVersion?: string;
  frameLimit: number;
}

export interface Page<T> {
  items: T[];
  nextPageToken?: string;
}

export interface CrashProvider {
  readonly kind: "cloud_logging" | "fixture";
  listApps(projectId: string): Promise<CrashApp[]>;
  listEvents(query: ProviderEventQuery): Promise<Page<CrashEvent>>;
}
