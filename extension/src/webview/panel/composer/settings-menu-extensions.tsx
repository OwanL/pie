/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ChatPrefs, ExtensionInfo, ModelInfo, PruningSettings, ToolResultPruningSettings } from '../../../shared/protocol';
import { setExtensionEnabled } from '../chat-prefs';
import { orderModelsForPicker } from './model-list';
import { CollapsibleChevron } from '../components/chevron';
import { BashSection } from './settings-menu-bash';
import { AskUserSettings } from './settings-menu-ask-user';
import { EXTENSIONS_WITH_SETTINGS } from './settings-menu-helpers';
import { SkillPrunerSettings } from './settings-menu-skill-pruner';
import { SubagentSection } from './settings-menu-subagent';
import { ToolResultPrunerSettings } from './settings-menu-tool-result-pruner';
import type { OnSetPrefs, OnSetPruningSettings, OnSetToolResultPruningSettings } from './settings-menu-types';

interface ExtensionItemProps {
  ext: ExtensionInfo;
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
  isExpanded: boolean;
  setExpandedExt: (next: string | null) => void;
  pruningSettings: PruningSettings;
  toolResultPruningSettings: ToolResultPruningSettings;
  modelEntries: ReturnType<typeof orderModelsForPicker>;
  availableModels: ModelInfo[];
  skillCatalog: string[];
  toolCatalog: string[];
  onSetPruningSettings: OnSetPruningSettings;
  onSetToolResultPruningSettings: OnSetToolResultPruningSettings;
}

function ExtensionItem({ ext, prefs, onSetPrefs, isExpanded, setExpandedExt, pruningSettings, toolResultPruningSettings, modelEntries, availableModels, skillCatalog, toolCatalog, onSetPruningSettings, onSetToolResultPruningSettings }: ExtensionItemProps) {
  const checked = prefs.extensionToggles[ext.id] !== false;
  const hasSettings = EXTENSIONS_WITH_SETTINGS.has(ext.id);
  // Extensions with nested settings expand inline under their row (skill-pruner
  // and subagent both use the same inline expansion mechanism).
  const expanded = isExpanded;
  const onChevronClick = () => setExpandedExt(isExpanded ? null : ext.id);
  return (
    <div class="toolbar-settings-ext-group">
      <div class="toolbar-settings-ext-row">
        <button
          class={`toolbar-settings-item${checked ? ' checked' : ''}`}
          type="button"
          role="checkbox"
          aria-checked={checked}
          title={ext.description}
          onClick={() => onSetPrefs(setExtensionEnabled(prefs, ext.id, !checked))}
        >
          <span class="toolbar-settings-item-check" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={checked ? '' : 'opacity:0'}>
              <polyline points="2.5,6.5 5,9 10.5,3.5" />
            </svg>
          </span>
          <span class="toolbar-settings-item-label">{ext.label}</span>
        </button>
        {hasSettings && (
          <button
            class={`toolbar-settings-ext-chevron${expanded ? ' expanded' : ''}`}
            type="button"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${ext.label} settings`}
            aria-expanded={expanded}
            onClick={onChevronClick}
          >
            <CollapsibleChevron open={expanded} size={12} />
          </button>
        )}
      </div>
      {hasSettings && expanded && ext.id === 'skill-pruner' && (
        <SkillPrunerSettings
          prefs={prefs}
          pruningSettings={pruningSettings}
          modelEntries={modelEntries}
          availableModels={availableModels}
          skillCatalog={skillCatalog}
          toolCatalog={toolCatalog}
          onSetPrefs={onSetPrefs}
          onSetPruningSettings={onSetPruningSettings}
        />
      )}
      {hasSettings && expanded && ext.id === 'subagent' && (
        <SubagentSection
          prefs={prefs}
          onSetPrefs={onSetPrefs}
          availableModels={availableModels}
        />
      )}
      {hasSettings && expanded && ext.id === 'tool-result-pruner' && (
        <ToolResultPrunerSettings
          settings={toolResultPruningSettings}
          onSetToolResultPruningSettings={onSetToolResultPruningSettings}
        />
      )}
      {hasSettings && expanded && ext.id === 'warm-bash' && (
        <BashSection prefs={prefs} onSetPrefs={onSetPrefs} />
      )}
      {hasSettings && expanded && ext.id === 'ask-user' && (
        <AskUserSettings prefs={prefs} onSetPrefs={onSetPrefs} />
      )}
    </div>
  );
}

interface ExtensionsSectionProps {
  availableExtensions: ExtensionInfo[];
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
  expandedExt: string | null;
  setExpandedExt: (next: string | null) => void;
  pruningSettings: PruningSettings;
  toolResultPruningSettings: ToolResultPruningSettings;
  modelEntries: ReturnType<typeof orderModelsForPicker>;
  availableModels: ModelInfo[];
  skillCatalog: string[];
  toolCatalog: string[];
  onSetPruningSettings: OnSetPruningSettings;
  onSetToolResultPruningSettings: OnSetToolResultPruningSettings;
}

export function ExtensionsSection({ availableExtensions, prefs, onSetPrefs, expandedExt, setExpandedExt, pruningSettings, toolResultPruningSettings, modelEntries, availableModels, skillCatalog, toolCatalog, onSetPruningSettings, onSetToolResultPruningSettings }: ExtensionsSectionProps) {
  return (
    <div key="extensions" class="toolbar-settings-section">
      <div class="toolbar-settings-section-label">Extensions</div>
      <div class="toolbar-settings-list">
        {availableExtensions.map((ext) => (
          <ExtensionItem
            key={ext.id}
            ext={ext}
            prefs={prefs}
            onSetPrefs={onSetPrefs}
            isExpanded={expandedExt === ext.id}
            setExpandedExt={setExpandedExt}
            pruningSettings={pruningSettings}
            toolResultPruningSettings={toolResultPruningSettings}
            modelEntries={modelEntries}
            availableModels={availableModels}
            skillCatalog={skillCatalog}
            toolCatalog={toolCatalog}
            onSetPruningSettings={onSetPruningSettings}
            onSetToolResultPruningSettings={onSetToolResultPruningSettings}
          />
        ))}
      </div>
    </div>
  );
}
