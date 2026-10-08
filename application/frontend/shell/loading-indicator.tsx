/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { cx } from '../lib/components/cx';

export interface LoadingIndicatorProps {
  /**
   * Short status line rendered beside the spinner (e.g. "Starting pi", "Loading
   * conversation"). Omit for a bare spinner. When provided, the visible text also
   * serves as the accessible name for the live region.
   */
  status?: string;
  /** Accessible label used only when no visible status is provided. */
  ariaLabel?: string;
  /** Extra classes on the wrapper. */
  class?: string;
}

/**
 * Single source of truth for loading affordances: the animated `.loading-wheel`
 * (keyframe lives in `index.css`) paired with an optional, subtle inline label.
 * The spinner carries the only motion. Used by the boot, session-recovery,
 * and transcript-hydrating surfaces.
 */
export function LoadingIndicator({ status, ariaLabel, class: className }: LoadingIndicatorProps) {
  return (
    <div
      class={cx('loading-indicator', className)}
      role="status"
      aria-label={status ? undefined : (ariaLabel ?? 'Loading')}
    >
      <div class="loading-wheel" aria-hidden="true" />
      {status && (
        <div class="loading-status">
          <span class="loading-status-text">{status}</span>
        </div>
      )}
    </div>
  );
}
