import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPinnedSdkVersion } from "./lib/sdk-version.mjs";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function readPinnedNodeVersion() {
  return fs.readFileSync(path.join(repoRoot, ".node-version"), "utf8").trim().replace(/^v/, "");
}

export function readPinnedNpmVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const match = /^npm@(.+)$/.exec(pkg.packageManager ?? "");
  if (!match) throw new Error("package.json must declare an exact npm packageManager");
  return match[1];
}

export function readPinnedPiVersion() {
  return readPinnedSdkVersion(repoRoot);
}
