/*
 * Stable categorical colours for provider/model charts. The palette is tuned
 * for Pie's dark panel and deliberately alternates hue families so adjacent
 * collision-resolution slots remain visually distinct.
 */

const PALETTE = [
  '#4CC2FF', // cyan-blue
  '#FF8A3D', // orange
  '#C77DFF', // violet
  '#54D66A', // green
  '#FF5C5C', // red
  '#2EC4B6', // teal
  '#FFD166', // yellow
  '#F065C2', // magenta
  '#9BE564', // lime
  '#4D8BFF', // royal blue
  '#FF6B9A', // pink
  '#A78BFA', // indigo
  '#00B8D9', // cyan
  '#D9A441', // ochre
  '#7BDFF2', // ice blue
  '#E879F9', // orchid
] as const;

function paletteIndex(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
  }
  return (hash >>> 0) % PALETTE.length;
}

/** Deterministic default colour for one segment key. */
export function colorFor(key: string): string {
  return PALETTE[paletteIndex(key)]!;
}

/**
 * Deterministic, order-independent colours for all keys in one chart. Hash
 * collisions probe forward to the next free slot, guaranteeing distinct fills
 * whenever the chart contains no more series than the palette.
 */
export function colorsFor(keys: readonly string[]): Map<string, string> {
  const uniqueKeys = [...new Set(keys)].sort();
  const result = new Map<string, string>();
  const used = new Set<number>();

  for (const key of uniqueKeys) {
    const preferred = paletteIndex(key);
    let index = preferred;
    if (used.size < PALETTE.length) {
      for (let offset = 0; offset < PALETTE.length; offset += 1) {
        const candidate = (preferred + offset) % PALETTE.length;
        if (!used.has(candidate)) {
          index = candidate;
          break;
        }
      }
    }
    used.add(index);
    result.set(key, PALETTE[index]!);
  }
  return result;
}
