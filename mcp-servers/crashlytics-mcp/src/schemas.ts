import { z } from "zod";

import {
  DEFAULT_FRAME_LIMIT,
  DEFAULT_PAGE_SIZE,
  MAX_FRAME_LIMIT,
  MAX_IDENTIFIER_LENGTH,
  MAX_PAGE_SIZE,
  MAX_PAGE_TOKEN_LENGTH,
} from "./constants.js";

const safeIdentifier = (label: string) => z.string()
  .trim()
  .min(1, `${label} must not be empty`)
  .max(MAX_IDENTIFIER_LENGTH, `${label} is too long`)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
    `${label} contains unsupported characters`,
  );

export const projectIdSchema = z.string()
  .trim()
  .min(4)
  .max(63)
  .regex(/^[a-z][a-z0-9.-]+$/, "project_id is invalid");
export const appIdSchema = safeIdentifier("firebase_app_id");
export const issueIdSchema = safeIdentifier("issue_id");
export const eventIdSchema = safeIdentifier("event_id");
export const dateTimeSchema = z.string().datetime({ offset: true });
const buildIdentitySchema = (label: string) => z.string()
  .trim()
  .min(1, `${label} must not be empty`)
  .max(256, `${label} is too long`)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), `${label} contains control characters`);

const rangeShape = {
  start_time: dateTimeSchema.optional(),
  end_time: dateTimeSchema.optional(),
};
const pageShape = {
  page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  page_token: z.string().min(1).max(MAX_PAGE_TOKEN_LENGTH).optional(),
};
const frameShape = {
  frame_limit: z.number().int().min(1).max(MAX_FRAME_LIMIT).default(DEFAULT_FRAME_LIMIT),
};
const targetShape = {
  project_id: projectIdSchema,
  firebase_app_id: appIdSchema,
};
const buildShape = {
  version_name: buildIdentitySchema("version_name").optional(),
  build_version: buildIdentitySchema("build_version").optional(),
};

function requireBuildPair(
  value: { version_name?: string; build_version?: string },
  context: z.RefinementCtx,
): void {
  if ((value.version_name === undefined) !== (value.build_version === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "version_name and build_version must be provided together",
      path: [value.version_name === undefined ? "version_name" : "build_version"],
    });
  }
}

export const getContextInputSchema = z.object({}).strict();
export const listAppsInputSchema = z.object({
  project_id: projectIdSchema,
}).strict();
export const listIssuesInputObjectSchema = z.object({
  ...targetShape,
  ...buildShape,
  ...rangeShape,
  ...pageShape,
  ...frameShape,
  fatal_only: z.boolean().default(false),
  kind: z.enum(["java", "anr", "native", "ios", "unknown"]).optional(),
}).strict();
export const listIssuesInputSchema = listIssuesInputObjectSchema.superRefine(requireBuildPair);

export const getIssueInputObjectSchema = z.object({
  ...targetShape,
  issue_id: issueIdSchema,
  ...buildShape,
  ...rangeShape,
  ...frameShape,
}).strict();
export const getIssueInputSchema = getIssueInputObjectSchema.superRefine(requireBuildPair);

export const listEventsInputObjectSchema = z.object({
  ...targetShape,
  issue_id: issueIdSchema.optional(),
  ...buildShape,
  ...rangeShape,
  ...pageShape,
  ...frameShape,
  fatal_only: z.boolean().default(false),
  kind: z.enum(["java", "anr", "native", "ios", "unknown"]).optional(),
}).strict();
export const listEventsInputSchema = listEventsInputObjectSchema.superRefine(requireBuildPair);

export const getEventInputSchema = z.object({
  ...targetShape,
  event_id: eventIdSchema,
  ...rangeShape,
  ...frameShape,
}).strict();
export const getSymbolicationStatusInputObjectSchema = z.object({
  ...targetShape,
  issue_id: issueIdSchema.optional(),
  event_id: eventIdSchema.optional(),
  ...buildShape,
  ...rangeShape,
  ...frameShape,
}).strict();
export const getSymbolicationStatusInputSchema = getSymbolicationStatusInputObjectSchema
  .superRefine((value, context) => {
    requireBuildPair(value, context);
    const count = Number(value.issue_id !== undefined) + Number(value.event_id !== undefined);
    if (count !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exactly one of issue_id or event_id is required",
        path: ["issue_id"],
      });
    }
    if (value.issue_id !== undefined && (
      value.version_name === undefined || value.build_version === undefined
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "issue symbolication coverage requires exact version_name and build_version",
        path: ["version_name"],
      });
    }
  });

export type ListIssuesInput = z.infer<typeof listIssuesInputSchema>;
export type GetIssueInput = z.infer<typeof getIssueInputSchema>;
export type ListEventsInput = z.infer<typeof listEventsInputSchema>;
export type GetEventInput = z.infer<typeof getEventInputSchema>;
export type GetSymbolicationStatusInput = z.infer<typeof getSymbolicationStatusInputSchema>;
