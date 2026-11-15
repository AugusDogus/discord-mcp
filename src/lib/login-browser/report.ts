import { z } from "zod";

const QrUrlSchema = z.string().max(512).regex(/^https:\/\/discord\.com\/ra\/[A-Za-z0-9_-]+$/);
const AvatarUrlSchema = z.url().max(2048).refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.hostname === "cdn.discordapp.com" && url.port === "" && url.username === "" && url.password === "";
});

const Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("qr"), url: QrUrlSchema }),
  z.object({ kind: z.literal("scanned"), name: z.string().trim().min(1).max(128), avatarUrl: AvatarUrlSchema }),
  z.object({ kind: z.enum(["captcha", "unknown"]) }),
  z.object({ kind: z.literal("token"), token: z.string().min(1).max(4096).regex(/^\S+$/) }),
]);

export type LoginReport = z.infer<typeof Schema>;
export const LoginReport = { Schema, QrUrlSchema, AvatarUrlSchema } as const;
