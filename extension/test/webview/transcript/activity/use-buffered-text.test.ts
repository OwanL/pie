import assert from 'node:assert/strict';
import test from 'node:test';

import { isForwardExtension } from '../../../../src/webview/panel/transcript/use-buffered-text';

// `isForwardExtension` drives the buffered-text hook's re-seed decision: when
// the source is replaced by a different stream (not a clean forward extension),
// the buffer resets so the new stream animates from its own start instead of
// inheriting the old stream's revealed length.

test('isForwardExtension treats an empty previous as a continuation (mount / reset)', () => {
  assert.equal(isForwardExtension('', ''), true);
  assert.equal(isForwardExtension('', 'anything'), true);
});

test('isForwardExtension returns true when next is prev grown by appending', () => {
  assert.equal(isForwardExtension('abc', 'abc'), true);
  assert.equal(isForwardExtension('abc', 'abcdef'), true);
  assert.equal(isForwardExtension('streaming ', 'streaming text'), true);
});

test('isForwardExtension returns false when the stream is replaced or shrinks', () => {
  // Shrunk: not a forward extension.
  assert.equal(isForwardExtension('abcdef', 'abc'), false);
  // Same length, different content: a different stream.
  assert.equal(isForwardExtension('abc', 'abd'), false);
  // Different content entirely (e.g. reasoning → reply).
  assert.equal(isForwardExtension('planning the answer', 'Here is the answer so far'), false);
  // Prepended/changed prefix is not an append-extension.
  assert.equal(isForwardExtension('abc', 'xabc'), false);
});

test('isForwardExtension returns true for a stream that keeps growing across snapshots', () => {
  // Models append tokens; each snapshot extends the previous.
  let prev = 'The quick brown fox';
  const next = 'The quick brown fox jumps over the lazy dog';
  assert.equal(isForwardExtension(prev, next), true);
  prev = next;
  assert.equal(isForwardExtension(prev, `${next} and keeps going`), true);
});
