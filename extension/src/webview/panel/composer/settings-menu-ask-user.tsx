/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ChatPrefs } from '../../../shared/protocol';
import { isAskUserForSubagentsEnabled, setAskUserForSubagents } from '../chat-prefs';
import type { OnSetPrefs } from './settings-menu-types';

interface AskUserSettingsProps {
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
}

/**
 * Settings panel for the `ask-user` extension. Currently exposes a single
 * toggle controlling whether the `ask_user` tool is available to subagents.
 *
 * The toggle reuses the shared `subagentDropTools` mechanism (the same one the
 * Subagent section's "Dropped tools" editor manages) rather than introducing a
 * dedicated pref: enabling here removes `ask_user` from the drop list, and
 * disabling adds it. The two stay in sync — toggling here is just a friendly
 * shortcut for managing `ask_user` membership in that list.
 *
 * Mirrors {@link ToolResultPrunerSettings}'s structure: a
 * `toolbar-settings-ext-settings` container with `toolbar-settings-item`
 * checkbox rows. No dedicated CSS — reuses the shared settings-menu classes.
 */
export function AskUserSettings({ prefs, onSetPrefs }: AskUserSettingsProps) {
  const enabled = isAskUserForSubagentsEnabled(prefs);
  return (
    <div class="toolbar-settings-ext-settings">
      <button
        class={`toolbar-settings-item${enabled ? ' checked' : ''}`}
        type="button"
        role="checkbox"
        aria-checked={enabled}
        onClick={() => onSetPrefs(setAskUserForSubagents(prefs, !enabled))}
      >
        <span class="toolbar-settings-item-check" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={enabled ? '' : 'opacity:0'}>
            <polyline points="2.5,6.5 5,9 10.5,3.5" />
          </svg>
        </span>
        <span class="toolbar-settings-item-label">Include for subagents</span>
      </button>
      <div class="toolbar-settings-item-hint">
        When off, subagents cannot call <code>ask_user</code> — they must decide without prompting you. Mirrored to the subagent runner via the shared dropped-tools list.
      </div>
    </div>
  );
}