/**
 * Shared Intl.NumberFormat-based token and cost formatters with module-level
 * cached NumberFormat instances. Centralizes the formatting that was
 * previously duplicated across the context-window, session-tabs, transcript,
 * and system-prompt-tokens modules.
 *
 * The NumberFormat instances are created once at module load and reused across
 * calls, matching the caching behavior of the former per-module formatters.
 */

const readableTokenFormatter = new Intl.NumberFormat('en-US');

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactTokenFormatter = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/**
 * Grouped integer token count using en-US digit grouping
 * (e.g. `1234567` -> `"1,234,567"`).
 */
export function formatTokens(n: number): string {
  return readableTokenFormatter.format(n);
}

/**
 * USD currency formatting with the same guard semantics as the former
 * `formatCostUsd`:
 * - non-finite or non-positive values render as `"$0.00"`;
 * - values below `$0.01` render as `"<$0.01"`;
 * - otherwise formatted with exactly 2 fraction digits.
 */
export function formatCost(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return currencyFormatter.format(n);
}

/**
 * Compact-notation token estimate (e.g. `1234` -> `"1.2K"`). Uses the host
 * locale (`undefined`) and a single fractional digit, matching the former
 * `compactTokenFormatter`.
 */
export function formatTokensCompact(n: number): string {
  return compactTokenFormatter.format(n);
}

function trimDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

/**
 * Pure-arithmetic M/k-suffix compact token count (NOT Intl-based).
 * e.g. `1234` -> `"1.2k"`, `1_500_000` -> `"1.5M"`, `999` -> `"999"`.
 */
export function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${trimDecimal(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${trimDecimal(tokens / 1_000)}k`;
  return String(tokens);
}