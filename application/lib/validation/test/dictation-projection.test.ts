import assert from 'node:assert/strict';
import test from 'node:test';

import { dictationForRenderer } from '../../protocol/dictation.js';
import { createDictationState, projectDictationView } from '../../../backend/dictation/state.js';

test('dictation projection exposes capture owner only while capture exists', () => {
  const idle = createDictationState();
  assert.equal('ownerRendererId' in projectDictationView(idle), false);
  const capturing = { ...idle, capture: {
    corrId: 'corr', rendererId: 'renderer-a', rendererGeneration: 1,
    prefix: '', selectedText: '', suffix: '', expectedAppliedDraft: '', sequence: 0, hadSpeech: false,
  } };
  assert.equal(projectDictationView(capturing).ownerRendererId, 'renderer-a');
  assert.equal('ownerRendererId' in projectDictationView({ ...capturing, capture: null }), false);
});

test('per-renderer dictation availability is a non-mutating projection', () => {
  const view = { ...projectDictationView({ ...createDictationState(), available: true }), ownerRendererId: 'renderer-a' };
  const remote = dictationForRenderer(view, 'renderer-b', false)!;
  const nonOwner = dictationForRenderer(view, 'renderer-b', true)!;
  const owner = dictationForRenderer(view, 'renderer-a', true)!;
  assert.equal(remote.available, false);
  assert.equal(nonOwner.available, false);
  assert.equal(owner.available, true);
  assert.equal(view.available, true);
  assert.notEqual(remote, view);
  assert.equal(owner, view);
});
