import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialArchState } from '../../../../src/host/core/arch-state';
import type { ArchState } from '../../../../src/host/core/arch-state';
import { selectViewState } from '../../../../src/host/core/projection';

test('projection: draftText surfaces the active sessions persisted draft', () => {
  const state: ArchState = {
    ...createInitialArchState(),
    sessions: {
      ...createInitialArchState().sessions,
      activeSessionPath: '/session/a',
    },
    composer: {
      ...createInitialArchState().composer,
      draftTextBySession: {
        '/session/a': 'saved draft for a',
        '/session/b': 'saved draft for b',
      },
    },
  };

  const viewState = selectViewState(state);

  assert.equal(viewState.draftText, 'saved draft for a');
});

test('projection: draftText is empty when no active session', () => {
  const state: ArchState = {
    ...createInitialArchState(),
    composer: {
      ...createInitialArchState().composer,
      draftTextBySession: { '/session/a': 'saved draft' },
    },
  };

  const viewState = selectViewState(state);

  assert.equal(viewState.draftText, '');
});

test('projection: draftText falls back to empty string when active session has no draft', () => {
  const state: ArchState = {
    ...createInitialArchState(),
    sessions: {
      ...createInitialArchState().sessions,
      activeSessionPath: '/session/c',
    },
    composer: {
      ...createInitialArchState().composer,
      draftTextBySession: { '/session/a': 'saved draft' },
    },
  };

  const viewState = selectViewState(state);

  assert.equal(viewState.draftText, '');
});
