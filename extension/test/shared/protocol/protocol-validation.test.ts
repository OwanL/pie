import test from 'node:test';
import assert from 'node:assert/strict';

import { validateWebviewToHostMessage } from '../../../src/shared/protocol-validation';

test('validateWebviewToHostMessage accepts the simple no-payload messages', () => {
  for (const type of ['ready', 'refreshState', 'requestSnapshot', 'openFilePicker', 'newSession']) {
    const result = validateWebviewToHostMessage({ type });
    assert.equal(result.ok, true, `${type} should validate`);
  }
});

test('validateWebviewToHostMessage rejects non-objects and missing type', () => {
  for (const value of [null, undefined, 'send', 42, [], true]) {
    const result = validateWebviewToHostMessage(value);
    assert.equal(result.ok, false);
  }
  const noType = validateWebviewToHostMessage({});
  assert.equal(noType.ok, false);
  if (!noType.ok) assert.match(noType.reason, /type/);
});

test('validateWebviewToHostMessage rejects unknown message types', () => {
  const result = validateWebviewToHostMessage({ type: 'something.invented' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /unknown/);
});

test('validateWebviewToHostMessage validates compact payloads', () => {
  assert.equal(validateWebviewToHostMessage({ type: 'compact', sessionPath: '/a' }).ok, true);
  assert.equal(validateWebviewToHostMessage({ type: 'compact' }).ok, false);
  assert.equal(validateWebviewToHostMessage({ type: 'compact', sessionPath: 42 }).ok, false);
});

test('validateWebviewToHostMessage validates send payloads', () => {
  assert.equal(validateWebviewToHostMessage({ type: 'send', sessionPath: '/a', text: 'hi' }).ok, true);
  assert.equal(validateWebviewToHostMessage({ type: 'send', text: 'hi' }).ok, false);
  assert.equal(validateWebviewToHostMessage({ type: 'send', sessionPath: '/a' }).ok, false);
  assert.equal(validateWebviewToHostMessage({ type: 'send', sessionPath: '/a', text: 42 }).ok, false);
});

test('validateWebviewToHostMessage validates openFile', () => {
  assert.equal(validateWebviewToHostMessage({ type: 'openFile', path: '/x' }).ok, true);
  assert.equal(validateWebviewToHostMessage({ type: 'openFile' }).ok, false);
});

test('validateWebviewToHostMessage validates openFileDiff, openFileInEditor, and revertFile', () => {
  for (const type of ['openFileDiff', 'openFileInEditor', 'revertFile']) {
    assert.equal(
      validateWebviewToHostMessage({ type, sessionPath: '/a', filePath: '/b' }).ok,
      true,
      `${type} with sessionPath + filePath should validate`,
    );
    assert.equal(
      validateWebviewToHostMessage({ type, filePath: '/b' }).ok,
      false,
      `${type} without sessionPath should be rejected`,
    );
    assert.equal(
      validateWebviewToHostMessage({ type, sessionPath: '/a' }).ok,
      false,
      `${type} without filePath should be rejected`,
    );
  }
});

test('validateWebviewToHostMessage validates session-scoped messages with required sessionPath', () => {
  for (const type of ['openSession', 'closeSession', 'interrupt', 'startNewTask', 'continueTask', 'togglePinTab']) {
    assert.equal(
      validateWebviewToHostMessage({ type, sessionPath: '/a' }).ok,
      true,
      `${type} with sessionPath should validate`,
    );
    assert.equal(
      validateWebviewToHostMessage({ type }).ok,
      false,
      `${type} without sessionPath should fail`,
    );
  }
});

test('validateWebviewToHostMessage validates cancelDeferredTrigger (required sessionPath, optional triggerId)', () => {
  // sessionPath required; triggerId optional.
  assert.equal(validateWebviewToHostMessage({ type: 'cancelDeferredTrigger', sessionPath: '/a' }).ok, true);
  assert.equal(validateWebviewToHostMessage({ type: 'cancelDeferredTrigger', sessionPath: '/a', triggerId: 't1' }).ok, true);
  // missing sessionPath
  assert.equal(validateWebviewToHostMessage({ type: 'cancelDeferredTrigger' }).ok, false);
  // non-string triggerId
  assert.equal(validateWebviewToHostMessage({ type: 'cancelDeferredTrigger', sessionPath: '/a', triggerId: 123 }).ok, false);
});

test('validateWebviewToHostMessage validates editMessage payloads', () => {
  assert.equal(
    validateWebviewToHostMessage({ type: 'editMessage', sessionPath: '/a', messageId: 'm1', text: 'edited' }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'editMessage', sessionPath: '/a', messageId: 'm1', text: 'edited', inputs: [] }).ok,
    true,
    'editMessage with inputs array should validate',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'editMessage', sessionPath: '/a', messageId: 'm1', text: 'edited', inputs: 'bad' }).ok,
    false,
    'editMessage with non-array inputs should fail',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'editMessage', sessionPath: '/a', messageId: 'm1', text: 'edited', queued: true }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'editMessage', sessionPath: '/a', messageId: 'm1', text: 'edited', queued: 'yes' }).ok,
    false,
  );
  assert.equal(validateWebviewToHostMessage({ type: 'editMessage', messageId: 'm1', text: 'edited' }).ok, false);
  assert.equal(validateWebviewToHostMessage({ type: 'editMessage', sessionPath: '/a', messageId: 'm1' }).ok, false);
  assert.equal(validateWebviewToHostMessage({ type: 'editMessage', sessionPath: '/a', text: 'x' }).ok, false);
});

test('validateWebviewToHostMessage validates moveSessionTab', () => {
  assert.equal(
    validateWebviewToHostMessage({ type: 'moveSessionTab', fromIndex: 0, toIndex: 2 }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'moveSessionTab', sessionPath: '/a', fromIndex: 0, toIndex: 1 }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'moveSessionTab', fromIndex: '0', toIndex: 1 }).ok,
    false,
  );
});

test('validateWebviewToHostMessage validates paging messages with optional sessionPath', () => {
  for (const type of ['loadOlderTranscript', 'loadNewerTranscript', 'jumpToLatestTranscript']) {
    assert.equal(validateWebviewToHostMessage({ type }).ok, true, `${type} should validate without sessionPath`);
    assert.equal(
      validateWebviewToHostMessage({ type, sessionPath: '/p' }).ok,
      true,
      `${type} should validate with sessionPath`,
    );
    assert.equal(
      validateWebviewToHostMessage({ type, sessionPath: 7 }).ok,
      false,
      `${type} should reject non-string sessionPath`,
    );
  }
});

test('validateWebviewToHostMessage validates composer input drafts', () => {
  const validFsRef = {
    type: 'addComposerInput',
    sessionPath: '/a',
    input: { kind: 'filesystemPathRef', path: '/x', name: 'x', source: 'picker' },
  };
  assert.equal(validateWebviewToHostMessage(validFsRef).ok, true);

  const validImage = {
    type: 'addComposerInput',
    sessionPath: '/a',
    input: {
      kind: 'imageBlob',
      mimeType: 'image/png',
      name: 'x.png',
      sizeBytes: 1024,
      dataBase64: 'aaaa',
      source: 'paste',
    },
  };
  assert.equal(validateWebviewToHostMessage(validImage).ok, true);

  const missingFields = {
    type: 'addComposerInput',
    sessionPath: '/a',
    input: { kind: 'imageBlob', mimeType: 'image/png', name: 'x.png' },
  };
  assert.equal(validateWebviewToHostMessage(missingFields).ok, false);

  const unknownKind = {
    type: 'addComposerInput',
    sessionPath: '/a',
    input: { kind: 'imaginary', value: 1 },
  };
  assert.equal(validateWebviewToHostMessage(unknownKind).ok, false);
});

test('validateWebviewToHostMessage validates removeComposerInput', () => {
  assert.equal(
    validateWebviewToHostMessage({ type: 'removeComposerInput', sessionPath: '/a', inputId: 'i1' }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'removeComposerInput', sessionPath: '/a' }).ok,
    false,
  );
});

test('validateWebviewToHostMessage validates recordOutcome', () => {
  assert.equal(
    validateWebviewToHostMessage({
      type: 'recordOutcome',
      sessionPath: '/a',
      outcome: { resolution: 'resolved', satisfaction: 4 },
    }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({
      type: 'recordOutcome',
      sessionPath: '/a',
      outcome: { resolution: 'unknown', satisfaction: 4 },
    }).ok,
    false,
  );
  assert.equal(
    validateWebviewToHostMessage({
      type: 'recordOutcome',
      sessionPath: '/a',
      outcome: { resolution: 'resolved' },
    }).ok,
    false,
  );
});

test('validateWebviewToHostMessage validates setModel and rejects invalid thinking levels', () => {
  assert.equal(
    validateWebviewToHostMessage({
      type: 'setModel',
      defaultModel: 'gpt-X',
      defaultThinkingLevel: 'medium',
    }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({
      type: 'setModel',
      defaultModel: 'gpt-X',
      defaultThinkingLevel: 'extreme',
    }).ok,
    false,
  );
  assert.equal(
    validateWebviewToHostMessage({
      type: 'setModel',
      defaultThinkingLevel: 'low',
    }).ok,
    false,
  );
});

test('validateWebviewToHostMessage validates setPrefs patches and rejects unknown keys', () => {
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { autoExpandReasoning: true } }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: {} }).ok,
    true,
    'empty prefs patch should validate',
  );
  assert.equal(
    validateWebviewToHostMessage({
      type: 'setPrefs',
      prefs: { subagentRouteAroundSaturatedProviders: true },
    }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({
      type: 'setPrefs',
      prefs: { subagentRouteAroundSaturatedProviders: 'yes' },
    }).ok,
    false,
  );
  assert.equal(
    validateWebviewToHostMessage({
      type: 'setPrefs',
      prefs: { autoExpandReasoning: 'yes' },
    }).ok,
    false,
  );
  assert.equal(
    validateWebviewToHostMessage({
      type: 'setPrefs',
      prefs: { unknownPref: true },
    }).ok,
    false,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiMessageWidth: 80 } }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiBackground: '#0d1117' } }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiForeground: '#c9d1d9' } }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiBorder: '#30363d' } }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiCornerRadius: 12 } }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiDensity: 'compact' } }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiDensity: 'invalid' } }).ok,
    false,
    'uiDensity must be one of compact/comfortable/spacious',
  );
  // ── Widened slider bounds (see ChatPrefs numericRanges) ─────────────
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiMessageWidth: 40 } }).ok,
    true,
    'uiMessageWidth at the 40 floor should validate',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiMessageWidth: 30 } }).ok,
    false,
    'uiMessageWidth below the 40 floor should be rejected',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiCornerRadius: -1 } }).ok,
    false,
    'uiCornerRadius below 0 should be rejected',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiCornerRadius: 24 } }).ok,
    true,
    'uiCornerRadius at the 24 ceiling should validate',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiCornerRadius: 25 } }).ok,
    false,
    'uiCornerRadius above 24 should be rejected',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { expandedSectionMaxHeight: 240 } }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { expandedSectionMaxHeight: 80 } }).ok,
    true,
    'expandedSectionMaxHeight at the 80 floor should validate',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { expandedSectionMaxHeight: 1600 } }).ok,
    true,
    'expandedSectionMaxHeight at the 1600 ceiling should validate',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { expandedSectionMaxHeight: 60 } }).ok,
    false,
    'expandedSectionMaxHeight below the 80 floor should be rejected',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { expandedSectionMaxHeight: 1700 } }).ok,
    false,
    'expandedSectionMaxHeight above the 1600 ceiling should be rejected',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { expandedSectionFontSize: 28 } }).ok,
    true,
    'expandedSectionFontSize at the 28 ceiling should validate',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { expandedSectionFontSize: 33 } }).ok,
    false,
    'expandedSectionFontSize above 32 should be rejected',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { activityTailLines: 12 } }).ok,
    true,
    'activityTailLines at the 12 ceiling should validate',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { activityTailLines: 0 } }).ok,
    false,
    'activityTailLines below 1 should be rejected',
  );
  // ── New per-place font sizes ────────────────────────────────────────
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiBaseFontSize: 13 } }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiBaseFontSize: 9 } }).ok,
    false,
    'uiBaseFontSize below 10 should be rejected',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiBaseFontSize: 25 } }).ok,
    false,
    'uiBaseFontSize above 24 should be rejected',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiComposerFontSize: 13 } }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiComposerFontSize: 10 } }).ok,
    false,
    'uiComposerFontSize below 11 should be rejected',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiComposerFontSize: 29 } }).ok,
    false,
    'uiComposerFontSize above 28 should be rejected',
  );
  // ── New color overrides (string-typed; '' resets to default) ────────
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiMutedColor: '#958f82' } }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiMutedColor: '' } }).ok,
    true,
    'uiMutedColor empty string (reset) should validate',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiMutedColor: 42 } }).ok,
    false,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiLinkColor: '#7bd8d0' } }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiLinkColor: '' } }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiLinkColor: false } }).ok,
    false,
  );
});

test('validateWebviewToHostMessage validates split render evidence payloads', () => {
  const base = { revision: 7, viewGeneration: 3 };
  assert.equal(validateWebviewToHostMessage({ type: 'stateReceived', payload: { ...base, snapshotBytes: 1024 } }).ok, true);
  assert.equal(validateWebviewToHostMessage({ type: 'stateReceived', payload: { ...base, snapshotBytes: -1 } }).ok, false);

  assert.equal(validateWebviewToHostMessage({ type: 'appCommitted', payload: { ...base, surface: 'transcript' } }).ok, true);
  assert.equal(validateWebviewToHostMessage({ type: 'appCommitted', payload: { ...base, surface: 'invented' } }).ok, false);

  const transcript = { ...base, identity: 'bounded-identity', mountGeneration: 2, evidence: 'displayed' };
  assert.equal(validateWebviewToHostMessage({ type: 'transcriptCommitted', payload: transcript }).ok, true);
  assert.equal(validateWebviewToHostMessage({ type: 'transcriptCommitted', payload: { ...transcript, identity: '' } }).ok, false);
  assert.equal(validateWebviewToHostMessage({ type: 'paintObserved', payload: { ...transcript, latencyMs: 12.5 } }).ok, true);
  assert.equal(validateWebviewToHostMessage({ type: 'paintObserved', payload: { ...transcript, latencyMs: -1 } }).ok, false);

  const failure = { viewGeneration: 3, revision: 7, surface: 'transcript', classification: 'component_error' };
  assert.equal(validateWebviewToHostMessage({ type: 'renderFailure', payload: failure }).ok, true);
  assert.equal(validateWebviewToHostMessage({
    type: 'renderFailure',
    payload: { ...failure, error: 'raw bodies are forbidden' },
  }).ok, false, 'arbitrary render-error bodies cannot cross the evidence boundary');
  assert.equal(validateWebviewToHostMessage({ type: 'renderFailure', payload: { ...failure, classification: 'raw error' } }).ok, false);
});

test('readiness generation metadata is bounded when present', () => {
  assert.equal(validateWebviewToHostMessage({ type: 'ready', viewGeneration: 2 }).ok, true);
  assert.equal(validateWebviewToHostMessage({ type: 'refreshState', viewGeneration: -1 }).ok, false);
  assert.equal(validateWebviewToHostMessage({ type: 'requestSnapshot', viewGeneration: 1.5 }).ok, false);
});

test('validateWebviewToHostMessage validates historyCompaction patches', () => {
  const valid = {
    type: 'setPrefs',
    prefs: {
      historyCompaction: {
        enabled: true,
        thresholdMode: 'tokens',
        softThreshold: 80_000,
        hardThreshold: 100_000,
        keepRecentTokens: 30_000,
        summaryInstructions: 'Brief.',
        summaryThinkingLevel: 'low',
        summaryModel: null,
        modelProfiles: {
          'openai/gpt-5': { softThreshold: 90_000, hardThreshold: 110_000, keepRecentTokens: 10_000 },
        },
      },
    },
  };
  assert.equal(validateWebviewToHostMessage(valid).ok, true);

  assert.equal(
    validateWebviewToHostMessage({
      type: 'setPrefs',
      prefs: { historyCompaction: { enabled: true, thresholdMode: 'percentage', softThreshold: 70, hardThreshold: 85 } },
    }).ok,
    true,
    'legacy four-field historyCompaction should still validate',
  );

  assert.equal(
    validateWebviewToHostMessage({
      type: 'setPrefs',
      prefs: { historyCompaction: { enabled: true, thresholdMode: 'tokens', softThreshold: 80_000, hardThreshold: 100_000, keepRecentTokens: -1 } },
    }).ok,
    false,
    'negative keepRecentTokens is rejected',
  );

  assert.equal(
    validateWebviewToHostMessage({
      type: 'setPrefs',
      prefs: { historyCompaction: { enabled: true, thresholdMode: 'tokens', softThreshold: 80_000, hardThreshold: 100_000, summaryInstructions: 'x'.repeat(4_001) } },
    }).ok,
    false,
    'summary instructions above 4000 chars are rejected',
  );

  assert.equal(
    validateWebviewToHostMessage({
      type: 'setPrefs',
      prefs: { historyCompaction: { enabled: true, thresholdMode: 'tokens', softThreshold: 80_000, hardThreshold: 100_000, summaryThinkingLevel: 'unknown' } },
    }).ok,
    false,
    'invalid summary thinking level is rejected',
  );

  assert.equal(
    validateWebviewToHostMessage({
      type: 'setPrefs',
      prefs: { historyCompaction: { enabled: true, thresholdMode: 'tokens', softThreshold: 80_000, hardThreshold: 100_000, summaryModel: { provider: '', id: 'x' } } },
    }).ok,
    false,
    'summary model with empty provider is rejected',
  );

  assert.equal(
    validateWebviewToHostMessage({
      type: 'setPrefs',
      prefs: { historyCompaction: { enabled: true, thresholdMode: 'tokens', softThreshold: 80_000, hardThreshold: 100_000, modelProfiles: { 'p/m': { softThreshold: 500, hardThreshold: 100_000, keepRecentTokens: 100 } } } },
    }).ok,
    false,
    'model profile with soft below minimum is rejected',
  );
});
