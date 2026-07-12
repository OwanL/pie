/**
 * Child lifecycle controller for subagent runs.
 *
 * Owns phase transitions, a renewable inactivity lease, terminal compare-and-set,
 * and exactly-once permit release. The lease is renewed by any credible progress
 * event (stream delta, tool heartbeat, state change, retry transition, etc.) and
 * is checked against phase-specific budgets rather than a single wall-clock
 * timeout. This lets a productive subagent run for more than 15 minutes while
 * guaranteeing that every blocked phase has a deterministic bound.
 */

import type { SingleResult } from "../types.js";
import { classifyProviderError, type ClassifiedProviderError } from "./provider-failure.js";

/** Phases a subagent attempt may pass through. */
export type ChildPhase =
	| "queued"
	| "preparing"
	| "waiting_provider"
	| "streaming"
	| "running_tool"
	| "retry_wait"
	| "completed"
	| "failed"
	| "cancelled"
	| "orphaned_cleanup";

/** Terminal phases: no further transition is permitted. */
const TERMINAL_PHASES = new Set<ChildPhase>([
	"completed",
	"failed",
	"cancelled",
	"orphaned_cleanup",
]);

/** Progress events that renew the inactivity lease. */
export interface ProgressDetail {
	type: string;
	/** Optional human-readable description of what progressed. */
	description?: string;
	/** Optional payload for diagnostics; keep small. */
	payload?: Record<string, unknown>;
}

/** Phase-specific inactivity budgets. */
export interface LivenessConfig {
	/** Max ms waiting in a provider concurrency/backpressure queue. */
	providerQueueMs: number;
	/** Max ms waiting for response headers after a provider request is sent. */
	headerMs: number;
	/** Max ms waiting for the first model token after headers. */
	firstTokenMs: number;
	/** Max ms without any stream delta/heartbeat while actively streaming. */
	streamIdleMs: number;
	/** Max ms a tool may be idle before it must heartbeat or complete. */
	toolIdleMs: number;
	/** Grace period for abort()/dispose() to settle before detaching. */
	abortGraceMs: number;
	/** How long orphan cleanup records are retained. */
	cleanupRetentionMs: number;
	/** Absolute last-resort containment; 0 disables the normal path. */
	absoluteContainmentMs: number;
}

/** Default phase budgets. These are intentionally generous: the goal is to
 *  bound *stalled* phases, not to cap productive work. */
export const DEFAULT_LIVENESS_CONFIG: LivenessConfig = {
	providerQueueMs: 10 * 60 * 1000,
	headerMs: 2 * 60 * 1000,
	firstTokenMs: 5 * 60 * 1000,
	streamIdleMs: 3 * 60 * 1000,
	toolIdleMs: 10 * 60 * 1000,
	abortGraceMs: 5_000,
	cleanupRetentionMs: 60 * 60 * 1000,
	absoluteContainmentMs: 0,
};

/** Environment key for an optional JSON override of liveness budgets. */
const LIVENESS_ENV = "PIE_SUBAGENT_LIVENESS_JSON";

/** Parse optional per-install liveness config from the environment. */
export function resolveLivenessConfig(overrides?: Partial<LivenessConfig>): LivenessConfig {
	const base = { ...DEFAULT_LIVENESS_CONFIG, ...overrides };
	const raw = process.env[LIVENESS_ENV];
	if (!raw) return base;
	try {
		const parsed = JSON.parse(raw) as Partial<LivenessConfig>;
		return {
			providerQueueMs: parsed.providerQueueMs ?? base.providerQueueMs,
			headerMs: parsed.headerMs ?? base.headerMs,
			firstTokenMs: parsed.firstTokenMs ?? base.firstTokenMs,
			streamIdleMs: parsed.streamIdleMs ?? base.streamIdleMs,
			toolIdleMs: parsed.toolIdleMs ?? base.toolIdleMs,
			abortGraceMs: parsed.abortGraceMs ?? base.abortGraceMs,
			cleanupRetentionMs: parsed.cleanupRetentionMs ?? base.cleanupRetentionMs,
			absoluteContainmentMs: parsed.absoluteContainmentMs ?? base.absoluteContainmentMs,
		};
	} catch {
		return base;
	}
}

/** Budget for the current phase. */
function phaseBudgetMs(phase: ChildPhase, cfg: LivenessConfig): number | undefined {
	switch (phase) {
		case "queued":
			return cfg.providerQueueMs;
		case "preparing":
			return cfg.headerMs;
		case "waiting_provider":
			return cfg.firstTokenMs;
		case "streaming":
			return cfg.streamIdleMs;
		case "running_tool":
			return cfg.toolIdleMs;
		case "retry_wait":
			return cfg.firstTokenMs;
		default:
			return undefined;
	}
}

/** Classification of a phase failure so callers can distinguish causes. */
export interface LeaseViolation {
	phase: ChildPhase;
	budgetMs: number;
	idleMs: number;
	reason: string;
}

/** Cleanup handle registered by the lifecycle and invoked exactly once. */
export type CleanupFn = () => void | Promise<void>;
export type ReleaseFn = () => void;

export interface ChildActivitySnapshot {
	phase: ChildPhase;
	detail?: string;
	phaseStartedAt: number;
	lastProgressAt: number;
	budgetMs?: number;
}

export type ActivityListener = (snapshot: ChildActivitySnapshot) => void;

/** Mutable accumulator for the run, surfaced in diagnostics and preserved on
 *  force-settlement. */
export interface LatestResultSnapshot {
	result: SingleResult;
	updatedAt: number;
}

/**
 * Per-attempt lifecycle. Thread-safe for a single attempt: all methods are
 * synchronous and should be called from the attempt's async context.
 */
export class ChildLifecycle {
	/** Unique id for this attempt; used to ignore late events. */
	public readonly attemptId: string;
	/** The provider/model tags for diagnostics. */
	public provider?: string;
	public model?: string;
	/** Current phase. */
	private _phase: ChildPhase = "queued";
	/** When the current phase began. */
	private phaseStartedAt: number;
	/** When the last credible progress event occurred. */
	private lastProgressAt: number;
	/** Sticky: any assistant output was streamed during this attempt. */
	private hasOutput = false;
	/** Sticky: a tool call started during this attempt (an external side effect
	 *  may already exist, so the turn must never be silently replayed). */
	private hasToolSideEffects = false;
	/** Terminal compare-and-set guard. */
	private terminal = false;
	/** Exactly-once permit release. */
	private releasedPermit = false;
	/** Classification of the error passed to {@link fail}, once it has run. */
	private classifiedError?: ClassifiedProviderError;
	/** Cleanup callbacks registered by the runner. */
	private cleanups: CleanupFn[] = [];
	/** Snapshot of the latest known result for force-settlement preservation. */
	private latestResult?: LatestResultSnapshot;
	/** Optional onRelease callback (used for concurrency permit). */
	private releaseFn?: ReleaseFn;
	private leaseTimer?: ReturnType<typeof setTimeout>;
	private onLeaseViolation?: (violation: LeaseViolation) => void;
	private activityDetail?: string;

	constructor(
		attemptId: string,
		private readonly cfg: LivenessConfig,
		private readonly nowFn: () => number = Date.now,
		private readonly onActivity?: ActivityListener,
	) {
		this.attemptId = attemptId;
		const now = nowFn();
		this.phaseStartedAt = now;
		this.lastProgressAt = now;
	}

	get phase(): ChildPhase {
		return this._phase;
	}

	get isTerminal(): boolean {
		return this.terminal;
	}

	/** Classification of the failure recorded by {@link fail}, if any. Used by
	 *  runner diagnostics and (later) the retry/failover policy. `undefined`
	 *  until `fail()` runs, or for non-failure terminal transitions. */
	get classified(): ClassifiedProviderError | undefined {
		return this.classifiedError;
	}

	/** Register a concurrency release callback to be invoked exactly once. */
	setRelease(fn: ReleaseFn): void {
		this.releaseFn = fn;
	}

	/** Register a cleanup callback invoked exactly once on terminal transition. */
	registerCleanup(fn: CleanupFn): void {
		this.cleanups.push(fn);
	}

	/** Begin the renewable inactivity watchdog. */
	startWatchdog(onViolation: (violation: LeaseViolation) => void): void {
		this.onLeaseViolation = onViolation;
		this.armLease();
	}

	/** Transition to a new phase. Progress is implicit on transition. */
	transition(next: ChildPhase, detail?: ProgressDetail): boolean {
		if (this.terminal) return false;
		// Repeated deltas report the same `streaming` phase. Treat those as
		// progress, not fresh transitions, so "time in state" measures the whole
		// generation instead of resetting to 0s on every token.
		if (this._phase === next) {
			this.progress(detail);
			return true;
		}
		const now = this.nowFn();
		this._phase = next;
		this.activityDetail = detail?.description;
		// Sticky progress flags: once the run has streamed output or started a
		// tool, it stays side-effect-unsafe for the whole attempt — even if a
		// later transition moves back to waiting_provider. These drive the
		// replay-safety assessment recorded by fail().
		if (next === "streaming") this.hasOutput = true;
		else if (next === "running_tool") this.hasToolSideEffects = true;
		this.phaseStartedAt = now;
		this.lastProgressAt = now;
		if (TERMINAL_PHASES.has(next)) {
			this.terminal = true;
			this.dispose();
			this.releasePermit();
			this.runCleanups();
		} else {
			this.armLease();
		}
		this.notifyActivity();
		return true;
	}

	/** Renew the lease with a progress event. */
	progress(detail?: ProgressDetail): void {
		if (this.terminal) return;
		this.lastProgressAt = this.nowFn();
		if (detail?.description) this.activityDetail = detail.description;
		this.armLease();
		this.notifyActivity();
	}

	private notifyActivity(): void {
		this.onActivity?.({
			phase: this._phase,
			detail: this.activityDetail,
			phaseStartedAt: this.phaseStartedAt,
			lastProgressAt: this.lastProgressAt,
			budgetMs: phaseBudgetMs(this._phase, this.cfg),
		});
	}

	/** Snapshot the latest known result for force-settlement preservation. */
	snapshotResult(result: SingleResult): void {
		this.latestResult = { result, updatedAt: this.nowFn() };
	}

	getLatestResult(): SingleResult | undefined {
		return this.latestResult?.result;
	}

	/** Check whether the inactivity lease for the current phase has expired. */
	checkLease(): LeaseViolation | undefined {
		if (this.terminal) return undefined;
		const budget = phaseBudgetMs(this._phase, this.cfg);
		if (budget === undefined) return undefined;
		const idleMs = this.nowFn() - this.lastProgressAt;
		if (idleMs <= budget) return undefined;
		return {
			phase: this._phase,
			budgetMs: budget,
			idleMs,
			reason: `Subagent phase "${this._phase}" was inactive for ${idleMs}ms (budget ${budget}ms)`,
		};
	}

	/** Mark the attempt as successfully completed. */
	finish(result: SingleResult): boolean {
		if (!this.compareAndSetTerminal()) return false;
		this.snapshotResult(result);
		this._phase = "completed";
		this.runCleanups();
		this.notifyActivity();
		return true;
	}

	/** Mark the attempt as failed. Classifies the error (phase-aware) and
	 *  records the result on {@link classified} for diagnostics and the future
	 *  retry/failover policy. Classification does not change control flow,
	 *  model selection, or failover — it is recorded only. */
	fail(error: unknown): boolean {
		if (!this.compareAndSetTerminal()) return false;
		// Classify with the phase AT failure time (before mutating to "failed")
		// and the sticky progress flags so replay safety reflects how far the
		// run had progressed when the failure hit.
		this.classifiedError = classifyProviderError(error, {
			phase: this._phase,
			hasOutput: this.hasOutput,
			hasToolSideEffects: this.hasToolSideEffects,
		});
		this._phase = "failed";
		this.runCleanups(error);
		this.notifyActivity();
		return true;
	}

	/** Mark the attempt as cancelled. */
	cancel(reason: string): boolean {
		if (!this.compareAndSetTerminal()) return false;
		this._phase = "cancelled";
		this.activityDetail = reason;
		this.runCleanups(new Error(reason));
		this.notifyActivity();
		return true;
	}

	/** Mark the attempt as orphaned (cleanup detached from local settlement). */
	markOrphaned(error?: unknown): boolean {
		if (!this.compareAndSetTerminal()) return false;
		this._phase = "orphaned_cleanup";
		this.runCleanups(error);
		return true;
	}

	dispose(): void {
		if (this.leaseTimer) clearTimeout(this.leaseTimer);
		this.leaseTimer = undefined;
	}

	private armLease(): void {
		if (this.leaseTimer) clearTimeout(this.leaseTimer);
		this.leaseTimer = undefined;
		if (this.terminal || !this.onLeaseViolation) return;
		const budget = phaseBudgetMs(this._phase, this.cfg);
		if (budget === undefined || budget <= 0) return;
		this.leaseTimer = setTimeout(() => {
			this.leaseTimer = undefined;
			const violation = this.checkLease();
			if (violation) this.onLeaseViolation?.(violation);
			else this.armLease();
		}, budget + 1);
		this.leaseTimer.unref?.();
	}

	private compareAndSetTerminal(): boolean {
		if (this.terminal) return false;
		this.terminal = true;
		this.dispose();
		this.releasePermit();
		return true;
	}

	private releasePermit(): void {
		if (this.releasedPermit) return;
		this.releasedPermit = true;
		try {
			this.releaseFn?.();
		} catch {
			/* permit release must never propagate */
		}
	}

	private runCleanups(error?: unknown): void {
		for (const fn of this.cleanups) {
			try {
				const r = fn();
				if (r && typeof (r as Promise<unknown>).catch === "function") {
					(r as Promise<unknown>).catch(() => {});
				}
			} catch {
				/* ignore cleanup failures */
			}
		}
		this.cleanups = [];
	}
}

/** Generate a short attempt id. */
export function makeAttemptId(agentName: string): string {
	return `${agentName}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
