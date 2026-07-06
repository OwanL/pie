import type { ChatPrefs, PruningSettings, ProxyProviderAddInput, ProxySettings, ProxySettingsUpdate, ToolResultPruningSettings } from '../../../shared/protocol';

export type OnSetPrefs = (prefs: Partial<ChatPrefs>) => void;
export type OnSetPruningSettings = (settings: Partial<PruningSettings>) => void;
export type OnSetToolResultPruningSettings = (settings: Partial<ToolResultPruningSettings>) => void;
export type OnSetProxySettings = (settings: ProxySettingsUpdate) => void;
export type OnAddProxyProvider = (input: ProxyProviderAddInput) => void;
