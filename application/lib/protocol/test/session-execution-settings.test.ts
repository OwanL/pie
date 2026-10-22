import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWebviewToHostMessage } from '../../validation/protocol-validation.js';

import {
  buildRuntimePrefsPayload,
  resolveAutonomousModeForSession,
  resolveChatPrefs,
  mergeChatPrefs,
  resolveSubagentBucketChoices,
  resolveSubagentProviderChoices,
} from '../settings.js';

test('chat preferences resolve autonomous overrides per root and mirror the map to runtime preferences', () => {
  const prefs = resolveChatPrefs({
    autonomousMode: false,
    autonomousModeBySession: { '/sessions/on.jsonl': true, '/sessions/off.jsonl': false, ignored: 'yes' },
  } as unknown as Parameters<typeof resolveChatPrefs>[0]);
  assert.equal(resolveAutonomousModeForSession(prefs, '/sessions/on.jsonl'), true);
  assert.equal(resolveAutonomousModeForSession(prefs, '/sessions/off.jsonl'), false);
  assert.equal(resolveAutonomousModeForSession(prefs, '/sessions/inherit.jsonl'), false);
  assert.deepEqual(prefs.autonomousModeBySession, {
    '/sessions/on.jsonl': true,
    '/sessions/off.jsonl': false,
  });
  assert.deepEqual(buildRuntimePrefsPayload(prefs).autonomousModeBySession, prefs.autonomousModeBySession);
});

test('bucket choices default safely, replace whole entries, survive restore and mirror to runtime', () => {
  const all = { small: true, medium: true, frontier: true };
  const small = { small: true, medium: false, frontier: false };
  const frontier = { small: false, medium: false, frontier: true };
  const original = resolveChatPrefs({ subagentBucketTogglesBySession: { a: small, b: frontier } });
  assert.deepEqual(resolveSubagentBucketChoices(resolveChatPrefs(), 'legacy'), all);
  const merged = mergeChatPrefs(original, { subagentBucketTogglesBySession: { a: frontier } });
  assert.deepEqual(merged.subagentBucketTogglesBySession, { a: frontier, b: frontier });
  assert.deepEqual(original.subagentBucketTogglesBySession.a, small);
  const restored = resolveChatPrefs(JSON.parse(JSON.stringify(merged)));
  assert.deepEqual(buildRuntimePrefsPayload(restored).subagentBucketTogglesBySession, merged.subagentBucketTogglesBySession);
  for (const invalid of [{ small: false, medium: false, frontier: false }, { small: true }, null, { ...all, extra: true }]) {
    const prefs = resolveChatPrefs({ subagentBucketTogglesBySession: { invalid } } as unknown as Parameters<typeof resolveChatPrefs>[0]);
    assert.deepEqual(resolveSubagentBucketChoices(prefs, 'invalid'), all);
  }
});

test('setPrefs rejects incomplete, extra-key, nonboolean and all-off bucket entries atomically', () => {
  const valid = { small: true, medium: false, frontier: false };
  const validate = (entry: unknown) => validateWebviewToHostMessage({
    type: 'setPrefs', prefs: { subagentBucketTogglesBySession: { a: valid, b: entry } },
  }).ok;
  assert.equal(validate(valid), true);
  for (const invalid of [{ small: true }, { ...valid, extra: true }, { ...valid, medium: 1 }, { small: false, medium: false, frontier: false }, null]) {
    assert.equal(validate(invalid), false);
  }
});

test('provider capture returns effective choices for exactly the configured surface', () => {
  const prefs = resolveChatPrefs({
    subagentBuckets: {
      small: [
        { model: 'openai/gpt-test', thinkingLevel: 'off' },
        { model: 'legacy-id', thinkingLevel: 'off' },
      ],
      medium: [],
      frontier: [],
    },
    subagentProviderDefaults: { anthropic: false, ollama: true },
    subagentProviderTogglesBySession: { '/sessions/root.jsonl': { openai: false, custom: true } },
  });
  assert.deepEqual(resolveSubagentProviderChoices(prefs, '/sessions/root.jsonl', [
    { id: 'legacy-id', provider: 'copilot' },
    { id: 'legacy-id', provider: 'codex' },
  ]), {
    anthropic: false,
    codex: true,
    copilot: true,
    custom: true,
    ollama: true,
    openai: false,
  });
});
