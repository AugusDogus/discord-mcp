import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserProcess } from "./browser-process";

test("launcher copies the extension, writes a private per-browser config and wipes the profile on close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "discord-browser-test-"));
  try {
    const extensionPath = join(directory, "extension");
    const profileRoot = join(directory, "profiles");
    const chromiumPath = join(directory, "fake-chromium");
    await mkdir(extensionPath);
    await writeFile(join(extensionPath, "manifest.json"), '{"manifest_version":3}');
    // No browser and no network: a process with the same stop lifecycle.
    await writeFile(chromiumPath, "#!/bin/sh\nexec sleep 60\n");
    await chmod(chromiumPath, 0o700);
    const launch = BrowserProcess.create({ extensionPath, profileRoot, chromiumPath, stopTimeoutMs: 100 });
    const browser = (await launch("test-secret-not-real", "light")).unwrap();
    try {
      const [entry] = await readdir(profileRoot);
      expect(entry).toBeDefined();
      if (entry === undefined) return;
      const profile = join(profileRoot, entry);
      const config = join(profile, "login-extension", "config.json");
      expect(JSON.parse(await readFile(config, "utf8"))).toEqual({ secret: "test-secret-not-real" });
      expect((await stat(config)).mode & 0o777).toBe(0o600);
      expect((await stat(profile)).mode & 0o777).toBe(0o700);
      expect(await readFile(join(profile, "login-extension", "manifest.json"), "utf8")).toBe('{"manifest_version":3}');
    } finally { (await browser.close()).unwrap(); }
    expect(browser.hasExited()).toBe(true);
    expect(await readdir(profileRoot)).toEqual([]);
    expect(await readdir(extensionPath)).toEqual(["manifest.json"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a launch failure removes its private config and any profile left by a server crash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "discord-browser-test-"));
  try {
    const extensionPath = join(directory, "extension");
    const profileRoot = join(directory, "profiles");
    await mkdir(extensionPath);
    await mkdir(join(profileRoot, "stale-profile"), { recursive: true });
    const launch = BrowserProcess.create({ extensionPath, profileRoot, chromiumPath: join(directory, "missing-chromium"), stopTimeoutMs: 100 });
    const result = await launch("test-secret-not-real", "light");
    expect(result.isErr()).toBe(true);
    expect(await readdir(profileRoot)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
