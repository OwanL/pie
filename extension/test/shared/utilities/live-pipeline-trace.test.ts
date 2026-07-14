import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBoundedLivePipelineTraceFingerprint,
  createHardenedLivePipelineTraceIdentifier,
  createLivePipelineTraceRecord,
  isLivePipelineTraceKind,
  isLivePipelineTraceStage,
  LIVE_PIPELINE_TRACE_KINDS,
  LIVE_PIPELINE_TRACE_SCHEMA_VERSION,
  LIVE_PIPELINE_TRACE_STAGES,
} from '../../../src/shared/live-pipeline-trace';

test('schema locks stage and kind to explicit operation allowlists', () => {
  for (const stage of LIVE_PIPELINE_TRACE_STAGES) assert.equal(isLivePipelineTraceStage(stage), true);
  for (const kind of LIVE_PIPELINE_TRACE_KINDS) assert.equal(isLivePipelineTraceKind(kind), true);
  assert.equal(isLivePipelineTraceStage('command'), false);
  assert.equal(isLivePipelineTraceKind('raw error'), false);
});

test('hardened identifiers are stable for a key and resist low-entropy guessing', () => {
  const first = createHardenedLivePipelineTraceIdentifier('private-session-id', 'test-key');
  assert.equal(first, createHardenedLivePipelineTraceIdentifier('private-session-id', 'test-key'));
  assert.notEqual(first, createHardenedLivePipelineTraceIdentifier('private-session-id', 'other-key'));
  assert.equal(first.includes('private-session-id'), false);
});

test('bounded fingerprints contain only length, bounded bytes, and hash', () => {
  const fingerprint = createBoundedLivePipelineTraceFingerprint('😀'.repeat(5_000), 64);
  assert.deepEqual(Object.keys(fingerprint).sort(), ['bytes', 'hash', 'length']);
  assert.equal(fingerprint.length, 10_000);
  assert.ok(fingerprint.bytes <= 64);
  assert.match(fingerprint.hash, /^[a-f0-9]{64}$/u);
});

test('record creation joins hardened IDs while copying only closed metadata', () => {
  const fingerprint = createBoundedLivePipelineTraceFingerprint('sensitive payload', 32);
  const record = createLivePipelineTraceRecord({
    process: 'backend',
    stage: 'backend.mapped',
    kind: 'success',
    identifiers: { session: 'private-session-id', turn: 'turn-1' },
    eventKind: 'text',
    eventSeq: 3,
    durationMs: 12,
    fingerprint,
  }, { hmacKey: 'test-key', wallTimestampMs: 1_234, monoMs: 25 });

  assert.equal(record.schemaVersion, LIVE_PIPELINE_TRACE_SCHEMA_VERSION);
  assert.equal(record.ts, new Date(1_234).toISOString());
  assert.equal(record.monoMs, 25);
  assert.equal(record.sessionHash, createHardenedLivePipelineTraceIdentifier('private-session-id', 'test-key'));
  assert.equal(record.turnHash, createHardenedLivePipelineTraceIdentifier('turn-1', 'test-key'));
  assert.equal(record.eventSeq, 3);
  assert.equal(JSON.stringify(record).includes('private-session-id'), false);
  assert.equal(JSON.stringify(record).includes('sensitive payload'), false);
  assert.equal('error' in record || 'path' in record || 'command' in record, false);
});

test('record creation rejects invalid numeric and arbitrary classification metadata', () => {
  assert.throws(() => createLivePipelineTraceRecord({
    process: 'host', stage: 'host.post.timeout', kind: 'timeout', durationMs: -1,
  }, { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1 }), RangeError);
  assert.throws(() => createLivePipelineTraceRecord({
    process: 'host', stage: 'host.recovery.action', kind: 'recovery', reasonCode: 'raw body' as never,
  }, { hmacKey: 'key', wallTimestampMs: 1, monoMs: 1 }), RangeError);
});
