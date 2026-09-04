/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { JSX } from 'preact';

import type {
  SessionCostIndicatorState,
  SessionCostSourceBreakdown,
} from '../session-tabs/token-usage';
import { colorsFor } from '../components/chart-colors';
import { ProviderLegend } from '../aggregate-stats-strip';
import { formatCompactTokens } from '../utils/format-tokens';

const SOURCE_COLORS: Record<SessionCostSourceBreakdown['key'], string> = {
  conversation: 'var(--vscode-charts-blue)',
  subagents: 'var(--vscode-charts-green)',
  pruning: 'var(--vscode-charts-purple)',
  retry: 'var(--vscode-charts-red)',
  history_compaction: 'var(--vscode-charts-yellow)',
  branch_summary: 'var(--vscode-charts-purple)',
  session_title: 'var(--vscode-charts-foreground)',
  other: 'var(--vscode-descriptionForeground)',
  live: 'var(--vscode-charts-orange)',
};

/** Rich whole-branch provider/model and source breakdown for the session cost chip. */
export function SessionCostTooltip({ indicator }: { indicator: SessionCostIndicatorState }): JSX.Element {
  const { breakdown } = indicator;
  const providerColors = colorsFor(breakdown.providers.map((provider) => provider.provider));
  const pricedProviders = breakdown.providers.filter((provider) => provider.cost > 0);
  const pricedSources = breakdown.sources.filter((source) => source.cost > 0);
  const subtitle = [
    'Whole branch',
    `Main conversation: ${breakdown.reportedTurnCount} assistant turn${breakdown.reportedTurnCount === 1 ? '' : 's'}`,
    `↓${formatCompactTokens(breakdown.inputTokens)} in  ↑${formatCompactTokens(breakdown.outputTokens)} out`,
  ].join(' · ');

  return (
    <div class="rich-tooltip session-cost-tooltip">
      <div class="rich-tooltip-head">
        <span>Estimated session cost</span>
        <span class="rich-tooltip-head-value">{indicator.label}</span>
      </div>
      <div class="rich-tooltip-sub">API-equivalent catalog estimate · subscriptions, plan allowances, and invoices are not reconciled</div>
      <div class="rich-tooltip-sub">{subtitle}</div>

      <CostBar
        className="session-cost-provider-bar"
        label="Cost by provider"
        segments={pricedProviders.map((provider) => ({
          key: provider.provider,
          label: provider.provider,
          value: provider.cost,
          color: providerColors.get(provider.provider) ?? 'var(--panel-muted)',
        }))}
      />

      {breakdown.providers.length > 0 && (
        <ProviderLegend items={breakdown.providers.map((provider) => ({
          key: provider.provider,
          value: costLabel(provider.cost, provider.hasKnownCost, provider.unpricedTokens),
          models: provider.models.map((model) => ({
            provider: model.provider,
            model: model.model,
            value: costLabel(model.cost, model.hasKnownCost, model.unpricedTokens),
          })),
        }))} />
      )}

      {breakdown.sources.length > 1 && (
        <div class="session-cost-sources">
          <div class="session-cost-section-head">Cost sources</div>
          <CostBar
            className="session-cost-source-bar"
            label="Cost by source"
            segments={pricedSources.map((source) => ({
              key: source.key,
              label: source.label,
              value: source.cost,
              color: SOURCE_COLORS[source.key],
            }))}
          />
          <div class="rich-tooltip-legend session-cost-source-legend">
            {breakdown.sources.map((source) => (
              <span class="rich-tooltip-legend-item session-cost-source-row" key={source.key}>
                <span class="rich-tooltip-swatch" style={`background:${SOURCE_COLORS[source.key]}`} />
                <span class="session-cost-source-label">{source.label}</span>
                <span class="session-cost-source-tokens">{formatCompactTokens(source.tokens)} tok</span>
                <span class="rich-tooltip-legend-val">
                  {costLabel(source.cost, source.hasKnownCost, source.unpricedTokens)}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {breakdown.hasIncompleteCost && (
        <div class="rich-tooltip-sub session-cost-note">
          * Excludes {formatCostTokens(breakdown.unpricedTokens)} pending billing details or pricing.
        </div>
      )}
    </div>
  );
}

interface CostBarSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

function CostBar({
  className,
  label,
  segments,
}: {
  className: string;
  label: string;
  segments: CostBarSegment[];
}): JSX.Element {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (total <= 0) {
    return <div class={`session-cost-bar session-cost-bar--empty ${className}`}>No priced usage</div>;
  }
  return (
    <div
      class={`session-cost-bar ${className}`}
      role="img"
      aria-label={`${label}: ${segments.map((segment) => `${segment.label} ${formatDetailedCost(segment.value)}`).join(', ')}`}
    >
      {segments.map((segment) => (
        <span
          class="session-cost-bar-segment"
          key={segment.key}
          title={`${segment.label}: ${formatDetailedCost(segment.value)} (${formatPercent(segment.value / total)})`}
          style={`width:${(segment.value / total) * 100}%;background:${segment.color}`}
        />
      ))}
    </div>
  );
}

function costLabel(cost: number, hasKnownCost: boolean, unpricedTokens: number): string {
  if (!hasKnownCost) return unpricedTokens > 0 ? `unavailable*` : 'unavailable';
  return `${formatDetailedCost(cost)}${unpricedTokens > 0 ? '*' : ''}`;
}

function formatDetailedCost(cost: number): string {
  return `$${Math.max(0, cost).toFixed(4)}`;
}

function formatPercent(ratio: number): string {
  const percent = ratio * 100;
  return percent > 0 && percent < 0.1 ? '<0.1%' : `${percent.toFixed(percent < 1 ? 1 : 0)}%`;
}

function formatCostTokens(tokens: number): string {
  return `${formatCompactTokens(tokens)} token${tokens === 1 ? '' : 's'}`;
}
