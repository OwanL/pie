/**
 * Host-side provider gate — replaces the LiteLLM proxy.
 *
 * Wraps `globalThis.fetch` to enforce per-provider concurrency limits, stream
 * liveness, account-pause circuit breaking, and metrics — all in-process,
 * with no external Python proxy. Every provider that uses the OpenAI SDK (or
 * any SDK that calls `globalThis.fetch`) passes through this gate automatically.
 *
 * Installed once at `BackendServer.start()` before `loadSdk()`, so every SDK
 * client constructed afterward inherits the wrapped fetch. Non-LLM requests
 * (GitHub API, telemetry, etc.) pass through unwrapped — the gate only
 * intercepts requests whose URL matches a configured provider base URL.
 *
 * Design goals (see the proxy-removal investigation):
 *  - One unified concurrency gate (replaces LiteLLM semaphore + AfterburnPool +
 *    extension inflightSemaphore fragmentation).
 *  - Stream-liveness watchdog (replaces `wrap_stream_with_liveness`).
 *  - Account-pause circuit breaker (replaces `AccountPauseCircuitBreaker`).
 *  - Metrics surfaced through the backend → host pipeline (no HTTP endpoint).
 *  - Direct provider access (no re-chunking, no proxy overhead).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

import {
	PROVIDER_GATE_REQUEST_CLASS_HEADER,
	type ProviderGateRequestClass,
} from '../../../shared/provider-gate-request-class.js';

// ── Request class / queue priority ─────────────────────────────────────────────

// Re-exported so callers can import the header constant / type from the gate
// module without reaching into the root `shared/` package directly.
export { PROVIDER_GATE_REQUEST_CLASS_HEADER, type ProviderGateRequestClass };

/** Priority rank for a request class — LOWER number = HIGHER priority
 *  (further toward the front of the queue). Used to order queued waiters
 *  when a slot opens up. */
const REQUEST_CLASS_PRIORITY: Record<ProviderGateRequestClass, number> = {
	'skill-pruner': 0,
	'default': 1,
};

/** Parse a request-class header value into a known class (unknown → default). */
function parseRequestClass(value: string | undefined | null): ProviderGateRequestClass {
	if (value === 'skill-pruner') return 'skill-pruner';
	return 'default';
}

/** Parse an HTTP `Retry-After` header into seconds. Accepts either a non-negative
 *  integer (delta seconds) or an HTTP-date (absolute); returns `undefined` for
 *  an absent/unparseable header. Shared by the account-suspension fallback and
 *  the transient 429 path so both honour the same server-directed backoff. */
function parseRetryAfterSeconds(header: string | null | undefined): number | undefined {
	if (!header) return undefined;
	const n = Number(header);
	if (Number.isFinite(n)) return n;
	const httpDate = Date.parse(header);
	if (Number.isFinite(httpDate)) {
		return Math.max(1, Math.ceil((httpDate - Date.now()) / 1000));
	}
	return undefined;
}

/** Per-provider concurrency configuration. */
export interface ProviderConcurrencyConfig {
	/** Provider name (matches the `providers.<name>` key in models.json). */
	provider: string;
	/** Base URL prefix to match outbound requests (e.g. `https://api.code.umans.ai/v1`). */
	baseUrl: string;
	/** Max concurrent in-flight LLM requests to this provider. */
	maxConcurrentRequests: number;
	/** Per-session sticky-slot window in seconds (0 = disabled). When a
	 *  session's LLM call finishes, the slot it held stays reserved for THAT
	 *  session for this many seconds. A follow-up from the same session
	 *  reuses the reserved slot instead of re-queueing. */
	afterburnSeconds?: number;
	/** Max seconds a queued request waits for a slot before failing with a
	 *  retryable 429/503. 0 = unbounded. */
	queueWaitSeconds?: number;
	/** Max seconds to wait for the upstream response HEADERS before aborting
	 *  the request with a retryable error and releasing the slot. This bounds
	 *  the header phase so a stalled upstream (TCP open but no HTTP response)
	 *  cannot hold a concurrency slot indefinitely. 0 = use the gate-wide
	 *  default (passed to `install`). */
	headerWaitSeconds?: number;
	/** Consecutive transient failures (5xx / transport / header timeout /
	 *  rate-limit-without-Retry-After) that trip the transient circuit breaker
	 *  into the OPEN state. Defaults to 3. 0 disables the transient breaker
	 *  (failures still surface to the caller, but no shared open/probe). */
	breakerFailureThreshold?: number;
	/** Base cooldown (seconds) the transient breaker stays OPEN after tripping.
	 *  Doubles on each consecutive open (exponential backoff), capped by
	 *  `breakerMaxOpenSeconds`. Defaults to 30. */
	breakerOpenSeconds?: number;
	/** Hard cap (seconds) on the transient breaker OPEN cooldown — bounds both
	 *  the exponential backoff and a server-directed Retry-After. Defaults to 300. */
	breakerMaxOpenSeconds?: number;
}

/** Per-provider live metrics (for the status bar / aggregate stats). */
export interface ProviderGateMetrics {
	provider: string;
	activeRequests: number;
	queuedRequests: number;
	maxConcurrentRequests: number;
	/** Configured afterburn sticky-slot window (seconds; 0 = disabled). */
	afterburnSeconds: number;
	/** Max seconds a queued request waits for a slot before failing with a
	 *  retryable 429/503 (0 = unbounded). Surfaced end-to-end so the host's
	 *  send-timer can size its prepass headroom to the real configured bound
	 *  (FP-C3) instead of a hardcoded 30s default. */
	queueWaitSeconds: number;
	/** True if the circuit breaker is currently armed (account paused). */
	paused: boolean;
	/** Epoch-ms until which the provider is paused (0 = not paused). */
	pausedUntilMs: number;
	/** Consecutive pause events (backoff escalation count). */
	strikeCount: number;
	/** Transient circuit-breaker state. `closed` = healthy; `open` = short-
	 *  circuiting requests until the cooldown elapses; `half-open` = a single
	 *  probe request is admitted to test recovery. Distinct from `paused`
	 *  (which reflects the hard, body-driven account-suspension breaker). */
	breakerState: 'closed' | 'open' | 'half-open';
	/** Epoch-ms until which the transient breaker is OPEN (0 when closed/half-open). */
	breakerOpenUntilMs: number;
	/** Consecutive transient failures since the last success (reset on close). */
	transientFailures: number;
	/** True when a half-open probe request is in flight (only one at a time). */
	breakerProbeInFlight: boolean;
}

/** Per-provider circuit-breaker state (account-pause detection). */
interface AccountPauseState {
	/** Epoch-ms timestamp after which new requests are allowed again. */
	pausedUntil: number;
	/** Number of consecutive pause events (for backoff escalation). */
	strikeCount: number;
}

/** Per-provider transient circuit-breaker state. Distinct from the account-
 *  pause breaker (a hard, body-driven suspension window with a known
 *  reactivation timestamp): this breaker trips on bounded transient failures
 *  (5xx bursts, transport errors, header timeouts, rate-limit 429s) and
 *  recovers via a half-open probe so a provider-wide outage does not cause a
 *  retry storm across parallel children. See `HANDOFF_SUBAGENT_PROVIDER_
 *  RESILIENCE.md` §E (provider circuit breaking and failover). */
interface TransientBreakerState {
	status: 'closed' | 'open' | 'half-open';
	/** Epoch-ms until which the breaker is OPEN (0 when closed/half-open). */
	openUntil: number;
	/** Consecutive transient failures since the last success (reset on close). */
	consecutiveFailures: number;
	/** True when a half-open probe request is in flight (only one at a time). */
	probeInFlight: boolean;
	/** Consecutive OPEN events (for exponential backoff). Reset on a successful
	 *  close (probe success). */
	openCount: number;
	/** Reason the breaker last opened (for metrics/error text). */
	reason: string;
}

/** A concurrency slot with optional afterburn sticky-hold. */
interface ConcurrencySlot {
	index: number;
	inFlight: boolean;
	/** Session ID that last held this slot (for afterburn reuse). */
	holder: string | null;
	/** Monotonic-ms timestamp until which this slot is reserved for `holder`. */
	holdUntil: number;
}

// ── Shared provider state across pool generations ───────────────────────────────

/** Provider state that survives pool reconfiguration. The ProviderGate rebuilds
 *  ProviderPool instances on settings changes, but active in-flight work and
 *  circuit-breaker history must stay shared so metrics do not reset and new
 *  requests cannot oversubscribe the provider while old requests drain. */
class SharedProviderState {
	/** In-flight requests across all pool generations for this provider. */
	private active = 0;

	/** Account-pause circuit breaker. */
	private circuitBreaker: AccountPauseState = { pausedUntil: 0, strikeCount: 0 };

	/** Transient circuit breaker (5xx/transport/header/rate-limit). */
	private transient: TransientBreakerState = {
		status: 'closed',
		openUntil: 0,
		consecutiveFailures: 0,
		probeInFlight: false,
		openCount: 0,
		reason: '',
	};

	/** Wake callback for the current (newest) ProviderPool. Old in-flight
	 *  requests notify this callback on release so queued waiters on the new
	 *  pool are unblocked promptly. */
	private currentPoolWake: (() => void) | null = null;

	setCurrentPoolWake(wake: (() => void) | null): void {
		this.currentPoolWake = wake;
	}

	notifySlotFreed(): void {
		this.currentPoolWake?.();
	}

	get activeCount(): number {
		return this.active;
	}

	incrementActive(): void {
		this.active++;
	}

	decrementActive(): void {
		this.active = Math.max(0, this.active - 1);
	}

	// ── Account-pause circuit breaker ───────────────────────────────────────

	isPaused(): boolean {
		return Date.now() < this.circuitBreaker.pausedUntil;
	}

	pausedUntilMs(): number {
		return this.circuitBreaker.pausedUntil;
	}

	strikeCount(): number {
		return this.circuitBreaker.strikeCount;
	}

	recordPause(pauseUntilMs?: number, retryAfterSeconds?: number): void {
		const now = Date.now();

		if (pauseUntilMs && pauseUntilMs > now) {
			this.circuitBreaker.strikeCount++;
			if (pauseUntilMs > this.circuitBreaker.pausedUntil) {
				this.circuitBreaker.pausedUntil = pauseUntilMs;
			}
			return;
		}

		this.circuitBreaker.strikeCount++;
		const backoff = (retryAfterSeconds ?? Math.min(60, 10 * this.circuitBreaker.strikeCount)) * 1000;
		const candidate = now + backoff;
		if (candidate > this.circuitBreaker.pausedUntil) {
			this.circuitBreaker.pausedUntil = candidate;
		}
	}

	clearPause(): void {
		if (this.circuitBreaker.strikeCount > 0) {
			this.circuitBreaker = { pausedUntil: 0, strikeCount: 0 };
		}
	}

	// ── Transient circuit breaker ─────────────────────────────────────────────

	admitTransient(breakerOpenMs: number): { allowed: true; probe: boolean } | { allowed: false; retryAfterMs: number } {
		const t = this.transient;
		if (t.status === 'closed') return { allowed: true, probe: false };
		const now = Date.now();
		if (t.status === 'open') {
			if (now < t.openUntil) return { allowed: false, retryAfterMs: t.openUntil - now };
			t.status = 'half-open';
			t.probeInFlight = true;
			return { allowed: true, probe: true };
		}
		if (t.probeInFlight) {
			return { allowed: false, retryAfterMs: Math.min(breakerOpenMs, 1000) };
		}
		t.probeInFlight = true;
		return { allowed: true, probe: true };
	}

	abandonTransientProbe(): void {
		const t = this.transient;
		if (t.status !== 'half-open' || !t.probeInFlight) return;
		t.probeInFlight = false;
		t.status = 'open';
		t.openUntil = Date.now();
	}

	recordTransientSuccess(): void {
		const t = this.transient;
		if (t.status === 'half-open' && t.probeInFlight) {
			this.transient = {
				status: 'closed',
				openUntil: 0,
				consecutiveFailures: 0,
				probeInFlight: false,
				openCount: 0,
				reason: '',
			};
			return;
		}
		if (t.status === 'closed') {
			t.consecutiveFailures = 0;
		}
	}

	recordTransientFailure(
		opts: { reason: string; retryAfterSeconds?: number },
		breakerThreshold: number,
		breakerOpenMs: number,
		breakerMaxOpenMs: number,
	): void {
		const t = this.transient;
		const now = Date.now();

		if (t.status === 'half-open' && t.probeInFlight) {
			t.probeInFlight = false;
			t.consecutiveFailures++;
			this.openTransient(now, opts.reason, opts.retryAfterSeconds, breakerOpenMs, breakerMaxOpenMs);
			return;
		}

		if (t.status === 'closed') {
			t.consecutiveFailures++;
			if (opts.retryAfterSeconds !== undefined) {
				this.openTransient(now, opts.reason, opts.retryAfterSeconds, breakerOpenMs, breakerMaxOpenMs);
				return;
			}
			if (breakerThreshold > 0 && t.consecutiveFailures >= breakerThreshold) {
				this.openTransient(now, opts.reason, undefined, breakerOpenMs, breakerMaxOpenMs);
			}
			return;
		}

		if (opts.retryAfterSeconds !== undefined) {
			const candidate = now + Math.min(Math.max(1, opts.retryAfterSeconds) * 1000, breakerMaxOpenMs);
			if (candidate > t.openUntil) t.openUntil = candidate;
		}
	}

	transientOpenUntilMs(): number {
		return this.transient.openUntil;
	}

	transientStatus(): 'closed' | 'open' | 'half-open' {
		return this.transient.status;
	}

	transientFailureCount(): number {
		return this.transient.consecutiveFailures;
	}

	transientProbeInFlight(): boolean {
		return this.transient.probeInFlight;
	}

	private openTransient(
		now: number,
		reason: string,
		retryAfterSeconds: number | undefined,
		breakerOpenMs: number,
		breakerMaxOpenMs: number,
	): void {
		const t = this.transient;
		t.status = 'open';
		t.reason = reason;
		t.openCount++;
		let cooldownMs: number;
		if (retryAfterSeconds !== undefined) {
			cooldownMs = Math.min(Math.max(1, retryAfterSeconds) * 1000, breakerMaxOpenMs);
		} else {
			const exp = t.openCount - 1;
			cooldownMs = Math.min(breakerOpenMs * 2 ** exp, breakerMaxOpenMs);
		}
		const candidate = now + cooldownMs;
		if (candidate > t.openUntil) t.openUntil = candidate;
	}
}

// ── Per-provider concurrency pool ──────────────────────────────────────────────

interface QueuedWaiter {
	resolve: () => void;
	reject: (error: unknown) => void;
	signal?: AbortSignal;
	/** Queue priority for this waiter (lower = higher priority). */
	priority: number;
	/** Monotonic enqueue order — preserves FIFO within a priority band. */
	seq: number;
}

class ProviderPool {
	slots: ConcurrencySlot[];
	readonly afterburnMs: number;
	readonly queueWaitMs: number;
	private waiters: QueuedWaiter[] = [];
	/** One deterministic wake-up for the earliest sticky hold that can expire. */
	private holdWakeTimer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;
	/** Monotonic enqueue counter — preserves FIFO within a priority band. */
	private waiterSeq = 0;
	readonly breakerThreshold: number;
	readonly breakerOpenMs: number;
	readonly breakerMaxOpenMs: number;

	constructor(
		readonly provider: string,
		readonly maxConcurrent: number,
		afterburnSeconds: number,
		queueWaitSeconds: number,
		readonly shared: SharedProviderState,
		breakerFailureThreshold?: number,
		breakerOpenSeconds?: number,
		breakerMaxOpenSeconds?: number,
	) {
		this.slots = Array.from({ length: Math.max(1, maxConcurrent) }, (_, i) => ({
			index: i,
			inFlight: false,
			holder: null,
			holdUntil: 0,
		}));
		this.afterburnMs = Math.max(0, afterburnSeconds) * 1000;
		this.queueWaitMs = Math.max(0, queueWaitSeconds) * 1000;
		this.breakerThreshold = Math.max(0, breakerFailureThreshold ?? 3);
		this.breakerOpenMs = Math.max(0, (breakerOpenSeconds ?? 30)) * 1000;
		const maxOpenS = Math.max(0, breakerMaxOpenSeconds ?? 300);
		this.breakerMaxOpenMs = Math.max(this.breakerOpenMs, maxOpenS * 1000);
		this.shared.setCurrentPoolWake(() => this.wakeWaiters());
	}

	get activeRequests(): number {
		return this.shared.activeCount;
	}

	get queuedRequests(): number {
		return this.waiters.length;
	}

	isPaused(): boolean {
		return this.shared.isPaused();
	}

	/** Epoch-ms until which the provider is paused (0 = not paused). */
	pausedUntilMs(): number {
		return this.shared.pausedUntilMs();
	}

	/** Circuit-breaker strike count (for metrics / backoff observability). */
	strikeCount(): number {
		return this.shared.strikeCount();
	}

	/** Record an account-pause event. */
	recordPause(pauseUntilMs?: number, retryAfterSeconds?: number): void {
		this.shared.recordPause(pauseUntilMs, retryAfterSeconds);
	}

	/** Clear the circuit breaker after a successful request. */
	clearPause(): void {
		this.shared.clearPause();
	}

	// ── Transient circuit breaker (5xx / transport / header / rate-limit) ──────

	/** Admit a request through the transient breaker. */
	admitTransient(): { allowed: true; probe: boolean } | { allowed: false; retryAfterMs: number } {
		return this.shared.admitTransient(this.breakerOpenMs);
	}

	/** A half-open probe was admitted but never reached a provider outcome. */
	abandonTransientProbe(): void {
		this.shared.abandonTransientProbe();
	}

	/** Record a successful response. */
	recordTransientSuccess(): void {
		this.shared.recordTransientSuccess();
	}

	/** Record a transient failure. */
	recordTransientFailure(opts: { reason: string; retryAfterSeconds?: number }): void {
		this.shared.recordTransientFailure(opts, this.breakerThreshold, this.breakerOpenMs, this.breakerMaxOpenMs);
	}

	/** Epoch-ms until which the transient breaker is OPEN (0 when not open). */
	transientOpenUntilMs(): number {
		return this.shared.transientOpenUntilMs();
	}

	/** Current transient breaker status (for metrics). */
	transientStatus(): 'closed' | 'open' | 'half-open' {
		return this.shared.transientStatus();
	}

	/** Consecutive transient failures since the last success (for metrics). */
	transientFailureCount(): number {
		return this.shared.transientFailureCount();
	}

	/** True when a half-open probe is in flight (for metrics). */
	transientProbeInFlight(): boolean {
		return this.shared.transientProbeInFlight();
	}

	private now(): number {
		// Use performance.now() for monotonic timing consistent with the proxy
		return performance.now();
	}

	/**
	 * Acquire a concurrency slot for a session. Resolves when a slot is
	 * available; rejects with `ProviderGateSaturatedError` if the queue-wait
	 * bound is exceeded, or `AbortError` if the signal fires while queued.
	 *
	 * Afterburn: if the session has a held (non-in-flight, within window)
	 * slot, it reuses that slot immediately without queueing.
	 *
	 * Priority: `requestClass` orders queued waiters — a `skill-pruner` call
	 * is unblocked ahead of `default` (main-session) calls when a slot opens,
	 * so a saturated pruner provider does not stall the session it is
	 * preflighting. Priority only affects queue ordering; an in-flight
	 * request is never preempted.
	 */
	async acquire(sessionId: string | null, signal?: AbortSignal, requestClass: ProviderGateRequestClass = 'default'): Promise<number> {
		if (this.disposed) throw new ProviderGatePoolDisposedError(this.provider);
		if (signal?.aborted) throw new ProviderGateAbortError();

		const now = this.now();

		// Fast path: reuse a held slot for this session (afterburn). The holder's
		// reservation remains valid even when other sessions are queued.
		if (sessionId && this.afterburnMs > 0 && this.shared.activeCount < this.maxConcurrent) {
			for (const s of this.slots) {
				if (!s.inFlight && s.holder === sessionId && s.holdUntil > now) {
					s.inFlight = true;
					s.holdUntil = 0;
					this.shared.incrementActive();
					this.scheduleHoldExpiryWake();
					return s.index;
				}
			}
		}

		const deadline = this.queueWaitMs > 0 ? now + this.queueWaitMs : 0;
		// Never let a new arrival bypass queued demand merely because its timer
		// callback has not run yet. Enqueue first; queueForSlot drains any holds
		// that are already expired using the complete priority queue.
		if (this.waiters.length > 0) {
			return this.queueForSlot(sessionId, signal, deadline, requestClass);
		}

		const slot = this.tryClaimFreeSlot(sessionId, now);
		if (slot !== null) {
			this.shared.incrementActive();
			return slot;
		}
		return this.queueForSlot(sessionId, signal, deadline, requestClass);
	}

	/** Claim a free or expired slot without checking the shared capacity or
	 *  mutating the shared active count. Returns null when no slot is available. */
	private claimSlot(sessionId: string | null, now: number): number | null {
		for (const s of this.slots) {
			if (s.inFlight) continue;
			if (s.holder !== null && s.holdUntil > now) continue; // held by another session
			// Free or expired hold.
			s.holder = null;
			s.holdUntil = 0;
			s.inFlight = true;
			s.holder = sessionId;
			return s.index;
		}
		return null;
	}

	private tryClaimFreeSlot(sessionId: string | null, now: number): number | null {
		if (this.shared.activeCount >= this.maxConcurrent) return null;
		return this.claimSlot(sessionId, now);
	}

	private async queueForSlot(sessionId: string | null, signal: AbortSignal | undefined, deadline: number, requestClass: ProviderGateRequestClass): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | null = null;
			const waiter: QueuedWaiter = {
				resolve: () => {},
				reject: () => {},
				signal,
				priority: REQUEST_CLASS_PRIORITY[requestClass],
				seq: this.waiterSeq++,
			};

			const cleanup = () => {
				const idx = this.waiters.indexOf(waiter);
				if (idx >= 0) this.waiters.splice(idx, 1);
				signal?.removeEventListener('abort', onAbort);
				if (timer) { clearTimeout(timer); timer = null; }
			};

			waiter.reject = (error: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
				this.scheduleHoldExpiryWake();
			};
			const onAbort = () => waiter.reject(new ProviderGateAbortError());
			if (signal) signal.addEventListener('abort', onAbort, { once: true });

			// Resolve function that transfers a currently available slot.
			waiter.resolve = () => {
				if (settled) return;
				settled = true;
				cleanup();
				const slot = this.tryClaimFreeSlot(sessionId, this.now());
				if (slot !== null) {
					this.shared.incrementActive();
					resolve(slot);
				} else {
					// Defensive retry: preserve the original absolute deadline and
					// request class if availability changed unexpectedly.
					this.queueForSlot(sessionId, signal, deadline, requestClass).then(resolve, reject);
				}
			};

			this.waiters.push(waiter);
			if (deadline > 0) {
				const remaining = deadline - this.now();
				if (remaining <= 0) {
					waiter.reject(new ProviderGateSaturatedError(this.provider, this.queueWaitMs));
					return;
				}
				timer = setTimeout(() => {
					waiter.reject(new ProviderGateSaturatedError(this.provider, this.queueWaitMs));
				}, remaining);
			}

			// This both schedules the next future expiry and synchronously drains a
			// hold whose deadline passed before its timer callback could run.
			this.wakeWaiters();
		});
	}

	/** Release a slot. Existing queued demand takes precedence over afterburn;
	 * sticky ownership is armed only while there is no queued demand. */
	release(slotIndex: number, sessionId: string | null, success: boolean): void {
		const s = this.slots[slotIndex];
		if (!s || !s.inFlight) return;
		s.inFlight = false;
		this.shared.decrementActive();

		if (this.waiters.length === 0 && success && sessionId && this.afterburnMs > 0 && !this.disposed) {
			s.holder = sessionId;
			s.holdUntil = this.now() + this.afterburnMs;
		} else {
			s.holder = null;
			s.holdUntil = 0;
		}
		this.wakeWaiters();
		// Notify the current generation pool so its queued waiters are unblocked
		// promptly when an old in-flight request releases.
		this.shared.notifySlotFreed();
	}

	/** Reject queued work and cancel local timers when this pool is replaced or
	 * the gate is uninstalled. In-flight requests still release their old slots
	 * normally, but no caller can remain attached to an unreachable pool. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.clearHoldWakeTimer();
		const error = new ProviderGatePoolDisposedError(this.provider);
		for (const waiter of [...this.waiters]) waiter.reject(error);
	}

	/** Transfer every currently free/expired slot to queued demand in priority
	 * order, then schedule exactly one wake-up for the next sticky expiry. */
	private wakeWaiters(): void {
		if (this.disposed) return;
		while (this.waiters.length > 0) {
			const now = this.now();
			const slotAvailable = this.slots.some((s) => !s.inFlight && (s.holder === null || s.holdUntil <= now));
			if (!slotAvailable) break;
			// Do not admit a waiter while the shared active count already equals
			// the current cap, because that capacity may be consumed by in-flight
			// requests from an older pool generation that is still draining.
			if (this.shared.activeCount >= this.maxConcurrent) break;
			const next = this.popNextWaiter();
			if (!next) break;
			next.resolve();
		}
		this.scheduleHoldExpiryWake();
	}

	/** Public hook so the shared state can wake the current pool when a slot
	 *  is freed by an older generation pool that is still draining. */
	wakeCurrentWaiters(): void {
		this.wakeWaiters();
	}

	private scheduleHoldExpiryWake(): void {
		this.clearHoldWakeTimer();
		if (this.disposed || this.waiters.length === 0) return;
		const now = this.now();
		let nextExpiry = Number.POSITIVE_INFINITY;
		for (const slot of this.slots) {
			if (!slot.inFlight && slot.holder !== null && slot.holdUntil > now) {
				nextExpiry = Math.min(nextExpiry, slot.holdUntil);
			}
		}
		if (!Number.isFinite(nextExpiry)) return;
		this.holdWakeTimer = setTimeout(() => {
			this.holdWakeTimer = null;
			this.wakeWaiters();
		}, Math.max(1, Math.ceil(nextExpiry - now)));
	}

	private clearHoldWakeTimer(): void {
		if (!this.holdWakeTimer) return;
		clearTimeout(this.holdWakeTimer);
		this.holdWakeTimer = null;
	}

	/** Remove and return the highest-priority queued waiter (lowest priority
	 *  number, then lowest enqueue seq). Returns undefined when the queue is
	 *  empty. */
	private popNextWaiter(): QueuedWaiter | undefined {
		if (this.waiters.length === 0) return undefined;
		let bestIdx = 0;
		for (let i = 1; i < this.waiters.length; i++) {
			const w = this.waiters[i];
			const best = this.waiters[bestIdx];
			if (w.priority < best.priority || (w.priority === best.priority && w.seq < best.seq)) {
				bestIdx = i;
			}
		}
		return this.waiters.splice(bestIdx, 1)[0];
	}
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class ProviderGateSaturatedError extends Error {
	readonly isRetryable = true;
	readonly httpStatus = 429;
	constructor(provider: string, queueWaitMs: number) {
		super(`Provider "${provider}" concurrency cap reached: waited ${queueWaitMs}ms without a slot. Retry after a brief delay.`);
		this.name = 'ProviderGateSaturatedError';
	}
}

export class ProviderGatePoolDisposedError extends Error {
	readonly isRetryable = true;
	readonly httpStatus = 503;
	constructor(provider: string) {
		super(`Provider "${provider}" concurrency pool was reconfigured or disposed while this request was queued (503 service unavailable). Retry the request.`);
		this.name = 'ProviderGatePoolDisposedError';
	}
}

export class ProviderGateAbortError extends Error {
	constructor(stage = 'waiting for provider concurrency slot') {
		super(`Aborted while ${stage}.`);
		this.name = 'AbortError';
	}
}

export class ProviderGatePauseError extends Error {
	readonly isRetryable = true;
	readonly httpStatus = 429;
	constructor(provider: string, pausedUntilMs: number) {
		const seconds = Math.ceil((pausedUntilMs - Date.now()) / 1000);
		super(`Provider "${provider}" is in an account-pause circuit-breaker window. Retrying in ~${seconds}s would deepen the pause. Wait and retry.`);
		this.name = 'ProviderGatePauseError';
	}
}

/** Raised when the upstream does not return response HEADERS within the
 *  configured `headerWaitSeconds`. This is a retryable condition — a transient
 *  network stall or a momentarily overloaded upstream should be retried after
 *  a brief backoff, not surfaced as a hard failure. The error text is matched
 *  by the SDK retry-classifier hot-patch (`upstream header phase stalled`). */
export class ProviderGateHeaderTimeoutError extends Error {
	readonly isRetryable = true;
	readonly httpStatus = 504;
	constructor(provider: string, waitMs: number) {
		super(`upstream header phase stalled: no response headers from provider "${provider}" within ${waitMs}ms.`);
		this.name = 'ProviderGateHeaderTimeoutError';
	}
}

/** Raised when the transient circuit breaker is OPEN (or a half-open probe is
 *  already in flight) and short-circuits a request before it acquires a slot.
 *  This is a retryable condition — the SDK retry classifier matches `503` /
 *  `service unavailable` in the message, so the turn backs off and retries
 *  once the breaker recovers (via a half-open probe). `retryAfterMs` carries
 *  the breaker's remaining cooldown for callers that honour an explicit backoff.
 *  Distinct from `ProviderGatePauseError` (the hard, body-driven account-
 *  suspension breaker): a transient open recovers via a probe, not a fixed
 *  reactivation timestamp. */
export class ProviderGateTransientPauseError extends Error {
	readonly isRetryable = true;
	readonly httpStatus = 503;
	constructor(provider: string, retryAfterMs: number) {
		const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
		super(
			`Provider "${provider}" circuit breaker open (503 service unavailable): too many recent transient failures. Retry after ~${seconds}s.`,
		);
		this.name = 'ProviderGateTransientPauseError';
	}
}

/** Raised for authentication / permission failures (HTTP 401, or 403 that is
 *  NOT an account suspension). Actionable and NON-retriable: the SDK retry
 *  classifier does not match its message (no `429`/`5xx`/`rate limit`/
 *  `timeout`/`connection` triggers), so the turn surfaces the error immediately
 *  instead of retrying the same bad credentials. Does NOT trip the transient
 *  circuit breaker — a credential/permission problem is not a provider outage,
 *  and suppressing it behind an open breaker would hide the actionable cause. */
export class ProviderGateAuthError extends Error {
	readonly isRetryable = false;
	readonly httpStatus: number;
	constructor(provider: string, status: number) {
		super(
			`Provider "${provider}" rejected the request: authentication or permission failed (HTTP ${status}). Check the API key and provider account permissions.`,
		);
		this.name = 'ProviderGateAuthError';
		this.httpStatus = status;
	}
}

// ── Provider Gate (singleton) ─────────────────────────────────────────────────

/**
 * The provider gate is a singleton installed once at backend startup. It wraps
 * `globalThis.fetch` with per-provider concurrency, stream-liveness, circuit
 * breaking, and metrics. Non-matching requests pass through unwrapped.
 *
 * Usage:
 *   const gate = ProviderGate.install(configs);
 *   // ... SDK runs, all fetch calls pass through the gate ...
 *   gate.getMetrics(); // read live metrics
 *
 * The gate is idempotent: calling `install()` again reconfigures the pools
 * (e.g. on settings change) without double-wrapping fetch.
 */
export class ProviderGate {
	private static instance: ProviderGate | null = null;
	private originalFetch: typeof globalThis.fetch | null = null;
	private pools = new Map<string, { pool: ProviderPool; baseUrl: string; headerWaitMs: number }>();
	/** Shared per-provider state that survives pool reconfiguration. */
	private sharedStates = new Map<string, SharedProviderState>();
	/** Effective configs (base configs with any live user overrides applied). */
	private configs: ProviderConcurrencyConfig[] = [];
	/** Immutable base configs derived from models.json — the starting point that
	 *  `applyUserOverrides` recomputes from each time (so removing an override
	 *  reverts to base rather than sticking). */
	private baseConfigs: ProviderConcurrencyConfig[] = [];
	/** provider → baseUrl for EVERY known provider (not just gated ones), so a
	 *  user override can gate a provider that had no base concurrency block. */
	private knownBaseUrls = new Map<string, string>();
	private idleTimeoutMs: number;
	private defaultHeaderWaitMs: number;

	private constructor(
		configs: ProviderConcurrencyConfig[],
		idleTimeoutSeconds: number,
		knownBaseUrls?: Map<string, string>,
	) {
		this.configs = configs;
		this.baseConfigs = configs;
		this.knownBaseUrls = knownBaseUrls ?? new Map(configs.map((c) => [c.provider, c.baseUrl]));
		this.idleTimeoutMs = Math.max(0, idleTimeoutSeconds) * 1000;
		// Gate-wide default for the header-phase bound (replaces the proxy's
		// raw-ASGI middleware header-phase bound). Individual providers may
		// override via `headerWaitSeconds` in their concurrency config.
		this.defaultHeaderWaitMs = 120_000;
		this.rebuildPools();
	}

	/** Install (or reconfigure) the provider gate. Wraps `globalThis.fetch`.
	 *  `knownBaseUrls` maps EVERY provider to its baseUrl (from models.json) so
	 *  a user override can gate a provider that shipped no base concurrency
	 *  block; when omitted it is derived from the gated configs. */
	static install(
		configs: ProviderConcurrencyConfig[],
		idleTimeoutSeconds = 120,
		knownBaseUrls?: Map<string, string>,
	): ProviderGate {
		if (ProviderGate.instance) {
			ProviderGate.instance.reconfigure(configs, idleTimeoutSeconds, knownBaseUrls);
			return ProviderGate.instance;
		}
		ProviderGate.instance = new ProviderGate(configs, idleTimeoutSeconds, knownBaseUrls);
		ProviderGate.instance.wrapFetch();
		return ProviderGate.instance;
	}

	/** Get the installed instance, or null if not installed. */
	static getInstance(): ProviderGate | null {
		return ProviderGate.instance;
	}

	/** Remove the fetch wrapper (for tests / disposal). */
	static uninstall(): void {
		if (ProviderGate.instance) {
			ProviderGate.instance.disposePools();
			if (ProviderGate.instance.originalFetch) {
				globalThis.fetch = ProviderGate.instance.originalFetch;
				ProviderGate.instance.originalFetch = null;
			}
		}
		ProviderGate.instance = null;
	}

	/** Reconfigure the pools without re-wrapping fetch (idempotent re-install). */
	reconfigure(
		configs: ProviderConcurrencyConfig[],
		idleTimeoutSeconds: number,
		knownBaseUrls?: Map<string, string>,
	): void {
		this.configs = configs;
		this.baseConfigs = configs;
		if (knownBaseUrls) this.knownBaseUrls = knownBaseUrls;
		else this.knownBaseUrls = new Map(configs.map((c) => [c.provider, c.baseUrl]));
		this.idleTimeoutMs = Math.max(0, idleTimeoutSeconds) * 1000;
		this.rebuildPools();
	}

	/** Apply user-configured per-provider concurrency overrides on top of the
	 *  models.json base configs and rebuild the pools live. Called from the
	 *  `runtimePrefs.set` handler when the user changes concurrency settings
	 *  in the Providers tab. No restart needed — the new pools take effect
	 *  immediately for new requests; in-flight requests continue on their
	 *  existing slots. */
	applyUserOverrides(overrides: Record<string, {
		maxConcurrentRequests?: number;
		afterburnSeconds?: number;
		queueWaitSeconds?: number;
		headerWaitSeconds?: number;
	}>): void {
		// Recompute effective configs from the immutable base each time so that
		// clearing an override reverts to base instead of sticking. Keyed by
		// provider for O(1) merge + insertion of newly-gated providers.
		const byProvider = new Map<string, ProviderConcurrencyConfig>(
			this.baseConfigs.map((cfg) => [cfg.provider, { ...cfg }]),
		);
		for (const [provider, ov] of Object.entries(overrides)) {
			if (!ov) continue;
			const existing = byProvider.get(provider);
			if (existing) {
				// Merge onto the provider's base config (shallow per-field).
				byProvider.set(provider, {
					...existing,
					...(ov.maxConcurrentRequests !== undefined && { maxConcurrentRequests: ov.maxConcurrentRequests }),
					...(ov.afterburnSeconds !== undefined && { afterburnSeconds: ov.afterburnSeconds }),
					...(ov.queueWaitSeconds !== undefined && { queueWaitSeconds: ov.queueWaitSeconds }),
					...(ov.headerWaitSeconds !== undefined && { headerWaitSeconds: ov.headerWaitSeconds }),
				});
				continue;
			}
			// Provider had no base concurrency block. Gate it from the override
			// alone — provided we know its baseUrl (to match outbound requests)
			// and the override sets a positive concurrency cap. This is what makes
			// the gate provider-agnostic: any provider can be capped from the UI.
			const baseUrl = this.knownBaseUrls.get(provider);
			if (!baseUrl) continue;
			if (typeof ov.maxConcurrentRequests !== 'number' || ov.maxConcurrentRequests <= 0) continue;
			byProvider.set(provider, {
				provider,
				baseUrl,
				maxConcurrentRequests: ov.maxConcurrentRequests,
				afterburnSeconds: ov.afterburnSeconds,
				queueWaitSeconds: ov.queueWaitSeconds,
				headerWaitSeconds: ov.headerWaitSeconds,
			});
		}
		this.configs = [...byProvider.values()];
		this.rebuildPools();
	}

	private rebuildPools(): void {
		const oldPools = this.pools;
		const nextPools = new Map<string, { pool: ProviderPool; baseUrl: string; headerWaitMs: number }>();
		for (const cfg of this.configs) {
			let shared = this.sharedStates.get(cfg.provider);
			if (!shared) {
				shared = new SharedProviderState();
				this.sharedStates.set(cfg.provider, shared);
			}
			const pool = new ProviderPool(
				cfg.provider,
				cfg.maxConcurrentRequests,
				cfg.afterburnSeconds ?? 0,
				cfg.queueWaitSeconds ?? 30,
				shared,
				cfg.breakerFailureThreshold,
				cfg.breakerOpenSeconds,
				cfg.breakerMaxOpenSeconds,
			);
			shared.setCurrentPoolWake(() => pool.wakeCurrentWaiters());
			const headerWaitMs = (cfg.headerWaitSeconds ?? 0) > 0
				? cfg.headerWaitSeconds! * 1000
				: this.defaultHeaderWaitMs;
			nextPools.set(cfg.provider, { pool, baseUrl: cfg.baseUrl, headerWaitMs });
		}
		this.pools = nextPools;
		for (const entry of oldPools.values()) entry.pool.dispose();
	}

	private disposePools(): void {
		for (const entry of this.pools.values()) entry.pool.dispose();
		this.pools.clear();
		this.sharedStates.clear();
	}

	private wrapFetch(): void {
		if (this.originalFetch) return; // already wrapped
		this.originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			return this.handleFetch(input, init);
		}) as typeof globalThis.fetch;
	}

	/** Match a request URL to a configured provider and return its pool. */
	private matchProvider(url: string): { pool: ProviderPool; config: ProviderConcurrencyConfig; headerWaitMs: number } | null {
		for (const cfg of this.configs) {
			// Match by baseUrl prefix — handles path-style URLs.
			if (url.startsWith(cfg.baseUrl)) {
				const entry = this.pools.get(cfg.provider);
				if (entry) return { pool: entry.pool, config: cfg, headerWaitMs: entry.headerWaitMs };
			}
		}
		return null;
	}

	/** Extract session ID from request headers (x-session-affinity). */
	private extractSessionId(init: RequestInit | undefined): string | null {
		const headers = init?.headers;
		if (!headers) return null;
		let headersRecord: Record<string, string> = {};
		if (headers instanceof Headers) {
			headers.forEach((v, k) => { headersRecord[k.toLowerCase()] = v; });
		} else if (Array.isArray(headers)) {
			for (const [k, v] of headers) headersRecord[k.toLowerCase()] = v;
		} else if (typeof headers === 'object') {
			headersRecord = Object.fromEntries(
				Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
			);
		}
		return headersRecord['x-session-affinity'] ?? headersRecord['session_id'] ?? null;
	}

	/** Extract the request class from request headers (x-pi-request-class).
	 *  Drives queue priority when the provider is saturated — `skill-pruner`
	 *  prepass calls jump ahead of main-session calls so a saturated pruner
	 *  provider does not stall the session it is preflighting. Unknown / absent
	 *  values map to `default`. */
	private extractRequestClass(init: RequestInit | undefined): ProviderGateRequestClass {
		const headers = init?.headers;
		if (!headers) return 'default';
		let headersRecord: Record<string, string> = {};
		if (headers instanceof Headers) {
			headers.forEach((v, k) => { headersRecord[k.toLowerCase()] = v; });
		} else if (Array.isArray(headers)) {
			for (const [k, v] of headers) headersRecord[k.toLowerCase()] = v;
		} else if (typeof headers === 'object') {
			headersRecord = Object.fromEntries(
				Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
			);
		}
		return parseRequestClass(headersRecord[PROVIDER_GATE_REQUEST_CLASS_HEADER]);
	}

	/** Core fetch handler: match → acquire → fetch (header-bounded) → wrap-stream → release-on-done. */
	private async handleFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const match = this.matchProvider(urlStr);

		// Non-LLM request — pass through unwrapped.
		if (!match) {
			return this.originalFetch!(input, init);
		}

		const { pool, config, headerWaitMs } = match;
		const sessionId = this.extractSessionId(init);
		const requestClass = this.extractRequestClass(init);
		const signal = init?.signal ?? undefined;

		// Circuit breaker: reject immediately if the provider is paused.
		if (pool.isPaused()) {
			throw new ProviderGatePauseError(config.provider, pool.pausedUntilMs());
		}

		// Transient circuit breaker: short-circuit if OPEN (or a probe is in
		// flight). Probe ownership is retained through the complete response body,
		// not merely through headers, so a stalled stream cannot count as recovery.
		const admission = pool.admitTransient();
		if (!admission.allowed) {
			throw new ProviderGateTransientPauseError(config.provider, admission.retryAfterMs);
		}

		// Acquire a concurrency slot. A half-open probe can be cancelled or time
		// out in this LOCAL queue before any provider traffic occurs; release probe
		// ownership on that path so the provider never remains half-open forever.
		let slotIndex: number;
		try {
			slotIndex = await pool.acquire(sessionId, signal, requestClass);
		} catch (error) {
			if (admission.probe) pool.abandonTransientProbe();
			throw error;
		}

		try {
			// Header-phase bound: race the upstream fetch against a timeout so
			// a stalled upstream (TCP open but no HTTP response) cannot hold a
			// concurrency slot indefinitely. The idle-chunk watchdog (armed in
			// wrapStream) only covers the BODY phase — headers must arrive first.
			const response = await this.fetchWithHeaderTimeout(input, init, config.provider, headerWaitMs, signal);

			// Account-pause detection: 429/403 with suspension body.
			const pauseInfo = await this.extractAccountPause(response, config.provider);
			if (pauseInfo) {
				// The provider responded coherently, so a half-open transient probe is
				// complete even though the separate account-pause breaker now owns it.
				pool.recordTransientSuccess();
				pool.recordPause(pauseInfo.pauseUntilMs, pauseInfo.retryAfterSeconds);
				pool.release(slotIndex, sessionId, false);
				return pauseInfo.reconstructed;
			}

			// Auth / permission failure (401, or 403 that is NOT a suspension).
			// Actionable + non-retried; does not trip the transient breaker
			// (a credential problem is not a provider outage). Slot release is
			// handled by the catch below.
			if (response.status === 401 || response.status === 403) {
				// Reachability was proven; do not strand a half-open probe behind an
				// actionable credential error.
				pool.recordTransientSuccess();
				throw new ProviderGateAuthError(config.provider, response.status);
			}

			// Transient 429 rate-limit (non-suspension).
			if (response.status === 429) {
				const retryAfter = parseRetryAfterSeconds(response.headers.get('retry-after'));
				if (retryAfter !== undefined) {
					// Respect the server-directed backoff: open the transient
					// breaker for the Retry-After window so parallel children (and
					// an over-eager SDK retry) back off. The 429 response is still
					// returned so the SDK applies its own retry policy; the open
					// breaker enforces the backoff across the process regardless.
					pool.recordTransientFailure({ reason: '429 rate limit (Retry-After)', retryAfterSeconds: retryAfter });
					pool.release(slotIndex, sessionId, false);
					return response;
				}
				// No Retry-After — feed the counter; the SDK retries per its
				// own policy, and a tripped breaker short-circuits later attempts.
				pool.recordTransientFailure({ reason: '429 rate limit (no Retry-After)' });
				pool.release(slotIndex, sessionId, false);
				return response;
			}

			// 5xx burst / 408 Request Timeout — transient. Feed the counter and
			// return the response so the SDK can retry; a tripped breaker will
			// short-circuit the SDK's next attempt (storm prevention).
			if (response.status >= 500 || response.status === 408) {
				pool.recordTransientFailure({ reason: `HTTP ${response.status}` });
				pool.release(slotIndex, sessionId, false);
				return response;
			}

			// Other non-OK 4xx prove provider reachability and therefore complete a
			// half-open probe, but are not successful requests for afterburn.
			if (!response.ok) {
				pool.recordTransientSuccess();
				pool.release(slotIndex, sessionId, false);
				return response;
			}

			pool.clearPause();

			// A streaming 2xx is successful only after its BODY completes. Marking
			// success at headers used to reset the breaker immediately before an idle
			// stall and incorrectly armed afterburn on stream errors.
			if (response.body) {
				return this.wrapStream(response, config.provider, pool, slotIndex, sessionId);
			}

			pool.recordTransientSuccess();
			pool.release(slotIndex, sessionId, true);
			return response;
		} catch (error) {
			// Caller cancellation often arrives from fetch as a DOMException rather
			// than ProviderGateAbortError. It is not provider health evidence and must
			// never trip the shared breaker under a mass parent/subagent abort.
			const callerAborted = signal?.aborted === true ||
				error instanceof ProviderGateAbortError ||
				(error as { name?: unknown } | null)?.name === 'AbortError';
			if (callerAborted) {
				if (admission.probe) pool.abandonTransientProbe();
			} else if (
				!(error instanceof ProviderGateAuthError) &&
				!(error instanceof ProviderGatePauseError) &&
				!(error instanceof ProviderGateTransientPauseError)
			) {
				if (error instanceof ProviderGateHeaderTimeoutError) {
					pool.recordTransientFailure({ reason: 'header timeout' });
				} else {
					pool.recordTransientFailure({ reason: 'transport error' });
				}
			}
			pool.release(slotIndex, sessionId, false);
			throw error;
		}
	}

	/** Fetch with a header-phase timeout. If the upstream does not return
	 *  response headers within `headerWaitMs`, the fetch is aborted and a
	 *  retryable `ProviderGateHeaderTimeoutError` is thrown. The caller's
	 *  `signal` (if any) is also honoured — an abort propagates as-is. */
	private async fetchWithHeaderTimeout(
		input: RequestInfo | URL,
		init: RequestInit | undefined,
		provider: string,
		headerWaitMs: number,
		signal: AbortSignal | undefined,
	): Promise<Response> {
		if (headerWaitMs <= 0) {
			return this.originalFetch!(input, init);
		}

		// Merge the caller's signal with our header-timeout signal. We can't
		// mutate the caller's init (it may be reused), so we create a fresh
		// controller and forward both abort sources.
		const controller = new AbortController();
		const onCallerAbort = () => controller.abort(signal?.reason);
		if (signal) {
			if (signal.aborted) {
				controller.abort(signal.reason);
			} else {
				signal.addEventListener('abort', onCallerAbort, { once: true });
			}
		}
		const timer = setTimeout(() => controller.abort(new ProviderGateHeaderTimeoutError(provider, headerWaitMs)), headerWaitMs);

		const mergedInit: RequestInit = { ...init, signal: controller.signal };
		try {
			return await this.originalFetch!(input, mergedInit);
		} catch (error) {
			// If the abort was triggered by OUR header timeout, surface the
			// retryable error (the SDK retry hot-patch matches its message).
			if (controller.signal.aborted) {
				const reason = controller.signal.reason;
				if (reason instanceof ProviderGateHeaderTimeoutError) {
					throw reason;
				}
			}
			throw error;
		} finally {
			clearTimeout(timer);
			if (signal) signal.removeEventListener('abort', onCallerAbort);
		}
	}

	// ── Account-pause body signatures ───────────────────────────────────────
	// The upstream umans account sends `account_suspended` / `cap_abuse` /
	// `access is paused`; LiteLLM (and the OpenAI SDK) wraps these as 429 /
	// 403 RateLimitError. We ONLY arm the circuit breaker when one of these
	// signatures is present in the body — a transient rate-limit 429 (a mere
	// per-minute burst) must NOT pause the provider, or a single burst wedges
	// every session for the cooldown window.
	private static readonly PAUSE_BODY_SIGNATURES = [
		'account_suspended',
		'access is paused',
		'cap_abuse',
		'account_paused',
		'upstream_account_paused',
	] as const;

	/** Regex matching the umans reactivation timestamp in the suspension body:
	 *  `reactivates automatically at 2026-07-08T14:30 UTC`. The time may be
	 *  separated by `T` or a space; seconds are optional. */
	private static readonly PAUSE_REACTIVATION_RE =
		/reactivates automatically at\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?)\s*UTC/i;

	/** Fallback cooldown (seconds) when the suspension body has no parseable
	 *  reactivation timestamp — bounded so we re-probe the upstream rather than
	 *  wedging forever. Mirrors the proxy's DEFAULT_PAUSE_COOLDOWN_S. */
	private static readonly DEFAULT_PAUSE_COOLDOWN_S = 60;

	/** Inspect a 429/403 response body for a real account-suspension signature.
	 *  Returns the parsed pause info (reactivation timestamp + retry-after
	 *  seconds) and a RECONSTRUCTED response (body re-consumed) so the caller
	 *  can still read it — or `null` if this is NOT a suspension (transient
	 *  rate-limit, auth error, etc.) and should NOT arm the breaker.
	 *
	 *  The body is consumed via `response.clone()` + `text()` so the original
	 *  response body remains readable by the SDK. */
	private async extractAccountPause(
		response: Response,
		_provider: string,
	): Promise<{ retryAfterSeconds: number | undefined; pauseUntilMs: number | undefined; reconstructed: Response } | null> {
		// Only inspect 429/403 — other statuses are never suspensions.
		if (response.status !== 429 && response.status !== 403) return null;

		// Clone so the SDK can still consume the original body.
		const cloneForInspection = response.clone();
		let bodyText: string;
		try {
			bodyText = await cloneForInspection.text();
		} catch {
			// Can't read body — don't arm the breaker (defensive).
			return null;
		}

		const lower = bodyText.toLowerCase();
		const isSuspension = ProviderGate.PAUSE_BODY_SIGNATURES.some((sig) => lower.includes(sig));
		if (!isSuspension) {
			// Transient 429 / 403 — NOT a suspension. Do NOT arm the breaker.
			return null;
		}

		// Parse the reactivation timestamp from the body.
		const m = ProviderGate.PAUSE_REACTIVATION_RE.exec(bodyText);
		let pauseUntilMs: number | undefined;
		let retryAfterSeconds: number | undefined;

		if (m) {
			// Normalise: `2026-07-08 14:30` → `2026-07-08T14:30` for Date.parse.
			const ts = m[1].replace(' ', 'T');
			const parsed = Date.parse(`${ts}Z`); // treat as UTC
			if (Number.isFinite(parsed)) {
				pauseUntilMs = parsed;
				retryAfterSeconds = Math.max(1, Math.ceil((parsed - Date.now()) / 1000));
			}
		}

		// Fallback to the HTTP Retry-After header (seconds or HTTP-date).
		if (retryAfterSeconds === undefined) {
			retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('retry-after'));
		}

		// Final fallback: bounded cooldown.
		if (retryAfterSeconds === undefined) {
			retryAfterSeconds = ProviderGate.DEFAULT_PAUSE_COOLDOWN_S;
		}

		// Reconstruct a readable response for the SDK (the original body was
		// consumed by the clone above; the original `response` is still intact
		// because we cloned before reading).
		const reconstructed = new Response(bodyText, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});

		return { retryAfterSeconds, pauseUntilMs, reconstructed };
	}

	/**
	 * Wrap a streaming response body. The slot is released when the stream
	 * completes, errors, or is cancelled. If `idleTimeoutMs > 0`, an idle-chunk
	 * watchdog is armed: if no chunk arrives within the timeout, the stream is
	 * terminated with a synthetic error (the SDK sees "Stream ended without
	 * finish_reason" which IS a retryable error per the retry classifier).
	 *
	 * This replaces both `wrap_stream_with_liveness` (idle watchdog) and the
	 * proxy's implicit slot release on stream completion.
	 */
	private wrapStream(response: Response, provider: string, pool: ProviderPool, slotIndex: number, sessionId: string | null): Response {
		const originalBody = response.body!;
		const idleTimeoutMs = this.idleTimeoutMs;
		const reader = originalBody.getReader();
		let released = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let settled = false;

		const releaseSlot = (outcome: 'success' | 'provider-failure' | 'cancelled') => {
			if (released) return;
			released = true;
			if (timer) { clearTimeout(timer); timer = null; }
			if (outcome === 'success') {
				pool.recordTransientSuccess();
			} else if (outcome === 'provider-failure') {
				pool.recordTransientFailure({ reason: 'stream failure' });
			} else {
				// Consumer cancellation is not provider health evidence. If this was a
				// half-open probe, allow a future request to probe again.
				pool.abandonTransientProbe();
			}
			pool.release(slotIndex, sessionId, outcome === 'success');
		};

		const clearTimer = () => {
			if (timer) { clearTimeout(timer); timer = null; }
		};

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const armTimer = () => {
					if (idleTimeoutMs <= 0) return;
					clearTimer();
					timer = setTimeout(() => {
						if (settled) return;
						settled = true;
						reader.cancel().catch(() => {});
						try {
							controller.error(
								new Error(`upstream stream stalled: no chunk for ${idleTimeoutMs / 1000}s (provider=${provider})`),
							);
						} catch { /* already closed */ }
						releaseSlot('provider-failure');
					}, idleTimeoutMs);
				};

				const pump = async () => {
					armTimer();
					try {
						while (true) {
							const { done, value } = await reader.read();
							clearTimer();
							if (settled) return;
							if (done) {
								controller.close();
								settled = true;
								releaseSlot('success');
								return;
							}
							if (value) {
								controller.enqueue(value);
							}
							armTimer();
						}
					} catch (err) {
						clearTimer();
						if (!settled) {
							settled = true;
							try { controller.error(err); } catch { /* already closed */ }
							releaseSlot('provider-failure');
						}
					}
				};

				pump();
			},

			cancel(reason) {
				if (settled) return;
				settled = true;
				clearTimer();
				reader.cancel(reason).catch(() => {});
				releaseSlot('cancelled');
			},
		});

		return new Response(stream, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}

	/** Get live metrics for all configured providers. */
	getMetrics(): ProviderGateMetrics[] {
		const result: ProviderGateMetrics[] = [];
		for (const [provider, entry] of this.pools) {
			result.push({
				provider,
				activeRequests: entry.pool.activeRequests,
				queuedRequests: entry.pool.queuedRequests,
				maxConcurrentRequests: entry.pool.maxConcurrent,
				afterburnSeconds: Math.round(entry.pool.afterburnMs / 1000),
				queueWaitSeconds: Math.round(entry.pool.queueWaitMs / 1000),
				paused: entry.pool.isPaused(),
				pausedUntilMs: entry.pool.pausedUntilMs(),
				strikeCount: entry.pool.strikeCount(),
				breakerState: entry.pool.transientStatus(),
				breakerOpenUntilMs: entry.pool.transientOpenUntilMs(),
				transientFailures: entry.pool.transientFailureCount(),
				breakerProbeInFlight: entry.pool.transientProbeInFlight(),
			});
		}
		return result.sort((a, b) => a.provider.localeCompare(b.provider));
	}

	/** Resolve concurrency config from the on-disk models.json. Each provider
	 *  entry may have a `concurrency` field (generated from models.yaml
	 *  `providers.<p>.concurrency`). Providers without a concurrency block are
	 *  not gated (direct, unthrottled). */
	static resolveConfigs(
		modelsJson: {
			providers?: Record<string, {
				baseUrl?: string;
				concurrency?: {
					maxConcurrentRequests?: number;
					afterburnSeconds?: number;
					queueWaitSeconds?: number;
					headerWaitSeconds?: number;
					breakerFailureThreshold?: number;
					breakerOpenSeconds?: number;
					breakerMaxOpenSeconds?: number;
				};
			}>;
		},
	): ProviderConcurrencyConfig[] {
		const configs: ProviderConcurrencyConfig[] = [];
		const providers = modelsJson.providers ?? {};
		for (const [name, entry] of Object.entries(providers)) {
			if (!entry.baseUrl) continue;
			const cc = entry.concurrency;
			if (!cc || typeof cc.maxConcurrentRequests !== 'number' || cc.maxConcurrentRequests <= 0) continue;
			configs.push({
				provider: name,
				baseUrl: entry.baseUrl,
				maxConcurrentRequests: cc.maxConcurrentRequests,
				afterburnSeconds: cc.afterburnSeconds ?? 0,
				queueWaitSeconds: cc.queueWaitSeconds ?? 30,
				headerWaitSeconds: cc.headerWaitSeconds,
				breakerFailureThreshold: cc.breakerFailureThreshold,
				breakerOpenSeconds: cc.breakerOpenSeconds,
				breakerMaxOpenSeconds: cc.breakerMaxOpenSeconds,
			});
		}
		return configs;
	}

	/** Map EVERY provider that has a `baseUrl` to that baseUrl (regardless of
	 *  whether it ships a `concurrency` block). Passed to `install` so a user
	 *  override can gate an otherwise-ungated provider — the gate needs the
	 *  baseUrl to match that provider's outbound requests. */
	static resolveBaseUrls(
		modelsJson: { providers?: Record<string, { baseUrl?: string }> },
	): Map<string, string> {
		const map = new Map<string, string>();
		for (const [name, entry] of Object.entries(modelsJson.providers ?? {})) {
			if (entry.baseUrl) map.set(name, entry.baseUrl);
		}
		return map;
	}
}
