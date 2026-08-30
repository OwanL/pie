import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { validateRuntimeProvenance } from '../src/runtime-provenance.js';
import type { ReviewerRuntime } from '../src/types.js';
import { validReview } from './fixtures.js';

function transcriptFor(review = validReview(), options: { agent?: string; workflowRef?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-runtime-'));
  const file = path.join(dir, 'orchestrator.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session', id: 'orchestrator-id' })}\n`);
  const runtimes: ReviewerRuntime[] = [...review.proposals, review.consolidation, ...review.components, ...(review.adjudication ? [review.adjudication] : [])];
  for (const runtime of runtimes) {
    fs.appendFileSync(file, `${JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: runtime.toolCallId, name: 'subagent', arguments: {
      agent: options.agent ?? 'session-evaluator', bucket: runtime.requestedBucket, ...(options.workflowRef ? { workflowRef: options.workflowRef } : {}),
    } }] } })}\n`);
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

test('runtime provenance requires the tool-free evaluator while accepting tagged v1 work in flight', () => {
  const current = transcriptFor(validReview(), { agent: 'reviewer' });
  try {
    assert.throws(() => validateRuntimeProvenance(current.review, current.file), /tool-free session-evaluator/);
  } finally { fs.rmSync(current.dir, { recursive: true, force: true }); }

  const legacy = transcriptFor(validReview(), { agent: 'reviewer', workflowRef: 'session-review-v1/legacy/evidence/role' });
  try {
    assert.doesNotThrow(() => validateRuntimeProvenance(legacy.review, legacy.file));
  } finally { fs.rmSync(legacy.dir, { recursive: true, force: true }); }
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


test('hostVersion is validated against the host editor version', () => {
  const { dir, file, review } = transcriptFor();
  const saved = process.env.PIE_EDITOR_VERSION;
  try {
    process.env.PIE_EDITOR_VERSION = '9.9.9';
    review.provenance.hostVersion = '9.9.9';
    assert.doesNotThrow(() => validateRuntimeProvenance(review, file));
    review.provenance.hostVersion = '1.0.0';
    assert.throws(() => validateRuntimeProvenance(review, file), /hostVersion does not match the host editor version/);
    delete process.env.PIE_EDITOR_VERSION;
    review.provenance.hostVersion = null;
    assert.doesNotThrow(() => validateRuntimeProvenance(review, file));
  } finally {
    if (saved === undefined) delete process.env.PIE_EDITOR_VERSION; else process.env.PIE_EDITOR_VERSION = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
