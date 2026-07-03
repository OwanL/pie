import type { ChatPrefs } from '../../shared/protocol';

export type BooleanPrefKey =
  | 'autoExpandReasoning'
  | 'autoExpandToolCalls'
  | 'autoExpandSubagentCalls'
  | 'suppressCompletionNotifications'
  | 'showPruningMessages'
  | 'subagentAlwaysParentModel'
  | 'runtimeAuditLog';

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
