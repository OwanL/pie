/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ToolCall } from '../../../../shared/protocol';
import { cx } from '../../utils/cx';
import { CollapsibleChevron } from '../../components/chevron';
import { formatDuration } from '../header';
import { StatusChip } from '../status-chip';
import { DEFAULT_CHAT_PREFS, type ChatPrefs } from '../../../../shared/protocol';

import { CollapsedSummary } from './collapsed-summary';
import { ToolCallStatusGlyph } from './status-glyph';
import { buildToolCallHeaderSummaryModel } from './summary-model';
import type { ToolCallHeaderSummaryModel } from './types';
import { ToolResultPruningBadge, type ToolResultPruningBadgeData } from '../tool-result-pruning-badge';

interface ToolCallHeaderProps {
  open: boolean;
  bodyVisible?: boolean;
  name: string;
  nameTitle?: string;
  status: ToolCall['status'];
  summary: string | null;
  summaryPath?: string;
  summaryModel?: ToolCallHeaderSummaryModel;
  sizeHint?: string;
  errorDetail?: string;
  /** Inline ✂ badge from the tool-result-pruner extension (`result.details.pruningBadge`).
   *  Rendered before the duration so it's visible even when the card is collapsed. */
  pruningBadge?: ToolResultPruningBadgeData | null;
  durationMs?: number;
  /** id of the body region this header controls, set as `aria-controls`.
   *  Only passed when the body is actually mounted (see ToolCallCard) so the
   *  reference never points at a missing element. */
  ariaControls?: string;
  prefs?: ChatPrefs;
  onOpenFile: (path: string) => void;
  /** Toggle the card's expanded state. The header is the toggle target so the
   *  card body stays a plain region (its selectable/copyable content remains
   *  reachable to AT) instead of being nested inside a button role. */
  onToggle: () => void;
}

export function ToolCallHeader({ open, bodyVisible, name, nameTitle, status, summary, summaryPath, summaryModel, sizeHint, errorDetail, pruningBadge, durationMs, ariaControls, prefs = DEFAULT_CHAT_PREFS, onOpenFile, onToggle }: ToolCallHeaderProps) {
  const statusTone = status === 'failed' ? 'failed' : null;
  const statusLabel = status === 'failed' ? 'Failed' : null;
  const accessibleStatus =
    status === 'drafting' ? 'Drafting'
    : status === 'ready' ? 'Ready'
    : status === 'running' ? 'Running'
    : status === 'failed' ? 'Failed'
    : 'Completed';
  const collapsedSummaryModel = summaryModel ?? buildToolCallHeaderSummaryModel(name, summary, summaryPath);
  // Hide the header summary while the tool body is already visible (e.g.
  // shell tools that auto-expand while running). The body renders its own
  // command line / details, so showing the summary in the header duplicates it.
  const showSummary = !bodyVisible && !open && !!collapsedSummaryModel;
  const showSizeHint = !open && !!sizeHint;
  const durationLabel =
    status !== 'running' && typeof durationMs === 'number' && durationMs >= 0
      ? formatDuration(durationMs)
      : null;

  // The entire header row is one expand/collapse hitbox: a single
  // role=button spanning the full card width with a clear hover/focus
  // affordance (see `.tool-call-header` in tool-call.css) and a compact
  // min-height so it is easy to hit without dominating the card. Its `title`
  // flips to "Collapse"/"Expand" so the click intent is obvious — this is the
  // TOP close target; the trailing `CollapsibleChevron` is the SIDE target,
  // and the `CollapsibleCloseFooter` at the bottom of the body is the BOTTOM
  // target. The header is non-sticky (it used to pin and read as a detaching
  // bar); the footer keeps the close reachable in a tall body. The StatusChip
  // (copy-error) and ClickablePathButton (open file) live *inside* the toggle
  // but stop propagation, so they keep their own behaviour without collapsing
  // the card.
  return (
    <div
      class="tool-call-header flex w-full min-h-[26px] cursor-pointer select-none items-center gap-1.5 px-2 py-[3px]"
      role="button"
      aria-expanded={open}
      aria-controls={ariaControls}
      aria-label={`${name} tool call, ${accessibleStatus}. ${open ? 'Collapse' : 'Expand'} details`}
      title={open ? 'Collapse' : 'Expand'}
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
    >
      <div class={cx('flex min-w-0 flex-1 items-center', (showSummary || showSizeHint) ? 'gap-1.5' : 'gap-2')}>
        <span class="transcript-header-title-mono min-w-0 flex-[0_1_auto] truncate" title={nameTitle}>{name}</span>
        {showSummary && collapsedSummaryModel ? (
          <CollapsedSummary model={collapsedSummaryModel} summaryPath={summaryPath} parentDepth={prefs.uiPathParentDepth} onOpenFile={onOpenFile} />
        ) : null}
        {showSizeHint && <span class="ml-auto block min-w-0 max-w-[var(--tool-call-size-column-width)] flex-[0_0_var(--tool-call-size-column-width)] truncate text-right font-mono text-[10px] text-muted/50">{sizeHint}</span>}
      </div>
      {pruningBadge && <ToolResultPruningBadge badge={pruningBadge} />}
      {durationLabel && <span class="ml-auto flex-none whitespace-nowrap font-mono text-[10px] text-muted/60 [font-variant-numeric:tabular-nums]" title="Tool execution time">{durationLabel}</span>}
      {status !== 'failed' && <ToolCallStatusGlyph status={status} />}
      {statusTone && statusLabel && (
        <StatusChip
          tone={statusTone}
          label={statusLabel}
          className="status-chip-fixed"
          copyText={errorDetail}
          copyAriaLabel={errorDetail ? 'Copy tool-call error detail' : undefined}
        />
      )}
      <CollapsibleChevron open={open} class="ml-0.5 shrink-0" />
    </div>
  );
}
