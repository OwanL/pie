import test from 'node:test';
import assert from 'node:assert/strict';

import { validateBrowserToHostMessage } from '../browser-ingress';
import { isDictationMicrophoneAllowed, validateWebviewToHostMessage } from '../protocol-validation';
import type { RendererCommandContext } from '../../protocol/index.js';

const UUID = '01234567-89ab-4cde-f012-3456789abcde';
const start = {
  type: 'dictationStart', sessionPath: null, recordingId: 'recording-1', draftText: 'hello',
  selectionStart: 1, selectionEnd: 4,
};

test('dictation start accepts explicit null session and valid bounded selection', () => {
  assert.equal(validateWebviewToHostMessage(start).ok, true);
  assert.equal(validateBrowserToHostMessage({ ...start, clientCommandId: UUID }, 1024).ok, true);
});

test('dictation selectors, identifiers and exact fields are validated', () => {
  for (const invalid of [
    { ...start, selectionStart: -1 },
    { ...start, selectionEnd: 6 },
    { ...start, selectionStart: 4, selectionEnd: 3 },
    { ...start, selectionStart: 1.5 },
    { ...start, recordingId: '' },
    { ...start, recordingId: 'x'.repeat(129) },
    { ...start, extra: true },
    { ...start, hostMicrophoneAllowed: true },
  ]) assert.equal(validateWebviewToHostMessage(invalid).ok, false);

  assert.equal(validateWebviewToHostMessage({ ...start, draftText: 'x'.repeat(256 * 1024 + 1), selectionStart: 0, selectionEnd: 0 }).ok, false);
  assert.equal(validateBrowserToHostMessage({ ...start, hostMicrophoneAllowed: true, clientCommandId: UUID }, 1024).ok, false);
});

test('dictation stop and cancel require a concrete session and bounded recording identity', () => {
  for (const type of ['dictationStop', 'dictationCancel'] as const) {
    const valid = { type, sessionPath: '/session.jsonl', recordingId: 'recording-1' };
    assert.equal(validateWebviewToHostMessage(valid).ok, true);
    assert.equal(validateBrowserToHostMessage({ ...valid, clientCommandId: UUID }, 1024).ok, true);
    assert.equal(validateWebviewToHostMessage({ ...valid, sessionPath: null }).ok, false);
    assert.equal(validateWebviewToHostMessage({ ...valid, recordingId: 'x'.repeat(129) }).ok, false);
    assert.equal(validateBrowserToHostMessage({ ...valid, extra: 'no', clientCommandId: UUID }, 1024).ok, false);
  }
});

test('microphone permission comes only from trusted renderer context', () => {
  const vscode: RendererCommandContext = { rendererId: 'vscode', kind: 'vscode', rendererGeneration: 1 };
  const browser: RendererCommandContext = { rendererId: 'browser', kind: 'browser', rendererGeneration: 1 };
  const allowedBrowser: RendererCommandContext = { ...browser, hostMicrophoneAllowed: true };
  assert.equal(isDictationMicrophoneAllowed(vscode), true);
  assert.equal(isDictationMicrophoneAllowed(browser), false);
  assert.equal(isDictationMicrophoneAllowed(allowedBrowser), true);
  assert.equal(isDictationMicrophoneAllowed(undefined), false);
});
