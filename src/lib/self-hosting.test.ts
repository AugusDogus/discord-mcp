import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SelfHosting } from "./self-hosting";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const directory = async () => {
  const dir = await mkdtemp(join(tmpdir(), "discord-mcp-startup-"));
  dirs.push(dir);
  return dir;
};
const source = { DISCORD_MCP_URL: "https://discord-mcp.example-tailnet.ts.net:6443" };
test("first start generates private persistent secrets, subsequent starts preserve them", async () => {
  const dir = await directory();
  expect((await SelfHosting.prepare(dir, source)).isOk()).toBe(true);
  const path = join(dir, "secrets/key-pepper");
  const original = await readFile(path, "utf8");
  expect(Buffer.from(original, "base64").length).toBe(32);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await SelfHosting.prepare(dir, source)).isOk()).toBe(true);
  expect(await readFile(path, "utf8")).toBe(original);
});
test("secret overrides take precedence without overwriting persistent files; errors never echo secrets", async () => {
  const dir = await directory();
  (await SelfHosting.prepare(dir, source)).unwrap();
  const path = join(dir, "secrets/key-pepper");
  const original = await readFile(path, "utf8");
  for (const key of ["test-invalid-key-not-real", "   "]) {
    const result = await SelfHosting.prepare(dir, { ...source, KEY_PEPPER: key });
    expect(result.isErr()).toBe(true);
    expect(JSON.stringify(result)).not.toContain("test-invalid-key-not-real");
  }
  expect(await readFile(path, "utf8")).toBe(original);
});
test("startup refuses missing origins and origins with paths or credentials", async () => {
  const dir = await directory();
  for (const url of [
    "",
    "invalid",
    "https://test.invalid/path",
    "https://user:fake@test.invalid",
    "https://test.invalid?query=1",
  ])
    expect((await SelfHosting.prepare(dir, { DISCORD_MCP_URL: url })).isErr()).toBe(true);
});
