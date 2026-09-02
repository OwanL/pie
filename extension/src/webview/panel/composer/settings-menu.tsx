/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import { DEFAULT_SESSION_TITLES_SETTINGS, resolveHistoryCompactionSettings, type ChatPrefs, type ExtensionInfo, type McpServerInfo, type ModelInfo, type PruningCatalog, type PruningResult, type PruningSettings, type ProviderGateStats, type SessionTitlesSettings, type ThinkingLevel, type ToolResultPruningSettings } from '../../../shared/protocol';
import { filterEnabledProviders, orderModelsForPicker, type ModelPickerEntry } from './model-list';
import { Tooltip } from '../components/tooltip';
import { HISTORY_COMPACTION_BEHAVIOR_SETTING_LABELS, HISTORY_COMPACTION_MODEL_SETTING_LABELS } from './settings-menu-history-compaction';
import { SESSION_TITLES_BEHAVIOR_SETTING_LABELS, SESSION_TITLES_MODEL_SETTING_LABELS } from './settings-menu-session-titles';
import { SKILL_PRUNER_BEHAVIOR_SETTING_LABELS, SKILL_PRUNER_MODEL_SETTING_LABELS } from './settings-menu-skill-pruner';
import { NESTED_TOGGLE_DEFS, SUBAGENT_BEHAVIOR_SETTING_LABELS, SUBAGENT_MODEL_SETTING_LABELS } from './settings-menu-subagent';
import { TOOL_RESULT_PRUNER_SETTING_LABELS } from './settings-menu-tool-result-pruner';
import { BASH_SETTING_LABELS } from './settings-menu-bash';
import { ASK_USER_SETTING_LABELS } from './settings-menu-ask-user';
import { PROVIDER_SETTING_LABELS } from './settings-menu-providers';
import { MCP_SETTING_LABELS } from './settings-menu-mcp';
import { CHAT_PREF_SECTION_SEARCH_DEFS } from './settings-menu-chat-prefs';
import { SOUND_SETTING_LABELS } from './settings-menu-sound';
import { APPEARANCE_SETTING_LABELS } from './ui-appearance-settings';
import { CHAT_DEFAULT_MODEL_SETTING_LABELS } from './settings-menu-models';

import {
  computeKeepCatalog,
  computeToolKeepCatalog,
} from './settings-menu-helpers';

import {
  AppearanceSection,
  ChatDefaultModelAssignment,
  ChatPrefSections,
  ExtensionsSection,
  HistoryCompactionModelAssignment,
  HistoryCompactionSection,
  McpSection,
  ProvidersSection,
  SessionTitlesModelAssignment,
  SessionTitlesSection,
  SkillPrunerModelAssignment,
  SkillPrunerSettings,
  SoundSection,
  SubagentModelAssignments,
  SubagentSection,
  ToolResultPrunerSettings,
} from './settings-menu-subcomponents';

import {
  CHAT_PREF_MENU_SECTIONS,
  setExtensionEnabled,
  setNestedAllowedBucket,
  setSubagentBucketCanSpawn,
  setProviderEnabled,
  toggleChatPref,
  type BooleanPrefKey,
} from '../chat-prefs';

export {
  AlwaysKeepPicker,
  filterKeepCatalog,
} from '../components/always-keep-picker';

export {
  computeKeepCatalog,
  computeToolKeepCatalog,
  DEFAULT_TOOL_KEEP_CATALOG,
} from './settings-menu-helpers';

export interface ComposerSettingsMenuProps {
  prefs: ChatPrefs;
  mcpServers: McpServerInfo[];
  mcpServersStatus?: 'loading' | 'error' | 'ok';
  mcpPendingApply: boolean;
  pruningSettings: PruningSettings;
  pruningCatalog: PruningCatalog;
  pruningResult: PruningResult | null;
  toolResultPruningSettings: ToolResultPruningSettings;
  sessionTitlesSettings?: SessionTitlesSettings;
  availableExtensions: ExtensionInfo[];
  availableModels: ModelInfo[];
  providerGateStats: ProviderGateStats;
  activeContextWindow?: number;
  activeModel?: { provider?: string; id: string };
  selectedModel?: string;
  selectedProvider?: string;
  selectedLevel?: ThinkingLevel;
  chatModelEntries?: ModelPickerEntry[];
  onModelChange?: (model: string, provider: string | undefined, thinkingLevel: ThinkingLevel) => void;
  onSetPrefs: (prefs: Partial<ChatPrefs>) => void;
  onMcpListRequested: () => void;
  onMcpSetServerEnabled: (name: string, enabled: boolean) => void;
  onSetPruningSettings: (settings: Partial<PruningSettings>) => void;
  onSetToolResultPruningSettings: (settings: Partial<ToolResultPruningSettings>) => void;
  onSetSessionTitlesSettings?: (settings: Partial<SessionTitlesSettings>) => void;
}

/** Settings categories, in tab-strip order. Each renders one at a time
 *  inside the menu body; search can jump to any of them. */
type SettingsTab = 'chat' | 'models' | 'context' | 'subagents' | 'appearance' | 'extensions' | 'mcp';

const TAB_DEFS: { id: SettingsTab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'models', label: 'Models' },
  { id: 'context', label: 'Context' },
  { id: 'subagents', label: 'Subagents' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'mcp', label: 'MCP' },
];

function getTabLabel(tab: SettingsTab): string {
  return TAB_DEFS.find((definition) => definition.id === tab)?.label ?? tab;
}

/** Fixed height for the settings menu, capped to the available vertical space
 *  at runtime. A fixed height keeps the menu from growing/shrinking as the
 *  user clicks between categories (which differ in content height) — the inner
 *  .toolbar-settings-menu-body scrolls any overflow. Sized to be comfortably
 *  larger than the old content-driven default. */
const SETTINGS_MENU_HEIGHT = 500;

/** Small line icons for the vertical category sidebar. 14px viewBox, stroked to
 *  match the rest of the composer UI. */
function TabIcon({ id }: { id: SettingsTab }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.5,
    'stroke-linecap': 'round' as const,
    'stroke-linejoin': 'round' as const,
    'aria-hidden': true,
  };
  switch (id) {
    case 'chat':
      return (
        <svg {...common}>
          <path d="M2.5 4.5h11a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H6l-3.5 3V5.5a1 1 0 0 1 1-1z" />
        </svg>
      );
    case 'models':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="2.5" />
          <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
        </svg>
      );
    case 'context':
      return (
        <svg {...common}>
          <path d="M3 3.5h10M4.5 7h7M6 10.5h4" />
          <path d="m6.5 13 1.5 1.5L9.5 13" />
        </svg>
      );
    case 'subagents':
      return (
        <svg {...common}>
          <circle cx="8" cy="4" r="2" />
          <circle cx="4" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <path d="M8 6v2M8 8 4.8 10M8 8l3.2 2" />
        </svg>
      );
    case 'appearance':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" />
          <circle cx="5.5" cy="6" r="1" fill="currentColor" stroke="none" />
          <circle cx="10" cy="6" r="1" fill="currentColor" stroke="none" />
          <circle cx="11" cy="9.5" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'extensions':
      return (
        <svg {...common}>
          <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
          <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
          <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
          <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
        </svg>
      );
    case 'mcp':
      return (
        <svg {...common}>
          <path d="M6.5 2v3M9.5 2v3" />
          <path d="M4.5 5h7v2.2a3.5 3.5 0 0 1-7 0V5Z" />
          <path d="M8 10.7V14" />
        </svg>
      );
  }
}


interface SearchJumpEntry {
  type: 'jump';
  id: string;
  label: string;
  haystack: string;
  tab: SettingsTab;
  /** Extension id to expand inline after switching to the Extensions tab. */
  expandExt?: string;
}

interface SearchToggleEntry {
  type: 'toggle';
  id: string;
  label: string;
  haystack: string;
  checked: boolean;
  apply: () => void;
}

type SearchEntry = SearchJumpEntry | SearchToggleEntry;

/** Build the searchable index of category jumps, continuous-control jumps,
 *  and boolean toggles that powers the settings search box. Kept as a pure
 *  helper so the component's control flow stays focused on rendering. */
function buildSettingsSearchIndex(
  visibleTabs: typeof TAB_DEFS,
  availableExtensions: ExtensionInfo[],
  providers: string[],
  prefs: ChatPrefs,
  onSetPrefs: (p: Partial<ChatPrefs>) => void,
): SearchEntry[] {
  const entries: SearchEntry[] = [];
  const extIds = new Set(availableExtensions.map((e) => e.id));
  const hasSkillPruner = extIds.has('skill-pruner');
  const hasSubagent = extIds.has('subagent');
  const hasToolResultPruner = extIds.has('tool-result-pruner');
  const hasWarmBash = extIds.has('warm-bash');

  // Category jump entries (one per visible tab).
  for (const tab of visibleTabs) {
    entries.push({
      type: 'jump',
      id: `cat:${tab.id}`,
      label: tab.label,
      haystack: tab.label.toLowerCase(),
      tab: tab.id,
    });
  }

  // Section-owned label lists keep search aligned with the controls each
  // section actually renders. The tab routing here is the IA map.
  const pushSettings = (
    labels: readonly string[],
    tab: SettingsTab,
    section: string,
    expandExt?: string,
  ) => {
    for (const label of labels) {
      entries.push({
        type: 'jump',
        id: `set:${tab}:${section}:${label}`,
        label,
        haystack: `${getTabLabel(tab)} ${section} ${label}`.toLowerCase(),
        tab,
        expandExt,
      });
    }
  };
  pushSettings(SESSION_TITLES_BEHAVIOR_SETTING_LABELS, 'chat', 'session titles');
  for (const section of CHAT_PREF_SECTION_SEARCH_DEFS) {
    pushSettings(
      section.labels,
      section.id === 'display' ? 'appearance' : 'chat',
      section.label ?? section.id,
    );
  }
  pushSettings(SOUND_SETTING_LABELS, 'chat', 'completion notifications');
  pushSettings(CHAT_DEFAULT_MODEL_SETTING_LABELS, 'models', 'chat default');
  pushSettings(SESSION_TITLES_MODEL_SETTING_LABELS, 'models', 'session titles');
  pushSettings(HISTORY_COMPACTION_MODEL_SETTING_LABELS, 'models', 'compaction summary');
  pushSettings(PROVIDER_SETTING_LABELS, 'models', 'providers');
  pushSettings(HISTORY_COMPACTION_BEHAVIOR_SETTING_LABELS, 'context', 'history compaction');
  pushSettings(APPEARANCE_SETTING_LABELS, 'appearance', 'appearance');
  pushSettings(MCP_SETTING_LABELS, 'mcp', 'mcp');
  if (hasWarmBash) pushSettings(BASH_SETTING_LABELS, 'extensions', 'warm bash', 'warm-bash');
  if (extIds.has('ask-user')) pushSettings(ASK_USER_SETTING_LABELS, 'extensions', 'ask user', 'ask-user');
  if (hasSkillPruner) {
    pushSettings(SKILL_PRUNER_MODEL_SETTING_LABELS, 'models', 'pruning prepass');
    pushSettings(SKILL_PRUNER_BEHAVIOR_SETTING_LABELS, 'context', 'skill pruning');
  }
  if (hasSubagent) {
    pushSettings(SUBAGENT_MODEL_SETTING_LABELS, 'models', 'subagent model buckets');
    pushSettings(SUBAGENT_BEHAVIOR_SETTING_LABELS, 'subagents', 'subagents');
  }
  if (hasToolResultPruner) pushSettings(TOOL_RESULT_PRUNER_SETTING_LABELS, 'context', 'tool-result pruning');

  // Chat prefs (transcript / alerts / diagnostics).
  for (const section of CHAT_PREF_MENU_SECTIONS) {
    for (const item of section.items) {
      const key = item.key as BooleanPrefKey;
      entries.push({
        type: 'toggle',
        id: `chatpref:${key}`,
        label: item.label,
        haystack: `${section.label ?? ''} ${item.label}`.toLowerCase(),
        checked: !!prefs[key],
        apply: () => onSetPrefs(toggleChatPref(prefs, key)),
      });
    }
  }

  const historyCompaction = resolveHistoryCompactionSettings(prefs.historyCompaction);
  entries.push({
    type: 'toggle',
    id: 'history-compaction:enabled',
    label: 'Proactive automatic compaction',
    haystack: 'history compaction proactive automatic soft hard trigger',
    checked: historyCompaction.enabled,
    apply: () => onSetPrefs({
      historyCompaction: {
        ...historyCompaction,
        enabled: !historyCompaction.enabled,
      },
    }),
  });

  // Bash fast-path toggle (warm-bash extension).
  if (hasWarmBash) {
    entries.push({
      type: 'toggle',
      id: 'bash:fastpath',
      label: 'Fast path (no shell for simple commands)',
      haystack: 'bash fast path no shell simple commands'.toLowerCase(),
      checked: !!prefs.bashFastPath,
      apply: () => onSetPrefs({ bashFastPath: !prefs.bashFastPath }),
    });
  }

  // Extension enable toggles.
  for (const ext of availableExtensions) {
    const checked = prefs.extensionToggles[ext.id] !== false;
    entries.push({
      type: 'toggle',
      id: `ext:${ext.id}`,
      label: ext.label,
      haystack: `extensions ${ext.label} ${ext.description ?? ''}`.toLowerCase(),
      checked,
      apply: () => onSetPrefs(setExtensionEnabled(prefs, ext.id, !checked)),
    });
  }

  // Skill-pruner "show summary" toggle (only when the extension is present).
  if (hasSkillPruner) {
    entries.push({
      type: 'toggle',
      id: 'pruning:show',
      label: 'Show pruning summary',
      haystack: 'context skill-pruner show pruning summary'.toLowerCase(),
      checked: !!prefs.showPruningMessages,
      apply: () => onSetPrefs(toggleChatPref(prefs, 'showPruningMessages')),
    });
  }

  // Subagent toggles (only when the extension is present).
  if (hasSubagent) {
    entries.push({
      type: 'toggle',
      id: 'subagent:parentmodel',
      label: 'Always use parent model',
      haystack: 'subagent always use parent model'.toLowerCase(),
      checked: !!prefs.subagentAlwaysParentModel,
      apply: () => onSetPrefs(toggleChatPref(prefs, 'subagentAlwaysParentModel')),
    });
    entries.push({
      type: 'toggle',
      id: 'subagent:route-around-saturated',
      label: 'Route around busy providers',
      haystack: 'subagent route around busy saturated providers capacity concurrency queue'.toLowerCase(),
      checked: !!prefs.subagentRouteAroundSaturatedProviders,
      apply: () => onSetPrefs(toggleChatPref(prefs, 'subagentRouteAroundSaturatedProviders')),
    });
    entries.push({
      type: 'toggle',
      id: 'subagent:fallback-provider-failure',
      label: 'Fallback on provider failure',
      haystack: 'subagent fallback failover provider failure timeout connection retries exhausted'.toLowerCase(),
      checked: !!prefs.subagentFallbackOnProviderFailure,
      apply: () => onSetPrefs(toggleChatPref(prefs, 'subagentFallbackOnProviderFailure')),
    });
    for (const def of NESTED_TOGGLE_DEFS) {
      const enabled = prefs.subagentNestedAllowedBuckets[def.key] ?? true;
      entries.push({
        type: 'toggle',
        id: `subagent:nested:${def.key}`,
        label: `Allow ${def.label}`,
        haystack: `subagent nested bucket allowlist allow ${def.label}`.toLowerCase(),
        checked: enabled,
        apply: () => onSetPrefs(setNestedAllowedBucket(prefs, def.key, !enabled)),
      });
      const canSpawn = prefs.subagentBucketCanSpawn[def.key] ?? true;
      entries.push({
        type: 'toggle',
        id: `subagent:delegate:${def.key}`,
        label: `Allow ${def.label} subagents to delegate`,
        haystack: `subagent delegation bucket spawn nested leaf ${def.label}`.toLowerCase(),
        checked: canSpawn,
        apply: () => onSetPrefs(setSubagentBucketCanSpawn(prefs, def.key, !canSpawn)),
      });
    }
  }

  // MCP global toggle (always present — the tab is unconditional).
  entries.push({
    type: 'toggle',
    id: 'mcp:enabled',
    label: 'MCP enabled',
    haystack: 'mcp model context protocol servers tools enabled'.toLowerCase(),
    checked: prefs.mcpEnabled,
    apply: () => onSetPrefs({ mcpEnabled: !prefs.mcpEnabled }),
  });

  // Provider enable toggles.
  for (const provider of providers) {
    const checked = prefs.providerToggles[provider] !== false;
    entries.push({
      type: 'toggle',
      id: `provider:${provider}`,
      label: provider,
      haystack: `providers ${provider}`.toLowerCase(),
      checked,
      apply: () => onSetPrefs(setProviderEnabled(prefs, provider, !checked)),
    });
  }

  return entries;
}

interface SettingsSearchResultsProps {
  query: string;
  jumps: SearchJumpEntry[];
  toggles: SearchToggleEntry[];
  onJump: (tab: SettingsTab, expandExt?: string) => void;
}

/** Renders the flat search-result list (jumps + toggles + empty state). */
function SettingsSearchResults({ query, jumps, toggles, onJump }: SettingsSearchResultsProps) {
  return (
    <div class="toolbar-settings-search-results">
      {jumps.length === 0 && toggles.length === 0 && (
        <div class="toolbar-settings-search-empty">No settings match “{query}”.</div>
      )}
      {jumps.map((entry) => (
        <button
          key={entry.id}
          class="toolbar-settings-search-result toolbar-settings-search-result-jump"
          type="button"
          onClick={() => onJump(entry.tab, entry.expandExt)}
        >
          <span class="toolbar-settings-search-result-label">{entry.label}</span>
          <span class="toolbar-settings-search-result-meta">{getTabLabel(entry.tab)}</span>
        </button>
      ))}
      {toggles.map((entry) => (
        <button
          key={entry.id}
          class={`toolbar-settings-item toolbar-settings-search-result${entry.checked ? ' checked' : ''}`}
          type="button"
          role="checkbox"
          aria-checked={entry.checked}
          onClick={() => entry.apply()}
        >
          <span class="toolbar-settings-item-check" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={entry.checked ? '' : 'opacity:0'}>
              <polyline points="2.5,6.5 5,9 10.5,3.5" />
            </svg>
          </span>
          <span class="toolbar-settings-item-label">{entry.label}</span>
        </button>
      ))}
    </div>
  );
}

interface SettingsTabListProps {
  visibleTabs: typeof TAB_DEFS;
  effectiveTab: SettingsTab;
  tabpanelId: string;
  tablistRef: { current: HTMLDivElement | null };
  onKeyDown: (event: KeyboardEvent) => void;
  onSelect: (tab: SettingsTab) => void;
}

/** Renders the vertical tab strip for switching settings categories. */
function SettingsTabList({ visibleTabs, effectiveTab, tabpanelId, tablistRef, onKeyDown, onSelect }: SettingsTabListProps) {
  return (
    <div ref={tablistRef} class="toolbar-settings-tabs" role="tablist" aria-orientation="vertical" aria-label="Settings categories" onKeyDown={onKeyDown}>
      {visibleTabs.map((tab) => {
        const active = tab.id === effectiveTab;
        return (
          <button
            key={tab.id}
            id={`toolbar-settings-tab-${tab.id}`}
            class={`toolbar-settings-tab${active ? ' active' : ''}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={tabpanelId}
            tabindex={active ? 0 : -1}
            data-tab={tab.id}
            onClick={() => onSelect(tab.id)}
          >
            <span class="toolbar-settings-tab-icon" aria-hidden="true">
              <TabIcon id={tab.id} />
            </span>
            <span class="toolbar-settings-tab-label">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

interface SettingsTabBodyProps {
  effectiveTab: SettingsTab;
  expandedExt: string | null;
  setExpandedExt: (id: string | null) => void;
  prefs: ChatPrefs;
  onSetPrefs: (p: Partial<ChatPrefs>) => void;
  mcpServers: McpServerInfo[];
  mcpServersStatus?: 'loading' | 'error' | 'ok';
  mcpPendingApply: boolean;
  onMcpListRequested: () => void;
  onMcpSetServerEnabled: (name: string, enabled: boolean) => void;
  pruningSettings: PruningSettings;
  onSetPruningSettings: (s: Partial<PruningSettings>) => void;
  toolResultPruningSettings: ToolResultPruningSettings;
  onSetToolResultPruningSettings: (s: Partial<ToolResultPruningSettings>) => void;
  sessionTitlesSettings: SessionTitlesSettings;
  onSetSessionTitlesSettings: (s: Partial<SessionTitlesSettings>) => void;
  providers: string[];
  providerGateStats: ProviderGateStats;
  modelEntries: ModelPickerEntry[];
  availableModels: ModelInfo[];
  availableExtensions: ExtensionInfo[];
  skillCatalog: string[];
  toolCatalog: string[];
  activeContextWindow?: number;
  activeModel?: { provider?: string; id: string };
  selectedModel: string;
  selectedProvider?: string;
  selectedLevel: ThinkingLevel;
  chatModelEntries: ModelPickerEntry[];
  onModelChange: (model: string, provider: string | undefined, thinkingLevel: ThinkingLevel) => void;
}

/** Renders the content of the active settings tab. */
function SettingsTabBody(props: SettingsTabBodyProps) {
  const {
    effectiveTab,
    expandedExt,
    setExpandedExt,
    prefs,
    onSetPrefs,
    mcpServers,
    mcpServersStatus,
    mcpPendingApply,
    onMcpListRequested,
    onMcpSetServerEnabled,
    pruningSettings,
    onSetPruningSettings,
    toolResultPruningSettings,
    onSetToolResultPruningSettings,
    sessionTitlesSettings,
    onSetSessionTitlesSettings,
    modelEntries,
    availableModels,
    availableExtensions,
    providers,
    providerGateStats,
    skillCatalog,
    toolCatalog,
    activeContextWindow,
    activeModel,
    selectedModel,
    selectedProvider,
    selectedLevel,
    chatModelEntries,
    onModelChange,
  } = props;
  const extensionIds = new Set(availableExtensions.map((extension) => extension.id));
  const hasSkillPruner = extensionIds.has('skill-pruner');
  const hasSubagent = extensionIds.has('subagent');
  const hasToolResultPruner = extensionIds.has('tool-result-pruner');
  const historySettings = resolveHistoryCompactionSettings(prefs.historyCompaction);

  return (
    <>
      {effectiveTab === 'chat' && (
        <>
          <div class="toolbar-settings-section">
            <div class="toolbar-settings-section-label">Session titles</div>
            <SessionTitlesSection settings={sessionTitlesSettings} onSetSessionTitlesSettings={onSetSessionTitlesSettings} />
          </div>
          <ChatPrefSections prefs={prefs} onSetPrefs={onSetPrefs} sectionIds={['transcript']} />
          <SoundSection prefs={prefs} onSetPrefs={onSetPrefs} />
          <ChatPrefSections prefs={prefs} onSetPrefs={onSetPrefs} sectionIds={['diagnostics']} />
        </>
      )}
      {effectiveTab === 'models' && (
        <>
          <div class="toolbar-settings-section">
            <div class="toolbar-settings-section-label">Model assignments</div>
            <div class="toolbar-settings-list">
              <ChatDefaultModelAssignment
                selectedModel={selectedModel}
                selectedProvider={selectedProvider}
                selectedLevel={selectedLevel}
                modelEntries={chatModelEntries}
                availableModels={availableModels}
                onModelChange={onModelChange}
              />
              <SessionTitlesModelAssignment settings={sessionTitlesSettings} modelEntries={modelEntries} availableModels={availableModels} onSetSessionTitlesSettings={onSetSessionTitlesSettings} />
              <HistoryCompactionModelAssignment settings={historySettings} availableModels={availableModels} modelEntries={modelEntries} activeModel={activeModel} onSetPrefs={onSetPrefs} />
              {hasSkillPruner && <SkillPrunerModelAssignment pruningSettings={pruningSettings} modelEntries={modelEntries} availableModels={availableModels} onSetPruningSettings={onSetPruningSettings} />}
              {hasSubagent && <SubagentModelAssignments prefs={prefs} onSetPrefs={onSetPrefs} availableModels={availableModels} />}
            </div>
          </div>
          <div class="toolbar-settings-section">
            <div class="toolbar-settings-section-label">Providers</div>
            <ProvidersSection providers={providers} prefs={prefs} onSetPrefs={onSetPrefs} providerGateStats={providerGateStats} />
          </div>
        </>
      )}
      {effectiveTab === 'context' && (
        <>
          <HistoryCompactionSection settings={historySettings} contextWindow={activeContextWindow} availableModels={availableModels} activeModel={activeModel} onSetPrefs={onSetPrefs} />
          {hasSkillPruner && (
            <div class="toolbar-settings-section">
              <div class="toolbar-settings-section-label">Skill pruning</div>
              <SkillPrunerSettings prefs={prefs} pruningSettings={pruningSettings} skillCatalog={skillCatalog} toolCatalog={toolCatalog} onSetPrefs={onSetPrefs} onSetPruningSettings={onSetPruningSettings} />
            </div>
          )}
          {hasToolResultPruner && (
            <div class="toolbar-settings-section">
              <div class="toolbar-settings-section-label">Tool-result pruning</div>
              <ToolResultPrunerSettings settings={toolResultPruningSettings} onSetToolResultPruningSettings={onSetToolResultPruningSettings} />
            </div>
          )}
        </>
      )}
      {effectiveTab === 'subagents' && hasSubagent && (
        <SubagentSection prefs={prefs} onSetPrefs={onSetPrefs} availableModels={availableModels} />
      )}
      {effectiveTab === 'appearance' && (
        <AppearanceSection prefs={prefs} onSetPrefs={onSetPrefs} />
      )}
      {effectiveTab === 'extensions' && (
        <ExtensionsSection
          availableExtensions={availableExtensions}
          prefs={prefs}
          onSetPrefs={onSetPrefs}
          expandedExt={expandedExt}
          setExpandedExt={setExpandedExt}
        />
      )}
      {effectiveTab === 'mcp' && (
        <McpSection prefs={prefs} mcpServers={mcpServers} mcpServersStatus={mcpServersStatus} mcpPendingApply={mcpPendingApply} onSetPrefs={onSetPrefs} onMcpListRequested={onMcpListRequested} onMcpSetServerEnabled={onMcpSetServerEnabled} />
      )}
    </>
  );
}

export function ComposerSettingsMenu({ prefs, mcpServers, mcpServersStatus, mcpPendingApply, pruningSettings, pruningCatalog, pruningResult, toolResultPruningSettings, sessionTitlesSettings = DEFAULT_SESSION_TITLES_SETTINGS, availableExtensions, availableModels, providerGateStats, activeContextWindow, activeModel, selectedModel, selectedProvider, selectedLevel, chatModelEntries, onModelChange, onSetPrefs, onMcpListRequested, onMcpSetServerEnabled, onSetPruningSettings, onSetToolResultPruningSettings, onSetSessionTitlesSettings = () => undefined }: ComposerSettingsMenuProps) {
  const skillCatalog = useMemo(
    () => computeKeepCatalog(
      pruningCatalog.skills,
      pruningResult ? { included: pruningResult.includedSkills, excluded: pruningResult.excludedSkills } : null,
      pruningSettings.skillAlwaysKeep,
    ),
    [pruningCatalog.skills, pruningResult, pruningSettings.skillAlwaysKeep],
  );
  const toolCatalog = useMemo(
    () => computeToolKeepCatalog(
      pruningCatalog.tools,
      pruningResult ? { included: pruningResult.includedTools, excluded: pruningResult.excludedTools } : null,
      pruningSettings.toolAlwaysKeep,
    ),
    [pruningCatalog.tools, pruningResult, pruningSettings.toolAlwaysKeep],
  );
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>('chat');
  const [query, setQuery] = useState('');
  const modelEntries = useMemo(
    // Generic settings pickers (history summaries and the skill-pruning
    // prepass) must not inherit subagent-specific eligibility warnings or
    // ordering. Provider toggles still apply because disabled providers cannot
    // execute these configured model calls.
    () => orderModelsForPicker(
      filterEnabledProviders(availableModels, prefs.providerToggles),
      { useSubagentEligibility: false },
    ),
    [availableModels, prefs.providerToggles],
  );
  const [expandedExt, setExpandedExt] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const tablistRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const queryRef = useRef(query);
  queryRef.current = query;

  // Close the menu and refocus the trigger button.
  const closeMenu = useCallback((refocus?: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // Extract unique providers from available models, sorted alphabetically.
  const providers = useMemo(
    () => [...new Set(availableModels.map((m) => m.provider))].sort((a, b) => a.localeCompare(b)),
    [availableModels],
  );

  // Extensions and Subagents disappear when their backing content is absent;
  // Models and Context always retain their baseline sections.
  const visibleTabs = useMemo(
    () => TAB_DEFS.filter((t) => {
      if (t.id === 'extensions') return availableExtensions.length > 0;
      if (t.id === 'subagents') return availableExtensions.some((extension) => extension.id === 'subagent');
      return true;
    }),
    [availableExtensions],
  );

  // Effective tab falls back to the first visible one if the active tab's
  // content disappeared (e.g. the last provider was toggled off elsewhere).
  const effectiveTab: SettingsTab = visibleTabs.some((t) => t.id === activeTab)
    ? activeTab
    : (visibleTabs[0]?.id ?? 'chat');

  // Keep activeTab in sync with effectiveTab so a re-appearing hidden tab
  // doesn't leave a stale selection.
  useEffect(() => {
    if (effectiveTab !== activeTab) setActiveTab(effectiveTab);
  }, [effectiveTab, activeTab]);

  // Search index: category jumps + every boolean toggle across all categories,
  // plus jump entries for the continuous (slider/select/stepper/text) controls,
  // so a single search box can find any setting without hunting through tabs.
  const searchIndex = useMemo<SearchEntry[]>(
    () => buildSettingsSearchIndex(visibleTabs, availableExtensions, providers, prefs, onSetPrefs),
    [visibleTabs, availableExtensions, providers, prefs, onSetPrefs],
  );

  const q = query.trim().toLowerCase();
  const searchResults = useMemo(() => {
    if (!q) return { jumps: [], toggles: [] };
    const jumps = searchIndex.filter((e): e is SearchJumpEntry => e.type === 'jump' && e.haystack.includes(q));
    const toggles = searchIndex.filter((e): e is SearchToggleEntry => e.type === 'toggle' && e.haystack.includes(q));
    return { jumps, toggles };
  }, [q, searchIndex]);

  const searching = q.length > 0;

  const jumpTo = (tab: SettingsTab, expandExt?: string) => {
    setActiveTab(tab);
    if (expandExt) setExpandedExt(expandExt);
    setQuery('');
  };

  // Pin the menu to a fixed height so it stops growing/shrinking as the user
  // clicks between categories — each tab has a different amount of content, so
  // a content-driven height made the menu's top edge jump around (the
  // "resizes too much" problem). The height is generously sized by default and
  // only shrinks when the viewport can't fit it; the inner
  // .toolbar-settings-menu-body scrolls any overflow. The menu is
  // bottom-anchored, so its bottom edge is stable regardless of height, and
  // since the height no longer depends on content there's no need to
  // re-measure on tab/search changes.
  useLayoutEffect(() => {
    const el = settingsMenuRef.current;
    if (!open || !el) return;
    const pad = 8;
    const fit = () => {
      const rect = el.getBoundingClientRect();
      const avail = Math.max(180, rect.bottom - pad);
      const h = Math.min(SETTINGS_MENU_HEIGHT, avail);
      el.style.height = `${h}px`;
      el.style.maxHeight = `${avail}px`;
    };
    fit();
    const frame = window.requestAnimationFrame(() => {
      fit();
      searchInputRef.current?.focus();
    });
    window.addEventListener('resize', fit);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', fit);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current && !menuRef.current.contains(target)) {
        // The ModelPicker dropdown is portaled to document.body (to escape
        // this menu's scroll container), so it is no longer a DOM descendant
        // of the menu. Treat interaction with it as inside the menu so
        // selecting a row doesn't dismiss the settings menu.
        if (target instanceof HTMLElement && target.closest('.model-picker-dropdown')) {
          return;
        }
        closeMenu();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // If a nested overlay (e.g. the ModelPicker dropdown rendered inside this
      // menu) owns focus, defer to its own Escape handler so only the picker
      // closes and focus returns to the picker trigger. This menu's keydown
      // listener is registered first (parent mounts first) and therefore fires
      // first, so we skip here rather than rely on the child stopping
      // propagation (stopImmediatePropagation would have no effect).
      const active = document.activeElement as HTMLElement | null;
      if (active && active.closest('.model-picker-dropdown')) {
        return;
      }
      // If the user is typing in the search box, Escape clears the query before
      // dismissing the menu — a one-step-back interaction model.
      if (queryRef.current) {
        // Update the ref synchronously so a second rapid Escape closes the
        // menu even before Preact has committed the cleared search state and
        // refreshed this document listener's closure.
        queryRef.current = '';
        setQuery('');
        return;
      }
      closeMenu(true);
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, closeMenu]);

  // WAI-ARIA tabs pattern: arrow keys move selection between visible tabs and
  // focus follows, so the tab strip is keyboard-navigable without Tab cycling.
  const onTablistKeyDown = (event: KeyboardEvent) => {
    const ids = visibleTabs.map((t) => t.id);
    if (ids.length === 0) return;
    const idx = ids.indexOf(effectiveTab);
    let next: SettingsTab | null = null;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = ids[(idx + 1) % ids.length];
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = ids[(idx - 1 + ids.length) % ids.length];
    else if (event.key === 'Home') next = ids[0];
    else if (event.key === 'End') next = ids[ids.length - 1];
    if (!next) return;
    event.preventDefault();
    setActiveTab(next);
    window.requestAnimationFrame(() => {
      tablistRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
    });
  };

  const tabpanelId = 'toolbar-settings-tabpanel';

  return (
    <div ref={menuRef} class="toolbar-settings">
      <Tooltip content={open ? null : 'Settings'} placement="top">
        <button
          ref={triggerRef}
          class={`toolbar-settings-trigger${open ? ' open' : ''}`}
          type="button"
          aria-label="Settings"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => (open ? closeMenu() : setOpen(true))}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 .99-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51.99H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </Tooltip>

      {open && (
        <div ref={settingsMenuRef} class="toolbar-settings-menu" role="dialog" aria-label="Settings">
          <div class="toolbar-settings-header">
            <span class="toolbar-settings-title">Settings</span>
            <button
              type="button"
              class="toolbar-settings-close"
              aria-label="Close settings"
              onClick={() => closeMenu(true)}
            >
              <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="3" y1="3" x2="10" y2="10" />
                <line x1="10" y1="3" x2="3" y2="10" />
              </svg>
            </button>
          </div>
          <div class="toolbar-settings-search">
            <svg class="toolbar-settings-search-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" />
              <line x1="10.5" y1="10.5" x2="14" y2="14" />
            </svg>
            <input
              ref={searchInputRef}
              class="toolbar-settings-search-input"
              type="text"
              placeholder="Search settings…"
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              aria-label="Search settings"
              spellcheck={false}
            />
            {query && (
              <button
                type="button"
                class="toolbar-settings-search-clear"
                aria-label="Clear search"
                onClick={() => setQuery('')}
              >
                <svg width="12" height="12" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <line x1="3" y1="3" x2="10" y2="10" />
                  <line x1="10" y1="3" x2="3" y2="10" />
                </svg>
              </button>
            )}
          </div>

          <div class="toolbar-settings-layout">
            {!searching && (
              <SettingsTabList
                visibleTabs={visibleTabs}
                effectiveTab={effectiveTab}
                tabpanelId={tabpanelId}
                tablistRef={tablistRef}
                onKeyDown={onTablistKeyDown}
                onSelect={setActiveTab}
              />
            )}

            <div
              id={tabpanelId}
              class="toolbar-settings-menu-body"
              role="tabpanel"
              aria-labelledby={`toolbar-settings-tab-${effectiveTab}`}
            >
            {searching ? (
              <SettingsSearchResults
                query={query}
                jumps={searchResults.jumps}
                toggles={searchResults.toggles}
                onJump={jumpTo}
              />
            ) : (
              <SettingsTabBody
                effectiveTab={effectiveTab}
                expandedExt={expandedExt}
                setExpandedExt={setExpandedExt}
                prefs={prefs}
                onSetPrefs={onSetPrefs}
                mcpServers={mcpServers}
                mcpServersStatus={mcpServersStatus}
                mcpPendingApply={mcpPendingApply}
                onMcpListRequested={onMcpListRequested}
                onMcpSetServerEnabled={onMcpSetServerEnabled}
                pruningSettings={pruningSettings}
                onSetPruningSettings={onSetPruningSettings}
                toolResultPruningSettings={toolResultPruningSettings}
                onSetToolResultPruningSettings={onSetToolResultPruningSettings}
                sessionTitlesSettings={sessionTitlesSettings}
                onSetSessionTitlesSettings={onSetSessionTitlesSettings}
                modelEntries={modelEntries}
                availableModels={availableModels}
                availableExtensions={availableExtensions}
                providers={providers}
                providerGateStats={providerGateStats}
                skillCatalog={skillCatalog}
                toolCatalog={toolCatalog}
                activeContextWindow={activeContextWindow}
                activeModel={activeModel}
                selectedModel={selectedModel ?? activeModel?.id ?? ''}
                selectedProvider={selectedProvider ?? activeModel?.provider}
                selectedLevel={selectedLevel ?? 'off'}
                chatModelEntries={chatModelEntries ?? modelEntries}
                onModelChange={onModelChange ?? (() => undefined)}
              />
            )}
          </div>
          </div>
        </div>
      )}
    </div>
  );
}
