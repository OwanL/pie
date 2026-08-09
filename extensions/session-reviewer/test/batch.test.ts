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

test('recordReviews and closeReviewedBatch process canonical and compact targets', async () => {
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
    const evidence = await Promise.all(targetPaths.map((sessionPath) => tool.execute(`evidence-${sessionPath}`, { action: 'getEvidence', sessionPath }, undefined, undefined, ctx)));
    assert.equal(evidence.every((result: any) => !result.isError), true);
    const fullReviews = targetPaths.map((sessionPath, index) => validReview({
      reviewId: `batch-review-${index}`,
      sessionId: evidence[index].details.sessionId,
      identityFallback: evidence[index].details.identityFallback,
      sessionPathAtReview: sessionPath,
      provenance: { ...validReview().provenance, orchestratorSessionId: 'self-id', evidenceManifest: evidence[index].details.manifest },
    }));
    const compact = compactReview(fullReviews[1]!);
    const compiledCompact = compileReviewDraft(compact, { orchestratorSessionId: 'self-id' });
    appendRuntimeCalls(selfPath, [fullReviews[0]!, compiledCompact]);

    const recorded = await tool.execute('record-batch', { action: 'recordReviews', reviews: [fullReviews[0], compact] }, undefined, undefined, ctx);
    assert.equal(recorded.isError, false, recorded.content[0].text);
    assert.equal(recorded.details.results.length, 2);
    assert.equal(recorded.details.results.every((result: any) => result.written), true);
    assert.equal(recorded.details.results[0].reviewId, 'batch-review-0');
    assert.match(recorded.details.results[1].reviewId, /^review-/);

    const closed = await tool.execute('close-batch', {
      action: 'closeReviewedBatch',
      closures: recorded.details.results.map((result: any, index: number) => ({ sessionId: evidence[index].details.sessionId, reviewId: result.reviewId, sessionPath: targetPaths[index] })),
    }, undefined, undefined, ctx);
    assert.equal(closed.isError, false, closed.content[0].text);
    assert.equal(closed.details.results.length, 2);
    assert.equal(closed.details.results.every((result: any) => result.status === 'pending'), true);
    const actions = fs.readFileSync(path.join(dir, 'closure-actions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(actions.map((action) => action.kind), ['closeReviewed', 'closeReviewed']);
  } finally {
    if (savedDir === undefined) delete process.env.PIE_REVIEWS_DIR; else process.env.PIE_REVIEWS_DIR = savedDir;
    if (savedTabs === undefined) delete process.env.PIE_OPEN_TABS; else process.env.PIE_OPEN_TABS = savedTabs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
