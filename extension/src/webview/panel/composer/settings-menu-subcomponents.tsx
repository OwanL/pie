/**
 * Barrel for the settings-menu subcomponents. The subcomponents themselves live
 * in cohesive sibling modules (`settings-menu-*` / `ui-appearance-settings`);
 * this file re-exports the public surface that `settings-menu.tsx` and tests
 * depend on. The menu is tabbed — appearance and subagent settings render inline
 * inside their tabs rather than as side flyouts.
 */
export type { OnSetPrefs, OnSetPruningSettings } from './settings-menu-types';
export { ChatPrefSections } from './settings-menu-chat-prefs';
export { SoundSection } from './settings-menu-sound';
export { BashSection } from './settings-menu-bash';
export { SubagentModelAssignments, SubagentSection } from './settings-menu-subagent';
export { SessionTitlesModelAssignment, SessionTitlesSection } from './settings-menu-session-titles';
export { HistoryCompactionModelAssignment, HistoryCompactionSection } from './settings-menu-history-compaction';
export { SkillPrunerModelAssignment, SkillPrunerSettings } from './settings-menu-skill-pruner';
export { ToolResultPrunerSettings } from './settings-menu-tool-result-pruner';
export { ChatDefaultModelAssignment } from './settings-menu-models';
export { ExtensionsSection } from './settings-menu-extensions';
export { McpSection } from './settings-menu-mcp';
export { ProvidersSection } from './settings-menu-providers';
export { AppearanceSection, UiGroupLabel } from './ui-appearance-settings';