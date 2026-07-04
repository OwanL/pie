import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_PREF_MENU_SECTIONS,
  getChatPrefContextKey,
  getChatPrefContextLabel,
  getChatPrefContextValue,
  getToolCallContextType,
  setBucketModels,
  setNestedAllowedBucket,
  toggleChatPref,
  toggleChatPrefForContext,
} from '../src/webview/panel/chat-prefs';
import type { ChatPrefs } from '../src/shared/protocol';

const prefs: ChatPrefs = {
  autoExpandReasoning: false,
  autoExpandToolCalls: true,
  autoExpandSubagentCalls: false,
  suppressCompletionNotifications: false,
  showPruningMessages: true,
  subagentAlwaysParentModel: false,
  runtimeAuditLog: false,
  subagentMaxDepth: 3,
  subagentMaxTreeSessions: 10,
  subagentMaxInflight: 2,
  subagentMaxConcurrency: 2,
  subagentMaxParallelTasks: 4,
  bashWarmPoolSize: 2,
  bashFastPath: true,
  bashShellPath: '',
  subagentBuckets: { small: [], medium: [], frontier: [] },
  subagentNestedAllowedBuckets: { small: true, medium: true, frontier: true },
  subagentDropTools: [],
  completionSoundVolume: 50,
  uiBaseFontSize: 13,
  uiComposerFontSize: 13,
  expandedSectionFontSize: 12,
  expandedSectionMaxHeight: 240,
  uiFontSans: '',
  uiFontMono: '',
  uiAccentColor: '',
  uiMutedColor: '',
  uiLinkColor: '',
  uiMessageWidth: 88,
  uiBackground: '',
  uiForeground: '',
  uiBorder: '',
  uiCornerRadius: 8,
  uiDensity: 'comfortable',
  extensionToggles: {},
  providerToggles: {},
  activityTailLines: 2,
  uiMessageRailSize: 18,
};

test('chat pref menu sections expose transcript, notifications, and diagnostics toggles', () => {
  assert.equal(CHAT_PREF_MENU_SECTIONS.length, 3);
  assert.equal(CHAT_PREF_MENU_SECTIONS[0]?.id, 'transcript');
  assert.deepEqual(
    CHAT_PREF_MENU_SECTIONS[0]?.items.map((item) => item.key),
    ['autoExpandReasoning', 'autoExpandToolCalls', 'autoExpandSubagentCalls'],
  );
  assert.equal(CHAT_PREF_MENU_SECTIONS[1]?.id, 'notifications');
  assert.deepEqual(
    CHAT_PREF_MENU_SECTIONS[1]?.items.map((item) => item.key),
    ['suppressCompletionNotifications'],
  );
  assert.equal(CHAT_PREF_MENU_SECTIONS[2]?.id, 'diagnostics');
  assert.deepEqual(
    CHAT_PREF_MENU_SECTIONS[2]?.items.map((item) => item.key),
    ['runtimeAuditLog'],
  );
});

test('context helpers map transcript block types to the right pref metadata', () => {
  assert.equal(getChatPrefContextKey('reasoning'), 'autoExpandReasoning');
  assert.equal(getChatPrefContextKey('toolCalls'), 'autoExpandToolCalls');
  assert.equal(getChatPrefContextKey('subagentCalls'), 'autoExpandSubagentCalls');
  assert.equal(getChatPrefContextLabel('reasoning'), 'Auto-expand reasoning');
  assert.equal(getChatPrefContextLabel('toolCalls'), 'Auto-expand tool calls');
  assert.equal(getChatPrefContextLabel('subagentCalls'), 'Auto-expand sub-agent calls');
  assert.equal(getChatPrefContextValue(prefs, 'reasoning'), false);
  assert.equal(getChatPrefContextValue(prefs, 'toolCalls'), true);
  assert.equal(getChatPrefContextValue(prefs, 'subagentCalls'), false);
  assert.equal(getToolCallContextType('read'), 'toolCalls');
  assert.equal(getToolCallContextType('subagent'), 'subagentCalls');
});

test('toggle helpers return partial pref patches without mutating source prefs', () => {
  assert.deepEqual(toggleChatPref(prefs, 'autoExpandReasoning'), { autoExpandReasoning: true });
  assert.deepEqual(toggleChatPref(prefs, 'suppressCompletionNotifications'), {
    suppressCompletionNotifications: true,
  });
  assert.deepEqual(toggleChatPref(prefs, 'runtimeAuditLog'), { runtimeAuditLog: true });
  assert.deepEqual(toggleChatPrefForContext(prefs, 'toolCalls'), { autoExpandToolCalls: false });
  assert.deepEqual(toggleChatPrefForContext(prefs, 'subagentCalls'), { autoExpandSubagentCalls: true });
  assert.deepEqual(prefs, {
    autoExpandReasoning: false,
    autoExpandToolCalls: true,
    autoExpandSubagentCalls: false,
    suppressCompletionNotifications: false,
    showPruningMessages: true,
    subagentAlwaysParentModel: false,
    runtimeAuditLog: false,
    subagentMaxDepth: 3,
    subagentMaxTreeSessions: 10,
    subagentMaxInflight: 2,
    subagentMaxConcurrency: 2,
    subagentMaxParallelTasks: 4,
    bashWarmPoolSize: 2,
    bashFastPath: true,
    bashShellPath: '',
    subagentBuckets: { small: [], medium: [], frontier: [] },
    subagentNestedAllowedBuckets: { small: true, medium: true, frontier: true },
  subagentDropTools: [],
    completionSoundVolume: 50,
    uiBaseFontSize: 13,
    uiComposerFontSize: 13,
    expandedSectionFontSize: 12,
    expandedSectionMaxHeight: 240,
    uiFontSans: '',
    uiFontMono: '',
    uiAccentColor: '',
    uiMutedColor: '',
    uiLinkColor: '',
    uiMessageWidth: 88,
    uiBackground: '',
    uiForeground: '',
    uiBorder: '',
    uiCornerRadius: 8,
    uiDensity: 'comfortable',
    extensionToggles: {},
    providerToggles: {},
    activityTailLines: 2,
    uiMessageRailSize: 18,
  });
});

test('setBucketModels replaces one bucket without mutating source prefs', () => {
  const before = prefs.subagentBuckets;
  const patch = setBucketModels(prefs, 'medium', ['sonnet', 'opus']);
  assert.deepEqual(patch, {
    subagentBuckets: {
      small: [],
      medium: ['sonnet', 'opus'],
      frontier: [],
    },
  });
  // source prefs untouched (and the original bucket array reference unchanged)
  assert.deepEqual(prefs.subagentBuckets, { small: [], medium: [], frontier: [] });
  assert.equal(prefs.subagentBuckets, before);
});

test('setBucketModels preserves the other two buckets', () => {
  const populated: ChatPrefs = {
    ...prefs,
    subagentBuckets: { small: ['haiku'], medium: ['sonnet'], frontier: ['opus'] },
  };
  const patch = setBucketModels(populated, 'frontier', ['opus', 'gpt-5']);
  assert.deepEqual(patch, {
    subagentBuckets: {
      small: ['haiku'],
      medium: ['sonnet'],
      frontier: ['opus', 'gpt-5'],
    },
  });
  assert.deepEqual(populated.subagentBuckets, { small: ['haiku'], medium: ['sonnet'], frontier: ['opus'] });
});

test('setNestedAllowedBucket toggles one tier without mutating source prefs', () => {
  const before = prefs.subagentNestedAllowedBuckets;
  const patch = setNestedAllowedBucket(prefs, 'frontier', false);
  assert.deepEqual(patch, {
    subagentNestedAllowedBuckets: { small: true, medium: true, frontier: false },
  });
  // source prefs untouched (and the original allowlist reference unchanged)
  assert.deepEqual(prefs.subagentNestedAllowedBuckets, { small: true, medium: true, frontier: true });
  assert.equal(prefs.subagentNestedAllowedBuckets, before);
});

test('setNestedAllowedBucket preserves the other two tiers', () => {
  const populated: ChatPrefs = {
    ...prefs,
    subagentNestedAllowedBuckets: { small: true, medium: false, frontier: false },
  };
  const patch = setNestedAllowedBucket(populated, 'medium', true);
  assert.deepEqual(patch, {
    subagentNestedAllowedBuckets: { small: true, medium: true, frontier: false },
  });
  assert.deepEqual(populated.subagentNestedAllowedBuckets, { small: true, medium: false, frontier: false });
});
