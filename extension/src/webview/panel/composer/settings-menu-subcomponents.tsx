/**
 * Barrel for the settings-menu subcomponents. The subcomponents themselves live
 * in cohesive sibling modules (`settings-menu-*` / `ui-appearance-settings`);
 * this file re-exports the public surface that `settings-menu.tsx` and tests
 * depend on. The menu is tabbed — appearance and subagent settings render inline
 * inside their tabs rather than as side flyouts.
 */
export type { OnSetPrefs, OnSetPruningSettings, OnSetProxySettings } from './settings-menu-types';
export { ChatPrefSections } from './settings-menu-chat-prefs';
export { SoundSection } from './settings-menu-sound';
export { BashSection } from './settings-menu-bash';
export { SubagentSection } from './settings-menu-subagent';
export { ExtensionsSection } from './settings-menu-extensions';
export { ProvidersSection } from './settings-menu-providers';
export { ProxySection } from './settings-menu-proxy';
export { AppearanceSection, UiGroupLabel } from './ui-appearance-settings';