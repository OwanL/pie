/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useMemo, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import type { AggregateSeriesPoint } from '../../../shared/protocol';
import { colorFor } from './chart-colors';

/**
 * Reusable SVG stacked-area/bar chart for status-strip tooltip graphs.
 *
 * Two modes:
 *  - **`cumulative`** (today's cost / tokens): values grow through the day;
 *    rendered as adjacent stacked step-bars so the silhouette is a staircase
 *    ending at the headline total. A trailing "now" point (appended host-side)
 *    extends the area to the current moment.
 *  - **`rate`** (today's throughput / weekly daily cost / daily run count):
 *    per-bucket values rendered as spaced stacked bars.
 *
 * Hover shows a crosshair at the nearest point plus a per-model breakdown box
 * (the stacked bands are per-provider; the hover drills into per-model).
 *
 * Empty-space pruning is host-side: the caller passes only points within
 * [first activity, now], so the x-axis is time-proportional with no leading or
 * trailing empty margin.
 *
 * Rendered inside an isolated Preact root (the rich tooltip's imperative
 * `render()`), so internal `useState` hover state persists for the hover.
 */

export interface StackedAreaChartProps {
  points: AggregateSeriesPoint[];
  mode: 'cumulative' | 'rate';
  /** Format a y-value for the axis max + hover. */
  formatY: (n: number) => string;
  /** Format an x-ms value for the axis labels + hover. */
  formatX: (ms: number) => string;
  /** Optional unit label shown beside the max. */
  unit?: string;
  height?: number;
  width?: number;
}

const PAD_L = 4;
const PAD_R = 4;
const PAD_T = 6;
const PAD_B = 13;

export function StackedAreaChart({
  points,
  mode,
  formatY,
  formatX,
  unit,
  height = 84,
  width = 312,
}: StackedAreaChartProps): JSX.Element {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const model = useMemo(() => {
    // Providers = union across points, sorted by total contribution desc so the
    // stack order is stable and the largest band sits on the baseline.
    const totals = new Map<string, number>();
    for (const p of points) {
      for (const s of p.byProvider) {
        totals.set(s.key, (totals.get(s.key) ?? 0) + s.value);
      }
    }
    const providers = [...totals.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    const minMs = points.length ? points[0]!.ms : 0;
    const maxMs = points.length ? points[points.length - 1]!.ms : 0;
    const span = Math.max(1, maxMs - minMs);
    let yMax = 0;
    for (const p of points) {
      let s = 0;
      for (const seg of p.byProvider) s += seg.value;
      if (s > yMax) yMax = s;
    }
    return { providers, minMs, maxMs, span, yMax: yMax > 0 ? yMax : 1 };
  }, [points]);

  if (points.length === 0 || model.yMax <= 0) {
    return <div class="chart-empty">No data yet</div>;
  }

  const plotW = width - PAD_L - PAD_R;
  const plotH = height - PAD_T - PAD_B;
  const xFor = (ms: number) => PAD_L + ((ms - model.minMs) / model.span) * plotW;
  const yFor = (v: number) => PAD_T + plotH - (v / model.yMax) * plotH;

  // Per-point stacked segments (cumulative offset per provider).
  const pointSegs = points.map((p) => {
    const valByProv = new Map(p.byProvider.map((s) => [s.key, s.value]));
    let y0 = 0;
    const segs = model.providers.map((prov) => {
      const v = valByProv.get(prov) ?? 0;
      const seg = { provider: prov, y0, y1: y0 + v };
      y0 += v;
      return seg;
    });
    return { ms: p.ms, total: y0, segs };
  });

  const bars: JSX.Element[] = [];
  for (let i = 0; i < pointSegs.length; i += 1) {
    const ps = pointSegs[i]!;
    const x0 = xFor(ps.ms);
    const nextX = i < pointSegs.length - 1 ? xFor(pointSegs[i + 1]!.ms) : PAD_L + plotW;
    const bw = mode === 'cumulative'
      ? Math.max(0.5, nextX - x0)
      : Math.min(16, (plotW / Math.max(1, pointSegs.length)) * 0.7);
    const bx = mode === 'cumulative' ? x0 : x0 - bw / 2;
    const dim = hoverIdx !== null && hoverIdx !== i;
    for (const seg of ps.segs) {
      if (seg.y1 - seg.y0 <= 0) continue;
      bars.push(
        <rect
          x={bx}
          y={yFor(seg.y1)}
          width={bw}
          height={yFor(seg.y0) - yFor(seg.y1)}
          fill={colorFor(seg.provider)}
          opacity={dim ? 0.4 : 0.92}
        />,
      );
    }
  }

  const onMove = (e: JSX.TargetedMouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * width;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i += 1) {
      const d = Math.abs(xFor(points[i]!.ms) - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHoverIdx(best);
  };

  const hp = hoverIdx !== null ? pointSegs[hoverIdx]! : null;
  const hpPoint = hoverIdx !== null ? points[hoverIdx]! : null;
  // Clamp the hover box inside the chart so it never overflows the tooltip.
  const hoverLeft = hp ? Math.min(Math.max(xFor(hp.ms) - 60, 2), width - 150) : 0;

  return (
    <div class="chart-wrap" style={`width:${width}px`}>
      <svg
        width={width}
        height={height}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <line
          x1={PAD_L}
          y1={yFor(model.yMax)}
          x2={PAD_L + plotW}
          y2={yFor(model.yMax)}
          stroke="var(--panel-border-subtle)"
          stroke-width="0.5"
          stroke-dasharray="2 2"
        />
        {bars}
        {hp && (
          <line
            x1={xFor(hp.ms)}
            y1={PAD_T}
            x2={xFor(hp.ms)}
            y2={PAD_T + plotH}
            stroke="var(--panel-foreground)"
            stroke-width="0.5"
            opacity="0.45"
          />
        )}
      </svg>
      <div class="chart-axis">
        <span>{formatX(model.minMs)}</span>
        <span class="chart-axis-max">
          {formatY(model.yMax)}{unit ? ` ${unit}` : ''}
        </span>
        <span>{formatX(model.maxMs)}</span>
      </div>
      {hp && hpPoint && (
        <div class="chart-hover" style={`left:${hoverLeft}px`}>
          <div class="chart-hover-head">
            <span class="chart-hover-time">{formatX(hpPoint.ms)}</span>
            <span class="chart-hover-total">{formatY(hp.total)}{unit ? ` ${unit}` : ''}</span>
          </div>
          {hpPoint.byModel.length > 0 && (
            <div class="chart-hover-models">
              {hpPoint.byModel.slice(0, 6).map((m) => (
                <div class="chart-hover-model" key={m.key}>
                  <span class="chart-hover-model-name" title={m.key}>{m.key}</span>
                  <span class="chart-hover-model-val">{formatY(m.value)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
