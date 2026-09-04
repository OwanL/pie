/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { WorkingTimeBreakdown, WorkingTimeState } from '../../../shared/protocol';

interface TimeCategory {
  key: 'generation' | 'tools' | 'retry' | 'auxiliary' | 'other';
  label: string;
  durationMs: number;
  approximate?: boolean;
}

const MAX_TOOL_ROWS = 8;

/** Rich, frozen-at-open explanation of one session's host-owned working clock. */
export function WorkingTimeTooltip({
  state,
  elapsedMs,
}: {
  state: WorkingTimeState | undefined;
  elapsedMs: number;
}) {
  const breakdown = state?.breakdown;
  const categories = timeCategories(state, elapsedMs);
  const denominator = Math.max(
    elapsedMs,
    categories.reduce((total, category) => total + category.durationMs, 0),
    1,
  );
  const allTools = toolRows(state, elapsedMs);
  const subagents = subagentSummary(breakdown, allTools);
  const tools = allTools.filter((tool) => tool.name.trim().toLowerCase() !== 'subagent');
  const hiddenTools = Math.max(0, tools.length - MAX_TOOL_ROWS);
  const shownTools = tools.slice(0, MAX_TOOL_ROWS);
  const active = state?.activeSince !== null && state?.activeSince !== undefined;
  const hasEstimate = (breakdown?.estimatedToolExecutionMs ?? 0) > 0
    || (breakdown?.estimatedRetryWaitMs ?? 0) > 0
    || (breakdown?.estimatedSubagentDurationMs ?? 0) > 0
    || subagents?.fallback === true;
  const measuredTotalMs = categories
    .filter((category) => category.key !== 'other')
    .reduce((total, category) => total + category.durationMs, 0);
  const hasOverlappingPhases = measuredTotalMs > finiteDuration(elapsedMs);

  return (
    <div class="rich-tooltip working-time-tooltip">
      <div class="rich-tooltip-head">
        <span>Agent working time</span>
        <span class="rich-tooltip-head-value">{formatTooltipDuration(elapsedMs)}</span>
      </div>
      <div class="rich-tooltip-sub">
        {active ? 'Working now' : 'Idle'} · excludes time waiting for you between runs
      </div>

      <div
        class="working-time-bar"
        role="img"
        aria-label={categories.map((category) => `${category.label}: ${formatTooltipDuration(category.durationMs)}`).join(', ')}
      >
        {categories.filter((category) => category.durationMs > 0).map((category) => (
          <span
            class={`working-time-bar-segment working-time-color--${category.key}`}
            style={`width:${(category.durationMs / denominator) * 100}%`}
            key={category.key}
          />
        ))}
      </div>

      <div class="rich-tooltip-legend working-time-legend">
        {categories.map((category) => (
          <span class="rich-tooltip-legend-item working-time-legend-item" key={category.key}>
            <span class={`rich-tooltip-swatch working-time-color--${category.key}`} />
            <span class="working-time-legend-label">{category.label}</span>
            <span class="rich-tooltip-legend-val">
              {category.approximate ? '≈' : ''}{formatTooltipDuration(category.durationMs)}
            </span>
          </span>
        ))}
      </div>

      {shownTools.length > 0 && (
        <div class="working-time-tools">
          <div class="working-time-section-head">
            <span>Tools by call time</span>
            <span>{tools.length} tool{tools.length === 1 ? '' : 's'}</span>
          </div>
          {shownTools.map((tool) => (
            <div class="working-time-tool-row" key={tool.name}>
              <span class="working-time-tool-name" title={tool.name}>{tool.name}</span>
              <span class="working-time-tool-count">{tool.calls}×</span>
              <span class="rich-tooltip-legend-val">{formatTooltipDuration(tool.durationMs)}</span>
            </div>
          ))}
          {hiddenTools > 0 && (
            <div class="rich-tooltip-sub">+ {hiddenTools} more tool{hiddenTools === 1 ? '' : 's'}</div>
          )}
        </div>
      )}

      {subagents && (
        <div class="working-time-tools working-time-subagents">
          <div class="working-time-section-head">
            <span>Subagents</span>
            <span>{subagents.count} {subagents.unit}{subagents.count === 1 ? '' : 's'}</span>
          </div>
          <div class="working-time-tool-row">
            <span class="working-time-tool-name">Cumulative agent time</span>
            <span />
            <span class="rich-tooltip-legend-val">
              {subagents.approximate ? '≈' : ''}{formatTooltipDuration(subagents.durationMs)}
            </span>
          </div>
          {subagents.unknownCount > 0 && (
            <div class="rich-tooltip-sub">
              {subagents.unknownCount} additional duration{subagents.unknownCount === 1 ? '' : 's'} unavailable
            </div>
          )}
          {subagents.fallback && (
            <div class="rich-tooltip-sub">Legacy total from top-level subagent tool calls</div>
          )}
        </div>
      )}

      <div class="rich-tooltip-sub working-time-note">
        {breakdown
          ? `Measured phase totals${hasEstimate ? '; ≈ marks legacy or scheduled estimates' : ''}${hasOverlappingPhases ? '; overlapping phase totals may exceed working time' : ''}. Tool call time may overlap. Subagent time counts parallel, nested, and retry attempts independently and overlaps the session total.`
          : 'Detailed phase timing is unavailable for earlier working-time data.'}
      </div>
    </div>
  );
}

function timeCategories(state: WorkingTimeState | undefined, elapsedMs: number): TimeCategory[] {
  const breakdown = state?.breakdown;
  const generationMs = finiteDuration(breakdown?.generationMs);
  const toolExecutionMs = finiteDuration(breakdown?.toolExecutionMs) + liveToolWallMs(state, elapsedMs);
  const retryWaitMs = finiteDuration(breakdown?.retryWaitMs);
  const auxiliaryGenerationMs = finiteDuration(breakdown?.auxiliaryGenerationMs);
  const attributedMs = generationMs + toolExecutionMs + retryWaitMs + auxiliaryGenerationMs;
  const remainingMs = Math.max(0, finiteDuration(elapsedMs) - attributedMs);
  return [
    { key: 'generation', label: 'Generation', durationMs: generationMs },
    {
      key: 'tools',
      label: 'Tool execution',
      durationMs: toolExecutionMs,
      approximate: (breakdown?.estimatedToolExecutionMs ?? 0) > 0,
    },
    {
      key: 'retry',
      label: 'Retry wait',
      durationMs: retryWaitMs,
      approximate: (breakdown?.estimatedRetryWaitMs ?? 0) > 0,
    },
    { key: 'auxiliary', label: 'Auxiliary model calls', durationMs: auxiliaryGenerationMs },
    { key: 'other', label: 'Other work', durationMs: remainingMs },
  ];
}

function toolRows(state: WorkingTimeState | undefined, elapsedMs: number): Array<{
  name: string;
  durationMs: number;
  calls: number;
}> {
  const breakdown = state?.breakdown;
  const durations = { ...(breakdown?.toolDurationMsByName ?? {}) };
  const calls = { ...(breakdown?.toolCallCountByName ?? {}) };
  const now = liveNow(state, elapsedMs);
  for (const tool of state?.activeTools ?? []) {
    const name = tool.name.trim() || '(unknown)';
    durations[name] = finiteDuration(durations[name]) + Math.max(0, now - finiteTimestamp(tool.startedAt));
    calls[name] = Math.max(0, Math.trunc(calls[name] ?? 0)) + 1;
  }
  return Object.entries(durations)
    .map(([name, durationMs]) => ({
      name,
      durationMs: finiteDuration(durationMs),
      calls: Math.max(0, Math.trunc(calls[name] ?? 0)),
    }))
    .filter((tool) => tool.durationMs > 0)
    .sort((left, right) => right.durationMs - left.durationMs || left.name.localeCompare(right.name));
}

function liveToolWallMs(state: WorkingTimeState | undefined, elapsedMs: number): number {
  if (state?.activeToolSince === null || state?.activeToolSince === undefined) return 0;
  return Math.max(0, liveNow(state, elapsedMs) - finiteTimestamp(state.activeToolSince));
}

function liveNow(state: WorkingTimeState | undefined, elapsedMs: number): number {
  if (state?.activeSince === null || state?.activeSince === undefined) return 0;
  return finiteTimestamp(state.activeSince)
    + Math.max(0, finiteDuration(elapsedMs) - finiteDuration(state.accumulatedMs));
}

function subagentSummary(
  breakdown: WorkingTimeBreakdown | undefined,
  tools: ReturnType<typeof toolRows>,
): {
  durationMs: number;
  count: number;
  unit: 'attempt' | 'call';
  unknownCount: number;
  approximate: boolean;
  fallback: boolean;
} | null {
  const attemptCount = Math.max(0, Math.trunc(breakdown?.subagentAttemptCount ?? 0));
  const unknownCount = Math.max(0, Math.trunc(breakdown?.unknownSubagentDurationCount ?? 0));
  if (attemptCount > 0 || unknownCount > 0) {
    return {
      durationMs: finiteDuration(breakdown?.subagentDurationMs),
      count: attemptCount,
      unit: 'attempt',
      unknownCount,
      approximate: finiteDuration(breakdown?.estimatedSubagentDurationMs) > 0,
      fallback: false,
    };
  }

  const legacy = tools.find((tool) => tool.name.trim().toLowerCase() === 'subagent');
  return legacy ? {
    durationMs: legacy.durationMs,
    count: legacy.calls,
    unit: 'call',
    unknownCount: 0,
    approximate: true,
    fallback: true,
  } : null;
}

function formatTooltipDuration(durationMs: number): string {
  const finiteMs = finiteDuration(durationMs);
  if (finiteMs > 0 && finiteMs < 1_000) return '<1s';
  const totalSeconds = Math.floor(finiteMs / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes === 0) return `${seconds}s`;
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours === 0) return `${minutes}m ${seconds}s`;
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);
  if (days === 0) return `${hours}h ${minutes}m`;
  return `${days}d ${hours}h`;
}

function finiteTimestamp(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

function finiteDuration(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}
