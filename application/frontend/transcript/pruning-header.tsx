/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import type { PruningDetails } from '../../lib/protocol/index.js';
import { PruningHeaderChipControl } from '../lib/components/panel-chip';
import { CollapsibleChevron } from '../lib/components/chevron';
import { AGENT_ACTIVITY_LABELS } from './activity';
import { PruningDiagnostics } from './pruning-details';
import { formatPruningSummary, pruningSavingsLabel, pruningTotals, type PruningHeaderState } from './pruning';
import { formatCompactTokens } from '../lib/formatting/format-tokens';

interface PruningHeaderChipProps {
  state: PruningHeaderState;
  expanded: boolean;
  onToggle: (event: JSX.TargetedMouseEvent<HTMLButtonElement>) => void;
  onCancel?: () => void;
}

interface PruningHeaderButtonProps {
  details: PruningDetails;
  expanded: boolean;
  fallbackText?: string;
  onToggle: (event: JSX.TargetedMouseEvent<HTMLButtonElement>) => void;
}

interface PruningHeaderPanelProps {
  details: PruningDetails;
  rawExpanded: boolean;
  onRawToggle: () => void;
}

function formatPruningChipLabel(details: PruningDetails, fallbackText?: string): string {
  if (details.prepassError) return 'Pruning failed';

  // Shadow mode evaluated but did not prune the request: label the figure
  // potential savings instead of claiming tokens were saved.
  const { tokensSaved } = pruningTotals(details);
  return pruningSavingsLabel(tokensSaved, details.mode, formatCompactTokens)
    || (fallbackText?.trim() ? fallbackText : '');
}

function PendingPruningHeader({ state, onCancel }: {
  state: Extract<PruningHeaderState, { kind: 'pending' }>;
  onCancel?: () => void;
}) {
  const startedAt = typeof state.prepassStartedAt === 'number' && Number.isFinite(state.prepassStartedAt)
    ? state.prepassStartedAt : null;
  const [now, setNow] = useState(() => Date.now());
  // The host owns the start time. Remounting a virtual row must not restart
  // the clock, and missing timing must not manufacture an elapsed value.
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  const seconds = startedAt === null ? null : Math.floor(Math.max(0, now - startedAt) / 1000);
  const elapsed = seconds === null ? null : seconds < 60
    ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const label = state.label.trim() || AGENT_ACTIVITY_LABELS.pruning;

  return (
    <PruningHeaderChipControl
      pending
      ariaLabel={label}
      title={elapsed ? `${label} · ${elapsed} elapsed` : label}
      label={(
        <span class="pruning-header-progress">
          <span class="pruning-header-active-marker" aria-hidden="true" />
          <span class="pruning-header-label">Prepass</span>
          {elapsed && <span class="pruning-header-elapsed" aria-hidden="true">{elapsed}</span>}
        </span>
      )}
      onCancel={onCancel}
    />
  );
}

export function PruningHeaderChip({ state, expanded, onToggle, onCancel }: PruningHeaderChipProps) {
  if (state.kind === 'pending') {
    return <PendingPruningHeader state={state} onCancel={onCancel} />;
  }

  return (
    <PruningHeaderButton
      details={state.details}
      expanded={expanded}
      fallbackText={state.fallbackText}
      onToggle={onToggle}
    />
  );
}

export function PruningHeaderButton({ details, expanded, fallbackText, onToggle }: PruningHeaderButtonProps) {
  const summary = formatPruningSummary(details, fallbackText);
  const chipLabel = formatPruningChipLabel(details, fallbackText);
  const failed = !!details.prepassError;

  return (
    <PruningHeaderChipControl
      failed={failed}
      expanded={expanded}
      ariaLabel={failed ? `Pruning failed: ${details.prepassError}` : summary}
      title={failed && details.prepassError ? details.prepassError : summary}
      onClick={onToggle}
      leading={failed ? '⚠' : <span class="pruning-header-label">Prepass</span>}
      label={failed ? 'Prepass failed' : chipLabel ? ` ${chipLabel}` : ''}
      trailing={<CollapsibleChevron open={expanded} size={9} />}
    />
  );
}

export function PruningHeaderPanel({ details, rawExpanded, onRawToggle }: PruningHeaderPanelProps) {
  return (
    <PruningDiagnostics
      details={details}
      rawExpanded={rawExpanded}
      onRawToggle={onRawToggle}
      presentation="panel"
    />
  );
}
