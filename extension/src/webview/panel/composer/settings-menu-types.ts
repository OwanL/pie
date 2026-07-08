import type { ChatPrefs, PruningSettings, ToolResultPruningSettings } from '../../../shared/protocol';

export type OnSetPrefs = (prefs: Partial<ChatPrefs>) => void;
export type OnSetPruningSettings = (settings: Partial<PruningSettings>) => void;
export type OnSetToolResultPruningSettings = (settings: Partial<ToolResultPruningSettings>) => void;
