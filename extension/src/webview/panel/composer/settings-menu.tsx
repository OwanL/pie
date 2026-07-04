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
  ChatPrefSections,
  ExtensionsSection,
  ProvidersSection,
  ProxySection,
  SoundSection,
  SubagentFlyout,
  UiFlyout,
  UiSubmenuTrigger,
  BashSection,
} from './settings-menu-subcomponents';

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
  const [uiOpen, setUiOpen] = useState(false);
  const [subagentOpen, setSubagentOpen] = useState(false);
  // Only one side flyout can be open at a time — they share the space to the
  // right of the settings menu, so opening one closes the other.
  const toggleUi = () => setUiOpen((v) => {
    const next = !v;
    if (next) setSubagentOpen(false);
    return next;
  });
  const toggleSubagent = () => setSubagentOpen((v) => {
    const next = !v;
    if (next) setUiOpen(false);
    return next;
  });
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const settingsMenuRef = useRef<HTMLDivElement>(null);

  // Cap the menu's height to the transcript's vertical space (viewport top → the
  // menu's bottom, which sits just above the toolbar) so a tall menu fills the
  // available room and its inner body scrolls instead of running off the top of
  // the screen. CSS max-height: calc(100vh - 32px) overestimates the room
  // because it ignores the toolbar/composer height. The menu is bottom-anchored,
  // so its bottom edge is stable regardless of content height (no feedback loop).
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
      //
      // The picker dropdown is portaled to document.body, so we can't gate on
      // menuRef.contains(active); matching the dropdown class is sufficient.
      const active = document.activeElement as HTMLElement | null;
      if (active && active.closest('.model-picker-dropdown')) {
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
  }, [open]);

  // Extract unique providers from available models, sorted alphabetically
  const providers = [...new Set(availableModels.map((m) => m.provider))].sort((a, b) =>
    a.localeCompare(b),
  );

  return (
    <div ref={menuRef} class="toolbar-settings">
      <button
        ref={triggerRef}
        class={`toolbar-settings-trigger${open ? ' open' : ''}`}
        type="button"
        aria-label="Chat settings"
        aria-haspopup="menu"
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
        <div ref={settingsMenuRef} class="toolbar-settings-menu" role="menu" aria-label="Chat settings menu">
          <div class="toolbar-settings-menu-body">
            <ChatPrefSections prefs={prefs} onSetPrefs={onSetPrefs} />
            <UiSubmenuTrigger open={uiOpen} onToggle={toggleUi} />
            <SoundSection prefs={prefs} onSetPrefs={onSetPrefs} />
            <BashSection prefs={prefs} onSetPrefs={onSetPrefs} />
            {availableExtensions.length > 0 && (
              <ExtensionsSection
                availableExtensions={availableExtensions}
                prefs={prefs}
                onSetPrefs={onSetPrefs}
                expandedExt={expandedExt}
                setExpandedExt={setExpandedExt}
                subagentOpen={subagentOpen}
                onToggleSubagent={toggleSubagent}
                pruningSettings={pruningSettings}
                modelEntries={modelEntries}
                availableModels={availableModels}
                skillCatalog={skillCatalog}
                toolCatalog={toolCatalog}
                onSetPruningSettings={onSetPruningSettings}
              />
            )}
            {providers.length > 0 && (
              <ProvidersSection providers={providers} prefs={prefs} onSetPrefs={onSetPrefs} />
            )}
            <ProxySection proxySettings={proxySettings} onSetProxySettings={onSetProxySettings} />
          </div>
          {uiOpen && <UiFlyout prefs={prefs} onSetPrefs={onSetPrefs} />}
          {subagentOpen && (
            <SubagentFlyout
              prefs={prefs}
              onSetPrefs={onSetPrefs}
              availableModels={availableModels}
              modelEntries={modelEntries}
            />
          )}
        </div>
      )}
    </div>
  );
}
