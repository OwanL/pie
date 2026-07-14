import assert from 'node:assert/strict';
import test from 'node:test';

import { getRenderableUserParts, messageHasUserImages, splitSummaryPath } from '../../../../src/webview/panel/transcript';
import { userImagePartsToInputs } from '../../../../src/webview/panel/transcript/parts';
import type { ChatMessage } from '../../../../src/shared/protocol';

function makeUserMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'user-1',
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'hello',
    status: 'completed',
    ...overrides,
  };
}

test('getRenderableUserParts prefers ordered structured user parts', () => {
  const message = makeUserMessage({
    markdown: 'fallback text',
    userParts: [
      { kind: 'text', text: 'Look at this' },
      { kind: 'image', mimeType: 'image/png', dataBase64: 'ZmFrZQ==', name: 'shot.png' },
    ],
  });

  assert.deepEqual(getRenderableUserParts(message), message.userParts);
});

test('getRenderableUserParts falls back to markdown for legacy user messages', () => {
  const message = makeUserMessage({ markdown: 'legacy text' });

  assert.deepEqual(getRenderableUserParts(message), [{ kind: 'text', text: 'legacy text' }]);
});

test('messageHasUserImages detects whether a user message carries an image part', () => {
  assert.equal(messageHasUserImages(makeUserMessage({ userParts: [{ kind: 'text', text: 'hello' }] })), false);
  assert.equal(messageHasUserImages(makeUserMessage({
    userParts: [{ kind: 'image', mimeType: 'image/png', dataBase64: 'ZmFrZQ==' }],
  })), true);
});

test('splitSummaryPath separates the directory and highlighted file sections', () => {
  assert.deepEqual(splitSummaryPath('docs/IDEAS.md'), {
    pathSection: 'docs/',
    fileSection: 'IDEAS.md',
  });

  assert.deepEqual(splitSummaryPath('IDEAS.md'), {
    pathSection: null,
    fileSection: 'IDEAS.md',
  });

  assert.deepEqual(splitSummaryPath('/repo/Makefile'), {
    pathSection: '/repo/',
    fileSection: 'Makefile',
  });
});

test('userImagePartsToInputs converts image user parts into seedable ComposerInput[]', () => {
  const message = makeUserMessage({
    userParts: [
      { kind: 'text', text: 'look' },
      { kind: 'image', mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=', name: 'a.png', width: 2, height: 2 },
      { kind: 'image', mimeType: 'image/jpeg', dataBase64: '/9j/4AAQ', name: 'b.jpg' },
    ],
  });

  const inputs = userImagePartsToInputs(message);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0]?.kind, 'imageBlob');
  assert.equal(inputs[1]?.kind, 'imageBlob');
  if (inputs[0]?.kind === 'imageBlob' && inputs[1]?.kind === 'imageBlob') {
    assert.equal(inputs[0].mimeType, 'image/png');
    assert.equal(inputs[0].dataBase64, 'iVBORw0KGgo=');
    assert.equal(inputs[0].name, 'a.png');
    assert.equal(inputs[0].width, 2);
    assert.equal(inputs[0].height, 2);
    assert.equal(inputs[1].mimeType, 'image/jpeg');
  }
  // Each seeded input gets a unique id.
  assert.ok(inputs[0]?.id && inputs[1]?.id && inputs[0].id !== inputs[1].id);
  // Two calls produce fresh ids (so a remount re-seeds without id collisions).
  assert.notEqual(userImagePartsToInputs(message)[0]?.id, inputs[0]?.id);
});

test('userImagePartsToInputs returns empty for messages without image parts', () => {
  assert.deepEqual(userImagePartsToInputs(makeUserMessage({ userParts: [{ kind: 'text', text: 'hi' }] })), []);
  assert.deepEqual(userImagePartsToInputs(makeUserMessage({})), []);
});
