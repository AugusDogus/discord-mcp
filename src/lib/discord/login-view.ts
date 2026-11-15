import { z } from "zod";

export const LoginViewSchema = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("starting") }),
  z.object({ stage: z.literal("qr"), url: z.url(), expiresAt: z.number() }),
  z.object({
    stage: z.literal("scanned"),
    user: z.object({ name: z.string(), handle: z.string(), avatarUrl: z.url() }),
  }),
  z.object({ stage: z.literal("loggedIn") }),
  z.object({ stage: z.literal("error"), message: z.string() }),
]);
export type LoginView = z.infer<typeof LoginViewSchema>;
