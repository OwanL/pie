/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { JSX } from 'preact';

import type { ContextWindowBreakdown, ContextWindowBreakdownEntry } from './breakdown';
import { formatCompactTokens } from '../utils/format-tokens';
import { cx } from '../utils/cx';

/**
 * Rich (JSX) tooltip for the context-window indicator. Renders a horizontal
 * stacked bar of the full context window: the used portion is split into its
 * contributor segments (system prompt, read files, skills, user messages,
 * other) and the remainder is shown as a muted tail. A legend below the bar
 * lists every segment with its colour swatch, label, and compact token count,
 * followed by the attribution notes.
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
  'Other': '#e3b341', // yellow
};

const FALLBACK_PALETTE = [
  '#53b9bd', // teal
  '#d2a8ff', // lilac
  '#a5d6ff', // pale blue
  '#db6d28', // amber
  '#f85149', // red
];

function segmentColor(label: string): string {
  const fixed = SEGMENT_COLORS[label];
  if (fixed) return fixed;
  let h = 0;
  for (let i = 0; i < label.length; i += 1) {
    h = (h * 31 + label.charCodeAt(i)) | 0;
  }
  return FALLBACK_PALETTE[Math.abs(h) % FALLBACK_PALETTE.length]!;
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
  /** Attribution kind suffix for the legend (estimated/derived/unknown). */
  kindSuffix?: string;
  /** Hover text for the segment's native `title`. */
  title: string;
}

function kindSuffixFor(entry: ContextWindowBreakdownEntry): string | undefined {
  if (entry.kind === 'estimated') return 'est';
  if (entry.kind === 'derived') return 'derived';
  if (entry.kind === 'unknown') return '?';
  return undefined;
}

export function ContextWindowBreakdownChart({
  breakdown,
}: {
  breakdown: ContextWindowBreakdown;
}): JSX.Element {
  const { summary, entries, notes } = breakdown;
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
  const remaining = summary.remainingTokens ?? Math.max(total - used, 0);

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
        kindSuffix: kindSuffixFor(e),
        title: `${label}: ${formatCompactTokens(tokens)} tokens (${pct.toFixed(1)}%)`,
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
        <span class="rich-tooltip-head-value">
          {summary.usedTokens !== null ? formatCompactTokens(summary.usedTokens) : '?'}
          {' / '}
          {formatCompactTokens(total)}
        </span>
      </div>

      <ContextBar
        usedSegments={displayUsedSegments}
        remainingSegment={remainingSegment}
        total={total}
      />

      <ContextLegend segments={allSegments} total={total} />

      {notes.length > 0 && (
        <div class="rich-tooltip-sub rich-tooltip-ctx-notes">
          {notes.join('\n')}
        </div>
      )}
    </div>
  );
}

function ContextBar({
  usedSegments,
  remainingSegment,
  total,
}: {
  usedSegments: Segment[];
  remainingSegment: Segment | null;
  total: number;
}): JSX.Element {
  // The bar spans the whole context window (100%). Each used contributor's
  // width is its true share of the total. Non-zero segments are bumped to a
  // minimum visible width so tiny contributors remain hoverable; the extra is
  // taken from the remaining tail (the muted remainder), and the total is
  // clamped to 100% so a saturated window never overflows.
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

  return (
    <div
      class="ctx-bar"
      role="img"
      aria-label="Context window usage breakdown"
      style={`height:${BAR_HEIGHT_PX}px`}
    >
      {usedSegments.map((s, i) => (
        <div
          key={s.key}
          class="ctx-bar-seg"
          title={s.title}
          style={`width:${bumpedPcts[i] ?? 0}%;background:${s.color}`}
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
        return (
          <span class="rich-tooltip-legend-item ctx-legend-item" key={s.key}>
            <span
              class={cx('rich-tooltip-swatch', s.muted && 'ctx-legend-swatch--muted')}
              style={`background:${s.color}`}
            />
            <span class="ctx-legend-label">
              {s.label}
              {s.kindSuffix && <span class="ctx-legend-kind">{` ${s.kindSuffix}`}</span>}
            </span>
            <span class="rich-tooltip-legend-val">{formatCompactTokens(s.tokens)}</span>
            <span class="ctx-legend-pct">{pct.toFixed(pct < 1 ? 1 : 0)}%</span>
          </span>
        );
      })}
    </div>
  );
}