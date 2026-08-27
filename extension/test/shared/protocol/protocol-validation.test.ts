import test from 'node:test';
import assert from 'node:assert/strict';

import { validateHostToWebviewDetailMessage, validateWebviewToHostMessage } from '../../../src/shared/protocol-validation';

test('validateWebviewToHostMessage accepts the simple no-payload messages', () => {
  for (const type of ['ready', 'refreshState', 'requestSnapshot', 'openFilePicker', 'newSession', 'showLogs', 'openSettings', 'restartBackend']) {
    const result = validateWebviewToHostMessage({ type });
    assert.equal(result.ok, true, `${type} should validate`);
  }
});

test('validateWebviewToHostMessage validates optional readiness build identities', () => {
  assert.equal(validateWebviewToHostMessage({ type: 'ready', buildId: 'build-1' }).ok, true);
  assert.equal(validateWebviewToHostMessage({ type: 'ready', buildId: 1 }).ok, false);
  assert.equal(validateWebviewToHostMessage({ type: 'requestSnapshot', buildId: false }).ok, false);
});

test('validateWebviewToHostMessage validates retrySend recovery payloads', () => {
  assert.equal(validateWebviewToHostMessage({
    type: 'retrySend', sessionPath: '/session.jsonl', text: 'try again', localId: 'local-1', disablePruning: true,
  }).ok, true);
  assert.equal(validateWebviewToHostMessage({
    type: 'retrySend', sessionPath: '/session.jsonl', text: 'try again', localId: 'local-1', disablePruning: 'yes',
  }).ok, false);
  assert.equal(validateWebviewToHostMessage({ type: 'retrySend', text: 'try again', localId: 'local-1' }).ok, false);
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

test('validateWebviewToHostMessage validates queue and session recovery payloads', () => {
  assert.equal(validateWebviewToHostMessage({ type: 'clearQueue', sessionPath: '/a' }).ok, true);
  assert.equal(validateWebviewToHostMessage({ type: 'clearQueue' }).ok, false);
  assert.equal(validateWebviewToHostMessage({ type: 'retryCreateOperation', operationId: 'op-1' }).ok, true);
  assert.equal(validateWebviewToHostMessage({ type: 'retryCreateOperation', operationId: 1 }).ok, false);
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

test('validateWebviewToHostMessage validates file-change expansion payloads', () => {
  assert.equal(validateWebviewToHostMessage({ type: 'setFileChangesExpanded', sessionPath: '/a', expanded: true }).ok, true);
  assert.equal(validateWebviewToHostMessage({ type: 'setFileChangesExpanded', sessionPath: '/a', expanded: 'yes' }).ok, false);
  assert.equal(validateWebviewToHostMessage({ type: 'setFileChangesExpanded', expanded: true }).ok, false);
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

test('validateWebviewToHostMessage validates bounded detail retrieval requests', () => {
  const ref = {
    key: 'durable:tool:key', kind: 'tool-result', source: 'durable', sessionPath: '/a',
    messageId: 'message', toolCallId: 'tool', sizeBytes: 100, summary: 'summary', available: true,
  };
  assert.equal(validateWebviewToHostMessage({ type: 'requestDetail', sessionPath: '/a', ref }).ok, true);
  assert.equal(validateWebviewToHostMessage({
    type: 'requestDetail', sessionPath: '/a', ref: { ...ref, childCount: 2, lineCount: 3 },
  }).ok, true);
  assert.equal(validateWebviewToHostMessage({ type: 'requestDetail', sessionPath: '/a', ref: { ...ref, kind: 'bad' } }).ok, false);
  for (const invalidCount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2']) {
    assert.equal(validateWebviewToHostMessage({
      type: 'requestDetail', sessionPath: '/a', ref: { ...ref, childCount: invalidCount },
    }).ok, false, `invalid childCount ${String(invalidCount)} should fail`);
    assert.equal(validateWebviewToHostMessage({
      type: 'requestDetail', sessionPath: '/a', ref: { ...ref, lineCount: invalidCount },
    }).ok, false, `invalid lineCount ${String(invalidCount)} should fail`);
  }
  assert.equal(validateWebviewToHostMessage({ type: 'requestDetail', ref }).ok, false);
});

test('validateWebviewToHostMessage validates Phase 5 detail subscription messages', () => {
  const address = {
    sessionPath: '/a/session.jsonl', turnId: 'turn-1', rootToolCallId: 'tool-1', rootAttemptId: 'attempt-1',
    lineage: [{ childId: 'child-1', spawningToolCallId: 'tool-1', attemptId: 'attempt-1' }],
  };
  const valid = { type: 'detail.subscribe', viewGeneration: 3, detailKey: 'subagent:msg:tool', detailAttempt: 1, address };
  assert.equal(validateWebviewToHostMessage(valid).ok, true);
  assert.equal(
    validateWebviewToHostMessage({ ...valid, cursor: { revision: 1, pageIndex: 0 } }).ok,
    true,
    'subscribe accepts an optional cursor',
  );
  assert.equal(
    validateWebviewToHostMessage({ ...valid, viewGeneration: -1 }).ok,
    false,
    'subscribe rejects a negative viewGeneration',
  );
  assert.equal(
    validateWebviewToHostMessage({ ...valid, viewGeneration: undefined }).ok,
    false,
    'subscribe requires viewGeneration (not the optional wrapper field)',
  );
  assert.equal(
    validateWebviewToHostMessage({ ...valid, detailAttempt: 0 }).ok,
    false,
    'subscribe requires a positive detailAttempt',
  );
  assert.equal(
    validateWebviewToHostMessage({ ...valid, detailKey: '' }).ok,
    false,
    'subscribe rejects an empty detailKey',
  );
  assert.equal(
    validateWebviewToHostMessage({ ...valid, detailKey: 'x'.repeat(513) }).ok,
    false,
    'subscribe rejects an oversized detailKey',
  );
  assert.equal(
    validateWebviewToHostMessage({ ...valid, address: { ...address, rootToolCallId: 42 } }).ok,
    false,
    'subscribe rejects a malformed address',
  );
  assert.equal(
    validateWebviewToHostMessage({ ...valid, cursor: { revision: -1 } }).ok,
    false,
    'subscribe rejects a malformed cursor',
  );

  assert.equal(
    validateWebviewToHostMessage({ type: 'detail.unsubscribe', viewGeneration: 3, detailKey: 'k', detailAttempt: 1, reason: 'collapse' }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'detail.unsubscribe', viewGeneration: 3, detailKey: 'k', detailAttempt: 1, reason: 'evict' }).ok,
    false,
    'unsubscribe rejects unknown reasons',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'detail.unsubscribe', detailKey: 'k', detailAttempt: 1, reason: 'collapse' }).ok,
    false,
    'unsubscribe requires viewGeneration',
  );

  assert.equal(
    validateWebviewToHostMessage({
      type: 'detail.fetchPages', viewGeneration: 3, detailKey: 'k', detailAttempt: 1, ref: { baselineRevision: 1, pageIndex: 0, pageCount: 2 },
    }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'detail.fetchPages', viewGeneration: 3, detailKey: 'k', detailAttempt: 1, ref: { pageIndex: 0 } }).ok,
    false,
    'fetchPages rejects an incomplete ref',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'detail.fetchPages', viewGeneration: 3, detailKey: 'k', detailAttempt: 1 }).ok,
    false,
    'fetchPages requires a ref',
  );
});

test('validateHostToWebviewDetailMessage validates every stream variant and route field', () => {
  const route = {
    hostInstanceId: 'host-1', hostGeneration: 0, viewGeneration: 3,
    rendererId: 'renderer-1', rendererGeneration: 1, detailAttempt: 1, backendGeneration: 2,
    coordinatorGeneration: 1, workerId: 'worker-1', workerGeneration: 1,
    detailKey: 'subagent:msg:tool', subscriptionId: 'subscription-1',
  };
  const address = {
    sessionPath: '/a/session.jsonl', turnId: 'turn-1', rootToolCallId: 'tool-1', rootAttemptId: 'attempt-1',
    lineage: [{ childId: 'child-1', spawningToolCallId: 'tool-1', attemptId: 'attempt-1' }],
  };
  const payload = {
    kind: 'json-segment', encoding: 'utf8-json', segmentId: 'segment', semanticPath: [],
    startByte: 0, endByte: 4, totalBytes: 4, startCodePoint: 0, endCodePoint: 4, totalCodePoints: 4, text: 'null',
  };

  assert.equal(validateHostToWebviewDetailMessage({ type: 'detail.start', ...route, address, source: 'live', baselineRevision: 1, pageCount: 1, totalBytes: 4, totalCodePoints: 4 }), true);
  assert.equal(validateHostToWebviewDetailMessage({ type: 'detail.start', ...route, address, source: 'durable', baselineRevision: 1, pageCount: 1, totalBytes: 4, totalCodePoints: 4 }), true);
  assert.equal(validateHostToWebviewDetailMessage({ type: 'detail.start', ...route, address, source: 'live', baselineRevision: 1, pageCount: 1, totalBytes: 4 }), false, 'start requires the code-point manifest total');
  assert.equal(validateHostToWebviewDetailMessage({ type: 'detail.start', ...route, address, source: 'other', baselineRevision: 1, pageCount: 1, totalBytes: 4, totalCodePoints: 4 }), false);
  assert.equal(validateHostToWebviewDetailMessage({ type: 'detail.start', ...route, address: { ...address, lineage: [] }, source: 'live', baselineRevision: 1, pageCount: 1, totalBytes: 4, totalCodePoints: 4 }), false);

  assert.equal(validateHostToWebviewDetailMessage({ type: 'detail.page', ...route, ref: { baselineRevision: 1, pageIndex: 0, pageCount: 1 }, payload, payloadBytes: 4, checksum: 'a'.repeat(64) }), true);
  assert.equal(validateHostToWebviewDetailMessage({ type: 'detail.page', ...route, ref: { baselineRevision: 1, pageIndex: 0, pageCount: 1 }, payload, payloadBytes: 4, checksum: 'zz' }), false, 'bad checksum shape');
  assert.equal(validateHostToWebviewDetailMessage({ type: 'detail.page', ...route, ref: { baselineRevision: 1, pageIndex: 0, pageCount: 1 }, payload: { ...payload, kind: 'other' }, payloadBytes: 4, checksum: 'a'.repeat(64) }), false, 'bad payload kind');

  assert.equal(validateHostToWebviewDetailMessage({ type: 'detail.delta', ...route, baseRevision: 1, revision: 2, operations: [{ op: 'set', path: ['a'], value: 1 }] }), true);
  assert.equal(validateHostToWebviewDetailMessage({ type: 'detail.delta', ...route, baseRevision: 2, revision: 1, operations: [] }), false, 'revision must advance');
  assert.equal(validateHostToWebviewDetailMessage({ type: 'detail.delta', ...route, baseRevision: 1, revision: 2, operations: [{ op: 'unknown', path: [] }] }), false, 'unknown op');

  assert.equal(validateHostToWebviewDetailMessage({ type: 'detail.rebase', ...route, currentRevision: 2, reason: 'gap' }), true);
  assert.equal(validateHostToWebviewDetailMessage({ type: 'detail.rebase', ...route, currentRevision: 2, reason: 'nope' }), false);

  assert.equal(validateHostToWebviewDetailMessage({ type: 'detail.terminal', ...route, revision: 2, durableRef: { sessionPath: '/a', messageId: 'm', key: 'k', kind: 'tool-result', source: 'durable', sizeBytes: 10, summary: 's', available: true } }), true);
  assert.equal(validateHostToWebviewDetailMessage({ type: 'detail.terminal', ...route, revision: 2, durableRef: { sessionPath: '/a', messageId: 'm', key: 'k', kind: 'bad', source: 'durable', sizeBytes: 10, summary: 's', available: true } }), false);

  assert.equal(validateHostToWebviewDetailMessage({ type: 'detail.error', ...route, code: 'UNAVAILABLE', message: 'x', retryable: true }), true);
  assert.equal(validateHostToWebviewDetailMessage({ type: 'detail.error', ...route, code: 'NOPE', message: 'x', retryable: true }), false);

  // Route defects are rejected for every variant.
  for (const variant of [
    { type: 'detail.start', address, source: 'live', baselineRevision: 1, pageCount: 1, totalBytes: 4, totalCodePoints: 4 },
    { type: 'detail.error', code: 'UNAVAILABLE', message: 'x', retryable: true },
  ]) {
    assert.equal(validateHostToWebviewDetailMessage({ ...variant, ...route, hostGeneration: -1 }), false, 'negative hostGeneration');
    assert.equal(validateHostToWebviewDetailMessage({ ...variant, ...route, workerId: 'worker-1', workerGeneration: undefined }), false, 'workerId without workerGeneration');
    assert.equal(validateHostToWebviewDetailMessage({ ...variant, ...route, subscriptionId: '' }), false, 'empty subscriptionId');
    assert.equal(validateHostToWebviewDetailMessage({ ...variant, ...route, detailAttempt: 0 }), false, 'invalid detailAttempt');
    assert.equal(validateHostToWebviewDetailMessage({ ...variant, ...route, detailKey: '' }), false, 'empty detailKey');
  }
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

test('validateWebviewToHostMessage validates pinned-group messages', () => {
  for (const type of ['groupPinnedTab', 'mergePinnedGroups']) {
    assert.equal(validateWebviewToHostMessage({ type, sourcePath: '/a', targetPath: '/b' }).ok, true);
    assert.equal(validateWebviewToHostMessage({ type, sourcePath: '', targetPath: '/b' }).ok, false);
    assert.equal(validateWebviewToHostMessage({ type, sourcePath: '/a', targetPath: 42 }).ok, false);
  }
  for (const type of ['ungroupPinnedTab', 'movePinnedItem']) {
    assert.equal(validateWebviewToHostMessage({ type, sourcePath: '/a', toItemIndex: 1 }).ok, true);
    assert.equal(validateWebviewToHostMessage({ type, sourcePath: '/a', toItemIndex: -1 }).ok, false);
    assert.equal(validateWebviewToHostMessage({ type, sourcePath: '/a', toItemIndex: 1.5 }).ok, false);
    assert.equal(validateWebviewToHostMessage({ type, sourcePath: '', toItemIndex: 0 }).ok, false);
  }
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
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { autonomousMode: true } }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { autonomousMode: 'yes' } }).ok,
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
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { composerInitialRows: 1 } }).ok,
    true,
    'one initial composer row should validate',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { composerInitialRows: 6 } }).ok,
    true,
    'six initial composer rows should validate',
  );
  for (const invalid of [0, 7, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      validateWebviewToHostMessage({ type: 'setPrefs', prefs: { composerInitialRows: invalid } }).ok,
      false,
      `invalid initial composer row count ${invalid} should be rejected`,
    );
  }
  for (const valid of [0, 1, 8]) {
    assert.equal(
      validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiPathParentDepth: valid } }).ok,
      true,
      `path parent depth ${valid} should validate`,
    );
  }
  for (const invalid of [-1, 9, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiPathParentDepth: invalid } }).ok,
      false,
      `invalid path parent depth ${invalid} should be rejected`,
    );
  }
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
