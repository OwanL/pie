/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ChatPrefs } from '../../../shared/protocol';
import { CHAT_PREF_MENU_SECTIONS, toggleChatPref } from '../chat-prefs';
import type { OnSetPrefs } from './settings-menu-types';

export type ChatPrefItemDef = (typeof CHAT_PREF_MENU_SECTIONS)[number]['items'][number];

export function ChatPrefItem({ item, prefs, onSetPrefs }: { item: ChatPrefItemDef; prefs: ChatPrefs; onSetPrefs: OnSetPrefs }) {
  const checked = prefs[item.key];
  return (
    <button
      class={`toolbar-settings-item${checked ? ' checked' : ''}`}
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onSetPrefs(toggleChatPref(prefs, item.key))}
    >
      <span class="toolbar-settings-item-check" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={checked ? '' : 'opacity:0'}>
          <polyline points="2.5,6.5 5,9 10.5,3.5" />
        </svg>
      </span>
      <span class="toolbar-settings-item-label">{item.label}</span>
    </button>
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
