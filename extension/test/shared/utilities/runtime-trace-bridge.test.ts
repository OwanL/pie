import assert from 'node:assert/strict';
import test from 'node:test';

import { mapRuntimeTraceEvent } from '../../../src/backend/live-pipeline-trace-runtime';
import { createHardenedLivePipelineTraceIdentifier, createLivePipelineTraceRecord } from '../../../src/shared/live-pipeline-trace';
import { installRuntimeTraceSink, recordRuntimeTrace } from '../../../src/shared/runtime-trace-bridge';

const SINK = Symbol.for('pie.runtime-trace-sink.v1');

test('extension runtime trace bridge is inert without an installed sink', () => {
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

test('extension runtime trace bridge forwards metadata and uninstalls cleanly', () => {
  const target = globalThis as Record<PropertyKey, unknown>;
  const previous = target[SINK];
  const received: unknown[] = [];
  installRuntimeTraceSink((event) => received.push(event));
  try {
    recordRuntimeTrace({
      phase: 'diff',
      outcome: 'changed',
      durationMs: 1,
      sourcePayloadBytes: 8,
      producedPayloadBytes: 2,
      payloadClass: 'compact',
      identifiers: { tool: 'tool-private' },
    });
    assert.deepEqual(received, [{
      phase: 'diff',
      outcome: 'changed',
      durationMs: 1,
      sourcePayloadBytes: 8,
      producedPayloadBytes: 2,
      payloadClass: 'compact',
      identifiers: { tool: 'tool-private' },
    }]);
  } finally {
    installRuntimeTraceSink(undefined);
    if (previous === undefined) delete target[SINK];
    else target[SINK] = previous;
  }
  assert.equal(target[SINK], previous);
});

test('production backend mapping preserves dedupe outcome, payload classification, and byte counters', () => {
  const mapped = mapRuntimeTraceEvent({
    phase: 'dedupe',
    outcome: 'duplicate',
    payloadClass: 'compact',
    sourcePayloadBytes: 8_192,
    producedPayloadBytes: 96,
    childCount: 2,
    messageCount: 7,
    maxRecursiveDepth: 3,
    identifiers: { session: 'private-session', tool: 'private-tool' },
    // A content-shaped property is deliberately ignored by the production map.
    prompt: 'never write this content',
  } as never);
  assert.equal(mapped.outcome, 'duplicate');
  assert.equal(mapped.payloadClass, 'compact');
  assert.equal(mapped.sourcePayloadBytes, 8_192);
  assert.equal(mapped.producedPayloadBytes, 96);
  assert.equal(mapped.detailDelivery, undefined, 'the current producer emits no detail delivery');
  assert.equal('detailDelivery' in mapped, false, 'the bridge does not invent a delivery');
  assert.equal('prompt' in mapped, false);

  const record = createLivePipelineTraceRecord({ ...mapped, process: 'backend' }, {
    hmacKey: 'test-key', wallTimestampMs: 1, monoMs: 2,
  });
  assert.equal(record.outcome, 'duplicate');
  assert.equal(record.payloadClass, 'compact');
  assert.equal(record.sourcePayloadBytes, 8_192);
  assert.equal(record.producedPayloadBytes, 96);
  assert.equal(record.sessionHash, createHardenedLivePipelineTraceIdentifier('private-session', 'test-key'));
  assert.equal(JSON.stringify(record).includes('never write this content'), false);
  assert.equal(JSON.stringify(record).includes('private-session'), false);
});

test('production mapping preserves an explicit reason when exact bytes are unavailable', () => {
  const mapped = mapRuntimeTraceEvent({
    phase: 'measure',
    payloadClass: 'detail_page',
    availabilityReason: 'detail_delivery_not_implemented_until_phase_5',
  });
  assert.equal(mapped.producedPayloadBytes, undefined);
  assert.equal(mapped.availabilityReason, 'detail_delivery_not_implemented_until_phase_5');
});

test('production mapping remains metadata-only and the shared sink rejects open outcome values', () => {
  const mapped = mapRuntimeTraceEvent({
    phase: 'dedupe',
    outcome: 'not-a-real-outcome' as never,
    sourcePayloadBytes: 12,
  });
  assert.throws(() => createLivePipelineTraceRecord({ ...mapped, process: 'backend' }, {
    hmacKey: 'test-key', wallTimestampMs: 1, monoMs: 2,
  }), RangeError);
  assert.equal(JSON.stringify(mapped).includes('prompt'), false);
});

test('extension runtime trace bridge swallows sink failures', () => {
  const target = globalThis as Record<PropertyKey, unknown>;
  const previous = target[SINK];
  installRuntimeTraceSink(() => { throw new Error('sink failure'); });
  try {
    assert.doesNotThrow(() => recordRuntimeTrace({ phase: 'measure' }));
  } finally {
    installRuntimeTraceSink(undefined);
    if (previous === undefined) delete target[SINK];
    else target[SINK] = previous;
  }
});
