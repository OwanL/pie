/**
 * Process-wide concurrency gate for subagent sessions.
 *
 * Multiple `subagent` tool calls in a single parent reply can each spawn their
 * own parallel batches. The per-batch `mapWithConcurrencyLimit` only throttles
 * one `tasks[]` array at a time, so a burst of parallel tool calls can still
 * open many concurrent SDK sessions. This module adds a global in-flight
 * semaphore around every `createAgentSession` call.
 */

import { MAX_CONCURRENCY, MAX_PARALLEL_TASKS } from "../types.js";

/** Acquire/release handle returned by {@link Semaphore.acquire}. */
export interface Release {
	(): void;
}

/**
 * Promise-based counting semaphore. Holds `capacityFn()` permits; callers
 * acquire one permit and release it in a `finally` block. Re-evaluates the
 * capacity on every acquire so env overrides take effect without a process
 * restart.
 */
export class Semaphore {
	private waiters: Array<(release: Release) => void> = [];
	private inFlight = 0;

	constructor(private readonly capacityFn: () => number) {}

	async acquire(): Promise<Release> {
		const capacity = Math.max(0, Math.floor(this.capacityFn()));

		if (this.inFlight < capacity) {
			this.inFlight++;
			return this.makeRelease();
		}

		return new Promise<Release>((resolve) => {
			this.waiters.push(resolve);
		});
	}

	private makeRelease(): Release {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.inFlight = Math.max(0, this.inFlight - 1);
			const next = this.waiters.shift();
			if (next) {
				this.inFlight++;
				next(this.makeRelease());
			}
		};
	}
}

/** Environment key for the global in-flight subagent cap. */
const MAX_INFLIGHT_ENV = "PIE_SUBAGENT_MAX_INFLIGHT";
/** Default in-flight cap when no override is supplied. */
export const DEFAULT_MAX_INFLIGHT = 2;

/** Resolve the global in-flight subagent cap. */
export function getMaxInflight(): number {
	const raw = process.env[MAX_INFLIGHT_ENV];
	if (raw === undefined || raw === "") return DEFAULT_MAX_INFLIGHT;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_INFLIGHT;
}

/** Resolve the per-`tasks[]` concurrency limit. */
export function getMaxConcurrency(): number {
	const raw = process.env["PIE_SUBAGENT_MAX_CONCURRENCY"];
	if (raw === undefined || raw === "") return MAX_CONCURRENCY;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : MAX_CONCURRENCY;
}

/** Resolve the max number of parallel tasks in one `subagent` call. */
export function getMaxParallelTasks(): number {
	const raw = process.env["PIE_SUBAGENT_MAX_PARALLEL_TASKS"];
	if (raw === undefined || raw === "") return MAX_PARALLEL_TASKS;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : MAX_PARALLEL_TASKS;
}

/** Process-wide semaphore guarding entry to `createAgentSession`. */
export const inflightSemaphore = new Semaphore(() => getMaxInflight());
