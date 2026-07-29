export const PROVIDER_NAME = "firebase-crashlytics" as const;
export const CLOUD_LOGGING_ENDPOINT =
  "https://logging.googleapis.com/v2/entries:list" as const;

export const DEFAULT_MAX_WINDOW_HOURS = 24;
export const ABSOLUTE_MAX_WINDOW_HOURS = 24 * 30;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_FRAME_LIMIT = 80;
export const MAX_FRAME_LIMIT = 200;
export const MAX_PAGE_TOKEN_LENGTH = 2_048;
export const MAX_IDENTIFIER_LENGTH = 256;
export const MAX_TEXT_FIELD_BYTES = 8 * 1024;
export const MAX_CANONICAL_STACK_BYTES = 256 * 1024;
export const MAX_MCP_RESPONSE_BYTES = 1024 * 1024;
export const MAX_UPSTREAM_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_FIXTURE_BYTES = 8 * 1024 * 1024;
export const MAX_FIXTURE_EVENTS = 10_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
export const MIN_REQUEST_TIMEOUT_MS = 250;
export const MAX_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;
export const MAX_RETRIES = 4;
