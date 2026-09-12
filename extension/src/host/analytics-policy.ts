import type { ActivationReadResult } from '../analytics/activation-store.js';

/** Process-local analytics behavior.  This is deliberately not persisted or
 * treated as activation authority. */
export type AnalyticsPolicy = 'normal' | 'total-disabled';

export const TOTAL_DISABLED_REHEARSAL_MODE = 'total-disabled-v1';
export const ANALYTICS_REHEARSAL_MODE_ENV = 'PIE_ANALYTICS_REHEARSAL_MODE';

export function resolveAnalyticsPolicy(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AnalyticsPolicy {
  return environment[ANALYTICS_REHEARSAL_MODE_ENV] === TOTAL_DISABLED_REHEARSAL_MODE
    ? 'total-disabled'
    : 'normal';
}

export function isTotalAnalyticsDisabled(policy: AnalyticsPolicy): boolean {
  return policy === 'total-disabled';
}

export function isFreshLegacyActivationState(
  state: Pick<ActivationReadResult, 'authority' | 'manifest' | 'tombstonePresent'>,
): boolean {
  return state.authority === 'legacy'
    && state.manifest === null
    && state.tombstonePresent === false;
}
