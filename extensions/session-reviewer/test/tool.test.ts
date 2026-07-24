import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import registerSessionReviewer from '../index.js';
import { sessionReviewSchema } from '../src/types.js';
import type { ReviewerRuntime, SessionReviewV2 } from '../src/types.js';
import { validReview } from './fixtures.js';

function appendRuntimeCalls(file: string, review: SessionReviewV2): void {
  const runtimes: ReviewerRuntime[] = [...review.proposals, review.consolidation, ...review.components, ...(review.adjudication ? [review.adjudication] : [])];
  for (const runtime of runtimes) {
    fs.appendFileSync(file, `${JSON.stringify({
      type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: runtime.toolCallId, name: 'subagent', arguments: { bucket: runtime.requestedBucket, task: runtime.promptHash } }] },
    })}\n${JSON.stringify({
      type: 'message', message: { role: 'toolResult', toolCallId: runtime.toolCallId, toolName: 'subagent', details: { results: [{
        parentToolCallId: runtime.toolCallId, requestedBucket: runtime.requestedBucket, bucket: runtime.bucket, bucketDowngraded: runtime.bucketDowngraded,
        model: runtime.modelId, provider: runtime.provider, family: runtime.family, thinkingLevel: runtime.thinkingLevel, promptHash: runtime.promptHash,
      }] } },
    })}\n`);
  }
}

test('tool exposes only the V2 action surface', () => {
  assert.deepEqual(sessionReviewSchema.properties.action.enum, ['listOpen', 'listSelected', 'getEvidence', 'recordReview', 'closeReviewed', 'closeSelf']);
  assert.equal(sessionReviewSchema.properties.action.enum.includes('setReview' as never), false);
  assert.equal(sessionReviewSchema.properties.action.enum.includes('getTranscript' as never), false);
});

test('list snapshots scope evidence and closure to eligible targets in the orchestrator session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-scope-'));
  const files = Object.fromEntries(['target', 'outside', 'running', 'self'].map((name) => {
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session', id: `${name}-id` })}\n`);
    return [name, file];
  })) as Record<string, string>;
  const savedDir = process.env.PIE_REVIEWS_DIR;
  const savedTabs = process.env.PIE_OPEN_TABS;
  process.env.PIE_REVIEWS_DIR = dir;
  process.env.PIE_OPEN_TABS = JSON.stringify([
    { path: files.target, name: 'target', pinned: true },
    { path: files.outside, name: 'outside', pinned: false },
    { path: files.running, name: 'running', pinned: true, isRunning: true },
    { path: files.self, name: 'self', pinned: true },
  ]);
  let tool: any;
  registerSessionReviewer({ registerTool(value: unknown) { tool = value; } } as any);
  const ctx = { sessionManager: { getSessionFile: () => files.self } };
  try {
    assert.equal((await tool.execute('pre', { action: 'getEvidence', sessionPath: files.target }, undefined, undefined, ctx)).isError, true);
    await tool.execute('list', { action: 'listSelected' }, undefined, undefined, ctx);
    assert.equal((await tool.execute('outside', { action: 'getEvidence', sessionPath: files.outside }, undefined, undefined, ctx)).isError, true);
    assert.equal((await tool.execute('running', { action: 'getEvidence', sessionPath: files.running }, undefined, undefined, ctx)).isError, true);
    assert.equal((await tool.execute('self', { action: 'getEvidence', sessionPath: files.self }, undefined, undefined, ctx)).isError, true);
    const tabs = JSON.parse(process.env.PIE_OPEN_TABS!);
    tabs[0].isRunning = true;
    process.env.PIE_OPEN_TABS = JSON.stringify(tabs);
    assert.equal((await tool.execute('became-running', { action: 'getEvidence', sessionPath: files.target }, undefined, undefined, ctx)).isError, true);
    tabs[0].isRunning = false;
    process.env.PIE_OPEN_TABS = JSON.stringify(tabs);
    assert.equal((await tool.execute('target', { action: 'getEvidence', sessionPath: files.target }, undefined, undefined, ctx)).isError, false);
    assert.equal((await tool.execute('close-outside', { action: 'closeReviewed', sessionId: 'outside-id', reviewId: 'none' }, undefined, undefined, ctx)).isError, true);
  } finally {
    if (savedDir === undefined) delete process.env.PIE_REVIEWS_DIR; else process.env.PIE_REVIEWS_DIR = savedDir;
    if (savedTabs === undefined) delete process.env.PIE_OPEN_TABS; else process.env.PIE_OPEN_TABS = savedTabs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vertical slice lists selected, issues evidence, records once, then enqueues closure separately', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-tool-'));
  const sessionPath = path.join(dir, 'target.jsonl');
  const selfPath = path.join(dir, 'self.jsonl');
  fs.writeFileSync(sessionPath, `${JSON.stringify({ type: 'session', id: 'target-id' })}\n${JSON.stringify({ type: 'message', message: { role: 'user', content: 'do it' } })}\n`);
  fs.writeFileSync(selfPath, `${JSON.stringify({ type: 'session', id: 'self-id' })}\n`);
  const savedDir = process.env.PIE_REVIEWS_DIR;
  const savedTabs = process.env.PIE_OPEN_TABS;
  process.env.PIE_REVIEWS_DIR = dir;
  process.env.PIE_OPEN_TABS = JSON.stringify([
    { path: sessionPath, name: 'target', pinned: true, isRunning: false },
    { path: selfPath, name: 'reviewer', pinned: true, isRunning: false },
  ]);
  let tool: any;
  registerSessionReviewer({ registerTool(value: unknown) { tool = value; } } as any);
  const ctx = { sessionManager: { getSessionFile: () => selfPath } };
  try {
    const listed = await tool.execute('1', { action: 'listSelected' }, undefined, undefined, ctx);
    assert.equal(listed.isError, false);
    assert.equal(listed.details.sessions.length, 2);
    assert.equal(listed.details.sessions.find((s: any) => s.sessionId === 'self-id').isSelf, true);

    const evidence = await tool.execute('2', { action: 'getEvidence', sessionPath }, undefined, undefined, ctx);
    assert.equal(evidence.isError, false);
    assert.equal(evidence.details.sessionId, 'target-id');
    const review = validReview({
      reviewId: 'target-review', sessionId: 'target-id', sessionPathAtReview: sessionPath,
      provenance: { ...validReview().provenance, orchestratorSessionId: 'self-id', evidenceManifest: evidence.details.manifest },
    });
    appendRuntimeCalls(selfPath, review);
    const recorded = await tool.execute('3', { action: 'recordReview', review }, undefined, undefined, ctx);
    assert.equal(recorded.isError, false, recorded.content[0].text);
    const duplicate = await tool.execute('4', { action: 'recordReview', review: { ...review, reviewId: 'duplicate' } }, undefined, undefined, ctx);
    assert.equal(duplicate.isError, false);
    assert.match(duplicate.content[0].text, /already has canonical/);

    const reviewsBeforeClose = fs.readFileSync(path.join(dir, 'reviews.jsonl'), 'utf8');
    const closed = await tool.execute('5', { action: 'closeReviewed', sessionId: 'target-id', reviewId: 'target-review', sessionPath }, undefined, undefined, ctx);
    assert.equal(closed.isError, false, closed.content[0].text);
    assert.equal(fs.readFileSync(path.join(dir, 'reviews.jsonl'), 'utf8'), reviewsBeforeClose);
    const selfClosed = await tool.execute('6', { action: 'closeSelf' }, undefined, undefined, ctx);
    assert.equal(selfClosed.isError, false);
    const actions = fs.readFileSync(path.join(dir, 'closure-actions.jsonl'), 'utf8').trim().split('\n').map((line: string) => JSON.parse(line));
    assert.deepEqual(actions.map((a: any) => a.kind), ['closeReviewed', 'closeSelf']);
    assert.equal(actions[1].reviewId, undefined);
  } finally {
    if (savedDir === undefined) delete process.env.PIE_REVIEWS_DIR; else process.env.PIE_REVIEWS_DIR = savedDir;
    if (savedTabs === undefined) delete process.env.PIE_OPEN_TABS; else process.env.PIE_OPEN_TABS = savedTabs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
