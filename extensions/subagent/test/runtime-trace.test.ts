import assert from 'node:assert/strict';
import test from 'node:test';

import { isRuntimeTraceEnabled, recordRuntimeTrace } from '../src/runtime-trace.js';

const SINK = Symbol.for('pie.runtime-trace-sink.v1');

test('runtime trace bridge is inert without a backend sink', () => {
  const target = globalThis as Record<PropertyKey, unknown>;
  const previous = target[SINK];
  delete target[SINK];
  try {
    assert.doesNotThrow(() => recordRuntimeTrace({ phase: 'source_update', childCount: 1 }));
  } finally {
    if (previous === undefined) delete target[SINK];
    else target[SINK] = previous;
  }
});

test('runtime trace bridge forwards only metadata to the process-local sink', () => {
  const target = globalThis as Record<PropertyKey, unknown>;
  const previous = target[SINK];
  const received: unknown[] = [];
  target[SINK] = (event: unknown) => received.push(event);
  try {
    recordRuntimeTrace({
      phase: 'clone',
      durationMs: 2,
      childCount: 2,
      messageCount: 5,
      payloadClass: 'compact',
      identifiers: { tool: 'tool-private' },
    });
    recordRuntimeTrace({
      phase: 'dedupe',
      outcome: 'duplicate',
      sourcePayloadBytes: 128,
      producedPayloadBytes: 42,
      payloadClass: 'compact',
      identifiers: { attempt: 'attempt-1', tool: 'tool-private' },
    });
    recordRuntimeTrace({
      phase: 'terminal',
      childCount: 1,
      messageCount: 3,
      payloadClass: 'terminal_append',
      identifiers: { request: 'request-1' },
    });
    assert.deepEqual(received, [{
      phase: 'clone',
      durationMs: 2,
      childCount: 2,
      messageCount: 5,
      payloadClass: 'compact',
      identifiers: { tool: 'tool-private' },
    }, {
      phase: 'dedupe',
      outcome: 'duplicate',
      sourcePayloadBytes: 128,
      producedPayloadBytes: 42,
      payloadClass: 'compact',
      identifiers: { attempt: 'attempt-1', tool: 'tool-private' },
    }, {
      phase: 'terminal',
      childCount: 1,
      messageCount: 3,
      payloadClass: 'terminal_append',
      identifiers: { request: 'request-1' },
    }]);
  } finally {
    if (previous === undefined) delete target[SINK];
    else target[SINK] = previous;
  }
});

test('runtime trace bridge reports whether a callable sink is installed', () => {
  const target = globalThis as Record<PropertyKey, unknown>;
  const previous = target[SINK];
  delete target[SINK];
  try {
    assert.equal(isRuntimeTraceEnabled(), false);
    target[SINK] = () => undefined;
    assert.equal(isRuntimeTraceEnabled(), true);
  } finally {
    if (previous === undefined) delete target[SINK];
    else target[SINK] = previous;
  }
});

test('runtime trace bridge swallows sink failures', () => {
  const target = globalThis as Record<PropertyKey, unknown>;
  const previous = target[SINK];
  target[SINK] = () => { throw new Error('trace sink unavailable'); };
  try {
    assert.doesNotThrow(() => recordRuntimeTrace({ phase: 'clone', durationMs: 1 }));
  } finally {
    if (previous === undefined) delete target[SINK];
    else target[SINK] = previous;
  }
});
