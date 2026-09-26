import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveModelInputKinds } from '../model-input-kinds';

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
