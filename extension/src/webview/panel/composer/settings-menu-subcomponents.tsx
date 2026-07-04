/**
 * Barrel for the settings-menu subcomponents. The subcomponents themselves live
 * in cohesive sibling modules (`settings-menu-*`); this file re-exports the
 * public surface that `settings-menu.tsx` and the UI-appearance module depend
 * on, plus the `UiSubmenuTrigger` / `UiFlyout` re-exports previously surfaced
 * here. Behavior is unchanged — only the physical split moved.
 */
export type { OnSetPrefs } from './settings-menu-types';
export { ChatPrefSections } from './settings-menu-chat-prefs';
export { SoundSection } from './settings-menu-sound';
export { SubagentFlyout } from './settings-menu-subagent';
export { ExtensionsSection } from './settings-menu-extensions';
export { ProvidersSection } from './settings-menu-providers';
export { ProxySection } from './settings-menu-proxy';
export { UiSubmenuTrigger, UiFlyout } from './ui-appearance-settings';
