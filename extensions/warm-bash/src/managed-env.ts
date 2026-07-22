import { delimiter } from "node:path";
import { pathKey } from "./resolve.js";

/**
 * Derive pi's authoritative managed shell environment: a copy of `env` with
 * `binDir` prepended to the platform PATH key. This mirrors pi's internal
 * `getShellEnv()`, which puts `getAgentDir()/bin` first so managed SDK
 * binaries (rg, fd) resolve ahead of anything on the inherited PATH.
 *
 * Pure / pi-package-free so it is unit-testable; `index.ts` supplies the real
 * `binDir` via `join(getAgentDir(), "bin")` (the only line that needs the pi
 * package, kept out of the testable core).
 *
 * If `binDir` is already on PATH the env is returned unchanged (idempotent),
 * preserving the caller's PATH exactly — never worse than the input.
 */
export function prependManagedBinDir(env: NodeJS.ProcessEnv, binDir: string): NodeJS.ProcessEnv {
  const key = pathKey(env);
  const current = env[key] ?? "";
  const entries = current.split(delimiter).filter(Boolean);
  if (entries.includes(binDir)) return { ...env };
  const updated = [binDir, current].filter(Boolean).join(delimiter);
  return { ...env, [key]: updated };
}
