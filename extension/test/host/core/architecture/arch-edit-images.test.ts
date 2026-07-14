/**
 * Regression test: an Edit command with an image ComposerInput carries the
 * image end-to-end through the optimistic replacement message and the EditRpc
 * effect, mirroring the existing Send path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';
import type { ComposerInput, SessionSummary, TranscriptWindow } from '../../../../src/shared/protocol';
import { buildOptimisticUserParts, buildPromptText } from '../../../../src/host/core/composer';

const sessionSummary: SessionSummary = {
  path: '/s',
  name: 'Session',
  cwd: '/workspace',
  modifiedAt: new Date().toISOString(),
  messageCount: 1,
  isPlaceholder: false,
};

const fullWindow: TranscriptWindow = {
  totalCount: 1,
  loadedStart: 0,
  loadedEnd: 1,
  hasOlder: false,
  hasNewer: false,
  isPartial: false,
  hasUserMessages: true,
};

const imageInput: ComposerInput = {
  id: 'input-img-1',
  kind: 'imageBlob',
  mimeType: 'image/png',
  name: 'tiny.png',
  sizeBytes: 8,
  dataBase64: 'iVBORw0KGgo=',
  source: 'paste',
};

test('reducer: Edit command with image input renders image in optimistic message and threads inputs to EditRpc', () => {
  const text = 'describe this';
  const inputs = [imageInput];
  const composedText = buildPromptText(text, inputs);
  const userParts = buildOptimisticUserParts(text, inputs);

  const state: ArchState = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: [sessionSummary],
      openTabPaths: ['/s'],
      activeSessionPath: '/s',
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [
          {
            id: 'msg-1',
            role: 'user',
            createdAt: '2026-01-01T00:00:00.000Z',
            markdown: 'original',
            status: 'completed',
          },
        ],
      },
      windowBySession: { '/s': { ...fullWindow } },
    },
  };

  const event: Event = {
    kind: 'Command',
    cmd: {
      kind: 'Edit',
      corrId: 'c-edit-img',
      sessionPath: '/s',
      messageId: 'msg-1',
      text,
      inputs,
      composedText,
      userParts,
      localId: 'local:edit:img',
      timestamp: 1,
    },
  };

  const result = reducer(state, event);

  // The optimistic replacement message is the last (and only) message.
  const transcript = result.state.transcript.bySession['/s'];
  assert.ok(transcript, 'transcript should exist');
  const message = transcript![transcript!.length - 1];
  assert.ok(message, 'optimistic replacement message should exist');
  assert.equal(message.id, 'local:edit:img');

  // userParts carries both the text part and the image part.
  assert.ok(message.userParts, 'optimistic message should have userParts');
  assert.equal(message.userParts!.length, 2);
  assert.equal(message.userParts![0]?.kind, 'text');
  assert.equal(message.userParts![1]?.kind, 'image');
  if (message.userParts![1]?.kind === 'image') {
    assert.equal(message.userParts![1].mimeType, 'image/png');
    assert.equal(message.userParts![1].dataBase64, 'iVBORw0KGgo=');
  }

  // EditRpc effect carries the inputs array.
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0]?.kind, 'EditRpc');
  if (result.effects[0]?.kind === 'EditRpc') {
    assert.equal(result.effects[0].inputs.length, 1);
    assert.equal(result.effects[0].inputs[0]?.kind, 'imageBlob');
    assert.equal(result.effects[0].userParts, userParts);
  }
});

test('reducer: failed edit of an image-bearing message restores the original images on rollback', () => {
  // Original user message carries a text part + an image part.
  const originalUserParts = [
    { kind: 'text' as const, text: 'see this' },
    { kind: 'image' as const, mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=', name: 'orig.png' },
  ];
  const text = 'describe this again';
  const inputs = [imageInput];
  const composedText = buildPromptText(text, inputs);
  const userParts = buildOptimisticUserParts(text, inputs);

  const state: ArchState = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      sessions: [sessionSummary],
      openTabPaths: ['/s'],
      activeSessionPath: '/s',
    },
    transcript: {
      ...initialArchState.transcript,
      bySession: {
        '/s': [
          {
            id: 'msg-img',
            role: 'user',
            createdAt: '2026-01-01T00:00:00.000Z',
            markdown: 'see this',
            userParts: originalUserParts,
            status: 'completed',
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            createdAt: '2026-01-01T00:00:01.000Z',
            markdown: 'sure',
            status: 'completed',
          },
        ],
      },
      windowBySession: {
        '/s': { ...fullWindow, totalCount: 2, loadedEnd: 2 },
      },
    },
  };

  // 1. Dispatch the Edit command — truncates the image-bearing original +
  //    reply and appends the optimistic replacement.
  const editResult = reducer(state, {
    kind: 'Command',
    cmd: {
      kind: 'Edit',
      corrId: 'c-edit-img-rollback',
      sessionPath: '/s',
      messageId: 'msg-img',
      text,
      inputs,
      composedText,
      userParts,
      localId: 'local:edit:img-rollback',
      timestamp: 1,
    },
  });

  // The optimistic replacement carries the new image; the original image-bearing
  // message + reply were truncated and captured for rollback.
  const editTranscript = editResult.state.transcript.bySession['/s']!;
  assert.equal(editTranscript.length, 1);
  assert.equal(editTranscript[0]?.id, 'local:edit:img-rollback');
  const op = editResult.state.pending.ops['c-edit-img-rollback'];
  assert.ok(op && op.kind === 'edit');
  assert.equal(op.removedTail?.length, 2);
  assert.equal(op.removedTail?.[0]?.id, 'msg-img');
  // The captured original still carries its image userParts.
  assert.ok(op.removedTail?.[0]?.userParts?.some((p) => p.kind === 'image'));

  // 2. The edit fails pre-ack — the original image-bearing message + reply are
  //    restored verbatim (including images), and the optimistic message is gone.
  const failResult = reducer(editResult.state, {
    kind: 'EditResult',
    corrId: 'c-edit-img-rollback',
    sessionPath: '/s',
    ok: false,
    error: 'denied',
  });

  const restored = failResult.state.transcript.bySession['/s']!;
  assert.equal(restored.length, 2);
  assert.equal(restored[0]?.id, 'msg-img');
  // The restored original message retains its image userParts.
  assert.ok(restored[0]?.userParts?.some((p) => p.kind === 'image'));
  if (restored[0]?.userParts?.[1]?.kind === 'image') {
    assert.equal(restored[0].userParts[1].dataBase64, 'iVBORw0KGgo=');
  }
  assert.equal(restored[1]?.id, 'assistant-1');
  assert.ok(!restored.some((m) => m.id === 'local:edit:img-rollback'));
});
