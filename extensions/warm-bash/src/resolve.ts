import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Resolve a program name to an executable path.
 *
 * On Windows, `child_process.spawn(prog, args, { shell: false })` does NOT
 * resolve `.cmd` / `.bat` shims (so `npm`, `npx`, `yarn` would ENOENT). This
 * scans PATH for the program with platform-appropriate extensions so those
 * shims fast-path correctly. Results are cached per program name.
 */
const cache = new Map<string, string | null>();
const WIN_EXTS = [".exe", ".cmd", ".bat", ""];
const UNIX_EXTS = [""];

export function resolveBinary(program: string): string | null {
  const cached = cache.get(program);
  if (cached !== undefined) return cached;
  const resolved = resolveUncached(program);
  cache.set(program, resolved);
  return resolved;
}

function resolveUncached(program: string): string | null {
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
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, program + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}