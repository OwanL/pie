/** @jsxRuntime automatic */
/** @jsxImportSource preact */

/**
 * Inline ✂ badge shown on a tool-call header when the tool-result-pruner
 * extension losslessly rewrote that tool's output (stripped ANSI, trimmed
 * whitespace, collapsed blank runs, minified JSON). Sits next to the
 * duration in {@link ToolCallHeader} so it stays visible when the card is
 * collapsed.
 *
 * Reads from the extension-merged `toolCall.result.details.pruningBadge`
 * (`{ rules, tokensSaved }`). Returns `null` when there is no badge or no
 * rules fired, so un-pruned tool calls render unchanged.
 */

export interface ToolResultPruningBadgeData {
  rules: string[];
  tokensSaved: number;
}

interface ToolResultPruningBadgeProps {
  badge?: ToolResultPruningBadgeData | null;
}

export function ToolResultPruningBadge({ badge }: ToolResultPruningBadgeProps) {
  if (!badge || badge.rules.length === 0) return null;
  const rulesLabel = badge.rules.join(', ');
  const title = `Tool-result pruning applied: ${rulesLabel} · ~${badge.tokensSaved} tokens saved`;
  return (
    <span class="tool-result-pruning-badge" title={title} aria-label={title}>
      <span class="tool-result-pruning-badge-text">
        ✂ pruned · {rulesLabel} · ~{badge.tokensSaved} tokens saved
      </span>
    </span>
  );
}
