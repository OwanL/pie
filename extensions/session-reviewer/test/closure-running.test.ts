import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import registerSessionReviewer from '../index.js';
import type { ReviewerRuntime, SessionReviewV2 } from '../src/types.js';
import { validReview } from './fixtures.js';

function appendRuntimeCalls(file: string, review: SessionReviewV2): void {
  const runtimes: ReviewerRuntime[] = [...review.proposals, review.consolidation, ...review.components, ...(review.adjudication ? [review.adjudication] : [])];
  for (const runtime of runtimes) {
    fs.appendFileSync(file, `${JSON.stringify({
      type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: runtime.toolCallId, name: 'subagent', arguments: { agent: 'reviewer', bucket: runtime.requestedBucket, task: runtime.promptHash } }] },
    })}\n${JSON.stringify({
      type: 'message', message: { role: 'toolResult', toolCallId: runtime.toolCallId, toolName: 'subagent', details: { results: [{
        parentToolCallId: runtime.toolCallId, requestedBucket: runtime.requestedBucket, bucket: runtime.bucket, bucketDowngraded: runtime.bucketDowngraded,
        model: runtime.modelId, provider: runtime.provider, family: runtime.family, thinkingLevel: runtime.thinkingLevel, promptHash: runtime.promptHash,
      }] } },
    })}\n`);
  }
}

interface Harness {
  tool: any;
  ctx: { sessionManager: { getSessionFile(): string } };
  dir: string;
  targetPath: string;
  selfPath: string;
  setRunning(running: boolean): void;
  cleanup(): void;
}

function harness(opts: { pinned?: boolean; running?: boolean; preReviewed?: boolean } = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-closure-running-'));
  const targetPath = path.join(dir, 'target.jsonl');
  const selfPath = path.join(dir, 'self.jsonl');
  fs.writeFileSync(targetPath, `${JSON.stringify({ type: 'session', id: 'target-id' })}\n${JSON.stringify({ type: 'message', message: { role: 'user', content: 'do it' } })}\n`);
  fs.writeFileSync(selfPath, `${JSON.stringify({ type: 'session', id: 'self-id' })}\n`);
  const savedDir = process.env.PIE_REVIEWS_DIR;
  const savedTabs = process.env.PIE_OPEN_TABS;
  process.env.PIE_REVIEWS_DIR = dir;
  const setTabs = (running: boolean): void => {
    process.env.PIE_OPEN_TABS = JSON.stringify([
      { path: targetPath, name: 'target', pinned: opts.pinned ?? true, isRunning: running },
      { path: selfPath, name: 'reviewer', pinned: true, isRunning: false },
    ]);
  };
  setTabs(opts.running ?? false);
  let tool: any;
  registerSessionReviewer({ registerTool(value: unknown) { tool = value; } } as any);
  const ctx = { sessionManager: { getSessionFile: () => selfPath } };
  return {
    tool,
    ctx,
    dir,
    targetPath,
    selfPath,
    setRunning: setTabs,
    cleanup: () => {
      if (savedDir === undefined) delete process.env.PIE_REVIEWS_DIR; else process.env.PIE_REVIEWS_DIR = savedDir;
      if (savedTabs === undefined) delete process.env.PIE_OPEN_TABS; else process.env.PIE_OPEN_TABS = savedTabs;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function recordReviewWhileIdle(h: Harness): Promise<SessionReviewV2> {
  await h.tool.execute('list', { action: 'listSelected' }, undefined, undefined, h.ctx);
  const evidence = await h.tool.execute('ev', { action: 'getEvidence', sessionPath: h.targetPath }, undefined, undefined, h.ctx);
  assert.equal(evidence.isError, false);
  const review = validReview({
    reviewId: 'target-review', sessionId: 'target-id', sessionPathAtReview: h.targetPath,
    provenance: { ...validReview().provenance, orchestratorSessionId: 'self-id', evidenceManifest: evidence.details.manifest, hostVersion: process.env.PIE_EDITOR_VERSION?.trim() || null },
  });
  appendRuntimeCalls(h.selfPath, review);
  const recorded = await h.tool.execute('rec', { action: 'recordReview', review }, undefined, undefined, h.ctx);
  assert.equal(recorded.isError, false, recorded.content[0].text);
  return review;
}

test('closeReviewed succeeds for an already-reviewed session that became running after the review', async () => {
  const h = harness({ pinned: true, running: false });
  try {
    await recordReviewWhileIdle(h);
    // The target starts running after the review was recorded.
    h.setRunning(true);
    const closed = await h.tool.execute('close', { action: 'closeReviewed', sessionId: 'target-id', reviewId: 'target-review', sessionPath: h.targetPath }, undefined, undefined, h.ctx);
    assert.equal(closed.isError, false, closed.content[0].text);
    assert.equal(closed.details.action.kind, 'closeReviewed');
    assert.equal(closed.details.action.targetSessionId, 'target-id');
    // reviews.jsonl is untouched by closure.
    const reviews = fs.readFileSync(path.join(h.dir, 'reviews.jsonl'), 'utf8').trim().split('\n');
    assert.equal(reviews.length, 1);
  } finally {
    h.cleanup();
  }
});

test('a running target forbids evidence and recording but allows closeReviewed once reviewed', async () => {
  const h = harness({ pinned: true, running: false });
  try {
    await recordReviewWhileIdle(h);
    h.setRunning(true);
    // Re-list so the running snapshot is current.
    const listed = await h.tool.execute('relist', { action: 'listSelected' }, undefined, undefined, h.ctx);
    const target = listed.details.sessions.find((s: any) => s.sessionId === 'target-id');
    assert.equal(target.isRunning, true);
    assert.equal(target.closureEligible, true, 'closureEligible stays truthful for a running already-reviewed session');
    assert.equal(target.reviewEligible, false, 'review stays forbidden for a running session');

    // Evidence and recording remain forbidden for running targets.
    const evidence = await h.tool.execute('ev2', { action: 'getEvidence', sessionPath: h.targetPath }, undefined, undefined, h.ctx);
    assert.equal(evidence.isError, true);
    const review = validReview({ reviewId: 'late', sessionId: 'target-id', sessionPathAtReview: h.targetPath });
    const recorded = await h.tool.execute('rec2', { action: 'recordReview', review }, undefined, undefined, h.ctx);
    assert.equal(recorded.isError, true);

    // Closure is allowed for the running already-reviewed target.
    const closed = await h.tool.execute('close', { action: 'closeReviewed', sessionId: 'target-id', reviewId: 'target-review', sessionPath: h.targetPath }, undefined, undefined, h.ctx);
    assert.equal(closed.isError, false, closed.content[0].text);
  } finally {
    h.cleanup();
  }
});

test('closeReviewed still excludes self even when self is running and reviewed', async () => {
  const h = harness({ pinned: true, running: false });
  try {
    await recordReviewWhileIdle(h);
    h.setRunning(true);
    // Self is never a valid closeReviewed target (it has no review for itself).
    const closed = await h.tool.execute('self-close', { action: 'closeReviewed', sessionId: 'self-id', reviewId: 'target-review' }, undefined, undefined, h.ctx);
    assert.equal(closed.isError, true);
  } finally {
    h.cleanup();
  }
});
