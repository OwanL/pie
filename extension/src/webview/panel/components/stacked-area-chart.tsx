/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useMemo, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import type { AggregateSeriesPoint } from '../../../shared/protocol';
import { colorsFor } from './chart-colors';

/**
 * Reusable SVG stacked-area/bar chart for status-strip tooltip graphs.
 *
 * Three modes:
 *  - **`cumulative`** (cost / tokens): exact timestamped cumulative samples
 *    are joined with monotone cubic curves. The interpolation cannot overshoot
 *    adjacent values, and the final sample remains the exact headline total.
 *  - **`rate`** (today's throughput / daily run count): per-bucket values
 *    rendered as spaced stacked bars.
 *  - **`line`** (work trend counts): one non-stacked line per series, so
 *    overlapping quantities (sessions used vs peak working) are compared
 *    rather than summed.
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
  mode: 'cumulative' | 'rate' | 'line';
  /** Format a y-value for the axis max + hover. */
  formatY: (n: number) => string;
  /** Format an x-ms value for the axis labels + hover. */
  formatX: (ms: number) => string;
  /** Optional unit label shown beside the max. */
  unit?: string;
  /** Full legend key set. Supplying it keeps collision-resolved chart fills and
   * legend swatches identical even when a zero-valued key has no SVG mark. */
  colorKeys?: string[];
  height?: number;
  width?: number;
}

const PAD_L = 4;
const PAD_R = 4;
const PAD_T = 6;
const PAD_B = 13;

interface PlotPoint {
  x: number;
  y: number;
}

/** Fritsch-Carlson monotone tangents for a series sampled at `xs` knots.
 *  Flat intervals stay flat and each interval is slope-limited, so a curve
 *  built from these tangents never overshoots the exact samples of a monotone
 *  series. Shared by the line-mode curves and the stacked band construction.
 *  Exported so regression tests can reproduce the exact smoothing the chart
 *  uses (e.g. to prove an adversarial input would cross under independent
 *  boundary smoothing). */
export function monotoneTangents(xs: number[], ys: number[]): number[] {
  const n = xs.length;
  const tangents = new Array<number>(n).fill(0);
  if (n < 2) return tangents;

  const deltas: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const dx = xs[i + 1]! - xs[i]!;
    deltas.push(dx === 0 ? 0 : (ys[i + 1]! - ys[i]!) / dx);
  }
  tangents[0] = deltas[0]!;
  tangents[n - 1] = deltas[deltas.length - 1]!;
  for (let i = 1; i < n - 1; i += 1) {
    const before = deltas[i - 1]!;
    const after = deltas[i]!;
    tangents[i] = before * after <= 0 ? 0 : (2 * before * after) / (before + after);
  }
  for (let i = 0; i < deltas.length; i += 1) {
    const slope = deltas[i]!;
    if (slope === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = tangents[i]! / slope;
    const b = tangents[i + 1]! / slope;
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[i] = scale * a * slope;
      tangents[i + 1] = scale * b * slope;
    }
  }
  return tangents;
}

/** Fritsch-Carlson monotone cubic interpolation expressed as SVG Béziers.
 * Flat intervals stay flat and each interval is slope-limited, so cumulative
 * values never overshoot the exact samples. */
function monotoneCurve(points: PlotPoint[], includeMove: boolean): string {
  if (points.length === 0) return '';
  let path = includeMove ? `M ${points[0]!.x} ${points[0]!.y}` : '';
  if (points.length === 1) return path;

  const tangents = monotoneTangents(points.map((p) => p.x), points.map((p) => p.y));
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i]!;
    const to = points[i + 1]!;
    const dx = to.x - from.x;
    path += ` C ${from.x + dx / 3} ${from.y + tangents[i]! * dx / 3}`
      + ` ${to.x - dx / 3} ${to.y - tangents[i + 1]! * dx / 3}`
      + ` ${to.x} ${to.y}`;
  }
  return path;
}

/** Cubic Bézier control values (pre-projection value space) for one interval
 *  of a stacked boundary: the curve starts at `start`, leaves toward
 *  `startControl`, arrives from `endControl`, and ends exactly at `end`. */
export interface StackedBoundaryInterval {
  start: number;
  startControl: number;
  endControl: number;
  end: number;
}

/**
 * Stacked cumulative band boundaries built from per-provider cumulative
 * contribution series (stack order = array order) over shared x knots.
 *
 * Each non-negative contribution series is interpolated independently with
 * monotone (Fritsch–Carlson) tangents: on a monotone series the curve stays
 * inside each interval's sample range, so a non-negative series can never
 * produce a negative contribution anywhere. The stacked upper/lower
 * boundaries are the component-wise sums of those contribution curves:
 * summing control values of curves that share knots and Bézier
 * parameterization yields exactly the curve of the summed values, so each
 * band's thickness equals its own contribution curve at every point.
 * Independently smoothing the (already ordered) boundary series can cross
 * mid-interval and invert a band; this construction mathematically cannot.
 * Boundary values at the knots are the exact stacked sample totals.
 */
export function stackedBoundaryCurves(
  contributions: number[][],
  xs: number[],
): Array<{ lower: StackedBoundaryInterval[]; upper: StackedBoundaryInterval[] }> {
  const intervalCount = Math.max(0, xs.length - 1);
  const zeroIntervals: StackedBoundaryInterval[] = Array.from(
    { length: intervalCount },
    () => ({ start: 0, startControl: 0, endControl: 0, end: 0 }),
  );
  const bands: Array<{ lower: StackedBoundaryInterval[]; upper: StackedBoundaryInterval[] }> = [];
  let lower: StackedBoundaryInterval[] = zeroIntervals;
  for (const contribution of contributions) {
    const tangents = monotoneTangents(xs, contribution);
    const upper: StackedBoundaryInterval[] = [];
    for (let i = 0; i < intervalCount; i += 1) {
      const dx = xs[i + 1]! - xs[i]!;
      upper.push({
        start: lower[i]!.start + contribution[i]!,
        startControl: lower[i]!.startControl + contribution[i]! + (tangents[i]! * dx) / 3,
        endControl: lower[i]!.endControl + contribution[i + 1]! - (tangents[i + 1]! * dx) / 3,
        end: lower[i]!.end + contribution[i + 1]!,
      });
    }
    bands.push({ lower, upper });
    lower = upper;
  }
  return bands;
}

export function StackedAreaChart({
  points,
  mode,
  formatY,
  formatX,
  unit,
  colorKeys,
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
      if (mode === 'line') {
        // Non-stacked series scale to the largest single value, not their sum.
        for (const seg of p.byProvider) {
          if (seg.value > yMax) yMax = seg.value;
        }
      } else {
        let s = 0;
        for (const seg of p.byProvider) s += seg.value;
        if (s > yMax) yMax = s;
      }
    }
    return {
      providers,
      colors: colorsFor(colorKeys ?? providers),
      minMs,
      maxMs,
      span,
      yMax: yMax > 0 ? yMax : 1,
    };
  }, [points, colorKeys, mode]);

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

  const marks: JSX.Element[] = [];
  if (mode === 'line') {
    // One stroked monotone curve + exact-sample dots per series. Lines are
    // never stacked: each series maps its own value onto the shared scale.
    for (const provider of model.providers) {
      const plotPoints = points
        .map((p) => {
          const seg = p.byProvider.find((entry) => entry.key === provider);
          return seg ? { x: xFor(p.ms), y: yFor(seg.value) } : null;
        })
        .filter((pt): pt is PlotPoint => pt !== null);
      if (plotPoints.length === 0) continue;
      const d = monotoneCurve(plotPoints, true);
      const color = model.colors.get(provider);
      marks.push(
        <path
          key={`line-${provider}`}
          d={d}
          fill="none"
          stroke={color}
          stroke-width="1.5"
          stroke-linecap="round"
          opacity="0.95"
        />,
      );
      for (const pt of plotPoints) {
        marks.push(
          <circle key={`dot-${provider}-${pt.x}-${pt.y}`} cx={pt.x} cy={pt.y} r="2" fill={color} opacity="0.95" />,
        );
      }
    }
  } else if (mode === 'cumulative') {
    // One closed path per provider, built from per-provider CONTRIBUTION
    // curves (see stackedBoundaryCurves). Never smooth the stacked upper/lower
    // boundaries independently: two ordered monotone boundaries can still
    // cross mid-interval and invert the band fill. Smoothing each non-negative
    // contribution and summing the curves keeps every band thickness equal to
    // its own non-negative contribution curve, preserves every exact sample
    // endpoint/total, and stays a smooth cubic path.
    const xs = points.map((p) => xFor(p.ms));
    const contributions = model.providers.map((_, providerIdx) =>
      pointSegs.map((p) => p.segs[providerIdx]!.y1 - p.segs[providerIdx]!.y0));
    const bands = stackedBoundaryCurves(contributions, xs);
    for (let providerIdx = 0; providerIdx < model.providers.length; providerIdx += 1) {
      const provider = model.providers[providerIdx]!;
      const nonEmpty = pointSegs.some((p) => p.segs[providerIdx]!.y1 > p.segs[providerIdx]!.y0);
      if (!nonEmpty) continue;
      const band = bands[providerIdx]!;
      let d: string;
      if (band.upper.length === 0) {
        // Single sample: a degenerate closed band at the exact stacked values.
        const x = xs[0]!;
        const seg = pointSegs[0]!.segs[providerIdx]!;
        d = `M ${x} ${yFor(seg.y1)} L ${x} ${yFor(seg.y0)} Z`;
      } else {
        d = `M ${xs[0]} ${yFor(band.upper[0]!.start)}`;
        for (let i = 0; i < band.upper.length; i += 1) {
          const c = band.upper[i]!;
          const dx = xs[i + 1]! - xs[i]!;
          d += ` C ${xs[i]! + dx / 3} ${yFor(c.startControl)}`
            + ` ${xs[i + 1]! - dx / 3} ${yFor(c.endControl)}`
            + ` ${xs[i + 1]!} ${yFor(c.end)}`;
        }
        // Lower boundary traversed right → left (reversed intervals).
        d += ` L ${xs[xs.length - 1]} ${yFor(band.lower[band.lower.length - 1]!.end)}`;
        for (let i = band.lower.length - 1; i >= 0; i -= 1) {
          const c = band.lower[i]!;
          const dx = xs[i + 1]! - xs[i]!;
          d += ` C ${xs[i + 1]! - dx / 3} ${yFor(c.endControl)}`
            + ` ${xs[i]! + dx / 3} ${yFor(c.startControl)}`
            + ` ${xs[i]!} ${yFor(c.start)}`;
        }
        d += ' Z';
      }
      marks.push(<path key={provider} d={d} fill={model.colors.get(provider)} opacity="0.92" />);
    }
  } else {
    for (let i = 0; i < pointSegs.length; i += 1) {
      const ps = pointSegs[i]!;
      const x = xFor(ps.ms);
      const bw = Math.min(16, (plotW / Math.max(1, pointSegs.length)) * 0.7);
      const dim = hoverIdx !== null && hoverIdx !== i;
      for (const seg of ps.segs) {
        if (seg.y1 - seg.y0 <= 0) continue;
        marks.push(
          <rect
            x={x - bw / 2}
            y={yFor(seg.y1)}
            width={bw}
            height={yFor(seg.y0) - yFor(seg.y1)}
            fill={model.colors.get(seg.provider)}
            opacity={dim ? 0.4 : 0.92}
          />,
        );
      }
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
  const hoverProviders = hp && hpPoint
    ? model.providers.map((provider, providerIdx) => ({
        provider,
        value: mode === 'line'
          ? (hpPoint.byProvider.find((seg) => seg.key === provider)?.value ?? 0)
          : hp.segs[providerIdx]!.y1 - hp.segs[providerIdx]!.y0,
        models: hpPoint.byModel.filter((entry) => entry.provider === provider),
      })).filter((entry) => entry.value > 0 || entry.models.length > 0)
    : [];
  // Clamp the hover box inside the chart so it never overflows the tooltip.
  const hoverLeft = hp ? Math.min(Math.max(xFor(hp.ms) - 78, 2), width - 184) : 0;

  return (
    <div class="chart-wrap" style={`width:${width}px`}>
      <svg
        aria-hidden="true"
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
        {marks}
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
            {mode !== 'line' && (
              <span class="chart-hover-total">{formatY(hp.total)}{unit ? ` ${unit}` : ''}</span>
            )}
          </div>
          {hoverProviders.length > 0 && (
            <div class="chart-hover-providers">
              {hoverProviders.slice(0, 5).map((provider) => (
                <div class="chart-hover-provider" key={provider.provider}>
                  <div class="chart-hover-provider-head">
                    <span class="rich-tooltip-swatch" style={`background:${model.colors.get(provider.provider)}`} />
                    <span class="chart-hover-provider-name">{provider.provider}</span>
                    <span class="chart-hover-model-val">{formatY(provider.value)}</span>
                  </div>
                  {provider.models.slice(0, 4).map((entry) => (
                    <div class="chart-hover-model" key={`${entry.provider}\u0000${entry.model}`}>
                      <span class="chart-hover-model-name" title={`${entry.model} (${entry.provider})`}>{entry.model}</span>
                      <span class="chart-hover-model-val">{formatY(entry.value)}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <ChartAccessibilityTable points={points} mode={mode} formatX={formatX} formatY={formatY} unit={unit} />
    </div>
  );
}

/**
 * Non-pointer representation of the chart's hover data. This table is visually
 * clipped, not `display:none`, so screen-reader users can inspect every point
 * and provider-qualified model without turning hundreds of samples into tab
 * stops. The visual SVG/crosshair remains mouse-driven.
 */
function ChartAccessibilityTable({
  points,
  mode,
  formatX,
  formatY,
  unit,
}: {
  points: AggregateSeriesPoint[];
  mode: StackedAreaChartProps['mode'];
  formatX: (ms: number) => string;
  formatY: (value: number) => string;
  unit?: string;
}): JSX.Element {
  const modeLabel = mode === 'cumulative' ? 'cumulative' : mode === 'rate' ? 'rate' : 'line';
  const accessiblePoints = sampleAccessibilityPoints(points, 12);
  const sampled = accessiblePoints.length < points.length;
  return (
    <table class="chart-a11y-table">
      <caption>{`${modeLabel} chart data${sampled ? `; ${accessiblePoints.length} representative points from ${points.length}` : ''}; each row includes the provider and model details available at that point.`}</caption>
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Provider</th>
          <th scope="col">Model</th>
          <th scope="col">Value</th>
          <th scope="col">Point total</th>
        </tr>
      </thead>
      <tbody>
        {accessiblePoints.flatMap((point) => {
          const providerEntries = point.byProvider.length > 0
            ? point.byProvider
            : [...new Set(point.byModel.map((entry) => entry.provider))].map((provider) => ({
                key: provider,
                value: point.byModel
                  .filter((entry) => entry.provider === provider)
                  .reduce((sum, entry) => sum + entry.value, 0),
              }));
          const pointTotal = point.byProvider.reduce((sum, entry) => sum + entry.value, 0);
          return providerEntries.flatMap((provider) => {
            const models = point.byModel.filter((entry) => entry.provider === provider.key);
            const providerRow = (
              <tr key={`${point.ms}\u0000${provider.key}`}>
                <th scope="row">{formatX(point.ms)}</th>
                <td>{provider.key}</td>
                <td>All models</td>
                <td>{formatY(provider.value)}{unit ? ` ${unit}` : ''}</td>
                <td>{mode === 'line' ? '—' : `${formatY(pointTotal)}${unit ? ` ${unit}` : ''}`}</td>
              </tr>
            );
            const modelRows = models.map((entry) => (
              <tr key={`${point.ms}\u0000${entry.provider}\u0000${entry.model}`}>
                <th scope="row">{formatX(point.ms)}</th>
                <td>{entry.provider}</td>
                <td>{entry.model} ({entry.provider})</td>
                <td>{formatY(entry.value)}{unit ? ` ${unit}` : ''}</td>
                <td />
              </tr>
            ));
            return [providerRow, ...modelRows];
          });
        })}
      </tbody>
    </table>
  );
}

/** Keep rich-tooltip charts useful to screen readers without placing hundreds
 * of minute buckets (and their provider/model subrows) into the accessibility
 * tree. Uniform sampling preserves the first and last points and the shape in
 * between; the caption discloses when the table is representative. */
function sampleAccessibilityPoints(points: AggregateSeriesPoint[], limit: number): AggregateSeriesPoint[] {
  if (points.length <= limit || limit < 2) return points;
  const sampled: AggregateSeriesPoint[] = [];
  let previousIndex = -1;
  for (let slot = 0; slot < limit; slot += 1) {
    const index = Math.round((slot * (points.length - 1)) / (limit - 1));
    if (index === previousIndex) continue;
    sampled.push(points[index]!);
    previousIndex = index;
  }
  return sampled;
}
