import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot, readPinnedNodeVersion, readPinnedNpmVersion, readPinnedPiVersion } from "./toolchain.mjs";

const ci = process.argv.includes("--ci");
let failures = 0;
const ok = (message) => console.log(`  [ok] ${message}`);
const fail = (message) => { failures++; console.error(`  [FAIL] ${message}`); };
const warn = (message) => console.warn(`  [warn] ${message}`);
const normalize = (value) => path.resolve(value).replaceAll("\\", "/").toLowerCase();
const run = (command, args) => process.platform === "win32"
  ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], { cwd: repoRoot, encoding: "utf8" })
  : spawnSync(command, args, { cwd: repoRoot, encoding: "utf8" });

console.log("pie multi-machine doctor");
const pinnedNode = readPinnedNodeVersion();
const pinnedNpm = readPinnedNpmVersion();
const pinnedPi = readPinnedPiVersion();
process.versions.node === pinnedNode ? ok(`Node ${pinnedNode}`) : fail(`Node ${process.versions.node}; expected ${pinnedNode}`);
const npm = run("npm", ["--version"]);
const actualNpm = npm.stdout?.trim() ?? "";
npm.status === 0 && actualNpm === pinnedNpm ? ok(`npm ${pinnedNpm}`) : fail(`npm ${actualNpm || "unavailable"}; expected ${pinnedNpm}`);

for (const relative of ["package-lock.json", "extension/package-lock.json", "analysis/package-lock.json"]) {
  fs.existsSync(path.join(repoRoot, relative)) ? ok(`${relative} present`) : fail(`${relative} missing`);
}

const settings = JSON.parse(fs.readFileSync(path.join(repoRoot, "settings.json"), "utf8"));
settings.sessionDir === "data/outcomes/sessions" ? ok("sessions are configured as checkout-local runtime data") : fail("settings.sessionDir must be data/outcomes/sessions");
const ignore = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
ignore.includes("/data/") && ignore.includes("auth.json") ? ok("auth and runtime data are git-ignored") : fail(".gitignore must exclude auth.json and /data/");
const inTreeAuth = path.join(repoRoot, "auth.json");
if (!fs.existsSync(inTreeAuth)) ok("no credentials in working tree");
else {
  let hasCredentials = true;
  try { hasCredentials = Object.keys(JSON.parse(fs.readFileSync(inTreeAuth, "utf8"))).length > 0; } catch {}
  if (hasCredentials) fail("split-brain credential file exists at repo root");
  else warn("empty auth.json exists at repo root; remove it after fully restarting VS Code");
}

const modelCheck = run(process.execPath, ["scripts/sync-models.mjs", "--check"]);
modelCheck.status === 0 ? ok("generated model configuration is in sync") : fail(`model configuration drift: ${(modelCheck.stderr || modelCheck.stdout).trim()}`);

if (!ci) {
  const expectedAgent = normalize(repoRoot);
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  agentDir && normalize(agentDir) === expectedAgent ? ok("PI_CODING_AGENT_DIR targets this checkout") : warn("PI_CODING_AGENT_DIR does not target this checkout; re-run the installer in a fresh shell");
  const expectedSessions = normalize(path.join(repoRoot, "data/outcomes/sessions"));
  const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  sessionDir && normalize(sessionDir) === expectedSessions ? ok("PI_CODING_AGENT_SESSION_DIR targets this machine-local store") : warn("PI_CODING_AGENT_SESSION_DIR is unset or targets another checkout");
  const authDir = process.env.PI_CODING_AGENT_AUTH_DIR;
  if (!authDir) warn("PI_CODING_AGENT_AUTH_DIR is unset");
  else if (normalize(authDir) === expectedAgent || normalize(authDir).startsWith(`${expectedAgent}/`)) fail("PI_CODING_AGENT_AUTH_DIR must be outside the Git checkout");
  else ok("PI_CODING_AGENT_AUTH_DIR is outside the checkout");

  const npmRoot = run("npm", ["root", "-g"]);
  const globalPiManifest = npmRoot.status === 0
    ? path.join(npmRoot.stdout.trim(), "@earendil-works", "pi-coding-agent", "package.json")
    : "";
  let installedPi = "";
  try { installedPi = JSON.parse(fs.readFileSync(globalPiManifest, "utf8")).version; } catch {}
  installedPi === pinnedPi ? ok(`pi CLI ${pinnedPi}`) : fail(`pi CLI ${installedPi || "unavailable"}; expected ${pinnedPi}`);
} else {
  ok(`CI skipped machine-local env/auth checks; pinned pi SDK is ${pinnedPi}`);
}

if (failures) {
  console.error(`\nDoctor found ${failures} blocking issue(s).`);
  process.exit(1);
}
console.log("\nDoctor passed.");
