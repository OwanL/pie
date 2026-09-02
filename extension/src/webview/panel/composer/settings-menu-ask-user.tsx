/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ChatPrefs } from '../../../shared/protocol';
import { isAskUserForSubagentsEnabled, setAskUserForSubagents } from '../chat-prefs';
import { SettingCheckbox } from '../components/setting-checkbox';
import type { OnSetPrefs } from './settings-menu-types';

export const ASK_USER_SETTING_LABELS = ['Include for subagents'] as const;

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
      <SettingCheckbox
        label="Include for subagents"
        checked={enabled}
        onChange={() => onSetPrefs(setAskUserForSubagents(prefs, !enabled))}
      />
      <div class="toolbar-settings-item-hint">
        When off, subagents cannot call <code>ask_user</code> — they must decide without prompting you. Mirrored to the subagent runner via the shared dropped-tools list.
      </div>
    </div>
  );
}