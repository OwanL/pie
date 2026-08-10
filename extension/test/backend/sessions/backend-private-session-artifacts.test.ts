import assert from 'node:assert/strict';
import test from 'node:test';

import { forgetPrivateSessionArtifacts } from '../../../src/backend/private-session-artifacts';

test('private-session cleanup removes fallible sidecars before deleting the transcript', async () => {
  const calls: string[] = [];

  await forgetPrivateSessionArtifacts('/sessions/private.jsonl', {
    forgetReviewSidecars: () => { calls.push('reviews'); },
    clearSystemPromptToggles: async () => { calls.push('prompts'); },
    deleteTranscript: async () => { calls.push('transcript'); },
  });

  assert.deepEqual(calls, ['reviews', 'prompts', 'transcript']);
});

test('review-sidecar failure leaves the private transcript intact for retry', async () => {
  let transcriptDeleted = false;

  await assert.rejects(
    forgetPrivateSessionArtifacts('/sessions/private.jsonl', {
      forgetReviewSidecars: () => { throw new Error('review sidecar locked'); },
      clearSystemPromptToggles: async () => undefined,
      deleteTranscript: async () => { transcriptDeleted = true; },
    }),
    /review sidecar locked/,
  );

  assert.equal(transcriptDeleted, false);
});

test('system-prompt sidecar failure leaves the private transcript intact for retry', async () => {
  let transcriptDeleted = false;

  await assert.rejects(
    forgetPrivateSessionArtifacts('/sessions/private.jsonl', {
      forgetReviewSidecars: () => undefined,
      clearSystemPromptToggles: async () => { throw new Error('prompt sidecar locked'); },
      deleteTranscript: async () => { transcriptDeleted = true; },
    }),
    /prompt sidecar locked/,
  );

  assert.equal(transcriptDeleted, false);
});
