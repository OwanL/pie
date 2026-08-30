import type { InitialContextEstimate } from '../../../shared/protocol';
import type {
  ContextWindowBreakdown,
  ContextWindowBreakdownEntry,
  ContextWindowSummary,
} from './breakdown';
import { formatTokens } from '../utils/format-tokens';

function line(entry: ContextWindowBreakdownEntry): string {
  const suffix = entry.kind === 'estimated' ? ' estimated' : '';
  return `${entry.label ?? entry.key}: ${entry.value}${suffix}${entry.note ? ` - ${entry.note}` : ''}`;
}

/** Immediate cold-session breakdown for the one-shot inventory estimate. It
 * intentionally carries no provider-hidden prompt attribution. */
export function buildInitialContextBreakdown(
  estimate: InitialContextEstimate,
  selectedModelContextWindow: number = estimate.contextWindow,
): ContextWindowBreakdown {
  const contextWindow = Number.isFinite(selectedModelContextWindow) && selectedModelContextWindow > 0
    ? Math.trunc(selectedModelContextWindow)
    : estimate.contextWindow;
  const remainingTokens = Math.max(contextWindow - estimate.tokens, 0);
  const summary: ContextWindowSummary = {
    usedTokens: estimate.tokens,
    usedKind: 'estimated',
    remainingTokens,
    remainingKind: 'estimated',
    totalWindow: contextWindow,
  };
  const entries: ContextWindowBreakdownEntry[] = [{
    key: 'initial.configured-catalog',
    label: 'Discovered initial prompt, tools, and skills',
    value: formatTokens(estimate.tokens),
    kind: 'estimated',
    tokens: estimate.tokens,
    note: 'Fresh pre-filter catalog estimate; unavailable or resource-config-excluded packages are excluded.',
  }];
  const footerEntries: ContextWindowBreakdownEntry[] = [
    { key: 'window.used', label: 'Used', value: formatTokens(estimate.tokens), kind: 'estimated', tokens: estimate.tokens },
    { key: 'window.remaining', label: 'Remaining', value: formatTokens(remainingTokens), kind: 'estimated', tokens: remainingTokens },
    { key: 'window.total', label: 'Total', value: formatTokens(contextWindow), kind: 'exact', tokens: contextWindow },
  ];
  const notes = [
    'Fresh estimate of successfully discovered/registered resources before Pie skill pruning or prompt/tool disabling.',
    'Includes initially sent prompt text and tool/skill catalog metadata, not provider-hidden instructions, prompt-template bodies, or full skill bodies.',
  ];
  return {
    entries,
    footerEntries,
    summary,
    notes,
    title: [
      'Context window usage',
      ...footerEntries.map(line),
      '',
      'Breakdown:',
      ...entries.map(line),
      '',
      ...notes.map((note) => `Note: ${note}`),
    ].join('\n'),
  };
}
