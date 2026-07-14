/**
 * Reducer-level tests for the `AddFilesystemPaths` MVI migration (the LAST
 * Phase 2 method-orchestration-lift).
 *
 * The reducer owns the composer-input append (pure): for each path, creates a
 * `filesystemPathRef` input (ID from `corrId:index`, name from `path.basename`),
 * checks for duplicates against existing inputs, skips duplicates + empty
 * paths, appends to `pendingComposerInputsBySession[sessionPath]`. No Effect —
 * there is no backend RPC for this op (purely a composer-input mutation). The
 * host-side entry (`service.addFilesystemPaths`) resolves the target session
 * (possibly via `createNewSession()`) + cleans the paths BEFORE dispatching the
 * Command.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { reducer, initialArchState, type ArchState } from '../../../../src/host/core/reducer';
import type { Event } from '../../../../src/host/core/events';
import type { ComposerInput, FilesystemPathComposerInput } from '../../../../src/shared/protocol';

function fsInput(input: ComposerInput | undefined): FilesystemPathComposerInput {
  assert.equal(input?.kind, 'filesystemPathRef');
  return input as FilesystemPathComposerInput;
}

const SESSION = '/workspace/session.jsonl';

function buildState(existingInputs: Record<string, ComposerInput[]> = {}): ArchState {
  return {
    ...initialArchState,
    composer: {
      ...initialArchState.composer,
      pendingComposerInputsBySession: existingInputs,
    },
  };
}

function addCmd(corrId: string, sessionPath: string, paths: string[], source: 'picker' | 'drop' = 'picker'): Event {
  return { kind: 'Command', cmd: { kind: 'AddFilesystemPaths', corrId, sessionPath, paths, source } };
}

test('AddFilesystemPaths appends filesystemPathRef inputs with IDs from corrId + index and names from basename', () => {
  const out = reducer(buildState(), addCmd('c1', SESSION, ['/a/file.ts', '/b/dir']));

  assert.deepEqual(out.effects, []);
  const inputs = out.state.composer.pendingComposerInputsBySession[SESSION];
  assert.equal(inputs?.length, 2);
  assert.equal(inputs?.[0]?.kind, 'filesystemPathRef');
  assert.equal(inputs?.[0]?.id, 'c1:input:0');
  assert.equal(fsInput(inputs?.[0]).path, '/a/file.ts');
  assert.equal(inputs?.[0]?.name, 'file.ts');
  assert.equal(inputs?.[0]?.source, 'picker');
  assert.equal(inputs?.[1]?.kind, 'filesystemPathRef');
  assert.equal(inputs?.[1]?.id, 'c1:input:1');
  assert.equal(fsInput(inputs?.[1]).path, '/b/dir');
  assert.equal(inputs?.[1]?.name, 'dir');
});

test('AddFilesystemPaths preserves existing inputs and appends after them', () => {
  const existing: ComposerInput[] = [
    { id: 'old-1', kind: 'filesystemPathRef', path: '/old.ts', name: 'old.ts', source: 'picker' },
  ];
  const out = reducer(buildState({ [SESSION]: existing }), addCmd('c2', SESSION, ['/new.ts']));

  const inputs = out.state.composer.pendingComposerInputsBySession[SESSION];
  assert.equal(inputs?.length, 2);
  assert.equal(inputs?.[0]?.id, 'old-1');
  assert.equal(inputs?.[1]?.id, 'c2:input:0');
  assert.equal(fsInput(inputs?.[1]).path, '/new.ts');
});

test('AddFilesystemPaths skips duplicate paths (same path already in existing inputs)', () => {
  const existing: ComposerInput[] = [
    { id: 'old-1', kind: 'filesystemPathRef', path: '/dup.ts', name: 'dup.ts', source: 'picker' },
  ];
  const out = reducer(buildState({ [SESSION]: existing }), addCmd('c3', SESSION, ['/dup.ts', '/new.ts']));

  const inputs = out.state.composer.pendingComposerInputsBySession[SESSION];
  assert.equal(inputs?.length, 2);
  assert.equal(inputs?.[0]?.id, 'old-1');
  assert.equal(fsInput(inputs?.[0]).path, '/dup.ts');
  assert.equal(fsInput(inputs?.[1]).path, '/new.ts');
  // The duplicate was skipped — the new input is '/new.ts', not '/dup.ts'.
  assert.equal(inputs?.[1]?.id, 'c3:input:1');
});

test('AddFilesystemPaths skips duplicate paths within the same batch', () => {
  // The host-side entry dedups paths before dispatch, but the reducer should
  // also be robust (defense in depth).
  const out = reducer(buildState(), addCmd('c4', SESSION, ['/a.ts', '/a.ts', '/b.ts']));

  const inputs = out.state.composer.pendingComposerInputsBySession[SESSION];
  assert.equal(inputs?.length, 2);
  assert.equal(fsInput(inputs?.[0]).path, '/a.ts');
  assert.equal(fsInput(inputs?.[1]).path, '/b.ts');
});

test('AddFilesystemPaths skips empty/whitespace paths (the reducer is defensive — the host-side entry already filters them)', () => {
  const out = reducer(buildState(), addCmd('c5', SESSION, ['', '  ', '/real.ts']));

  const inputs = out.state.composer.pendingComposerInputsBySession[SESSION];
  assert.equal(inputs?.length, 1);
  assert.equal(fsInput(inputs?.[0]).path, '/real.ts');
});

test('AddFilesystemPaths with all duplicates or empty produces no state change', () => {
  const existing: ComposerInput[] = [
    { id: 'old-1', kind: 'filesystemPathRef', path: '/dup.ts', name: 'dup.ts', source: 'picker' },
  ];
  const state = buildState({ [SESSION]: existing });
  const out = reducer(state, addCmd('c6', SESSION, ['/dup.ts', '']));

  assert.deepEqual(out.state, state);
  assert.deepEqual(out.effects, []);
});

test('AddFilesystemPaths sets the source field on each input', () => {
  const out = reducer(buildState(), addCmd('c7', SESSION, ['/a.ts'], 'drop'));

  const inputs = out.state.composer.pendingComposerInputsBySession[SESSION];
  assert.equal(inputs?.[0]?.source, 'drop');
});

test('AddFilesystemPaths does not touch other sessions pendingComposerInputsBySession', () => {
  const otherInput: ComposerInput = { id: 'other-1', kind: 'filesystemPathRef', path: '/other.ts', name: 'other.ts', source: 'picker' };
  const state = buildState({ ['/other']: [otherInput] });
  const out = reducer(state, addCmd('c8', SESSION, ['/a.ts']));

  assert.deepEqual(out.state.composer.pendingComposerInputsBySession['/other'], [otherInput]);
  assert.equal(out.state.composer.pendingComposerInputsBySession[SESSION]?.length, 1);
});
