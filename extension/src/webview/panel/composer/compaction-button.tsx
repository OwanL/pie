/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { Tooltip } from '../components/tooltip';

interface Props {
  disabled: boolean;
  onCompact: () => void;
}

/** Manually summarize older conversation history to free context. */
export function CompactionButton({ disabled, onCompact }: Props) {
  const label = disabled ? 'Compaction is unavailable while the session is running' : 'Compact conversation context';
  return (
    <Tooltip content={label} placement="top">
      <button
        type="button"
        class="system-prompt-toggle-trigger compaction-trigger"
        aria-label={label}
        disabled={disabled}
        onClick={onCompact}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 3l3.25 3.25M3 3h3M3 3v3" />
          <path d="M13 3L9.75 6.25M13 3h-3M13 3v3" />
          <path d="M3 13l3.25-3.25M3 13h3M3 13v-3" />
          <path d="M13 13L9.75 9.75M13 13h-3M13 13v-3" />
        </svg>
      </button>
    </Tooltip>
  );
}
