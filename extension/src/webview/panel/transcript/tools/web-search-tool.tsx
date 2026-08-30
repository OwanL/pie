/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChild } from 'preact';

import type { ChatPrefs, ToolCall } from '../../../../shared/protocol';
import { renderMarkdown } from '../../markdown';
import { getToolCallContextType } from '../../chat-prefs';
import { cx } from '../../utils/cx';
import { toMouseEvent } from '../../utils/preact-events';
import {
  formatValueAsHighlightedYaml,
  textFromToolResult,
} from '../highlight';
import {
  formatToolCallResultForDisplay,
  ToolCallCard,
  ToolCallHeader,
  TOOL_CALL_COMPLETION_PULSE_MS,
  type ToolCallHeaderSummaryModel,
} from '../tool-call-card';
import { registerToolRenderer, type ToolRendererProps } from '../registry';
import { toolDisclosureKey, useCollapsibleOpen } from '../use-collapsible-open';
import { deriveToolTail } from '../activity-tail';
import { TurnActivityTailBody } from '../activity-tail-preview';
import type { TranscriptContextMenuHandler } from '../types';

// ─── Input type ──────────────────────────────────────────────────────────────
// web_search accepts either a single `query` string or a `queries` array,
// plus optional tuning knobs (numResults, provider, recency, domains, …).

interface ParsedWebSearchInput {
  queries: string[];
  numResults?: number;
  includeContent?: boolean;
  recencyFilter?: string;
  domainFilter?: string[];
  providers?: string[];
  workflow?: string;
  usesProxy?: boolean;
}

/** Mirror pi-web-access 0.27's recovery for models that serialize a query array
 * into the singular `query` field. Ordinary strings remain one query. */
function expandQueryInput(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [query];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) && parsed.every((entry): entry is string => typeof entry === 'string')
      ? parsed
      : [query];
  } catch {
    return [query];
  }
}

function parseWebSearchInput(input: unknown): ParsedWebSearchInput | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;

  const rawQueries = Array.isArray(obj.queries)
    ? obj.queries
    : typeof obj.query === 'string'
      ? expandQueryInput(obj.query)
      : null;
  if (!rawQueries) return null;

  const queries = rawQueries
    .filter((q): q is string => typeof q === 'string')
    .map((q) => q.trim())
    .filter((q) => q.length > 0);
  if (queries.length === 0) return null;

  const domainFilter = Array.isArray(obj.domainFilter)
    ? obj.domainFilter.filter((d): d is string => typeof d === 'string')
    : undefined;
  const providers = (Array.isArray(obj.provider) ? obj.provider : [obj.provider])
    .filter((provider): provider is string => typeof provider === 'string')
    .map((provider) => provider.trim())
    .filter((provider) => provider.length > 0);

  return {
    queries,
    ...(typeof obj.numResults === 'number' ? { numResults: obj.numResults } : {}),
    ...(obj.includeContent === true ? { includeContent: true } : {}),
    ...(typeof obj.recencyFilter === 'string' ? { recencyFilter: obj.recencyFilter } : {}),
    ...(domainFilter && domainFilter.length > 0 ? { domainFilter } : {}),
    ...(providers.length > 0 ? { providers } : {}),
    ...(typeof obj.workflow === 'string' ? { workflow: obj.workflow } : {}),
    ...(typeof obj.proxy === 'string' && obj.proxy.trim().length > 0 ? { usesProxy: true } : {}),
  };
}

// ─── Header summary ──────────────────────────────────────────────────────────
// The generic renderer dumps the first query at up to 300 chars, which is hard
// to scan. Show a tighter preview: the first query clipped short, with a count
// suffix when there are several so the user knows more searches are in flight.

const HEADER_SUMMARY_SINGLE_MAX = 160;
const HEADER_SUMMARY_MULTI_MAX = 100;

function truncateForHeader(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3).trimEnd()}...`
    : normalized;
}

function buildHeaderSummary(parsed: ParsedWebSearchInput): string {
  const first = parsed.queries[0];
  if (parsed.queries.length === 1) {
    return truncateForHeader(first, HEADER_SUMMARY_SINGLE_MAX);
  }
  const extra = parsed.queries.length - 1;
  return `${truncateForHeader(first, HEADER_SUMMARY_MULTI_MAX)} +${extra} more`;
}

// ─── Options chips ───────────────────────────────────────────────────────────
// Compact metadata line: only non-default / informative knobs, so the queries
// stay the focus and the card doesn't fill with boilerplate.

function buildOptionChips(parsed: ParsedWebSearchInput): string[] {
  const chips: string[] = [];
  if (parsed.numResults != null) chips.push(`${parsed.numResults} results`);
  if (parsed.providers && !(parsed.providers.length === 1 && parsed.providers[0] === 'auto')) {
    chips.push(`${parsed.providers.length === 1 ? 'provider' : 'providers'}: ${parsed.providers.join(', ')}`);
  }
  if (parsed.recencyFilter) chips.push(`recency: ${parsed.recencyFilter}`);
  if (parsed.workflow && parsed.workflow !== 'none') chips.push(`workflow: ${parsed.workflow}`);
  if (parsed.includeContent) chips.push('fetch content');
  if (parsed.usesProxy) chips.push('proxy');
  if (parsed.domainFilter && parsed.domainFilter.length > 0) {
    chips.push(`domains: ${parsed.domainFilter.join(' ')}`);
  }
  return chips;
}

// ─── Body ────────────────────────────────────────────────────────────────────

interface WebSearchBodyProps {
  toolCall: ToolCall;
  parsed: ParsedWebSearchInput;
}

function WebSearchBody({ toolCall, parsed }: WebSearchBodyProps) {
  const isRunning = toolCall.status === 'running';
  const resultText = textFromToolResult(toolCall.result);
  const hasResultText = resultText !== undefined;
  const multiple = parsed.queries.length > 1;
  const optionChips = buildOptionChips(parsed);

  // Render the synthesised answer as wrapped markdown prose once the call has
  // settled (clickable citation links, lists, headings). While streaming we
  // keep it as cheap plain text so a long answer doesn't re-run marked.parse
  // on every delta; it settles into formatted prose on completion.
  const resultHtml = useMemo(
    () => (!isRunning && resultText !== undefined ? renderMarkdown(resultText, true, false) : ''),
    [isRunning, resultText],
  );

  let resultBlock: ComponentChild | null = null;
  if (hasResultText) {
    if (isRunning) {
      resultBlock = (
        <div class="web-search-result web-search-result-streaming">{resultText}</div>
      );
    } else {
      resultBlock = (
        <div
          class="web-search-result message-body"
          dangerouslySetInnerHTML={{ __html: resultHtml }}
        />
      );
    }
  } else if (toolCall.result !== undefined) {
    // Object-shaped result we couldn't extract text from — fall back to YAML.
    resultBlock = (
      <pre class="tool-call-pre tool-call-pre-resizable hljs-scope">
        <code
          class="hljs language-yaml"
          dangerouslySetInnerHTML={{ __html: formatValueAsHighlightedYaml(toolCall.result) }}
        />
      </pre>
    );
  } else if (isRunning) {
    resultBlock = <div class="web-search-pending">Searching the web…</div>;
  }

  const resultLabel = isRunning && !hasResultText && toolCall.result === undefined
    ? 'Searching'
    : 'Result';

  return (
    <div class="tool-call-body" onClick={(e) => e.stopPropagation()}>
      <div class="tool-call-section">
        <div class="tool-call-section-label">
          {multiple ? `Queries · ${parsed.queries.length}` : 'Query'}
        </div>
        <ul class="web-search-queries">
          {parsed.queries.map((query, index) => (
            <li class="web-search-query" key={index}>
              {multiple && <span class="web-search-query-index">{index + 1}</span>}
              <span class="web-search-query-text">{query}</span>
            </li>
          ))}
        </ul>
        {optionChips.length > 0 && (
          <div class="web-search-options">
            {optionChips.map((chip) => (
              <span class="web-search-option" key={chip}>{chip}</span>
            ))}
          </div>
        )}
      </div>
      {resultBlock && (
        <div class="tool-call-section">
          <div class="tool-call-section-label">{resultLabel}</div>
          {resultBlock}
        </div>
      )}
    </div>
  );
}

// ─── Card ────────────────────────────────────────────────────────────────────

interface WebSearchCardProps {
  toolCall: ToolCall;
  parsed: ParsedWebSearchInput;
  prefs: ChatPrefs;
  onOpenFile: (path: string) => void;
  onContextMenu: TranscriptContextMenuHandler;
}

function WebSearchCard({
  toolCall,
  parsed,
  prefs,
  onOpenFile,
  onContextMenu,
}: WebSearchCardProps) {
  const [open, setOpen] = useCollapsibleOpen(toolDisclosureKey(toolCall.id), prefs.autoExpandToolCalls);
  const contextType = getToolCallContextType('web_search');
  const handleContextMenu = (e: MouseEvent) =>
    onContextMenu(contextType, JSON.stringify(toolCall, null, 2), e);

  // Brief success-tinted ring flash on completion — parity with the generic
  // ToolCallCard so a web_search card doesn't read as the only tool that
  // silently settles. CSS lives on `.tool-call-just-completed` (tool-call.css).
  const [justCompleted, setJustCompleted] = useState(false);
  const prevRunningRef = useRef(false);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    const nowRunning = toolCall.status === 'running';
    prevRunningRef.current = nowRunning;
    if (wasRunning && !nowRunning && toolCall.status === 'completed') {
      setJustCompleted(true);
      if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
      pulseTimerRef.current = setTimeout(() => {
        pulseTimerRef.current = null;
        setJustCompleted(false);
      }, TOOL_CALL_COMPLETION_PULSE_MS);
    }
  }, [toolCall.status]);
  useEffect(() => () => {
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
  }, []);

  const errorDetail = toolCall.status === 'failed'
    ? (textFromToolResult(toolCall.result) ?? formatToolCallResultForDisplay(toolCall)) || undefined
    : undefined;

  const headerSummary = buildHeaderSummary(parsed);
  const summaryModel: ToolCallHeaderSummaryModel = { kind: 'text', text: headerSummary };
  const inlineLivePreview = !open && toolCall.status === 'running'
    ? deriveToolTail(toolCall, prefs.activityTailLines)
    : null;

  return (
    <div
      class={cx(
        'tool-call-card overflow-clip border-x-0 border-t-0 border-b border-border-subtle bg-transparent transition-colors duration-100',
        'forced-colors:border forced-colors:border-[ButtonText]',
        justCompleted && 'tool-call-just-completed',
      )}
      data-status={toolCall.status}
      role="group"
      aria-label={`web_search tool call, ${toolCall.status}`}
      onContextMenu={(e) => { e.preventDefault(); handleContextMenu(toMouseEvent(e)); }}
    >
      <ToolCallHeader
        open={open}
        name="web_search"
        status={toolCall.status}
        summary={headerSummary}
        summaryModel={summaryModel}
        errorDetail={errorDetail}
        durationMs={toolCall.durationMs}
        prefs={prefs}
        onOpenFile={onOpenFile}
        onToggle={() => setOpen((v) => !v)}
      />
      {inlineLivePreview && (
        <div class="tool-call-live-preview" role="status" aria-label="web_search live result preview">
          <TurnActivityTailBody tail={inlineLivePreview.tail} continuous />
        </div>
      )}
      {open && (
        <div class="tool-call-body-wrap">
          <div class="tool-call-body-inner">
            <WebSearchBody toolCall={toolCall} parsed={parsed} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

function renderWebSearchTool({
  toolCall,
  prefs,
  workingDirectory,
  onOpenFile,
  onContextMenu,
}: ToolRendererProps) {
  const parsed = parseWebSearchInput(toolCall.input);
  if (!parsed) {
    // Unrecognised input shape — fall back to the generic card so nothing is lost.
    const contextType = getToolCallContextType(toolCall.name);
    const handleContextMenu = (e: MouseEvent) =>
      onContextMenu(contextType, JSON.stringify(toolCall, null, 2), e);
    return (
      <ToolCallCard
        toolCall={toolCall}
        autoExpand={prefs.autoExpandToolCalls}
        activityTailLines={prefs.activityTailLines}
        workingDirectory={workingDirectory}
        prefs={prefs}
        onOpenFile={onOpenFile}
        onContextMenu={handleContextMenu}
      />
    );
  }

  return (
    <WebSearchCard
      toolCall={toolCall}
      parsed={parsed}
      prefs={prefs}
      onOpenFile={onOpenFile}
      onContextMenu={onContextMenu}
    />
  );
}

registerToolRenderer('web_search', renderWebSearchTool);
