import { execSync } from "node:child_process";
import path from "node:path";

let cached: string | undefined;

/**
 * Root of the pi-config repo, resolved from this extension's `src/` directory
 * (three levels up: `src/` → `skill-pruner/` → `extensions/` → repo root).
 * Mirrors the resolution in `state.ts` but is duplicated here so `version.ts`
 * stays self-contained — importing `state.ts` would drag in the
 * `@earendil-works/pi-coding-agent` peer dependency, which is only resolvable
 * inside the pi runtime (not under standalone `tsx` test runs).
 */
const CONFIG_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

/**
 * Resolve the short git SHA of the repo HEAD once (cached for the process
 * lifetime) to stamp each pruning decision with the code version that produced
 * it. This lets analytics split runs into cohorts (e.g. before/after a
 * prompt-compaction change) even when the provider reports no token usage —
 * the cohort is derivable from the SHA alone.
 *
 * Resolved lazily on first call so importing the module is free; the single git
 * subprocess runs on the first `before_agent_start` (bounded to 2s) and is then
 * cached. Returns `"unknown"` when git is unavailable or the repo cannot be
 * resolved (packaged builds, sandboxes without git, a 2s timeout).
 */
export function getCodeVersion(): string {
	if (cached !== undefined) return cached;
	try {
		const sha = execSync("git rev-parse --short HEAD", {
			cwd: CONFIG_ROOT,
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf-8",
			timeout: 2_000,
		}).trim();
		cached = /^[0-9a-f]{4,40}$/i.test(sha) ? sha : "unknown";
	} catch {
		cached = "unknown";
	}
	return cached;
}

/** Test seam: override the cached code version (pass `null` to reset). */
export function __setCodeVersionForTesting(version: string | null): void {
	cached = version ?? undefined;
}
