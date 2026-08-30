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
	installProviderCapacityBridge,
	type ProviderCapacitySnapshot,
} from '../../../shared/provider-capacity-bridge.js';
import { publishProviderTransportObservation } from './provider-progress-bus.js';
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
	'session-title': 2,
};

/** Parse a request-class header value into a known class (unknown → default). */
function parseRequestClass(value: string | undefined | null): ProviderGateRequestClass {
	if (value === 'skill-pruner') return 'skill-pruner';
	if (value === 'session-title') return 'session-title';
	return 'default';
}

/** Per-provider concurrency configuration. */
export interface ProviderConcurrencyConfig {
	/** Provider name (matches the `providers.<name>` key in models.json). */
	provider: string;
	/** Base URL prefix declared in models.json. Optional for built-in providers:
	 * their effective URLs are registered from the SDK model registry after a
	 * runtime is created (including credential-specific OAuth endpoints). */
	baseUrl?: string;
	/** Additional effective model URL prefixes discovered at runtime. */
	baseUrls?: string[];
	/** Max concurrent in-flight LLM requests to this provider. */
	maxConcurrentRequests: number;
	/** Per-session sticky-slot window in seconds (0 = disabled). When a
	 *  session's LLM call finishes, the slot it held stays reserved for THAT
	 *  session for this many seconds. A follow-up from the same session
	 *  reuses the reserved slot instead of re-queueing. */
	afterburnSeconds?: number;
	/** Max seconds a queued request waits for a slot before failing with a
	 *  retryable 429/503. 0 selects the five-minute safety maximum. */
	queueWaitSeconds?: number;
	/** Max seconds to wait for the upstream response HEADERS before aborting
	 *  the request with a retryable error and releasing the slot. This bounds
	 *  the header phase so a stalled upstream (TCP open but no HTTP response)
	 *  cannot hold a concurrency slot indefinitely. 0 = use the gate-wide
	 *  default (passed to `install`). */
	headerWaitSeconds?: number;
}

	/** Per-provider live metrics (for the status bar / aggregate stats). */
export interface ProviderGateMetrics {
	provider: string;
	activeRequests: number;
	queuedRequests: number;
	maxConcurrentRequests: number;
	/** Configured afterburn sticky-slot window (seconds; 0 = disabled). */
	afterburnSeconds: number;
	/** Configured maximum queue wait before saturation fails. */
	queueWaitSeconds?: number;
	/** True if the circuit breaker is currently armed (account paused). */
	paused: boolean;
	/** Epoch-ms until which the provider is paused (0 = not paused). */
	pausedUntilMs: number;
	/** Consecutive pause events (backoff escalation count). */
	strikeCount: number;
}

/** Per-provider circuit-breaker state (account-pause detection). */
interface AccountPauseState {
	/** Epoch-ms timestamp after which new requests are allowed again. */
	pausedUntil: number;
	/** Number of consecutive pause events (for backoff escalation). */
	strikeCount: number;
}

interface TransportCircuitState {
	consecutiveFailures: number;
	openUntil: number;
	/** Monotonic probe ownership. A token is cleared only by the attempt that
	 * claimed it, so a stale queued attempt cannot release a newer probe. */
	nextProbeToken: number;
	activeProbeToken: number | null;
}

export interface ProviderGateResilienceOptions {
	/** Consecutive header stalls required to open the shared provider circuit. */
	transportFailureThreshold?: number;
	/** Initial circuit cooldown. Failed half-open probes increase it exponentially. */
	transportCircuitCooldownSeconds?: number;
}

const DEFAULT_TRANSPORT_FAILURE_THRESHOLD = 2;
const DEFAULT_TRANSPORT_CIRCUIT_COOLDOWN_SECONDS = 30;
const MAX_PAUSE_INSPECTION_BYTES = 1024 * 1024;

async function readBoundedInspectionBody(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
	const decoder = new TextDecoder();
	let body = '';
	let bytes = 0;
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) return body + decoder.decode();
		bytes += chunk.value.byteLength;
		if (bytes > MAX_PAUSE_INSPECTION_BYTES) {
			void reader.cancel('provider pause inspection body exceeded limit').catch(() => {});
			throw new Error('provider pause inspection body exceeded limit');
		}
		body += decoder.decode(chunk.value, { stream: true });
	}
}
const MAX_TRANSPORT_CIRCUIT_COOLDOWN_MS = 5 * 60_000;

/** A concurrency slot with optional afterburn sticky-hold. */
interface ConcurrencySlot {
	index: number;
	inFlight: boolean;
	/** Session ID that last held this slot (for afterburn reuse). */
	holder: string | null;
	/** Monotonic-ms timestamp until which this slot is reserved for `holder`. */
	holdUntil: number;
}

// ── Per-provider concurrency pool ──────────────────────────────────────────────

interface QueuedWaiter {
	resolve: () => void;
	reject: (error: unknown) => void;
	abortFn?: () => void;
	signal?: AbortSignal;
	/** Queue priority for this waiter (lower = higher priority). */
	priority: number;
	/** Monotonic enqueue order — preserves FIFO within a priority band. */
	seq: number;
	/** Session affinity is needed to transfer an afterburn-held slot without
	 * disturbing queue priority for waiters that cannot claim it. */
	sessionId: string | null;
}

const PROVIDER_QUEUE_WAIT_SAFETY_MAX_MS = 5 * 60 * 1000;

function normalizeQueueWaitMs(queueWaitSeconds: number): number {
	const requestedMs = Math.max(0, queueWaitSeconds) * 1000;
	return requestedMs > 0
		? Math.min(requestedMs, PROVIDER_QUEUE_WAIT_SAFETY_MAX_MS)
		: PROVIDER_QUEUE_WAIT_SAFETY_MAX_MS;
}

class ProviderPool {
	slots: ConcurrencySlot[];
	private configuredMaxConcurrent: number;
	private configuredAfterburnMs: number;
	private configuredQueueWaitMs: number;
	private waiters: QueuedWaiter[] = [];
	private holdWakeTimer: ReturnType<typeof setTimeout> | null = null;
	private circuitBreaker: AccountPauseState = { pausedUntil: 0, strikeCount: 0 };
	private circuitGeneration = 0;
	private disposed = false;
	/** Monotonic enqueue counter — preserves FIFO within a priority band. */
	private waiterSeq = 0;

	constructor(readonly provider: string, maxConcurrent: number, afterburnSeconds: number, queueWaitSeconds: number) {
		this.configuredMaxConcurrent = Math.max(1, Math.floor(maxConcurrent));
		this.configuredAfterburnMs = Math.max(0, afterburnSeconds) * 1000;
		this.configuredQueueWaitMs = normalizeQueueWaitMs(queueWaitSeconds);
		this.slots = Array.from({ length: this.configuredMaxConcurrent }, (_, i) => ({
			index: i,
			inFlight: false,
			holder: null,
			holdUntil: 0,
		}));
	}

	get maxConcurrent(): number {
		return this.configuredMaxConcurrent;
	}

	get afterburnMs(): number {
		return this.configuredAfterburnMs;
	}

	get queueWaitMs(): number {
		return this.configuredQueueWaitMs;
	}

	/** Update live bounds without replacing the pool. Keeping this object is
	 * what preserves in-flight permits, queued waiters, sticky holds, and the
	 * account-pause breaker across settings changes. Shrinking is conservative:
	 * existing requests finish on their original slot, while new admissions wait
	 * until active work is below the new cap. */
	reconfigure(maxConcurrent: number, afterburnSeconds: number, queueWaitSeconds: number): void {
		const nextMax = Math.max(1, Math.floor(maxConcurrent));
		const nextAfterburnMs = Math.max(0, afterburnSeconds) * 1000;
		const now = this.now();

		while (this.slots.length < nextMax) {
			const index = this.slots.length;
			this.slots.push({ index, inFlight: false, holder: null, holdUntil: 0 });
		}

		// A shorter/disabled afterburn setting may release existing idle holds,
		// but never extends a hold merely because preferences were reapplied.
		for (const slot of this.slots) {
			if (slot.inFlight) continue;
			if (slot.index >= nextMax || nextAfterburnMs === 0) {
				slot.holder = null;
				slot.holdUntil = 0;
			} else if (nextAfterburnMs < this.configuredAfterburnMs && slot.holder !== null) {
				slot.holdUntil = Math.min(slot.holdUntil, now + nextAfterburnMs);
			}
		}

		this.configuredMaxConcurrent = nextMax;
		this.configuredAfterburnMs = nextAfterburnMs;
		this.configuredQueueWaitMs = normalizeQueueWaitMs(queueWaitSeconds);
		this.wakeEligibleWaiters();
	}

	get activeRequests(): number {
		return this.slots.filter((s) => s.inFlight).length;
	}

	get queuedRequests(): number {
		return this.waiters.length;
	}

	isPaused(): boolean {
		return Date.now() < this.circuitBreaker.pausedUntil;
	}

	/** Whether a new, unrelated session can claim a slot without queueing.
	 *  In-flight and afterburn-held slots are unavailable; queued waiters keep
	 *  priority over a new unrelated session. */
	canClaimImmediatelyForUnrelatedSession(): boolean {
		if (this.isPaused() || this.waiters.length > 0) return false;
		if (this.activeRequests >= this.maxConcurrent) return false;
		const now = this.now();
		return this.slots.some((slot) => slot.index < this.maxConcurrent &&
			!slot.inFlight && (slot.holder === null || slot.holdUntil <= now),
		);
	}

	/** Exact pre-acquire classification for one session (includes afterburn). */
	canClaimImmediately(sessionId: string | null): boolean {
		if (this.isPaused() || this.waiters.length > 0) return false;
		if (this.activeRequests >= this.maxConcurrent) return false;
		const now = this.now();
		if (sessionId && this.afterburnMs > 0 && this.slots.some((slot) => slot.index < this.maxConcurrent &&
			!slot.inFlight && slot.holder === sessionId && slot.holdUntil > now,
		)) return true;
		return this.slots.some((slot) => slot.index < this.maxConcurrent &&
			!slot.inFlight && (slot.holder === null || slot.holdUntil <= now),
		);
	}

	/** Epoch-ms until which the provider is paused (0 = not paused). */
	pausedUntilMs(): number {
		return this.circuitBreaker.pausedUntil;
	}

	/** Circuit-breaker strike count (for metrics / backoff observability). */
	strikeCount(): number {
		return this.circuitBreaker.strikeCount;
	}

	pauseGeneration(): number {
		return this.circuitGeneration;
	}

	/** Record an account-pause event.
	 *
	 *  `pauseUntilMs` — if the upstream body carried an explicit reactivation
	 *  timestamp (epoch ms), pass it here; the breaker honours it directly
	 *  (keeping the LONGER of the new and existing pause, since umans can
	 *  extend the pause on continued traffic). Pass 0/undefined to fall back
	 *  to a bounded cooldown derived from `retryAfterSeconds` (or a strike-
	 *  count backoff if that is also absent). */
	recordPause(pauseUntilMs?: number, retryAfterSeconds?: number): void {
		const now = Date.now();
		this.circuitGeneration += 1;

		// Explicit reactivation timestamp from the body wins over the header.
		if (pauseUntilMs && pauseUntilMs > now) {
			this.circuitBreaker.strikeCount++;
			// Keep the LONGER pause (upstream may extend on continued traffic).
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

	/** Clear the circuit breaker after a successful request. */
	clearPause(admissionGeneration: number): void {
		if (admissionGeneration === this.circuitGeneration && this.circuitBreaker.strikeCount > 0) {
			this.circuitBreaker = { pausedUntil: 0, strikeCount: 0 };
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.holdWakeTimer) {
			clearTimeout(this.holdWakeTimer);
			this.holdWakeTimer = null;
		}
		for (const waiter of [...this.waiters]) {
			if (waiter.abortFn) waiter.abortFn();
			else waiter.reject(new ProviderGateAbortError('disposing provider gate'));
		}
		this.waiters = [];
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
		if (this.disposed) throw new ProviderGateAbortError('disposing provider gate');
		if (signal?.aborted) throw new ProviderGateAbortError();

		const now = this.now();

		// Fast path: reuse a held slot for this session (afterburn).
		if (sessionId && this.afterburnMs > 0) {
			for (const s of this.slots) {
				if (s.index >= this.maxConcurrent || this.activeRequests >= this.maxConcurrent) break;
				if (!s.inFlight && s.holder === sessionId && s.holdUntil > now) {
					s.inFlight = true;
					s.holdUntil = 0;
					return s.index;
				}
			}
		}

		// Try to find a free slot.
		const slot = this.tryClaimFreeSlot(sessionId, now);
		if (slot !== null) return slot;

		// No free slot — queue.
		const deadline = this.queueWaitMs > 0 ? now + this.queueWaitMs : 0;
		return this.queueForSlot(sessionId, signal, deadline, requestClass);
	}

	private tryClaimFreeSlot(sessionId: string | null, now: number): number | null {
		if (this.activeRequests >= this.maxConcurrent) return null;
		for (const s of this.slots) {
			if (s.index >= this.maxConcurrent) break;
			if (s.inFlight) continue;
			if (sessionId && s.holder === sessionId && s.holdUntil > now) {
				s.inFlight = true;
				s.holdUntil = 0;
				return s.index;
			}
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

	private async queueForSlot(sessionId: string | null, signal: AbortSignal | undefined, deadline: number, requestClass: ProviderGateRequestClass): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			const waiter: QueuedWaiter = {
				resolve: () => {},
				reject,
				signal,
				priority: REQUEST_CLASS_PRIORITY[requestClass],
				seq: this.waiterSeq++,
				sessionId,
			};
			this.waiters.push(waiter);

			let settled = false;
			let timer: ReturnType<typeof setTimeout> | null = null;

			const cleanup = () => {
				const idx = this.waiters.indexOf(waiter);
				if (idx >= 0) this.waiters.splice(idx, 1);
				signal?.removeEventListener('abort', onAbort);
				if (timer) { clearTimeout(timer); timer = null; }
				this.scheduleHoldWakeup();
			};

			const onAbort = () => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new ProviderGateAbortError());
			};
			waiter.abortFn = onAbort;
			if (signal) signal.addEventListener('abort', onAbort, { once: true });

			// Resolve function that transfers a slot to this waiter.
			waiter.resolve = () => {
				if (settled) return;
				settled = true;
				cleanup();
				// Claim a slot now — release() guarantees one is available.
				const slot = this.tryClaimFreeSlot(sessionId, this.now());
				if (slot !== null) {
					resolve(slot);
				} else {
					// Race: hold expired, another waiter got it. Retry queue.
					// This is extremely unlikely with small pools. Re-queue
					// preserves the original request class so priority survives.
					this.queueForSlot(sessionId, signal, deadline, requestClass).then(resolve, reject);
				}
			};

			// Deadline timeout.
			if (deadline > 0) {
				const remaining = deadline - this.now();
				if (remaining <= 0) {
					settled = true;
					cleanup();
					reject(new ProviderGateSaturatedError(this.provider, this.queueWaitMs));
					return;
				}
				timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					cleanup();
					reject(new ProviderGateSaturatedError(this.provider, this.queueWaitMs));
				}, remaining);
			}
			this.scheduleHoldWakeup();
		});
	}

	/** Release a slot, arming the afterburn hold for the session on success. */
	release(slotIndex: number, sessionId: string | null, success: boolean): void {
		const s = this.slots[slotIndex];
		if (!s || !s.inFlight) return;
		s.inFlight = false;
		if (slotIndex < this.maxConcurrent && success && sessionId && this.afterburnMs > 0) {
			s.holder = sessionId;
			s.holdUntil = this.now() + this.afterburnMs;
		} else {
			s.holder = null;
			s.holdUntil = 0;
		}

		// Wake the next waiter (transfer permit). Pick the highest-priority
		// waiter (lowest `priority` number); within a priority band, the
		// earliest-enqueued waiter (lowest `seq`) wins — stable FIFO. This
		// unblocks skill-pruner prepass calls ahead of main-session calls
		// so a saturated pruner provider does not stall its own session.
		this.wakeEligibleWaiters();
	}

	/** Transfer as many newly available permits as the configured cap allows. */
	private wakeEligibleWaiters(): void {
		if (this.disposed) return;
		if (this.holdWakeTimer) {
			clearTimeout(this.holdWakeTimer);
			this.holdWakeTimer = null;
		}
		while (this.activeRequests < this.maxConcurrent && this.waiters.length > 0) {
			const next = this.popNextEligibleWaiter(this.now());
			if (!next) break;
			next.resolve();
		}
		this.scheduleHoldWakeup();
	}

	/** Remove the highest-priority waiter that can claim a slot now. Ineligible
	 * waiters retain their original queue position while an afterburn hold is
	 * active, avoiding reorder-on-requeue races. */
	private popNextEligibleWaiter(now: number): QueuedWaiter | undefined {
		let bestIdx = -1;
		for (let i = 0; i < this.waiters.length; i++) {
			const w = this.waiters[i];
			if (!this.hasClaimableSlotForSession(w.sessionId, now)) continue;
			if (bestIdx < 0) {
				bestIdx = i;
				continue;
			}
			const best = this.waiters[bestIdx];
			if (w.priority < best.priority || (w.priority === best.priority && w.seq < best.seq)) {
				bestIdx = i;
			}
		}
		if (bestIdx < 0) return undefined;
		return this.waiters.splice(bestIdx, 1)[0];
	}

	private hasClaimableSlotForSession(sessionId: string | null, now: number): boolean {
		if (this.activeRequests >= this.maxConcurrent) return false;
		return this.slots.some((slot) => {
			if (slot.index >= this.maxConcurrent || slot.inFlight) return false;
			if (sessionId && slot.holder === sessionId && slot.holdUntil > now) return true;
			return slot.holder === null || slot.holdUntil <= now;
		});
	}

	/** A held slot has no release event when its sticky window expires, so arm
	 * one pool-level wakeup for the earliest expiry whenever waiters exist. */
	private scheduleHoldWakeup(): void {
		if (this.disposed) return;
		if (this.holdWakeTimer) {
			clearTimeout(this.holdWakeTimer);
			this.holdWakeTimer = null;
		}
		if (this.waiters.length === 0 || this.activeRequests >= this.maxConcurrent) return;
		const now = this.now();
		let earliest = Number.POSITIVE_INFINITY;
		for (const slot of this.slots) {
			if (slot.index >= this.maxConcurrent) break;
			if (!slot.inFlight && slot.holder !== null && slot.holdUntil > now) {
				earliest = Math.min(earliest, slot.holdUntil);
			}
		}
		if (!Number.isFinite(earliest)) return;
		this.holdWakeTimer = setTimeout(() => {
			this.holdWakeTimer = null;
			this.wakeEligibleWaiters();
		}, Math.max(0, earliest - now));
		this.holdWakeTimer.unref?.();
	}

	/** Force-release all slots held by a session (e.g. on abort). */
	releaseAllForSession(sessionId: string): void {
		for (const s of this.slots) {
			if (s.holder === sessionId) {
				s.inFlight = false;
				s.holder = null;
				s.holdUntil = 0;
			}
		}
		this.wakeEligibleWaiters();
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

/** Raised locally while repeated header stalls have opened the provider-wide
 * transport circuit. No upstream request is made. */
export class ProviderGateTransportCircuitOpenError extends Error {
	readonly isRetryable = true;
	readonly httpStatus = 503;
	constructor(provider: string, retryAtMs: number) {
		const seconds = Math.max(1, Math.ceil((retryAtMs - Date.now()) / 1000));
		super(`upstream transport circuit open for provider "${provider}" after repeated header stalls; retry probe available in ~${seconds}s.`);
		this.name = 'ProviderGateTransportCircuitOpenError';
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
	private pools = new Map<string, { pool: ProviderPool; headerWaitMs: number }>();
	private configs: ProviderConcurrencyConfig[] = [];
	private idleTimeoutMs: number;
	private defaultHeaderWaitMs: number;
	private readonly transportCircuits = new Map<string, TransportCircuitState>();
	private transportFailureThreshold: number;
	private transportCircuitCooldownMs: number;
	private uninstallCapacityBridge: (() => void) | null = null;
	/** Monotonic identity for correlating all observations from one wrapped fetch. */
	private nextProviderAttemptId = 0;

	private constructor(
		configs: ProviderConcurrencyConfig[],
		idleTimeoutSeconds: number,
		resilience: ProviderGateResilienceOptions = {},
	) {
		this.configs = configs;
		this.idleTimeoutMs = Math.max(0, idleTimeoutSeconds) * 1000;
		this.transportFailureThreshold = Math.max(1, Math.floor(
			resilience.transportFailureThreshold ?? DEFAULT_TRANSPORT_FAILURE_THRESHOLD,
		));
		this.transportCircuitCooldownMs = Math.max(1,
			(resilience.transportCircuitCooldownSeconds ?? DEFAULT_TRANSPORT_CIRCUIT_COOLDOWN_SECONDS) * 1000,
		);
		// Gate-wide default for the header-phase bound (replaces the proxy's
		// raw-ASGI middleware header-phase bound). Individual providers may
		// override via `headerWaitSeconds` in their concurrency config.
		this.defaultHeaderWaitMs = 120_000;
		this.rebuildPools();
	}

	/** Install (or reconfigure) the provider gate. Wraps `globalThis.fetch`. */
	static install(
		configs: ProviderConcurrencyConfig[],
		idleTimeoutSeconds = 120,
		resilience: ProviderGateResilienceOptions = {},
	): ProviderGate {
		if (ProviderGate.instance) {
			ProviderGate.instance.reconfigure(configs, idleTimeoutSeconds, resilience);
			return ProviderGate.instance;
		}
		ProviderGate.instance = new ProviderGate(configs, idleTimeoutSeconds, resilience);
		ProviderGate.instance.wrapFetch();
		ProviderGate.instance.installCapacityBridge();
		return ProviderGate.instance;
	}

	/** Get the installed instance, or null if not installed. */
	static getInstance(): ProviderGate | null {
		return ProviderGate.instance;
	}

	/** Remove the fetch wrapper (for tests / disposal). */
	static uninstall(): void {
		if (ProviderGate.instance) {
			for (const entry of ProviderGate.instance.pools.values()) entry.pool.dispose();
			ProviderGate.instance.uninstallCapacityBridge?.();
			ProviderGate.instance.uninstallCapacityBridge = null;
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
		resilience?: ProviderGateResilienceOptions,
	): void {
		this.configs = configs;
		this.idleTimeoutMs = Math.max(0, idleTimeoutSeconds) * 1000;
		if (resilience?.transportFailureThreshold !== undefined) {
			this.transportFailureThreshold = Math.max(1, Math.floor(resilience.transportFailureThreshold));
		}
		if (resilience?.transportCircuitCooldownSeconds !== undefined) {
			this.transportCircuitCooldownMs = Math.max(1, resilience.transportCircuitCooldownSeconds * 1000);
		}
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
		// Merge overrides onto the base configs (shallow per-provider merge).
		this.configs = this.configs.map((cfg) => {
			const ov = overrides[cfg.provider];
			if (!ov) return cfg;
			return {
				...cfg,
				...(ov.maxConcurrentRequests !== undefined && { maxConcurrentRequests: ov.maxConcurrentRequests }),
				...(ov.afterburnSeconds !== undefined && { afterburnSeconds: ov.afterburnSeconds }),
				...(ov.queueWaitSeconds !== undefined && { queueWaitSeconds: ov.queueWaitSeconds }),
				...(ov.headerWaitSeconds !== undefined && { headerWaitSeconds: ov.headerWaitSeconds }),
			};
		});
		this.rebuildPools();
	}

	private rebuildPools(): void {
		const oldPools = this.pools;
		this.pools = new Map();
		for (const cfg of this.configs) {
			const existing = oldPools.get(cfg.provider);
			const pool = existing?.pool ?? new ProviderPool(
				cfg.provider,
				cfg.maxConcurrentRequests,
				cfg.afterburnSeconds ?? 0,
				cfg.queueWaitSeconds ?? 30,
			);
			if (existing) {
				pool.reconfigure(
					cfg.maxConcurrentRequests,
					cfg.afterburnSeconds ?? 0,
					cfg.queueWaitSeconds ?? 30,
				);
			}
			const headerWaitMs = (cfg.headerWaitSeconds ?? 0) > 0
				? cfg.headerWaitSeconds! * 1000
				: this.defaultHeaderWaitMs;
			this.pools.set(cfg.provider, { pool, headerWaitMs });
		}
		for (const [provider, entry] of oldPools) {
			if (!this.pools.has(provider)) entry.pool.dispose();
		}
	}

	private getTransportCircuit(provider: string): TransportCircuitState {
		let state = this.transportCircuits.get(provider);
		if (!state) {
			state = {
				consecutiveFailures: 0,
				openUntil: 0,
				nextProbeToken: 0,
				activeProbeToken: null,
			};
			this.transportCircuits.set(provider, state);
		}
		return state;
	}

	/** Claim the single half-open probe after cooldown, or reject locally while
	 * the shared provider circuit remains open. */
	private beginTransportAttempt(provider: string): number | null {
		const state = this.getTransportCircuit(provider);
		if (state.consecutiveFailures < this.transportFailureThreshold) return null;
		const now = Date.now();
		if (state.openUntil > now || state.activeProbeToken !== null) {
			throw new ProviderGateTransportCircuitOpenError(provider, Math.max(state.openUntil, now + 1_000));
		}
		const token = ++state.nextProbeToken;
		state.activeProbeToken = token;
		return token;
	}

	private cancelTransportAttempt(provider: string, probeToken: number | null): void {
		if (probeToken === null) return;
		const state = this.getTransportCircuit(provider);
		if (state.activeProbeToken === probeToken) state.activeProbeToken = null;
	}

	private recordTransportSuccess(provider: string, probeToken: number | null): void {
		const state = this.getTransportCircuit(provider);
		// A request admitted before a newer half-open probe is not authoritative
		// for that probe. Its late result must not close or release the new probe.
		if (state.activeProbeToken !== null && state.activeProbeToken !== probeToken) return;
		state.consecutiveFailures = 0;
		state.openUntil = 0;
		if (probeToken !== null && state.activeProbeToken === probeToken) {
			state.activeProbeToken = null;
		}
	}

	private recordTransportFailure(provider: string, probeToken: number | null): void {
		const state = this.getTransportCircuit(provider);
		state.consecutiveFailures += 1;
		if (probeToken !== null && state.activeProbeToken === probeToken) {
			state.activeProbeToken = null;
		}
		if (state.consecutiveFailures < this.transportFailureThreshold) return;
		const exponent = Math.max(0, state.consecutiveFailures - this.transportFailureThreshold);
		const cooldown = Math.min(
			MAX_TRANSPORT_CIRCUIT_COOLDOWN_MS,
			this.transportCircuitCooldownMs * (2 ** exponent),
		);
		state.openUntil = Date.now() + cooldown;
	}

	private transportCircuitBlocked(provider: string): boolean {
		const state = this.transportCircuits.get(provider);
		return !!state && state.consecutiveFailures >= this.transportFailureThreshold
			&& (state.openUntil > Date.now() || state.activeProbeToken !== null);
	}

	private wrapFetch(): void {
		if (this.originalFetch) return; // already wrapped
		this.originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
			this.handleFetch(input, init)) as typeof globalThis.fetch;
	}

	private installCapacityBridge(): void {
		this.uninstallCapacityBridge?.();
		this.uninstallCapacityBridge = installProviderCapacityBridge(() => this.getCapacitySnapshot());
	}

	/** Snapshot used by subagent pre-request model/provider routing. */
	getCapacitySnapshot(): ProviderCapacitySnapshot {
		const snapshot: Record<string, { immediatelyClaimable: boolean }> = {};
		for (const [provider, entry] of this.pools) {
			snapshot[provider] = {
				immediatelyClaimable: !this.transportCircuitBlocked(provider)
					&& entry.pool.canClaimImmediatelyForUnrelatedSession(),
			};
		}
		return snapshot;
	}

	/** Register effective model URLs from the SDK registry. This closes the gap
	 * between static models.json configuration and built-in/OAuth providers whose
	 * URL is supplied or rewritten by pi-ai at runtime (notably GitHub Copilot,
	 * including enterprise endpoints). Existing prefixes are retained because
	 * concurrently-open runtimes may legitimately use different account URLs. */
	registerModelBaseUrls(models: ReadonlyArray<{ provider?: unknown; baseUrl?: unknown }>): void {
		const discovered = new Map<string, Set<string>>();
		for (const model of models) {
			if (typeof model.provider !== 'string' || typeof model.baseUrl !== 'string') continue;
			const baseUrl = model.baseUrl.trim();
			if (!baseUrl || !this.pools.has(model.provider)) continue;
			let urls = discovered.get(model.provider);
			if (!urls) {
				urls = new Set<string>();
				discovered.set(model.provider, urls);
			}
			urls.add(baseUrl);
		}
		if (discovered.size === 0) return;
		this.configs = this.configs.map((cfg) => {
			const urls = discovered.get(cfg.provider);
			if (!urls) return cfg;
			const merged = [...new Set([
				...(cfg.baseUrl ? [cfg.baseUrl] : []),
				...(cfg.baseUrls ?? []),
				...urls,
			])];
			return { ...cfg, baseUrls: merged };
		});
	}

	/** Match a request URL to a configured provider and return its pool. Longest
	 * prefix wins so overlapping gateway roots route deterministically. */
	private matchProvider(url: string): { pool: ProviderPool; config: ProviderConcurrencyConfig; headerWaitMs: number } | null {
		let best: { pool: ProviderPool; config: ProviderConcurrencyConfig; headerWaitMs: number; prefixLength: number } | null = null;
		for (const cfg of this.configs) {
			for (const prefix of new Set([...(cfg.baseUrl ? [cfg.baseUrl] : []), ...(cfg.baseUrls ?? [])])) {
				if (!prefix || !url.startsWith(prefix) || prefix.length <= (best?.prefixLength ?? -1)) continue;
				const entry = this.pools.get(cfg.provider);
				if (entry) best = { pool: entry.pool, config: cfg, headerWaitMs: entry.headerWaitMs, prefixLength: prefix.length };
			}
		}
		return best && { pool: best.pool, config: best.config, headerWaitMs: best.headerWaitMs };
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
		const attemptId = `${config.provider}:${++this.nextProviderAttemptId}`;

		// Account suspension and repeated transport stalls are independent shared
		// circuits. Both reject before consuming a concurrency slot.
		if (pool.isPaused()) {
			throw new ProviderGatePauseError(config.provider, pool.pausedUntilMs());
		}
		let transportProbeToken = this.beginTransportAttempt(config.provider);

		// Acquire a concurrency slot. Queue and header waits are separate phases.
		// Classify the synchronous fast path before awaiting so an immediate permit
		// is recorded as an explicit zero rather than timer-resolution noise.
		const immediatelyClaimable = pool.canClaimImmediately(sessionId);
		const queueStartedAt = performance.now();
		if (sessionId && !immediatelyClaimable) {
			publishProviderTransportObservation({ sessionId, provider: config.provider, attemptId, kind: 'gate_queue' });
		}
		let slotIndex: number;
		try {
			slotIndex = await pool.acquire(sessionId, signal, requestClass);
			if (sessionId) publishProviderTransportObservation({
				sessionId,
				provider: config.provider,
				attemptId,
				kind: 'gate_acquired',
				queueDurationMs: immediatelyClaimable ? 0 : Math.max(0, Math.trunc(performance.now() - queueStartedAt)),
			});
		} catch (error) {
			if (sessionId) publishProviderTransportObservation({ sessionId, provider: config.provider, attemptId, kind: 'gate_rejected' });
			this.cancelTransportAttempt(config.provider, transportProbeToken);
			throw error;
		}

		// Availability may have changed while this request was queued. Recheck
		// both shared circuits after acquiring the slot and immediately before
		// dispatching upstream. Without this fence, waiters admitted while the
		// provider was healthy would drain into an outage or account-pause window.
		try {
			if (pool.isPaused()) {
				throw new ProviderGatePauseError(config.provider, pool.pausedUntilMs());
			}
			if (transportProbeToken === null) {
				transportProbeToken = this.beginTransportAttempt(config.provider);
			}
		} catch (error) {
			this.cancelTransportAttempt(config.provider, transportProbeToken);
			if (sessionId) publishProviderTransportObservation({ sessionId, provider: config.provider, attemptId, kind: 'transport_error' });
			pool.release(slotIndex, sessionId, false);
			throw error;
		}
		const pauseGenerationAtAdmission = pool.pauseGeneration();
		if (sessionId) publishProviderTransportObservation({ sessionId, provider: config.provider, attemptId, kind: 'headers_wait' });

		let receivedHeaders = false;
		try {
			// Header-phase bound: race the upstream fetch against a timeout so
			// a stalled upstream (TCP open but no HTTP response) cannot hold a
			// concurrency slot indefinitely. The idle-chunk watchdog (armed in
			// wrapStream) only covers the BODY phase — headers must arrive first.
			const response = await this.fetchWithHeaderTimeout(input, init, config.provider, headerWaitMs, signal);
			receivedHeaders = true;
			// A server-side 5xx is transport-retryable and cannot prove that a
			// half-open provider recovered. Count it as a shared failure, while
			// returning the original response unchanged so the SDK retains control
			// of retry/replay policy.
			if (response.status >= 500 && response.status <= 599) {
				this.recordTransportFailure(config.provider, transportProbeToken);
			} else {
				this.recordTransportSuccess(config.provider, transportProbeToken);
			}
			if (sessionId) publishProviderTransportObservation({ sessionId, provider: config.provider, attemptId, kind: 'headers_received' });

			// Account-pause detection: 429/403 with suspension body.
			const pauseInfo = await this.extractAccountPause(response, config.provider, signal);
			if (pauseInfo) {
				pool.recordPause(pauseInfo.pauseUntilMs, pauseInfo.retryAfterSeconds);
				pool.release(slotIndex, sessionId, false);
				return pauseInfo.reconstructed;
			}

			// Non-OK response — release slot and return.
			if (!response.ok) {
				pool.release(slotIndex, sessionId, false);
				return response;
			}

			// Success.
			pool.clearPause(pauseGenerationAtAdmission);

			// If the response has a body, wrap it to release the slot on
			// stream completion (and arm the idle watchdog if configured).
			if (response.body) {
				return this.wrapStream(response, config.provider, pool, slotIndex, sessionId, attemptId, signal);
			}

			// No body — release immediately.
			pool.release(slotIndex, sessionId, true);
			return response;
		} catch (error) {
			if (error instanceof ProviderGateHeaderTimeoutError) {
				this.recordTransportFailure(config.provider, transportProbeToken);
			} else if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
				// User cancellation is not evidence that the provider is unhealthy.
				this.cancelTransportAttempt(config.provider, transportProbeToken);
			} else if (!receivedHeaders) {
				// Fetch-level failures such as DNS/connect/reset errors are provider
				// transport evidence even while the circuit is closed. Counting only
				// half-open probe failures would let an ordinary outage retry forever.
				this.recordTransportFailure(config.provider, transportProbeToken);
			}
			if (sessionId) publishProviderTransportObservation({ sessionId, provider: config.provider, attemptId, kind: 'transport_error' });
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
		let onMergedAbort: (() => void) | undefined;
		const abortSettlement = new Promise<never>((_resolve, reject) => {
			onMergedAbort = () => reject(controller.signal.reason ?? new ProviderGateAbortError());
			if (controller.signal.aborted) {
				onMergedAbort();
			} else {
				controller.signal.addEventListener('abort', onMergedAbort, { once: true });
			}
		});

		const mergedInit: RequestInit = { ...init, signal: controller.signal };
		try {
			const upstream = Promise.resolve(this.originalFetch!(input, mergedInit)).then((response) => {
				if (controller.signal.aborted) {
					// The local deadline already won. A non-cooperative upstream may
					// still return later; discard its body without reviving the request.
					void response.body?.cancel().catch(() => undefined);
					throw controller.signal.reason ?? new ProviderGateAbortError();
				}
				return response;
			});
			return await Promise.race([upstream, abortSettlement]);
		} finally {
			clearTimeout(timer);
			if (onMergedAbort) controller.signal.removeEventListener('abort', onMergedAbort);
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
	 *  A bounded explicit reader consumes a clone, leaving the original body
	 *  untouched. Suspension responses are reconstructed from the inspected
	 *  text so the SDK receives the same readable payload. */
	private async extractAccountPause(
		response: Response,
		_provider: string,
		signal: AbortSignal | undefined,
	): Promise<{ retryAfterSeconds: number | undefined; pauseUntilMs: number | undefined; reconstructed: Response } | null> {
		// Only inspect 429/403 — other statuses are never suspensions.
		if (response.status !== 429 && response.status !== 403) return null;

		// Clone so the SDK can still consume the original body.
		const cloneForInspection = response.clone();
		const inspectionReader = cloneForInspection.body?.getReader();
		let bodyText: string;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let removeAbort = () => {};
		try {
			const timeoutMs = this.idleTimeoutMs > 0 ? this.idleTimeoutMs : this.defaultHeaderWaitMs;
			const timeout = new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), timeoutMs);
				timer.unref?.();
			});
			const aborted = new Promise<never>((_resolve, reject) => {
				if (!signal) return;
				const onAbort = () => reject(new ProviderGateAbortError('inspecting provider response body'));
				if (signal.aborted) onAbort();
				else {
					signal.addEventListener('abort', onAbort, { once: true });
					removeAbort = () => signal.removeEventListener('abort', onAbort);
				}
			});
			const inspected = await Promise.race([
				(inspectionReader ? readBoundedInspectionBody(inspectionReader) : Promise.resolve(''))
					.then((text) => ({ text })),
				timeout,
				aborted,
			]);
			if (inspected === null) {
				void inspectionReader?.cancel('provider pause inspection timeout').catch(() => {});
				return null;
			}
			bodyText = inspected.text;
		} catch {
			if (signal?.aborted) {
				// The caller will never receive this response. Cancel both tee branches:
				// cancelling only the inspection clone can leave the source alive while
				// the untouched original branch remains open.
				void inspectionReader?.cancel('provider pause inspection aborted').catch(() => {});
				void response.body?.cancel('provider pause inspection aborted').catch(() => {});
				throw new ProviderGateAbortError('inspecting provider response body');
			}
			// Can't read body — don't arm the breaker (defensive).
			return null;
		} finally {
			if (timer) clearTimeout(timer);
			removeAbort();
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
			const ra = response.headers.get('retry-after');
			if (ra) {
				const n = Number(ra);
				if (Number.isFinite(n)) {
					retryAfterSeconds = n;
				} else {
					const httpDate = Date.parse(ra);
					if (Number.isFinite(httpDate)) {
						retryAfterSeconds = Math.max(1, Math.ceil((httpDate - Date.now()) / 1000));
					}
				}
			}
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
	private wrapStream(
		response: Response,
		provider: string,
		pool: ProviderPool,
		slotIndex: number,
		sessionId: string | null,
		attemptId: string,
		signal: AbortSignal | undefined,
	): Response {
		const originalBody = response.body!;
		const idleTimeoutMs = this.idleTimeoutMs;
		const reader = originalBody.getReader();
		let released = false;
		let removeCallerAbort = () => {};

		const releaseSlot = (success: boolean) => {
			if (released) return;
			released = true;
			removeCallerAbort();
			pool.release(slotIndex, sessionId, success);
		};

		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				let timer: ReturnType<typeof setTimeout> | null = null;
				let settled = false;

				const clearTimer = () => {
					if (timer) { clearTimeout(timer); timer = null; }
				};

				const onCallerAbort = () => {
					if (settled) return;
					settled = true;
					clearTimer();
					const reason = signal?.reason ?? new ProviderGateAbortError('reading provider response body');
					reader.cancel(reason).catch(() => {});
					try { controller.error(reason); } catch { /* already closed */ }
					releaseSlot(false);
				};
				if (signal) {
					signal.addEventListener('abort', onCallerAbort, { once: true });
					removeCallerAbort = () => signal.removeEventListener('abort', onCallerAbort);
					if (signal.aborted) onCallerAbort();
				}

				const armTimer = () => {
					if (idleTimeoutMs <= 0) return;
					if (timer) clearTimeout(timer);
					timer = setTimeout(() => {
						if (settled) return;
						settled = true;
						if (sessionId) publishProviderTransportObservation({ sessionId, provider, attemptId, kind: 'transport_error' });
						reader.cancel().catch(() => {});
						try {
							controller.error(
								new Error(`upstream stream stalled: no chunk for ${idleTimeoutMs / 1000}s (provider=${provider})`),
							);
						} catch { /* already closed */ }
						releaseSlot(false);
					}, idleTimeoutMs);
				};

				if (!settled) armTimer();
				try {
					while (true) {
						const { done, value } = await reader.read();
						// Caller cancellation may settle this wrapper while an upstream
						// reader ignores abort briefly. Its eventual read completion is
						// stale and must not publish a successful terminal observation.
						if (settled) return;
						clearTimer();
						if (settled) return;
						if (done) {
							if (sessionId) publishProviderTransportObservation({ sessionId, provider, attemptId, kind: 'transport_terminal' });
							controller.close();
							settled = true;
							releaseSlot(true);
							return;
						}
						if (value) {
							if (sessionId) publishProviderTransportObservation({ sessionId, provider, attemptId, kind: 'raw_chunk' });
							controller.enqueue(value);
						}
						armTimer();
					}
				} catch (err) {
					if (sessionId) publishProviderTransportObservation({ sessionId, provider, attemptId, kind: 'transport_error' });
					clearTimer();
					if (!settled) {
						settled = true;
						try { controller.error(err); } catch { /* already closed */ }
						releaseSlot(false);
					}
				}
			},

			cancel(reason) {
				reader.cancel(reason).catch(() => {});
				releaseSlot(false);
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
			const transport = this.transportCircuits.get(provider);
			const transportPaused = this.transportCircuitBlocked(provider);
			result.push({
				provider,
				activeRequests: entry.pool.activeRequests,
				queuedRequests: entry.pool.queuedRequests,
				maxConcurrentRequests: entry.pool.maxConcurrent,
				afterburnSeconds: Math.round(entry.pool.afterburnMs / 1000),
				queueWaitSeconds: entry.pool.queueWaitMs / 1000,
				paused: entry.pool.isPaused() || transportPaused,
				pausedUntilMs: Math.max(entry.pool.pausedUntilMs(), transportPaused ? (transport?.openUntil ?? 0) : 0),
				strikeCount: entry.pool.strikeCount() + (transport?.consecutiveFailures ?? 0),
			});
		}
		return result.sort((a, b) => a.provider.localeCompare(b.provider));
	}

	/** Resolve concurrency config from the on-disk models.json. Each provider
	 * entry may have a `concurrency` field (generated from models.yaml
	 * `providers.<p>.concurrency`). A provider does not need a static baseUrl:
	 * built-in and OAuth URLs are registered later from the SDK model registry.
	 * Providers without a concurrency block are not gated (direct, unthrottled). */
	static resolveConfigs(
		modelsJson: {
			providers?: Record<string, {
				baseUrl?: string;
				concurrency?: {
					maxConcurrentRequests?: number;
					afterburnSeconds?: number;
					queueWaitSeconds?: number;
					headerWaitSeconds?: number;
				};
			}>;
		},
	): ProviderConcurrencyConfig[] {
		const configs: ProviderConcurrencyConfig[] = [];
		const providers = modelsJson.providers ?? {};
		for (const [name, entry] of Object.entries(providers)) {
			const cc = entry.concurrency;
			if (!cc || typeof cc.maxConcurrentRequests !== 'number' || cc.maxConcurrentRequests <= 0) continue;
			configs.push({
				provider: name,
				...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
				maxConcurrentRequests: cc.maxConcurrentRequests,
				afterburnSeconds: cc.afterburnSeconds ?? 0,
				queueWaitSeconds: cc.queueWaitSeconds ?? 30,
				headerWaitSeconds: cc.headerWaitSeconds,
			});
		}
		return configs;
	}
}
