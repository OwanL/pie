// Focused unit tests for scripts/install/lib/json.mjs — the BOM-less UTF-8 JSON
// read/write helpers shared by both shell installers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseJson, readJsonFile, stringifyJson, writeJsonFile } from '../install/lib/json.mjs';

function withTempDir(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pie-install-json-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('parseJson returns fallback for empty / invalid input', () => {
  assert.equal(parseJson(''), null);
  assert.equal(parseJson('   '), null);
  assert.equal(parseJson('{not json'), null);
  assert.deepEqual(parseJson('{}', {}), {});
  assert.deepEqual(parseJson('{"a":1}', null), { a: 1 });
});

test('stringifyJson uses 2-space indent and honours trailingNewline', () => {
  assert.equal(stringifyJson({ a: 1 }), '{\n  "a": 1\n}');
  assert.equal(stringifyJson({ a: 1 }, { trailingNewline: true }), '{\n  "a": 1\n}\n');
  assert.equal(stringifyJson({ a: 1 }, { indent: 0 }), '{"a":1}');
});

test('readJsonFile returns fallback for missing or malformed files', () => withTempDir((root) => {
  const missing = path.join(root, 'nope.json');
  assert.deepEqual(readJsonFile(missing, { fallback: {} }), {});

  const malformed = path.join(root, 'bad.json');
  writeFileSync(malformed, '{broken');
  assert.deepEqual(readJsonFile(malformed, { fallback: {} }), {});

  const empty = path.join(root, 'empty.json');
  writeFileSync(empty, '');
  assert.deepEqual(readJsonFile(empty, { fallback: {} }), {});

  const ok = path.join(root, 'ok.json');
  writeFileSync(ok, '{"x":2}');
  assert.deepEqual(readJsonFile(ok), { x: 2 });
}));

test('readJsonFile throws on malformed content when throwOnParseError is set', () => withTempDir((root) => {
  const bad = path.join(root, 'bad.json');
  writeFileSync(bad, '{broken');
  assert.throws(() => readJsonFile(bad, { throwOnParseError: true }), SyntaxError);
}));

test('writeJsonFile writes BOM-less UTF-8 with no trailing newline by default', () => withTempDir((root) => {
  const file = path.join(root, 'settings.json');
  const written = writeJsonFile(file, { sessionDir: 'data/outcomes/sessions' });
  // No trailing newline by default (matches the git-tracked settings.json).
  assert.equal(written, '{\n  "sessionDir": "data/outcomes/sessions"\n}');
  const bytes = readFileSync(file);
  // BOM-less: first byte is '{' (0x7B), not 0xEF (BOM lead byte).
  assert.equal(bytes[0], 0x7B);
  assert.equal(bytes.toString('utf8'), '{\n  "sessionDir": "data/outcomes/sessions"\n}');
}));

test('writeJsonFile trailingNewline option appends a single LF', () => withTempDir((root) => {
  const file = path.join(root, 'auth.json');
  writeJsonFile(file, { anthropic: { key: 'x' } }, { trailingNewline: true });
  const text = readFileSync(file, 'utf8');
  assert.equal(text.endsWith('}\n'), true);
  // Exactly one trailing newline.
  assert.equal(text.endsWith('\n\n'), false);
  // BOM-less.
  assert.equal(readFileSync(file)[0], 0x7B);
}));

test('writeJsonFile is byte-stable (idempotent rewrite produces no diff)', () => withTempDir((root) => {
  const file = path.join(root, 's.json');
  const data = { b: 2, a: 1, nested: { z: 9 } };
  writeJsonFile(file, data);
  const first = readFileSync(file, 'utf8');
  const mtimeBefore = statSync(file).mtimeMs;
  // Re-write the parsed content back; the bytes must be identical.
  writeJsonFile(file, JSON.parse(first));
  const second = readFileSync(file, 'utf8');
  assert.equal(second, first);
  void mtimeBefore;
}));
