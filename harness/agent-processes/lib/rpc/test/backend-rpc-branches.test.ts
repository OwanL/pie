import assert from 'node:assert/strict';
import test from 'node:test';

import { validateHostLiveMembership } from '../live-session-control.js';
import { MAX_IMAGE_INPUT_BYTES, validateLoadTranscriptPage, validateMessageSend, validateRuntimePrefsSet, validateSessionCreate, validateSessionDuplicate, validateSessionOpen, validateSessionPath, validateSessionViewed, validateSettingsSet, validateSystemPromptTogglesSet, validateTruncateAfter } from '../backend-rpc.js';

test('validateSessionPath handles required path form and rejects pending pseudo-paths', () => {
  assert.deepEqual(validateSessionPath('session.open', { sessionPath: '/repo/session.jsonl' }), { sessionPath: '/repo/session.jsonl' });
  assert.throws(() => validateSessionPath('session.open', { sessionPath: '' }), /requires a string sessionPath/);
  assert.throws(() => validateSessionPath('session.open', { sessionPath: '__pending__:1-abc' }), /resolved session/);
  assert.throws(() => validateSessionPath('session.open', { sessionPath: 'C:\\repo\\__pending__:1-abc' }), /resolved session/);
});

test('session create/open validators reject invalid payloads and selection tokens', () => {
  assert.deepEqual(validateSessionCreate(undefined), {});
  assert.throws(() => validateSessionCreate('bad'), /expected an object/);
  assert.throws(() => validateSessionCreate({ cwd: 123 }), /cwd must be a string/);
  assert.throws(() => validateSessionCreate({ selectionToken: 123 }), /selectionToken must be a string/);
  assert.throws(() => validateSessionOpen({ sessionPath: '/repo/session.jsonl', selectionToken: 123 }), /selectionToken must be a string/);
});

test('session viewed validator requires an explicit resolved predecessor or null', () => {
  assert.deepEqual(validateSessionViewed({
    sessionPath: '/repo/b.jsonl',
    previousSessionPath: '/repo/a.jsonl',
  }), {
    sessionPath: '/repo/b.jsonl',
    previousSessionPath: '/repo/a.jsonl',
  });
  assert.deepEqual(validateSessionViewed({ sessionPath: '/repo/a.jsonl', previousSessionPath: null }), {
    sessionPath: '/repo/a.jsonl', previousSessionPath: null,
  });
  assert.throws(() => validateSessionViewed({ sessionPath: '/repo/a.jsonl' }), /string or null/);
  assert.throws(() => validateSessionViewed({
    sessionPath: '/repo/a.jsonl', previousSessionPath: '__pending__:1-abc',
  }), /resolved session/);
});

test('session duplicate validator requires a sessionPath and optionally accepts selectionToken', () => {
  assert.deepEqual(validateSessionDuplicate({ sessionPath: '/repo/session.jsonl' }), {
    sessionPath: '/repo/session.jsonl',
    selectionToken: undefined,
  });
  assert.deepEqual(validateSessionDuplicate({ sessionPath: '/repo/session.jsonl', selectionToken: 'sel-1' }), {
    sessionPath: '/repo/session.jsonl',
    selectionToken: 'sel-1',
  });
  assert.throws(() => validateSessionDuplicate('bad'), /expected an object/);
  assert.throws(() => validateSessionDuplicate({ sessionPath: '' }), /requires a string sessionPath/);
  assert.throws(() => validateSessionDuplicate({ sessionPath: '/repo/session.jsonl', selectionToken: 123 }), /selectionToken must be a string/);
});

test('transcript page and truncation validators cover range edge cases', () => {
  assert.throws(
    () => validateLoadTranscriptPage({ sessionPath: '/repo/session.jsonl', direction: 'older', loadedStart: -1 }),
    /loadedStart must be a non-negative integer/,
  );
  assert.throws(
    () => validateLoadTranscriptPage({ sessionPath: '/repo/session.jsonl', direction: 'older', loadedStart: 5, loadedEnd: 4 }),
    /loadedStart must be less than or equal to loadedEnd/,
  );
  assert.throws(
    () => validateLoadTranscriptPage({ sessionPath: 'C:\\repo\\__pending__:1-abc', direction: 'latest' }),
    /resolved session/,
  );
  assert.deepEqual(validateTruncateAfter({ sessionPath: '/repo/session.jsonl', entryId: 'entry-1' }), {
    sessionPath: '/repo/session.jsonl',
    entryId: 'entry-1',
  });
  assert.throws(() => validateTruncateAfter({ sessionPath: '', entryId: 'entry-1' }), /requires a string sessionPath/);
  assert.throws(() => validateTruncateAfter({ sessionPath: 'C:\\repo\\__pending__:1-abc', entryId: 'entry-1' }), /resolved session/);
  assert.throws(() => validateTruncateAfter({ sessionPath: '/repo/session.jsonl', entryId: '' }), /requires a string entryId/);
});

test('validateMessageSend rejects malformed attachment payloads and invalid arrays', () => {
  assert.throws(() => validateMessageSend({ sessionPath: 'C:\\repo\\__pending__:1-abc', text: 'hello' }), /resolved session/);
  assert.throws(() => validateMessageSend({ sessionPath: '/repo/session.jsonl', text: 'hello', inputs: {} }), /inputs must be an array/);
  assert.throws(() => validateMessageSend({ sessionPath: '/repo/session.jsonl', text: 'hello', inputs: [null] }), /inputs\[0\] must be an object/);
  assert.throws(() => validateMessageSend({ sessionPath: '/repo/session.jsonl', text: 'hello', inputs: [{ kind: 'filesystemPathRef' }] }), /inputs\[0\]\.id must be a non-empty string/);
  assert.throws(() => validateMessageSend({ sessionPath: '/repo/session.jsonl', text: 'hello', inputs: [{ id: '1', kind: 'filesystemPathRef', path: '', name: 'file.ts', source: 'picker' }] }), /path must be a non-empty string/);
  assert.throws(() => validateMessageSend({ sessionPath: '/repo/session.jsonl', text: 'hello', inputs: [{ id: '1', kind: 'filesystemPathRef', path: '/repo/file.ts', name: '', source: 'picker' }] }), /name must be a non-empty string/);
  assert.throws(() => validateMessageSend({ sessionPath: '/repo/session.jsonl', text: 'hello', inputs: [{ id: '1', kind: 'filesystemPathRef', path: '/repo/file.ts', name: 'file.ts', source: 'paste' }] }), /source must be "picker" or "drop"/);
  assert.throws(() => validateMessageSend({ sessionPath: '/repo/session.jsonl', text: 'hello', inputs: [{ id: '1', kind: 'imageBlob', mimeType: 'text/plain', name: 'bad.txt', sizeBytes: 1, dataBase64: 'abc', source: 'paste' }] }), /mimeType must be one of/);
  assert.throws(() => validateMessageSend({ sessionPath: '/repo/session.jsonl', text: 'hello', inputs: [{ id: '1', kind: 'imageBlob', mimeType: 'image/png', name: 'big.png', sizeBytes: MAX_IMAGE_INPUT_BYTES + 1, dataBase64: 'abc', source: 'paste' }] }), /exceeds the/);
  assert.throws(() => validateMessageSend({ sessionPath: '/repo/session.jsonl', text: 'hello', inputs: [{ id: '1', kind: 'imageBlob', mimeType: 'image/png', name: 'img.png', sizeBytes: 10, dataBase64: 'abc', source: 'picker' }] }), /source must be "paste" or "drop"/);
  assert.throws(() => validateMessageSend({ sessionPath: '/repo/session.jsonl', text: 'hello', inputs: [{ id: '1', kind: 'imageBlob', mimeType: 'image/png', name: 'img.png', sizeBytes: 10, dataBase64: 'abc', source: 'paste', width: 0 }] }), /width must be a positive number/);
  assert.throws(() => validateMessageSend({ sessionPath: '/repo/session.jsonl', text: 'hello', inputs: [{ id: '1', kind: 'imageBlob', mimeType: 'image/png', name: 'img.png', sizeBytes: 10, dataBase64: 'abc', source: 'paste', height: 0 }] }), /height must be a positive number/);
  const image = (id: string) => ({ id, kind: 'imageBlob', mimeType: 'image/png', name: `${id}.png`, sizeBytes: 7 * 1024 * 1024, dataBase64: 'abc', source: 'paste' });
  assert.throws(
    () => validateMessageSend({ sessionPath: '/repo/session.jsonl', text: 'hello', inputs: [image('1'), image('2'), image('3')] }),
    /aggregate limit/,
  );
});

test('runtime prefs and settings validators reject invalid object shapes', () => {
  assert.throws(() => validateRuntimePrefsSet('invalid'), /expected an object/);
  assert.throws(() => validateRuntimePrefsSet({ providerToggles: [] }), /providerToggles must be an object/);
  assert.throws(() => validateRuntimePrefsSet({ mcpEnabled: 'yes' }), /mcpEnabled must be a boolean/);
  assert.equal(validateRuntimePrefsSet({ mcpEnabled: false }).mcpEnabled, false);
  assert.throws(() => validateSettingsSet({ sessionPath: '' }), /sessionPath must be a non-empty string/);
  assert.throws(() => validateSettingsSet({ sessionPath: 'C:\\repo\\__pending__:1-abc' }), /resolved session/);
  assert.throws(
    () => validateSystemPromptTogglesSet({ sessionPath: 'C:\\repo\\__pending__:1-abc', disabledEntries: [] }),
    /resolved session/,
  );
  assert.throws(() => validateSettingsSet({ defaultModel: 123 }), /defaultModel must be a string/);
  assert.deepEqual(validateSettingsSet({ defaultThinkingLevel: 'max' }), { defaultThinkingLevel: 'max' });
  assert.throws(() => validateSettingsSet({ defaultThinkingLevel: 'extreme' }), /defaultThinkingLevel must be one of/);
});

test('settings.set accepts an additive session persistence scope and requires its sessionPath', () => {
  // Global scope (and omission) keep the shared default behavior.
  assert.deepEqual(validateSettingsSet({ persistenceScope: 'global' }), { persistenceScope: 'global' });
  assert.deepEqual(validateSettingsSet({}), {});
  assert.throws(() => validateSettingsSet({ persistenceScope: 'workspace' }), /persistenceScope must be session or global/);
  // Session scope must address one session.
  assert.throws(() => validateSettingsSet({ persistenceScope: 'session' }), /session persistence requires sessionPath/);
  const sessionScoped = validateSettingsSet({ persistenceScope: 'session', sessionPath: 'C:\\repo\\live.jsonl', defaultModel: 'gpt-x' });
  assert.deepEqual(sessionScoped, {
    persistenceScope: 'session', sessionPath: 'C:\\repo\\live.jsonl', defaultModel: 'gpt-x',
  });
});

test('host live membership snapshots validate shape, bounds, and monotonic revisions', () => {
  const snapshot = validateHostLiveMembership({
    revision: 3,
    timestamp: 1234,
    sessions: [{
      path: '/workspace/live.jsonl',
      name: 'Live',
      title: 'Assigned',
      activity: 'running',
      requestStartedAt: 10,
      runningTools: 2,
      usage: { workingTimeMs: 42, costUsd: 0.25, costProvenance: 'reported', freshness: 'fresh' },
    }],
    closing: [{ path: '/workspace/closing.jsonl', operationId: 'op-1', privacyMode: true, source: 'agent' }],
  });
  assert.equal(snapshot.sessions[0]?.activity, 'running');
  assert.equal(snapshot.closing[0]?.privacyMode, true);
  assert.equal(snapshot.closing[0]?.source, 'agent');

  assert.throws(() => validateHostLiveMembership({}), /revision must be a positive integer/);
  assert.throws(() => validateHostLiveMembership({
    revision: 1, timestamp: 0, sessions: 'x', closing: [],
  }), /sessions must be an array/);
  assert.throws(() => validateHostLiveMembership({
    revision: 1, timestamp: 0,
    sessions: [{ path: '/workspace/live.jsonl', activity: 'busy' }],
    closing: [],
  }), /activity must be idle, running, or waiting-user-input/);
  assert.throws(() => validateHostLiveMembership({
    revision: 1, timestamp: 0,
    sessions: [{ path: '/workspace/live.jsonl', activity: 'idle', usage: { costUsd: -1 } }],
    closing: [],
  }), /usage.costUsd/);
  assert.throws(() => validateHostLiveMembership({
    revision: 1, timestamp: 0, sessions: [], closing: [{ path: '/x' }],
  }), /operationId/);
  assert.throws(() => validateHostLiveMembership({
    revision: 1, timestamp: 0,
    sessions: Array.from({ length: 257 }, () => ({ path: '/x', activity: 'idle' })),
    closing: [],
  }), /at most 256/);
  assert.throws(() => validateHostLiveMembership({
    revision: 1, timestamp: 0, sessions: [], closing: [{ path: '/x', operationId: 'o', source: 'tool' }],
  }), /source must be agent or host/);
});
