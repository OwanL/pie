/**
 * Stable color palette for chart segments (providers / models). A key is hashed
 * to a palette index so a given provider always gets the same color across
 * renders and tooltips, without needing to persist a mapping. The palette is
 * tuned for contrast on the panel's dark surface.
 */

const PALETTE = [
  '#4cc2ff', // azure
  '#f0883e', // orange
  '#b079f3', // purple
  '#3fb950', // green
  '#f85149', // red
  '#53b9bd', // teal
  '#e3b341', // yellow
  '#d2a8ff', // lilac
  '#a5d6ff', // pale blue
  '#db6d28', // amber
];

/** Deterministic color for a segment key (provider or model id). */
export function colorFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) {
    h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length]!;
}
