/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ChatPrefs } from '../../lib/protocol/index.js';
import { isAskUserForSubagentsEnabled, setAskUserForSubagents } from '../shell/chat-prefs';
import { SettingCheckbox } from './setting-checkbox';
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
        hint={<>When enabled, <code>ask_user</code> is removed from the shared dropped-tools list; when off, it is added, so subagents decide without prompting you. This mirrors the Subagent settings' dropped-tools control.</>}
        onChange={() => onSetPrefs(setAskUserForSubagents(prefs, !enabled))}
      />
    </div>
  );
}