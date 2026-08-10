import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import registerSessionReviewer from '../index.js';
import { compileReviewDraft } from '../src/draft.js';
import type { ReviewerRuntime, SessionReviewDraft, SessionReviewV2 } from '../src/types.js';
import { validReview } from './fixtures.js';

function appendRuntimeCalls(file: string, reviews: SessionReviewV2[]): void {
  const runtimes = reviews.flatMap((review) => [...review.proposals, review.consolidation, ...review.components, ...(review.adjudication ? [review.adjudication] : [])]);
  for (const runtime of runtimes) {
    const record = runtime as ReviewerRuntime;
    fs.appendFileSync(file, `${JSON.stringify({
      type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: record.toolCallId, name: 'subagent', arguments: { agent: 'reviewer', bucket: record.requestedBucket, task: record.promptHash } }] },
    })}\n${JSON.stringify({
      type: 'message', message: { role: 'toolResult', toolCallId: record.toolCallId, toolName: 'subagent', details: { results: [{
        parentToolCallId: record.toolCallId, requestedBucket: record.requestedBucket, bucket: record.bucket, bucketDowngraded: record.bucketDowngraded,
        model: record.modelId, provider: record.provider, family: record.family, thinkingLevel: record.thinkingLevel, promptHash: record.promptHash,
      }] } },
    })}\n`);
  }
}

function compactReview(review: SessionReviewV2): SessionReviewDraft {
  const proposals = review.proposals.map(({ proposalId: _proposalId, proposedAt: _proposedAt, rubricVersion: _rubricVersion, ...rest }) => rest) as SessionReviewDraft['proposals'];
  const { consolidationId: _consolidationId, consolidatedAt: _consolidatedAt, rubricVersion: _consolidationRubric, frozenLedger: _consolidationLedger, frozenLedgerSha256: _consolidationHash, provenance: consolidationProvenance, ...consolidation } = review.consolidation;
  const components = review.components.map(({ assessmentId: _assessmentId, assessedAt: _assessedAt, rubricVersion: _assessmentRubric, classifications, ...rest }) => {
    const { proposedOverall: _proposedOverall, ...classificationFields } = classifications;
    return { ...rest, classifications: classificationFields };
  }) as SessionReviewDraft['components'];
  return {
    sessionId: review.sessionId,
    sessionPathAtReview: review.sessionPathAtReview,
    frozenLedger: review.frozenLedger,
    proposals,
    consolidation: { ...consolidation, provenance: consolidationProvenance },
    components,
    provenance: { evidenceManifest: review.provenance.evidenceManifest },
  };
}

test('review work is single-target and legacy batch routes remain bounded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-batch-'));
  const targetPaths = ['one', 'two'].map((name) => {
    const file = path.join(dir, `${name}.jsonl`);
    const header = name === 'two' ? { type: 'session' } : { type: 'session', id: `${name}-id` };
    fs.writeFileSync(file, `${JSON.stringify(header)}\n`);
    return file;
  });
  const selfPath = path.join(dir, 'self.jsonl');
  fs.writeFileSync(selfPath, `${JSON.stringify({ type: 'session', id: 'self-id' })}\n`);
  const savedDir = process.env.PIE_REVIEWS_DIR;
  const savedTabs = process.env.PIE_OPEN_TABS;
  process.env.PIE_REVIEWS_DIR = dir;
  process.env.PIE_OPEN_TABS = JSON.stringify([
    ...targetPaths.map((file, index) => ({ path: file, name: `target-${index}`, pinned: true, isRunning: false })),
    { path: selfPath, name: 'reviewer', pinned: true, isRunning: false },
  ]);
  let tool: any;
  registerSessionReviewer({ registerTool(value: unknown) { tool = value; } } as any);
  const ctx = { sessionManager: { getSessionFile: () => selfPath } };
  try {
    assert.equal((await tool.execute('list', { action: 'listSelected' }, undefined, undefined, ctx)).isError, false);
    const firstEvidence = await tool.execute('evidence-one', { action: 'getEvidence', sessionPath: targetPaths[0] }, undefined, undefined, ctx);
    assert.equal(firstEvidence.isError, false, firstEvidence.content[0].text);
    const blockedEvidence = await tool.execute('evidence-two-blocked', { action: 'getEvidence', sessionPath: targetPaths[1] }, undefined, undefined, ctx);
    assert.equal(blockedEvidence.isError, true);
    assert.match(blockedEvidence.content[0].text, /active review target/);

    const firstReview = validReview({
      reviewId: 'batch-review-0',
      sessionId: firstEvidence.details.sessionId,
      identityFallback: firstEvidence.details.identityFallback,
      sessionPathAtReview: targetPaths[0],
      provenance: { ...validReview().provenance, orchestratorSessionId: 'self-id', evidenceManifest: firstEvidence.details.manifest },
    });
    appendRuntimeCalls(selfPath, [firstReview]);
    const firstRecorded = await tool.execute('record-one', { action: 'recordReviews', reviews: [firstReview] }, undefined, undefined, ctx);
    assert.equal(firstRecorded.isError, false, firstRecorded.content[0].text);
    assert.equal(firstRecorded.details.results.length, 1);
    assert.equal(firstRecorded.details.results[0].reviewId, 'batch-review-0');
    const firstClosed = await tool.execute('close-one', {
      action: 'closeReviewed', sessionId: firstEvidence.details.sessionId, reviewId: firstRecorded.details.results[0].reviewId, sessionPath: targetPaths[0],
    }, undefined, undefined, ctx);
    assert.equal(firstClosed.isError, false, firstClosed.content[0].text);

    const secondEvidence = await tool.execute('evidence-two', { action: 'getEvidence', sessionPath: targetPaths[1] }, undefined, undefined, ctx);
    assert.equal(secondEvidence.isError, false, secondEvidence.content[0].text);
    const secondReview = validReview({
      reviewId: 'batch-review-1',
      sessionId: secondEvidence.details.sessionId,
      identityFallback: secondEvidence.details.identityFallback,
      sessionPathAtReview: targetPaths[1],
      provenance: { ...validReview().provenance, orchestratorSessionId: 'self-id', evidenceManifest: secondEvidence.details.manifest },
    });
    const compact = compactReview(secondReview);
    const compiledCompact = compileReviewDraft(compact, { orchestratorSessionId: 'self-id' });
    appendRuntimeCalls(selfPath, [compiledCompact]);
    const secondRecorded = await tool.execute('record-two', { action: 'recordReviews', reviews: [compact] }, undefined, undefined, ctx);
    assert.equal(secondRecorded.isError, false, secondRecorded.content[0].text);
    assert.equal(secondRecorded.details.results.length, 1);
    assert.match(secondRecorded.details.results[0].reviewId, /^review-/);

    const secondClosed = await tool.execute('close-two', {
      action: 'closeReviewedBatch',
      closures: [{ sessionId: secondEvidence.details.sessionId, reviewId: secondRecorded.details.results[0].reviewId, sessionPath: targetPaths[1] }],
    }, undefined, undefined, ctx);
    assert.equal(secondClosed.isError, false, secondClosed.content[0].text);
    assert.equal(secondClosed.details.results.length, 1);
    assert.equal(secondClosed.details.results[0].status, 'pending');
    const actions = fs.readFileSync(path.join(dir, 'closure-actions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(actions.map((action) => action.kind), ['closeReviewed', 'closeReviewed']);
  } finally {
    if (savedDir === undefined) delete process.env.PIE_REVIEWS_DIR; else process.env.PIE_REVIEWS_DIR = savedDir;
    if (savedTabs === undefined) delete process.env.PIE_OPEN_TABS; else process.env.PIE_OPEN_TABS = savedTabs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
