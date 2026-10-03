import fs from "node:fs";
import path from "node:path";
import { repoRoot, readPinnedNodeVersion, readPinnedNpmVersion, readPinnedPiSourceVersion } from "../install/toolchain.mjs";
import { collectEnvironmentDiagnostics } from "./doctor-environment.mjs";
import { collectStrandedLegacySessions } from "./doctor-sessions.mjs";
import { collectPostMigrationOutcomeDrift } from "./doctor-outcomes.mjs";
import { spawnCliSync } from "../lib/subprocess.mjs";
import { collectPiRuntimeArtifactRoute, parsePiRuntimeRoute, resolvePiRuntimeRoute } from "./doctor-pi-runtime.mjs";
import { inspectManagedPackages, managedPackagePinsReady } from "../install/lib/managed-packages.mjs";
import { resolvePieDataPaths } from "../../lib/data-root/pie-data-root-core.mjs";

const ci = process.argv.includes("--ci");
const skipModelCheck = process.argv.includes("--skip-model-check");
// Runtime checks use the checkout's built artifact by default; an explicit
// --pi-runtime path overrides it and is never a fallback target.
const piRuntimeRoute = resolvePiRuntimeRoute(parsePiRuntimeRoute(process.argv), repoRoot);
let failures = 0;
const ok = (message) => console.log(`  [ok] ${message}`);
const fail = (message) => { failures++; console.error(`  [FAIL] ${message}`); };
const warn = (message) => console.warn(`  [warn] ${message}`);
const info = (message) => console.log(`  [info] ${message}`);
const normalize = (value) => path.resolve(value).replaceAll("\\", "/").toLowerCase();
const run = (command, args, cwd = repoRoot) => spawnCliSync(command, args, { cwd, encoding: "utf8" });

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
const pinnedPiSourceVersion = readPinnedPiSourceVersion();
process.versions.node === pinnedNode ? ok(`Node ${pinnedNode}`) : fail(`Node ${process.versions.node}; expected ${pinnedNode}`);
const npm = run("npm", ["--version"]);
const actualNpm = npm.stdout?.trim() ?? "";
npm.status === 0 && actualNpm === pinnedNpm ? ok(`npm ${pinnedNpm}`) : fail(`npm ${actualNpm || "unavailable"}; expected ${pinnedNpm}`);

for (const relative of ["package-lock.json", "application/hosts/vscode/package-lock.json", "analytics/analysis/package-lock.json"]) {
  fs.existsSync(path.join(repoRoot, relative)) ? ok(`${relative} present`) : fail(`${relative} missing`);
}
for (const relative of [".", "application/hosts/vscode", "analytics/analysis"]) {
  const result = run("npm", ["ls", "--depth=0", "--include=dev"], path.join(repoRoot, relative));
  result.status === 0
    ? ok(`${relative === "." ? "root" : relative} dependencies installed`)
    : fail(`${relative === "." ? "root" : relative} dependencies incomplete; run npm ci at the repo root`);
}

const settings = JSON.parse(fs.readFileSync(path.join(repoRoot, "settings.json"), "utf8"));
if (!managedPackagePinsReady(settings)) {
  fail("settings.json must pin pi-web-access@0.27.0 and pi-mcp-adapter@2.20.1");
}
const managedAgentDir = process.env.PI_CODING_AGENT_DIR?.trim() || repoRoot;
let managedCacheDir;
try {
  managedCacheDir = resolvePieDataPaths({
    dataDir: process.env.PIE_DATA_DIR,
    agentDir: managedAgentDir,
    environment: process.env,
  }).cacheDir;
} catch (error) {
  fail(`canonical Pie cache root is unresolved: ${error instanceof Error ? error.message : String(error)}`);
}
for (const result of inspectManagedPackages({ agentDir: managedAgentDir, cacheDir: managedCacheDir })) {
  if (result.status === "ready") {
    ok(`${result.name}@${result.expectedVersion} managed package ready (${result.sourceFingerprint}; ${result.cacheTargets.join(", ")})`);
  } else {
    fail(`${result.name}: ${result.detail} Intended cache target: ${result.cacheTargets.join(", ")}. ${result.remediation}`);
  }
}
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
  warn(`  Re-run .\\install.bat to migrate them into the canonical store.`);
} else {
  ok("no legacy sessions stranded outside the canonical store");
}

// A backend launched before storage migration keeps its old process environment
// until VS Code reloads. Detect retained sessions and completed runs written
// after the merge so they cannot silently remain split across authorities.
const outcomesRoot = path.join(repoRoot, "data", "outcomes");
const outcomeDrift = collectPostMigrationOutcomeDrift({ canonicalOutcomesRoot: outcomesRoot });
if (outcomeDrift.changedFileCount > 0) {
  warn(`${outcomeDrift.changedFileCount} displaced outcomes file(s) changed after their last migration:`);
  for (const source of outcomeDrift.sources.filter((entry) => entry.changedFiles.length > 0)) {
    warn(`  ${source.changedFiles.length} file(s) under ${source.sourceRoot}`);
    warn(`  Reconcile with: node scripts/migrations/migrate-outcomes-store.mjs --source "${source.sourceRoot}" --dest "${outcomesRoot}"`);
  }
} else {
  ok("no post-migration outcomes stranded outside the canonical store");
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
  const modelCheck = run(process.execPath, ["scripts/model-config/sync-models.mjs", "--check"]);
  modelCheck.status === 0 ? ok("generated model configuration is in sync") : fail(`model configuration drift: ${(modelCheck.stderr || modelCheck.stdout).trim()}`);
}

if (piRuntimeRoute.usageError) {
  fail(`pi runtime artifact route rejected: ${piRuntimeRoute.usageError}`);
} else if (ci && !piRuntimeRoute.explicit) {
  ok(`CI skipped the implicit checkout pi runtime artifact check; pass --pi-runtime <absolute artifact root> to verify one explicitly`);
} else {
  // Read-only full-payload verification bound to this Node process; the
  // artifact and its manifest are never rebuilt, extended or executed here.
  const route = await collectPiRuntimeArtifactRoute({ artifactDir: piRuntimeRoute.artifactDir });
  if (route.status === "ready") {
    const targetSummary = `${route.target.platform}/${route.target.arch}/modules ${route.target.nodeAbi}`;
    if (route.version !== pinnedPiSourceVersion) {
      fail(`pi runtime artifact version ${route.version}; expected pinned Pi source version ${pinnedPiSourceVersion}`);
    } else {
      ok(`pi runtime artifact ${route.version} (upstream ${route.upstreamVersion}) verified read-only for Node ${targetSummary}; identity ${route.identity}`);
      ok(piRuntimeRoute.explicit
        ? "explicit pi-runtime artifact route; no global pi CLI lookup or fallback"
        : `checkout-built pi runtime artifact selected (${route.artifactDir}); no global pi CLI lookup or fallback`);
    }
  } else if (!piRuntimeRoute.explicit) {
    fail(`checkout pi runtime artifact at ${piRuntimeRoute.artifactDir} could not be verified read-only: ${route.detail}. Build the checkout's VS Code application under normal safe conditions, or pass --pi-runtime <absolute artifact root>.`);
  } else {
    fail(`explicit pi runtime artifact failed read-only verification for the executing Node target: ${route.detail}`);
  }
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
} else {
  ok(`CI skipped machine-local env/auth checks; pinned Pi source version is ${pinnedPiSourceVersion}`);
}

if (failures) {
  console.error(`\nDoctor found ${failures} blocking issue(s).`);
  process.exit(1);
}
console.log("\nDoctor passed.");
