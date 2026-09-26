/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { cx } from './cx';

interface QuestionIconProps {
  /** Square pixel size of the glyph. */
  size?: number;
  /** Extra classes (e.g. for color overrides via `currentColor`). */
  class?: string;
}

/**
 * Speech-bubble glyph used as the visual identity for ask_user prompts
 * (interactive, loading, and completed states). Replaces the previous text
 * "?" which rendered awkwardly (font-glyph centering). `currentColor` lets it
 * inherit the accent (pending/loading) or success (completed) color from its
 * container (`.ext-prompt-icon` / `.ask-user-icon`).
 */
export function QuestionIcon({ size = 13, class: className }: QuestionIconProps) {
  return (
    <svg
      class={cx('question-icon', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
