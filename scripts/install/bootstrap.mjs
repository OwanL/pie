import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, readPinnedNodeVersion, readPinnedNpmVersion } from "./toolchain.mjs";
import { readConfiguredPackageSources } from "./lib/packages.mjs";
import { spawnCliSync } from "../lib/subprocess.mjs";
import { withPiRuntime } from "../lib/pi-runtime-context.mjs";
import { createSourcePiCli } from "./lib/source-pi-cli.mjs";
import { validateAuthDirectory } from "./lib/auth-directory.mjs";

const rootNpmCiStep = (root) => ({ command: "npm", args: ["ci", "--include=dev"], cwd: root });

class BootstrapCommandError extends Error {
  constructor(command, args, status) {
    super(`${command} ${args.join(" ")} failed with exit code ${status}`);
    this.name = "BootstrapCommandError";
    this.exitCode = status;
  }
}

function runSync(step, spawn) {
  console.log(`\n==> ${step.command} ${step.args.join(" ")}`);
  const result = spawn(step.command, step.args, { cwd: step.cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new BootstrapCommandError(step.command, step.args, result.status ?? 1);
}

function runSourcePiCli(cli, step, onChildCompletionKnown) {
  console.log(`\n==> verified source Pi CLI ${step.args.join(" ")}`);
  const child = cli.run(step.args, { cwd: step.cwd, stdio: "inherit" });
  return new Promise((resolve, reject) => {
    let spawnError;
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => {
      onChildCompletionKnown();
      if (spawnError) reject(spawnError);
      else if (code !== 0) {
        const status = code ?? 1;
        reject(new BootstrapCommandError("verified source Pi CLI", step.args, status));
      } else if (signal) {
        reject(new Error(`verified source Pi CLI ${step.args.join(" ")} terminated with signal ${signal}`));
      } else resolve();
    });
  });
}

export function parseBootstrapArgs(args) {
  let artifactDir;
  let packageExtension = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--package") {
      packageExtension = true;
      continue;
    }
    if (arg !== "--pi-runtime" && !arg.startsWith("--pi-runtime=")) {
      throw new Error(`Unknown bootstrap option: ${arg}`);
    }
    if (artifactDir !== undefined) throw new Error("--pi-runtime may be specified only once.");
    const value = arg === "--pi-runtime" ? args[++index] : arg.slice("--pi-runtime=".length);
    if (!value || value.startsWith("--")) throw new Error("--pi-runtime requires an artifact path.");
    if (!path.isAbsolute(value)) throw new Error("--pi-runtime requires an absolute artifact root.");
    artifactDir = value;
  }
  return { artifactDir, package: packageExtension };
}

/**
 * Pure description of the post-root-ci bootstrap steps. It neither acquires nor
 * installs a runtime; callers supply the already selected artifact explicitly.
 */
export function buildCommandPlan({
  root = repoRoot,
  nodeExecutable = process.execPath,
  artifactDir,
  packageSources = readConfiguredPackageSources(path.join(root, "settings.json")),
  package: packageExtension = false,
} = {}) {
  if (typeof artifactDir !== "string" || !path.isAbsolute(artifactDir)) {
    throw new TypeError("buildCommandPlan requires an absolute verified Pi runtime artifact directory");
  }
  const hostRoot = path.join(root, "application", "hosts", "vscode");
  return [
    rootNpmCiStep(root),
    ...packageSources.map((source) => ({ operation: "source-pi-cli", args: ["install", source], cwd: root })),
    { command: nodeExecutable, args: ["scripts/model-config/sync-models.mjs", "--check"], cwd: root },
    {
      command: "npm",
      args: ["run", "build", "--", "--pi-runtime", artifactDir],
      cwd: hostRoot,
    },
    ...(packageExtension ? [{
      command: nodeExecutable,
      args: ["node_modules/@vscode/vsce/vsce", "package", "--no-dependencies", "--allow-missing-repository", "--skip-license"],
      cwd: hostRoot,
    }] : []),
    { command: nodeExecutable, args: ["scripts/diagnostics/doctor.mjs", "--skip-model-check", "--pi-runtime", artifactDir], cwd: root },
  ];
}

/** Run bootstrap with injectable boundaries for fixture-only lifecycle tests. */
export async function runBootstrap({
  root = repoRoot,
  nodeExecutable = process.execPath,
  artifactDir,
  packageSources = readConfiguredPackageSources(path.join(root, "settings.json")),
  package: packageExtension = false,
  spawn = spawnCliSync,
  acquireRuntime = withPiRuntime,
  createPiCli = createSourcePiCli,
  runtimeTarget = { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules },
} = {}) {
  // Root npm ci owns the root/host dependency setup and must finish before any
  // private Pi runtime is built or reused.
  runSync(rootNpmCiStep(root), spawn);

  return acquireRuntime({ artifactDir }, async (context) => {
    let childCompletionKnown = true;
    try {
      const piCli = await createPiCli({
        artifactDir: context.artifactDir,
        nodeExecutable,
        target: runtimeTarget,
      });
      const plan = buildCommandPlan({
        root, nodeExecutable, artifactDir: context.artifactDir, packageSources, package: packageExtension,
      });
      for (const step of plan.slice(1)) {
        if (step.operation === "source-pi-cli") {
          // Do not confirm teardown if the launcher fails before a close event
          // proves that the child is gone.
          childCompletionKnown = false;
          await runSourcePiCli(piCli, step, () => { childCompletionKnown = true; });
        } else {
          runSync(step, spawn);
        }
      }
    } finally {
      if (childCompletionKnown) context.confirmChildCompletion();
    }
  });
}

function validateBootstrapEnvironment() {
  const nodeVersion = readPinnedNodeVersion();
  const npmVersion = readPinnedNpmVersion();
  const authDir = process.env.PI_CODING_AGENT_AUTH_DIR;
  const authDirValidation = validateAuthDirectory({ repoRoot, authDir });
  if (!authDirValidation.valid) {
    throw new Error(`Run .\\install.bat first: PI_CODING_AGENT_AUTH_DIR ${authDirValidation.reason}`);
  }
  const inTreeAuth = path.join(repoRoot, "auth.json");
  if (fs.existsSync(inTreeAuth)) {
    let hasCredentials = true;
    try { hasCredentials = Object.keys(JSON.parse(fs.readFileSync(inTreeAuth, "utf8"))).length > 0; } catch {}
    if (hasCredentials) throw new Error("Refusing to bootstrap with credentials in the working tree; re-run .\\install.bat");
  }
  if (process.versions.node !== nodeVersion) throw new Error(`Node ${nodeVersion} required; found ${process.versions.node}`);
  const npm = spawnCliSync("npm", ["--version"], { encoding: "utf8" });
  if (npm.stdout.trim() !== npmVersion) throw new Error(`npm ${npmVersion} required; found ${npm.stdout.trim() || "unavailable"}`);
}

async function main() {
  validateBootstrapEnvironment();
  const { artifactDir, package: packageExtension } = parseBootstrapArgs(process.argv.slice(2));
  await runBootstrap({ artifactDir, package: packageExtension });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (!(error instanceof BootstrapCommandError)) console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof BootstrapCommandError ? error.exitCode : 1;
  });
}
