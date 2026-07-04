import type { ChatPrefs, PruningSettings, ProxySettings, ProxySettingsUpdate } from '../../../shared/protocol';

export type OnSetPrefs = (prefs: Partial<ChatPrefs>) => void;
export type OnSetPruningSettings = (settings: Partial<PruningSettings>) => void;
export type OnSetProxySettings = (settings: ProxySettingsUpdate) => void;
