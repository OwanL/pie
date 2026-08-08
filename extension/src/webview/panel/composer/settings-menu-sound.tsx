/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { playCompletionSound, warmupCompletionSoundContext } from '../completion-sound';
import type { ChatPrefs } from '../../../shared/protocol';
import { CHAT_PREF_MENU_SECTIONS } from '../chat-prefs';
import { ChatPrefItem } from './settings-menu-chat-prefs';
import type { OnSetPrefs } from './settings-menu-types';

const notificationItem = CHAT_PREF_MENU_SECTIONS
  .find((section) => section.id === 'notifications')
  ?.items[0];

export function SoundSection({ prefs, onSetPrefs }: { prefs: ChatPrefs; onSetPrefs: OnSetPrefs }) {
  return (
    <div key="sound" class="toolbar-settings-section">
      <div class="toolbar-settings-section-label">Completion notifications</div>
      <div class="toolbar-settings-list">
        {notificationItem && <ChatPrefItem item={notificationItem} prefs={prefs} onSetPrefs={onSetPrefs} />}
        <div class="toolbar-settings-item toolbar-settings-mode-row toolbar-settings-sound-row">
          <span class="toolbar-settings-item-label">Sound volume</span>
          <div class="toolbar-settings-sound-controls">
            <span class="toolbar-settings-control-value">
              {prefs.completionSoundVolume === 0 ? 'Off' : `${prefs.completionSoundVolume}%`}
            </span>
            <input
              type="range"
              class="toolbar-settings-slider"
              min="0"
              max="100"
              step="5"
              value={prefs.completionSoundVolume}
              onInput={(e) => onSetPrefs({ completionSoundVolume: Number((e.target as HTMLInputElement).value) })}
              aria-label="Completion sound volume"
            />
            <button
              type="button"
              class="toolbar-settings-test-btn"
              disabled={prefs.completionSoundVolume === 0}
              onClick={() => { warmupCompletionSoundContext(); playCompletionSound(prefs.completionSoundVolume); }}
              aria-label="Test completion sound"
            >Test</button>
          </div>
        </div>
      </div>
    </div>
  );
}
