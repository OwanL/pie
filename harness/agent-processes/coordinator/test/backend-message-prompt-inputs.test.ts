import assert from 'node:assert/strict';
import test from 'node:test';

import type { ComposerInput } from '../../lib/rpc/message-contract.js';
import type { SdkImageContent } from '../../lib/sdk-integration/sdk';

import { buildPromptText, lowerImageInputs } from '../message-inputs';

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
