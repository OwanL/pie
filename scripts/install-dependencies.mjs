import { spawnSync } from "node:child_process";
import { repoRoot } from "./toolchain.mjs";

const npmInvocation = (args, cwd, stdio) => {
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
  const commandArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm", ...args]
    : args;
  return spawnSync(command, commandArgs, { cwd, stdio });
};

for (const directory of ["extension", "analysis"]) {
  const cwd = `${repoRoot}/${directory}`;
  const installed = npmInvocation(["ls", "--depth=0", "--include=dev"], cwd, "ignore");
  if (installed.status === 0) {
    console.log(`==> ${directory}/ dependencies already satisfy the package manifest`);
    continue;
  }
  console.log(`\n==> Installing locked dependencies in ${directory}/`);
  // npm install uses the committed lockfile while repairing an incomplete tree;
  // unlike npm ci it does not destructively replace a VS Code-locked esbuild binary.
  const result = npmInvocation(["install", "--include=dev"], cwd, "inherit");
  if (result.status !== 0) process.exit(result.status ?? 1);
}
