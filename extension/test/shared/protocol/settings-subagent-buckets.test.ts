import test from 'node:test';
import assert from 'node:assert/strict';

import type { ChatPrefs } from '../../../src/shared/protocol';
import {
  ALL_NESTED_BUCKETS_ALLOWED,
  ALL_SUBAGENT_BUCKETS_CAN_SPAWN,
  DEFAULT_CHAT_PREFS,
  EMPTY_SUBAGENT_BUCKETS,
  normalizeBooleanMap,
  normalizeNestedAllowedBuckets,
  normalizeSubagentBucketCanSpawn,
  normalizeSubagentBuckets,
  resolveChatPrefs,
} from '../../../src/shared/protocol';

test('subagent provider defaults are empty and malformed stored values are normalized', () => {
  assert.deepEqual(DEFAULT_CHAT_PREFS.subagentProviderDefaults, {});
  assert.deepEqual(normalizeBooleanMap({ anthropic: false, openai: true, invalid: 'no' }), {
    anthropic: false,
    openai: true,
  });
  assert.deepEqual(resolveChatPrefs({
    // @ts-expect-error intentionally malformed stored value
    subagentProviderDefaults: { anthropic: false, invalid: 'no' },
  }).subagentProviderDefaults, { anthropic: false });
});

test('DEFAULT_CHAT_PREFS keeps busy-provider routing off and provider-failure fallback on', () => {
  assert.equal(DEFAULT_CHAT_PREFS.subagentRouteAroundSaturatedProviders, false);
  assert.equal(resolveChatPrefs(null).subagentRouteAroundSaturatedProviders, false);
  assert.equal(DEFAULT_CHAT_PREFS.subagentFallbackOnProviderFailure, true);
  assert.equal(resolveChatPrefs(null).subagentFallbackOnProviderFailure, true);
  assert.equal(resolveChatPrefs({ subagentFallbackOnProviderFailure: false }).subagentFallbackOnProviderFailure, false);
});

test('DEFAULT_CHAT_PREFS seeds empty subagent buckets', () => {
  assert.deepEqual(DEFAULT_CHAT_PREFS.subagentBuckets, { small: [], medium: [], frontier: [] });
  // and a distinct copy, not the shared EMPTY_SUBAGENT_BUCKETS reference
  assert.notEqual(DEFAULT_CHAT_PREFS.subagentBuckets, EMPTY_SUBAGENT_BUCKETS);
});

test('normalizeSubagentBuckets returns empty buckets for non-object input', () => {
  assert.deepEqual(normalizeSubagentBuckets(undefined), { small: [], medium: [], frontier: [] });
  assert.deepEqual(normalizeSubagentBuckets(null), { small: [], medium: [], frontier: [] });
  assert.deepEqual(normalizeSubagentBuckets(['a']), { small: [], medium: [], frontier: [] });
  assert.deepEqual(normalizeSubagentBuckets('nope'), { small: [], medium: [], frontier: [] });
});

test('normalizeSubagentBuckets coerces explicit model/reasoning assignments', () => {
  assert.deepEqual(
    normalizeSubagentBuckets({
      small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
      medium: [{ model: 'anthropic/sonnet', thinkingLevel: 'high' }],
      frontier: [{ model: 'anthropic/opus', thinkingLevel: 'max' }],
    }),
    {
      small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
      medium: [{ model: 'anthropic/sonnet', thinkingLevel: 'high' }],
      frontier: [{ model: 'anthropic/opus', thinkingLevel: 'max' }],
    },
  );
});

test('normalizeSubagentBuckets drops legacy string bucket preferences', () => {
  assert.deepEqual(
    normalizeSubagentBuckets({ small: ['haiku'], medium: ['sonnet'], frontier: ['opus'] }),
    { small: [], medium: [], frontier: [] },
  );
});

test('normalizeSubagentBuckets drops malformed assignments', () => {
  assert.deepEqual(
    normalizeSubagentBuckets({
      small: 'haiku',
      medium: [1, { model: 'sonnet', thinkingLevel: 'bogus' }, { model: '', thinkingLevel: 'low' }],
      frontier: [{ model: 'opus', thinkingLevel: 'high' }, 'legacy'],
    }),
    { small: [], medium: [], frontier: [{ model: 'opus', thinkingLevel: 'high' }] },
  );
});

test('normalizeSubagentBuckets defaults missing bucket keys to empty', () => {
  assert.deepEqual(
    normalizeSubagentBuckets({ medium: [{ model: 'anthropic/sonnet', thinkingLevel: 'medium' }] }),
    {
      small: [],
      medium: [{ model: 'anthropic/sonnet', thinkingLevel: 'medium' }],
      frontier: [],
    },
  );
});

test('resolveChatPrefs fills subagentBuckets from defaults when absent', () => {
  const resolved = resolveChatPrefs(null);
  assert.deepEqual(resolved.subagentBuckets, { small: [], medium: [], frontier: [] });
});

test('resolveChatPrefs normalizes a malformed stored subagentBuckets', () => {
  const resolved = resolveChatPrefs({
    subagentBuckets: {
      small: 'haiku',
      medium: [{ model: 'sonnet', thinkingLevel: 'bogus' }],
      frontier: null,
    } as unknown as ChatPrefs['subagentBuckets'],
  });
  assert.deepEqual(resolved.subagentBuckets, { small: [], medium: [], frontier: [] });
});

test('resolveChatPrefs preserves a valid stored subagentBuckets', () => {
  const resolved = resolveChatPrefs({
    subagentBuckets: {
      small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
      medium: [{ model: 'anthropic/sonnet', thinkingLevel: 'medium' }],
      frontier: [{ model: 'anthropic/opus', thinkingLevel: 'xhigh' }],
    },
  });
  assert.deepEqual(resolved.subagentBuckets, {
    small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
    medium: [{ model: 'anthropic/sonnet', thinkingLevel: 'medium' }],
    frontier: [{ model: 'anthropic/opus', thinkingLevel: 'xhigh' }],
  });
});

test('thinking levels keep xhigh and max as distinct supported values', () => {
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
  assert.notEqual(levels.indexOf('xhigh'), levels.indexOf('max'));
  assert.equal(normalizeSubagentBuckets({ small: [{ model: 'm', thinkingLevel: 'xhigh' }] }).small[0]?.thinkingLevel, 'xhigh');
  assert.equal(normalizeSubagentBuckets({ small: [{ model: 'm', thinkingLevel: 'max' }] }).small[0]?.thinkingLevel, 'max');
});

test('DEFAULT_CHAT_PREFS seeds all nested buckets allowed', () => {
  assert.deepEqual(DEFAULT_CHAT_PREFS.subagentNestedAllowedBuckets, { small: true, medium: true, frontier: true });
  // distinct copy, not the shared ALL_NESTED_BUCKETS_ALLOWED reference
  assert.notEqual(DEFAULT_CHAT_PREFS.subagentNestedAllowedBuckets, ALL_NESTED_BUCKETS_ALLOWED);
});

test('normalizeNestedAllowedBuckets returns all-allowed for non-object input', () => {
  assert.deepEqual(normalizeNestedAllowedBuckets(undefined), { small: true, medium: true, frontier: true });
  assert.deepEqual(normalizeNestedAllowedBuckets(null), { small: true, medium: true, frontier: true });
  assert.deepEqual(normalizeNestedAllowedBuckets(['a']), { small: true, medium: true, frontier: true });
  assert.deepEqual(normalizeNestedAllowedBuckets('nope'), { small: true, medium: true, frontier: true });
});

test('normalizeNestedAllowedBuckets coerces a well-formed value', () => {
  assert.deepEqual(
    normalizeNestedAllowedBuckets({ small: true, medium: false, frontier: false }),
    { small: true, medium: false, frontier: false },
  );
});

test('normalizeNestedAllowedBuckets defaults missing keys to allowed (true)', () => {
  assert.deepEqual(
    normalizeNestedAllowedBuckets({ frontier: false }),
    { small: true, medium: true, frontier: false },
  );
});

test('normalizeNestedAllowedBuckets treats non-boolean values as allowed (true)', () => {
  assert.deepEqual(
    normalizeNestedAllowedBuckets({ frontier: 'no', medium: 1 }),
    { small: true, medium: true, frontier: true },
  );
});

test('resolveChatPrefs fills subagentNestedAllowedBuckets from defaults when absent', () => {
  const resolved = resolveChatPrefs(null);
  assert.deepEqual(resolved.subagentNestedAllowedBuckets, { small: true, medium: true, frontier: true });
});

test('resolveChatPrefs normalizes a malformed stored subagentNestedAllowedBuckets', () => {
  const resolved = resolveChatPrefs({
    // @ts-expect-error intentionally malformed stored value
    subagentNestedAllowedBuckets: { frontier: 'no', medium: 1 },
  });
  assert.deepEqual(resolved.subagentNestedAllowedBuckets, { small: true, medium: true, frontier: true });
});

test('resolveChatPrefs preserves a valid stored subagentNestedAllowedBuckets', () => {
  const resolved = resolveChatPrefs({
    subagentNestedAllowedBuckets: { small: true, medium: true, frontier: false },
  });
  assert.deepEqual(resolved.subagentNestedAllowedBuckets, { small: true, medium: true, frontier: false });
});

test('subagent bucket delegation defaults to allowed and normalizes fail-open', () => {
  assert.deepEqual(DEFAULT_CHAT_PREFS.subagentBucketCanSpawn, { small: true, medium: true, frontier: true });
  assert.notEqual(DEFAULT_CHAT_PREFS.subagentBucketCanSpawn, ALL_SUBAGENT_BUCKETS_CAN_SPAWN);
  assert.deepEqual(normalizeSubagentBucketCanSpawn(undefined), { small: true, medium: true, frontier: true });
  assert.deepEqual(
    normalizeSubagentBucketCanSpawn({ small: false, medium: 'invalid', frontier: true }),
    { small: false, medium: true, frontier: true },
  );
  assert.deepEqual(
    resolveChatPrefs({ subagentBucketCanSpawn: { small: false, medium: false, frontier: true } }).subagentBucketCanSpawn,
    { small: false, medium: false, frontier: true },
  );
});
