import { PassThrough } from 'node:stream';
import test from 'node:test';
import assert from 'node:assert/strict';

import { attachJsonlLineReader, serializeJsonLine } from '../../../src/shared/jsonl';

test('serializeJsonLine uses LF framing', () => {
  assert.equal(serializeJsonLine({ ok: true }), '{"ok":true}\n');
});

test('attachJsonlLineReader preserves unicode separators inside json strings', async () => {
  const stream = new PassThrough();
  const lines: string[] = [];

  attachJsonlLineReader(stream, (line) => {
    lines.push(line);
  });

  stream.write('{"text":"a\u2028b"}\n{"text":"c\u2029d"}\n');
  stream.end();

  await new Promise((resolve) => stream.on('end', resolve));

  assert.deepEqual(lines, ['{"text":"a\u2028b"}', '{"text":"c\u2029d"}']);
});

test('attachJsonlLineReader handles chunked lines and trailing partial line', async () => {
  const stream = new PassThrough();
  const lines: string[] = [];

  attachJsonlLineReader(stream, (line) => {
    lines.push(line);
  });

  stream.write('{"a":1');
  stream.write('}\n{"b":2');
  stream.end('}');

  await new Promise((resolve) => stream.on('end', resolve));

  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});
