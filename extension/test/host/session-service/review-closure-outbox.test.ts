import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { createInitialArchState, type ArchState } from '../../../src/host/core/arch-state';
import { SessionServiceState } from '../../../src/host/session-service/state';
import type { ClosureAction } from '../../../src/shared/protocol';
import type { ReviewAutoCloseAttempt } from '../../../src/shared/review-auto-close';

function action(overrides: Partial<ClosureAction> = {}): ClosureAction {
  return {
    actionId: 'action-1',
    kind: 'closeSelf',
    targetSessionId: 'session-1',
    status: 'pending',
    attempts: 0,
    requestedAt: '2026-07-24T00:00:00.000Z',
    ...overrides,
  };
}

function createState(getArchState: () => ArchState): SessionServiceState {
  return new SessionServiceState(
    { globalState: { update: async () => undefined }, workspaceState: { update: async () => undefined } } as any,
    { request: async () => ({}) } as any,
    () => undefined,
    getArchState,
    () => undefined,
    0,
  );
}

async function withReviewsDir(run: (dir: string) => void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-review-closure-outbox-'));
  const previous = process.env.PIE_REVIEWS_DIR;
  process.env.PIE_REVIEWS_DIR = dir;
  try {
    run(dir);
  } finally {
    if (previous === undefined) delete process.env.PIE_REVIEWS_DIR;
    else process.env.PIE_REVIEWS_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readOutbox(dir: string): ClosureAction[] {
  return fs.readFileSync(path.join(dir, 'closure-actions.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line) as ClosureAction);
}

test('running closure succeeds after PersistTabs only and remains a hide', async () => {
  await withReviewsDir((dir) => {
    const sessionPath = '/running';
    const arch: ArchState = {
      ...createInitialArchState(),
      sessions: {
        ...createInitialArchState().sessions,
        openTabPaths: [],
        runningSessionPaths: [sessionPath],
      },
    };
    const state = createState(() => arch);
    const attempt: ReviewAutoCloseAttempt = {
      sessionPath,
      actions: [action()],
      requiresCloseCompletion: false,
    };
    state.beginReviewClosureAttempt('corr-running', attempt);
    state.handleReviewClosureEffectResult({ kind: 'PersistTabsResult', corrId: 'corr-running', ok: true });

    assert.equal(readOutbox(dir)[0]?.status, 'succeeded');
    assert.deepEqual(arch.sessions.runningSessionPaths, [sessionPath]);
  });
});

test('failed persistence writes retrying, releases the claim, and never writes a review', async () => {
  await withReviewsDir((dir) => {
    const sessionPath = '/idle';
    const arch = createInitialArchState();
    const state = createState(() => arch);
    const pending = action();
    const claimed = state.consumeReviewAutoCloseClosures(
      [{ path: sessionPath, closureActions: [pending] }],
      [sessionPath],
      [],
    );
    const attempt = claimed.attempts[0]!;
    state.beginReviewClosureAttempt('corr-fail', attempt);
    state.handleReviewClosureEffectResult({
      kind: 'CloseSessionResult', corrId: 'corr-fail', sessionPath, ok: true,
    });
    state.handleReviewClosureEffectResult({
      kind: 'PersistTabsResult', corrId: 'corr-fail', ok: false, error: 'disk full',
    });

    const retry = readOutbox(dir)[0]!;
    assert.equal(retry.status, 'retrying');
    assert.equal(retry.attempts, 1);
    assert.match(retry.lastError ?? '', /disk full/);
    assert.equal(fs.existsSync(path.join(dir, 'reviews.jsonl')), false);

    const next = state.consumeReviewAutoCloseClosures(
      [{ path: sessionPath, closureActions: [retry] }],
      [],
      [],
    );
    assert.equal(next.attempts.length, 1);
  });
});

test('a crash before effect completion leaves the durable pending action claimable by a new host state', async () => {
  await withReviewsDir(() => {
    const sessionPath = '/idle';
    const arch = createInitialArchState();
    const pending = action();
    const first = createState(() => arch);
    const claimed = first.consumeReviewAutoCloseClosures(
      [{ path: sessionPath, closureActions: [pending] }],
      [sessionPath],
      [],
    );
    first.beginReviewClosureAttempt('corr-crash', claimed.attempts[0]!);

    const restarted = createState(() => arch);
    const retry = restarted.consumeReviewAutoCloseClosures(
      [{ path: sessionPath, closureActions: [pending] }],
      [],
      [],
    );
    assert.equal(retry.attempts.length, 1);
  });
});
