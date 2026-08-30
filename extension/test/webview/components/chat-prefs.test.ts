import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_PREF_MENU_SECTIONS,
  getChatPrefContextKey,
  getChatPrefContextLabel,
  getChatPrefContextValue,
  getSubagentBucketProviders,
  getToolCallContextType,
  isAskUserForSubagentsEnabled,
  isSubagentProviderEnabled,
  setAskUserForSubagents,
  setBucketAssignments,
  setNestedAllowedBucket,
  setSubagentBucketCanSpawn,
  setSubagentProviderDefaultEnabled,
  setSubagentProviderEnabled,
  toggleChatPref,
  toggleChatPrefForContext,
} from '../../../src/webview/panel/chat-prefs';
import type { ChatPrefs, ModelInfo } from '../../../src/shared/protocol';

const prefs: ChatPrefs = {
  autoExpandReasoning: false,
  autoExpandToolCalls: true,
  autoExpandSubagentCalls: false,
  suppressCompletionNotifications: false,
  showPruningMessages: true,
  autonomousMode: false,
  mcpEnabled: true,
  subagentAlwaysParentModel: false,
  subagentRouteAroundSaturatedProviders: false,
  subagentFallbackOnProviderFailure: true,
  runtimeAuditLog: false,
  subagentMaxDepth: 3,
  subagentMaxTreeSessions: 10,
  subagentMaxInflight: 2,
  bashWarmPoolSize: 2,
  bashFastPath: true,
  bashShellPath: '',
  bashWarmupTimeoutMs: 0,
  bashAcquireTimeoutMs: 0,
  bashDefaultTimeout: 60,
  subagentBuckets: { small: [], medium: [], frontier: [] },
  subagentNestedAllowedBuckets: { small: true, medium: true, frontier: true },
  subagentBucketCanSpawn: { small: true, medium: true, frontier: true },
  subagentDropTools: [],
  completionSoundVolume: 50,
  uiBaseFontSize: 13,
  uiComposerFontSize: 13,
  composerInitialRows: 1,
  expandedSectionFontSize: 12,
  expandedSectionMaxHeight: 240,
  uiFontSans: '',
  uiFontMono: '',
  uiAccentColor: '',
  uiMutedColor: '',
  uiLinkColor: '',
  uiPathParentDepth: 1,
  uiMessageWidth: 88,
  uiBackground: '',
  uiForeground: '',
  uiBorder: '',
  uiCornerRadius: 8,
  uiDensity: 'comfortable',
  historyCompaction: {
    enabled: true,
    thresholdMode: 'percentage',
    softThreshold: 70,
    hardThreshold: 85,
    keepRecentTokens: 30_000,
    summaryInstructions: '',
    summaryThinkingLevel: 'inherit',
    summaryModel: null,
    modelProfiles: {},
  },
  extensionToggles: {},
  providerToggles: {},
  subagentProviderDefaults: {},
  subagentProviderTogglesBySession: {},
  providerConcurrency: {},
  activityTailLines: 2,
  uiMessageRailSize: 18,
  hideStatusStrip: false,
  hideTokenRate: false,
  hideSessionTokens: false,
  hideSessionCost: false,
  hideContextIndicator: false,
  hideRunStatus: false,
};

test('chat pref menu sections expose transcript, display, notifications, and diagnostics toggles', () => {
  assert.equal(CHAT_PREF_MENU_SECTIONS.length, 4);
  assert.equal(CHAT_PREF_MENU_SECTIONS[0]?.id, 'transcript');
  assert.deepEqual(
    CHAT_PREF_MENU_SECTIONS[0]?.items.map((item) => item.key),
    ['autoExpandReasoning', 'autoExpandToolCalls', 'autoExpandSubagentCalls'],
  );
  assert.equal(CHAT_PREF_MENU_SECTIONS[1]?.id, 'display');
  assert.deepEqual(
    CHAT_PREF_MENU_SECTIONS[1]?.items.map((item) => item.key),
    ['hideStatusStrip', 'hideTokenRate', 'hideSessionTokens', 'hideSessionCost', 'hideContextIndicator', 'hideRunStatus'],
  );
  assert.equal(CHAT_PREF_MENU_SECTIONS[2]?.id, 'notifications');
  assert.deepEqual(
    CHAT_PREF_MENU_SECTIONS[2]?.items.map((item) => item.key),
    ['suppressCompletionNotifications'],
  );
  assert.equal(CHAT_PREF_MENU_SECTIONS[3]?.id, 'diagnostics');
  assert.deepEqual(
    CHAT_PREF_MENU_SECTIONS[3]?.items.map((item) => item.key),
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
  assert.deepEqual(toggleChatPref(prefs, 'subagentRouteAroundSaturatedProviders'), {
    subagentRouteAroundSaturatedProviders: true,
  });
  assert.deepEqual(toggleChatPref(prefs, 'subagentFallbackOnProviderFailure'), {
    subagentFallbackOnProviderFailure: false,
  });
  assert.deepEqual(toggleChatPrefForContext(prefs, 'toolCalls'), { autoExpandToolCalls: false });
  assert.deepEqual(toggleChatPrefForContext(prefs, 'subagentCalls'), { autoExpandSubagentCalls: true });
  assert.deepEqual(prefs, {
    autoExpandReasoning: false,
    autoExpandToolCalls: true,
    autoExpandSubagentCalls: false,
    suppressCompletionNotifications: false,
    showPruningMessages: true,
    autonomousMode: false,
    mcpEnabled: true,
    subagentAlwaysParentModel: false,
    subagentRouteAroundSaturatedProviders: false,
    subagentFallbackOnProviderFailure: true,
    runtimeAuditLog: false,
    subagentMaxDepth: 3,
    subagentMaxTreeSessions: 10,
    subagentMaxInflight: 2,
    bashWarmPoolSize: 2,
    bashFastPath: true,
    bashShellPath: '',
    bashWarmupTimeoutMs: 0,
    bashAcquireTimeoutMs: 0,
    bashDefaultTimeout: 60,
    subagentBuckets: { small: [], medium: [], frontier: [] },
    subagentNestedAllowedBuckets: { small: true, medium: true, frontier: true },
    subagentBucketCanSpawn: { small: true, medium: true, frontier: true },
    subagentDropTools: [],
    completionSoundVolume: 50,
    uiBaseFontSize: 13,
    uiComposerFontSize: 13,
    composerInitialRows: 1,
    expandedSectionFontSize: 12,
    expandedSectionMaxHeight: 240,
    uiFontSans: '',
    uiFontMono: '',
    uiAccentColor: '',
    uiMutedColor: '',
    uiLinkColor: '',
    uiPathParentDepth: 1,
    uiMessageWidth: 88,
    uiBackground: '',
    uiForeground: '',
    uiBorder: '',
    uiCornerRadius: 8,
    uiDensity: 'comfortable',
    historyCompaction: {
      enabled: true,
      thresholdMode: 'percentage',
      softThreshold: 70,
      hardThreshold: 85,
      keepRecentTokens: 30_000,
      summaryInstructions: '',
      summaryThinkingLevel: 'inherit',
      summaryModel: null,
      modelProfiles: {},
    },
    extensionToggles: {},
    providerToggles: {},
    subagentProviderDefaults: {},
    subagentProviderTogglesBySession: {},
    providerConcurrency: {},
    activityTailLines: 2,
    uiMessageRailSize: 18,
    hideStatusStrip: false,
    hideTokenRate: false,
    hideSessionTokens: false,
    hideSessionCost: false,
    hideContextIndicator: false,
    hideRunStatus: false,
  });
});

test('subagent provider defaults are inherited and session overrides take precedence', () => {
  const configured: ChatPrefs = {
    ...prefs,
    subagentProviderDefaults: { anthropic: false, openai: true },
    subagentProviderTogglesBySession: {
      '/session/a.jsonl': { anthropic: true },
    },
  };

  assert.equal(isSubagentProviderEnabled(configured, 'anthropic'), false);
  assert.equal(isSubagentProviderEnabled(configured, 'anthropic', '/session/a.jsonl'), true);
  assert.equal(isSubagentProviderEnabled(configured, 'anthropic', '/session/b.jsonl'), false);
  assert.equal(isSubagentProviderEnabled(configured, 'unconfigured', '/session/a.jsonl'), true);
});

test('subagent provider helpers only list bucket-backed providers and update defaults immutably', () => {
  const configured: ChatPrefs = {
    ...prefs,
    subagentBuckets: {
      small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
      medium: [{ model: 'openai/gpt-5', thinkingLevel: 'medium' }],
      frontier: [{ model: 'anthropic/haiku', thinkingLevel: 'low' }],
    },
  };
  const providers = getSubagentBucketProviders(configured, [
    { id: 'haiku', name: 'Haiku', provider: 'anthropic', reasoning: false, inputKinds: ['text'] },
    { id: 'gpt-5', name: 'GPT-5', provider: 'openai', reasoning: true, inputKinds: ['text'] },
    { id: 'unused', name: 'Unused', provider: 'google', reasoning: false, inputKinds: ['text'] },
  ]);
  assert.deepEqual(providers, ['anthropic', 'openai']);

  const patch = setSubagentProviderDefaultEnabled(configured, 'anthropic', false);
  assert.deepEqual(patch.subagentProviderDefaults, { anthropic: false });
  assert.deepEqual(configured.subagentProviderDefaults, {});
});

test('subagent provider helpers preserve providers from qualified duplicate-id bucket entries', () => {
  const configured: ChatPrefs = {
    ...prefs,
    subagentBuckets: {
      small: [],
      medium: [
        { model: 'github-copilot/gpt-5.6-sol', thinkingLevel: 'high' },
        { model: 'openai-codex/gpt-5.6-sol', thinkingLevel: 'high' },
      ],
      frontier: [],
    },
  };
  const providers = getSubagentBucketProviders(configured, [
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 SOL', provider: 'github-copilot', reasoning: true, inputKinds: ['text'] },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 SOL', provider: 'openai-codex', reasoning: true, inputKinds: ['text'] },
  ]);
  assert.deepEqual(providers, ['github-copilot', 'openai-codex']);

  assert.deepEqual(
    getSubagentBucketProviders(configured, []),
    ['github-copilot', 'openai-codex'],
    'qualified bucket assignments keep their provider toggles during a temporary catalog contraction',
  );
});

test('subagent provider helpers preserve explicit routes for legacy bare-id buckets', () => {
  const configured: ChatPrefs = {
    ...prefs,
    subagentBuckets: {
      small: [],
      medium: [{ model: 'gpt-5.6-sol', thinkingLevel: 'high' }],
      frontier: [],
    },
    subagentProviderDefaults: { 'openai-codex': true, anthropic: false },
    subagentProviderTogglesBySession: {
      '/session/a.jsonl': { ollama: true, umans: false },
    },
  };
  const contractedCatalog: ModelInfo[] = [
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 SOL', provider: 'github-copilot', reasoning: true, inputKinds: ['text'] },
  ];

  assert.deepEqual(
    getSubagentBucketProviders(configured, contractedCatalog),
    ['anthropic', 'github-copilot', 'openai-codex'],
  );
  assert.deepEqual(
    getSubagentBucketProviders(configured, contractedCatalog, '/session/a.jsonl'),
    ['anthropic', 'github-copilot', 'ollama', 'openai-codex', 'umans'],
  );
});

test('setSubagentProviderEnabled scopes provider state to one session', () => {
  const result = setSubagentProviderEnabled(prefs, '/session/a.jsonl', 'cheap-provider', false);
  assert.deepEqual(result.subagentProviderTogglesBySession, {
    '/session/a.jsonl': { 'cheap-provider': false },
  });
  assert.deepEqual(prefs.subagentProviderTogglesBySession, {});
});

test('setBucketAssignments replaces one bucket without mutating source prefs', () => {
  const before = prefs.subagentBuckets;
  const assignments = [
    { model: 'anthropic/sonnet', thinkingLevel: 'high' as const },
    { model: 'anthropic/opus', thinkingLevel: 'xhigh' as const },
  ];
  const patch = setBucketAssignments(prefs, 'medium', assignments);
  assert.deepEqual(patch, {
    subagentBuckets: {
      small: [],
      medium: assignments,
      frontier: [],
    },
  });
  // source prefs untouched (and the original bucket array reference unchanged)
  assert.deepEqual(prefs.subagentBuckets, { small: [], medium: [], frontier: [] });
  assert.equal(prefs.subagentBuckets, before);
});

test('setBucketAssignments preserves the other two buckets', () => {
  const populated: ChatPrefs = {
    ...prefs,
    subagentBuckets: {
      small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
      medium: [{ model: 'anthropic/sonnet', thinkingLevel: 'medium' }],
      frontier: [{ model: 'anthropic/opus', thinkingLevel: 'high' }],
    },
  };
  const assignments = [
    { model: 'anthropic/opus', thinkingLevel: 'xhigh' as const },
    { model: 'openai/gpt-5', thinkingLevel: 'max' as const },
  ];
  const patch = setBucketAssignments(populated, 'frontier', assignments);
  assert.deepEqual(patch, {
    subagentBuckets: {
      small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
      medium: [{ model: 'anthropic/sonnet', thinkingLevel: 'medium' }],
      frontier: assignments,
    },
  });
  assert.deepEqual(populated.subagentBuckets, {
    small: [{ model: 'anthropic/haiku', thinkingLevel: 'off' }],
    medium: [{ model: 'anthropic/sonnet', thinkingLevel: 'medium' }],
    frontier: [{ model: 'anthropic/opus', thinkingLevel: 'high' }],
  });
});

test('setSubagentBucketCanSpawn toggles one tier without mutating source prefs', () => {
  const before = prefs.subagentBucketCanSpawn;
  const patch = setSubagentBucketCanSpawn(prefs, 'medium', false);
  assert.deepEqual(patch, {
    subagentBucketCanSpawn: { small: true, medium: false, frontier: true },
  });
  assert.deepEqual(prefs.subagentBucketCanSpawn, { small: true, medium: true, frontier: true });
  assert.equal(prefs.subagentBucketCanSpawn, before);
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

test('isAskUserForSubagentsEnabled reflects the drop-tools list', () => {
  assert.equal(isAskUserForSubagentsEnabled(prefs), true);
  const dropped: ChatPrefs = { ...prefs, subagentDropTools: ['ask_user'] };
  assert.equal(isAskUserForSubagentsEnabled(dropped), false);
  // Other tools in the list do not affect ask_user membership.
  const others: ChatPrefs = { ...prefs, subagentDropTools: ['web_search'] };
  assert.equal(isAskUserForSubagentsEnabled(others), true);
});

test('setAskUserForSubagents adds ask_user when disabling and removes it when enabling', () => {
  // Disabling on an empty list adds ask_user.
  const disablePatch = setAskUserForSubagents(prefs, false);
  assert.deepEqual(disablePatch, { subagentDropTools: ['ask_user'] });
  // Source prefs untouched.
  assert.deepEqual(prefs.subagentDropTools, []);

  // Disabling is idempotent — already-present ask_user is not duplicated.
  const alreadyDropped: ChatPrefs = { ...prefs, subagentDropTools: ['ask_user', 'web_search'] };
  const idempotent = setAskUserForSubagents(alreadyDropped, false);
  assert.deepEqual(idempotent, { subagentDropTools: ['ask_user', 'web_search'] });

  // Enabling removes ask_user while preserving other dropped tools.
  const enablePatch = setAskUserForSubagents(alreadyDropped, true);
  assert.deepEqual(enablePatch, { subagentDropTools: ['web_search'] });

  // Enabling when ask_user is not present is a no-op (returns an equivalent list
  // without ask_user — no mutation of source).
  const clean: ChatPrefs = { ...prefs, subagentDropTools: ['web_search'] };
  const noOp = setAskUserForSubagents(clean, true);
  assert.deepEqual(noOp, { subagentDropTools: ['web_search'] });
  assert.deepEqual(clean.subagentDropTools, ['web_search']);
});
