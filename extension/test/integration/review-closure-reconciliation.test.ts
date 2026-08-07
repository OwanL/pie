import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { applySessionReviews } from '../../src/backend/session-metadata';
import { createInitialArchState, type ArchState } from '../../src/host/core/arch-state';
import { reducer } from '../../src/host/core/reducer';
import { SessionServiceState } from '../../src/host/session-service/state';
import { REVIEW_CLOSURE_ACTIONS_FILE, type ClosureAction } from '../../src/shared/protocol';

function createHostState(getArchState: () => ArchState): SessionServiceState {
  return new SessionServiceState(
    { globalState: { update: async () => undefined }, workspaceState: { update: async () => undefined } } as any,
    { request: async () => ({}) } as any,
    () => undefined,
    getArchState,
    () => undefined,
    0,
  );
}

function latestOutboxAction(file: string): ClosureAction {
  const latest = new Map<string, ClosureAction>();
  for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
    const action = JSON.parse(line) as ClosureAction;
    latest.set(action.actionId, action);
  }
  return [...latest.values()][0]!;
}

test('preseeded catalog-absent closure is reclaimed after host restart and settles durably', () => {
  const reviewsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-review-reconcile-integration-'));
  const previous = process.env.PIE_REVIEWS_DIR;
  process.env.PIE_REVIEWS_DIR = reviewsDir;
  const targetPath = path.join(reviewsDir, 'removed-before-startup.jsonl');
  const outboxFile = path.join(reviewsDir, REVIEW_CLOSURE_ACTIONS_FILE);
  const pending: ClosureAction = {
    actionId: 'preseeded-action',
    kind: 'closeSelf',
    targetSessionId: 'removed-session',
    targetSessionPath: targetPath,
    status: 'pending',
    attempts: 0,
    requestedAt: '2026-07-24T00:00:00.000Z',
  };
  fs.writeFileSync(outboxFile, `${JSON.stringify(pending)}\n`, 'utf8');

  try {
    const startupSummaries = applySessionReviews([]);
    assert.equal(startupSummaries[0]?.path, targetPath, 'backend reconciliation exposes the absent target');

    let arch: ArchState = {
      ...createInitialArchState(),
      sessions: {
        ...createInitialArchState().sessions,
        sessions: startupSummaries,
        openTabPaths: [targetPath],
        activeSessionPath: targetPath,
      },
    };

    // Simulate a crash after the first host claimed the durable action but
    // before either close effect completed.
    const firstHost = createHostState(() => arch);
    assert.equal(firstHost.consumeReviewAutoCloseClosures(startupSummaries, [targetPath], []).attempts.length, 1);

    const restartedHost = createHostState(() => arch);
    const reclaimed = restartedHost.consumeReviewAutoCloseClosures(applySessionReviews([]), [targetPath], []);
    assert.equal(reclaimed.attempts.length, 1, 'a fresh host reclaims the preseeded pending action');
    restartedHost.beginReviewClosureAttempt('restart-close', reclaimed.attempts[0]!);

    const close = reducer(arch, {
      kind: 'Command',
      cmd: {
        kind: 'CloseSession',
        corrId: 'restart-close',
        sessionPath: targetPath,
        ensureClosed: true,
        reviewClosure: true,
      },
    });
    arch = close.state;
    assert.deepEqual(close.effects.map((effect) => effect.kind).sort(), ['CloseSession', 'PersistTabs']);

    restartedHost.handleReviewClosureEffectResult({
      kind: 'CloseSessionResult', corrId: 'restart-close', sessionPath: targetPath, ok: true,
    });
    restartedHost.handleReviewClosureEffectResult({
      kind: 'PersistTabsResult', corrId: 'restart-close', ok: true,
    });

    const settled = latestOutboxAction(outboxFile);
    assert.equal(settled.actionId, pending.actionId);
    assert.equal(settled.status, 'succeeded');
    assert.equal(settled.attempts, 1);
    assert.ok(settled.settledAt);
    assert.equal(fs.existsSync(path.join(reviewsDir, 'reviews.jsonl')), false, 'closure remains separate from review persistence');
  } finally {
    if (previous === undefined) delete process.env.PIE_REVIEWS_DIR;
    else process.env.PIE_REVIEWS_DIR = previous;
    fs.rmSync(reviewsDir, { recursive: true, force: true });
  }
});
