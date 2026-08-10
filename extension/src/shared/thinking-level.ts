/**
 * Single source of truth for the `ThinkingLevel` union's enumerated forms.
 *
 * Consolidates the previously duplicated level lists, option arrays, label
 * maps, validation sets, and guards that were scattered across the backend,
 * host, and webview. The canonical union type lives in `./protocol/models.js`;
 * this module mirrors it into the runtime structures every layer needs.
 *
 * Order is low → high and is significant for the picker.
 */

import type { ThinkingLevel } from './protocol/models.js';

/** All Pi thinking levels, ordered low → high. Values stay one-to-one
 * with the runtime: `xhigh` and `max` are distinct provider controls. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** Picker options (value + human label) for the thinking-level selector. */
export const THINKING_LEVEL_OPTIONS: readonly { value: ThinkingLevel; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
  { value: 'max', label: 'Max' },
];

/** Per-level display labels (exhaustive over the union). */
export const THINKING_LEVEL_LABELS: Readonly<Record<ThinkingLevel, string>> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
};

/** Membership set for validation. */
export const THINKING_LEVEL_SET: ReadonlySet<ThinkingLevel> = new Set(THINKING_LEVELS);

/** Whether an unknown value is a valid `ThinkingLevel`. */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Normalize an incoming string (or undefined) to a `ThinkingLevel`, returning
 * `undefined` when the value is absent or not a recognized level. Behavior is
 * identical to the per-module switch-based normalizers it replaces.
 */
export function normalizeThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  return isThinkingLevel(value) ? value : undefined;
}