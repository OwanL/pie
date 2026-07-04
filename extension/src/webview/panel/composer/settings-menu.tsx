/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { ChatPrefs, ExtensionInfo, ModelInfo, PruningCatalog, PruningResult, PruningSettings, ProxySettings, ProxySettingsUpdate } from '../../../shared/protocol';
import { filterEnabledProviders, orderModelsForPicker } from './model-list';

import {
  computeKeepCatalog,
  computeToolKeepCatalog,
} from './settings-menu-helpers';

import {
  AppearanceSection,
  BashSection,
  ChatPrefSections,
  ExtensionsSection,
  ProvidersSection,
  ProxySection,
  SoundSection,
} from './settings-menu-subcomponents';

import {
  CHAT_PREF_MENU_SECTIONS,
  setExtensionEnabled,
  setNestedAllowedBucket,
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
  pruningSettings: PruningSettings;
  pruningCatalog: PruningCatalog;
  pruningResult: PruningResult | null;
  proxySettings: ProxySettings;
  availableExtensions: ExtensionInfo[];
  availableModels: ModelInfo[];
  onSetPrefs: (prefs: Partial<ChatPrefs>) => void;
  onSetPruningSettings: (settings: Partial<PruningSettings>) => void;
  onSetProxySettings: (settings: ProxySettingsUpdate) => void;
}

/** The six settings categories, in tab-strip order. Each renders one at a time
 *  inside the menu body; search can jump to any of them. */
type SettingsTab = 'chat' | 'appearance' | 'bash' | 'extensions' | 'providers' | 'proxy';

const TAB_DEFS: { id: SettingsTab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'bash', label: 'Bash' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'providers', label: 'Providers' },
  { id: 'proxy', label: 'Proxy' },
];

const TAB_LABEL: Record<SettingsTab, string> = {
  chat: 'Chat',
  appearance: 'Appearance',
  bash: 'Bash',
  extensions: 'Extensions',
  providers: 'Providers',
  proxy: 'Proxy',
};

/** Nested-bucket allowlist labels, mirrored from the subagent section so the
 *  search index can surface those toggles by their tier name. Highest tier
 *  first to match the in-tab order. */
const NESTED_LABELS: { key: 'small' | 'medium' | 'frontier'; label: string }[] = [
  { key: 'frontier', label: 'Frontier (Opus)' },
  { key: 'medium', label: 'Medium (Sonnet)' },
  { key: 'small', label: 'Small (Haiku)' },
];

/** Continuous (non-boolean) controls surfaced as search jump entries. Clicking
 *  one switches to its tab (and expands the owning extension when applicable)
 *  so the user lands directly on the control. Haystacks include the control's
 *  own words so searching "font", "radius", "timeout", etc. always hits. */
const APPEARANCE_SETTING_LABELS = [
  'Theme', 'Background color', 'Text color', 'Border color', 'Accent color',
  'Muted text color', 'Link color', 'Corner radius', 'Density', 'Message width',
  'Expanded section height', 'Activity preview rows', 'Message rail markers',
  'Base text size', 'Composer text size', 'Expanded section text size',
  'Sans-serif font', 'Monospace font',
];
const BASH_SETTING_LABELS = ['Warm pool size', 'Bash shell path'];
const SKILL_PRUNER_SETTING_LABELS = [
  'Pruning mode', 'Pruning prepass model', 'Pruning thinking level',
  'Pruning skill limit', 'Pruning tool limit', 'Omitted skills (never pruned)',
  'Omitted tools (never pruned)',
];
const SUBAGENT_SETTING_LABELS = [
  'Subagent dropped tools', 'Subagent model buckets', 'Subagent nesting levels',
  'Subagent tree session budget', 'Subagent max in-flight',
  'Subagent max concurrency', 'Subagent max parallel tasks',
];

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

export function ComposerSettingsMenu({ prefs, pruningSettings, pruningCatalog, pruningResult, proxySettings, availableExtensions, availableModels, onSetPrefs, onSetPruningSettings, onSetProxySettings }: ComposerSettingsMenuProps) {
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
    // Exclude models whose provider is toggled off in the Providers section —
    // they're filtered out of the subagent/pruning selection pools at runtime,
    // so offering them in the picker is misleading. The full `availableModels`
    // list is still passed through for label/selected-model resolution (e.g. a
    // bucket chip whose provider was just disabled).
    () => orderModelsForPicker(filterEnabledProviders(availableModels, prefs.providerToggles)),
    [availableModels, prefs.providerToggles],
  );
  const [expandedExt, setExpandedExt] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const tablistRef = useRef<HTMLDivElement>(null);

  // Extract unique providers from available models, sorted alphabetically.
  const providers = useMemo(
    () => [...new Set(availableModels.map((m) => m.provider))].sort((a, b) => a.localeCompare(b)),
    [availableModels],
  );

  // Tabs that have content to show. Extensions and Providers are conditional on
  // available extensions/models; the rest always have content.
  const visibleTabs = useMemo(
    () => TAB_DEFS.filter((t) => {
      if (t.id === 'extensions') return availableExtensions.length > 0;
      if (t.id === 'providers') return providers.length > 0;
      return true;
    }),
    [availableExtensions.length, providers.length],
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
  const searchIndex = useMemo<SearchEntry[]>(() => {
    const entries: SearchEntry[] = [];
    const extIds = new Set(availableExtensions.map((e) => e.id));
    const hasSkillPruner = extIds.has('skill-pruner');
    const hasSubagent = extIds.has('subagent');

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

    // Continuous setting jumps.
    const pushSettings = (labels: readonly string[], tab: SettingsTab, expandExt?: string) => {
      for (const label of labels) {
        entries.push({
          type: 'jump',
          id: `set:${tab}:${expandExt ?? ''}:${label}`,
          label,
          haystack: `${TAB_LABEL[tab]} ${label}`.toLowerCase(),
          tab,
          expandExt,
        });
      }
    };
    if (visibleTabs.some((t) => t.id === 'appearance')) pushSettings(APPEARANCE_SETTING_LABELS, 'appearance');
    if (visibleTabs.some((t) => t.id === 'bash')) pushSettings(BASH_SETTING_LABELS, 'bash');
    if (hasSkillPruner) pushSettings(SKILL_PRUNER_SETTING_LABELS, 'extensions', 'skill-pruner');
    if (hasSubagent) pushSettings(SUBAGENT_SETTING_LABELS, 'extensions', 'subagent');
    if (visibleTabs.some((t) => t.id === 'proxy')) {
      pushSettings(['Proxy retries', 'Proxy timeout'], 'proxy');
      for (const name of Object.keys(proxySettings.providers)) {
        entries.push({
          type: 'jump',
          id: `set:proxy:upstream:${name}`,
          label: `Proxy ${name} upstream`,
          haystack: `proxy ${name} upstream api base api key litellm provider concurrent`.toLowerCase(),
          tab: 'proxy',
        });
      }
    }

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

    // Bash fast-path toggle.
    entries.push({
      type: 'toggle',
      id: 'bash:fastpath',
      label: 'Fast path (no shell for simple commands)',
      haystack: 'bash fast path no shell simple commands'.toLowerCase(),
      checked: !!prefs.bashFastPath,
      apply: () => onSetPrefs({ bashFastPath: !prefs.bashFastPath }),
    });

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
        haystack: 'extensions skill-pruner show pruning summary'.toLowerCase(),
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
      for (const def of NESTED_LABELS) {
        const enabled = prefs.subagentNestedAllowedBuckets[def.key] ?? true;
        entries.push({
          type: 'toggle',
          id: `subagent:nested:${def.key}`,
          label: `Allow ${def.label}`,
          haystack: `subagent nested bucket allowlist allow ${def.label}`.toLowerCase(),
          checked: enabled,
          apply: () => onSetPrefs(setNestedAllowedBucket(prefs, def.key, !enabled)),
        });
      }
    }

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

    // Proxy boolean toggles.
    const { gateway } = proxySettings;
    entries.push({
      type: 'toggle',
      id: 'proxy:retryAfter',
      label: 'Retry after header',
      haystack: 'proxy retry after header'.toLowerCase(),
      checked: !!gateway.routerSettings.retryAfter,
      apply: () => onSetProxySettings({ gateway: { routerSettings: { ...gateway.routerSettings, retryAfter: !gateway.routerSettings.retryAfter } } }),
    });
    entries.push({
      type: 'toggle',
      id: 'proxy:dropParams',
      label: 'Drop unknown params',
      haystack: 'proxy drop unknown params'.toLowerCase(),
      checked: !!gateway.litellmSettings.dropParams,
      apply: () => onSetProxySettings({ gateway: { litellmSettings: { dropParams: !gateway.litellmSettings.dropParams } } }),
    });

    return entries;
  }, [visibleTabs, availableExtensions, providers, prefs, proxySettings, onSetPrefs, onSetProxySettings]);

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

  // Cap the menu's height to the transcript's vertical space (viewport top → the
  // menu's bottom, which sits just above the toolbar) so a tall menu fills the
  // available room and its inner body scrolls instead of running off the top of
  // the screen. The menu is bottom-anchored, so its bottom edge is stable
  // regardless of content height (no feedback loop). Re-runs when the tab or
  // search mode changes, since content height changes with it.
  useLayoutEffect(() => {
    const el = settingsMenuRef.current;
    if (!open || !el) return;
    const pad = 8;
    const fit = () => {
      const rect = el.getBoundingClientRect();
      el.style.maxHeight = `${Math.max(180, rect.bottom - pad)}px`;
    };
    fit();
    const t = window.setTimeout(fit, 320);
    window.addEventListener('resize', fit);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('resize', fit);
    };
  }, [open, effectiveTab, searching]);

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
        setOpen(false);
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
      if (query) {
        setQuery('');
        return;
      }
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, query]);

  // WAI-ARIA tabs pattern: arrow keys move selection between visible tabs and
  // focus follows, so the tab strip is keyboard-navigable without Tab cycling.
  const onTablistKeyDown = (event: KeyboardEvent) => {
    const ids = visibleTabs.map((t) => t.id);
    if (ids.length === 0) return;
    const idx = ids.indexOf(effectiveTab);
    let next: SettingsTab | null = null;
    if (event.key === 'ArrowRight') next = ids[(idx + 1) % ids.length];
    else if (event.key === 'ArrowLeft') next = ids[(idx - 1 + ids.length) % ids.length];
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
      <button
        ref={triggerRef}
        class={`toolbar-settings-trigger${open ? ' open' : ''}`}
        type="button"
        aria-label="Chat settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Chat settings"
        onClick={() => setOpen((current) => !current)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 .99-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51.99H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {open && (
        <div ref={settingsMenuRef} class="toolbar-settings-menu" role="dialog" aria-label="Chat settings">
          <div class="toolbar-settings-search">
            <svg class="toolbar-settings-search-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" />
              <line x1="10.5" y1="10.5" x2="14" y2="14" />
            </svg>
            <input
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

          {!searching && (
            <div ref={tablistRef} class="toolbar-settings-tabs" role="tablist" aria-label="Settings categories" onKeyDown={onTablistKeyDown}>
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
                    onClick={() => setActiveTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
          )}

          <div
            id={tabpanelId}
            class="toolbar-settings-menu-body"
            role="tabpanel"
            aria-labelledby={`toolbar-settings-tab-${effectiveTab}`}
          >
            {searching ? (
              <div class="toolbar-settings-search-results">
                {searchResults.jumps.length === 0 && searchResults.toggles.length === 0 && (
                  <div class="toolbar-settings-search-empty">No settings match “{query}”.</div>
                )}
                {searchResults.jumps.map((entry) => (
                  <button
                    key={entry.id}
                    class="toolbar-settings-search-result toolbar-settings-search-result-jump"
                    type="button"
                    onClick={() => jumpTo(entry.tab, entry.expandExt)}
                  >
                    <span class="toolbar-settings-search-result-label">{entry.label}</span>
                    <span class="toolbar-settings-search-result-meta">{TAB_LABEL[entry.tab]}</span>
                  </button>
                ))}
                {searchResults.toggles.map((entry) => (
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
            ) : (
              <>
                {effectiveTab === 'chat' && (
                  <>
                    <ChatPrefSections prefs={prefs} onSetPrefs={onSetPrefs} />
                    <SoundSection prefs={prefs} onSetPrefs={onSetPrefs} />
                  </>
                )}
                {effectiveTab === 'appearance' && (
                  <AppearanceSection prefs={prefs} onSetPrefs={onSetPrefs} />
                )}
                {effectiveTab === 'bash' && (
                  <BashSection prefs={prefs} onSetPrefs={onSetPrefs} />
                )}
                {effectiveTab === 'extensions' && (
                  <ExtensionsSection
                    availableExtensions={availableExtensions}
                    prefs={prefs}
                    onSetPrefs={onSetPrefs}
                    expandedExt={expandedExt}
                    setExpandedExt={setExpandedExt}
                    pruningSettings={pruningSettings}
                    modelEntries={modelEntries}
                    availableModels={availableModels}
                    skillCatalog={skillCatalog}
                    toolCatalog={toolCatalog}
                    onSetPruningSettings={onSetPruningSettings}
                  />
                )}
                {effectiveTab === 'providers' && (
                  <ProvidersSection providers={providers} prefs={prefs} onSetPrefs={onSetPrefs} />
                )}
                {effectiveTab === 'proxy' && (
                  <ProxySection proxySettings={proxySettings} onSetProxySettings={onSetProxySettings} />
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}