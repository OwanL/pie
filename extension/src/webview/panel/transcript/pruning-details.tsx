/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { JSX } from 'preact';

import type { PruningDetails } from '../../../shared/protocol';
import { pruningTotals } from './pruning';
import { Collapsible } from '../components/collapsible';
import { ResizablePre } from '../components/resizable-pre';
import { highlightToolResultText } from './highlight';

interface PruningDiagnosticsProps {
  details: PruningDetails;
  rawExpanded: boolean;
  onRawToggle: () => void;
  presentation: 'panel' | 'inline';
}

function diagnosticText(value: string | undefined, emptyLabel: string): string {
  return value && value.trim().length > 0 ? value : emptyLabel;
}

function listText(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : 'None';
}

function modeLabel(mode: PruningDetails['mode']): string {
  switch (mode) {
    case 'shadow':
      return 'Shadow (measured only)';
    case 'off':
      return 'Off';
    case 'auto':
    default:
      return 'Auto';
  }
}

function tokenBreakdown(details: PruningDetails): string | null {
  const skillTokens = details.skillTokensSaved ?? 0;
  const toolTokens = details.toolTokensSaved ?? 0;
  const total = skillTokens + toolTokens;
  if (total <= 0) return null;

  const parts: string[] = [];
  if (skillTokens > 0) parts.push(`skills ${skillTokens} tokens`);
  if (toolTokens > 0) parts.push(`tools ${toolTokens} tokens`);
  parts.push(`total ${total} tokens`);
  return parts.join(' · ');
}

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

function DetailRow({ label, children, danger = false }: { label: string; children: JSX.Element | string | null; danger?: boolean }) {
  return (
    <div class="pruning-detail-row">
      <span class="pruning-detail-hint">{label}</span>
      <span class={`pruning-detail-text${danger ? ' pruning-detail-text-danger' : ''}`}>{children}</span>
    </div>
  );
}

function RawBlock({ label, children }: { label: string; children: string }) {
  return (
    <div class="pruning-raw-block">
      <span class="pruning-detail-hint">{label}</span>
      <ResizablePre class="pruning-raw-pre hljs-scope" minHeight={80}>
        <code class="hljs" dangerouslySetInnerHTML={{ __html: highlightToolResultText(children) }} />
      </ResizablePre>
    </div>
  );
}

function PruningDiagnosticsContent({ details, rawExpanded, onRawToggle }: Omit<PruningDiagnosticsProps, 'presentation'>) {
  const failed = !!details.prepassError;
  const totals = pruningTotals(details);
  const savedText = tokenBreakdown(details);
  const prepass = prepassLabel(details);

  return (
    <div class="pruning-detail-list">
      {failed && <DetailRow label="Error" danger>{details.prepassError ?? null}</DetailRow>}
      {prepass && <DetailRow label="Prepass">{prepass}</DetailRow>}
      <DetailRow label="Mode">{modeLabel(details.mode)}</DetailRow>
      {savedText && <DetailRow label="Saved">{savedText}</DetailRow>}
      {(totals.skillsTotal > 0 || details.excludedSkills.length > 0) && (
        <>
          <DetailRow label="Skills pruned">{listText(details.excludedSkills)}</DetailRow>
          <DetailRow label="Skills kept">{listText(details.includedSkills)}</DetailRow>
        </>
      )}
      {(totals.toolsTotal > 0 || details.excludedTools.length > 0) && (
        <>
          <DetailRow label="Tools pruned">{listText(details.excludedTools)}</DetailRow>
          <DetailRow label="Tools kept">{listText(details.includedTools)}</DetailRow>
        </>
      )}
      {details.prepassSafeguardReason && <DetailRow label="Keep-all safeguard">{details.prepassSafeguardReason}</DetailRow>}
      <div class="pruning-detail-row">
        <span class="pruning-detail-hint">Reasoning</span>
        <ResizablePre class="pruning-raw-pre hljs-scope" minHeight={80}>
          <code class="hljs" dangerouslySetInnerHTML={{ __html: highlightToolResultText(diagnosticText(details.prepassThinking, '∅ No reasoning returned')) }} />
        </ResizablePre>
      </div>
      <div class="pruning-raw-toggle">
        <Collapsible
          open={rawExpanded}
          onToggle={() => onRawToggle()}
          ariaLabel="Toggle prepass prompts and output"
          class="pruning-raw-toggle-collapsible"
          headerClass="pruning-raw-toggle-button"
          bodyClass="pruning-raw-content"
          closeFooter={false}
          header={<span>Prepass prompts and output</span>}
        >
          <RawBlock label="System prompt">{diagnosticText(details.prepassSystemPrompt, '∅ No system prompt captured')}</RawBlock>
          <RawBlock label="User prompt">{diagnosticText(details.prepassUserMessage, '∅ No user prompt captured')}</RawBlock>
          <RawBlock label="Raw LLM output">{diagnosticText(details.prepassResponse, '∅ Empty response')}</RawBlock>
        </Collapsible>
      </div>
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
