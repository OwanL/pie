/**
 * Bounded orphan cleanup registry for subagent attempts whose resource/session
 * creation lost an abort/timeout race.
 *
 * When `createSession()` is in-flight and the parent signal (or pre-spawn
 * timeout) fires first, the underlying creation promise is not cancelled.
 * If it later resolves to a session, that session must be disposed exactly
 * once, any loader-leaked exit-signal listeners must be reclaimed, and no
 * process permit may be retained. This registry tracks those detached cleanup
 * tasks, retries them with bounded exponential backoff, caps total retention,
 * exposes observable stats, and drains best-effort on process shutdown.
 *
 * Important limitation: the upstream `DefaultResourceLoader` does not expose a
 * reliable `dispose()`/`destroy()` API, so the registry cannot tear down the
 * loader itself. Cleanup is limited to disposing a late-resolved session and
 * reclaiming the orphaned exit-signal listeners leaked during loader setup.
 */

/** Cancelable timer handle returned by {@link CleanupScheduler.setTimer}. */
export interface CleanupTimer {
	promise: Promise<void>;
	cancel: () => void;
}

/** Clock and timer abstraction so tests can inject deterministic control. */
export interface CleanupScheduler {
	now(): number;
	/** Keep the timer referenced when it owns a shutdown drain. Ordinary orphan
	 * retry timers stay unreferenced so they never retain the process alone. */
	setTimer(ms: number, referenced?: boolean): CleanupTimer;
}

/** Real clock/timer scheduler used in production. */
export const realScheduler: CleanupScheduler = {
	now: () => Date.now(),
	setTimer: (ms, referenced = false) => {
		let handle: ReturnType<typeof setTimeout> | undefined;
		const promise = new Promise<void>((resolve) => {
			handle = setTimeout(resolve, ms);
			if (!referenced) handle.unref?.();
		});
		return {
			promise,
			cancel: () => {
				if (handle) {
					clearTimeout(handle);
					handle = undefined;
				}
			},
		};
	},
};

/** Reason a cleanup attempt terminated. */
export type OrphanCleanupPhase = "pending" | "disposing" | "completed" | "failed";

/** Observable record for a single registered orphan cleanup. */
export interface OrphanCleanupEntry {
	attemptId: string;
	registeredAt: number;
	phase: OrphanCleanupPhase;
	attempts: number;
	lastError?: string;
	cleanupCompletedAt?: number;
}

/** Aggregate observable counters. */
export interface OrphanCleanupStats {
	pending: number;
	disposing: number;
	completed: number;
	failed: number;
	totalRegistered: number;
	evicted: number;
}

/** Configuration for the global orphan registry. */
export interface OrphanRegistryOptions {
	/** Maximum retained entries. Oldest failed/completed entries are evicted first. */
	maxEntries: number;
	/** Initial retry delay in ms. */
	initialRetryMs: number;
	/** Maximum retry delay in ms. */
	maxRetryMs: number;
	/** Exponential backoff multiplier. */
	retryMultiplier: number;
	/** Maximum attempts before an entry is marked failed. */
	maxAttempts: number;
	/** Per-cleanup-attempt timeout in ms. */
	cleanupTimeoutMs: number;
}

const DEFAULT_OPTIONS: OrphanRegistryOptions = {
	maxEntries: 64,
	initialRetryMs: 500,
	maxRetryMs: 30_000,
	retryMultiplier: 2,
	maxAttempts: 5,
	cleanupTimeoutMs: 5_000,
};

/**
 * A bounded cleanup registry for orphaned subagent sessions/resource loaders.
 *
 * - Cleanup functions never reacquire execution permits; they only dispose
 *   late-resolved sessions and reclaim attempt-owned loader listeners.
 * - Retries use bounded exponential backoff with a per-attempt timeout.
 * - Total entries are capped; oldest terminal entries are evicted first.
 * - `drain()` awaits pending work best-effort.
 */
export class OrphanCleanupRegistry {
	private entries = new Map<string, OrphanCleanupEntry>();
	private totalRegistered = 0;
	private evicted = 0;
	private drainPromise: Promise<void> | undefined;

	constructor(
		private readonly options: OrphanRegistryOptions = DEFAULT_OPTIONS,
		private readonly scheduler: CleanupScheduler = realScheduler,
		installProcessShutdownDrain = false,
	) {
		if (installProcessShutdownDrain) this.installShutdownDrain();
	}

	/**
	 * Register a detached cleanup task.
	 *
	 * The returned function removes the entry from scheduling. It does NOT undo
	 * cleanup that has already run; it only stops future retries.
	 */
	register(attemptId: string, cleanup: () => Promise<void>): () => void {
		this.totalRegistered++;

		const entry: OrphanCleanupEntry = {
			attemptId,
			registeredAt: this.scheduler.now(),
			phase: "pending",
			attempts: 0,
		};
		this.entries.set(attemptId, entry);
		this.evictIfNeeded();
		void this.runLoop(entry, cleanup);

		return () => {
			this.entries.delete(attemptId);
		};
	}

	/** Aggregate observable counters. */
	stats(): OrphanCleanupStats {
		let pending = 0;
		let disposing = 0;
		let completed = 0;
		let failed = 0;
		for (const entry of this.entries.values()) {
			switch (entry.phase) {
				case "pending":
					pending++;
					break;
				case "disposing":
					disposing++;
					break;
				case "completed":
					completed++;
					break;
				case "failed":
					failed++;
					break;
			}
		}
		return {
			pending,
			disposing,
			completed,
			failed,
			totalRegistered: this.totalRegistered,
			evicted: this.evicted,
		};
	}

	/** Best-effort wait for all pending/disposing entries to become terminal. */
	async drain(): Promise<void> {
		if (this.drainPromise) return this.drainPromise;
		this.drainPromise = (async () => {
			const start = this.scheduler.now();
			const maxWaitMs = 60_000;
			while (this.hasActive()) {
				// A beforeExit drain must keep Node alive while it polls; the orphan
				// retry/backoff timers it is waiting on are deliberately unreferenced.
				await this.scheduler.setTimer(10, true).promise;
				if (this.scheduler.now() - start > maxWaitMs) break;
			}
		})();
		try {
			await this.drainPromise;
		} finally {
			this.drainPromise = undefined;
		}
	}

	private hasActive(): boolean {
		for (const entry of this.entries.values()) {
			if (entry.phase === "pending" || entry.phase === "disposing") return true;
		}
		return false;
	}

	private async runLoop(entry: OrphanCleanupEntry, cleanup: () => Promise<void>): Promise<void> {
		while (this.entries.has(entry.attemptId)) {
			const delay = entry.attempts > 0 ? this.backoffMs(entry.attempts - 1) : 0;
			if (entry.attempts > 0) {
				await this.scheduler.setTimer(delay).promise;
			}
			if (!this.entries.has(entry.attemptId)) return;

			entry.phase = "disposing";
			entry.attempts++;
			try {
				await this.withTimeout(cleanup);
				entry.phase = "completed";
				entry.cleanupCompletedAt = this.scheduler.now();
				return;
			} catch (error) {
				entry.lastError = String(error);
				if (entry.attempts >= this.options.maxAttempts) {
					entry.phase = "failed";
					return;
				}
				entry.phase = "pending";
			}
		}
	}

	private async withTimeout(cleanup: () => Promise<void>): Promise<void> {
		const timer = this.scheduler.setTimer(this.options.cleanupTimeoutMs);
		const timeoutPromise = timer.promise.then(() => {
			throw new Error(`orphan cleanup timed out after ${this.options.cleanupTimeoutMs}ms`);
		});
		try {
			await Promise.race([cleanup(), timeoutPromise]);
		} finally {
			timer.cancel();
		}
	}

	private backoffMs(attemptsMade: number): number {
		const ms = this.options.initialRetryMs * Math.pow(this.options.retryMultiplier, attemptsMade);
		return Math.min(this.options.maxRetryMs, Math.floor(ms));
	}

	private evictIfNeeded(): void {
		if (this.entries.size <= this.options.maxEntries) return;
		// Evict oldest terminal entries first; if none, evict oldest entries overall.
		const ordered = [...this.entries.entries()].sort((a, b) => a[1].registeredAt - b[1].registeredAt);
		const terminal = ordered.filter(([, e]) => e.phase === "completed" || e.phase === "failed");
		const toEvict = terminal.length > 0 ? terminal : ordered;
		let remove = this.entries.size - this.options.maxEntries;
		for (const [id] of toEvict) {
			if (remove <= 0) break;
			if (this.entries.delete(id)) {
				remove--;
				this.evicted++;
			}
		}
	}

	private installShutdownDrain(): void {
		try {
			process.once("beforeExit", () => {
				void this.drain().catch(() => {
					/* best-effort drain; ignore failures on shutdown */
				});
			});
		} catch {
			/* process.once may not be available in some test environments */
		}
	}
}

/** Process-wide registry used by runner.ts. Unit registries omit process hooks. */
export const globalOrphanRegistry = new OrphanCleanupRegistry(DEFAULT_OPTIONS, realScheduler, true);
