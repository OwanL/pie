import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRuntimePrefsPayload,
  resolveAutonomousModeForSession,
  resolveChatPrefs,
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
