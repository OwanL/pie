import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, readPinnedNodeVersion, readPinnedNpmVersion, readPinnedPiVersion } from "./toolchain.mjs";
import { readConfiguredPackageSources } from "./lib/packages.mjs";
import { spawnCliSync } from "../lib/subprocess.mjs";

const spawn = (command, args, options) => spawnCliSync(command, args, options);
const run = (command, args, cwd = repoRoot) => {
  console.log(`\n==> ${command} ${args.join(" ")}`);
  const result = spawn(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

export function buildCommandPlan({
  root = repoRoot,
  nodeExecutable = process.execPath,
  piVersion = readPinnedPiVersion(),
  packageSources = readConfiguredPackageSources(path.join(root, "settings.json")),
} = {}) {
  return [
    { command: "npm", args: ["ci", "--include=dev"], cwd: root },
    { command: "npm", args: ["install", "-g", `@earendil-works/pi-coding-agent@${piVersion}`], cwd: root },
    ...packageSources.map((source) => ({ command: "pi", args: ["install", source], cwd: root })),
    { command: nodeExecutable, args: ["scripts/model-config/sync-models.mjs", "--check"], cwd: root },
    { command: "npm", args: ["run", "build"], cwd: path.join(root, "application", "hosts", "vscode") },
    { command: nodeExecutable, args: ["scripts/diagnostics/doctor.mjs", "--skip-model-check"], cwd: root },
  ];
}

function main() {
  const nodeVersion = readPinnedNodeVersion();
  const npmVersion = readPinnedNpmVersion();
  const authDir = process.env.PI_CODING_AGENT_AUTH_DIR;
  const normalizedRoot = path.resolve(repoRoot).toLowerCase();
  const normalizedAuthDir = authDir ? path.resolve(authDir).toLowerCase() : "";
  if (!authDir || normalizedAuthDir === normalizedRoot || normalizedAuthDir.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error("Run .\\install.bat first: PI_CODING_AGENT_AUTH_DIR must point outside the Git checkout");
  }
  const inTreeAuth = path.join(repoRoot, "auth.json");
  if (fs.existsSync(inTreeAuth)) {
    let hasCredentials = true;
    try { hasCredentials = Object.keys(JSON.parse(fs.readFileSync(inTreeAuth, "utf8"))).length > 0; } catch {}
    if (hasCredentials) throw new Error("Refusing to bootstrap with credentials in the working tree; re-run .\\install.bat");
  }
  if (process.versions.node !== nodeVersion) throw new Error(`Node ${nodeVersion} required; found ${process.versions.node}`);
  const npm = spawn("npm", ["--version"], { encoding: "utf8" });
  if (npm.stdout.trim() !== npmVersion) throw new Error(`npm ${npmVersion} required; found ${npm.stdout.trim() || "unavailable"}`);

  // Root npm ci runs the postinstall hook, which installs the locked VS Code host
  // and retained analytics-analysis dependency trees (including build/test devDependencies).
  for (const step of buildCommandPlan()) run(step.command, step.args, step.cwd);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
