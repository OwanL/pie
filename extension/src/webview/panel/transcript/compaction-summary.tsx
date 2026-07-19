/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useMemo, useState } from 'preact/hooks';

import type { CompactionSummaryDetails } from '../../../shared/protocol';
import { Collapsible } from '../components/collapsible';
import { formatDuration, formatThinkingLevelLabel } from './header';
import { renderMarkdown } from '../markdown';
import { formatTokens } from '../utils/format-tokens';
import { normalizeThinkingLevel } from '../../../shared/thinking-level.js';

interface CompactionSummaryProps {
  summary: string;
  /** Durable metrics scanned from the `pie.compaction-metrics` sidecar.
   *  Absent for legacy/malformed sidecars (and for sessions compacted before
   *  the sidecar existed) — the card then renders the summary markdown only. */
  details?: CompactionSummaryDetails;
}

/** Human-readable label for a compaction `reason`. Returns the raw value when
 *  it is not one of the known reasons (so a future SDK reason still surfaces). */
function reasonLabel(reason: string | undefined): string | null {
  if (!reason) return null;
  switch (reason) {
    case 'manual':
      return 'Manual';
    case 'threshold':
      return 'Threshold';
    case 'overflow':
      return 'Overflow';
    default:
      return reason;
  }
}

/** Absolute token reduction, or `undefined` when either side is missing. */
function tokenReduction(details: CompactionSummaryDetails): number | undefined {
  if (details.tokensBefore === undefined || details.estimatedTokensAfter === undefined) {
    return undefined;
  }
  return Math.max(0, details.tokensBefore - details.estimatedTokensAfter);
}

/** Percentage reduction (0–100), or `undefined` when not computable. */
function tokenReductionPercent(details: CompactionSummaryDetails): number | undefined {
  const reduction = tokenReduction(details);
  if (reduction === undefined || details.tokensBefore === undefined || details.tokensBefore <= 0) {
    return undefined;
  }
  return Math.min(100, Math.max(0, (reduction / details.tokensBefore) * 100));
}

/** "before → after" with optional `(-reduction, -pct%)` suffix. Returns `null`
 *  when neither token field is present (nothing to show). */
function tokenRange(details: CompactionSummaryDetails): string | null {
  const before = details.tokensBefore;
  const after = details.estimatedTokensAfter;
  if (before === undefined && after === undefined) return null;

  const fmt = (value: number | undefined): string =>
    value === undefined ? '—' : formatTokens(value);

  const reduction = tokenReduction(details);
  const pct = tokenReductionPercent(details);
  if (reduction !== undefined && pct !== undefined) {
    return `${fmt(before)} → ${fmt(after)}  (-${formatTokens(reduction)}, ${pct.toFixed(0)}%)`;
  }
  return `${fmt(before)} → ${fmt(after)}`;
}

/** "model · thinking" provenance line, when either is present. */
function modelLine(details: CompactionSummaryDetails): string | null {
  const parts: string[] = [];
  if (details.modelId) parts.push(details.modelId);
  const thinking = formatThinkingLevelLabel(normalizeThinkingLevel(details.thinkingLevel));
  if (thinking) parts.push(thinking);
  if (details.provider) parts.push(details.provider);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * The SDK persists history compaction as an entry rather than an ordinary chat
 * message. Keep its (often long) replacement context available in the
 * transcript without making it dominate the conversation by default.
 *
 * When durable metrics are available (scanned from the `pie.compaction-metrics`
 * sidecar), the collapsed header surfaces a compact one-line summary: reason,
 * before→after tokens (with absolute + percentage reduction when computable),
 * model/thinking provenance, and duration. The full replacement-context
 * markdown stays lazy — `renderMarkdown` only runs when the card is expanded.
 */
export function CompactionSummary({ summary, details }: CompactionSummaryProps) {
  const [open, setOpen] = useState(false);
  const html = useMemo(() => (open ? renderMarkdown(summary) : ''), [open, summary]);

  const reason = details ? reasonLabel(details.reason) : null;
  const tokens = details ? tokenRange(details) : null;
  const model = details ? modelLine(details) : null;
  const duration = details?.durationMs !== undefined ? formatDuration(details.durationMs) : null;
  const metaParts = [reason, tokens, model, duration].filter((value): value is string => Boolean(value));
  const hasMeta = metaParts.length > 0;

  return (
    <Collapsible
      open={open}
      onToggle={setOpen}
      ariaLabel="Toggle compaction summary"
      class="compaction-summary-card"
      headerClass="px-2 py-[5px]"
      bodyClass="px-2.5 pb-2.5 pt-1 leading-relaxed text-foreground"
      header={
        <div class="compaction-summary-header">
          <span class="transcript-header-label">Compaction summary</span>
          {hasMeta && (
            <span class="compaction-summary-meta">
              {metaParts.map((part, index) => (
                <span key={index} class="compaction-summary-meta-item">{part}</span>
              ))}
            </span>
          )}
        </div>
      }
    >
      <div class="message-body" dangerouslySetInnerHTML={{ __html: html }} />
    </Collapsible>
  );
}
