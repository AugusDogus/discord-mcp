import * as z from "zod/v4";

export const snowflake = z.string().regex(/^\d+$/).describe("Discord snowflake ID");
export const confirm = z.boolean().describe("Must be true after reviewing the target and consequences");

export const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export const destructiveAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;
