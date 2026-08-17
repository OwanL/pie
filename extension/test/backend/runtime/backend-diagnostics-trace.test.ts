import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import test from 'node:test';

import { BackendServer } from '../../../src/backend/server';
import {
  flushBackendLivePipelineTrace,
  getBackendLivePipelineTracePath,
  isBackendLivePipelineTraceEnabled,
  setBackendLivePipelineTraceEnabled,
} from '../../../src/backend/live-pipeline-trace-runtime';
import { readBackendRequestTracePhases } from '../../helpers/backend-live-pipeline-trace';

test('BackendServer defers diagnostics off until the exact handleLine completion and stops its monitor', async () => {
  const server = new BackendServer({ sdkPath: '/sdk', cwd: '/workspace' }) as any;
  const before = await fs.readFile(getBackendLivePipelineTracePath(), 'utf8').catch(() => '');
  const wasEnabled = isBackendLivePipelineTraceEnabled();
  const monitorCalls: string[] = [];
  server.startEventLoopMonitor = () => { monitorCalls.push('on'); };
  server.stopEventLoopMonitor = () => { monitorCalls.push('off'); };
  let stdout = '';
  const originalWrite = process.stdout.write;
  (process.stdout as any).write = (chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (!text.trimStart().startsWith('{')) {
      if (typeof encodingOrCallback === 'function') return (originalWrite as any).call(process.stdout, chunk, encodingOrCallback);
      if (callback !== undefined) return (originalWrite as any).call(process.stdout, chunk, encodingOrCallback, callback);
      return (originalWrite as any).call(process.stdout, chunk, encodingOrCallback);
    }
    stdout += text;
    if (typeof done === 'function') done(null);
    return true;
  };

  setBackendLivePipelineTraceEnabled(false);
  try {
    await server.handleLine(JSON.stringify({
      id: 'production-trace-on', method: 'diagnostics.livePipeline.setEnabled', params: { enabled: true },
    }));
    assert.equal(isBackendLivePipelineTraceEnabled(), true);
    assert.deepEqual(monitorCalls, ['on']);

    await server.handleLine(JSON.stringify({
      id: 'production-trace-off', method: 'diagnostics.livePipeline.setEnabled', params: { enabled: false },
    }));
    assert.equal(isBackendLivePipelineTraceEnabled(), false);
    assert.deepEqual(monitorCalls, ['on', 'off']);

    const responses = stdout.trim().split('\n').map((line) => JSON.parse(line) as {
      id: string;
      result?: { enabled?: boolean; health?: { enabled?: boolean } };
    });
    assert.deepEqual(responses.map((response) => response.id), ['production-trace-on', 'production-trace-off']);
    assert.equal(responses[1]?.result?.enabled, false);
    assert.equal(responses[1]?.result?.health?.enabled, false);

    await flushBackendLivePipelineTrace();
  } finally {
    (process.stdout as any).write = originalWrite;
    setBackendLivePipelineTraceEnabled(wasEnabled);
    await flushBackendLivePipelineTrace();
    await server.dispose();
  }

  const phases = await readBackendRequestTracePhases(before, ['production-trace-on', 'production-trace-off']);
  // Request identifiers are intentionally hashed in persisted diagnostics;
  // the first request starts with route_selected because tracing was off, while
  // the second also carries the already-enabled request_received observation.
  assert.deepEqual(phases, [
    'route_selected:transition',
    'request_validated:success',
    'handler_started:start',
    'handler_finished:success',
    'request_received:observation',
    'route_selected:transition',
    'request_validated:success',
    'handler_started:start',
    'handler_finished:success',
  ]);
});

test('BackendServer keeps pending diagnostics disables keyed by request and clears them on failure/dispose', async () => {
  const server = new BackendServer({ sdkPath: '/sdk', cwd: '/workspace' }) as any;
  const wasEnabled = isBackendLivePipelineTraceEnabled();
  const originalWrite = process.stdout.write;
  server.startEventLoopMonitor = () => undefined;
  server.stopEventLoopMonitor = () => undefined;
  (process.stdout as any).write = (chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (!text.trimStart().startsWith('{')) {
      if (typeof encodingOrCallback === 'function') return (originalWrite as any).call(process.stdout, chunk, encodingOrCallback);
      if (callback !== undefined) return (originalWrite as any).call(process.stdout, chunk, encodingOrCallback, callback);
      return (originalWrite as any).call(process.stdout, chunk, encodingOrCallback);
    }
    if (typeof done === 'function') done(null);
    return true;
  };
  setBackendLivePipelineTraceEnabled(true);
  try {
    const generationA = server.reserveLivePipelineTraceToggle();
    assert.equal(server.deferLivePipelineTraceDisable('request-a', generationA), true);
    assert.equal(server.deferLivePipelineTraceDisable('request-a', generationA), true, 'a retry keeps the same request pending');
    assert.equal(server.pendingLivePipelineTraceDisables.size, 1);
    assert.equal(server.completeLivePipelineTraceDisable('request-b'), false, 'an unrelated completion cannot consume the pending disable');
    assert.equal(isBackendLivePipelineTraceEnabled(), true);

    // A newer on transition supersedes the older exact off identity rather
    // than allowing its later completion to undo the successful enable. The
    // supersession is established at the on request's receipt reservation.
    server.reserveLivePipelineTraceToggle();
    await server.handleRequest({
      id: 'request-on-after-off', method: 'diagnostics.livePipeline.setEnabled', params: { enabled: true },
    });
    assert.equal(server.pendingLivePipelineTraceDisables.size, 0);
    assert.equal(server.completeLivePipelineTraceDisable('request-a'), false);
    assert.equal(isBackendLivePipelineTraceEnabled(), true);

    server.handleRequest = async (request: { id: string }, _onRequestValidated?: () => void, toggleGeneration?: number) => {
      server.deferLivePipelineTraceDisable(request.id, toggleGeneration ?? 0);
      throw new Error('diagnostics request failed');
    };
    await server.handleLine(JSON.stringify({
      id: 'request-failed', method: 'diagnostics.livePipeline.setEnabled', params: { enabled: false },
    }));
    assert.equal(server.pendingLivePipelineTraceDisables.has('request-failed'), false);

    server.deferLivePipelineTraceDisable('request-disposed', server.reserveLivePipelineTraceToggle());
    await server.dispose();
    assert.equal(server.pendingLivePipelineTraceDisables.size, 0);
  } finally {
    (process.stdout as any).write = originalWrite;
    setBackendLivePipelineTraceEnabled(wasEnabled);
    await flushBackendLivePipelineTrace();
  }
});

test('BackendServer orders concurrent diagnostics toggles by receipt: an older off settling after a newer on never disables tracing or the monitor', async () => {
  const server = new BackendServer({ sdkPath: '/sdk', cwd: '/workspace' }) as any;
  const before = await fs.readFile(getBackendLivePipelineTracePath(), 'utf8').catch(() => '');
  const wasEnabled = isBackendLivePipelineTraceEnabled();
  const monitorCalls: string[] = [];
  server.startEventLoopMonitor = () => { monitorCalls.push('on'); };
  server.stopEventLoopMonitor = () => { monitorCalls.push('off'); };
  let stdout = '';
  const originalWrite = process.stdout.write;
  (process.stdout as any).write = (chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (!text.trimStart().startsWith('{')) {
      if (typeof encodingOrCallback === 'function') return (originalWrite as any).call(process.stdout, chunk, encodingOrCallback);
      if (callback !== undefined) return (originalWrite as any).call(process.stdout, chunk, encodingOrCallback, callback);
      return (originalWrite as any).call(process.stdout, chunk, encodingOrCallback);
    }
    stdout += text;
    if (typeof done === 'function') done(null);
    return true;
  };

  setBackendLivePipelineTraceEnabled(false);
  try {
    // Gate each request's completion so the test controls settlement order:
    // the real handler work runs (and the off defers) at its natural settle,
    // but handleLine's completion boundary is held until the gate releases.
    const realHandleRequest = server.handleRequest.bind(server);
    const gates = new Map<string, () => void>();
    server.handleRequest = (request: { id: string }, onRequestValidated?: () => void, toggleGeneration?: number) => {
      const real = realHandleRequest(request, onRequestValidated, toggleGeneration);
      const gate = new Promise<void>((resolve) => { gates.set(request.id, resolve); });
      return Promise.all([real, gate]).then(([value]) => value);
    };

    // Receipt order: off first, then on. The on is applied at its dispatch
    // boundary (synchronously with receipt), before either request's
    // completion settles.
    const offLine = server.handleLine(JSON.stringify({
      id: 'concurrent-off', method: 'diagnostics.livePipeline.setEnabled', params: { enabled: false },
    }));
    const onLine = server.handleLine(JSON.stringify({
      id: 'concurrent-on', method: 'diagnostics.livePipeline.setEnabled', params: { enabled: true },
    }));

    // Settle the newer on first, then the older off.
    gates.get('concurrent-on')!();
    await onLine;
    assert.equal(isBackendLivePipelineTraceEnabled(), true, 'the on must be applied');
    assert.deepEqual(monitorCalls, ['on']);

    gates.get('concurrent-off')!();
    await offLine;
    // The stale off must not disable tracing or stop the event-loop monitor.
    assert.equal(isBackendLivePipelineTraceEnabled(), true, 'a stale off must not disable tracing');
    assert.deepEqual(monitorCalls, ['on'], 'a stale off must not stop the monitor');

    const responses = stdout.trim().split('\n').map((line) => JSON.parse(line) as {
      id: string;
      result?: { enabled?: boolean; health?: { enabled?: boolean } };
    });
    assert.deepEqual(responses.map((response) => response.id), ['concurrent-on', 'concurrent-off']);
    assert.equal(responses[0]?.result?.enabled, true);
    assert.equal(responses[0]?.result?.health?.enabled, true);
    // The stale off reports its desired enablement but the truthful current
    // health: the newer on still owns the global state.
    assert.equal(responses[1]?.result?.enabled, false);
    assert.equal(responses[1]?.result?.health?.enabled, true);

    await flushBackendLivePipelineTrace();
  } finally {
    (process.stdout as any).write = originalWrite;
    setBackendLivePipelineTraceEnabled(wasEnabled);
    await flushBackendLivePipelineTrace();
    await server.dispose();
  }

  // Both requests' traces are complete under the state they establish: the
  // on's prefix is recorded under the enabled state it establishes, and the
  // older off's completion is recorded while the newer on still owns the
  // store (its own prefix was dropped while tracing was still disabled).
  const phases = await readBackendRequestTracePhases(before, ['concurrent-off', 'concurrent-on']);
  assert.deepEqual(phases, [
    'route_selected:transition',
    'request_validated:success',
    'handler_started:start',
    'handler_finished:success',
    'handler_finished:success',
  ]);
});

test('BackendServer applies a newer off after its own handler_finished even when an older on settles first', async () => {
  const server = new BackendServer({ sdkPath: '/sdk', cwd: '/workspace' }) as any;
  const wasEnabled = isBackendLivePipelineTraceEnabled();
  const monitorCalls: string[] = [];
  server.startEventLoopMonitor = () => { monitorCalls.push('on'); };
  server.stopEventLoopMonitor = () => { monitorCalls.push('off'); };
  let stdout = '';
  const originalWrite = process.stdout.write;
  (process.stdout as any).write = (chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (!text.trimStart().startsWith('{')) {
      if (typeof encodingOrCallback === 'function') return (originalWrite as any).call(process.stdout, chunk, encodingOrCallback);
      if (callback !== undefined) return (originalWrite as any).call(process.stdout, chunk, encodingOrCallback, callback);
      return (originalWrite as any).call(process.stdout, chunk, encodingOrCallback);
    }
    stdout += text;
    if (typeof done === 'function') done(null);
    return true;
  };

  setBackendLivePipelineTraceEnabled(false);
  try {
    const realHandleRequest = server.handleRequest.bind(server);
    const gates = new Map<string, () => void>();
    server.handleRequest = (request: { id: string }, onRequestValidated?: () => void, toggleGeneration?: number) => {
      const real = realHandleRequest(request, onRequestValidated, toggleGeneration);
      const gate = new Promise<void>((resolve) => { gates.set(request.id, resolve); });
      return Promise.all([real, gate]).then(([value]) => value);
    };

    // Receipt order: on first, then off. The off is the latest requested
    // generation, so it must still apply after its own handler_finished even
    // though the older on settles first.
    const onLine = server.handleLine(JSON.stringify({
      id: 'reverse-on', method: 'diagnostics.livePipeline.setEnabled', params: { enabled: true },
    }));
    const offLine = server.handleLine(JSON.stringify({
      id: 'reverse-off', method: 'diagnostics.livePipeline.setEnabled', params: { enabled: false },
    }));

    gates.get('reverse-on')!();
    await onLine;
    assert.equal(isBackendLivePipelineTraceEnabled(), true);
    assert.deepEqual(monitorCalls, ['on']);

    gates.get('reverse-off')!();
    await offLine;
    assert.equal(isBackendLivePipelineTraceEnabled(), false, 'the newer off must apply after its own handler_finished');
    assert.deepEqual(monitorCalls, ['on', 'off']);

    const responses = stdout.trim().split('\n').map((line) => JSON.parse(line) as {
      id: string;
      result?: { enabled?: boolean; health?: { enabled?: boolean } };
    });
    assert.deepEqual(responses.map((response) => response.id), ['reverse-on', 'reverse-off']);
    assert.equal(responses[0]?.result?.enabled, true);
    assert.equal(responses[0]?.result?.health?.enabled, true);
    assert.equal(responses[1]?.result?.enabled, false);
    assert.equal(responses[1]?.result?.health?.enabled, false, 'the off response health must reflect the post-disable state');
  } finally {
    (process.stdout as any).write = originalWrite;
    setBackendLivePipelineTraceEnabled(wasEnabled);
    await flushBackendLivePipelineTrace();
    await server.dispose();
  }
});
