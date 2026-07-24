import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { validateRuntimeProvenance } from '../src/runtime-provenance.js';
import type { ReviewerRuntime } from '../src/types.js';
import { validReview } from './fixtures.js';

function transcriptFor(review = validReview()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-runtime-'));
  const file = path.join(dir, 'orchestrator.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session', id: 'orchestrator-id' })}\n`);
  const runtimes: ReviewerRuntime[] = [...review.proposals, review.consolidation, ...review.components, ...(review.adjudication ? [review.adjudication] : [])];
  for (const runtime of runtimes) {
    fs.appendFileSync(file, `${JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: runtime.toolCallId, name: 'subagent', arguments: { bucket: runtime.requestedBucket } }] } })}\n`);
    fs.appendFileSync(file, `${JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: runtime.toolCallId, toolName: 'subagent', details: { results: [{
      parentToolCallId: runtime.toolCallId, requestedBucket: runtime.requestedBucket, bucket: runtime.bucket, bucketDowngraded: runtime.bucketDowngraded,
      model: runtime.modelId, provider: runtime.provider, family: runtime.family, thinkingLevel: runtime.thinkingLevel, promptHash: runtime.promptHash,
    }] } } })}\n`);
  }
  review.provenance.orchestratorSessionId = 'orchestrator-id';
  return { dir, file, review };
}

test('runtime provenance is bound to prior subagent result metadata', () => {
  const { dir, file, review } = transcriptFor();
  try {
    assert.doesNotThrow(() => validateRuntimeProvenance(review, file));
    review.components[0].modelId = 'caller-forged-model';
    assert.throws(() => validateRuntimeProvenance(review, file), /runtime provenance does not match/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('humanCheck is bound to the exact prior ask_user call and result', () => {
  const { dir, file, review } = transcriptFor();
  const recordedAt = '2026-07-24T11:00:00.000Z';
  review.humanCheck = {
    toolCallId: 'ask-1',
    input: {
      question: 'Did it render correctly?', options: ['Yes', 'No'],
      reviewMeta: { purpose: 'review_human_verification', targetSessionId: review.sessionId, targetSessionPath: review.sessionPathAtReview, criterionId: 'c1', domain: 'UI', expectedObservation: 'Correct rendering' },
    },
    response: { answer: 'Yes', source: 'option', cancelled: false, status: 'answered', recordedAt },
    interpretation: 'Supports the criterion.',
  };
  fs.appendFileSync(file, `${JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'ask-1', name: 'ask_user', arguments: review.humanCheck.input }] } })}\n`);
  fs.appendFileSync(file, `${JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: 'ask-1', toolName: 'ask_user', timestamp: Date.parse(recordedAt), details: { answer: 'Yes', source: 'option', cancelled: false, targetSessionId: review.sessionId } } })}\n`);
  try {
    assert.doesNotThrow(() => validateRuntimeProvenance(review, file));
    review.humanCheck.response.answer = 'No';
    assert.throws(() => validateRuntimeProvenance(review, file), /humanCheck answer does not match/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
