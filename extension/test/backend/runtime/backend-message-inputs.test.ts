import assert from 'node:assert/strict';
import test from 'node:test';

import type { ComposerInput } from '../../../src/shared/protocol';
import type { SdkImageContent } from '../../../src/backend/sdk';

import {
  buildPromptText,
  lowerImageInputs,
  resolveModelInputKinds,
} from '../../../src/backend/message-inputs';

// ─── helpers ─────────────────────────────────────────────────────────────────

function pathInput(path: string): ComposerInput {
  return { id: `p-${path}`, kind: 'filesystemPathRef', path, name: path, source: 'picker' };
}

function imageInput(data: string, mimeType = 'image/png'): ComposerInput {
  return {
    id: `img-${data}`,
    kind: 'imageBlob',
    mimeType,
    name: `${data}.png`,
    sizeBytes: data.length,
    dataBase64: data,
    source: 'paste',
  };
}

function fileInput(data: string): ComposerInput {
  return {
    id: `file-${data}`,
    kind: 'fileBlob',
    mimeType: 'text/plain',
    name: `${data}.txt`,
    sizeBytes: data.length,
    dataBase64: data,
    source: 'paste',
  };
}

// ─── resolveModelInputKinds (normalization) ──────────────────────────────────

test('resolveModelInputKinds: text-only input → ["text"]', () => {
  assert.deepEqual(resolveModelInputKinds({ input: ['text'] }), ['text']);
});

test('resolveModelInputKinds: image-only input is promoted to ["text","image"]', () => {
  // image without text is impossible for a prompt; text is always available.
  assert.deepEqual(resolveModelInputKinds({ input: ['image'] }), ['text', 'image']);
});

test('resolveModelInputKinds: ["text","image"] preserved as-is', () => {
  assert.deepEqual(resolveModelInputKinds({ input: ['text', 'image'] }), ['text', 'image']);
});

test('resolveModelInputKinds: deduplicates repeated kinds', () => {
  assert.deepEqual(resolveModelInputKinds({ input: ['text', 'text', 'image', 'image'] }), ['text', 'image']);
});

test('resolveModelInputKinds: image repeated → ["text","image"]', () => {
  assert.deepEqual(resolveModelInputKinds({ input: ['image', 'image'] }), ['text', 'image']);
});

test('resolveModelInputKinds: unknown kinds filtered out, leaving text', () => {
  assert.deepEqual(resolveModelInputKinds({ input: ['text', 'audio', 'video'] }), ['text']);
});

test('resolveModelInputKinds: only unknown kinds → falls back to ["text"]', () => {
  // filter leaves [] → normalize returns ['text']; resolve returns ['text'].
  assert.deepEqual(resolveModelInputKinds({ input: ['audio', 'video'] }), ['text']);
});

test('resolveModelInputKinds: empty array → ["text"]', () => {
  assert.deepEqual(resolveModelInputKinds({ input: [] }), ['text']);
});

test('resolveModelInputKinds: non-array input → ["text"]', () => {
  assert.deepEqual(resolveModelInputKinds({ input: 'text' }), ['text']);
  assert.deepEqual(resolveModelInputKinds({ input: 'image' }), ['text']);
  assert.deepEqual(resolveModelInputKinds({ input: 42 }), ['text']);
  assert.deepEqual(resolveModelInputKinds({ input: null }), ['text']);
});

test('resolveModelInputKinds: missing input field → ["text"]', () => {
  assert.deepEqual(resolveModelInputKinds({}), ['text']);
  assert.deepEqual(resolveModelInputKinds({ other: 'x' }), ['text']);
});

// ─── lowerImageInputs ─────────────────────────────────────────────────────────

test('lowerImageInputs: maps imageBlob inputs to SdkImageContent', () => {
  const result = lowerImageInputs([
    imageInput('AAAA', 'image/png'),
    imageInput('BBBB', 'image/jpeg'),
  ]);
  const expected: SdkImageContent[] = [
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' },
  ];
  assert.deepEqual(result, expected);
});

test('lowerImageInputs: ignores non-image inputs', () => {
  const result = lowerImageInputs([
    pathInput('foo.txt'),
    imageInput('AAAA'),
    fileInput('CCCC'),
  ]);
  assert.deepEqual(result, [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]);
});

test('lowerImageInputs: empty input list → empty array', () => {
  assert.deepEqual(lowerImageInputs([]), []);
});

test('lowerImageInputs: no image inputs → empty array', () => {
  assert.deepEqual(lowerImageInputs([pathInput('a.txt'), fileInput('b')]), []);
});

test('lowerImageInputs: preserves order of image inputs', () => {
  const result = lowerImageInputs([
    imageInput('first'),
    imageInput('second'),
    imageInput('third'),
  ]);
  assert.deepEqual(result.map((i) => i.data), ['first', 'second', 'third']);
});

// ─── buildPromptText ──────────────────────────────────────────────────────────

test('buildPromptText: plain text only → text unchanged', () => {
  assert.equal(buildPromptText('hello world', []), 'hello world');
});

test('buildPromptText: empty text + no inputs → empty string', () => {
  assert.equal(buildPromptText('', []), '');
});

test('buildPromptText: whitespace-only text → empty string', () => {
  assert.equal(buildPromptText('   \n\t  ', []), '');
});

test('buildPromptText: filesystem path refs prepended as @path prelude', () => {
  const result = buildPromptText('explain this', [pathInput('foo.txt')]);
  assert.equal(result, '@foo.txt\n\nexplain this');
});

test('buildPromptText: multiple paths joined with newline in prelude', () => {
  const result = buildPromptText('hi', [pathInput('a.txt'), pathInput('b.txt')]);
  assert.equal(result, '@a.txt\n@b.txt\n\nhi');
});

test('buildPromptText: paths with empty text → prelude only (no trailing separators)', () => {
  assert.equal(buildPromptText('', [pathInput('foo.txt')]), '@foo.txt');
  assert.equal(buildPromptText('   ', [pathInput('foo.txt')]), '@foo.txt');
});

test('buildPromptText: images do NOT appear in prompt text', () => {
  const result = buildPromptText('describe this', [imageInput('AAAA')]);
  assert.equal(result, 'describe this');
});

test('buildPromptText: images + paths + text → only paths and text appear', () => {
  const result = buildPromptText('go', [pathInput('a.txt'), imageInput('AAAA'), fileInput('b')]);
  assert.equal(result, '@a.txt\n\ngo');
});

test('buildPromptText: fileBlob inputs are not part of prompt text', () => {
  const result = buildPromptText('text', [fileInput('CCCC')]);
  assert.equal(result, 'text');
});
