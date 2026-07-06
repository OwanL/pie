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
 * Error thrown when an {@link Semaphore.acquire} call is aborted while waiting
 * for a permit (or was already aborted at call time). Named `AbortError` so
 * callers can distinguish it from other rejections and so a `finally` that
 * releases a permit is reliably reached.
 */
export class SemaphoreAbortError extends Error {
	constructor(stage = "waiting for subagent concurrency slot") {
		super(`Subagent aborted (while ${stage})`);
		this.name = "AbortError";
	}
}

/** A queued waiter: carried so it can be removed on abort without leaking. */
interface Waiter {
	resolve: (release: Release) => void;
	reject: (error: unknown) => void;
}

/**
 * Promise-based counting semaphore. Holds `capacityFn()` permits; callers
 * acquire one permit and release it in a `finally` block. Re-evaluates the
 * capacity on every acquire so env overrides take effect without a process
 * restart.
 *
 * `acquire(signal?)` is abortable: a caller that is aborted while queued — or
 * that is already aborted at call time — rejects with a {@link SemaphoreAbortError}
 * and is removed from the waiter list, so a parent "Stop" can never leave a
 * permit claimed by a dead caller. This is the structural fix for the
 * "Build Out" freeze class, where a hung/aborted pre-spawn phase held the
 * process-wide permit forever and poisoned all future subagents.
 */
export class Semaphore {
	private waiters: Waiter[] = [];
	private inFlight = 0;

	constructor(private readonly capacityFn: () => number) {}

	async acquire(signal?: AbortSignal): Promise<Release> {
		// Already aborted: reject before touching capacity. A "Stop" that
		// arrived before we even tried to enter must never claim a permit —
		// otherwise an abandoned caller can consume the last slot and starve a
		// real caller. This takes priority over the fast path.
		if (signal?.aborted) throw new SemaphoreAbortError();

		const capacity = Math.max(0, Math.floor(this.capacityFn()));

		if (this.inFlight < capacity) {
			this.inFlight++;
			return this.makeRelease();
		}

		return new Promise<Release>((resolve, reject) => {
			const waiter: Waiter = { resolve, reject };
			this.waiters.push(waiter);
			if (!signal) return;
			const onAbort = () => {
				const idx = this.waiters.indexOf(waiter);
				if (idx >= 0) this.waiters.splice(idx, 1);
				reject(new SemaphoreAbortError());
			};
			signal.addEventListener("abort", onAbort, { once: true });
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
				// Transfer the permit to the next waiter rather than leaving it
				// free: `inFlight` was just decremented above, so incrementing it
				// back to its prior value keeps the count correct. The waiter now
				// owns a fresh `makeRelease()` handle whose own `release()` will
				// eventually decrement `inFlight` when the caller is done.
				this.inFlight++;
				next.resolve(this.makeRelease());
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
