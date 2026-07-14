import assert from 'node:assert/strict';
import test from 'node:test';

import DOMPurify from 'dompurify';
import renderToString from 'preact-render-to-string';

import { DEFAULT_CHAT_PREFS, type ToolCall } from '../../../../src/shared/protocol';

// Bypass DOMPurify so we can assert on the rendered markdown HTML.
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

// Trigger side-effect renderer registration.
require('../../../../src/webview/panel/transcript/register-builtins');
const registryModule: typeof import('../../../../src/webview/panel/transcript/registry') =
  require('../../../../src/webview/panel/transcript/registry');

const noop = () => undefined;
const noopContextMenu = () => undefined;
const noopRenderToolCall = () => null;

function webSearchTool(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'web-search-1',
    name: 'web_search',
    input: { query: 'VESA mount adapter' },
    result: { content: [{ type: 'text', text: 'A synthesised answer with [a link](https://example.com).' }] },
    status: 'completed',
    ...overrides,
  };
}

function render(toolCall: ToolCall, autoExpand = true): string {
  const Renderer = registryModule.getToolRenderer('web_search');
  assert.ok(Renderer, 'web_search renderer should be registered');
  const tree = Renderer({
    toolCall,
    prefs: { ...DEFAULT_CHAT_PREFS, autoExpandToolCalls: autoExpand },
    workingDirectory: null,
    onOpenFile: noop,
    onContextMenu: noopContextMenu,
    renderToolCall: noopRenderToolCall,
  });
  return renderToString(tree as Parameters<typeof renderToString>[0]);
}

test('web_search renderer is registered', () => {
  assert.ok(registryModule.getToolRenderer('web_search'));
});

test('web_search renders queries as a wrapped list with a count and option chips', () => {
  const toolCall = webSearchTool({
    id: 'web-search-multi',
    input: {
      queries: [
        'Titan Army N27FW VESA mount adapter 50mm hole pattern',
        'Titan Army N27FW curved monitor specification',
        'MONTTA0001 VESA converter buy New Zealand',
      ],
      numResults: 8,
      provider: 'perplexity',
      recencyFilter: 'month',
      domainFilter: ['-spam.com'],
    },
  });
  const html = render(toolCall);

  // Each query is rendered as its own readable line (not a YAML <pre>).
  assert.match(html, /web-search-queries/);
  assert.match(html, /web-search-query-text">Titan Army N27FW VESA mount adapter 50mm hole pattern/);
  assert.match(html, /MONTTA0001 VESA converter buy New Zealand/);
  // Count appears in the section label and as per-query indices.
  assert.match(html, /Queries · 3/);
  assert.match(html, /web-search-query-index">1/);
  // Only non-default option knobs are surfaced as compact chips.
  assert.match(html, /web-search-option">8 results/);
  assert.match(html, /web-search-option">provider: perplexity/);
  assert.match(html, /web-search-option">recency: month/);
  assert.match(html, /web-search-option">domains: -spam\.com/);
  // No raw YAML dump of the input.
  assert.doesNotMatch(html, /tool-call-pre[^-]/);
  // Synthesised answer renders as markdown prose (clickable link), bounded.
  assert.match(html, /web-search-result message-body/);
  assert.match(html, /<a href="https:\/\/example\.com"/);
});

test('web_search collapses the header to a tight query preview with a count suffix', () => {
  const toolCall = webSearchTool({
    id: 'web-search-collapsed',
    input: {
      queries: [
        'Titan Army N27FW VESA mount adapter 50mm hole pattern',
        'second query',
        'third query',
      ],
    },
  });
  const html = render(toolCall, false);

  // Header shows the first query clipped, plus a count of the remaining ones.
  assert.match(html, /transcript-header-summary-mono/);
  assert.match(html, /Titan Army N27FW VESA mount adapter/);
  assert.match(html, /\+2 more/);
  // The full second query is not dumped into the header.
  assert.doesNotMatch(html, /second query/);
});

test('web_search renders a single query without an index and a Query label', () => {
  const toolCall = webSearchTool({
    id: 'web-search-single',
    input: { query: 'VESA mount adapter 50mm hole pattern' },
  });
  const html = render(toolCall);

  assert.match(html, /tool-call-section-label">Query</);
  assert.doesNotMatch(html, /web-search-query-index/);
  assert.doesNotMatch(html, /Queries · /);
});

test('web_search falls back to the generic card when input cannot be parsed', () => {
  // Non-object input.
  let html = render(webSearchTool({ id: 'web-search-fallback-1', input: 'not an object' }));
  assert.match(html, /tool-call-section-label">Input</);
  assert.doesNotMatch(html, /web-search-queries/);

  // Empty queries array / whitespace-only query.
  html = render(webSearchTool({ id: 'web-search-fallback-2', input: { queries: [] } }));
  assert.match(html, /tool-call-section-label">Input</);
  assert.doesNotMatch(html, /web-search-queries/);

  html = render(webSearchTool({ id: 'web-search-fallback-3', input: { query: '   ' } }));
  assert.match(html, /tool-call-section-label">Input</);
  assert.doesNotMatch(html, /web-search-queries/);
});

test('web_search shows plain streaming text while running and a pending state before any result', () => {
  // Partial streamed progress text.
  const streaming = render(webSearchTool({
    id: 'web-search-streaming',
    status: 'running',
    result: { content: [{ type: 'text', text: 'Searching 3/3: final query' }] },
  }));
  assert.match(streaming, /web-search-result-streaming/);
  assert.match(streaming, /Searching 3\/3: final query/);
  // No markdown prose block while streaming.
  assert.doesNotMatch(streaming, /web-search-result message-body/);

  // No result at all yet.
  const pending = render(webSearchTool({
    id: 'web-search-pending',
    status: 'running',
    result: undefined,
  }));
  assert.match(pending, /web-search-pending/);
  assert.match(pending, /Searching the web…/);
  assert.match(pending, /tool-call-section-label">Searching/);
});
