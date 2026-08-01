import assert from 'node:assert/strict';
import test from 'node:test';

import { BackendServer } from '../../../src/backend';
import type { SessionContext } from '../../../src/backend/server-types';

/**
 * Focused robustness coverage for the bounded backend pass:
 *  1. `emitSessionOpened` / `emitSessionListChanged` are rejection-safe (a
 *     thrown payload/list build logs and swallows instead of producing an
 *     unhandled rejection from a fire-and-forget `void …` caller).
 *  2. `BackendServer.dispose()` clears every active-request/watchdog timer,
 *     bounds a hung `runtime.dispose()`, and tears down in-flight recovery
 *     replacement contexts instead of leaking them.
 *  3. Post-disposal stale events / payload builds are suppressed.
 *
 * Mirrors the cast-to-any + stubbed-internals pattern of
 * `backend-stuck-retry-recovery.test.ts` so the private methods under test can
 * be exercised without a real SDK.
 */

interface EmittedEvent {
  event: string;
  payload?: unknown;
}

function makeServer(): any {
  return new BackendServer({ sdkPath: '/unused', cwd: '/repo' }) as any;
}

/** A minimal context whose teardown no-ops, with an instrumented runtime. */
function makeContext(
  sessionPath: string,
  overrides: Record<string, unknown> = {},
): SessionContext {
  return {
    sessionPath,
    busySeq: 0,
    unsubscribe: () => undefined,
    runtime: { dispose: async () => undefined },
    ...overrides,
  } as unknown as SessionContext;
}

/** Capture `process.stderr.write` across an async op. The backend logger
 *  (`backendWarn`) writes structured JSON lines here; callers filter for their
 *  event string so incidental runner output cannot false-match. */
async function captureStderrAsync<T>(op: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  (process.stderr as any).write = (chunk: unknown) => {
    captured += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  try {
    const result = await op();
    return { result, stderr: captured };
  } finally {
    (process.stderr as any).write = original;
  }
}

/** Capture `process.stdout.write` across a *synchronous* `server.emit` call.
 *  The shared `OrderedJsonlWriter` calls `process.stdout.write` synchronously
 *  inside its pump on the first (idle) write, so a tight sync capture observes
 *  it. The fake invokes the writer's callback so the shared writer does not
 *  wedge in `writing=true` for later tests. */
function captureStdoutSync(op: () => void): string {
  const original = process.stdout.write.bind(process.stdout);
  let captured = '';
  (process.stdout as any).write = (chunk: unknown, a?: unknown, b?: unknown) => {
    captured += typeof chunk === 'string' ? chunk : String(chunk);
    const cb = typeof a === 'function' ? a : typeof b === 'function' ? b : undefined;
    if (cb) (cb as (err: Error | null) => void)(null);
    return true;
  };
  try {
    op();
  } finally {
    (process.stdout as any).write = original;
  }
  return captured;
}

const GRACE_ENV = 'PIE_RUNTIME_DISPOSE_GRACE_MS';
function withGrace(ms: number, fn: () => Promise<void>): Promise<void> {
  const previous = process.env[GRACE_ENV];
  process.env[GRACE_ENV] = String(ms);
  return fn().finally(() => {
    if (previous === undefined) delete process.env[GRACE_ENV];
    else process.env[GRACE_ENV] = previous;
  });
}

// ---------------------------------------------------------------------------
// 1. Rejection-safe session emitters
// ---------------------------------------------------------------------------

test('emitSessionOpened swallows and logs a thrown payload build (no unhandled rejection, no event)', async () => {
  const server = makeServer();
  server.sessionContexts.set('/s', makeContext('/s'));
  server.buildSessionOpenedPayload = async () => {
    throw new Error('payload build exploded');
  };
  const events: EmittedEvent[] = [];
  server.emit = (event: string, payload?: unknown) => events.push({ event, payload });

  const { stderr } = await captureStderrAsync(() => server.emitSessionOpened('/s'));

  // Rejection-safe: the fire-and-forget contract holds (no rejection escapes).
  assert.deepEqual(events, [], 'a failed payload build must not emit session.opened');
  assert.match(stderr, /emitSessionOpened\.failed/, 'the failure is logged, not swallowed silently');
  assert.match(stderr, /payload build exploded/);
});

test('emitSessionListChanged swallows and logs a thrown list scan (no unhandled rejection, no event)', async () => {
  const server = makeServer();
  server.listSessionSummaries = async () => {
    throw new Error('list scan exploded');
  };
  const events: EmittedEvent[] = [];
  server.emit = (event: string, payload?: unknown) => events.push({ event, payload });

  const { stderr } = await captureStderrAsync(() => server.emitSessionListChanged());

  assert.deepEqual(events, [], 'a failed list scan must not emit session.list.changed');
  assert.match(stderr, /emitSessionListChanged\.failed/);
  assert.match(stderr, /list scan exploded/);
});

test('emitSessionOpened is a no-op for an unknown session path without building a payload', async () => {
  const server = makeServer();
  let builds = 0;
  server.buildSessionOpenedPayload = async () => { builds += 1; };
  const events: EmittedEvent[] = [];
  server.emit = (event: string, payload?: unknown) => events.push({ event, payload });

  await server.emitSessionOpened('/missing');

  assert.equal(builds, 0, 'an unknown session must short-circuit before building the payload');
  assert.deepEqual(events, []);
});

// ---------------------------------------------------------------------------
// 2. Disposal clears every active-request / watchdog timer
// ---------------------------------------------------------------------------

test('dispose clears every active-request and watchdog timer so none can fire post-shutdown', async () => {
  const server = makeServer();
  const fired: string[] = [];
  const arm = (label: string, ms = 30): ReturnType<typeof setTimeout> =>
    setTimeout(() => fired.push(label), ms);

  const activeRequest = {
    id: 'r1',
    messageIndex: 1,
    aborted: false,
    promptSafetyTimer: arm('promptSafety'),
    semanticLeaseTimer: arm('semanticLease'),
    quotaSettlementTimer: arm('quotaSettlement'),
  };
  const context = makeContext('/s', {
    activeRequest: activeRequest as any,
    willRetryWatchdogTimer: arm('willRetryWatchdog'),
    willRetryWatchdogClear: () => fired.push('willRetryWatchdogClear'),
  });
  server.sessionContexts.set('/s', context);

  await server.dispose();

  // Every handle is cleared (direct proof of clearTimeout), and the clear fn ran.
  assert.equal(context.willRetryWatchdogClear, undefined);
  assert.equal(context.willRetryWatchdogTimer, undefined);
  assert.equal(activeRequest.promptSafetyTimer, undefined);
  assert.equal(activeRequest.semanticLeaseTimer, undefined);
  assert.equal(activeRequest.quotaSettlementTimer, undefined);
  assert.ok(fired.includes('willRetryWatchdogClear'), 'the watchdog clear fn is invoked');

  // Wait past every armed delay: nothing fired because every timer was cleared.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(
    fired.filter((label) => label !== 'willRetryWatchdogClear'),
    [],
    'no cleared timer may fire post-shutdown',
  );
});

test('dispose clears the willRetry watchdog handle directly even without a clear fn', async () => {
  const server = makeServer();
  const fired: string[] = [];
  const context = makeContext('/s', {
    // No willRetryWatchdogClear: the direct handle clear must still run.
    willRetryWatchdogTimer: setTimeout(() => fired.push('willRetryWatchdog'), 30),
  });
  server.sessionContexts.set('/s', context);

  await server.dispose();

  assert.equal(context.willRetryWatchdogTimer, undefined);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(fired, [], 'the watchdog timer is cleared even with no clear fn');
});

test('dispose clears pendingDurableToolTerminals on the active request', async () => {
  const server = makeServer();
  const pending = new Map([['call-1', { toolCallId: 'call-1' } as any]]);
  const activeRequest = { id: 'r1', messageIndex: 1, aborted: false, pendingDurableToolTerminals: pending };
  const context = makeContext('/s', { activeRequest: activeRequest as any });
  server.sessionContexts.set('/s', context);

  await server.dispose();

  assert.equal(activeRequest.pendingDurableToolTerminals!.size, 0, 'pending durable terminals are dropped');
});

// ---------------------------------------------------------------------------
// 3. Hung disposal is bounded
// ---------------------------------------------------------------------------

test('dispose resolves within the grace bound even when runtime.dispose never settles', async () => {
  await withGrace(50, async () => {
    const server = makeServer();
    let disposeCalled = false;
    const context = makeContext('/s', {
      runtime: { dispose: () => new Promise<void>(() => { disposeCalled = true; }) },
    });
    server.sessionContexts.set('/s', context);

    const started = Date.now();
    // Race against a hard cap well beyond the grace: if the bound regresses,
    // dispose hangs and this rejects instead of resolving.
    await Promise.race([
      server.dispose(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('dispose hung past grace')), 2_000)),
    ]);
    const elapsed = Date.now() - started;

    assert.ok(disposeCalled, 'runtime.dispose is still invoked (not skipped)');
    assert.ok(elapsed < 2_000, 'a wedged runtime.dispose cannot block shutdown');
  });
});

test('dispose bounds a rejecting runtime.dispose and continues to later contexts', async () => {
  await withGrace(50, async () => {
    const server = makeServer();
    const disposed: string[] = [];
    server.sessionContexts.set('/a', makeContext('/a', {
      runtime: { dispose: async () => { throw new Error('A exploded'); } },
    }));
    server.sessionContexts.set('/b', makeContext('/b', {
      runtime: { dispose: async () => { disposed.push('/b'); } },
    }));

    await server.dispose();

    assert.deepEqual(disposed, ['/b'], 'a rejecting runtime must not strand the remaining contexts');
    assert.equal(server.sessionContexts.size, 0);
  });
});

// ---------------------------------------------------------------------------
// 4. In-flight recovery replacement contexts are torn down (no leak)
// ---------------------------------------------------------------------------

test('dispose awaits an in-flight recovery and tears down the replacement runtime too', async () => {
  await withGrace(2_000, async () => {
    const server = makeServer();
    const disposed: string[] = [];
    const replacement = makeContext('/s', {
      runtime: { dispose: async () => { disposed.push('replacement'); } },
    });
    // Simulate recoverStuckSession's in-flight replacement: the retired
    // context holds a recoveryPromise that resolves to a fresh context whose
    // runtime would otherwise leak (the dispose snapshot predates it).
    const old = makeContext('/s', {
      retired: true,
      runtime: { dispose: async () => { disposed.push('old'); } },
      recoveryPromise: new Promise<SessionContext>((resolve) => {
        setTimeout(() => resolve(replacement), 10);
      }),
    });
    server.sessionContexts.set('/s', old);

    await server.dispose();

    assert.deepEqual(
      disposed.sort(),
      ['old', 'replacement'],
      'both the retired runtime and the in-flight replacement runtime are disposed',
    );
  });
});

test('dispose does not hang when an in-flight recovery never settles', async () => {
  await withGrace(50, async () => {
    const server = makeServer();
    const disposed: string[] = [];
    const old = makeContext('/s', {
      retired: true,
      runtime: { dispose: async () => { disposed.push('old'); } },
      // Recovery never resolves (provider wedged mid-replacement).
      recoveryPromise: new Promise<SessionContext>(() => undefined),
    });
    server.sessionContexts.set('/s', old);

    await Promise.race([
      server.dispose(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('dispose hung on in-flight recovery')), 2_000)),
    ]);

    assert.deepEqual(disposed, ['old'], 'the retired runtime is still disposed even if the recovery never lands');
  });
});

// ---------------------------------------------------------------------------
// 5. Post-disposal stale state is suppressed
// ---------------------------------------------------------------------------

test('a disposed server suppresses every stale event (emit guarded by disposed)', async () => {
  // Positive control on a fresh, live server: the event reaches stdout.
  const live = makeServer();
  const liveOut = captureStdoutSync(() => live.emit('test.event', { marker: 'LIVE_MARKER_X' }));
  assert.match(liveOut, /LIVE_MARKER_X/, 'a live server writes emitted events to stdout');

  // After disposal the same emit is suppressed. The shared writer is idle
  // (no prior write on this server), so absence is attributable to the guard.
  const dead = makeServer();
  dead.sessionContexts.set('/s', makeContext('/s'));
  await dead.dispose();
  assert.equal(dead.disposed, true);
  const deadOut = captureStdoutSync(() => dead.emit('test.event', { marker: 'DEAD_MARKER_Y' }));
  assert.doesNotMatch(deadOut, /DEAD_MARKER_Y/, 'a disposed server suppresses stale events');
});

test('emitSessionOpened and emitSessionListChanged skip payload builds after disposal', async () => {
  const server = makeServer();
  let builds = 0;
  let listScans = 0;
  server.buildSessionOpenedPayload = async () => { builds += 1; };
  server.listSessionSummaries = async () => { listScans += 1; return []; };
  server.emit = () => undefined;
  server.sessionContexts.set('/s', makeContext('/s'));

  await server.dispose();
  // Simulate an in-flight recovery re-adding a context to the cleared map: the
  // `disposed` guard must still short-circuit before any payload/list work.
  server.sessionContexts.set('/s', makeContext('/s'));

  await server.emitSessionOpened('/s');
  await server.emitSessionListChanged();

  assert.equal(builds, 0, 'emitSessionOpened must not build a payload after disposal');
  assert.equal(listScans, 0, 'emitSessionListChanged must not scan the list after disposal');
});

test('dispose is idempotent and does not run teardown twice', async () => {
  await withGrace(50, async () => {
    const server = makeServer();
    let disposeCalls = 0;
    server.sessionContexts.set('/s', makeContext('/s', {
      runtime: { dispose: async () => { disposeCalls += 1; } },
    }));

    await server.dispose();
    await server.dispose();

    assert.equal(disposeCalls, 1, 'a second dispose call is a no-op');
  });
});
