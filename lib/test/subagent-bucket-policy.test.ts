import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SUBAGENT_BUCKET_CHOICES,
  isSubagentBucketChoices,
  normalizeSubagentBucketChoices,
  resolveEnabledSubagentBucket,
  SUBAGENT_BUCKET_TIERS,
  type SubagentBucketChoices,
  type SubagentBucketTier,
} from '../subagent-bucket-policy';

test('tier constants and default choices expose the complete permissive selection', () => {
  assert.deepEqual(SUBAGENT_BUCKET_TIERS, ['small', 'medium', 'frontier']);
  assert.deepEqual(DEFAULT_SUBAGENT_BUCKET_CHOICES, { small: true, medium: true, frontier: true });
});

test('choice guard accepts exactly the seven complete non-empty selections', () => {
  const validSelections: SubagentBucketChoices[] = [
    { small: true, medium: false, frontier: false },
    { small: false, medium: true, frontier: false },
    { small: false, medium: false, frontier: true },
    { small: true, medium: true, frontier: false },
    { small: true, medium: false, frontier: true },
    { small: false, medium: true, frontier: true },
    { small: true, medium: true, frontier: true },
  ];
  for (const choices of validSelections) assert.equal(isSubagentBucketChoices(choices), true);
  assert.equal(isSubagentBucketChoices({ small: false, medium: false, frontier: false }), false);
});

test('resolution checks requested tier, then nearest lower, then nearest higher', () => {
  const cases: Array<{ choices: SubagentBucketChoices; expected: [SubagentBucketTier, SubagentBucketTier, SubagentBucketTier] }> = [
    { choices: { small: true, medium: false, frontier: false }, expected: ['small', 'small', 'small'] },
    { choices: { small: false, medium: true, frontier: false }, expected: ['medium', 'medium', 'medium'] },
    { choices: { small: false, medium: false, frontier: true }, expected: ['frontier', 'frontier', 'frontier'] },
    { choices: { small: true, medium: true, frontier: false }, expected: ['small', 'medium', 'medium'] },
    { choices: { small: true, medium: false, frontier: true }, expected: ['small', 'small', 'frontier'] },
    { choices: { small: false, medium: true, frontier: true }, expected: ['medium', 'medium', 'frontier'] },
    { choices: { small: true, medium: true, frontier: true }, expected: ['small', 'medium', 'frontier'] },
  ];
  for (const { choices, expected } of cases) {
    SUBAGENT_BUCKET_TIERS.forEach((requested, index) => {
      assert.equal(resolveEnabledSubagentBucket(requested, choices), expected[index], `${JSON.stringify(choices)} requested ${requested}`);
    });
  }
});

test('nested allowed-bucket restrictions are never bypassed', () => {
  const choices = { small: true, medium: true, frontier: true };
  assert.equal(resolveEnabledSubagentBucket('medium', choices, new Set()), undefined);
  assert.equal(resolveEnabledSubagentBucket('frontier', choices, new Set(['small'])), 'small');
  assert.equal(resolveEnabledSubagentBucket('small', choices, new Set(['frontier'])), 'frontier');
});

test('choice guard rejects malformed, incomplete, empty, and extra-key values', () => {
  for (const malformed of [
    null,
    undefined,
    [],
    { small: true, medium: false },
    { small: true, medium: false, frontier: false, extra: true },
    { small: true, medium: 1, frontier: false },
    { small: false, medium: false, frontier: false },
  ]) assert.equal(isSubagentBucketChoices(malformed), false, JSON.stringify(malformed));
});

test('normalization returns a valid independent copy or the all-enabled default', () => {
  const persisted = { small: true, medium: false, frontier: true };
  const normalized = normalizeSubagentBucketChoices(persisted);
  assert.deepEqual(normalized, persisted);
  assert.notEqual(normalized, persisted);
  assert.deepEqual(normalizeSubagentBucketChoices({ small: false, medium: false, frontier: false }), DEFAULT_SUBAGENT_BUCKET_CHOICES);
  assert.notEqual(normalizeSubagentBucketChoices(null), DEFAULT_SUBAGENT_BUCKET_CHOICES);
});
