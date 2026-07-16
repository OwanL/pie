/**
 * Reducer-level tests for the `SetModel` MVI migration.
 *
 * The reducer now owns: the open/pending guard (relocated from the service),
 * the modal-needed decision (pure ArchState read), the optimistic apply
 * (global default + per-session model badge + context-usage clear + pending
 * image clear), and the rollback on `SetModelResult{ok:false}`. The modal is a
 * `ShowModelSwitchConfirm` Effect branched on via `ModelSwitchConfirmResult`.
 *
 * These tests pin the behavior that the old service-owned path got wrong:
 *  - an invalid (closed/pending/missing) session must NOT leave an optimistic
 *    `modelSettings` change un-reverted;
 *  - a modal "Cancel" must leave all state untouched (the old path applied
 *    optimistically before the modal and never reverted on abort).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';
import type { ModelInfo, ComposerInput, ContextWindowUsage, ThinkingLevel } from '../../../../src/shared/protocol';

const SESSION = '/s';

const TEXT_ONLY_MODEL: ModelInfo = {
  id: 'text-only', name: 'Text', provider: 'p', reasoning: false, inputKinds: ['text'], contextWindow: 200000,
};
const IMAGE_MODEL: ModelInfo = {
  id: 'image-model', name: 'Img', provider: 'p', reasoning: false, inputKinds: ['text', 'image'], contextWindow: 1000000,
};
const IMAGE_INPUT: ComposerInput = {
  id: 'img1', kind: 'imageBlob', mimeType: 'image/png', name: 'a.png', sizeBytes: 10, dataBase64: 'AAAA', source: 'paste',
};
const FILE_REF_INPUT: ComposerInput = {
  id: 'f1', kind: 'filesystemPathRef', path: '/w/file.ts', name: 'file.ts', source: 'picker',
};
const USAGE: ContextWindowUsage = { tokens: 100, contextWindow: 200000, percent: 0.0005 };

interface BuildOpts {
  openTabs?: string[];
  sessionModelId?: string;
  pendingImages?: boolean;
  pendingInputs?: ComposerInput[];
  contextUsage?: ContextWindowUsage | null;
  availableModels?: ModelInfo[];
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
}

function buildState(opts: BuildOpts = {}): ArchState {
  const openTabs = opts.openTabs ?? [SESSION];
  const hasUsage = opts.contextUsage !== undefined;
  return {
    ...initialArchState,
    settings: {
      ...initialArchState.settings,
      modelSettings: {
        defaultModel: opts.defaultModel ?? 'old-model',
        defaultThinkingLevel: opts.defaultThinkingLevel ?? 'medium',
      },
      availableModelsBySession: { [SESSION]: opts.availableModels ?? [TEXT_ONLY_MODEL, IMAGE_MODEL] },
      contextUsageBySession: hasUsage ? { [SESSION]: opts.contextUsage as ContextWindowUsage | null } : {},
    },
    sessions: {
      ...initialArchState.sessions,
      sessions: [{
        path: SESSION, name: 'S', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 0,
        modelId: opts.sessionModelId ?? 'old-model', thinkingLevel: 'medium',
      }],
      openTabPaths: openTabs,
      activeSessionPath: SESSION,
    },
    composer: {
      ...initialArchState.composer,
      pendingComposerInputsBySession: opts.pendingInputs
        ? { [SESSION]: opts.pendingInputs }
        : opts.pendingImages
          ? { [SESSION]: [IMAGE_INPUT] }
          : {},
    },
  };
}

function cmd(
  corrId: string,
  defaultModel: string,
  sessionPath: string = SESSION,
  thinkingLevel: ThinkingLevel = 'high',
  defaultProvider?: string,
): Event {
  return {
    kind: 'Command',
    cmd: {
      kind: 'SetModel',
      corrId,
      sessionPath,
      modelSettings: {
        defaultModel,
        ...(defaultProvider !== undefined && { defaultProvider }),
        defaultThinkingLevel: thinkingLevel,
      },
    },
  };
}

function confirm(corrId: string, confirmed: boolean): Event {
  return { kind: 'ModelSwitchConfirmResult', corrId, confirmed };
}

function result(corrId: string, ok: boolean, error?: string): Event {
  return { kind: 'SetModelResult', corrId, sessionPath: SESSION, ok, error };
}

function reduceFrom(state: ArchState, ...events: Event[]): ArchState {
  let s = state;
  for (const e of events) s = reducer(s, e).state;
  return s;
}

// ─── SessionOpened must not revert an in-flight SetModel ─────────────────────

test('SessionOpened does not clobber an in-flight optimistic SetModel (global default + per-session badge)', () => {
  // User picks a new model; the reducer applies it optimistically and records
  // the pending SetModel (SetModelRpc is still in flight).
  const afterSet = reduceFrom(buildState({ defaultModel: 'old-model', sessionModelId: 'old-model' }),
    cmd('c1', 'new-model', SESSION, 'high', 'openai-codex'));
  assert.equal(afterSet.settings.modelSettings?.defaultModel, 'new-model');
  assert.equal(afterSet.sessions.sessions.find((s) => s.path === SESSION)?.modelId, 'new-model');
  assert.equal(afterSet.sessions.sessions.find((s) => s.path === SESSION)?.provider, 'openai-codex');
  assert.ok(afterSet.pending.setModelByCorrId.c1, 'pending SetModel entry should exist');

  // A stale session.opened arrives before settings.set commits: its
  // modelSettings + per-session badge still reflect the PRE-switch state.
  const staleOpened: Event = {
    kind: 'SessionOpened',
    sessionPath: SESSION,
    payload: {
      session: { path: SESSION, name: 'S', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 0, modelId: 'old-model', thinkingLevel: 'medium' },
      transcript: [],
      transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
      busy: false,
      modelSettings: { defaultModel: 'old-model', defaultThinkingLevel: 'medium' },
    },
  };
  const afterOpened = reduceFrom(afterSet, staleOpened);

  // The in-flight SetModel owns the model state — the stale snapshot must not
  // revert the global default or the per-session badge.
  assert.equal(afterOpened.settings.modelSettings?.defaultModel, 'new-model',
    'global modelSettings must keep the in-flight optimistic model, not the stale payload');
  assert.equal(afterOpened.sessions.sessions.find((s) => s.path === SESSION)?.modelId, 'new-model',
    'per-session badge must keep the in-flight optimistic model, not the stale payload');
  assert.equal(afterOpened.sessions.sessions.find((s) => s.path === SESSION)?.thinkingLevel, 'high');
  // The pending entry is untouched (SetModelResult will still reconcile it).
  assert.ok(afterOpened.pending.setModelByCorrId.c1);
});

test('SessionOpened applies payload modelSettings when no SetModel is in flight (hydration path preserved)', () => {
  // No pending SetModel: the payload's modelSettings is the authoritative
  // hydration from settings.json and must be applied (regression guard for
  // the in-flight guard above being too aggressive).
  const base = buildState({ defaultModel: 'old-model', sessionModelId: 'old-model' });
  const opened: Event = {
    kind: 'SessionOpened',
    sessionPath: SESSION,
    payload: {
      session: { path: SESSION, name: 'S', cwd: '/w', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 0, modelId: 'hydrated-model', thinkingLevel: 'low' },
      transcript: [],
      transcriptWindow: { totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false, isPartial: false, hasUserMessages: false },
      busy: false,
      modelSettings: { defaultModel: 'hydrated-model', defaultThinkingLevel: 'low' },
    },
  };
  const after = reduceFrom(base, opened);
  assert.equal(after.settings.modelSettings?.defaultModel, 'hydrated-model');
  assert.equal(after.sessions.sessions.find((s) => s.path === SESSION)?.modelId, 'hydrated-model');
  assert.equal(after.sessions.sessions.find((s) => s.path === SESSION)?.thinkingLevel, 'low');
});

// ─── Guard (relocated from service) ─────────────────────────────────────────

test('SetModel for a missing session reference sets a notice and changes nothing', () => {
  const state = buildState();
  const out = reducer(state, cmd('c1', 'text-only', ''));

  assert.equal(out.state.settings.notice, 'Cannot set model: missing session reference.');
  assert.deepEqual(out.effects, []);
  // No optimistic apply — the old bug flipped the global default even here.
  assert.equal(out.state.settings.modelSettings?.defaultModel, 'old-model');
  assert.deepEqual(out.state.pending.setModelByCorrId, {});
});

test('SetModel for a closed session sets a notice and does NOT optimistically flip the model', () => {
  const state = buildState({ openTabs: [] });
  const out = reducer(state, cmd('c1', 'text-only'));

  assert.equal(out.state.settings.notice, 'Cannot set model: the selected session is no longer open.');
  assert.deepEqual(out.effects, []);
  assert.equal(out.state.settings.modelSettings?.defaultModel, 'old-model');
  assert.deepEqual(out.state.pending.setModelByCorrId, {});
});

test('SetModel for a still-opening (pending) session sets a notice and changes nothing', () => {
  const state = buildState({ openTabs: ['__pending__:1-a'] });
  const out = reducer(state, cmd('c1', 'text-only', '__pending__:1-a'));

  assert.equal(out.state.settings.notice, 'Cannot set model: the session is still opening.');
  assert.deepEqual(out.effects, []);
  assert.equal(out.state.settings.modelSettings?.defaultModel, 'old-model');
});

// ─── No-modal path: optimistic apply + SetModelRpc ──────────────────────────

test('SetModel with no pending images applies optimistically and emits SetModelRpc', () => {
  const state = buildState();
  const out = reducer(state, cmd('c1', 'image-model'));

  // Global default + per-session badge flip instantly.
  assert.equal(out.state.settings.modelSettings?.defaultModel, 'image-model');
  assert.equal(out.state.settings.modelSettings?.defaultThinkingLevel, 'high');
  assert.equal(out.state.sessions.sessions.find((s) => s.path === SESSION)?.modelId, 'image-model');
  assert.equal(out.state.sessions.sessions.find((s) => s.path === SESSION)?.thinkingLevel, 'high');
  // Context usage left untouched across the switch (the backend re-emits a
  // fresh reading immediately after setModel).
  assert.equal(out.state.settings.contextUsageBySession[SESSION], undefined);
  // Rollback snapshot recorded.
  assert.equal(out.state.pending.setModelByCorrId['c1']?.snapshot?.previousModelSettings?.defaultModel, 'old-model');
  assert.deepEqual(out.effects, [{ kind: 'SetModelRpc', corrId: 'c1', sessionPath: SESSION, modelSettings: { defaultModel: 'image-model', defaultThinkingLevel: 'high' } }]);
});

test('SetModel to an image-capable model with pending images applies without a modal (no clear)', () => {
  const state = buildState({ pendingImages: true });
  const out = reducer(state, cmd('c1', 'image-model'));

  assert.equal(out.state.settings.modelSettings?.defaultModel, 'image-model');
  // Pending images are preserved — the new model still accepts them.
  assert.equal(out.state.composer.pendingComposerInputsBySession[SESSION]?.length, 1);
  assert.equal(out.effects[0]?.kind, 'SetModelRpc');
});

test('SetModel is a no-op when the requested model settings already match state and session summary', () => {
  const base = buildState({
    defaultModel: 'image-model',
    defaultThinkingLevel: 'high',
    sessionModelId: 'image-model',
  });
  const state: ArchState = {
    ...base,
    sessions: {
      ...base.sessions,
      sessions: [{
        ...base.sessions.sessions[0],
        thinkingLevel: 'high',
      }],
    },
  };
  const out = reducer(state, cmd('c1', 'image-model', SESSION, 'high'));

  assert.deepEqual(out.state, state);
  assert.deepEqual(out.effects, []);
});

// ─── Modal path: ShowModelSwitchConfirm gates the optimistic apply ────────────

test('SetModel that would drop pending images emits ShowModelSwitchConfirm and changes nothing', () => {
  const state = buildState({ pendingImages: true });
  const out = reducer(state, cmd('c1', 'text-only'));

  // Nothing applied yet — the user has not confirmed.
  assert.equal(out.state.settings.modelSettings?.defaultModel, 'old-model');
  assert.equal(out.state.sessions.sessions.find((s) => s.path === SESSION)?.modelId, 'old-model');
  assert.equal(out.state.composer.pendingComposerInputsBySession[SESSION]?.length, 1);
  // Stashed intent with no snapshot (nothing to roll back yet).
  assert.equal(out.state.pending.setModelByCorrId['c1']?.snapshot, null);
  assert.equal(out.state.pending.setModelByCorrId['c1']?.modelSettings.defaultModel, 'text-only');
  assert.deepEqual(out.effects, [{
    kind: 'ShowModelSwitchConfirm',
    corrId: 'c1',
    sessionPath: SESSION,
    modelSettings: { defaultModel: 'text-only', defaultThinkingLevel: 'high' },
    message: 'Switching to this model will remove pending pasted images because it does not support image inputs.',
    confirmChoice: 'Switch Model',
  }]);
});

test('ModelSwitchConfirmResult{confirmed} applies optimistically, clears images, emits SetModelRpc', () => {
  const state = reduceFrom(buildState({ pendingImages: true }), cmd('c1', 'text-only'));
  const out = reducer(state, confirm('c1', true));

  assert.equal(out.state.settings.modelSettings?.defaultModel, 'text-only');
  assert.equal(out.state.sessions.sessions.find((s) => s.path === SESSION)?.modelId, 'text-only');
  assert.equal(out.state.settings.contextUsageBySession[SESSION], undefined);
  // Pending images cleared on confirm.
  assert.equal(out.state.composer.pendingComposerInputsBySession[SESSION], undefined);
  // Snapshot now present (for rollback of the apply that just happened).
  assert.notEqual(out.state.pending.setModelByCorrId['c1']?.snapshot, null);
  assert.deepEqual(out.effects, [{ kind: 'SetModelRpc', corrId: 'c1', sessionPath: SESSION, modelSettings: { defaultModel: 'text-only', defaultThinkingLevel: 'high' } }]);
});

test('ModelSwitchConfirmResult{!confirmed} (Cancel) drops the intent and leaves all state untouched', () => {
  const state = reduceFrom(buildState({ pendingImages: true }), cmd('c1', 'text-only'));
  const out = reducer(state, confirm('c1', false));

  assert.equal(out.state.settings.modelSettings?.defaultModel, 'old-model');
  assert.equal(out.state.sessions.sessions.find((s) => s.path === SESSION)?.modelId, 'old-model');
  assert.equal(out.state.composer.pendingComposerInputsBySession[SESSION]?.length, 1);
  assert.deepEqual(out.state.pending.setModelByCorrId, {});
  assert.deepEqual(out.effects, []);
});

test('ModelSwitchConfirmResult for an unknown corrId is a no-op', () => {
  const state = buildState();
  const out = reducer(state, confirm('nope', true));

  assert.deepEqual(out.state, state);
  assert.deepEqual(out.effects, []);
});

// ─── SetModelResult: success clears the snapshot; failure reverts ─────────────

test('SetModelResult{ok:true} drops the rollback snapshot and retains the new model', () => {
  const state = reduceFrom(buildState({ pendingImages: true }), cmd('c1', 'text-only'), confirm('c1', true));
  const out = reducer(state, result('c1', true));

  assert.deepEqual(out.state.pending.setModelByCorrId, {});
  assert.equal(out.state.settings.modelSettings?.defaultModel, 'text-only');
  assert.equal(out.state.composer.pendingComposerInputsBySession[SESSION], undefined);
  assert.deepEqual(out.effects, []);
});

test('SetModelResult{ok:false} reverts the optimistic apply field-for-field and surfaces a notice', () => {
  // Full lifecycle: pending images + text-only target → modal → confirm (apply
  // + clear images + SetModelRpc) → backend failure reverts everything.
  const state = reduceFrom(
    buildState({ pendingImages: true, contextUsage: USAGE }),
    cmd('c1', 'text-only'),
    confirm('c1', true),
  );
  const out = reducer(state, result('c1', false, 'backend down'));

  // Global default + per-session badge restored.
  assert.equal(out.state.settings.modelSettings?.defaultModel, 'old-model');
  assert.equal(out.state.settings.modelSettings?.defaultThinkingLevel, 'medium');
  assert.equal(out.state.sessions.sessions.find((s) => s.path === SESSION)?.modelId, 'old-model');
  assert.equal(out.state.sessions.sessions.find((s) => s.path === SESSION)?.thinkingLevel, 'medium');
  // Context usage restored (not null).
  assert.deepEqual(out.state.settings.contextUsageBySession[SESSION], USAGE);
  // Pending images restored.
  assert.equal(out.state.composer.pendingComposerInputsBySession[SESSION]?.length, 1);
  assert.equal(out.state.composer.pendingComposerInputsBySession[SESSION]?.[0]?.kind, 'imageBlob');
  // Notice surfaced; pending entry dropped.
  assert.equal(out.state.settings.notice, 'Failed to set model: backend down');
  assert.deepEqual(out.state.pending.setModelByCorrId, {});
  assert.deepEqual(out.effects, []);
});

test('SetModelResult{ok:false} restores an absent context-usage key by deleting it', () => {
  // No contextUsage key initially; optimistic apply leaves it absent (it does
  // not null it); revert deletes the (already absent) key.
  const state = reduceFrom(buildState({ pendingImages: false }), cmd('c1', 'image-model'));
  assert.equal(state.settings.contextUsageBySession[SESSION], undefined); // applied -> absent
  const out = reducer(state, result('c1', false, 'boom'));

  assert.equal(SESSION in out.state.settings.contextUsageBySession, false);
  assert.equal(out.state.settings.modelSettings?.defaultModel, 'old-model');
});

test('SetModelResult for an unknown corrId is a no-op', () => {
  const state = buildState();
  const out = reducer(state, result('nope', true));

  assert.deepEqual(out.state, state);
  assert.deepEqual(out.effects, []);
});

test('SetModelResult{ok:false} with no snapshot (no optimistic apply) just notifies + drops', () => {
  // Defensive: a result arriving while the entry still has snapshot===null
  // (modal not yet confirmed) should not crash and should not revert anything.
  const state = reduceFrom(buildState({ pendingImages: true }), cmd('c1', 'text-only'));
  assert.equal(state.pending.setModelByCorrId['c1']?.snapshot, null);
  const out = reducer(state, result('c1', false, 'late'));

  assert.equal(out.state.settings.modelSettings?.defaultModel, 'old-model');
  assert.equal(out.state.settings.notice, 'Failed to set model: late');
  assert.deepEqual(out.state.pending.setModelByCorrId, {});
});

// ─── Edge cases flagged by review ─────────────────────────────────────────────

test('SetModelResult{ok:false} on the no-modal path preserves pending file-ref inputs (no data loss)', () => {
  // Regression guard: the optimistic apply must snapshot pending inputs
  // unconditionally, so a backend failure on the no-modal path (which never
  // touched the inputs) restores them instead of deleting them.
  const applied = reduceFrom(buildState({ pendingInputs: [FILE_REF_INPUT] }), cmd('c1', 'image-model'));
  // No-modal apply: image-model still supports images, so inputs are untouched.
  assert.deepEqual(applied.composer.pendingComposerInputsBySession[SESSION], [FILE_REF_INPUT]);

  const out = reducer(applied, result('c1', false, 'boom'));
  // File refs preserved (NOT deleted); global default reverted.
  assert.deepEqual(out.state.composer.pendingComposerInputsBySession[SESSION], [FILE_REF_INPUT]);
  assert.equal(out.state.settings.modelSettings?.defaultModel, 'old-model');
});

test('SessionScopeCleared drops an in-flight setModel so a late failure result does not pollute the closed session', () => {
  const applied = reduceFrom(buildState({ contextUsage: USAGE }), cmd('c1', 'image-model'));
  assert.notEqual(applied.pending.setModelByCorrId['c1'], undefined);
  assert.deepEqual(applied.settings.contextUsageBySession[SESSION], USAGE); // preserved across apply

  const cleared = reducer(applied, { kind: 'SessionScopeCleared', sessionPath: SESSION, removeSessionSummary: true });
  // Entry dropped; session-scoped state cleared.
  assert.deepEqual(cleared.state.pending.setModelByCorrId, {});
  assert.equal(SESSION in cleared.state.settings.contextUsageBySession, false);
  assert.equal(cleared.state.sessions.sessions.find((s) => s.path === SESSION), undefined);

  // Late failure result is a no-op: no summary re-push, no orphan contextUsage
  // key, no notice.
  const out = reducer(cleared.state, result('c1', false, 'late'));
  assert.deepEqual(out.state.pending.setModelByCorrId, {});
  assert.equal(SESSION in out.state.settings.contextUsageBySession, false);
  assert.equal(out.state.sessions.sessions.find((s) => s.path === SESSION), undefined);
  assert.equal(out.state.settings.notice, null);
});

test('SetModel apply with no per-session summary flips only the global default; revert does not fabricate a summary', () => {
  const noSummary: ArchState = { ...buildState(), sessions: { ...buildState().sessions, sessions: [] } };
  const applied = reducer(noSummary, cmd('c1', 'image-model'));
  assert.equal(applied.state.settings.modelSettings?.defaultModel, 'image-model');
  // No summary to update; snapshot captured previousSummary === null.
  assert.equal(applied.state.pending.setModelByCorrId['c1']?.snapshot?.previousSummary, null);

  const out = reducer(applied.state, result('c1', false, 'boom'));
  assert.equal(out.state.settings.modelSettings?.defaultModel, 'old-model');
  assert.deepEqual(out.state.sessions.sessions, []); // no fabricated summary
});

test('concurrent setModels with distinct corrIds reconcile independently (entries do not cross-contaminate)', () => {
  const state = buildState();
  const a = reducer(state, cmd('a', 'image-model'));
  const b = reducer(a.state, cmd('b', 'text-only'));
  // Both in-flight, distinct corrIds.
  assert.notEqual(b.state.pending.setModelByCorrId['a'], undefined);
  assert.notEqual(b.state.pending.setModelByCorrId['b'], undefined);

  // A fails: A's entry is dropped, B's entry is untouched.
  const aFail = reducer(b.state, result('a', false, 'boom'));
  assert.equal(aFail.state.pending.setModelByCorrId['a'], undefined);
  assert.notEqual(aFail.state.pending.setModelByCorrId['b'], undefined);

  // B succeeds: B's entry is dropped.
  const bOk = reducer(aFail.state, result('b', true));
  assert.deepEqual(bOk.state.pending.setModelByCorrId, {});
});