import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPinnedPiSourceVersion as readSourceVersion } from "../lib/sdk-version.mjs";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readProtoPin(name, root) {
  const config = fs.readFileSync(path.join(root, ".prototools"), "utf8");
  const match = new RegExp(`^\\s*${name}\\s*=\\s*"([^"]+)"\\s*$`, "m").exec(config);
  if (!match) throw new Error(`.prototools must declare an exact ${name} version`);
  return match[1];
}

export function readPinnedNodeVersion(root = repoRoot) {
  const protoVersion = readProtoPin("node", root);
  const nodeVersion = fs.readFileSync(path.join(root, ".node-version"), "utf8").trim().replace(/^v/, "");
  if (nodeVersion !== protoVersion) {
    throw new Error(`.node-version (${nodeVersion}) must match the Proto Node pin (${protoVersion})`);
  }
  return protoVersion;
}

export function readPinnedPnpmVersion(root = repoRoot) {
  const protoVersion = readProtoPin("pnpm", root);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const match = /^pnpm@(.+)$/.exec(pkg.packageManager ?? "");
  if (!match) throw new Error("package.json must declare an exact pnpm packageManager");
  if (match[1] !== protoVersion) {
    throw new Error(`packageManager (${match[1]}) must match the Proto pnpm pin (${protoVersion})`);
  }
  return protoVersion;
}

export function readPinnedPiSourceVersion(root = repoRoot) {
  return readSourceVersion(root);
}
