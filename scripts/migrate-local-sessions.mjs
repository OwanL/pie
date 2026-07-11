import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { repoRoot } from "./toolchain.mjs";

const destination = path.join(repoRoot, "data", "outcomes", "sessions");
const sources = [path.join(os.homedir(), ".pi", "agent", "sessions"), path.join(repoRoot, "data", "sessions")];
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const filesUnder = (root) => {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
};
const sessionInfo = (file) => {
  let cwd;
  let latest = fs.statSync(file).mtimeMs;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value.type === "session" && value.cwd) cwd = value.cwd;
      if (value.timestamp) latest = Math.max(latest, Date.parse(value.timestamp) || 0);
    } catch { /* malformed legacy lines do not block migration */ }
  }
  return { bucket: cwd ? `--${cwd.replace(/^[\\/]+/, "").replace(/[\\/:]/g, "-")}--` : "--unknown--", latest };
};

let copied = 0, updated = 0, identical = 0, conflicts = 0;
for (const sourceRoot of sources) {
  if (path.resolve(sourceRoot) === path.resolve(destination)) continue;
  for (const source of filesUnder(sourceRoot)) {
    const sourceInfo = sessionInfo(source);
    const targetDir = path.join(destination, sourceInfo.bucket);
    const target = path.join(targetDir, path.basename(source));
    fs.mkdirSync(targetDir, { recursive: true });
    if (!fs.existsSync(target)) { fs.copyFileSync(source, target); copied++; continue; }
    if (hash(source) === hash(target)) { identical++; continue; }
    const targetInfo = sessionInfo(target);
    const suffix = crypto.randomUUID().replaceAll("-", "");
    if (sourceInfo.latest > targetInfo.latest) {
      fs.copyFileSync(target, `${target}.conflict.${suffix}.bak`);
      fs.copyFileSync(source, target);
      updated++;
    } else {
      fs.copyFileSync(source, `${target}.conflict.${suffix}.incoming.bak`);
    }
    conflicts++;
  }
}
console.log(`Session migration: ${copied} copied, ${updated} refreshed, ${identical} identical, ${conflicts} conflict backup(s).`);
