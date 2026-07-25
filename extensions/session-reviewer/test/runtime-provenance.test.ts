import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { hashJson, sha256 } from '../src/evidence.js';
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

function bashEntry(id: string, command: string, output: string, isError = false): string {
  return `${JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'bash', arguments: { command } }] } })}
${JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: id, toolName: 'bash', content: [{ type: 'text', text: output }], isError } })}
`;
}
function readEntry(id: string, filePath: string, output: string): string {
  return `${JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: { path: filePath } }] } })}
${JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: output }], isError: false } })}
`;
}
function grepEntry(id: string, pattern: string, filePath: string, output: string): string {
  return `${JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'grep', arguments: { pattern, path: filePath } }] } })}
${JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: id, toolName: 'grep', content: [{ type: 'text', text: output }], isError: false } })}
`;
}
function syncChecks(review: ReturnType<typeof validReview>): void {
  review.reviewerChecksSha256 = hashJson(review.reviewerChecks);
  review.provenance.pipeline.reviewerChecksSha256 = review.reviewerChecksSha256;
}

test('command reviewer checks bind to a prior bash call and immutable output', () => {
  const { dir, file, review } = transcriptFor();
  const output = 'src/a.ts:1:needle found\n';
  const baseCheck = {
    checkId: 'chk-bash', kind: 'command' as const, command: 'git diff --no-ext-diff --no-textconv -- src/a.ts', cwd: '/repo',
    result: output, status: 'pass' as const, evidenceRefs: [], toolCallId: 'chk-bash-call', outputSha256: sha256(output),
  };
  review.reviewerChecks = [baseCheck];
  syncChecks(review);
  fs.appendFileSync(file, bashEntry('chk-bash-call', 'git diff --no-ext-diff --no-textconv -- src/a.ts', output));
  try {
    assert.doesNotThrow(() => validateRuntimeProvenance(review, file));
    review.reviewerChecks[0]!.outputSha256 = '0'.repeat(64);
    assert.throws(() => validateRuntimeProvenance(review, file), /output hash does not match/);
    review.reviewerChecks[0]!.outputSha256 = sha256(output);
    review.reviewerChecks[0]!.result = 'fabricated prefix not in output';
    assert.throws(() => validateRuntimeProvenance(review, file), /result is not a prefix/);
    review.reviewerChecks[0] = { ...baseCheck, command: 'rm -rf src' };
    assert.throws(() => validateRuntimeProvenance(review, file), /command does not match the prior bash call/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed command check must be recorded as fail', () => {
  const { dir, file, review } = transcriptFor();
  const output = 'Command exited with code 1';
  const baseCheck = {
    checkId: 'chk-fail', kind: 'command' as const, command: 'grep -q missing src/a.ts', cwd: '/repo',
    result: output, status: 'pass' as const, evidenceRefs: [], toolCallId: 'chk-fail-call', outputSha256: sha256(output),
  };
  review.reviewerChecks = [baseCheck];
  syncChecks(review);
  fs.appendFileSync(file, bashEntry('chk-fail-call', 'grep -q missing src/a.ts', output, true));
  try {
    assert.throws(() => validateRuntimeProvenance(review, file), /must be 'fail' for a failed command/);
    review.reviewerChecks[0] = { ...baseCheck, status: 'fail' as const };
    syncChecks(review);
    assert.doesNotThrow(() => validateRuntimeProvenance(review, file));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('static inspection checks bind to a prior read or grep call', () => {
  const { dir, file, review } = transcriptFor();
  const target = path.join(dir, 'a.ts');
  const content = 'export const needle = 1;\n';
  const readCheck = { checkId: 'chk-read', kind: 'static_inspection' as const, target, query: 'needle', result: content, status: 'pass' as const, evidenceRefs: [], toolCallId: 'chk-read-call', outputSha256: sha256(content) };
  const grepCheck = { checkId: 'chk-grep', kind: 'static_inspection' as const, target, query: 'needle', result: content, status: 'pass' as const, evidenceRefs: [], toolCallId: 'chk-grep-call', outputSha256: sha256(content) };
  review.reviewerChecks = [readCheck, grepCheck];
  syncChecks(review);
  fs.appendFileSync(file, readEntry('chk-read-call', target, content));
  fs.appendFileSync(file, grepEntry('chk-grep-call', 'needle', target, content));
  try {
    assert.doesNotThrow(() => validateRuntimeProvenance(review, file));
    review.reviewerChecks[0] = { ...readCheck, target: path.join(dir, 'other.ts') };
    assert.throws(() => validateRuntimeProvenance(review, file), /target does not match the prior read call/);
    review.reviewerChecks[0] = readCheck;
    review.reviewerChecks[1] = { ...grepCheck, query: 'absent' };
    assert.throws(() => validateRuntimeProvenance(review, file), /query does not match the prior grep pattern/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a non-skipped check not bound to any prior tool call is rejected', () => {
  const { dir, file, review } = transcriptFor();
  review.reviewerChecks = [{
    checkId: 'chk-orphan', kind: 'command', command: 'git diff --no-ext-diff --no-textconv -- src/a.ts', cwd: '/repo',
    result: 'x', status: 'pass', evidenceRefs: [], toolCallId: 'never-issued', outputSha256: sha256('x'),
  }];
  syncChecks(review);
  try {
    assert.throws(() => validateRuntimeProvenance(review, file), /not bound to a completed prior tool call/);
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
    review.provenance.hostVersion = '9.9.9';
    assert.throws(() => validateRuntimeProvenance(review, file), /hostVersion does not match the host editor version/);
  } finally {
    if (saved === undefined) delete process.env.PIE_EDITOR_VERSION; else process.env.PIE_EDITOR_VERSION = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
