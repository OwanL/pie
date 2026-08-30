/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { JSX } from 'preact';
import { memo } from 'preact/compat';

import type { ContextWindowBreakdown, ContextWindowBreakdownEntry } from './breakdown';
import { formatCompactTokens } from '../utils/format-tokens';
import { cx } from '../utils/cx';

/**
 * Rich (JSX) tooltip for the context-window indicator. Renders a horizontal
 * stacked bar of the full context window: the used portion is split into its
 * contributor segments (system prompt, messages, assistant responses,
 * reasoning, tools, skills, and residual content) and the remainder is shown as a muted tail. A legend below the bar
 * lists every segment with its colour swatch, label, and compact token count.
 *
 * Replaces the former plain-text `title` tooltip. Rendered into the
 * `Tooltip` component's out-of-tree host via `contentNode`, so it survives
 * parent re-renders while the pointer is hovering (`freezeWhileVisible`).
 */

/** Fixed semantic palette for the known contributor categories, so a given
 *  kind always renders the same colour across hovers. Unknown labels fall
 *  back to a stable hash-based colour. Tuned for contrast on the dark panel. */
const SEGMENT_COLORS: Record<string, string> = {
  'System prompt': '#b079f3', // purple
  'Read file': '#4cc2ff', // azure
  'Skill': '#3fb950', // green
  'User message': '#f0883e', // orange
  'Assistant responses': '#58a6ff', // blue
  'Reasoning': '#d2a8ff', // lilac
  'System messages': '#f85149', // red
  'Tool calls': '#53b9bd', // teal
  'Other': '#e3b341', // yellow
};

const FALLBACK_PALETTE = [
  '#53b9bd', // teal
  '#d2a8ff', // lilac
  '#a5d6ff', // pale blue
  '#db6d28', // amber
  '#f85149', // red
];

/** Stable colour for a contributor label. Known categories map to fixed
 *  semantic colours; anything else is hashed to a stable palette entry so the
 *  same label always renders the same colour. Exported for unit testing. */
export function segmentColor(label: string): string {
  const fixed = SEGMENT_COLORS[label];
  if (fixed) return fixed;
  if (label.startsWith('Tool: ')) return SEGMENT_COLORS['Tool calls']!;
  if (label.startsWith('Skill: ')) return SEGMENT_COLORS.Skill!;
  let h = 0;
  for (let i = 0; i < label.length; i += 1) {
    h = (h * 31 + label.charCodeAt(i)) | 0;
  }
  // `>>> 0` coerces to an unsigned 32-bit int. `| 0` above can yield
  // -2147483648 (INT_MIN), for which `Math.abs` is still negative, producing a
  // negative modulo index and an `undefined` colour. The unsigned shift keeps
  // the index in range.
  return FALLBACK_PALETTE[(h >>> 0) % FALLBACK_PALETTE.length]!;
}

/** Minimum visible width (% of the bar) for a non-zero segment so tiny
 *  contributors are still hoverable rather than collapsing to a sub-pixel
 *  sliver. ~240px is the typical rich-tooltip width. */
const MIN_SEGMENT_PCT = (2 / 240) * 100;
const BAR_HEIGHT_PX = 10;

interface Segment {
  key: string;
  label: string;
  tokens: number;
  color: string;
  /** Muted tail segment (remaining context), styled differently from contributors. */
  muted?: boolean;
  /** Compact contributor detail shown beside the label (counts/previews). */
  note?: string;
  /** Attribution kind suffix for the legend (estimated/derived/unknown). */
  kindSuffix?: string;
  /** Hover text for the segment's native `title`. */
  title: string;
}

export function kindSuffixFor(entry: ContextWindowBreakdownEntry): string | undefined {
  if (entry.kind === 'estimated') return 'est';
  if (entry.kind === 'derived') return 'derived';
  if (entry.kind === 'unknown') return '?';
  return undefined;
}

export function remainingTokensForChart(
  summary: ContextWindowBreakdown['summary'],
): number {
  if (summary.remainingTokens !== null) return summary.remainingTokens;
  if (summary.usedTokens === null) return 0;
  return Math.max(summary.totalWindow - summary.usedTokens, 0);
}

export interface BarLayout {
  /** Per-used-segment width (% of the bar), after min-width bumping and
   *  saturation scaling. Length matches the input `usedSegments`. */
  widths: number[];
  /** Remaining-tail width (% of the bar); 0 when there is no tail or the used
   *  segments saturate/overflow the window. */
  remainingPct: number;
}

/**
 * Pure layout math for the stacked context bar, extracted so it can be unit
 * tested without rendering. Each used segment's width is its true share of
 * `total`, bumped to `MIN_SEGMENT_PCT` so tiny non-zero contributors stay
 * hoverable; the extra is taken from the remaining tail. If the bumped used
 * segments exceed 100% (a saturated window), they are scaled back
 * proportionally and the tail is dropped so the bar never overflows.
 */
export function computeBarLayout(
  usedSegments: readonly { tokens: number }[],
  remainingSegment: { tokens: number } | null,
  total: number,
): BarLayout {
  if (total <= 0) {
    return { widths: usedSegments.map(() => 0), remainingPct: 0 };
  }
  const rawPcts = usedSegments.map((s) => (s.tokens > 0 ? (s.tokens / total) * 100 : 0));
  const bumpedPcts = rawPcts.map((p) => (p > 0 ? Math.max(p, MIN_SEGMENT_PCT) : 0));
  const usedPct = bumpedPcts.reduce((a, b) => a + b, 0);
  let remainingPct = remainingSegment ? Math.max(100 - usedPct, 0) : 0;
  // If the bumped used segments alone exceed 100% (saturated window), scale
  // the used segments back proportionally and drop the tail.
  if (usedPct > 100) {
    const scale = 100 / usedPct;
    for (let i = 0; i < bumpedPcts.length; i += 1) {
      bumpedPcts[i] = (bumpedPcts[i] ?? 0) * scale;
    }
    remainingPct = 0;
  }
  return { widths: bumpedPcts, remainingPct };
}

function ContextWindowBreakdownChartBase({
  breakdown,
}: {
  breakdown: ContextWindowBreakdown;
}): JSX.Element {
  const { summary, entries } = breakdown;
  const total = summary.totalWindow;

  // No usable window → nothing to draw; fall back to a compact textual view.
  if (total <= 0) {
    return (
      <div class="rich-tooltip rich-tooltip--ctx">
        <div class="rich-tooltip-head">
          <span>Context window</span>
          <span class="rich-tooltip-head-value">unknown</span>
        </div>
        <div class="rich-tooltip-sub">No context-window size is available for this model.</div>
      </div>
    );
  }

  const used = summary.usedTokens ?? 0;
  // Null means unknown, not "the whole window remains". In particular, a
  // freshly reopened compacted session may have neither a PI usage snapshot nor
  // enough boundary metadata to estimate used/remaining safely.
  const remaining = remainingTokensForChart(summary);
  const remainingKnown = summary.remainingTokens !== null;
  const percent = summary.usedTokens !== null ? Math.round((used / total) * 100) : null;

  // Header shows the full decision set: fill percentage, exact used/total, and
  // remaining. Unknown slots stay explicitly unknown rather than reading as 0.
  const headValue = percent !== null
    ? `${percent}% · ${formatCompactTokens(used)} / ${formatCompactTokens(total)}${remainingKnown ? ` · ${formatCompactTokens(remaining)} left` : ''}`
    : `?% · ? / ${formatCompactTokens(total)}`;

  const usedSegments: Segment[] = entries
    .filter((e) => (e.tokens ?? 0) > 0)
    .map((e) => {
      const label = e.label ?? e.key;
      const tokens = e.tokens ?? 0;
      const pct = (tokens / total) * 100;
      return {
        key: e.key,
        label,
        tokens,
        color: e.key === 'other' ? SEGMENT_COLORS['Other']! : segmentColor(label),
        note: e.note,
        kindSuffix: kindSuffixFor(e),
        title: `${label}: ${formatCompactTokens(tokens)} tokens (${pct.toFixed(1)}%)${e.note ? ` — ${e.note}` : ''}`,
      } satisfies Segment;
    });

  const remainingSegment: Segment | null = remaining > 0
    ? {
        key: 'window.remaining',
        label: 'Remaining',
        tokens: remaining,
        color: 'var(--panel-border-subtle)',
        muted: true,
        title: `Remaining: ${formatCompactTokens(remaining)} tokens (${((remaining / total) * 100).toFixed(1)}%)`,
      }
    : null;

  // When the transcript window is partial, contributor rows are suppressed so
  // the bar has no used segments — synthesize a single neutral "Used" sliver from
  // the reported total so the bar still reflects used vs remaining rather than
  // rendering only the muted tail (which would hide the used portion entirely).
  const displayUsedSegments: Segment[] = usedSegments.length > 0
    ? usedSegments
    : (used > 0
      ? [{
          key: 'window.used',
          label: 'Used',
          tokens: used,
          color: 'color-mix(in srgb, var(--panel-foreground) 55%, var(--panel-muted))',
          title: `Used: ${formatCompactTokens(used)} tokens (${((used / total) * 100).toFixed(1)}%) — breakdown hidden (partial transcript)`,
        } satisfies Segment]
      : []);

  const allSegments = [...displayUsedSegments, ...(remainingSegment ? [remainingSegment] : [])];

  return (
    <div class="rich-tooltip rich-tooltip--ctx">
      <div class="rich-tooltip-head">
        <span>Context window</span>
        <span class="rich-tooltip-head-value">{headValue}</span>
      </div>

      <ContextBar
        usedSegments={displayUsedSegments}
        remainingSegment={remainingSegment}
        used={used}
        total={total}
      />

      <ContextLegend segments={allSegments} total={total} />
    </div>
  );
}

export const ContextWindowBreakdownChart = memo(ContextWindowBreakdownChartBase);

function ContextBar({
  usedSegments,
  remainingSegment,
  used,
  total,
}: {
  usedSegments: Segment[];
  remainingSegment: Segment | null;
  used: number;
  total: number;
}): JSX.Element {
  const { widths, remainingPct } = computeBarLayout(usedSegments, remainingSegment, total);
  // The bar is a visual summary; the legend below carries the full per-segment
  // data as text. The aria-label gives screen-reader users the headline
  // used/total figure without repeating every segment.
  const ariaLabel = used > 0
    ? `Context window: ${formatCompactTokens(used)} of ${formatCompactTokens(total)} tokens used`
    : `Context window usage (total ${formatCompactTokens(total)} tokens)`;

  return (
    <div
      class="ctx-bar"
      role="img"
      aria-label={ariaLabel}
      style={`height:${BAR_HEIGHT_PX}px`}
    >
      {usedSegments.map((s, i) => (
        <div
          key={s.key}
          class="ctx-bar-seg"
          title={s.title}
          style={`width:${widths[i] ?? 0}%;background:${s.color}`}
        />
      ))}
      {remainingSegment && remainingPct > 0 && (
        <div
          key={remainingSegment.key}
          class={cx('ctx-bar-seg', 'ctx-bar-seg--muted')}
          title={remainingSegment.title}
          style={`width:${remainingPct}%;background:${remainingSegment.color}`}
        />
      )}
    </div>
  );
}

function ContextLegend({
  segments,
  total,
}: {
  segments: Segment[];
  total: number;
}): JSX.Element {
  return (
    <div class="rich-tooltip-legend ctx-legend">
      {segments.map((s) => {
        const pct = total > 0 ? (s.tokens / total) * 100 : 0;
        // Sub-0.1% contributors would otherwise round to "0.0%"; surface them
        // as "<0.1%" so a non-zero segment never reads as zero.
        const pctLabel = pct > 0 && pct < 0.1
          ? '<0.1%'
          : `${pct.toFixed(pct < 1 ? 1 : 0)}%`;
        return (
          <span class="rich-tooltip-legend-item ctx-legend-item" key={s.key}>
            <span
              class={cx('rich-tooltip-swatch', s.muted && 'ctx-legend-swatch--muted')}
              style={`background:${s.color}`}
            />
            <span class="ctx-legend-label" title={s.note}>
              {s.label}
              {s.note && <span class="ctx-legend-note">{` · ${s.note}`}</span>}
              {s.kindSuffix && <span class="ctx-legend-kind">{` ${s.kindSuffix}`}</span>}
            </span>
            <span class="rich-tooltip-legend-val">{formatCompactTokens(s.tokens)}</span>
            <span class="ctx-legend-pct">{pctLabel}</span>
          </span>
        );
      })}
    </div>
  );
}
