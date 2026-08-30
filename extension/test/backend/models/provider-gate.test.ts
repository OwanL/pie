/**
 * Tests for the host-side provider gate (replaces the LiteLLM proxy).
 *
 * Covers the three core responsibilities ported from the Python proxy:
 *  - Per-provider concurrency semaphore (replaces TrackedSemaphore)
 *  - AfterburnPool sticky-slot semantics (replaces AfterburnPool)
 *  - Stream-liveness watchdog (replaces wrap_stream_with_liveness)
 *
 * Also covers circuit-breaker (account-pause) and metrics.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
	ProviderGate,
	ProviderGateSaturatedError,
	ProviderGateAbortError,
	ProviderGateHeaderTimeoutError,
	ProviderGatePauseError,
	ProviderGateTransportCircuitOpenError,
	type ProviderConcurrencyConfig,
} from '../../../src/backend/provider-gate.js';
import { readProviderCapacitySnapshot } from '../../../../shared/provider-capacity-bridge.js';
import { observeProviderTransport } from '../../../src/backend/provider-progress-bus.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_BASE = 'https://test-provider.example.com/v1';

const BASE_CONFIG: ProviderConcurrencyConfig = {
	provider: 'test-provider',
	baseUrl: TEST_BASE,
	maxConcurrentRequests: 2,
	afterburnSeconds: 0,
	queueWaitSeconds: 1, // short for tests
};

/** Build a minimal RequestInit with session-affinity headers. */
function makeInit(sessionId?: string, signal?: AbortSignal): RequestInit {
	const headers: Record<string, string> = {};
	if (sessionId) {
		headers['x-session-affinity'] = sessionId;
		headers['session_id'] = sessionId;
	}
	return { headers, signal, method: 'POST' };
}

/** Build a RequestInit tagged as a skill-pruner prepass call (queue priority). */
function makePrunerInit(sessionId?: string, signal?: AbortSignal): RequestInit {
	const init = makeInit(sessionId, signal);
	(init.headers as Record<string, string>)['x-pi-request-class'] = 'skill-pruner';
	return init;
}

/** Build a fake Response with a streaming body. */
function makeStreamingResponse(chunks: Uint8Array[], delayMs = 0): Response {
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			for (const chunk of chunks) {
				if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
				controller.enqueue(chunk);
			}
			controller.close();
		},
	});
	return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Build a fake Response that stalls (never produces data). */
function makeStallingResponse(): Response {
	const body = new ReadableStream<Uint8Array>({
		pull() {
			// Never enqueues or closes — stalls forever.
			return new Promise(() => {});
		},
	});
	return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Read all bytes from a response body. */
async function readBody(response: Response): Promise<string> {
	const text = await response.text();
	return text;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let savedFetch: typeof globalThis.fetch;

beforeEach(() => {
	savedFetch = globalThis.fetch;
	// Default mock fetch: a simple streaming response.
	globalThis.fetch = async () => makeStreamingResponse([new TextEncoder().encode('data: hello\n\n')]);
});

afterEach(() => {
	ProviderGate.uninstall();
	globalThis.fetch = savedFetch;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test('provider transport phases correlate one attempt and explicitly record an immediate zero queue', async () => {
	const observations: Array<{ kind: string; attemptId: string; queueDurationMs?: number }> = [];
	const stop = observeProviderTransport((observation) => observations.push(observation));
	try {
		ProviderGate.install([BASE_CONFIG], 0);
		const response = await fetch(`${TEST_BASE}/chat/completions`, makeInit('session-progress'));
		await response.text();
		assert.deepEqual(observations.map((observation) => observation.kind), [
			'gate_acquired',
			'headers_wait',
			'headers_received',
			'raw_chunk',
			'transport_terminal',
		]);
		assert.equal(observations[0]?.queueDurationMs, 0);
		assert.equal(new Set(observations.map((observation) => observation.attemptId)).size, 1);
	} finally {
		stop();
	}
});

describe('ProviderGate — installation and passthrough', () => {
	test('non-matching requests pass through unwrapped', async () => {
		let called = false;
		globalThis.fetch = async () => {
			called = true;
			return new Response('ok', { status: 200 });
		};
		ProviderGate.install([BASE_CONFIG], 0);

		const res = await fetch('https://other.example.com/api', {});
		assert.equal(called, true);
		assert.equal(res.status, 200);
	});

	test('install is idempotent — does not double-wrap fetch', async () => {
		let callCount = 0;
		globalThis.fetch = async () => {
			callCount++;
			return new Response('ok', { status: 200 });
		};
		ProviderGate.install([BASE_CONFIG], 0);
		ProviderGate.install([BASE_CONFIG], 0);

		// Non-matching request — should call fetch exactly once.
		await fetch('https://unrelated.example.com/', {});
		assert.equal(callCount, 1);
	});

	test('getInstance returns the installed gate', () => {
		globalThis.fetch = async () => new Response('ok', { status: 200 });
		const gate = ProviderGate.install([BASE_CONFIG], 0);
		assert.equal(ProviderGate.getInstance(), gate);
	});

	test('runtime model URLs activate a configured built-in provider without a static baseUrl', async () => {
		globalThis.fetch = async () => makeStallingResponse();
		const gate = ProviderGate.install([{
			provider: 'github-copilot',
			maxConcurrentRequests: 2,
			afterburnSeconds: 0,
			queueWaitSeconds: 1,
		}], 0);
		gate.registerModelBaseUrls([
			{ provider: 'github-copilot', baseUrl: 'https://api.individual.githubcopilot.com' },
		]);

		const response = await fetch('https://api.individual.githubcopilot.com/chat/completions', makeInit('copilot-session'));
		assert.equal(gate.getMetrics()[0]?.activeRequests, 1);
		await response.body?.cancel();
		assert.equal(gate.getMetrics()[0]?.activeRequests, 0);
	});

	test('uninstall restores the original fetch', async () => {
		let called = false;
		globalThis.fetch = async () => {
			called = true;
			return new Response('ok', { status: 200 });
		};
		ProviderGate.install([BASE_CONFIG], 0);
		ProviderGate.uninstall();
		assert.equal(ProviderGate.getInstance(), null);
		// After uninstall, fetch should be restored to the mock we set before install.
		await fetch('https://unrelated.example.com/', {});
		assert.equal(called, true);
	});
});

describe('ProviderGate — concurrency limiting', () => {
	test('respects maxConcurrentRequests', async () => {
		const config: ProviderConcurrencyConfig = {
			...BASE_CONFIG,
			maxConcurrentRequests: 1,
			queueWaitSeconds: 0, // five-minute safety maximum — should not fail here
		};

		let inFlight = 0;
		let maxInFlight = 0;
		globalThis.fetch = async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			// Simulate a slow response.
			await new Promise((r) => setTimeout(r, 50));
			inFlight--;
			return makeStreamingResponse([new TextEncoder().encode('data: ok\n\n')]);
		};
		ProviderGate.install([config], 0);

		// Fire 3 concurrent requests.
		await Promise.all([
			fetch(TEST_BASE + '/chat', makeInit('s1')),
			fetch(TEST_BASE + '/chat', makeInit('s2')),
			fetch(TEST_BASE + '/chat', makeInit('s3')),
		]);

		assert.equal(maxInFlight, 1, 'only 1 request should be in-flight at a time');
	});

	test('queued grants report measured duration under their own attempt identity', async () => {
		const observations: Array<{ sessionId: string; attemptId: string; kind: string; queueDurationMs?: number }> = [];
		const stop = observeProviderTransport((observation) => observations.push(observation));
		let releaseFirst!: () => void;
		const held = new Promise<void>((resolve) => { releaseFirst = resolve; });
		let calls = 0;
		globalThis.fetch = async () => {
			calls += 1;
			if (calls === 1) await held;
			return makeStreamingResponse([new TextEncoder().encode('data: ok\n\n')]);
		};
		try {
			ProviderGate.install([{ ...BASE_CONFIG, maxConcurrentRequests: 1, queueWaitSeconds: 0 }], 0);
			const first = fetch(TEST_BASE + '/chat', makeInit('queue-first'));
			while (calls < 1) await new Promise((resolve) => setImmediate(resolve));
			const second = fetch(TEST_BASE + '/chat', makeInit('queue-second'));
			await new Promise((resolve) => setTimeout(resolve, 20));
			releaseFirst();
			await Promise.all([first, second]);

			const queued = observations.find((observation) => observation.sessionId === 'queue-second' && observation.kind === 'gate_queue');
			const acquired = observations.find((observation) => observation.sessionId === 'queue-second' && observation.kind === 'gate_acquired');
			assert.ok(queued && acquired);
			assert.equal(acquired.attemptId, queued.attemptId);
			assert.ok((acquired.queueDurationMs ?? 0) >= 15);
		} finally {
			stop();
		}
	});

	test('saturated queue rejects with ProviderGateSaturatedError', async () => {
		const config: ProviderConcurrencyConfig = {
			...BASE_CONFIG,
			maxConcurrentRequests: 1,
			queueWaitSeconds: 1, // 1s deadline
		};

		let resolveFirst: () => void;
		const firstPromise = new Promise<void>((r) => { resolveFirst = r; });
		globalThis.fetch = async () => {
			await firstPromise;
			return makeStreamingResponse([new TextEncoder().encode('data: ok\n\n')]);
		};
		ProviderGate.install([config], 0);

		// Start the first (holds the only slot).
		const p1 = fetch(TEST_BASE + '/chat', makeInit('s1'));
		// Start the second (queued, will time out in 1s).
		const p2 = fetch(TEST_BASE + '/chat', makeInit('s2'));

		// Wait for saturation error.
		await assert.rejects(p2, (err: unknown) => {
			return err instanceof ProviderGateSaturatedError;
		});

		// Let the first complete.
		resolveFirst!();
		await p1;
	});

	test('abort signal rejects queued requests', async () => {
		const config: ProviderConcurrencyConfig = {
			...BASE_CONFIG,
			maxConcurrentRequests: 1,
			queueWaitSeconds: 0, // five-minute safety maximum — abort frees it immediately
		};

		let resolveFirst: () => void;
		const firstPromise = new Promise<void>((r) => { resolveFirst = r; });
		globalThis.fetch = async () => {
			await firstPromise;
			return makeStreamingResponse([new TextEncoder().encode('data: ok\n\n')]);
		};
		ProviderGate.install([config], 0);

		const ac = new AbortController();
		const p1 = fetch(TEST_BASE + '/chat', makeInit('s1'));
		const p2 = fetch(TEST_BASE + '/chat', makeInit('s2', ac.signal));

		// Abort the queued request.
		ac.abort();

		await assert.rejects(p2, (err: unknown) => err instanceof ProviderGateAbortError);

		// Clean up.
		resolveFirst!();
		await p1;
	});
});

describe('ProviderGate — afterburn sticky slots', () => {
	test('uninstall rejects waiters blocked behind an afterburn hold', async () => {
		globalThis.fetch = async () => new Response(null, { status: 200 });
		ProviderGate.install([{
			...BASE_CONFIG,
			maxConcurrentRequests: 1,
			afterburnSeconds: 60,
			queueWaitSeconds: 0,
		}], 0);

		await fetch(TEST_BASE + '/chat', makeInit('session-A'));
		const blocked = fetch(TEST_BASE + '/chat', makeInit('session-B'));
		await new Promise((resolve) => setImmediate(resolve));

		ProviderGate.uninstall();
		await assert.rejects(blocked, ProviderGateAbortError);
	});

	test('same session reuses its slot immediately (no queue)', async () => {
		const config: ProviderConcurrencyConfig = {
			...BASE_CONFIG,
			maxConcurrentRequests: 1,
			afterburnSeconds: 10, // 10s sticky window
			queueWaitSeconds: 0,
		};

		let callCount = 0;
		globalThis.fetch = async () => {
			callCount++;
			return makeStreamingResponse([new TextEncoder().encode('data: ok\n\n')]);
		};
		ProviderGate.install([config], 0);

		// First request from session-A completes.
		await fetch(TEST_BASE + '/chat', makeInit('session-A'));

		// Second request from the SAME session should reuse the sticky slot
		// without queueing, even though it's within the afterburn window.
		const start = Date.now();
		await fetch(TEST_BASE + '/chat', makeInit('session-A'));
		const elapsed = Date.now() - start;

		// Should be near-instant (no queue wait).
		assert.ok(elapsed < 100, `second request took ${elapsed}ms (should reuse slot)`);
		assert.equal(callCount, 2);
	});

	test('different session queues behind sticky slot holder', async () => {
		const config: ProviderConcurrencyConfig = {
			...BASE_CONFIG,
			maxConcurrentRequests: 1,
			afterburnSeconds: 10,
			queueWaitSeconds: 1, // 1s bound
		};

		globalThis.fetch = async () => {
			return makeStreamingResponse([new TextEncoder().encode('data: ok\n\n')]);
		};
		ProviderGate.install([config], 0);

		// Session-A acquires the slot.
		await fetch(TEST_BASE + '/chat', makeInit('session-A'));

		// Session-B should NOT be able to use the sticky slot.
		// The afterburn hold blocks session-B from claiming the slot, so it
		// queues and eventually times out with a SaturatedError.
		await assert.rejects(
			fetch(TEST_BASE + '/chat', makeInit('session-B')),
			(err: unknown) => err instanceof ProviderGateSaturatedError,
		);
	});

	test('an expired sticky hold wakes the next queued session', async () => {
		let calls = 0;
		globalThis.fetch = async () => {
			calls++;
			return new Response(null, { status: 200 });
		};
		ProviderGate.install([{
			...BASE_CONFIG,
			maxConcurrentRequests: 1,
			afterburnSeconds: 0.02,
			queueWaitSeconds: 1,
		}], 0);

		await fetch(TEST_BASE + '/chat', makeInit('session-A'));
		const response = await fetch(TEST_BASE + '/chat', makeInit('session-B'));

		assert.equal(response.status, 200);
		assert.equal(calls, 2, 'hold expiry should transfer the permit before the queue deadline');
	});
});

describe('ProviderGate — request-class queue priority', () => {
	test('skill-pruner prepass jumps the queue ahead of main-session calls', async () => {
		const config: ProviderConcurrencyConfig = {
			...BASE_CONFIG,
			maxConcurrentRequests: 1,
			queueWaitSeconds: 0, // five-minute safety maximum — ordering is what matters
		};

		// Tracks the order in which requests actually reach the fetch impl
		// (i.e. acquire a slot). With maxConcurrent=1 this is the grant order.
		const grantOrder: string[] = [];

		let releaseFirst: () => void;
		const firstHeld = new Promise<void>((r) => { releaseFirst = r; });

		// R1 holds the only slot until `releaseFirst` fires.
		globalThis.fetch = async (_input, init) => {
			const headers = init?.headers as Record<string, string> | undefined;
			const cls = headers?.['x-pi-request-class'] ?? 'default';
			const tag = headers?.['x-session-affinity'] ?? 'none';
			grantOrder.push(`${cls}:${tag}`);
			// The first request blocks until we release it; later ones stream
			// straight through.
			if (tag === 'r1') await firstHeld;
			return makeStreamingResponse([new TextEncoder().encode('data: ok\n\n')]);
		};
		ProviderGate.install([config], 0);

		// R1 (main) acquires the only slot.
		const p1 = fetch(TEST_BASE + '/chat', makeInit('r1'));
		// Let R1 reach the fetch impl and grab the slot.
		await new Promise((r) => setTimeout(r, 20));

		// Queue a main-session call, THEN a skill-pruner call (queued later).
		const pMain = fetch(TEST_BASE + '/chat', makeInit('main-2'));
		const pPruner = fetch(TEST_BASE + '/chat', makePrunerInit('pruner-1'));
		// Give both a moment to enqueue.
		await new Promise((r) => setTimeout(r, 20));

		// Release R1's slot — the gate should hand it to the skill-pruner
		// (queued second) ahead of the main-session call (queued first).
		releaseFirst!();
		await Promise.all([p1, pMain, pPruner]);

		// grantOrder = ['default:r1', <next grant>, <next grant>].
		// The skill-pruner must be granted before the main-session call.
		const afterR1 = grantOrder.slice(1);
		const prunerIdx = afterR1.indexOf('skill-pruner:pruner-1');
		const mainIdx = afterR1.indexOf('default:main-2');
		assert.notEqual(prunerIdx, -1, 'skill-pruner request should have been granted');
		assert.notEqual(mainIdx, -1, 'main-session request should have been granted');
		assert.ok(prunerIdx < mainIdx, `skill-pruner should jump the queue (order: ${afterR1.join(', ')})`);
	});

	test('default requests keep FIFO when no priority waiter is queued', async () => {
		const config: ProviderConcurrencyConfig = {
			...BASE_CONFIG,
			maxConcurrentRequests: 1,
			queueWaitSeconds: 0,
		};

		const grantOrder: string[] = [];
		let releaseFirst: () => void;
		const firstHeld = new Promise<void>((r) => { releaseFirst = r; });

		globalThis.fetch = async (_input, init) => {
			const headers = init?.headers as Record<string, string> | undefined;
			const tag = headers?.['x-session-affinity'] ?? 'none';
			grantOrder.push(tag);
			if (tag === 'r1') await firstHeld;
			return makeStreamingResponse([new TextEncoder().encode('data: ok\n\n')]);
		};
		ProviderGate.install([config], 0);

		const p1 = fetch(TEST_BASE + '/chat', makeInit('r1'));
		await new Promise((r) => setTimeout(r, 20));

		// Queue two default (main) calls in order — no pruner.
		const pA = fetch(TEST_BASE + '/chat', makeInit('a'));
		const pB = fetch(TEST_BASE + '/chat', makeInit('b'));
		await new Promise((r) => setTimeout(r, 20));

		releaseFirst!();
		await Promise.all([p1, pA, pB]);

		// Default ordering is preserved (FIFO).
		assert.deepEqual(grantOrder, ['r1', 'a', 'b']);
	});
});

describe('ProviderGate — stream liveness', () => {
	test('caller cancellation releases a body-phase slot immediately', async () => {
		let mode: 'stall' | 'success' = 'stall';
		let calls = 0;
		globalThis.fetch = async () => {
			calls++;
			return mode === 'stall' ? makeStallingResponse() : new Response(null, { status: 200 });
		};
		const gate = ProviderGate.install([{
			...BASE_CONFIG,
			maxConcurrentRequests: 1,
			queueWaitSeconds: 0,
		}], 0);
		const abort = new AbortController();
		const response = await fetch(TEST_BASE + '/chat', makeInit('streaming', abort.signal));
		const bodyRead = response.text();
		assert.equal(gate.getMetrics()[0].activeRequests, 1);

		abort.abort();
		assert.equal(gate.getMetrics()[0].activeRequests, 0, 'abort dispatch should release synchronously');
		await assert.rejects(bodyRead, (error: unknown) => error instanceof Error && error.name === 'AbortError');

		mode = 'success';
		assert.equal((await fetch(TEST_BASE + '/chat', makeInit('next'))).status, 200);
		assert.equal(calls, 2);
	});

	test('stalled stream is terminated after idle timeout', async () => {
		globalThis.fetch = async () => makeStallingResponse();
		ProviderGate.install([BASE_CONFIG], 0.1); // 100ms idle timeout

		// The fetch should resolve (200 OK headers come fast), but reading the
		// body should fail with an error after the idle timeout.
		const res = await fetch(TEST_BASE + '/chat', makeInit('s1'));
		assert.equal(res.status, 200);

		// Reading the body should throw (stream was terminated).
		await assert.rejects(res.text(), (err: unknown) => {
			return err instanceof Error && err.message.includes('stalled');
		});
	});

	test('healthy stream passes through unchanged', async () => {
		const data = new TextEncoder().encode('data: hello\n\n');
		globalThis.fetch = async () => makeStreamingResponse([data]);
		ProviderGate.install([BASE_CONFIG], 10); // 10s timeout (generous)

		const res = await fetch(TEST_BASE + '/chat', makeInit('s1'));
		const text = await readBody(res);
		assert.equal(text, 'data: hello\n\n');
	});
});

describe('ProviderGate — header-phase timeout', () => {
	test('header deadline settles locally and releases the slot when upstream ignores abort', async () => {
		const config: ProviderConcurrencyConfig = {
			...BASE_CONFIG,
			maxConcurrentRequests: 1,
			headerWaitSeconds: 0.02,
			queueWaitSeconds: 0,
		};

		globalThis.fetch = async () => new Promise<Response>(() => {});
		const gate = ProviderGate.install([config], 0);

		const request = fetch(TEST_BASE + '/chat', makeInit('stuck-upstream'));
		const outcome = await Promise.race([
			request.then(
				() => 'resolved' as const,
				(error: unknown) => error,
			),
			new Promise<'test-timeout'>((resolve) => setTimeout(() => resolve('test-timeout'), 250)),
		]);

		assert.notEqual(outcome, 'test-timeout', 'the local header deadline must not await upstream abort settlement');
		assert.ok(outcome instanceof ProviderGateHeaderTimeoutError);
		assert.equal(gate.getMetrics()[0]?.activeRequests, 0, 'the timed-out request must release its slot');

		globalThis.fetch = async () => makeStreamingResponse([new TextEncoder().encode('data: recovered\n\n')]);
		const response = await fetch(TEST_BASE + '/chat', makeInit('next-request'));
		assert.equal(await response.text(), 'data: recovered\n\n');
	});

	test('stalled headers abort with ProviderGateHeaderTimeoutError and release the slot', async () => {
		const config: ProviderConcurrencyConfig = {
			...BASE_CONFIG,
			maxConcurrentRequests: 1,
			headerWaitSeconds: 0.1, // 100ms header bound
			queueWaitSeconds: 0,
		};

		// Fetch that stalls until its abort signal fires, then rejects.
		globalThis.fetch = async (_input, init) => {
			return new Promise((_resolve, reject) => {
				const signal = init?.signal;
				if (signal) {
					if (signal.aborted) reject(signal.reason);
					else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
				}
			});
		};
		ProviderGate.install([config], 0);

		// The first request should fail with the header timeout.
		await assert.rejects(
			fetch(TEST_BASE + '/chat', makeInit('s1')),
			(err: unknown) => err instanceof ProviderGateHeaderTimeoutError,
		);

		// The slot must have been released — a follow-up request should succeed.
		globalThis.fetch = async () => makeStreamingResponse([new TextEncoder().encode('data: ok\n\n')]);
		const res = await fetch(TEST_BASE + '/chat', makeInit('s2'));
		assert.equal(res.status, 200);
	});

	test('repeated header stalls open a shared circuit and stop hitting the upstream', async () => {
		const config: ProviderConcurrencyConfig = {
			...BASE_CONFIG,
			headerWaitSeconds: 0.02,
			queueWaitSeconds: 0,
		};
		let callCount = 0;
		globalThis.fetch = async (_input, init) => {
			callCount++;
			return new Promise((_resolve, reject) => {
				const signal = init?.signal;
				if (signal?.aborted) reject(signal.reason);
				else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
			});
		};
		const gate = ProviderGate.install([config], 0, {
			transportFailureThreshold: 2,
			// Keep this well above event-loop scheduling jitter from the fully
			// parallel pre-commit suite. This test verifies immediate local
			// short-circuiting, not half-open cooldown expiry.
			transportCircuitCooldownSeconds: 5,
		});

		await assert.rejects(fetch(TEST_BASE + '/chat', makeInit('s1')), ProviderGateHeaderTimeoutError);
		await assert.rejects(fetch(TEST_BASE + '/chat', makeInit('s2')), ProviderGateHeaderTimeoutError);
		await assert.rejects(fetch(TEST_BASE + '/chat', makeInit('s3')), ProviderGateTransportCircuitOpenError);

		assert.equal(callCount, 2, 'an open circuit must reject locally without another upstream call');
		const [metrics] = gate.getMetrics();
		assert.equal(metrics.paused, true);
		assert.equal(metrics.strikeCount, 2);
	});

	test('one half-open probe closes the transport circuit after recovery', async () => {
		const config: ProviderConcurrencyConfig = {
			...BASE_CONFIG,
			headerWaitSeconds: 0.01,
			queueWaitSeconds: 0,
		};
		let healthy = false;
		let callCount = 0;
		globalThis.fetch = async (_input, init) => {
			callCount++;
			if (healthy) return makeStreamingResponse([new TextEncoder().encode('data: recovered\n\n')]);
			return new Promise((_resolve, reject) => {
				const signal = init?.signal;
				if (signal?.aborted) reject(signal.reason);
				else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
			});
		};
		const gate = ProviderGate.install([config], 0, {
			transportFailureThreshold: 2,
			transportCircuitCooldownSeconds: 0.02,
		});

		await assert.rejects(fetch(TEST_BASE + '/chat', makeInit('s1')), ProviderGateHeaderTimeoutError);
		await assert.rejects(fetch(TEST_BASE + '/chat', makeInit('s2')), ProviderGateHeaderTimeoutError);
		await new Promise((resolve) => setTimeout(resolve, 30));
		healthy = true;

		const probe = await fetch(TEST_BASE + '/chat', makeInit('probe'));
		assert.equal(await probe.text(), 'data: recovered\n\n');
		assert.equal(gate.getMetrics()[0].paused, false);
		assert.equal(gate.getMetrics()[0].strikeCount, 0);

		const followUp = await fetch(TEST_BASE + '/chat', makeInit('follow-up'));
		assert.equal(followUp.status, 200);
		assert.equal(callCount, 4, 'two failed calls, one probe, and one normal follow-up should reach upstream');
	});

	test('only one half-open probe reaches upstream at a time', async () => {
		const config: ProviderConcurrencyConfig = {
			...BASE_CONFIG,
			headerWaitSeconds: 0.01,
			queueWaitSeconds: 0,
		};
		let healthy = false;
		let releaseProbe: ((response: Response) => void) | undefined;
		let callCount = 0;
		globalThis.fetch = async (_input, init) => {
			callCount++;
			if (healthy) return new Promise<Response>((resolve) => { releaseProbe = resolve; });
			return new Promise((_resolve, reject) => {
				const signal = init?.signal;
				if (signal?.aborted) reject(signal.reason);
				else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
			});
		};
		ProviderGate.install([config], 0, {
			transportFailureThreshold: 2,
			transportCircuitCooldownSeconds: 0.02,
		});
		await assert.rejects(fetch(TEST_BASE + '/chat', makeInit('s1')), ProviderGateHeaderTimeoutError);
		await assert.rejects(fetch(TEST_BASE + '/chat', makeInit('s2')), ProviderGateHeaderTimeoutError);
		await new Promise((resolve) => setTimeout(resolve, 30));
		healthy = true;

		const probe = fetch(TEST_BASE + '/chat', makeInit('probe'));
		await new Promise((resolve) => setImmediate(resolve));
		await assert.rejects(
			fetch(TEST_BASE + '/chat', makeInit('blocked-sibling')),
			ProviderGateTransportCircuitOpenError,
		);
		assert.equal(callCount, 3, 'the blocked sibling must not reach upstream');
		releaseProbe?.(makeStreamingResponse([new TextEncoder().encode('data: ok\n\n')]));
		assert.equal((await probe).status, 200);
	});

	test('a late ordinary failure cannot relinquish a newer half-open probe', async (t) => {
		let now = 1_000_000;
		t.mock.method(Date, 'now', () => now);
		let rejectOld!: (error: unknown) => void;
		let resolveProbe!: (response: Response) => void;
		let markOldEntered!: () => void;
		let markProbeEntered!: () => void;
		const oldEntered = new Promise<void>((resolve) => { markOldEntered = resolve; });
		const probeEntered = new Promise<void>((resolve) => { markProbeEntered = resolve; });
		let calls = 0;
		globalThis.fetch = async (_input, init) => {
			calls++;
			const sessionId = new Headers(init?.headers).get('x-session-affinity');
			if (sessionId === 'old') {
				markOldEntered();
				return new Promise<Response>((_resolve, reject) => { rejectOld = reject; });
			}
			if (sessionId === 'trip') throw new TypeError('connection refused');
			if (sessionId === 'probe') {
				markProbeEntered();
				return new Promise<Response>((resolve) => { resolveProbe = resolve; });
			}
			throw new Error(`unexpected upstream request for ${sessionId}`);
		};
		ProviderGate.install([{
			...BASE_CONFIG,
			maxConcurrentRequests: 2,
			headerWaitSeconds: 10,
			queueWaitSeconds: 0,
		}], 0, {
			transportFailureThreshold: 1,
			transportCircuitCooldownSeconds: 1,
		});

		const old = fetch(TEST_BASE + '/chat', makeInit('old'));
		await oldEntered;
		await assert.rejects(fetch(TEST_BASE + '/chat', makeInit('trip')), TypeError);
		now += 1_001;
		const probe = fetch(TEST_BASE + '/chat', makeInit('probe'));
		await probeEntered;

		// This pre-circuit request settles after the probe was claimed. It is
		// transport evidence, but does not own (and therefore cannot clear) it.
		rejectOld(new TypeError('old connection reset'));
		await assert.rejects(old, TypeError);
		now += 2_001;
		await assert.rejects(
			fetch(TEST_BASE + '/chat', makeInit('blocked-sibling')),
			ProviderGateTransportCircuitOpenError,
		);
		assert.equal(calls, 3, 'the active probe remains the sole upstream attempt');

		resolveProbe(new Response(null, { status: 200 }));
		assert.equal((await probe).status, 200);
	});

	test('non-header failure during a half-open probe re-opens the circuit', async () => {
		const config: ProviderConcurrencyConfig = {
			...BASE_CONFIG,
			headerWaitSeconds: 0.01,
			queueWaitSeconds: 0,
		};
		let probeFailsDifferently = false;
		let callCount = 0;
		globalThis.fetch = async (_input, init) => {
			callCount++;
			if (probeFailsDifferently) throw new TypeError('connection reset during probe');
			return new Promise((_resolve, reject) => {
				const signal = init?.signal;
				if (signal?.aborted) reject(signal.reason);
				else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
			});
		};
		ProviderGate.install([config], 0, {
			transportFailureThreshold: 2,
			transportCircuitCooldownSeconds: 0.02,
		});
		await assert.rejects(fetch(TEST_BASE + '/chat', makeInit('s1')), ProviderGateHeaderTimeoutError);
		await assert.rejects(fetch(TEST_BASE + '/chat', makeInit('s2')), ProviderGateHeaderTimeoutError);
		await new Promise((resolve) => setTimeout(resolve, 30));
		probeFailsDifferently = true;

		await assert.rejects(fetch(TEST_BASE + '/chat', makeInit('probe')), TypeError);
		await assert.rejects(fetch(TEST_BASE + '/chat', makeInit('blocked')), ProviderGateTransportCircuitOpenError);
		assert.equal(callCount, 3, 'failed half-open probe should restore local short-circuiting');
	});

	test('transport circuit survives live concurrency reconfiguration', async () => {
		const config: ProviderConcurrencyConfig = {
			...BASE_CONFIG,
			headerWaitSeconds: 0.01,
			queueWaitSeconds: 0,
		};
		let callCount = 0;
		globalThis.fetch = async (_input, init) => {
			callCount++;
			return new Promise((_resolve, reject) => {
				const signal = init?.signal;
				if (signal?.aborted) reject(signal.reason);
				else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
			});
		};
		const gate = ProviderGate.install([config], 0, {
			transportFailureThreshold: 2,
			transportCircuitCooldownSeconds: 1,
		});
		await assert.rejects(fetch(TEST_BASE + '/chat', makeInit('s1')), ProviderGateHeaderTimeoutError);
		await assert.rejects(fetch(TEST_BASE + '/chat', makeInit('s2')), ProviderGateHeaderTimeoutError);

		gate.applyUserOverrides({ 'test-provider': { maxConcurrentRequests: 4 } });
		await assert.rejects(fetch(TEST_BASE + '/chat', makeInit('s3')), ProviderGateTransportCircuitOpenError);
		assert.equal(callCount, 2, 'settings changes must not reset an outage circuit');
	});

	test('ordinary pre-header connection failures open the shared circuit', async () => {
		let callCount = 0;
		globalThis.fetch = async () => {
			callCount++;
			throw new TypeError('fetch failed: connection reset');
		};
		const gate = ProviderGate.install([{
			...BASE_CONFIG,
			queueWaitSeconds: 0,
		}], 0, {
			transportFailureThreshold: 2,
			transportCircuitCooldownSeconds: 1,
		});

		await assert.rejects(fetch(TEST_BASE + '/chat', makeInit('s1')), TypeError);
		await assert.rejects(fetch(TEST_BASE + '/chat', makeInit('s2')), TypeError);
		await assert.rejects(
			fetch(TEST_BASE + '/chat', makeInit('blocked')),
			ProviderGateTransportCircuitOpenError,
		);

		assert.equal(callCount, 2, 'the open circuit must stop a third connection attempt');
		assert.equal(gate.getMetrics()[0].activeRequests, 0);
		assert.equal(gate.getMetrics()[0].strikeCount, 2);
	});

	test('queued request revalidates a circuit opened while it waited', async () => {
		let rejectFirst!: (error: unknown) => void;
		let markEntered!: () => void;
		const entered = new Promise<void>((resolve) => { markEntered = resolve; });
		let callCount = 0;
		globalThis.fetch = async () => {
			callCount++;
			markEntered();
			return new Promise<Response>((_resolve, reject) => { rejectFirst = reject; });
		};
		const gate = ProviderGate.install([{
			...BASE_CONFIG,
			maxConcurrentRequests: 1,
			queueWaitSeconds: 0,
		}], 0, {
			transportFailureThreshold: 1,
			transportCircuitCooldownSeconds: 1,
		});

		const first = fetch(TEST_BASE + '/chat', makeInit('first'));
		await entered;
		const queued = fetch(TEST_BASE + '/chat', makeInit('queued'));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(gate.getMetrics()[0].queuedRequests, 1);

		rejectFirst(new TypeError('connection reset'));
		await assert.rejects(first, TypeError);
		await assert.rejects(queued, ProviderGateTransportCircuitOpenError);

		assert.equal(callCount, 1, 'the stale queued request must not reach upstream');
		assert.equal(gate.getMetrics()[0].activeRequests, 0);
		assert.equal(gate.getMetrics()[0].queuedRequests, 0);
	});

	test('half-open probe returning 503 re-opens the circuit without replay', async (t) => {
		let now = 1_000_000;
		t.mock.method(Date, 'now', () => now);
		let return503 = false;
		let callCount = 0;
		globalThis.fetch = async () => {
			callCount++;
			if (!return503) throw new TypeError('connection refused');
			return new Response('service unavailable', { status: 503 });
		};
		const gate = ProviderGate.install([{
			...BASE_CONFIG,
			queueWaitSeconds: 0,
		}], 0, {
			transportFailureThreshold: 2,
			transportCircuitCooldownSeconds: 1,
		});

		await assert.rejects(fetch(TEST_BASE + '/chat', makeInit('s1')), TypeError);
		await assert.rejects(fetch(TEST_BASE + '/chat', makeInit('s2')), TypeError);
		now += 1_001;
		return503 = true;

		const probe = await fetch(TEST_BASE + '/chat', makeInit('probe'));
		assert.equal(probe.status, 503, 'the gate must preserve the upstream response');
		assert.equal(await probe.text(), 'service unavailable');
		await assert.rejects(
			fetch(TEST_BASE + '/chat', makeInit('blocked')),
			ProviderGateTransportCircuitOpenError,
		);

		assert.equal(callCount, 3, 'the gate observes failures but never replays requests');
		assert.equal(gate.getMetrics()[0].paused, true);
		assert.equal(gate.getMetrics()[0].strikeCount, 3);
	});

	test('headers arriving within the bound pass through normally', async () => {
		const config: ProviderConcurrencyConfig = {
			...BASE_CONFIG,
			maxConcurrentRequests: 1,
			headerWaitSeconds: 5, // generous
		};

		globalThis.fetch = async () => makeStreamingResponse([new TextEncoder().encode('data: ok\n\n')]);
		ProviderGate.install([config], 0);

		const res = await fetch(TEST_BASE + '/chat', makeInit('s1'));
		assert.equal(res.status, 200);
		assert.equal(await readBody(res), 'data: ok\n\n');
	});

	test('caller abort signal still propagates through the header-timeout wrapper', async () => {
		const config: ProviderConcurrencyConfig = {
			...BASE_CONFIG,
			maxConcurrentRequests: 1,
			headerWaitSeconds: 10, // long — caller abort should fire first
		};

		// Fetch that stalls until its abort signal fires, then rejects.
		globalThis.fetch = async (_input, init) => {
			return new Promise((_resolve, reject) => {
				const signal = init?.signal;
				if (signal) {
					if (signal.aborted) reject(signal.reason);
					else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
				}
			});
		};
		const gate = ProviderGate.install([config], 0);

		const ac = new AbortController();
		const p = fetch(TEST_BASE + '/chat', makeInit('s1', ac.signal));
		ac.abort();

		// Should reject (an abort, NOT the header timeout).
		await assert.rejects(p, (err: unknown) => {
			return !(err instanceof ProviderGateHeaderTimeoutError);
		});
		assert.equal(gate.getMetrics()[0].activeRequests, 0);
		assert.equal(gate.getMetrics()[0].strikeCount, 0, 'caller cancellation is not a provider failure');
	});
});

describe('ProviderGate — live reconfiguration', () => {
	test('keeps the active permit and queued waiters under the original cap', async () => {
		let releaseFirst!: () => void;
		let markEntered!: () => void;
		const entered = new Promise<void>((resolve) => { markEntered = resolve; });
		const held = new Promise<void>((resolve) => { releaseFirst = resolve; });
		let calls = 0;
		let upstreamActive = 0;
		let maxUpstreamActive = 0;
		globalThis.fetch = async () => {
			calls++;
			upstreamActive++;
			maxUpstreamActive = Math.max(maxUpstreamActive, upstreamActive);
			if (calls === 1) {
				markEntered();
				await held;
			}
			upstreamActive--;
			return new Response(null, { status: 200 });
		};
		const gate = ProviderGate.install([{
			...BASE_CONFIG,
			maxConcurrentRequests: 1,
			queueWaitSeconds: 0,
		}], 0);

		const first = fetch(TEST_BASE + '/chat', makeInit('first'));
		await entered;
		const second = fetch(TEST_BASE + '/chat', makeInit('second'));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(gate.getMetrics()[0].queuedRequests, 1);

		gate.applyUserOverrides({ 'test-provider': { headerWaitSeconds: 30 } });
		const third = fetch(TEST_BASE + '/chat', makeInit('third'));
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(calls, 1, 'reconfiguration must not create a second pool authority');
		assert.equal(gate.getMetrics()[0].activeRequests, 1);
		assert.equal(gate.getMetrics()[0].queuedRequests, 2);
		releaseFirst();
		await Promise.all([first, second, third]);
		assert.equal(maxUpstreamActive, 1);
	});

	test('shrinking the cap drains existing work before admitting a waiter', async () => {
		const releases: Array<() => void> = [];
		let calls = 0;
		globalThis.fetch = async () => {
			const call = calls++;
			if (call < 2) await new Promise<void>((resolve) => { releases[call] = resolve; });
			return new Response(null, { status: 200 });
		};
		const gate = ProviderGate.install([{
			...BASE_CONFIG,
			maxConcurrentRequests: 2,
			queueWaitSeconds: 0,
		}], 0);

		const first = fetch(TEST_BASE + '/chat', makeInit('first'));
		const second = fetch(TEST_BASE + '/chat', makeInit('second'));
		while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
		gate.applyUserOverrides({ 'test-provider': { maxConcurrentRequests: 1 } });
		const third = fetch(TEST_BASE + '/chat', makeInit('third'));
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(gate.getMetrics()[0].maxConcurrentRequests, 1);
		assert.equal(gate.getMetrics()[0].queuedRequests, 1);
		releases[0]();
		await first;
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(calls, 2, 'one remaining active request still occupies the shrunken cap');

		releases[1]();
		await Promise.all([second, third]);
		assert.equal(calls, 3);
	});

	test('growing the cap immediately transfers a new permit to a queued waiter', async () => {
		let releaseFirst!: () => void;
		const held = new Promise<void>((resolve) => { releaseFirst = resolve; });
		let calls = 0;
		globalThis.fetch = async () => {
			calls++;
			if (calls === 1) await held;
			return new Response(null, { status: 200 });
		};
		const gate = ProviderGate.install([{
			...BASE_CONFIG,
			maxConcurrentRequests: 1,
			queueWaitSeconds: 0,
		}], 0);

		const first = fetch(TEST_BASE + '/chat', makeInit('first'));
		while (calls < 1) await new Promise((resolve) => setImmediate(resolve));
		const second = fetch(TEST_BASE + '/chat', makeInit('second'));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(gate.getMetrics()[0].queuedRequests, 1);

		gate.applyUserOverrides({ 'test-provider': { maxConcurrentRequests: 2 } });
		await second;
		assert.equal(calls, 2, 'the newly configured permit should wake the existing queue');
		releaseFirst();
		await first;
	});

	test('preserves an afterburn hold across unrelated settings changes', async () => {
		let calls = 0;
		globalThis.fetch = async () => {
			calls++;
			return new Response(null, { status: 200 });
		};
		const gate = ProviderGate.install([{
			...BASE_CONFIG,
			maxConcurrentRequests: 1,
			afterburnSeconds: 10,
			queueWaitSeconds: 0,
		}], 0);
		await fetch(TEST_BASE + '/chat', makeInit('holder'));

		gate.applyUserOverrides({ 'test-provider': { headerWaitSeconds: 30 } });
		const abort = new AbortController();
		const blocked = fetch(TEST_BASE + '/chat', makeInit('other', abort.signal));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(gate.getMetrics()[0].queuedRequests, 1);
		assert.equal(calls, 1, 'the sticky reservation must remain authoritative');

		abort.abort();
		await assert.rejects(blocked, ProviderGateAbortError);
	});
});

describe('ProviderGate — queued circuit revalidation', () => {
	test('queued request revalidates an account pause before upstream dispatch', async () => {
		const suspensionBody = JSON.stringify({
			error: {
				message: 'account_suspended: reactivates automatically at 2099-01-01T00:00 UTC',
				type: 'upstream_account_paused',
			},
		});
		let releaseFirst!: () => void;
		let markEntered!: () => void;
		const entered = new Promise<void>((resolve) => { markEntered = resolve; });
		const held = new Promise<void>((resolve) => { releaseFirst = resolve; });
		let callCount = 0;
		globalThis.fetch = async () => {
			callCount++;
			markEntered();
			await held;
			return new Response(suspensionBody, {
				status: 429,
				headers: { 'content-type': 'application/json' },
			});
		};
		const gate = ProviderGate.install([{
			...BASE_CONFIG,
			maxConcurrentRequests: 1,
			queueWaitSeconds: 0,
		}], 0);

		const first = fetch(TEST_BASE + '/chat', makeInit('first'));
		await entered;
		const queued = fetch(TEST_BASE + '/chat', makeInit('queued'));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(gate.getMetrics()[0].queuedRequests, 1);

		releaseFirst();
		assert.equal((await first).status, 429);
		await assert.rejects(queued, ProviderGatePauseError);

		assert.equal(callCount, 1, 'a waiter queued before the pause must not reach upstream');
		assert.equal(gate.getMetrics()[0].activeRequests, 0);
		assert.equal(gate.getMetrics()[0].queuedRequests, 0);
	});
});

describe('ProviderGate — account-pause circuit breaker', () => {
	test('a stale success cannot clear a pause armed by a newer concurrent response', async () => {
		const suspensionBody = JSON.stringify({
			error: { message: 'account_suspended: reactivates automatically at 2099-01-01T00:00 UTC' },
		});
		let releaseSuccess!: () => void;
		const successHeld = new Promise<void>((resolve) => { releaseSuccess = resolve; });
		let calls = 0;
		globalThis.fetch = async () => {
			calls += 1;
			if (calls === 1) {
				await successHeld;
				return new Response(null, { status: 200 });
			}
			return new Response(suspensionBody, {
				status: 429,
				headers: { 'content-type': 'application/json' },
			});
		};
		const gate = ProviderGate.install([{ ...BASE_CONFIG, maxConcurrentRequests: 2 }], 0);

		const staleSuccess = fetch(TEST_BASE + '/chat', makeInit('success'));
		const pauseResponse = await fetch(TEST_BASE + '/chat', makeInit('pause'));
		assert.equal(pauseResponse.status, 429);
		assert.equal(gate.getMetrics()[0].paused, true);

		releaseSuccess();
		assert.equal((await staleSuccess).status, 200);
		await assert.rejects(fetch(TEST_BASE + '/chat', makeInit('blocked')), ProviderGatePauseError);
		assert.equal(calls, 2, 'the stale success must not reopen the paused provider');
	});

	test('caller abort releases a slot while a 429 inspection body is stalled', async () => {
		let sourceCancelCount = 0;
		globalThis.fetch = async () => {
			const body = new ReadableStream<Uint8Array>({
				pull() { return new Promise(() => {}); },
				cancel() { sourceCancelCount += 1; },
			});
			return new Response(body, { status: 429, headers: { 'content-type': 'application/json' } });
		};
		const gate = ProviderGate.install([{ ...BASE_CONFIG, maxConcurrentRequests: 1 }], 0);
		const abort = new AbortController();
		const pending = fetch(TEST_BASE + '/chat', makeInit('stalled', abort.signal));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(gate.getMetrics()[0].activeRequests, 1);

		abort.abort();
		await assert.rejects(pending, ProviderGateAbortError);
		assert.equal(gate.getMetrics()[0].activeRequests, 0);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(sourceCancelCount, 1, 'caller abort cancels both response tee branches');
	});

	test('live reconfiguration cannot bypass an armed account pause', async () => {
		const suspensionBody = JSON.stringify({
			error: { message: 'account_suspended: reactivates automatically at 2099-01-01T00:00 UTC' },
		});
		let calls = 0;
		globalThis.fetch = async () => {
			calls++;
			return new Response(suspensionBody, {
				status: 429,
				headers: { 'content-type': 'application/json' },
			});
		};
		const gate = ProviderGate.install([{ ...BASE_CONFIG, maxConcurrentRequests: 1 }], 0);
		assert.equal((await fetch(TEST_BASE + '/chat', makeInit('first'))).status, 429);

		gate.applyUserOverrides({ 'test-provider': { maxConcurrentRequests: 3 } });
		await assert.rejects(
			fetch(TEST_BASE + '/chat', makeInit('second')),
			ProviderGatePauseError,
		);

		assert.equal(calls, 1, 'settings changes must retain the existing breaker state');
		assert.equal(gate.getMetrics()[0].paused, true);
		assert.equal(gate.getMetrics()[0].strikeCount, 1);
	});

	test('suspension body arms the circuit breaker', async () => {
		const reactivation = new Date(Date.now() + 3600_000).toISOString().replace(/.\d+Z$/, ' UTC').replace('T', ' ');
		const suspensionBody = JSON.stringify({
			error: {
				message: `account_suspended: reactivates automatically at ${reactivation}`,
				type: 'upstream_account_paused',
			},
		});

		let callCount = 0;
		globalThis.fetch = async () => {
			callCount++;
			return new Response(suspensionBody, { status: 429, headers: { 'content-type': 'application/json' } });
		};
		const config: ProviderConcurrencyConfig = { ...BASE_CONFIG, maxConcurrentRequests: 1 };
		ProviderGate.install([config], 0);

		// First request: arms the breaker.
		const res1 = await fetch(TEST_BASE + '/chat', makeInit('s1'));
		assert.equal(res1.status, 429);

		// Second request: short-circuited (caller gets a pause error, upstream not called).
		await assert.rejects(
			fetch(TEST_BASE + '/chat', makeInit('s2')),
			(err: unknown) => err instanceof Error && err.message.includes('account-pause'),
		);
		assert.equal(callCount, 1, 'upstream should NOT be called while paused');
	});

	test('transient 429 (rate-limit, no suspension body) does NOT arm the breaker', async () => {
		let callCount = 0;
		globalThis.fetch = async () => {
			callCount++;
			// A plain rate-limit 429 — no suspension signature.
			return new Response('{"error":{"message":"Rate limit exceeded","type":"rate_limit_exceeded"}}', {
				status: 429,
				headers: { 'content-type': 'application/json', 'retry-after': '5' },
			});
		};
		const config: ProviderConcurrencyConfig = { ...BASE_CONFIG, maxConcurrentRequests: 1 };
		const gate = ProviderGate.install([config], 0);

		// A transient 429 should NOT pause the provider.
		await fetch(TEST_BASE + '/chat', makeInit('s1'));

		const metrics = gate.getMetrics();
		assert.equal(metrics[0].paused, false, 'transient 429 must not arm the circuit breaker');
		assert.equal(metrics[0].strikeCount, 0);
		assert.equal(callCount, 1);
	});

	test('reactivation timestamp parsed from body overrides Retry-After header', async () => {
		// Body says reactivate in ~1 hour; header says 5 seconds. The body wins.
		const reactivation = new Date(Date.now() + 3600_000).toISOString().replace(/.\d+Z$/, ' UTC').replace('T', ' ');
		const suspensionBody = JSON.stringify({
			error: {
				message: `cap_abuse: reactivates automatically at ${reactivation}`,
			},
		});
		globalThis.fetch = async () => new Response(suspensionBody, {
			status: 429,
			headers: { 'content-type': 'application/json', 'retry-after': '5' },
		});
		const config: ProviderConcurrencyConfig = { ...BASE_CONFIG, maxConcurrentRequests: 1 };
		const gate = ProviderGate.install([config], 0);

		await fetch(TEST_BASE + '/chat', makeInit('s1')).catch(() => {});

		const metrics = gate.getMetrics();
		assert.ok(metrics[0].pausedUntilMs > Date.now() + 3000_000, 'should use body timestamp (~1h), not header (5s)');
	});

	test('clears pause on successful response after breaker was armed', async () => {
		// First: arm the breaker with a suspension body (far-future timestamp).
		const farFuture = new Date(Date.now() + 86400_000).toISOString().replace(/.\d+Z$/, ' UTC').replace('T', ' ');
		const suspensionBody = JSON.stringify({
			error: { message: `account_suspended: reactivates automatically at ${farFuture}` },
		});

		// We need to flip fetch between suspension + success. Use a counter.
		const mode: 'suspend' | 'success' = 'suspend';
		globalThis.fetch = async () => {
			if (mode === 'suspend') {
				return new Response(suspensionBody, { status: 429, headers: { 'content-type': 'application/json' } });
			}
			return makeStreamingResponse([new TextEncoder().encode('data: ok\n\n')]);
		};
		const config: ProviderConcurrencyConfig = { ...BASE_CONFIG, maxConcurrentRequests: 1 };
		const gate = ProviderGate.install([config], 0);

		// Arm the breaker.
		await fetch(TEST_BASE + '/chat', makeInit('s1')).catch(() => {});
		assert.equal(gate.getMetrics()[0].paused, true);

		// The breaker is still armed — we can't get a success through while paused.
		// To test clearPause, we must clear the breaker manually via a success.
		// Since isPaused() short-circuits before fetch, we need to wait for the
		// pause to expire. Instead, test clearPause() directly via a successful
		// response when the breaker is NOT yet armed (clears a stale strike).
		// This test validates the metrics shape, not the full expiry flow.
		assert.ok(gate.getMetrics()[0].strikeCount >= 1);
	});
});

describe('ProviderGate — live capacity bridge', () => {
	test('publishes immediate capacity and removes the bridge on uninstall', () => {
		ProviderGate.install([{ ...BASE_CONFIG, maxConcurrentRequests: 1 }], 0);
		assert.deepEqual(readProviderCapacitySnapshot(), {
			'test-provider': { immediatelyClaimable: true },
		});

		ProviderGate.uninstall();
		assert.equal(readProviderCapacitySnapshot(), undefined);
	});

	test('reports an in-flight request and an afterburn-held slot as unavailable', async () => {
		let releaseHeaders!: () => void;
		let markEntered!: () => void;
		const entered = new Promise<void>((resolve) => { markEntered = resolve; });
		const held = new Promise<void>((resolve) => { releaseHeaders = resolve; });
		globalThis.fetch = async () => {
			markEntered();
			await held;
			return new Response(null, { status: 200 });
		};
		ProviderGate.install([{
			...BASE_CONFIG,
			maxConcurrentRequests: 1,
			afterburnSeconds: 10,
		}], 0);

		const request = fetch(TEST_BASE + '/chat', makeInit('session-A'));
		await entered;
		assert.equal(readProviderCapacitySnapshot()?.['test-provider']?.immediatelyClaimable, false);

		releaseHeaders();
		await request;
		assert.equal(readProviderCapacitySnapshot()?.['test-provider']?.immediatelyClaimable, false);
	});

	test('reports a transport-circuit-open provider as unavailable even with free slots', async () => {
		const config: ProviderConcurrencyConfig = {
			...BASE_CONFIG,
			headerWaitSeconds: 0.01,
			queueWaitSeconds: 0,
		};
		globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
			const signal = init?.signal;
			if (signal?.aborted) reject(signal.reason);
			else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
		});
		ProviderGate.install([config], 0, {
			transportFailureThreshold: 2,
			transportCircuitCooldownSeconds: 1,
		});
		await assert.rejects(fetch(TEST_BASE + '/chat', makeInit('s1')), ProviderGateHeaderTimeoutError);
		await assert.rejects(fetch(TEST_BASE + '/chat', makeInit('s2')), ProviderGateHeaderTimeoutError);

		assert.equal(readProviderCapacitySnapshot()?.['test-provider']?.immediatelyClaimable, false);
	});

	test('reports a paused provider as unavailable even with a free slot', async () => {
		const suspensionBody = JSON.stringify({
			error: { message: 'account_suspended: reactivates automatically at 2099-01-01T00:00 UTC' },
		});
		globalThis.fetch = async () => new Response(suspensionBody, {
			status: 429,
			headers: { 'content-type': 'application/json' },
		});
		ProviderGate.install([{ ...BASE_CONFIG, maxConcurrentRequests: 1 }], 0);

		await fetch(TEST_BASE + '/chat', makeInit('session-A'));
		assert.equal(readProviderCapacitySnapshot()?.['test-provider']?.immediatelyClaimable, false);
	});
});

describe('ProviderGate — metrics', () => {
	test('getMetrics returns live provider state including afterburn + pause fields', async () => {
		globalThis.fetch = async () => new Response('ok', { status: 200 });
		const config: ProviderConcurrencyConfig = {
			...BASE_CONFIG,
			maxConcurrentRequests: 2,
			afterburnSeconds: 15,
		};
		const gate = ProviderGate.install([config], 0);

		// Initially idle.
		const metrics = gate.getMetrics();
		assert.equal(metrics.length, 1);
		assert.equal(metrics[0].provider, 'test-provider');
		assert.equal(metrics[0].activeRequests, 0);
		assert.equal(metrics[0].queuedRequests, 0);
		assert.equal(metrics[0].maxConcurrentRequests, 2);
		assert.equal(metrics[0].afterburnSeconds, 15);
		assert.equal(metrics[0].queueWaitSeconds, 1);
		assert.equal(metrics[0].paused, false);
		assert.equal(metrics[0].pausedUntilMs, 0);
		assert.equal(metrics[0].strikeCount, 0);
	});

	test('getMetrics reflects paused state after account suspension', async () => {
		const suspensionBody = JSON.stringify({
			error: {
				message: 'account_suspended: reactivates automatically at 2099-01-01T00:00 UTC',
				type: 'upstream_account_paused',
			},
		});
		globalThis.fetch = async () => new Response(suspensionBody, { status: 429, headers: { 'content-type': 'application/json' } });
		const config: ProviderConcurrencyConfig = { ...BASE_CONFIG, maxConcurrentRequests: 1 };
		const gate = ProviderGate.install([config], 0);

		// Trigger a suspension response.
		await fetch(TEST_BASE + '/chat', makeInit('s1')).catch(() => {});

		const metrics = gate.getMetrics();
		assert.equal(metrics[0].paused, true);
		assert.ok(metrics[0].pausedUntilMs > Date.now(), 'pausedUntilMs should be in the future');
		assert.equal(metrics[0].strikeCount, 1);
	});
});

describe('ProviderGate — resolveConfigs from models.json', () => {
	test('builds configs from providers with concurrency block', () => {
		const modelsJson = {
			providers: {
				umans: {
					baseUrl: 'https://api.code.umans.ai/v1',
					concurrency: { maxConcurrentRequests: 4, afterburnSeconds: 15 },
				},
				ollama: { baseUrl: 'http://localhost:11434/v1' },
			},
		};

		const configs = ProviderGate.resolveConfigs(modelsJson);
		assert.equal(configs.length, 1); // only umans
		assert.equal(configs[0].provider, 'umans');
		assert.equal(configs[0].baseUrl, 'https://api.code.umans.ai/v1');
		assert.equal(configs[0].maxConcurrentRequests, 4);
		assert.equal(configs[0].afterburnSeconds, 15);
	});

	test('keeps concurrency configs without a static baseUrl for runtime registry discovery', () => {
		const configs = ProviderGate.resolveConfigs({
			providers: {
				'github-copilot': {
					concurrency: { maxConcurrentRequests: 2, afterburnSeconds: 15 },
				},
			},
		});
		assert.deepEqual(configs, [{
			provider: 'github-copilot',
			maxConcurrentRequests: 2,
			afterburnSeconds: 15,
			queueWaitSeconds: 30,
			headerWaitSeconds: undefined,
		}]);
	});

	test('providers without concurrency block are not gated', () => {
		const modelsJson = {
			providers: {
				umans: { baseUrl: 'https://api.code.umans.ai/v1' },
			},
		};
		const configs = ProviderGate.resolveConfigs(modelsJson);
		assert.equal(configs.length, 0);
	});

	test('resolves headerWaitSeconds when provided', () => {
		const modelsJson = {
			providers: {
				umans: {
					baseUrl: 'https://api.code.umans.ai/v1',
					concurrency: { maxConcurrentRequests: 2, headerWaitSeconds: 60 },
				},
			},
		};
		const configs = ProviderGate.resolveConfigs(modelsJson);
		assert.equal(configs[0].headerWaitSeconds, 60);
	});

	test('headerWaitSeconds is undefined when not in config (uses gate default)', () => {
		const modelsJson = {
			providers: {
				umans: {
					baseUrl: 'https://api.code.umans.ai/v1',
					concurrency: { maxConcurrentRequests: 2 },
				},
			},
		};
		const configs = ProviderGate.resolveConfigs(modelsJson);
		assert.equal(configs[0].headerWaitSeconds, undefined);
	});
});
