import { execSync, exec } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PIE_BUILD_ID } from "../../../lib/build-identity.js";

let cached: string | undefined;
const BUILD_CODE_VERSION = PIE_BUILD_ID === "source-test-build" ? undefined : `build:${PIE_BUILD_ID}`;
/** True while the source-only async pre-warm `exec` is in flight, so repeated
 *  `register()` calls don't spawn concurrent git subprocesses. Reset in callback. */
let prewarming = false;

/**
 * Root of the pi-config repo for source-test builds, resolved from this owner's
 * `lifecycle/` directory (three levels up: `lifecycle/` → `tool-and-skill-selection/`
 * → `harness/` → repo root). Delivered builds use their explicit build identity
 * instead and never resolve or execute git. This remains self-contained rather
 * than importing `selector-state.ts`, which would drag in the SDK peer dependency.
 */
const CONFIG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Stamp each pruning decision with a diagnostic cohort. Delivered builds use
 * the explicitly tagged `build:<PIE_BUILD_ID>` identity; source-test builds
 * preserve the short Git SHA behavior. Either string lets analytics split
 * decisions into cohorts even when the provider reports no token usage.
 *
 * The compiled build identity is returned from process-local code and performs
 * no subprocess. In source-test builds, the short SHA is resolved lazily on
 * first call (one Git subprocess, bounded to 2s) and then cached; `"unknown"`
 * remains the fallback when git or the source repository is unavailable.
 */
export function getCodeVersion(): string {
	if (cached !== undefined) return cached;
	if (BUILD_CODE_VERSION !== undefined) return cached = BUILD_CODE_VERSION;
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

/**
 * Pre-warm the cached code version. Delivered builds cache their tagged build
 * identity synchronously without spawning a process. Source-test builds remain
 * fire-and-forget: a single bounded async `exec` resolves the Git SHA away from
 * the latency-critical prepass path, with no long-lived resource. If that
 * pre-warm loses a race to synchronous resolution, its callback no-ops. Safe
 * to call repeatedly: a no-op once cached or while source Git pre-warm is in flight.
 */
export function prewarmCodeVersion(): void {
	if (cached !== undefined) return;
	if (BUILD_CODE_VERSION !== undefined) {
		cached = BUILD_CODE_VERSION;
		return;
	}
	if (prewarming) return;
	prewarming = true;
	exec("git rev-parse --short HEAD", {
		cwd: CONFIG_ROOT,
		encoding: "utf-8",
		timeout: 2_000,
	}, (err, stdout) => {
		prewarming = false;
		if (cached !== undefined) return; // a sync call won the race
		if (err) { cached = "unknown"; return; }
		const sha = String(stdout).trim();
		cached = /^[0-9a-f]{4,40}$/i.test(sha) ? sha : "unknown";
	});
}

/** Test seam: override the cached code version (pass `null` to reset). */
export function __setCodeVersionForTesting(version: string | null): void {
	cached = version ?? undefined;
}

/** Test seam: peek at the cached value without triggering sync resolution, so
 *  tests can observe the async pre-warm populating the cache. */
export function __peekCodeVersionCacheForTesting(): string | undefined {
	return cached;
}
