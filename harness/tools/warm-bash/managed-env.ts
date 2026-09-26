import { delimiter } from "node:path";
import { pathKey } from "./resolve.js";

function pathDelimiter(env: NodeJS.ProcessEnv, key: string, ...pathHints: Array<string | undefined>): string {
  const current = env[key] ?? "";
  const looksWindows = /(?:^|;)[a-z]:[\\/]/i.test(current)
    || pathHints.some((value) => value !== undefined && /^[a-z]:[\\/]/i.test(value));
  return looksWindows ? ";" : delimiter;
}

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
  const separator = pathDelimiter(env, key, binDir);
  const entries = current.split(separator).filter(Boolean);
  if (entries.includes(binDir)) return { ...env };
  const updated = [binDir, current].filter(Boolean).join(separator);
  return { ...env, [key]: updated };
}

/** Per-tool activation vars proto's `activate` emits: `PROTO_<TOOL>_VERSION` (a
 *  resolved version pin) and `PROTO_<TOOL>_SHIM` (a shim-executable pin).
 *  Stripping these forces proto's shims to re-resolve the version from
 *  `.prototools` at run time instead of inheriting whatever was live when the
 *  warm-bash pool was spawned (which would pin every later call to it).
 *  `PROTO_HOME`, `PROTO_VERSION` (proto's own version), `PROTO_APP_LOG`,
 *  `PROTO_OFFLINE_TIMEOUT`, … do NOT match and are preserved. */
const PROTO_TOOL_ACTIVATION_VAR = /^PROTO_[A-Z0-9_]+_(VERSION|SHIM)$/;

/** The running shim's self-identification — set by a proto shim when it launches
 *  a process (e.g. `PROTO_SHIM_NAME=node`, `PROTO_SHIM_PATH=…/node.exe`). These
 *  are activation context, not config: a warm-bash pool frozen at spawn time
 *  should not carry a stale "I am node" identity into every command it runs
 *  (each shim the pool later invokes sets its own). They do not match the
 *  per-tool pattern above (`PROTO_SHIM_*` vs `PROTO_<TOOL>_SHIM`), so they are
 *  matched explicitly. */
const PROTO_SHIM_NAME = "PROTO_SHIM_NAME";
const PROTO_SHIM_PATH = "PROTO_SHIM_PATH";

function isProtoActivationVar(name: string): boolean {
  return (
    name === PROTO_SHIM_NAME ||
    name === PROTO_SHIM_PATH ||
    PROTO_TOOL_ACTIVATION_VAR.test(name)
  );
}

/** Normalize a PATH entry for comparison: forward slashes, collapsed runs,
 *  trailing slash trimmed, and case-folded ONLY for Windows drive paths
 *  (`C:\…` / `C:/…`). POSIX paths stay case-sensitive. Keying case-folding on
 *  the path *structure* (a drive letter) — not on `process.platform` — keeps
 *  the Windows-Path-casing assertions machine-independent in tests. */
function normPath(p: string): string {
  let n = p.replace(/\\/g, "/");
  n = n.replace(/\/+/g, "/");
  if (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
  if (/^[a-z]:\//i.test(n)) n = n.toLowerCase();
  return n;
}

/**
 * Sanitize proto's per-project activation out of an environment so a warm-bash
 * pool (spawned ONCE with a fixed env) is not pinned to whatever proto
 * activation was live at spawn time — making the pool project-aware (shims
 * re-resolve per `.prototools`) instead of frozen.
 *
 * - Strips activation-specific `PROTO_*_VERSION` / `PROTO_*_SHIM` vars and the
 *   running shim's `PROTO_SHIM_NAME` / `PROTO_SHIM_PATH`, so proto shims
 *   re-resolve the version from `.prototools` at run time instead of inheriting
 *   a frozen one. `PROTO_HOME` is preserved (the shims need it to locate their
 *   config), as are unrelated proto vars (`PROTO_VERSION`, `PROTO_APP_LOG`, …).
 * - Strips direct `$PROTO_HOME/tools/<tool>/<ver>/…` PATH entries — version-pinned
 *   install bins (and their `globals/bin`) that bypass the shims entirely, so
 *   `node`/`npm` would always resolve to the version active at spawn.
 * - Promotes `$PROTO_HOME/shims` and `$PROTO_HOME/bin` to sit immediately AFTER
 *   `managedBinDir` (pi's `<agentDir>/bin`, which holds `rg`/`fd`) so the
 *   managed SDK binaries still win, then proto's version-aware shims resolve
 *   `node`/`npm`/`python`/… per project. `shims` is placed before `bin` because
 *   `bin/<tool>` is the real pinned binary whereas `shims/<tool>` is the
 *   version-resolving shim — the shim must win. If `managedBinDir` is absent or
 *   not on PATH, shims/bin are promoted to the front. Existing (buried)
 *   shims/bin entries are moved up rather than duplicated.
 *
 * Pure (no `process.env` / fs reads) and immutable (returns a fresh object,
 * never mutates the input). Preserves unrelated vars and the PATH key casing
 * (`Path` on Windows vs `PATH` on POSIX) via {@link pathKey}.
 */
export function sanitizeProtoEnv(
  env: NodeJS.ProcessEnv,
  managedBinDir?: string,
): NodeJS.ProcessEnv {
  // 1. Drop activation-specific vars. Done unconditionally (independent of
  //    PROTO_HOME): a stale PROTO_NODE_VERSION pins a tool even when PROTO_HOME
  //    is set elsewhere.
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (isProtoActivationVar(k)) continue;
    out[k] = v;
  }

  // 2. PATH work needs PROTO_HOME to compute the shim/tools paths.
  const protoHome = env.PROTO_HOME;
  if (!protoHome) return out;

  const key = pathKey(out);
  const separator = pathDelimiter(out, key, protoHome, managedBinDir);
  const entries = (out[key] ?? "").split(separator).filter(Boolean);

  // Build sub-paths preserving protoHome's separator convention (Windows `\`
  // vs POSIX `/`), keyed on protoHome's CONTENT — not on `process.platform` —
  // so the output is identical regardless of the host running the helper. Using
  // path.join() would normalize to the host's separator and mangle cross-style
  // proto paths (e.g. a Windows-style PROTO_HOME under a POSIX test host).
  const home = protoHome.replace(/[\\/]+$/, "");
  const sep = home.includes("\\") ? "\\" : "/";
  const shimsDir = `${home}${sep}shims`;
  const binDir = `${home}${sep}bin`;
  // Comparison forms (normalized to forward slashes; drive paths case-folded).
  const homeNorm = normPath(home);
  const toolsPrefix = `${homeNorm}/tools`;
  const shimsNorm = `${homeNorm}/shims`;
  const binNorm = `${homeNorm}/bin`;
  const managedNorm = managedBinDir ? normPath(managedBinDir) : null;

  // 2a. Strip direct tools/ entries (version-pinned install bins + globals/bin)
  //     and existing shims/bin (re-inserted below in the right place). Track
  //     where managedBinDir sits among the kept entries so shims/bin land right
  //     after it.
  const kept: string[] = [];
  let managedIdx = -1;
  for (const entry of entries) {
    const n = normPath(entry);
    if (n === toolsPrefix || n.startsWith(`${toolsPrefix}/`)) continue;
    if (n === shimsNorm || n === binNorm) continue;
    if (managedIdx === -1 && managedNorm !== null && n === managedNorm) {
      managedIdx = kept.length;
    }
    kept.push(entry);
  }

  // 3. Promote shims + bin right after managedBinDir (or at the front).
  const insertAt = managedIdx === -1 ? 0 : managedIdx + 1;
  kept.splice(insertAt, 0, shimsDir, binDir);

  out[key] = kept.join(separator);
  return out;
}
