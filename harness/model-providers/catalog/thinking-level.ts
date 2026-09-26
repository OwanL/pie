/** Pi provider/runtime reasoning levels. This is the canonical provider contract. */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export const THINKING_LEVEL_SET: ReadonlySet<ThinkingLevel> = new Set(THINKING_LEVELS);

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Normalize a provider/runtime string to a recognized thinking level. */
export function normalizeThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  return isThinkingLevel(value) ? value : undefined;
}
