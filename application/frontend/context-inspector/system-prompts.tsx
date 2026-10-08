/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState, useMemo } from 'preact/hooks';

import type { SystemPromptEntry } from '../../lib/protocol/index.js';
import { renderMarkdown, reasoningSummary } from '../transcript/markdown';
import { Collapsible } from '../lib/components/collapsible';
import {
  estimateSystemPromptTokens,
  formatSystemPromptTokenLabel,
  getSystemPromptTokenEstimateTitle,
} from './system-prompt-tokens';

interface SystemPromptCardProps {
  prompt: SystemPromptEntry;
}

function getCollapsedSummary(prompt: SystemPromptEntry): string {
  const summary = prompt.summary || reasoningSummary(prompt.text);
  if (!summary) {
    return '';
  }

  // Hide placeholder summaries that carry no real information (e.g. a provider
  // entry before its provider has been resolved). A resolved provider name is
  // a meaningful summary and should surface on the collapsed card.
  if (prompt.availability !== 'available' && /^(unknown|unavailable|none configured)$/i.test(summary)) {
    return '';
  }

  return summary;
}

function SystemPromptCard({ prompt }: SystemPromptCardProps) {
  const [open, setOpen] = useState(false);
  const summary = getCollapsedSummary(prompt);
  const html = useMemo(() => (open ? renderMarkdown(prompt.text, true, false) : ''), [open, prompt.text]);
  const showSummary = !!summary;

  return (
    <Collapsible
      open={open}
      onToggle={setOpen}
      ariaLabel={`Toggle system prompt: ${prompt.title}`}
      class="system-prompt-card"
      headerClass="system-prompt-card-header"
      bodyClass="system-prompt-card-body"
      closeFooter={false}
      header={
        <>
          <span class="system-prompt-title" title={prompt.title}>{prompt.title}</span>
          {showSummary && (
            <span class="system-prompt-summary" title={summary}>{summary}</span>
          )}
        </>
      }
    >
      <div
        class="message-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </Collapsible>
  );
}

interface SystemPromptMessageProps {
  prompts: SystemPromptEntry[];
}

export function SystemPromptMessage({ prompts }: SystemPromptMessageProps) {
  // Hide entries the user has toggled off — they're also stripped from the
  // prompt sent to the model, so they shouldn't appear in the transcript.
  const [groupOpen, setGroupOpen] = useState(false);
  const visiblePrompts = prompts.filter((p) => !p.disabled);
  if (visiblePrompts.length === 0) {
    return null;
  }

  const estimatedTokenCount = estimateSystemPromptTokens(visiblePrompts);
  const tokenLabel = estimatedTokenCount > 0
    ? formatSystemPromptTokenLabel(estimatedTokenCount)
    : null;
  const tokenTitle = tokenLabel
    ? getSystemPromptTokenEstimateTitle(visiblePrompts)
    : undefined;

  const label = visiblePrompts.length === 1
    ? `1 system prompt`
    : `${visiblePrompts.length} system prompts`;

  return (
    <Collapsible
      open={groupOpen}
      onToggle={setGroupOpen}
      ariaLabel={`Toggle system prompts group: ${label}${tokenLabel ? `, ${tokenLabel}` : ''}`}
      class="system-prompts"
      headerClass="system-prompts-header"
      bodyClass="system-prompts-body"
      closeFooter={false}
      dataAttrs={{ 'data-role': 'system', 'data-scroll-anchor-id': 'system-prompts' }}
      header={
        <>
          <span class="system-prompts-label">System prompts</span>
          <span class="system-prompts-context">
            <span class="system-prompts-meta" title={label}>{visiblePrompts.length} {visiblePrompts.length === 1 ? 'entry' : 'entries'}</span>
            {tokenLabel && <span class="system-prompts-meta system-prompts-tokens" title={tokenTitle}>{tokenLabel}</span>}
          </span>
        </>
      }
    >
      {visiblePrompts.map((prompt) => (
        <SystemPromptCard
          key={`${prompt.source}:${prompt.title}`}
          prompt={prompt}
        />
      ))}
    </Collapsible>
  );
}