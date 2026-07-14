/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { JSX } from 'preact';

import type { PruningDetails } from '../../../shared/protocol';
import { PruningHeaderChipControl } from '../components/panel-chip';
import { CollapsibleChevron } from '../components/chevron';
import { AGENT_ACTIVITY_LABELS } from './activity';
import { AgentActivityLabel } from './activity-label';
import { PruningDiagnostics } from './pruning-details';
import { formatPruningSummary, pruningTotals, type PruningHeaderState } from './pruning';

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

  const { skillsKept, skillsTotal, toolsKept, toolsTotal, tokensSaved } = pruningTotals(details);
  const parts: string[] = [];
  if (skillsTotal > 0) parts.push(`${skillsKept}/${skillsTotal} skills`);
  if (toolsTotal > 0) parts.push(`${toolsKept}/${toolsTotal} tools`);
  if (parts.length > 0) parts.push(`✂ ${tokensSaved}`);

  return parts.length > 0 ? parts.join(' · ') : fallbackText || 'Pruning complete';
}

export function PruningHeaderChip({ state, expanded, onToggle, onCancel }: PruningHeaderChipProps) {
  if (state.kind === 'pending') {
    const label = state.label.trim().length > 0 ? state.label : AGENT_ACTIVITY_LABELS.pruning;

    return (
      <PruningHeaderChipControl
        pending
        ariaLabel={label}
        title={label}
        label={<AgentActivityLabel label={label} />}
        onCancel={onCancel}
      />
    );
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
      leading={failed ? '⚠' : undefined}
      label={chipLabel}
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
