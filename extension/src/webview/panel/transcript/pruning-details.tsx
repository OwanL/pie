/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState } from 'preact/hooks';

import type { PruningDetails } from '../../../shared/protocol';
import { pruningTotals } from './pruning';
import { Collapsible } from '../components/collapsible';
import { ResizablePre } from '../components/resizable-pre';
import { highlightToolResultText } from './highlight';
import { cx } from '../utils/cx';
import { formatTokens } from '../utils/format-tokens';

interface PruningDiagnosticsProps {
  details: PruningDetails;
  rawExpanded: boolean;
  onRawToggle: () => void;
  presentation: 'panel' | 'inline';
}

function diagnosticText(value: string | undefined, emptyLabel: string): string {
  return value && value.trim().length > 0 ? value : emptyLabel;
}

function modeLabel(mode: PruningDetails['mode']): string {
  switch (mode) {
    case 'shadow':
      return 'Shadow';
    case 'off':
      return 'Off';
    case 'custom':
      return 'Custom';
    case 'auto':
    default:
      return 'Auto';
  }
}

/** "model · thinking-level · latency" — the prepass provenance line. */
function prepassLabel(details: PruningDetails): string | null {
  const parts: string[] = [];
  if (details.prepassModel) parts.push(details.prepassModel);
  if (details.prepassThinkingLevel && details.prepassThinkingLevel !== 'off') {
    parts.push(details.prepassThinkingLevel);
  }
  if (details.prepassLatencyMs != null) {
    parts.push(`${details.prepassLatencyMs}ms`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** A labelled raw <pre> block (system/user prompt or raw LLM output). */
function RawBlock({ label, children }: { label: string; children: string }) {
  return (
    <div class="pruning-raw-block">
      <span class="pruning-raw-label">{label}</span>
      <ResizablePre class="pruning-raw-pre hljs-scope" minHeight={80}>
        <code class="hljs" dangerouslySetInnerHTML={{ __html: highlightToolResultText(children) }} />
      </ResizablePre>
    </div>
  );
}

interface CategoryProps {
  title: string;
  kept: number;
  total: number;
  included: readonly string[];
  excluded: readonly string[];
}

/** A Skills/Tools section: a count sub-header followed by kept (accent) and
 *  pruned (struck, muted) name tags. Tags wrap; kept precede pruned so the
 *  surviving catalog reads first. */
function PruningCategory({ title, kept, total, included, excluded }: CategoryProps) {
  return (
    <div class="pruning-category">
      <div class="pruning-category-header">
        <span class="pruning-category-title">{title}</span>
        <span class="pruning-category-count">kept {kept} of {total}</span>
      </div>
      <div class="pruning-tag-list">
        {included.map((name) => (
          <span class="pruning-tag pruning-tag-kept" title={`Kept · ${name}`}>{name}</span>
        ))}
        {excluded.map((name) => (
          <span class="pruning-tag pruning-tag-pruned" title={`Pruned · ${name}`}>{name}</span>
        ))}
      </div>
    </div>
  );
}

function PruningDiagnosticsContent({ details, rawExpanded, onRawToggle }: Omit<PruningDiagnosticsProps, 'presentation'>) {
  const failed = !!details.prepassError;
  const totals = pruningTotals(details);
  const prepass = prepassLabel(details);
  const [reasoningOpen, setReasoningOpen] = useState(false);

  const showSkills = totals.skillsTotal > 0 || details.excludedSkills.length > 0;
  const showTools = totals.toolsTotal > 0 || details.excludedTools.length > 0;

  return (
    <div class="pruning-detail-list">
      {failed && (
        <div class="pruning-banner pruning-banner-danger" role="alert">
          <span class="pruning-banner-icon" aria-hidden="true">⚠</span>
          <span class="pruning-banner-text">{details.prepassError}</span>
        </div>
      )}

      <div class="pruning-stat-row">
        {totals.skillsTotal > 0 && (
          <div class="pruning-stat-tile">
            <span class="pruning-stat-value">{`${totals.skillsKept}/${totals.skillsTotal}`}</span>
            <span class="pruning-stat-label">skills</span>
          </div>
        )}
        {totals.toolsTotal > 0 && (
          <div class="pruning-stat-tile">
            <span class="pruning-stat-value">{`${totals.toolsKept}/${totals.toolsTotal}`}</span>
            <span class="pruning-stat-label">tools</span>
          </div>
        )}
        {totals.tokensSaved > 0 && (
          <div class="pruning-stat-tile pruning-stat-tile-accent">
            <span class="pruning-stat-value">{`✂ ${formatTokens(totals.tokensSaved)}`}</span>
            <span class="pruning-stat-label">tokens saved</span>
          </div>
        )}
        <div class="pruning-meta">
          {prepass && <div class="pruning-meta-line">{prepass}</div>}
          <span class={cx('pruning-mode-badge', `pruning-mode-${details.mode}`)}>{modeLabel(details.mode)}</span>
        </div>
      </div>

      {showSkills && (
        <PruningCategory
          title="Skills"
          kept={totals.skillsKept}
          total={totals.skillsTotal}
          included={details.includedSkills}
          excluded={details.excludedSkills}
        />
      )}
      {showTools && (
        <PruningCategory
          title="Tools"
          kept={totals.toolsKept}
          total={totals.toolsTotal}
          included={details.includedTools}
          excluded={details.excludedTools}
        />
      )}

      {details.prepassSafeguardReason && (
        <div class="pruning-banner pruning-banner-warning">
          <span class="pruning-banner-icon" aria-hidden="true">⚠</span>
          <span class="pruning-banner-text">Keep-all safeguard — {details.prepassSafeguardReason}</span>
        </div>
      )}

      <Collapsible
        open={reasoningOpen}
        onToggle={(open: boolean) => setReasoningOpen(open)}
        ariaLabel="Toggle pruning prepass reasoning"
        class="pruning-sub-collapsible"
        headerClass="pruning-sub-header"
        bodyClass="pruning-sub-body"
        closeFooter={false}
        header={<span>Reasoning</span>}
      >
        <ResizablePre class="pruning-raw-pre hljs-scope" minHeight={80}>
          <code class="hljs" dangerouslySetInnerHTML={{ __html: highlightToolResultText(diagnosticText(details.prepassThinking, '∅ No reasoning returned')) }} />
        </ResizablePre>
      </Collapsible>

      <Collapsible
        open={rawExpanded}
        onToggle={() => onRawToggle()}
        ariaLabel="Toggle prepass prompts and output"
        class="pruning-sub-collapsible"
        headerClass="pruning-sub-header"
        bodyClass="pruning-sub-body"
        closeFooter={false}
        header={<span>Prepass prompts and output</span>}
      >
        <RawBlock label="System prompt">{diagnosticText(details.prepassSystemPrompt, '∅ No system prompt captured')}</RawBlock>
        <RawBlock label="User prompt">{diagnosticText(details.prepassUserMessage, '∅ No user prompt captured')}</RawBlock>
        <RawBlock label="Raw LLM output">{diagnosticText(details.prepassResponse, '∅ Empty response')}</RawBlock>
      </Collapsible>
    </div>
  );
}

export function PruningDiagnostics({ details, rawExpanded, onRawToggle, presentation }: PruningDiagnosticsProps) {
  if (presentation === 'panel') {
    return (
      <div
        class={`pruning-diagnostics-panel${details.prepassError ? ' failed' : ''}`}
        role="region"
        aria-label="Pruning details"
      >
        <PruningDiagnosticsContent details={details} rawExpanded={rawExpanded} onRawToggle={onRawToggle} />
      </div>
    );
  }

  return (
    <div class="pruning-diagnostics-inline">
      <PruningDiagnosticsContent details={details} rawExpanded={rawExpanded} onRawToggle={onRawToggle} />
    </div>
  );
}
