import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import registerSessionReviewer from '../index.js';
import { recordReviewOnce } from '../src/store.js';
import { validReview } from './fixtures.js';

interface Harness {
  dir: string;
  targetPath: string;
  selfPath: string;
  tool: any;
  ctx: { sessionManager: { getSessionFile(): string } };
  setTabs(input: { targetPinned?: boolean; includeTarget?: boolean; selfPinned?: boolean; selfRunning?: boolean; revision: number }): void;
  cleanup(): void;
}

function harness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-authority-'));
  const targetPath = path.join(dir, 'target.jsonl');
  const selfPath = path.join(dir, 'self.jsonl');
  fs.writeFileSync(targetPath, `${JSON.stringify({ type: 'session', id: 'target-id' })}\n`);
  fs.writeFileSync(selfPath, `${JSON.stringify({ type: 'session', id: 'self-id' })}\n${JSON.stringify({ type: 'message', message: { role: 'user', content: 'review selected sessions' } })}\n`);

  const savedDir = process.env.PIE_REVIEWS_DIR;
  const savedTabs = process.env.PIE_OPEN_TABS;
  const savedRevision = process.env.PIE_OPEN_TABS_REVISION;
  process.env.PIE_REVIEWS_DIR = dir;
  const setTabs = (input: { targetPinned?: boolean; includeTarget?: boolean; selfPinned?: boolean; selfRunning?: boolean; revision: number }): void => {
    process.env.PIE_OPEN_TABS = JSON.stringify([
      ...(input.includeTarget === false ? [] : [{ path: targetPath, name: 'target', pinned: input.targetPinned ?? true, isRunning: false }]),
      { path: selfPath, name: 'reviewer', pinned: input.selfPinned ?? true, isRunning: input.selfRunning ?? false },
    ]);
    process.env.PIE_OPEN_TABS_REVISION = String(input.revision);
  };
  setTabs({ revision: 1 });
  let tool: any;
  registerSessionReviewer({ registerTool(value: unknown) { tool = value; } } as any);
  return {
    dir,
    targetPath,
    selfPath,
    tool,
    ctx: { sessionManager: { getSessionFile: () => selfPath } },
    setTabs,
    cleanup: () => {
      if (savedDir === undefined) delete process.env.PIE_REVIEWS_DIR; else process.env.PIE_REVIEWS_DIR = savedDir;
      if (savedTabs === undefined) delete process.env.PIE_OPEN_TABS; else process.env.PIE_OPEN_TABS = savedTabs;
      if (savedRevision === undefined) delete process.env.PIE_OPEN_TABS_REVISION; else process.env.PIE_OPEN_TABS_REVISION = savedRevision;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('closeReviewed revalidates current selected membership instead of trusting its list snapshot', async () => {
  const h = harness();
  try {
    await recordReviewOnce(validReview({ reviewId: 'target-review', sessionId: 'target-id', sessionPathAtReview: h.targetPath }));
    const listed = await h.tool.execute('list', { action: 'listSelected' }, undefined, undefined, h.ctx);
    assert.equal(listed.isError, false);
    assert.equal(listed.details.registryRevision, 1);

    h.setTabs({ includeTarget: false, revision: 2 });
    const removed = await h.tool.execute('close-removed', {
      action: 'closeReviewed', sessionId: 'target-id', reviewId: 'target-review', sessionPath: h.targetPath,
    }, undefined, undefined, h.ctx);
    assert.equal(removed.isError, true);
    assert.equal(fs.existsSync(path.join(h.dir, 'closure-actions.jsonl')), false);

    h.setTabs({ targetPinned: false, revision: 3 });
    const unpinned = await h.tool.execute('close-unpinned', {
      action: 'closeReviewed', sessionId: 'target-id', reviewId: 'target-review', sessionPath: h.targetPath,
    }, undefined, undefined, h.ctx);
    assert.equal(unpinned.isError, true);
    assert.equal(fs.existsSync(path.join(h.dir, 'closure-actions.jsonl')), false);

    // Re-pinning does not authorize a target which was absent from the most
    // recent selected list; an explicit relist is required.
    await h.tool.execute('relist-unpinned', { action: 'listSelected' }, undefined, undefined, h.ctx);
    h.setTabs({ targetPinned: true, revision: 4 });
    const newlyPinned = await h.tool.execute('close-newly-pinned', {
      action: 'closeReviewed', sessionId: 'target-id', reviewId: 'target-review', sessionPath: h.targetPath,
    }, undefined, undefined, h.ctx);
    assert.equal(newlyPinned.isError, true);
  } finally { h.cleanup(); }
});

test('a target pinned after the evaluator starts is reviewable after an explicit relist', async () => {
  const h = harness();
  try {
    h.setTabs({ includeTarget: false, revision: 1 });
    const initial = await h.tool.execute('initial-list', { action: 'listSelected' }, undefined, undefined, h.ctx);
    assert.equal(initial.isError, false);
    assert.equal(initial.details.sessions.some((session: { sessionId: string }) => session.sessionId === 'target-id'), false);

    h.setTabs({ targetPinned: true, revision: 2 });
    const beforeRelist = await h.tool.execute(
      'evidence-before-relist',
      { action: 'getEvidence', sessionPath: h.targetPath },
      undefined,
      undefined,
      h.ctx,
    );
    assert.equal(beforeRelist.isError, true);

    const relisted = await h.tool.execute('relist', { action: 'listSelected' }, undefined, undefined, h.ctx);
    assert.equal(relisted.isError, false);
    assert.equal(relisted.details.sessions.some((session: { sessionId: string }) => session.sessionId === 'target-id'), true);
    const evidence = await h.tool.execute(
      'evidence-after-relist',
      { action: 'getEvidence', sessionPath: h.targetPath },
      undefined,
      undefined,
      h.ctx,
    );
    assert.equal(evidence.isError, false, evidence.content[0].text);
  } finally { h.cleanup(); }
});

test('an unrelated newer registry revision keeps the current-turn selected scope usable', async () => {
  const h = harness();
  try {
    await recordReviewOnce(validReview({ reviewId: 'target-review', sessionId: 'target-id', sessionPathAtReview: h.targetPath }));
    await h.tool.execute('list', { action: 'listSelected' }, undefined, undefined, h.ctx);

    // Busy/tab changes elsewhere advance the host revision frequently. The
    // target is still the same selected path and identity, so forcing another
    // list here would make a large review batch unnecessarily chatty.
    h.setTabs({ targetPinned: true, revision: 2 });
    const closed = await h.tool.execute('close-current', {
      action: 'closeReviewed', sessionId: 'target-id', reviewId: 'target-review', sessionPath: h.targetPath,
    }, undefined, undefined, h.ctx);

    assert.equal(closed.isError, false, closed.content[0].text);
    assert.equal(closed.details.action.status, 'pending');
  } finally { h.cleanup(); }
});

test('ordinary user follow-ups preserve in-flight target recovery and close authority', async () => {
  const h = harness();
  try {
    await h.tool.execute('list', { action: 'listSelected' }, undefined, undefined, h.ctx);
    const evidence = await h.tool.execute(
      'evidence',
      { action: 'getEvidence', sessionPath: h.targetPath },
      undefined,
      undefined,
      h.ctx,
    );
    assert.equal(evidence.isError, false, evidence.content[0].text);

    fs.appendFileSync(h.selfPath, `${JSON.stringify({ type: 'message', message: { role: 'user', content: 'close sessions as you go' } })}\n`);
    const status = await h.tool.execute(
      'status-after-follow-up',
      { action: 'getReviewStatus', sessionId: 'target-id', sessionPath: h.targetPath },
      undefined,
      undefined,
      h.ctx,
    );
    assert.equal(status.isError, false, status.content[0].text);
    assert.equal(status.details.next, 'proposal-small');

    await recordReviewOnce(validReview({ reviewId: 'target-review', sessionId: 'target-id', sessionPathAtReview: h.targetPath }));
    const closed = await h.tool.execute('close-after-follow-up', {
      action: 'closeReviewed', sessionId: 'target-id', reviewId: 'target-review', sessionPath: h.targetPath,
    }, undefined, undefined, h.ctx);
    assert.equal(closed.isError, false, closed.content[0].text);

    const selfClose = await h.tool.execute(
      'self-close-after-follow-up',
      { action: 'closeSelf', confirmSelf: true },
      undefined,
      undefined,
      h.ctx,
    );
    assert.equal(selfClose.isError, true);
    assert.match(selfClose.content[0].text, /current user turn/);
  } finally { h.cleanup(); }
});

test('a branch rewrite invalidates in-flight target recovery until relisted', async () => {
  const h = harness();
  try {
    await h.tool.execute('list', { action: 'listSelected' }, undefined, undefined, h.ctx);
    const evidence = await h.tool.execute(
      'evidence',
      { action: 'getEvidence', sessionPath: h.targetPath },
      undefined,
      undefined,
      h.ctx,
    );
    assert.equal(evidence.isError, false, evidence.content[0].text);

    fs.writeFileSync(h.selfPath, `${JSON.stringify({ type: 'session', id: 'self-id' })}\n${JSON.stringify({ type: 'message', message: { role: 'user', content: 'edited and resent review request' } })}\n`);
    const stale = await h.tool.execute(
      'status-after-rewrite',
      { action: 'getReviewStatus', sessionId: 'target-id', sessionPath: h.targetPath },
      undefined,
      undefined,
      h.ctx,
    );
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /List targets/);

    await h.tool.execute('relist', { action: 'listSelected' }, undefined, undefined, h.ctx);
    const recovered = await h.tool.execute(
      'status-after-relist',
      { action: 'getReviewStatus', sessionId: 'target-id', sessionPath: h.targetPath },
      undefined,
      undefined,
      h.ctx,
    );
    assert.equal(recovered.isError, true);
    assert.match(recovered.content[0].text, /Fetch evidence/);
  } finally { h.cleanup(); }
});

test('a revisioned snapshot fails closed if the live registry revision disappears or becomes malformed', async () => {
  const h = harness();
  try {
    await h.tool.execute('list', { action: 'listSelected' }, undefined, undefined, h.ctx);
    delete process.env.PIE_OPEN_TABS_REVISION;
    const missing = await h.tool.execute(
      'close-missing-revision',
      { action: 'closeSelf', confirmSelf: true },
      undefined,
      undefined,
      h.ctx,
    );
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /listSelected/);

    h.setTabs({ revision: 2 });
    await h.tool.execute('relist', { action: 'listSelected' }, undefined, undefined, h.ctx);
    process.env.PIE_OPEN_TABS_REVISION = 'not-a-revision';
    const malformed = await h.tool.execute(
      'close-malformed-revision',
      { action: 'closeSelf', confirmSelf: true },
      undefined,
      undefined,
      h.ctx,
    );
    assert.equal(malformed.isError, true);
    assert.match(malformed.content[0].text, /listSelected/);
  } finally { h.cleanup(); }
});

test('a later user turn or branch rewrite invalidates inherited closeSelf authority', async () => {
  const h = harness();
  try {
    await h.tool.execute('list', { action: 'listSelected' }, undefined, undefined, h.ctx);
    fs.appendFileSync(h.selfPath, `${JSON.stringify({ type: 'message', message: { role: 'user', content: 'new turn' } })}\n`);
    const laterTurn = await h.tool.execute('close-later-turn', { action: 'closeSelf', confirmSelf: true }, undefined, undefined, h.ctx);
    assert.equal(laterTurn.isError, true);
    assert.match(laterTurn.content[0].text, /listSelected/);

    await h.tool.execute('relist', { action: 'listSelected' }, undefined, undefined, h.ctx);
    fs.writeFileSync(h.selfPath, `${JSON.stringify({ type: 'session', id: 'self-id' })}\n${JSON.stringify({ type: 'message', message: { role: 'user', content: 'edited request' } })}\n`);
    const rewrittenBranch = await h.tool.execute('close-rewritten', { action: 'closeSelf', confirmSelf: true }, undefined, undefined, h.ctx);
    assert.equal(rewrittenBranch.isError, true);
    assert.equal(fs.existsSync(path.join(h.dir, 'closure-actions.jsonl')), false);
  } finally { h.cleanup(); }
});

test('a malformed complete transcript append invalidates inherited close authority', async () => {
  const h = harness();
  try {
    await h.tool.execute('list', { action: 'listSelected' }, undefined, undefined, h.ctx);
    fs.appendFileSync(h.selfPath, '{malformed transcript entry}\n');

    const result = await h.tool.execute(
      'close-after-corruption',
      { action: 'closeSelf', confirmSelf: true },
      undefined,
      undefined,
      h.ctx,
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /listSelected/);
    assert.equal(fs.existsSync(path.join(h.dir, 'closure-actions.jsonl')), false);
  } finally { h.cleanup(); }
});

test('closeSelf requires listSelected plus current pinning and labels a running close as a hide', async () => {
  const h = harness();
  try {
    await h.tool.execute('list-open', { action: 'listOpen' }, undefined, undefined, h.ctx);
    const fromOpen = await h.tool.execute('close-from-open', { action: 'closeSelf', confirmSelf: true }, undefined, undefined, h.ctx);
    assert.equal(fromOpen.isError, true);
    assert.match(fromOpen.content[0].text, /listSelected/);

    await h.tool.execute('list-selected', { action: 'listSelected' }, undefined, undefined, h.ctx);
    h.setTabs({ selfPinned: false, revision: 2 });
    const unpinned = await h.tool.execute('close-unpinned', { action: 'closeSelf', confirmSelf: true }, undefined, undefined, h.ctx);
    assert.equal(unpinned.isError, true);

    h.setTabs({ selfPinned: true, selfRunning: true, revision: 3 });
    await h.tool.execute('relist-running', { action: 'listSelected' }, undefined, undefined, h.ctx);
    const hidden = await h.tool.execute('close-running', { action: 'closeSelf', confirmSelf: true }, undefined, undefined, h.ctx);
    assert.equal(hidden.isError, false, hidden.content[0].text);
    assert.equal(hidden.details.disposition, 'hide-running');
    assert.match(hidden.content[0].text, /only hides\/unpins.*does not interrupt/s);
  } finally { h.cleanup(); }
});
