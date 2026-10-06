#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnCliSync } from "../lib/subprocess.mjs";
import { withDevelopmentWriter } from "../../lib/development-runtime/lifetime.mjs";
import { repoRoot } from "./toolchain.mjs";

/** The one repository-wide dependency setup; workspaces share the root lockfile. */
export function buildRootInstallStep(root = repoRoot) {
  return {
    command: "proto",
    args: ["run", "pnpm", "--", "install", "--frozen-lockfile", "--ignore-scripts"],
    cwd: root,
  };
}

/** Run the shared setup with an injectable process boundary for fixture tests. */
export async function runRootInstall({ root = repoRoot, spawn = spawnCliSync, stdio = "inherit" } = {}) {
  const step = buildRootInstallStep(root);
  const workspace = path.join(root, "harness", "pi");
  return withDevelopmentWriter(workspace, () => {
    console.log(`\n==> ${step.command} ${step.args.join(" ")}`);
    const result = spawn(step.command, step.args, { cwd: step.cwd, stdio });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const error = new Error(`proto ${step.args.join(" ")} failed with exit code ${result.status ?? 1}`);
      error.exitCode = result.status ?? 1;
      throw error;
    }
    return step;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRootInstall().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = typeof error?.exitCode === "number" ? error.exitCode : 1;
  });
}
