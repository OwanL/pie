/**
 * Unit tests for the user-facing 'proxy restarted' notice contract in
 * ProxyService.stop().
 *
 * Pins the behaviour described in STATE_CONTRACT.md Notice Surfacing and the
 * Bug 5 comments in proxy-service.ts: when stop() kills a tracked proxy
 * child, it MUST invoke this.onInFlightInterrupted with a structured payload
 * BEFORE the kill, and a buggy/throwing listener MUST NOT block the kill.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { ProxyService } from '../src/host/backend/proxy-service';

type Event = { type: 'notice' | 'kill' | 'processKill'; ts: number; payload?: unknown };

let events: Event[] = [];
let monotonicTs = 0;
let spawnSyncCalls: Array<{ args: unknown[]; opts?: unknown }> = [];
let originalProcessKill: typeof process.kill;

function now(): number {
  monotonicTs += 1;
  return monotonicTs;
}

const stubbedChildProcess = {
  spawnSync: (command: string, args?: unknown[], options?: unknown): unknown => {
    spawnSyncCalls.push({ args: [command, args], opts: options });
    return {};
  },
  spawn: (): unknown => ({}),
};

type ModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown;
const ModuleInternals = Module as unknown as { _load: ModuleLoad };
const originalLoad: ModuleLoad = ModuleInternals._load;
ModuleInternals._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'node:child_process') {
    return stubbedChildProcess;
  }
  return originalLoad.call(this, request, parent, isMain);
};

test.beforeEach(() => {
  events = [];
  monotonicTs = 0;
  spawnSyncCalls = [];
  originalProcessKill = process.kill;
  process.kill = ((...args: unknown[]): boolean => {
    events.push({ type: 'processKill', ts: now(), payload: args });
    return true;
  }) as typeof process.kill;
});

test.afterEach(() => {
  process.kill = originalProcessKill;
});

function createServiceWithProc(pid: number): { service: ProxyService; fakeProc: { pid: number; kill: () => void } } {
  const fakeProc = {
    pid,
    kill: (): void => {
      events.push({ type: 'kill', ts: now() });
    },
  };
  const service = new ProxyService();
  (service as unknown as { proc: typeof fakeProc }).proc = fakeProc;
  return { service, fakeProc };
}

test('stop() fires onInFlightInterrupted exactly once, with the structured payload, BEFORE the kill', async () => {
  const { service } = createServiceWithProc(4242);

  const notices: Array<{ code: string; message: string; pid: number }> = [];
  service.onInFlightInterrupted = (payload) => {
    events.push({ type: 'notice', ts: now(), payload });
    notices.push(payload);
  };

  await service.stop();

  assert.equal(notices.length, 1, 'onInFlightInterrupted must be called exactly once');
  const notice = notices[0];
  assert.equal(notice.code, 'PROXY_RESTART_IN_FLIGHT');
  assert.equal(notice.pid, 4242);
  assert.ok(typeof notice.message === 'string' && notice.message.length > 0, 'message must be a non-empty string');
  assert.match(notice.message, /proxy.*restart|restart.*proxy/i, 'message must mention proxy restart');

  // Ordering: notice event must precede kill event.
  const noticeEvent = events.find((e) => e.type === 'notice');
  const killEvent = events.find((e) => e.type === 'kill');
  assert.ok(noticeEvent, 'notice event must be recorded');
  assert.ok(killEvent, 'kill event must be recorded');
  assert.ok(
    (noticeEvent as Event).ts < (killEvent as Event).ts,
    'notice must fire before proc.kill is invoked',
  );

  assert.equal((service as unknown as { proc?: unknown }).proc, undefined, 'proc must be cleared after stop()');
});

test('stop() with no tracked proc is a no-op and does not fire the notice', async () => {
  const service = new ProxyService();

  let noticeCount = 0;
  service.onInFlightInterrupted = () => {
    noticeCount += 1;
  };

  await service.stop();

  assert.equal(noticeCount, 0, 'no notice must fire when there is no tracked proc');
  assert.equal(spawnSyncCalls.length, 0, 'no child_process calls must occur when there is no tracked proc');
  const processKillEvents = events.filter((e) => e.type === 'processKill');
  assert.equal(processKillEvents.length, 0, 'no process.kill calls must occur when there is no tracked proc');
});

test('a throwing onInFlightInterrupted listener does not prevent proc.kill and does not throw out of stop()', async () => {
  const { service } = createServiceWithProc(4242);

  service.onInFlightInterrupted = () => {
    events.push({ type: 'notice', ts: now() });
    throw new Error('boom');
  };

  await assert.doesNotReject(service.stop(), 'stop() must not throw even if the listener throws');

  const killEvent = events.find((e) => e.type === 'kill');
  assert.ok(killEvent, 'proc.kill must still be called when the listener throws');
});

test('after stop(), proc is cleared so a second stop() is a no-op', async () => {
  const { service } = createServiceWithProc(4242);

  let noticeCount = 0;
  service.onInFlightInterrupted = () => {
    noticeCount += 1;
  };

  await service.stop();
  await service.stop();

  assert.equal(noticeCount, 1, 'notice must only fire once across two stops');
  assert.equal((service as unknown as { proc?: unknown }).proc, undefined, 'proc must remain undefined');
});

test('stop() default reason is "config" and the message says "config changed"', async () => {
  const { service } = createServiceWithProc(7788);
  const notices: Array<{ reason: string; message: string }> = [];
  service.onInFlightInterrupted = (payload) => {
    notices.push({ reason: payload.reason, message: payload.message });
  };

  await service.stop();

  assert.equal(notices.length, 1);
  assert.equal(notices[0].reason, 'config');
  assert.match(notices[0].message, /config changed/i, 'default stop() must say "config changed"');
});

test('stop("health-monitor") surfaces "became unresponsive", NOT "config changed"', async () => {
  const { service } = createServiceWithProc(9090);
  const notices: Array<{ reason: string; message: string }> = [];
  service.onInFlightInterrupted = (payload) => {
    notices.push({ reason: payload.reason, message: payload.message });
  };

  await service.stop('health-monitor');

  assert.equal(notices.length, 1);
  assert.equal(notices[0].reason, 'health-monitor');
  assert.doesNotMatch(
    notices[0].message, /config changed/i,
    'a health-monitor recovery must NOT be mislabeled as a config edit',
  );
  assert.match(
    notices[0].message, /unresponsive/i,
    'a health-monitor recovery must say the proxy became unresponsive',
  );
  assert.match(
    notices[0].message, /proxy.*restart|restart.*proxy/i,
    'the message must still mention "proxy restart" so the generic test regex holds',
  );
});

test('stop("dispose") surfaces a stopping notice, NOT "config changed"', async () => {
  const { service } = createServiceWithProc(9091);
  const notices: Array<{ reason: string; message: string }> = [];
  service.onInFlightInterrupted = (payload) => {
    notices.push({ reason: payload.reason, message: payload.message });
  };

  await service.stop('dispose');

  assert.equal(notices.length, 1);
  assert.equal(notices[0].reason, 'dispose');
  assert.doesNotMatch(notices[0].message, /config changed/i, 'dispose must not be mislabeled as a config edit');
  assert.match(notices[0].message, /stopping/i, 'dispose must say the proxy is stopping');
});
