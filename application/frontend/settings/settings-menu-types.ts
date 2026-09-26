import type { ChatPrefs, PruningSettings, SessionTitlesSettings, ToolResultPruningSettings } from '../../lib/protocol/index.js';

export type OnSetPrefs = (prefs: Partial<ChatPrefs>) => void;
export type OnSetPruningSettings = (settings: Partial<PruningSettings>) => void;
export type OnSetToolResultPruningSettings = (settings: Partial<ToolResultPruningSettings>) => void;
export type OnSetSessionTitlesSettings = (settings: Partial<SessionTitlesSettings>) => void;
