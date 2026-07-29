export type CrashlyticsErrorCode =
  | "CONFIG_INVALID"
  | "FORBIDDEN_PROJECT"
  | "FORBIDDEN_APP"
  | "INVALID_TIME_RANGE"
  | "INVALID_PAGE_TOKEN"
  | "NOT_FOUND"
  | "FIXTURE_INVALID"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "RESPONSE_TOO_LARGE"
  | "INTERNAL_ERROR";

export class CrashlyticsError extends Error {
  readonly code: CrashlyticsErrorCode;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: CrashlyticsErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      details?: Readonly<Record<string, unknown>>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "CrashlyticsError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function toPublicError(error: unknown): {
  error: {
    code: CrashlyticsErrorCode;
    message: string;
    retryable: boolean;
    details?: Readonly<Record<string, unknown>>;
  };
} {
  if (error instanceof CrashlyticsError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }

  return {
    error: {
      code: "INTERNAL_ERROR",
      message: "Unexpected Crashlytics MCP failure",
      retryable: false,
    },
  };
}
