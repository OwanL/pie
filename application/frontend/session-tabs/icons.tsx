/** @jsxRuntime automatic */
/** @jsxImportSource preact */

// Small reusable inline-SVG icons shared by session-tab controls and the
// context menu. Context-menu icons render in a 13×13 leading indicator slot;
// the empty `CheckmarkIcon` is the spacer used on items without one.

/** Quiet provenance cue for sessions created by an agent. */
export function AgentIcon({ compact = false }: { compact?: boolean } = {}) {
  const size = compact ? 11 : 13;
  return (
    <svg
      class={`session-tab-agent-icon${compact ? ' compact' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.35"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M8 1.75v2" />
      <rect x="3" y="4" width="10" height="9" rx="2" />
      <circle cx="6.25" cy="8.25" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="9.75" cy="8.25" r="0.7" fill="currentColor" stroke="none" />
      <path d="M5.75 10.75h4.5" />
    </svg>
  );
}

export function CheckmarkIcon() {
  return (
    <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0" />
  );
}

export function DuplicateIcon() {
  return (
    <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0">
      <rect x="2" y="2" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0">
      <line x1="3" y1="3" x2="10" y2="10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      <line x1="10" y1="3" x2="3" y2="10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    </svg>
  );
}
