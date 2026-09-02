/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ChatPrefs } from '../../../shared/protocol';
import { CHAT_PREF_MENU_SECTIONS, toggleChatPref } from '../chat-prefs';
import { SettingCheckbox } from '../components/setting-checkbox';
import type { OnSetPrefs } from './settings-menu-types';

export type ChatPrefItemDef = (typeof CHAT_PREF_MENU_SECTIONS)[number]['items'][number];

export const CHAT_PREF_SECTION_SEARCH_DEFS = CHAT_PREF_MENU_SECTIONS.map((section) => ({
  id: section.id,
  label: section.label,
  labels: section.items.map((item) => item.label),
}));

/** Prefs-bound wrapper over the generic {@link SettingCheckbox} row. */
export function ChatPrefItem({ item, prefs, onSetPrefs }: { item: ChatPrefItemDef; prefs: ChatPrefs; onSetPrefs: OnSetPrefs }) {
  return (
    <SettingCheckbox
      label={item.label}
      checked={prefs[item.key]}
      onChange={() => onSetPrefs(toggleChatPref(prefs, item.key))}
    />
  );
}

export function ChatPrefSections({
  prefs,
  onSetPrefs,
  sectionIds,
}: {
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
  sectionIds?: readonly string[];
}) {
  const sections = sectionIds
    ? CHAT_PREF_MENU_SECTIONS.filter((section) => sectionIds.includes(section.id))
    : CHAT_PREF_MENU_SECTIONS;
  return (
    <>
      {sections.map((section) => (
        <div key={section.id} class="toolbar-settings-section">
          {section.label && <div class="toolbar-settings-section-label">{section.label}</div>}
          <div class="toolbar-settings-list">
            {section.items.map((item) => (
              <ChatPrefItem key={item.key} item={item} prefs={prefs} onSetPrefs={onSetPrefs} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
