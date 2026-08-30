import type { ChatPrefs, ModelInfo, SubagentBucketAssignment } from '../../shared/protocol';

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
export type TranscriptContextMenuType = ChatPrefContextType | 'message' | 'filePath';

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

/** Providers represented by at least one model in a configured subagent bucket.
 * New values are canonical `provider/id` specs. Legacy bare ids are resolved
 * against every matching catalog entry for backward compatibility. Explicitly
 * configured provider preferences are retained when a session's live model catalog
 * temporarily contracts, so an authenticated provider does not disappear from
 * the toggle surface merely because the active session has a stale snapshot. */
export function getSubagentBucketProviders(
  prefs: ChatPrefs,
  availableModels: ModelInfo[],
  sessionPath?: string | null,
): string[] {
  const assignments = [
    ...prefs.subagentBuckets.small,
    ...prefs.subagentBuckets.medium,
    ...prefs.subagentBuckets.frontier,
  ];
  const providers = new Set<string>();
  for (const assignment of assignments) {
    const spec = assignment.model;
    const slash = spec.indexOf('/');
    if (slash > 0 && slash < spec.length - 1) {
      const provider = spec.substring(0, slash);
      // A qualified bucket assignment is itself authoritative configuration.
      // Keep its provider visible even while that model is absent from the
      // active session's auth-filtered/stale catalog snapshot.
      providers.add(provider);
      continue;
    }
    for (const model of availableModels) {
      if (model.id === spec) providers.add(model.provider);
    }
  }

  // Preserve explicit defaults/session overrides that were created
  // while a legacy bare-id bucket resolved to this provider. Without this,
  // duplicate ids such as GPT-5.6 can collapse to whichever provider remains
  // in a stale session snapshot (for example Copilot), hiding Codex even though
  // its persisted subagent route is still configured. Keep both enabled and
  // disabled entries visible so toggling off never removes the route needed to
  // turn that provider back on.
  for (const provider of Object.keys(prefs.subagentProviderDefaults)) {
    providers.add(provider);
  }
  if (sessionPath) {
    for (const provider of Object.keys(prefs.subagentProviderTogglesBySession[sessionPath] ?? {})) {
      providers.add(provider);
    }
  }

  return [...providers].sort((a, b) => a.localeCompare(b));
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

/** Replace one bucket's explicit model/reasoning assignments, preserving
 * the other two buckets and copying entries to avoid caller aliasing. */
export function setBucketAssignments(
  prefs: ChatPrefs,
  bucket: 'small' | 'medium' | 'frontier',
  assignments: SubagentBucketAssignment[],
): Partial<ChatPrefs> {
  return {
    subagentBuckets: {
      ...prefs.subagentBuckets,
      [bucket]: assignments.map((entry) => ({ ...entry })),
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

/** Toggle whether subagents running in one effective bucket may create
 *  further subagents, preserving the other bucket policies. */
export function setSubagentBucketCanSpawn(
  prefs: ChatPrefs,
  bucket: 'small' | 'medium' | 'frontier',
  enabled: boolean,
): Partial<ChatPrefs> {
  return {
    subagentBucketCanSpawn: {
      ...prefs.subagentBucketCanSpawn,
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
