import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeJsonl, JsonlDecoder, JsonlProtocolError } from '../src/protocol.js';
import { SidecarJsonlDecoder } from '../src/sidecar-core.mjs';
import { MAX_JSONL_BYTES } from '../src/types.js';

test('decoder parses multiple records across arbitrary chunk splits', () => {
  const decoder = new JsonlDecoder();
  const a = JSON.stringify({ v: 1, kind: 'response', id: '1', ok: true, result: {} });
  const b = JSON.stringify({ v: 1, kind: 'response', id: '2', ok: true, result: { ünicode: '✓' } });
  const payload = Buffer.from(`${a}\n${b}\n`, 'utf8');
  const records: unknown[] = [];
  for (let index = 0; index < payload.length; index += 3) {
    records.push(...decoder.push(payload.subarray(index, index + 3)));
  }
  assert.equal(records.length, 2);
  assert.equal((records[1] as { result: { ünicode: string } }).result.ünicode, '✓');
});

test('decoder rejects malformed and oversized records', () => {
  const decoder = new JsonlDecoder();
  assert.throws(() => decoder.push('not json\n'), (error) => error instanceof JsonlProtocolError && error.code === 'MALFORMED_JSONL');
  const oversized = new JsonlDecoder();
  assert.throws(() => oversized.push(`${'a'.repeat(MAX_JSONL_BYTES + 2)}\n`), (error) => error instanceof JsonlProtocolError && error.code === 'OVERSIZED_JSONL');
  const growing = new JsonlDecoder();
  assert.throws(() => growing.push('a'.repeat(MAX_JSONL_BYTES + 2)), (error) => error instanceof JsonlProtocolError && error.code === 'OVERSIZED_JSONL');
});

test('sidecar decoder discards oversized records through LF and recovers same-chunk suffixes', () => {
  const decoder = new SidecarJsonlDecoder();
  assert.deepEqual(decoder.push('a'.repeat(MAX_JSONL_BYTES + 1)), []);
  assert.equal(decoder.takeErrors()[0]?.code, 'OVERSIZED_JSONL');
  assert.deepEqual(decoder.push('still-the-same-record'), []);
  const valid = JSON.stringify({ v: 1, kind: 'request', id: 'ok', method: 'ping', params: {} });
  assert.deepEqual(decoder.push(`end-of-oversized\n${valid}\n`), [JSON.parse(valid)]);

  const withSuffix = new SidecarJsonlDecoder();
  assert.deepEqual(withSuffix.push(`${'b'.repeat(MAX_JSONL_BYTES + 1)}\n${valid}\n`), [JSON.parse(valid)]);
  assert.equal(withSuffix.takeErrors()[0]?.code, 'OVERSIZED_JSONL');
});

test('encoder bounds records and round-trips', () => {
  const decoder = new JsonlDecoder();
  const wire = encodeJsonl({ v: 1, kind: 'request', id: 'x', method: 'ping', params: {} });
  assert.deepEqual(decoder.push(wire), [{ v: 1, kind: 'request', id: 'x', method: 'ping', params: {} }]);
  assert.throws(() => encodeJsonl({ big: 'a'.repeat(MAX_JSONL_BYTES) }), (error) => error instanceof JsonlProtocolError && error.code === 'OVERSIZED_JSONL');
});
