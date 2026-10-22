import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimePrefsSet } from '../backend-rpc.js';
import { validateSessionControlSettingsRequest, validateSessionControlSettingsAcknowledgement } from '../session-control-settings.js';

const choices = { small: false, medium: true, frontier: false };
const envelope = { requestId: 'buckets', sessionPath: '/sessions/root.jsonl', action: 'apply' };

test('runtime prefs transport preserves session bucket choices without replacing global buckets', () => {
  const result = validateRuntimePrefsSet({ subagentBucketTogglesBySession: { '/root': choices } });
  assert.deepEqual(result.subagentBucketTogglesBySession, { '/root': choices });
  assert.equal(result.subagentBuckets, undefined);
  assert.equal(validateRuntimePrefsSet({}).subagentBucketTogglesBySession, undefined);
});

test('private inheritance transport accepts complete choices and rejects invalid selections', () => {
  assert.deepEqual(validateSessionControlSettingsRequest({ ...envelope, settings: { subagentBucketChoices: choices } }).settings, { subagentBucketChoices: choices });
  for (const invalid of [{}, { small: true }, { small: false, medium: false, frontier: false }, { ...choices, other: true }]) {
    assert.throws(() => validateSessionControlSettingsRequest({ ...envelope, settings: { subagentBucketChoices: invalid } }));
    assert.throws(() => validateRuntimePrefsSet({ subagentBucketTogglesBySession: { '/root': invalid } }));
    assert.throws(() => validateSessionControlSettingsAcknowledgement({ ...envelope, outcome: 'succeeded', settings: { autonomousMode: false, subagentProviderChoices: {}, subagentBucketChoices: invalid } }));
  }
});
