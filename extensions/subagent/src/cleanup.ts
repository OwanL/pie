/**
 * Bounded cleanup and orphan registry for subagent sessions.
 *
 * When a child session's `abort()` or `dispose()` does not settle within a
 * short grace, we detach remote teardown from local settlement, record the
 * orphan, and move on. The registry retries cleanup with bounded backoff,
 * never reacquires execution permits, caps retained entries, and exposes
 * aggregate diagnostics. It is drained best-effort on backend shutdown.
 */

import type { ChildPhase } from "./lifecycle.js";

/** Record for a session whose remote cleanup exceeded its grace period. */
export interface OrphanRecord {
	attemptId: string;
	provider?: string;
	model?: string;
	phase: ChildPhase;
	/** When the session was detached from local settlement. */
	detachedAt: number;
	/** How many cleanup attempts have been made. */
	abortAttempts: number;
	/** Last recorded error message. */
	lastError?: string;
	/** Whether the local caller already stopped billable windows. */
	billableWindowsStopped: boolean;
	/** When the registry observed cleanup completion, if ever. */
	cleanupCompletedAt?: number;
}

/** Diagnostic snapshot of the registry state. */
export interface OrphanDiagnostics {
	count: number;
	maxSize: number;
	retentionMs: number;
	completed: number;
	pending: number;
}

/** Cleanup task supplied by the runner. */
export type OrphanCleanupTask = () => Promise<void>;

/**
 * Process-wide orphan cleanup registry. Bounded and best-effort: it retries
 * cleanup a few times, evicts old entries, and never blocks new subagent calls.
 */
export class OrphanCleanupRegistry {
	private orphans = new Map<string, OrphanRecord>();
	private maxSize: number;
	private retentionMs: number;
	private retryIntervalsMs: number[];
	private attemptTimeoutMs: number;
	private timers = new Set<ReturnType<typeof setTimeout>>();
	private cleanupTasks = new Map<string, OrphanCleanupTask>();
	private drained = false;

	constructor(options?: {
		maxSize?: number;
		retentionMs?: number;
		retryIntervalsMs?: number[];
		/** Bound for each detached cleanup attempt. A cleanup task that never
		 * settles must not stop later retries or hang backend shutdown. */
		attemptTimeoutMs?: number;
	}) {
		this.maxSize = options?.maxSize ?? 100;
		this.retentionMs = options?.retentionMs ?? 60 * 60 * 1000;
		this.retryIntervalsMs = options?.retryIntervalsMs ?? [5_000, 30_000, 120_000];
		this.attemptTimeoutMs = Math.max(1, options?.attemptTimeoutMs ?? 5_000);
	}

	/** Register a session that exceeded its abort/dispose grace. */
	register(record: Omit<OrphanRecord, "abortAttempts">, cleanupTask?: OrphanCleanupTask): OrphanRecord {
		const full: OrphanRecord = { ...record, abortAttempts: 0 };
		this.enforceCap();
		this.orphans.set(full.attemptId, full);
		if (cleanupTask) this.cleanupTasks.set(full.attemptId, cleanupTask);
		this.scheduleRetry(full.attemptId);
		return full;
	}

	/** Mark an orphan as successfully cleaned up. */
	recordCompleted(attemptId: string): void {
		const rec = this.orphans.get(attemptId);
		if (!rec) return;
		rec.cleanupCompletedAt = Date.now();
		this.cleanupTasks.delete(attemptId);
		// Keep the record briefly for diagnostics, then evict on next cap or drain.
	}

	/** Record a cleanup error for an orphan and schedule another retry if budget remains. */
	recordError(attemptId: string, error: unknown): void {
		const rec = this.orphans.get(attemptId);
		if (!rec) return;
		rec.lastError = String(error ?? "unknown");
		if (rec.abortAttempts < this.retryIntervalsMs.length) {
			this.scheduleRetry(attemptId);
		}
	}

	/** Snapshot diagnostics. */
	getDiagnostics(): OrphanDiagnostics {
		let completed = 0;
		let pending = 0;
		for (const rec of this.orphans.values()) {
			if (rec.cleanupCompletedAt) completed++;
			else pending++;
		}
		return {
			count: this.orphans.size,
			maxSize: this.maxSize,
			retentionMs: this.retentionMs,
			completed,
			pending,
		};
	}

	/** Drain all pending cleanup tasks. Returns the final list of records. */
	async drain(): Promise<OrphanRecord[]> {
		this.drained = true;
		for (const t of this.timers) clearTimeout(t);
		this.timers.clear();
		await this.runPendingCleanups((attemptId) => this.cleanupTasks.get(attemptId));
		return [...this.orphans.values()];
	}

	/** Reap entries older than retentionMs and completed records. */
	prune(): number {
		const now = Date.now();
		let removed = 0;
		for (const [id, rec] of this.orphans) {
			const age = now - rec.detachedAt;
			if (age > this.retentionMs || rec.cleanupCompletedAt) {
				this.orphans.delete(id);
				this.cleanupTasks.delete(id);
				removed++;
			}
		}
		return removed;
	}

	private enforceCap(): void {
		if (this.orphans.size < this.maxSize) return;
		// Evict oldest by detachedAt, preferring completed records first.
		let removed = this.prune();
		while (this.orphans.size >= this.maxSize && removed === 0) {
			let oldestId: string | undefined;
			let oldestTime = Infinity;
			for (const [id, rec] of this.orphans) {
				if (rec.detachedAt < oldestTime) {
					oldestTime = rec.detachedAt;
					oldestId = id;
				}
			}
			if (oldestId) {
				this.orphans.delete(oldestId);
				this.cleanupTasks.delete(oldestId);
				break;
			}
		}
	}

	private scheduleRetry(attemptId: string): void {
		if (this.drained || this.retryIntervalsMs.length === 0) return;
		const rec = this.orphans.get(attemptId);
		if (!rec || rec.cleanupCompletedAt || rec.abortAttempts >= this.retryIntervalsMs.length) return;
		const delay = this.retryIntervalsMs[rec.abortAttempts];
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			const task = this.cleanupTasks.get(attemptId);
			if (!task) return;
			void this.runCleanupAttempt(attemptId, task);
		}, delay);
		timer.unref?.();
		this.timers.add(timer);
	}

	private async runCleanupAttempt(attemptId: string, task: OrphanCleanupTask): Promise<void> {
		const rec = this.orphans.get(attemptId);
		if (!rec || rec.cleanupCompletedAt) return;
		rec.abortAttempts++;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.resolve().then(task),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`orphan cleanup attempt exceeded ${this.attemptTimeoutMs}ms`)), this.attemptTimeoutMs);
				}),
			]);
			this.recordCompleted(attemptId);
		} catch (err) {
			this.recordError(attemptId, err);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/** Run pending cleanup tasks concurrently; each attempt is independently
	 * bounded so one broken provider socket cannot hang shutdown or later orphans. */
	async runPendingCleanups(taskFor: (attemptId: string) => OrphanCleanupTask | undefined): Promise<void> {
		const attempts: Promise<void>[] = [];
		for (const [attemptId, rec] of this.orphans) {
			if (rec.cleanupCompletedAt) continue;
			const task = taskFor(attemptId);
			if (task) attempts.push(this.runCleanupAttempt(attemptId, task));
		}
		await Promise.all(attempts);
	}
}

/** Shared process-wide orphan registry. */
export const orphanRegistry = new OrphanCleanupRegistry();

/** Synchronously stop known billable windows on a session object. */
export function hardAbortBillable(session: unknown): void {
	const s = session as Record<string, () => void> | null;
	if (!s || typeof s !== "object") return;
	for (const method of ["abortCompaction", "abortBranchSummary", "abortBash", "abortRetry"]) {
		try {
			(s as Record<string, () => void>)[method]?.();
		} catch {
			/* a stuck billable-window abort must not prevent the others */
		}
	}
}

/**
 * Race an abort/dispose call against a grace timer. If it doesn't settle, detach
 * locally and register an orphan. Never throws: local settlement must proceed.
 */
export async function boundedAbort(
	attemptId: string,
	abortFn: () => Promise<void> | void,
	disposeFn: () => void,
	graceMs: number,
	metadata: Omit<OrphanRecord, "detachedAt" | "abortAttempts">,
	registry: OrphanCleanupRegistry = orphanRegistry,
): Promise<void> {
	let completed = false;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	const cleanupTask = async () => {
		await abortFn();
		disposeFn();
	};
	try {
		await Promise.race([
			Promise.resolve()
				.then(cleanupTask)
				.then(() => {
					completed = true;
				}),
			new Promise<void>((_, reject) => {
				graceTimer = setTimeout(() => reject(new Error("abort/dispose grace exceeded")), graceMs);
			}),
		]);
	} catch {
		// Detach local settlement from remote teardown, but retain a bounded retry
		// task; a record with no task can never clean itself up.
		registry.register({ ...metadata, attemptId, detachedAt: Date.now() }, cleanupTask);
	} finally {
		if (graceTimer) clearTimeout(graceTimer);
		// Always attempt disposal even if abort raced; ignore errors.
		try {
			disposeFn();
		} catch {
			/* ignore */
		}
		if (completed) {
			registry.recordCompleted(attemptId);
		}
	}
}
