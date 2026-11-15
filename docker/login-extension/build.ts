import { mkdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = process.argv[2];
if (output === undefined) throw new Error("Pass the output directory for the bundled login extension.");
const directory = resolve(output);
await mkdir(directory, { recursive: true });
for (const entry of ["content", "service-worker"]) {
  const built = await Bun.build({ entrypoints: [resolve(import.meta.dir, `${entry}.ts`)], outdir: directory, target: "browser", format: "iife", minify: true });
  if (!built.success) throw new Error(`Could not bundle login extension ${entry}.`);
}
await copyFile(resolve(import.meta.dir, "manifest.json"), resolve(directory, "manifest.json"));
// config.json is intentionally absent here. The server creates it per launch
// inside a private copy in the RAM profile. No secret is baked into the image.
