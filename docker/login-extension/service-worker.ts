import { z } from "zod";
import { LoginReport } from "../../src/lib/login-browser/report";
import { LoginParsing } from "./parsing";

const ConfigSchema = z.object({ secret: z.string().regex(/^[a-f0-9]{64}$/) });
let tokenSubmitted = false;

const forward = async (value: LoginReport): Promise<boolean> => {
  if (tokenSubmitted) return false;
  const response = await fetch(chrome.runtime.getURL("config.json"));
  const config = ConfigSchema.safeParse(await response.json());
  if (!config.success) return false;
  if (value.kind === "token") tokenSubmitted = true;
  const reported = await fetch("http://127.0.0.1:3100/api/internal/login-report", {
    method: "POST",
    headers: { "content-type": "application/json", "x-login-secret": config.data.secret },
    body: JSON.stringify(value),
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  return reported.ok;
};

chrome.runtime.onMessage.addListener((value: unknown, sender, sendResponse) => {
  if (!LoginParsing.isSender(sender.id, chrome.runtime.id, sender.frameId, sender.url) || sender.tab?.id === undefined) return false;
  const parsed = LoginReport.Schema.safeParse(value);
  if (!parsed.success) return false;
  void forward(parsed.data).then((ok) => sendResponse({ ok })).catch(() => sendResponse({ ok: false }));
  return true;
});
