import type { ContextWindowSummary } from './breakdown';
import { formatCompactTokens, formatTokens } from '../utils/format-tokens';

export interface ContextWindowIndicatorState {
  label: string | null;
  ariaLabel: string;
  severity: '' | 'warning' | 'critical';
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
  const severity: ContextWindowIndicatorState['severity'] =
    usageRatio !== null && usageRatio > 0.85
      ? 'critical'
      : usageRatio !== null && usageRatio > 0.7
        ? 'warning'
        : '';

  if (usedTokens === null) {
    return {
      label: `? / ${formatCompactTokens(totalWindow)} tokens`,
      ariaLabel: `Context window usage is unknown. Total window: ${formatReadableTokens(totalWindow)} tokens.`,
      severity,
    };
  }

  const compactUsed = formatCompactTokens(usedTokens);
  const ariaPrefix = usedKind === 'estimated' ? 'Estimated context window usage' : 'Context window usage';

  return {
    label: `${compactUsed} / ${formatCompactTokens(totalWindow)} tokens`,
    ariaLabel: `${ariaPrefix}: ${formatReadableTokens(usedTokens)} of ${formatReadableTokens(totalWindow)} tokens used.`,
    severity,
  };
}
