import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Resolve a program name to an executable path.
 *
 * On Windows, `child_process.spawn(prog, args, { shell: false })` does NOT
 * resolve `.cmd` / `.bat` shims (so `npm`, `npx`, `yarn` would ENOENT). This
 * scans PATH for the program with platform-appropriate extensions so those
 * shims fast-path correctly.
 *
 * The PATH is taken from the execution `env` (falling back to `process.env`)
 * so pi's managed-bin directory — which the host prepends to PATH for each
 * call — is honoured. Results are cached per (program, PATH) pair, so the same
 * program resolves consistently under one PATH but re-resolves when the PATH
 * changes (e.g. pi prepending its managed-bin dir, or a per-call custom PATH).
 */
const cache = new Map<string, string | null>();
const WIN_EXTS = [".exe", ".cmd", ".bat", ""];
const UNIX_EXTS = [""];

/** The platform PATH environment-variable key. Windows conventionally uses
 *  "Path" while POSIX uses "PATH"; pi's managed-bin prepend matches whichever
 *  key is present (case-insensitive), defaulting to "PATH". Exported so the
 *  resolver and the managed-env derivation (managed-env.ts) agree on the key. */
export function pathKey(env: NodeJS.ProcessEnv = process.env): string {
  return Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
}

/**
 * Resolve `program` to an executable path, scanning the PATH carried by `env`
 * (defaults to `process.env`). Passing the execution env — not `process.env` —
 * is what lets the fast path find pi's managed SDK binaries (rg/fd) that the
 * host prepended to PATH for this call.
 */
export function resolveBinary(program: string, env?: NodeJS.ProcessEnv): string | null {
  const pathEnv = (env ?? process.env)[pathKey(env)] ?? "";
  const cacheKey = program + "\0" + pathEnv;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const resolved = resolveUncached(program, pathEnv);
  cache.set(cacheKey, resolved);
  return resolved;
}

function resolveUncached(program: string, pathEnv: string): string | null {
  // An empty or whitespace-only program name is meaningless and must not be
  // resolved. Without this guard, scanning PATH with program="" returns the
  // first directory itself, because join(dir, "" + "") === dir and
  // existsSync(dir) is true on every PATH entry.
  if (program.trim() === "") return null;
  // Absolute or relative path: use as-is if it exists.
  if (program.includes("/") || (process.platform === "win32" && program.includes("\\"))) {
    return existsSync(program) ? program : null;
  }
  const exts = process.platform === "win32" ? WIN_EXTS : UNIX_EXTS;
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, program + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Drop all cached resolutions. Tests mutate PATH between cases; production
 *  never needs this (PATH is stable for a process). */
export function clearResolveCache(): void {
  cache.clear();
}
