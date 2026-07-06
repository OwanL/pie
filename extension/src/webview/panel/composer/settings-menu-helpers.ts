import type { ChatPrefs, PruningMode, UiDensity } from '../../../shared/protocol';

export { THINKING_LEVEL_OPTIONS } from '../../../shared/thinking-level.js';

/** Extension IDs that have nested settings panels */
export const EXTENSIONS_WITH_SETTINGS = new Set(['skill-pruner', 'subagent', 'tool-result-pruner', 'warm-bash', 'ask-user']);

export const PRUNING_MODE_OPTIONS: { value: PruningMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'shadow', label: 'Shadow' },
  { value: 'off', label: 'Off' },
];

export const DENSITY_OPTIONS: { value: UiDensity; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'spacious', label: 'Spacious' },
];

/** A coordinated color palette applied as a batch. Selecting a preset writes
 *  all four color prefs at once; the user can then tweak individual colors, at
 *  which point the picker shows "Custom". The "night" preset is the bundled
 *  default (all empty → stylesheet defaults win). */
export interface UiThemePreset {
  id: string;
  label: string;
  background: string;
  foreground: string;
  border: string;
  accent: string;
  /** Muted text color override; '' means "derive from foreground / use the
   *  bundled default" (presets don't pin a muted shade). */
  muted: string;
  /** Link color override; '' means "follow the accent" (the bundled default). */
  link: string;
}

export const UI_THEME_PRESETS: UiThemePreset[] = [
  { id: 'night', label: 'Night', background: '', foreground: '', border: '', accent: '', muted: '', link: '' },
  { id: 'slate', label: 'Slate', background: '#0d1117', foreground: '#c9d1d9', border: '#30363d', accent: '#58a6ff', muted: '', link: '' },
  { id: 'warm', label: 'Warm', background: '#1a1410', foreground: '#ede0d4', border: '#3a2e24', accent: '#e0a458', muted: '', link: '' },
  { id: 'midnight', label: 'Midnight', background: '#060614', foreground: '#d6d8f5', border: '#2a2d52', accent: '#8b93ff', muted: '', link: '' },
  { id: 'carbon', label: 'Carbon', background: '#0a0a0a', foreground: '#e6e6e6', border: '#2e2e2e', accent: '#4ade80', muted: '', link: '' },
];

/** Returns the id of the theme preset whose palette exactly matches the given
 *  color prefs, or '' when the colors don't match any preset (Custom). */
export function matchUiThemePreset(prefs: {
  uiBackground: string;
  uiForeground: string;
  uiBorder: string;
  uiAccentColor: string;
  uiMutedColor: string;
  uiLinkColor: string;
}): string {
  for (const p of UI_THEME_PRESETS) {
    if (
      p.background === prefs.uiBackground
      && p.foreground === prefs.uiForeground
      && p.border === prefs.uiBorder
      && p.accent === prefs.uiAccentColor
      && p.muted === prefs.uiMutedColor
      && p.link === prefs.uiLinkColor
    ) {
      return p.id;
    }
  }
  return '';
}

/** Convert a preset into a prefs patch that writes its color fields (muted/link
 *  reset to '' so selecting a preset gives a clean, coordinated palette). */
export function uiThemePresetToPrefs(
  preset: UiThemePreset,
): Partial<Pick<ChatPrefs, 'uiBackground' | 'uiForeground' | 'uiBorder' | 'uiAccentColor' | 'uiMutedColor' | 'uiLinkColor'>> {
  return {
    uiBackground: preset.background,
    uiForeground: preset.foreground,
    uiBorder: preset.border,
    uiAccentColor: preset.accent,
    uiMutedColor: preset.muted,
    uiLinkColor: preset.link,
  };
}

/**
 * Tools contributed by non-extension providers are only visible to the backend
 * when they are active. After pruning, analytics can therefore contain only the
 * kept subset, which makes the always-keep picker unable to recover omitted
 * provider tools. Seed the picker with the stable built-in/provider tools so
 * users can pin them even when the previous turn pruned them away.
 */
export const DEFAULT_TOOL_KEEP_CATALOG = [
  'ask_user',
  'bash',
  'code_search',
  'edit',
  'fetch_content',
  'find',
  'get_search_content',
  'grep',
  'ls',
  'read',
  'request_tool',
  'web_search',
  'write',
];

/** Compute a sorted, deduplicated catalog for the always-keep picker. */
export function computeKeepCatalog(
  discoveredNames: string[],
  fromPruningResult: { included?: string[]; excluded?: string[] } | null,
  currentlySelected: string[],
): string[] {
  const set = new Set<string>();
  for (const name of discoveredNames) set.add(name);
  for (const name of fromPruningResult?.included ?? []) set.add(name);
  for (const name of fromPruningResult?.excluded ?? []) set.add(name);
  // Always-keep items are filtered OUT of the prepass input, so they will not
  // appear in included/excluded after the next pruning turn. Union them in so
  // they remain visible/removable in the picker.
  for (const name of currentlySelected) set.add(name);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Compute the tool catalog, including provider tools that may be hidden by pruning. */
export function computeToolKeepCatalog(
  discoveredNames: string[],
  fromPruningResult: { included?: string[]; excluded?: string[] } | null,
  currentlySelected: string[],
): string[] {
  return computeKeepCatalog(
    [...DEFAULT_TOOL_KEEP_CATALOG, ...discoveredNames],
    fromPruningResult,
    currentlySelected,
  );
}
