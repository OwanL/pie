import fs from "node:fs";
import path from "node:path";
import { repoRoot, readPinnedNodeVersion, readPinnedNpmVersion, readPinnedPiVersion } from "./toolchain.mjs";
import { readConfiguredPackageSources } from "./install/lib/packages.mjs";
import { spawnCliSync } from "./lib/subprocess.mjs";

const spawn = (command, args, options) => spawnCliSync(command, args, options);
const run = (command, args, cwd = repoRoot) => {
  console.log(`\n==> ${command} ${args.join(" ")}`);
  const result = spawn(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const nodeVersion = readPinnedNodeVersion();
const npmVersion = readPinnedNpmVersion();
const piVersion = readPinnedPiVersion();
const normalizedRoot = path.resolve(repoRoot).toLowerCase();
const authDir = process.env.PI_CODING_AGENT_AUTH_DIR;
const normalizedAuthDir = authDir ? path.resolve(authDir).toLowerCase() : "";
if (!authDir || normalizedAuthDir === normalizedRoot || normalizedAuthDir.startsWith(`${normalizedRoot}${path.sep}`)) {
  throw new Error("Run the OS installer first: PI_CODING_AGENT_AUTH_DIR must point outside the Git checkout");
}
const inTreeAuth = path.join(repoRoot, "auth.json");
if (fs.existsSync(inTreeAuth)) {
  let hasCredentials = true;
  try { hasCredentials = Object.keys(JSON.parse(fs.readFileSync(inTreeAuth, "utf8"))).length > 0; } catch {}
  if (hasCredentials) throw new Error("Refusing to bootstrap with credentials in the working tree; re-run the OS installer");
}
if (process.versions.node !== nodeVersion) throw new Error(`Node ${nodeVersion} required; found ${process.versions.node}`);
const npm = spawn("npm", ["--version"], { encoding: "utf8" });
if (npm.stdout.trim() !== npmVersion) throw new Error(`npm ${npmVersion} required; found ${npm.stdout.trim() || "unavailable"}`);

// Root npm ci runs the postinstall hook, which installs the locked extension
// and analysis dependency trees (including build/test devDependencies).
run("npm", ["ci", "--include=dev"]);
run("npm", ["install", "-g", `@earendil-works/pi-coding-agent@${piVersion}`]);
for (const source of readConfiguredPackageSources(path.join(repoRoot, "settings.json"))) {
  run("pi", ["install", source]);
}
run(process.execPath, ["scripts/sync-models.mjs", "--check"]);
run("npm", ["run", "build"], `${repoRoot}/extension`);
run(process.execPath, ["scripts/doctor.mjs", "--skip-model-check"]);
