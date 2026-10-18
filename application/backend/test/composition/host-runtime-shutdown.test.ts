import test from 'node:test';
import assert from 'node:assert/strict';
import { HostRuntime } from '../../composition/host-runtime.js';
import { setPieLoggerOutputAdapter } from '../../../../lib/structured-logging/pie-logger.js';

test('pre-backend timings preserve ordering, degraded analytics and fatal stage failures', async (t) => {
  const payloads: Array<{ stage: string; outcome: string; durationMs: number }> = [];
  setPieLoggerOutputAdapter({ accepts: () => true, emit: (_level, _scope, line) => {
    if (line.includes('DEBUG-startup-preflight')) payloads.push(JSON.parse(line.slice(line.indexOf('{'))));
  } });
  t.after(() => setPieLoggerOutputAdapter(undefined));
  for (const failure of [null, 'handoff', 'analytics', 'privacy', 'stats']) {
    payloads.length = 0;
    const calls: string[] = [];
    const error = new Error('private-failure-content');
    const step = (name: string) => { calls.push(name); if (failure === name) throw error; };
    const runtime = Object.assign(Object.create(HostRuntime.prototype), {
      startupPromise: null, shutdownRequested: false,
      reportStatus: () => undefined,
      analyticsHandoffControl: { start: async () => step('handoff') },
      analyticsRuntime: { start: async () => step('analytics') },
      platform: { notifications: { showWarningMessage: () => step('warning') } },
      hydratePrivacyMarkers: () => step('privacy'),
      tokenRateService: { start: () => step('rates') },
      aggregateStatsService: { start: () => step('aggregate') },
      statsService: { start: async () => step('stats') },
      service: { start: async () => step('session') },
      browserServer: { start: async () => step('browser') },
    }) as HostRuntime;
    if (failure && failure !== 'analytics') await assert.rejects(runtime.start(), (caught) => caught === error);
    else await runtime.start();
    const expected = ['handoff', 'analytics', ...(failure === 'analytics' ? ['warning'] : []), 'privacy', 'rates', 'aggregate', 'stats', 'session', 'browser'];
    assert.deepEqual(calls, failure && failure !== 'analytics' ? expected.slice(0, expected.indexOf(failure) + 1) : expected);
    const stages = ['analytics-handoff-start', 'analytics-runtime-start', 'privacy-marker-initialization', 'host-stats-start'];
    const failedIndex = ['handoff', 'analytics', 'privacy', 'stats'].indexOf(failure ?? '');
    assert.deepEqual(payloads.map(({ stage }) => stage), failure && failure !== 'analytics' ? stages.slice(0, failedIndex + 1) : stages);
    for (const [index, payload] of payloads.entries()) {
      assert.deepEqual(Object.keys(payload).sort(), ['durationMs', 'outcome', 'stage']);
      assert.equal(payload.outcome, index === failedIndex ? 'failure' : 'success');
      assert.ok(Number.isFinite(payload.durationMs) && payload.durationMs >= 0);
      assert.ok(!JSON.stringify(payload).includes(error.message));
    }
  }
});

test('HostRuntime reports uncertain backend lifetime only after complete teardown', async () => {
  for (const confirmed of [true, false]) {
    const calls: string[] = [];
    // No host/backend/SDK activation or analytics storage: all producers fake.
    const runtime = Object.assign(Object.create(HostRuntime.prototype), {
      startupPromise: null,
      shutdownPromise: null,
      analyticsHandoffControl: {
        stop: async () => { calls.push('handoff-stop'); },
        markStopped: async () => { calls.push('handoff-stopped'); },
      },
      browserServer: { dispose: () => { calls.push('browser'); } },
      effectRunner: { dispose: () => { calls.push('effects'); } },
      dictationService: {
        shutdown: async () => { calls.push('dictation-stop'); },
        isLifetimeTeardownConfirmed: () => { calls.push('dictation-lifetime-evidence'); return true; },
      },
      tokenRateService: { dispose: () => { calls.push('rates'); } },
      aggregateStatsService: { dispose: () => { calls.push('aggregate'); } },
      statsService: { shutdown: async () => { calls.push('stats'); } },
      backend: {
        stop: async () => { calls.push('coordinator-exit'); },
        dispose: () => { calls.push('backend-dispose'); },
        isRuntimeLifetimeTeardownConfirmed: () => { calls.push('lifetime-evidence'); return confirmed; },
      },
      analyticsTransport: {
        shutdown: async () => { calls.push('transport-stop'); },
        dispose: () => { calls.push('transport-dispose'); },
      },
      analyticsRuntime: { stop: async () => { calls.push('analytics'); } },
      analyticsHandoffRegistry: { close: () => { calls.push('registry'); } },
      service: { dispose: () => { calls.push('service'); } },
    }) as HostRuntime;
    if (confirmed) await runtime.shutdown();
    else await assert.rejects(runtime.shutdown(), /generation lease must be retained/);
    assert.deepEqual(calls, [
      'handoff-stop', 'browser', 'effects', 'dictation-stop', 'rates', 'aggregate', 'stats',
      'coordinator-exit', 'transport-stop', 'backend-dispose', 'analytics',
      'handoff-stopped', 'transport-dispose', 'registry', 'service',
      'dictation-lifetime-evidence', 'lifetime-evidence',
    ]);
    if (confirmed) await runtime.shutdown();
    else await assert.rejects(runtime.shutdown(), /generation lease must be retained/);
    assert.equal(calls.filter((call) => call === 'service').length, 1);
  }
});
