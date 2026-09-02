/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren } from 'preact';
import {
  COMPOSER_INITIAL_ROWS_MAX,
  COMPOSER_INITIAL_ROWS_MIN,
  type ChatPrefs,
  type UiDensity,
} from '../../../shared/protocol';
import { CHAT_PREF_MENU_SECTIONS } from '../chat-prefs';
import { ChatPrefItem } from './settings-menu-chat-prefs';
import { SliderRow } from '../components/slider-row';
import { DENSITY_OPTIONS, UI_THEME_PRESETS, matchUiThemePreset, uiThemePresetToPrefs } from './settings-menu-helpers';
import type { OnSetPrefs } from './settings-menu-types';

export const APPEARANCE_SETTING_LABELS = [
  'Theme',
  'Background',
  'Text',
  'Border',
  'Accent',
  'Muted text',
  'Links',
  'Corner radius',
  'Density',
  'Path parent depth',
  'Message width',
  'Initial composer rows',
  'Expanded height',
  'Activity rows',
  'Rail markers',
  'Base text',
  'Composer text',
  'Expanded text',
  'Sans font',
  'Mono font',
] as const;

interface FontOption {
  label: string;
  /** CSS font-family stack. Empty string means "use the bundled default". */
  value: string;
}

/** Curated sans-serif (plus a few serif) stacks for the UI font picker. */
const SANS_FONT_OPTIONS: ReadonlyArray<FontOption> = [
  { label: 'Default', value: '' },
  { label: 'Inter', value: 'Inter, "Segoe UI", system-ui, sans-serif' },
  { label: 'Roboto', value: 'Roboto, "Segoe UI", system-ui, sans-serif' },
  { label: 'Open Sans', value: '"Open Sans", "Segoe UI", system-ui, sans-serif' },
  { label: 'Montserrat', value: 'Montserrat, "Segoe UI", system-ui, sans-serif' },
  { label: 'Lato', value: 'Lato, "Segoe UI", system-ui, sans-serif' },
  { label: 'Source Sans 3', value: '"Source Sans 3", "Source Sans Pro", "Segoe UI", sans-serif' },
  { label: 'Noto Sans', value: '"Noto Sans", "Segoe UI", system-ui, sans-serif' },
  { label: 'Ubuntu', value: 'Ubuntu, "Segoe UI", system-ui, sans-serif' },
  { label: 'Calibri', value: 'Calibri, Candara, "Segoe UI", system-ui, sans-serif' },
  { label: 'System UI', value: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif' },
  { label: 'Segoe UI', value: '"Segoe UI", system-ui, sans-serif' },
  { label: 'Helvetica', value: 'Helvetica, Arial, sans-serif' },
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  { label: 'Tahoma', value: 'Tahoma, Geneva, sans-serif' },
  { label: 'Trebuchet MS', value: '"Trebuchet MS", Helvetica, sans-serif' },
  { label: 'Century Gothic', value: '"Century Gothic", "Apple Gothic", "Segoe UI", sans-serif' },
  { label: 'Geneva', value: 'Geneva, Tahoma, Verdana, sans-serif' },
  { label: 'Georgia (serif)', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Times New Roman (serif)', value: '"Times New Roman", Times, serif' },
  { label: 'Garamond (serif)', value: 'Garamond, "Times New Roman", serif' },
  { label: 'Cambria (serif)', value: 'Cambria, Georgia, serif' },
  { label: 'Palatino (serif)', value: '"Palatino Linotype", Palatino, Georgia, serif' },
];

/** Curated monospace stacks for the code/tool-output font picker. */
const MONO_FONT_OPTIONS: ReadonlyArray<FontOption> = [
  { label: 'Default', value: '' },
  { label: 'JetBrains Mono', value: '"JetBrains Mono", "Cascadia Code", Consolas, monospace' },
  { label: 'Cascadia Code', value: '"Cascadia Code", "JetBrains Mono", Consolas, monospace' },
  { label: 'Fira Code', value: '"Fira Code", "JetBrains Mono", Consolas, monospace' },
  { label: 'IBM Plex Mono', value: '"IBM Plex Mono", "JetBrains Mono", Consolas, monospace' },
  { label: 'Source Code Pro', value: '"Source Code Pro", "JetBrains Mono", Consolas, monospace' },
  { label: 'Hack', value: 'Hack, "JetBrains Mono", Consolas, monospace' },
  { label: 'Roboto Mono', value: '"Roboto Mono", "JetBrains Mono", Consolas, monospace' },
  { label: 'DejaVu Sans Mono', value: '"DejaVu Sans Mono", "JetBrains Mono", Consolas, monospace' },
  { label: 'Liberation Mono', value: '"Liberation Mono", "DejaVu Sans Mono", Consolas, monospace' },
  { label: 'SF Mono', value: '"SF Mono", ui-monospace, Menlo, monospace' },
  { label: 'ui-monospace', value: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  { label: 'Consolas', value: 'Consolas, "Courier New", monospace' },
  { label: 'Menlo', value: 'Menlo, Consolas, monospace' },
  { label: 'Monaco', value: 'Monaco, Menlo, monospace' },
  { label: 'Andale Mono', value: '"Andale Mono", "DejaVu Sans Mono", monospace' },
  { label: 'Courier New', value: '"Courier New", Courier, monospace' },
];

interface FontSelectProps {
  value: string;
  options: ReadonlyArray<FontOption>;
  ariaLabel: string;
  onChange: (next: string) => void;
}

/**
 * Font-family dropdown (replaces the old free-text input). The closed control
 * and each option render in their own font as a live preview where the browser
 * supports per-option styling. A value that doesn't match any preset (e.g. left
 * over from the old text input) is surfaced as an explicit "Custom" option so
 * the select never silently snaps away from persisted state.
 */
function FontSelect({ value, options, ariaLabel, onChange }: FontSelectProps) {
  const hasMatch = options.some((opt) => opt.value === value);
  return (
    <select
      class="toolbar-settings-select toolbar-settings-ui-font-select"
      style={value ? { fontFamily: value } : undefined}
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
    >
      {!hasMatch && value !== '' && (
        <option value={value} style={{ fontFamily: value }}>Custom</option>
      )}
      {options.map((opt) => (
        <option key={opt.label} value={opt.value} style={opt.value ? { fontFamily: opt.value } : undefined}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

interface UiGroupLabelProps {
  label: string;
}

/** Small uppercase divider heading used to group related controls — Theme,
 *  Colors, Shape, Layout, Typography — inside the Appearance tab. */
export function UiGroupLabel({ label }: UiGroupLabelProps) {
  return <div class="toolbar-settings-ui-group-label">{label}</div>;
}

function UiSettingsGroup({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <section class="toolbar-settings-ui-group">
      <UiGroupLabel label={label} />
      <div class="toolbar-settings-ui-group-content">{children}</div>
    </section>
  );
}

const STATUS_DISPLAY_ITEMS = CHAT_PREF_MENU_SECTIONS
  .find((section) => section.id === 'display')
  ?.items ?? [];

interface ColorRowProps {
  label: string;
  /** Current pref value; '' means "use bundled default". */
  value: string;
  /** Solid swatch shown when value is '' (the bundled default is often
   *  semi-transparent and <input type="color"> can't render alpha, so we show
   *  its solid RGB). */
  defaultValue: string;
  hint: string;
  ariaLabel: string;
  onChange: (next: string) => void;
}

/** Reusable color-picker + Reset row. The bundled default swatch is shown when
 *  no override is set so the control always displays a meaningful color; Reset
 *  clears the override so the stylesheet default wins. */
function ColorRow({ label, value, defaultValue, hint, ariaLabel, onChange }: ColorRowProps) {
  return (
    <div class="toolbar-settings-ui-control">
      <span class="toolbar-settings-ui-control-label">{label}</span>
      <div class="toolbar-settings-color-controls">
        <input
          type="color"
          class="toolbar-settings-color-input"
          value={value || defaultValue}
          onInput={(e) => onChange((e.target as HTMLInputElement).value)}
          aria-label={ariaLabel}
        />
        <button
          type="button"
          class="toolbar-settings-color-reset"
          disabled={!value}
          onClick={() => onChange('')}
          aria-label={`Reset ${ariaLabel}`}
        >Reset</button>
      </div>
      <div class="toolbar-settings-item-hint">{hint}</div>
    </div>
  );
}

/** Theme preset picker. Shows the active preset when the six color prefs
 *  exactly match one, else "Custom". Selecting a preset writes all six color
 *  prefs as a batch; the user can then tweak individually (which flips back to
 *  Custom). */
function ThemeSelect({ prefs, onSetPrefs }: { prefs: ChatPrefs; onSetPrefs: OnSetPrefs }) {
  const active = matchUiThemePreset(prefs);
  return (
    <div class="toolbar-settings-ui-control">
      <span class="toolbar-settings-ui-control-label">Theme</span>
      <select
        class="toolbar-settings-select toolbar-settings-ui-font-select"
        value={active}
        aria-label="Color theme"
        onChange={(e) => {
          const id = (e.target as HTMLSelectElement).value;
          const preset = UI_THEME_PRESETS.find((p) => p.id === id);
          if (preset) onSetPrefs(uiThemePresetToPrefs(preset));
        }}
      >
        {!active && <option value="">Custom</option>}
        {UI_THEME_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
      </select>
      <div class="toolbar-settings-item-hint">Apply a coordinated palette. Tweak any color below to make it custom.</div>
    </div>
  );
}

interface AppearanceSectionProps {
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
}

/**
 * Inline appearance controls rendered inside the Appearance tab of the settings
 * menu. Previously these lived in a side flyout that escaped the menu's scroll
 * container; the tabbed menu shows one category at a time, so the controls now
 * render inline and the menu body scrolls when needed.
 */
export function AppearanceSection({ prefs, onSetPrefs }: AppearanceSectionProps) {
  return (
    <div class="toolbar-settings-appearance">
      <UiSettingsGroup label="Theme & colors">
        <ThemeSelect prefs={prefs} onSetPrefs={onSetPrefs} />
        <ColorRow
        label="Background"
        value={prefs.uiBackground}
        defaultValue="#050506"
        hint="Base surface color; lighter shades for cards and inputs derive from it."
        ariaLabel="Background color"
        onChange={(next) => onSetPrefs({ uiBackground: next })}
      />
      <ColorRow
        label="Text"
        value={prefs.uiForeground}
        defaultValue="#f2eee4"
        hint="Primary text color; muted shades derive toward the background."
        ariaLabel="Text color"
        onChange={(next) => onSetPrefs({ uiForeground: next })}
      />
      <ColorRow
        label="Border"
        value={prefs.uiBorder}
        defaultValue="#f2eee4"
        hint="Separators and outlines. The default is a faint cream line."
        ariaLabel="Border color"
        onChange={(next) => onSetPrefs({ uiBorder: next })}
      />
      <ColorRow
        label="Accent"
        value={prefs.uiAccentColor}
        defaultValue="#d7a942"
        hint="Buttons, highlights, and active states."
        ariaLabel="Accent color"
        onChange={(next) => onSetPrefs({ uiAccentColor: next })}
      />
      <ColorRow
        label="Muted text"
        value={prefs.uiMutedColor}
        defaultValue="#958f82"
        hint="Secondary labels, hints, and metadata. Empty derives a shade from the text color."
        ariaLabel="Muted text color"
        onChange={(next) => onSetPrefs({ uiMutedColor: next })}
      />
      <ColorRow
        label="Links"
        value={prefs.uiLinkColor}
        defaultValue="#d7a942"
        hint="Hyperlinks in message bodies and prompts. Empty follows the accent color."
        ariaLabel="Link color"
        onChange={(next) => onSetPrefs({ uiLinkColor: next })}
      />

      </UiSettingsGroup>

      <UiSettingsGroup label="Spacing & shape">
      <SliderRow
        label="Corner radius"
        value={prefs.uiCornerRadius}
        min={0}
        max={24}
        step={1}
        formatValue={(v) => `${v}px`}
        hint="Roundness of cards, buttons, and inputs across the panel."
        onChange={(uiCornerRadius) => onSetPrefs({ uiCornerRadius })}
      />
      <div class="toolbar-settings-ui-control">
        <span class="toolbar-settings-ui-control-label">Density</span>
        <select
          class="toolbar-settings-select toolbar-settings-ui-font-select"
          value={prefs.uiDensity}
          aria-label="Spacing density"
          onChange={(e) => onSetPrefs({ uiDensity: (e.target as HTMLSelectElement).value as UiDensity })}
        >
          {DENSITY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <div class="toolbar-settings-item-hint">Spacing between elements. Compact tightens, spacious loosens.</div>
      </div>

      </UiSettingsGroup>

      <UiSettingsGroup label="Files & paths">
      <SliderRow
        label="Path parent depth"
        value={prefs.uiPathParentDepth}
        min={0}
        max={8}
        step={1}
        hint="Number of parent directories shown before a filename. 0 = filename only, 1 = parent/filename."
        onChange={(uiPathParentDepth) => onSetPrefs({ uiPathParentDepth })}
      />
      </UiSettingsGroup>

      <UiSettingsGroup label="Layout">
      <SliderRow
        label="Message width"
        value={prefs.uiMessageWidth}
        min={40}
        max={100}
        step={2}
        formatValue={(v) => `${v}%`}
        hint="Max width of chat bubbles. Narrow view scales up to keep content readable."
        onChange={(uiMessageWidth) => onSetPrefs({ uiMessageWidth })}
      />
      <SliderRow
        label="Initial composer rows"
        value={prefs.composerInitialRows}
        min={COMPOSER_INITIAL_ROWS_MIN}
        max={COMPOSER_INITIAL_ROWS_MAX}
        step={1}
        formatValue={(v) => `${v} ${v === 1 ? 'row' : 'rows'}`}
        hint="Rows available for typing before the composer starts expanding."
        ariaLabel="Initial composer rows"
        onChange={(composerInitialRows) => onSetPrefs({ composerInitialRows })}
      />
      </UiSettingsGroup>

      <UiSettingsGroup label="Content & navigation">
      <SliderRow
        label="Expanded height"
        value={prefs.expandedSectionMaxHeight}
        min={80}
        max={1600}
        step={20}
        formatValue={(v) => `${v}px`}
        hint="Max height of expanded sections — reasoning, tool output, and subagent threads."
        ariaLabel="Expanded section max height"
        onChange={(expandedSectionMaxHeight) => onSetPrefs({ expandedSectionMaxHeight })}
      />
      <SliderRow
        label="Activity rows"
        value={prefs.activityTailLines}
        min={1}
        max={12}
        step={1}
        ariaLabel="Activity preview rows"
        hint="Rows shown in the live activity preview at the bottom of a turn."
        onChange={(activityTailLines) => onSetPrefs({ activityTailLines })}
      />
      <SliderRow
        label="Rail markers"
        value={prefs.uiMessageRailSize}
        min={8}
        max={40}
        step={1}
        formatValue={(v) => `${v}px`}
        hint="Size of the user-message jump buttons beside the scrollbar — both the click target and the visible dot. Larger is easier to click and see."
        ariaLabel="Message rail marker size"
        onChange={(uiMessageRailSize) => onSetPrefs({ uiMessageRailSize })}
      />

      </UiSettingsGroup>

      <UiSettingsGroup label="Typography">
      <SliderRow
        label="Base text"
        value={prefs.uiBaseFontSize}
        min={10}
        max={24}
        step={1}
        formatValue={(v) => `${v}px`}
        hint="Message body and primary readable text across the panel."
        ariaLabel="Base font size"
        onChange={(uiBaseFontSize) => onSetPrefs({ uiBaseFontSize })}
      />
      <SliderRow
        label="Composer text"
        value={prefs.uiComposerFontSize}
        min={11}
        max={28}
        step={1}
        formatValue={(v) => `${v}px`}
        hint="The message input box where you type."
        ariaLabel="Composer font size"
        onChange={(uiComposerFontSize) => onSetPrefs({ uiComposerFontSize })}
      />
      <SliderRow
        label="Expanded text"
        value={prefs.expandedSectionFontSize}
        min={8}
        max={32}
        step={1}
        formatValue={(v) => `${v}px`}
        hint="Tool-call output, reasoning, system prompts, and code blocks."
        ariaLabel="Expanded section font size"
        onChange={(expandedSectionFontSize) => onSetPrefs({ expandedSectionFontSize })}
      />
      <div class="toolbar-settings-ui-control">
        <span class="toolbar-settings-ui-control-label">Sans font</span>
        <FontSelect
          value={prefs.uiFontSans}
          options={SANS_FONT_OPTIONS}
          ariaLabel="Sans-serif font family"
          onChange={(next) => onSetPrefs({ uiFontSans: next })}
        />
        <div class="toolbar-settings-item-hint">Body and UI text. "Default" uses the bundled stack.</div>
      </div>
      <div class="toolbar-settings-ui-control">
        <span class="toolbar-settings-ui-control-label">Mono font</span>
        <FontSelect
          value={prefs.uiFontMono}
          options={MONO_FONT_OPTIONS}
          ariaLabel="Monospace font family"
          onChange={(next) => onSetPrefs({ uiFontMono: next })}
        />
        <div class="toolbar-settings-item-hint">Code and tool output. "Default" uses the bundled stack.</div>
      </div>
      </UiSettingsGroup>

      <UiSettingsGroup label="Status & usage">
        <div class="toolbar-settings-list">
          {STATUS_DISPLAY_ITEMS.map((item) => (
            <ChatPrefItem key={item.key} item={item} prefs={prefs} onSetPrefs={onSetPrefs} />
          ))}
        </div>
      </UiSettingsGroup>
    </div>
  );
}