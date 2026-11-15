import { z } from "zod";
import { LoginReport } from "./report";

const Schema = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("starting") }),
  z.object({ stage: z.literal("qr"), url: LoginReport.QrUrlSchema }),
  z.object({ stage: z.literal("scanned"), user: z.object({ name: z.string(), avatarUrl: LoginReport.AvatarUrlSchema }) }),
  z.object({ stage: z.literal("browser"), reason: z.enum(["captcha", "unknown"]) }),
  z.object({ stage: z.literal("loggedIn") }),
  z.object({ stage: z.literal("error"), message: z.string() }),
]);
export type LoginView = z.infer<typeof Schema>;
export const LoginView = { Schema } as const;
