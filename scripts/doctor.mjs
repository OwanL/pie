import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot, readPinnedNodeVersion, readPinnedNpmVersion, readPinnedPiVersion } from "./toolchain.mjs";
import { collectEnvironmentDiagnostics } from "./doctor-environment.mjs";
import { collectStrandedLegacySessions } from "./doctor-sessions.mjs";

const ci = process.argv.includes("--ci");
const skipModelCheck = process.argv.includes("--skip-model-check");
let failures = 0;
const ok = (message) => console.log(`  [ok] ${message}`);
const fail = (message) => { failures++; console.error(`  [FAIL] ${message}`); };
const warn = (message) => console.warn(`  [warn] ${message}`);
const info = (message) => console.log(`  [info] ${message}`);
const normalize = (value) => path.resolve(value).replaceAll("\\", "/").toLowerCase();
const run = (command, args, cwd = repoRoot) => process.platform === "win32"
  ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], { cwd, encoding: "utf8" })
  : spawnSync(command, args, { cwd, encoding: "utf8" });

console.log("pie multi-machine doctor");
const diagnostics = collectEnvironmentDiagnostics();
for (const { name, paths } of diagnostics.executables) {
  if (paths.length === 0) {
    warn(`${name}: unavailable`);
  } else if (paths.length === 1) {
    info(`${name}: ${paths[0]}`);
  } else {
    info(`${name}:`);
    for (const resolved of paths) info(`    ${resolved}`);
  }
}
const encoding = diagnostics.encoding;
if ("codePage" in encoding) {
  info(`captured output decoded as ${encoding.capturedOutputDecoding}; cmd code page ${encoding.codePage}`);
} else {
  info(`captured output decoded as ${encoding.capturedOutputDecoding}; LANG/LC_ALL ${encoding.locale}`);
}
for (const message of diagnostics.pathWarnings) warn(message);

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
for (const relative of [".", "extension", "analysis"]) {
  const result = run("npm", ["ls", "--depth=0", "--include=dev"], path.join(repoRoot, relative));
  result.status === 0
    ? ok(`${relative === "." ? "root" : relative} dependencies installed`)
    : fail(`${relative === "." ? "root" : relative} dependencies incomplete; run npm ci at the repo root`);
}

const settings = JSON.parse(fs.readFileSync(path.join(repoRoot, "settings.json"), "utf8"));
settings.sessionDir === "data/outcomes/sessions" ? ok("sessions are configured as checkout-local runtime data") : fail("settings.sessionDir must be data/outcomes/sessions");
const ignore = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
ignore.includes("/data/") && ignore.includes("auth.json") ? ok("auth and runtime data are git-ignored") : fail(".gitignore must exclude auth.json and /data/");

// The runtime lists sessions from the canonical store only; legacy roots are
// no longer scanned. Detect sessions stranded in a legacy root without a
// canonical counterpart so the user can re-run the installer to migrate them
// (no silent loss) instead of the app scanning legacy roots forever.
const stranded = collectStrandedLegacySessions({ repoRoot });
if (stranded.totalStranded > 0) {
  warn(`${stranded.totalStranded} legacy session(s) stranded outside the canonical store (${stranded.canonical}):`);
  for (const entry of stranded.roots) {
    if (entry.stranded > 0) warn(`  ${entry.stranded} of ${entry.total} in ${entry.root}`);
  }
  warn(`  Re-run the installer (./install.sh or .\\install.bat) to migrate them into the canonical store.`);
} else {
  ok("no legacy sessions stranded outside the canonical store");
}

const inTreeAuth = path.join(repoRoot, "auth.json");
if (!fs.existsSync(inTreeAuth)) ok("no credentials in working tree");
else {
  let hasCredentials = true;
  try { hasCredentials = Object.keys(JSON.parse(fs.readFileSync(inTreeAuth, "utf8"))).length > 0; } catch {}
  if (hasCredentials) fail("split-brain credential file exists at repo root");
  else warn("empty auth.json exists at repo root; remove it after fully restarting VS Code");
}

if (skipModelCheck) {
  ok("generated model configuration was checked by the caller");
} else {
  const modelCheck = run(process.execPath, ["scripts/sync-models.mjs", "--check"]);
  modelCheck.status === 0 ? ok("generated model configuration is in sync") : fail(`model configuration drift: ${(modelCheck.stderr || modelCheck.stdout).trim()}`);
}

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
