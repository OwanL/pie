import assert from 'node:assert/strict';
import test from 'node:test';
import type { ToolCall } from '../../../../lib/protocol/index.js';
import { readOutputPreview } from '../../../transcript/tool-call-card/read-output-preview';

const base: ToolCall = { id: 'preview', name: 'read', input: {}, status: 'completed' };
const preview = (result: unknown, extra: Partial<ToolCall> = {}) =>
  readOutputPreview({ ...base, result, ...extra });
const middle = '\n' + 'middle line\n'.repeat(1000);

test('previews directly present strings and content strings with normalized read names', () => {
  assert.deepEqual(preview('const first = 1;' + middle + 'export default last;'), {
    start: 'const first = 1;', end: 'export default last;',
  });
  assert.deepEqual(preview({ content: 'first' + middle + 'last' }, { name: '  READ  ' }), {
    start: 'first', end: 'last',
  });
});

test('short output is shown once and whitespace is normalized without losing punctuation', () => {
  assert.deepEqual(preview('\n\tconst x = { a: 1 };\r\n  export { x };  '), {
    start: 'const x = { a: 1 }; export { x };',
  });
  assert.deepEqual(preview('one line'), { start: 'one line' });
  assert.equal(preview(' \n\t '), null);
  assert.deepEqual(preview('same' + middle + 'same'), { start: 'same' });
});

test('text arrays preserve edge text and ignore images and non-text blocks', () => {
  const image = { type: 'image', get text(): string { throw new Error('image text must not be read'); } };
  assert.deepEqual(preview({ content: [image, { type: 'text', text: 'first' },
    { type: 'text', text: middle }, { type: 'text', text: 'last' }, image] }), {
    start: 'first', end: 'last',
  });
  assert.deepEqual(preview({ content: [{ type: 'text', text: 'a' }, image, { type: 'text', text: 'b' }] }), { start: 'a b' });
  assert.equal(preview({ content: [image] }), null);
  assert.equal(preview({ content: [{ text: 'not a text block' }, null, 3] }), null);
});

test('strips ANSI only from bounded samples', () => {
  assert.deepEqual(preview('\x1b[31mfirst\x1b[0m' + middle + '\x1b[2Klast\x1b[0m'), {
    start: 'first', end: 'last',
  });
  assert.deepEqual(preview({ content: '\x1b[32mshort\x1b[0m' }), { start: 'short' });
});

test('known read continuation notices are excluded from the end of available file content', () => {
  for (const notice of [
    '[Showing lines 1-2000 of 4000. Use offset=2001 to continue.]',
    '[Showing lines 1-123 of 4000 (50KB limit). Use offset=124 to continue.]',
    '[35 more lines in file. Use offset=21 to continue.]',
  ]) {
    assert.deepEqual(preview('first' + middle + 'last\n\n' + notice + '\n'), { start: 'first', end: 'last' });
    assert.deepEqual(preview('short\n\n' + notice), { start: 'short' });
    assert.equal(preview(notice), null);
    assert.deepEqual(preview({ content: [{ type: 'text', text: 'first' + middle + 'last' },
      { type: 'text', text: notice }] }), { start: 'first', end: 'last' });
  }
  assert.deepEqual(preview('first' + middle + '[ordinary file text]'), {
    start: 'first', end: '[ordinary file text]',
  });
});

test('does not inspect lazy detail, result references, summaries, or serialize objects', () => {
  const lazy = { ...base, get detail(): never { throw new Error('lazy detail accessed'); },
    get resultRef(): never { throw new Error('reference accessed'); },
    get resultSummary(): never { throw new Error('summary accessed'); } };
  assert.equal(readOutputPreview(lazy), null);
  assert.deepEqual(readOutputPreview(Object.assign(lazy, { result: 'direct' })), { start: 'direct' });
  assert.equal(preview({ summary: 'not file content', toJSON() { throw new Error('serialized'); } }), null);
  for (const status of ['drafting', 'ready', 'running', 'failed'] as const) {
    assert.equal(preview('file text', { status }), null);
  }
  for (const name of ['cat', 'read_file', 'mcp__read', 'bash']) assert.equal(preview('text', { name }), null);
});

test('large single-line results use small snippets and slice only bounded edges', () => {
  const large = 'BEGIN ' + 'x'.repeat(2_000_000) + ' END';
  const original = String.prototype.slice;
  const sampledLengths: number[] = [];
  String.prototype.slice = function (start?: number, end?: number): string {
    const value = original.call(this, start, end);
    if (this.length === large.length) sampledLengths.push(value.length);
    return value;
  };
  try {
    const result = preview(large);
    assert.equal(result?.start.length, 90);
    assert.equal(result?.end?.length, 90);
    assert.equal(result?.start.startsWith('BEGIN '), true);
    assert.equal(result?.end?.endsWith(' END'), true);
    assert.deepEqual(sampledLengths, [2048, 2048]);
  } finally {
    String.prototype.slice = original;
  }
});

test('large text arrays visit only a bounded number of edge blocks, not the interior', () => {
  const blocks = new Array(100_000);
  blocks[0] = { type: 'text', text: 'first' };
  blocks[blocks.length - 1] = { type: 'text', text: 'last' };
  let reads = 0;
  const content = new Proxy(blocks, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        reads++;
        const index = Number(key);
        assert.ok(index < 32 || index >= blocks.length - 32, 'interior block inspected');
      }
      return Reflect.get(target, key, receiver);
    },
  });
  assert.deepEqual(preview({ content }), { start: 'first', end: 'last' });
  assert.equal(reads, 64);
});

test('edge scans stop after a bounded number of blank lines', () => {
  assert.equal(preview('\n'.repeat(40) + 'hidden interior' + '\n'.repeat(3000)), null);
});
