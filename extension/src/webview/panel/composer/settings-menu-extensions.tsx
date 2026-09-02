/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ChatPrefs, ExtensionInfo } from '../../../shared/protocol';
import { setExtensionEnabled } from '../chat-prefs';
import { CollapsibleChevron } from '../components/chevron';
import { SettingCheckbox } from '../components/setting-checkbox';
import { BashSection } from './settings-menu-bash';
import { AskUserSettings } from './settings-menu-ask-user';
import { EXTENSIONS_WITH_SETTINGS } from './settings-menu-helpers';
import type { OnSetPrefs } from './settings-menu-types';

const MOVED_SETTINGS_NOTES: Readonly<Record<string, string>> = {
  'skill-pruner': 'Settings moved to the Context and Models tabs.',
  subagent: 'Settings moved to the Subagents and Models tabs.',
  'tool-result-pruner': 'Settings moved to the Context tab.',
};

interface ExtensionItemProps {
  ext: ExtensionInfo;
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
  isExpanded: boolean;
  setExpandedExt: (next: string | null) => void;
}

function ExtensionItem({ ext, prefs, onSetPrefs, isExpanded, setExpandedExt }: ExtensionItemProps) {
  const checked = prefs.extensionToggles[ext.id] !== false;
  const hasSettings = EXTENSIONS_WITH_SETTINGS.has(ext.id);
  const onChevronClick = () => setExpandedExt(isExpanded ? null : ext.id);
  const movedNote = MOVED_SETTINGS_NOTES[ext.id];
  return (
    <div class="toolbar-settings-ext-group">
      <div class="toolbar-settings-ext-row">
        <SettingCheckbox
          label={ext.label}
          checked={checked}
          title={ext.description}
          onChange={() => onSetPrefs(setExtensionEnabled(prefs, ext.id, !checked))}
          trailing={hasSettings && (
            <button
              class={`toolbar-settings-ext-chevron${isExpanded ? ' expanded' : ''}`}
              type="button"
              aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${ext.label} settings`}
              aria-expanded={isExpanded}
              onClick={onChevronClick}
            >
              <CollapsibleChevron open={isExpanded} size={12} />
            </button>
          )}
        />
      </div>
      {hasSettings && isExpanded && movedNote && (
        <div class="toolbar-settings-note">{movedNote}</div>
      )}
      {hasSettings && isExpanded && ext.id === 'warm-bash' && (
        <BashSection prefs={prefs} onSetPrefs={onSetPrefs} />
      )}
      {hasSettings && isExpanded && ext.id === 'ask-user' && (
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
}

export function ExtensionsSection({ availableExtensions, prefs, onSetPrefs, expandedExt, setExpandedExt }: ExtensionsSectionProps) {
  return (
    <div key="extensions" class="toolbar-settings-section">
      <div class="toolbar-settings-list">
        {availableExtensions.map((ext) => (
          <ExtensionItem
            key={ext.id}
            ext={ext}
            prefs={prefs}
            onSetPrefs={onSetPrefs}
            isExpanded={expandedExt === ext.id}
            setExpandedExt={setExpandedExt}
          />
        ))}
      </div>
    </div>
  );
}
