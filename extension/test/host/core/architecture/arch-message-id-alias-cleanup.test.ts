/**
 * Tests for the `messageIdAlias` memory-leak fix.
 *
 * Bug: `pending.messageIdAlias` was `Record<string, string>` keyed by message
 * ID with no `sessionPath`, so neither `handleSessionScopeCleared` nor the
 * (now-collapsed) `removeSessionFromState` could filter it by session. It grew
 * unboundedly over long sessions with multi-turn conversations.
 *
 * Fix: change the shape to `Record<string, { canonicalId: string; sessionPath:
 * string }>` (mirroring `requestIdToLocalId`) and clean it in both eviction
 * paths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';
import { evictSession, resolveAlias } from '../../../../src/host/core/reducer/helpers';

const readyState: ArchState = {
  ...initialArchState,
  settings: { ...initialArchState.settings, backendReady: true },
};

type AliasEntry = { canonicalId: string; sessionPath: string };

function sessionScopeCleared(sessionPath: string, removeSessionSummary: boolean): Event {
  return { kind: 'SessionScopeCleared', sessionPath, removeSessionSummary };
}

function messageStarted(
  sessionPath: string,
  messageId: string,
  requestId: string,
): Extract<Event, { kind: 'MessageStarted' }> {
  return {
    kind: 'MessageStarted',
    sessionPath,
    messageId,
    requestId,
    timestamp: 1,
  };
}

// ─── Test 1: handleSessionScopeCleared cleans messageIdAlias ────────────────

test('handleSessionScopeCleared cleans messageIdAlias for the closed session', () => {
  const state: ArchState = {
    ...readyState,
    pending: {
      ...readyState.pending,
      messageIdAlias: {
        'msg-1': { canonicalId: 'msg-0', sessionPath: '/a' } as AliasEntry as never,
        'msg-2': { canonicalId: 'msg-0b', sessionPath: '/b' } as AliasEntry as never,
      },
    },
  };
  const result = reducer(state, sessionScopeCleared('/a', false));
  assert.equal(result.state.pending.messageIdAlias['msg-1'], undefined);
  assert.deepEqual(
    result.state.pending.messageIdAlias['msg-2'],
    { canonicalId: 'msg-0b', sessionPath: '/b' } as never,
  );
});

// ─── Test 2: evictSession (full eviction) cleans messageIdAlias ─────────

test('evictSession (full eviction) cleans messageIdAlias for the evicted session', () => {
  const state: ArchState = {
    ...readyState,
    pending: {
      ...readyState.pending,
      messageIdAlias: {
        'msg-1': { canonicalId: 'msg-0', sessionPath: '/a' } as AliasEntry as never,
        'msg-2': { canonicalId: 'msg-0b', sessionPath: '/b' } as AliasEntry as never,
      },
    },
  };
  const result = evictSession(state, '/a', { removeSummary: true, removeTabs: true });
  assert.equal(result.state.pending.messageIdAlias['msg-1'], undefined);
  assert.deepEqual(
    result.state.pending.messageIdAlias['msg-2'],
    { canonicalId: 'msg-0b', sessionPath: '/b' } as never,
  );
});

// ─── Test 3: messageIdAlias write includes sessionPath ──────────────────────

test('messageIdAlias write includes sessionPath', () => {
  // Seed a currentTurn for /a so the next MessageStarted with the matching
  // requestId is treated as an alias (continuation) and writes to the map.
  const seed: ArchState = {
    ...readyState,
    pending: {
      ...readyState.pending,
      currentTurnBySession: {
        '/a': { requestId: 'req-1', firstMessageId: 'msg-0' },
      },
    },
  };

  // A MessageStarted with requestId === the current turn's requestId is an alias.
  const result = reducer(seed, messageStarted('/a', 'msg-9', 'req-1'));
  assert.deepEqual(
    result.state.pending.messageIdAlias['msg-9'],
    { canonicalId: 'msg-0', sessionPath: '/a' } as never,
  );
});

// ─── Test 4: resolveAlias reads the new shape ───────────────────────────────

test('messageIdAlias read returns canonicalId from the new shape', () => {
  const state: ArchState = {
    ...readyState,
    pending: {
      ...readyState.pending,
      messageIdAlias: {
        'msg-1': { canonicalId: 'msg-0', sessionPath: '/a' } as AliasEntry as never,
      },
    },
  };
  assert.equal(resolveAlias(state, 'msg-1'), 'msg-0');
  // Unaliased IDs pass through unchanged.
  assert.equal(resolveAlias(state, 'msg-2'), 'msg-2');
});

// ─── Test 5: Parity — both cleanup functions clean messageIdAlias ───────────

test('Parity — both cleanup functions clean messageIdAlias', () => {
  const base: ArchState = {
    ...readyState,
    pending: {
      ...readyState.pending,
      messageIdAlias: {
        'msg-a1': { canonicalId: 'msg-a0', sessionPath: '/a' } as AliasEntry as never,
        'msg-a2': { canonicalId: 'msg-a0', sessionPath: '/a' } as AliasEntry as never,
        'msg-b1': { canonicalId: 'msg-b0', sessionPath: '/b' } as AliasEntry as never,
      },
    },
  };

  const cleared = reducer(base, sessionScopeCleared('/a', true));
  const evicted = evictSession(base, '/a', { removeSummary: true, removeTabs: true });

  for (const [, entry] of Object.entries(cleared.state.pending.messageIdAlias)) {
    assert.notEqual(
      (entry as AliasEntry).sessionPath,
      '/a',
      'handleSessionScopeCleared left stale messageIdAlias referencing /a',
    );
  }
  for (const [, entry] of Object.entries(evicted.state.pending.messageIdAlias)) {
    assert.notEqual(
      (entry as AliasEntry).sessionPath,
      '/a',
      'evictSession left stale messageIdAlias referencing /a',
    );
  }

  // The /b entry survives both paths.
  assert.deepEqual(
    cleared.state.pending.messageIdAlias['msg-b1'],
    { canonicalId: 'msg-b0', sessionPath: '/b' } as never,
  );
  assert.deepEqual(
    evicted.state.pending.messageIdAlias['msg-b1'],
    { canonicalId: 'msg-b0', sessionPath: '/b' } as never,
  );
});
