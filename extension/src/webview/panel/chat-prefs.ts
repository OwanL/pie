import type { ChatPrefs, ModelInfo } from '../../shared/protocol';

export type BooleanPrefKey =
  | 'autoExpandReasoning'
  | 'autoExpandToolCalls'
  | 'autoExpandSubagentCalls'
  | 'suppressCompletionNotifications'
  | 'showPruningMessages'
  | 'subagentAlwaysParentModel'
  | 'subagentRouteAroundSaturatedProviders'
  | 'subagentFallbackOnProviderFailure'
  | 'runtimeAuditLog'
  | 'hideStatusStrip'
  | 'hideTokenRate'
  | 'hideSessionTokens'
  | 'hideSessionCost'
  | 'hideContextIndicator'
  | 'hideRunStatus';

export type ChatPrefKey = keyof ChatPrefs;
export type ChatPrefContextType = 'reasoning' | 'toolCalls' | 'subagentCalls';
export type TranscriptContextMenuType = ChatPrefContextType | 'message';

export interface ExtensionToggleItem {
  id: string;
  label: string;
}

export interface ChatPrefMenuItem {
  key: BooleanPrefKey;
  label: string;
}

export interface ChatPrefMenuSection {
  id: string;
  label?: string;
  items: ChatPrefMenuItem[];
}

const CHAT_PREF_CONTEXT_ITEMS: Record<ChatPrefContextType, ChatPrefMenuItem> = {
  reasoning: {
    key: 'autoExpandReasoning',
    label: 'Auto-expand reasoning',
  },
  toolCalls: {
    key: 'autoExpandToolCalls',
    label: 'Auto-expand tool calls',
  },
  subagentCalls: {
    key: 'autoExpandSubagentCalls',
    label: 'Auto-expand sub-agent calls',
  },
};

export const CHAT_PREF_MENU_SECTIONS: readonly ChatPrefMenuSection[] = [
  {
    id: 'transcript',
    label: 'Transcript',
    items: [
      CHAT_PREF_CONTEXT_ITEMS.reasoning,
      CHAT_PREF_CONTEXT_ITEMS.toolCalls,
      CHAT_PREF_CONTEXT_ITEMS.subagentCalls,
    ],
  },
  {
    id: 'display',
    label: 'Display',
    items: [
      {
        key: 'hideStatusStrip',
        label: 'Hide bottom usage strip',
      },
      {
        key: 'hideTokenRate',
        label: 'Hide tokens/sec',
      },
      {
        key: 'hideSessionTokens',
        label: 'Hide session tokens',
      },
      {
        key: 'hideSessionCost',
        label: 'Hide session cost',
      },
      {
        key: 'hideContextIndicator',
        label: 'Hide context usage',
      },
      {
        key: 'hideRunStatus',
        label: 'Hide run status',
      },
    ],
  },
  {
    id: 'notifications',
    label: 'Alerts',
    items: [
      {
        key: 'suppressCompletionNotifications',
        label: 'Suppress completion alerts',
      },
    ],
  },
  {
    id: 'diagnostics',
    label: 'Diagnostics',
    items: [
      {
        key: 'runtimeAuditLog',
        label: 'Emit audit logs to exthost.log',
      },
    ],
  },
] as const;

export function toggleChatPref(prefs: ChatPrefs, key: BooleanPrefKey): Partial<ChatPrefs> {
  return { [key]: !prefs[key] } as Partial<ChatPrefs>;
}

export function getChatPrefContextKey(type: ChatPrefContextType): BooleanPrefKey {
  return CHAT_PREF_CONTEXT_ITEMS[type].key;
}

export function getChatPrefContextLabel(type: ChatPrefContextType): string {
  return CHAT_PREF_CONTEXT_ITEMS[type].label;
}

export function getChatPrefContextValue(prefs: ChatPrefs, type: ChatPrefContextType): boolean {
  return prefs[getChatPrefContextKey(type)];
}

export function toggleChatPrefForContext(
  prefs: ChatPrefs,
  type: ChatPrefContextType,
): Partial<ChatPrefs> {
  return toggleChatPref(prefs, getChatPrefContextKey(type));
}

export function getToolCallContextType(toolName: string): Exclude<ChatPrefContextType, 'reasoning'> {
  return toolName === 'subagent' ? 'subagentCalls' : 'toolCalls';
}

export function setExtensionEnabled(prefs: ChatPrefs, extensionId: string, enabled: boolean): Partial<ChatPrefs> {
  return {
    extensionToggles: {
      ...prefs.extensionToggles,
      [extensionId]: enabled,
    },
  };
}
export function setProviderEnabled(prefs: ChatPrefs, provider: string, enabled: boolean): Partial<ChatPrefs> {
  return {
    providerToggles: {
      ...prefs.providerToggles,
      [provider]: enabled,
    },
  };
}

/** Providers represented by at least one model in a configured subagent bucket. */
export function getSubagentBucketProviders(prefs: ChatPrefs, availableModels: ModelInfo[]): string[] {
  const bucketIds = new Set([
    ...prefs.subagentBuckets.small,
    ...prefs.subagentBuckets.medium,
    ...prefs.subagentBuckets.frontier,
  ]);
  return [...new Set(
    availableModels.filter((model) => bucketIds.has(model.id)).map((model) => model.provider),
  )].sort((a, b) => a.localeCompare(b));
}

/** Effective provider state in a session: explicit override → default → enabled. */
export function isSubagentProviderEnabled(
  prefs: ChatPrefs,
  provider: string,
  sessionPath?: string | null,
): boolean {
  const sessionValue = sessionPath
    ? prefs.subagentProviderTogglesBySession[sessionPath]?.[provider]
    : undefined;
  return sessionValue ?? prefs.subagentProviderDefaults[provider] ?? true;
}

/** Set the default state inherited by sessions without an explicit override. */
export function setSubagentProviderDefaultEnabled(
  prefs: ChatPrefs,
  provider: string,
  enabled: boolean,
): Partial<ChatPrefs> {
  return {
    subagentProviderDefaults: {
      ...prefs.subagentProviderDefaults,
      [provider]: enabled,
    },
  };
}

/** Toggle a provider only for subagents launched by one chat session. */
export function setSubagentProviderEnabled(
  prefs: ChatPrefs,
  sessionPath: string,
  provider: string,
  enabled: boolean,
): Partial<ChatPrefs> {
  return {
    subagentProviderTogglesBySession: {
      ...prefs.subagentProviderTogglesBySession,
      [sessionPath]: {
        ...(prefs.subagentProviderTogglesBySession[sessionPath] ?? {}),
        [provider]: enabled,
      },
    },
  };
}

/** Replace one bucket's model list, preserving the other two buckets. */
export function setBucketModels(
  prefs: ChatPrefs,
  bucket: 'small' | 'medium' | 'frontier',
  models: string[],
): Partial<ChatPrefs> {
  return {
    subagentBuckets: {
      ...prefs.subagentBuckets,
      [bucket]: [...models],
    },
  };
}

/** Toggle whether a single bucket tier is allowed for *nested* sub-agents
 *  (depth ≥ 1), preserving the other two tiers. */
export function setNestedAllowedBucket(
  prefs: ChatPrefs,
  bucket: 'small' | 'medium' | 'frontier',
  enabled: boolean,
): Partial<ChatPrefs> {
  return {
    subagentNestedAllowedBuckets: {
      ...prefs.subagentNestedAllowedBuckets,
      [bucket]: enabled,
    },
  };
}

/** Replace the user-configured list of tool names always dropped from
 *  subagent sessions (e.g. ['ask_user']). */
export function setSubagentDropTools(prefs: ChatPrefs, tools: string[]): Partial<ChatPrefs> {
  return { subagentDropTools: [...tools] };
}

/** The tool name the ask-user extension contributes. */
export const ASK_USER_TOOL = 'ask_user';

/** Toggle whether the ask-user tool is available to subagents. When disabled,
 *  `ask_user` is added to the subagent drop-tools list; when enabled it is
 *  removed. This reuses the existing `subagentDropTools` mechanism rather than
 *  introducing a separate pref, so the ask-user toggle stays in sync with the
 *  "Dropped tools" editor in the Subagent section. */
export function setAskUserForSubagents(prefs: ChatPrefs, enabled: boolean): Partial<ChatPrefs> {
  const current = prefs.subagentDropTools ?? [];
  const next = enabled
    ? current.filter((t) => t !== ASK_USER_TOOL)
    : current.includes(ASK_USER_TOOL) ? current : [...current, ASK_USER_TOOL];
  return { subagentDropTools: next };
}

/** Whether the ask-user tool is currently available to subagents (i.e. not in
 *  the drop list). */
export function isAskUserForSubagentsEnabled(prefs: ChatPrefs): boolean {
  return !(prefs.subagentDropTools ?? []).includes(ASK_USER_TOOL);
}
