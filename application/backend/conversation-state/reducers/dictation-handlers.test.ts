import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialArchState, reducer } from '../reducer.js';
import { selectViewState } from '../projections/projection.js';
import type { Event } from '../events.js';
const identity = { corrId: 'c', recordingId: 'r', sessionPath: 'pending:test', rendererId: 'web', rendererGeneration: 1 };
function started() {
  let s = createInitialArchState();
  s = { ...s, sessions: { ...s.sessions, activeSessionPath: identity.sessionPath, openTabPaths: [identity.sessionPath] },
    composer: { ...s.composer, draftTextBySession: { [identity.sessionPath]: 'before OLD after' } } };
  s = reducer(s, { kind: 'DictationAvailabilityChanged', available: true }).state;
  const r = reducer(s, { kind: 'Command', cmd: { ...identity, kind: 'DictationStart', draftText: 'before OLD after', selectionStart: 7, selectionEnd: 10 } });
  assert.deepEqual(r.effects, [{ kind: 'DictationControl', action: 'start', recordingId: 'r' }]);
  return r.state;
}
function observed(sequence: number, text: string, final = false): Event {
  return { kind: 'DictationObserved', id: 'r', sequence, observation: { kind: 'transcript', text, final } };
}
test('levels are fenced, finite, recording-only and cleared on stop and terminal', () => {
  const level = (sequence: number, value: number, id = 'r'): Event => ({ kind: 'DictationObserved', id, sequence, observation: { kind: 'level', level: value } });
  let s = started();
  assert.equal(reducer(s, level(1, 0.5)).state, s);
  s = reducer(s, { kind: 'DictationObserved', id: 'r', sequence: 1, observation: { kind: 'status', phase: 'recording' } }).state;
  for (const value of [NaN, Infinity, -1, 1.1]) assert.equal(reducer(s, level(2, value)).state, s);
  assert.equal(reducer(s, level(2, 1, 'stale')).state, s);
  const r = reducer(s, level(2, 0));
  assert.equal(r.state.dictation.audioLevel, 0);
  assert.equal(r.state.composer, s.composer); assert.deepEqual(r.effects, []);
  s = r.state;
  assert.equal(reducer(s, level(2, 1)).state, s);
  s = reducer(s, { kind: 'Command', cmd: { ...identity, kind: 'DictationStop' } }).state;
  assert.equal(s.dictation.audioLevel, undefined);
  assert.equal(reducer(s, level(3, 1)).state, s);
  s = reducer(s, observed(3, '', true)).state;
  assert.equal(s.dictation.audioLevel, undefined);
  assert.equal(reducer(s, level(4, 1)).state, s);
});
test('revisions replace captured region; stale and terminal observations are inert', () => {
  let s = started();
  s = reducer(s, observed(1, 'hello')).state;
  assert.equal(selectViewState(s).draftText, 'before hello after');
  assert.equal(reducer(s, observed(1, 'stale')).state, s);
  s = reducer(s, observed(2, 'world', true)).state;
  assert.equal(selectViewState(s).draftText, 'before world after');
  assert.equal(reducer(s, observed(3, 'late')).state, s);
});
test('initial empty restores selection, empty after speech removes voice region', () => {
  assert.equal(selectViewState(reducer(started(), observed(1, '', true)).state).draftText, 'before OLD after');
  const s = reducer(started(), observed(1, 'voice')).state;
  assert.equal(selectViewState(reducer(s, observed(2, '', true)).state).draftText, 'before  after');
});
test('manual editing cancels without overwriting; stop duplicate is inert', () => {
  let s = started();
  s = reducer(s, { kind: 'Command', cmd: { ...identity, kind: 'DictationStop' } }).state;
  assert.equal(reducer(s, { kind: 'Command', cmd: { ...identity, kind: 'DictationStop' } }).state, s);
  const r = reducer(s, { kind: 'Command', cmd: { kind: 'SetComposerDraft', corrId: 'edit', sessionPath: identity.sessionPath, text: 'manual' } });
  assert.equal(selectViewState(r.state).draftText, 'manual');
  assert.equal(r.effects.at(-1)?.kind, 'DictationControl');
  assert.equal(reducer(r.state, observed(10, 'late')).state, r.state);
});
test('renderer fencing and pending rekey preserve ownership; selection cancels', () => {
  let s = started();
  assert.equal(reducer(s, { kind: 'DictationRendererInvalidated', rendererId: 'web', rendererGeneration: 0 }).state, s);
  s = reducer(s, { kind: 'PendingPathReplaced', oldPendingPath: identity.sessionPath, newSessionPath: 'real' }).state;
  assert.equal(s.dictation.sessionPath, 'real');
  assert.ok(s.dictation.capture);
  s = reducer(s, observed(1, 'voice')).state;
  assert.equal(s.composer.draftTextBySession.real, 'before voice after');
  const r = reducer(s, { kind: 'OpenTabsChanged', openTabPaths: [], pinnedTabPaths: [], pinnedTabGroups: [] });
  assert.equal(r.state.dictation.capture, null);
});
test('a stop routed with the pending path still targets the rekeyed capture', () => {
  let s = reducer(started(), { kind: 'PendingPathReplaced', oldPendingPath: identity.sessionPath, newSessionPath: 'real' }).state;
  const stalePathStop = { ...identity, kind: 'DictationStop' as const };
  for (const wrong of [
    { ...stalePathStop, recordingId: 'other' },
    { ...stalePathStop, rendererId: 'other' },
    { ...stalePathStop, rendererGeneration: 2 },
  ]) assert.equal(reducer(s, { kind: 'Command', cmd: wrong }).state, s);

  const stopped = reducer(s, { kind: 'Command', cmd: stalePathStop });
  assert.equal(stopped.state.dictation.phase, 'finalizing');
  assert.deepEqual(stopped.effects, [{ kind: 'DictationControl', action: 'stop', recordingId: 'r' }]);
  s = reducer(stopped.state, observed(1, 'voice', true)).state;
  assert.equal(s.composer.draftTextBySession.real, 'before voice after');
  assert.equal(s.composer.draftTextBySession[identity.sessionPath], undefined);
});
test('a tab change cancels capture; a later cancel command is inert', () => {
  const s = started();
  const changed = reducer(s, { kind: 'OpenTabsChanged', openTabPaths: [], pinnedTabPaths: [], pinnedTabGroups: [] });
  assert.equal(changed.state.dictation.capture, null);
  const lateCancel = reducer(changed.state, { kind: 'Command', cmd: { ...identity, kind: 'DictationCancel' } });
  assert.equal(lateCancel.state, changed.state);
  assert.deepEqual(lateCancel.effects, []);
});
test('backend loss is independent; matching owner invalidation preserves preview', () => {
  let s = reducer(started(), observed(1, 'voice')).state;
  s = reducer(s, { kind: 'BackendReadyChanged', ready: false }).state;
  assert.ok(s.dictation.capture);
  const r = reducer(s, { kind: 'DictationRendererInvalidated', rendererId: 'web', rendererGeneration: 1 });
  assert.equal(r.state.dictation.capture, null);
  assert.equal(selectViewState(r.state).draftText, 'before voice after');
  assert.deepEqual(r.effects, [{ kind: 'DictationControl', action: 'cancel', recordingId: 'r' }]);
});
test('start is fenced by availability, active/open path, draft and selection', () => {
  const cmd = { ...identity, kind: 'DictationStart' as const, draftText: 'before OLD after', selectionStart: 7, selectionEnd: 10 };
  const fresh = createInitialArchState();
  assert.equal(reducer(fresh, { kind: 'Command', cmd }).state, fresh);
  const completed = reducer(started(), observed(1, '', true)).state;
  for (const bad of [{ ...cmd, sessionPath: 'other' }, { ...cmd, selectionEnd: 100 }, { ...cmd, draftText: 'stale' }]) {
    assert.equal(reducer(completed, { kind: 'Command', cmd: bad }).state, completed);
  }
});
test('error preserves preview and availability busts projection memoization', () => {
  let s = started();
  s = reducer(s, observed(1, 'preview')).state;
  s = reducer(s, { kind: 'DictationObserved', id: 'r', sequence: 2, observation: { kind: 'error', message: 'failed' } }).state;
  assert.equal(selectViewState(s).draftText, 'before preview after');
  assert.equal(s.dictation.error, 'failed');
  const before = selectViewState(s);
  const after = selectViewState(reducer(s, { kind: 'DictationAvailabilityChanged', available: false }).state);
  assert.notEqual(before, after);
});
