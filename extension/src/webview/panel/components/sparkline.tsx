/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { JSX } from 'preact';

/**
 * Tiny inline line sparkline for the last-run tooltip: one point per assistant
 * turn's output tokens, plotted over the run's duration. Gives a quick visual
 * of how token output was distributed across the run's turns.
 */
export interface SparklineProps {
  data: { ms: number; value: number }[];
  width?: number;
  height?: number;
  color?: string;
}

export function Sparkline({
  data,
  width = 120,
  height = 28,
  color = 'var(--panel-accent)',
}: SparklineProps): JSX.Element {
  if (data.length === 0) {
    return <div class="sparkline sparkline--empty" style={`width:${width}px;height:${height}px`}>—</div>;
  }

  const minMs = data[0]!.ms;
  const maxMs = data[data.length - 1]!.ms;
  const span = Math.max(1, maxMs - minMs);
  const maxVal = Math.max(1, ...data.map((d) => d.value));
  const pad = 2;
  const w = width - pad * 2;
  const h = height - pad * 2;

  const pts = data.map((d) => {
    const x = data.length === 1 ? pad + w / 2 : pad + ((d.ms - minMs) / span) * w;
    const y = pad + h - (d.value / maxVal) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg class="sparkline" width={width} height={height} aria-hidden="true">
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke={color}
        stroke-width="1.4"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
      {data.length === 1 && <circle cx={pts[0]!.split(',')[0]} cy={pts[0]!.split(',')[1]} r="1.6" fill={color} />}
    </svg>
  );
}
