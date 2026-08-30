import type { ContextWindowSummary } from './breakdown';
import { formatCompactTokens, formatTokens } from '../utils/format-tokens';

export interface ContextWindowIndicatorState {
  label: string | null;
  ariaLabel: string;
  severity: '' | 'warning' | 'critical';
}

/** Inclusive severity thresholds: ≥70% of the window is a warning, ≥85% is
 *  critical. Inclusive so a window filled to exactly the threshold escalates. */
const WARNING_RATIO = 0.7;
const CRITICAL_RATIO = 0.85;

function severityForRatio(usageRatio: number | null): ContextWindowIndicatorState['severity'] {
  if (usageRatio === null) return '';
  return usageRatio >= CRITICAL_RATIO ? 'critical' : usageRatio >= WARNING_RATIO ? 'warning' : '';
}

function formatReadableTokens(tokens: number): string {
  return formatTokens(tokens);
}

export function buildContextWindowIndicatorState(summary: ContextWindowSummary): ContextWindowIndicatorState {
  const { totalWindow, usedTokens, usedKind } = summary;
  if (totalWindow <= 0) {
    return {
      label: null,
      ariaLabel: '',
      severity: '',
    };
  }

  const usageRatio = usedTokens !== null ? usedTokens / totalWindow : null;
  const severity = severityForRatio(usageRatio);

  if (usedTokens === null) {
    return {
      label: `? / ${formatCompactTokens(totalWindow)} tokens`,
      ariaLabel: `Context window usage is unknown. Total window: ${formatReadableTokens(totalWindow)} tokens.`,
      severity,
    };
  }

  // Decision-useful compact chip: actual tokens used over the total window.
  // Percentages are intentionally omitted — the raw token counts are what the
  // user acts on. Exact used/remaining stay in the aria label and the rich
  // tooltip. Estimated usage is identified in the accessible label and rich
  // tooltip without adding a prefix to the compact chip.
  const compactUsed = formatCompactTokens(usedTokens);
  const remaining = Math.max(totalWindow - usedTokens, 0);
  const ariaPrefix = usedKind === 'estimated' ? 'Estimated context window usage' : 'Context window usage';

  return {
    label: `${compactUsed} / ${formatCompactTokens(totalWindow)} tokens`,
    ariaLabel: `${ariaPrefix}: ${formatReadableTokens(usedTokens)} of ${formatReadableTokens(totalWindow)} tokens used; ${formatReadableTokens(remaining)} remaining.`,
    severity,
  };
}