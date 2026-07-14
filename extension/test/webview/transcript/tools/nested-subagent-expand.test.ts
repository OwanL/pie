import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../../_helpers/dom';
installDom();

// Stub DOMPurify before any component imports (matches webview-render.test.ts)
import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { SubagentToolRenderer } from '../../../../src/webview/panel/transcript/tool-call-item.tsx';
import { ToolCallItem } from '../../../../src/webview/panel/transcript/tool-call-item.tsx';
// Side-effect: registers all built-in tool renderers ('subagent', 'ask_user',
// …) so ToolCallItem dispatches nested subagent calls to SubagentToolRenderer
// instead of falling back to the generic card.
import '../../../../src/webview/panel/transcript/register-builtins.ts';
import { clearCollapsibleCache } from '../../../../src/webview/panel/transcript/use-collapsible-open';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CHAT_PREFS, type ChatPrefs, type ToolCall } from '../../../../src/shared/protocol';
import type { RenderToolCall, TranscriptContextMenuHandler } from '../../../../src/webview/panel/transcript/types';

const noop = () => undefined;
const noopContextMenu: TranscriptContextMenuHandler = () => undefined;

let container: HTMLElement;

beforeEach(() => {
  clearCollapsibleCache();
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
  };
});

/**
 * A nested subagent tool call: the outer subagent's transcript contains an
 * assistant message that itself invokes a `subagent` tool (the inner scout),
 * whose result carries its own nested transcript. This is the depth-2 case
 * that the recent "nested subagent enablement" work made possible.
 */
/**
 * A depth-3 fixture: outer worker → inner scout → innermost reviewer.
 * Validates that subagentDepth keeps incrementing so every level ≥ 2 is
 * treated as nested (non-sticky header, free-flowing body).
 */
function depth3SubagentToolCall(): ToolCall {
  const innermostDetails = { results: [{ agent: 'reviewer', task: 'review the change', exitCode: 0, messages: [
    { role: 'assistant', content: 'Looks good — depth-3 reviewer transcript.' },
  ] }] };
  const innermost: ToolCall = {
    id: 'sub_d3', name: 'subagent', status: 'completed',
    input: { agent: 'reviewer', task: 'review the change' },
    result: { details: innermostDetails },
  };
  const middle: ToolCall = {
    id: 'sub_top', name: 'subagent', status: 'completed',
    input: { agent: 'worker', task: 'do the thing' },
    result: { details: { results: [{ agent: 'worker', task: 'do the thing', exitCode: 0, messages: [
      { role: 'assistant', content: [ { type: 'text', text: 'Delegating recon then review.' }, { type: 'toolCall', id: 'sub_d2', name: 'subagent', arguments: { agent: 'scout', task: 'recon' } } ] },
      { role: 'toolResult', toolCallId: 'sub_d2', details: { results: [{ agent: 'scout', task: 'recon', exitCode: 0, messages: [
        { role: 'assistant', content: [ { type: 'text', text: 'Recon done; delegating review.' }, { type: 'toolCall', id: 'sub_d3', name: 'subagent', arguments: innermost.input } ] },
        { role: 'toolResult', toolCallId: 'sub_d3', details: innermostDetails },
        { role: 'assistant', content: 'Recon + review complete.' },
      ] }] } },
      { role: 'assistant', content: 'Work done.' },
    ] }] } },
  };
  return middle;
}

function nestedSubagentToolCall(): ToolCall {
  return {
    id: 'sub_top',
    name: 'subagent',
    input: { agent: 'worker', task: 'do the thing' },
    status: 'completed',
    result: {
      details: {
        results: [
          {
            agent: 'worker',
            task: 'do the thing',
            exitCode: 0,
            messages: [
              {
                role: 'assistant',
                content: [
                  { type: 'text', text: 'Delegating recon to scout.' },
                  {
                    type: 'toolCall',
                    id: 'sub_nested',
                    name: 'subagent',
                    arguments: { agent: 'scout', task: 'recon the codebase' },
                  },
                ],
              },
              {
                role: 'toolResult',
                toolCallId: 'sub_nested',
                details: {
                  results: [
                    {
                      agent: 'scout',
                      task: 'recon the codebase',
                      exitCode: 0,
                      messages: [
                        { role: 'assistant', content: 'Recon complete. Found 3 relevant files.' },
                      ],
                    },
                  ],
                },
              },
              {
                role: 'assistant',
                content: 'Done with the work.',
              },
            ],
          },
        ],
      },
    },
  };
}

/** Build the real recursive renderToolCall (mirrors virtual-list.tsx). */
function makeRenderToolCall(prefs: ChatPrefs): RenderToolCall {
  function renderToolCall(toolCall: ToolCall, onContextMenu: TranscriptContextMenuHandler) {
    return h(ToolCallItem, {
      toolCall,
      prefs,
      workingDirectory: '/repo',
      onOpenFile: noop,
      onContextMenu: onContextMenu,
      renderToolCall,
    });
  }
  return renderToolCall;
}

function mount(toolCall: ToolCall, prefs: ChatPrefs) {
  const renderToolCall = makeRenderToolCall(prefs);
  act(() => {
    render(
      h(SubagentToolRenderer, {
        toolCall,
        prefs,
        workingDirectory: '/repo',
        onOpenFile: noop,
        onContextMenu: noopContextMenu,
        renderToolCall,
      }),
      container,
    );
  });
}

function prefsWith(overrides: Partial<ChatPrefs>): ChatPrefs {
  return { ...DEFAULT_CHAT_PREFS, ...overrides };
}

test('nested subagent: with autoExpand, both outer and inner subagent headers render', () => {
  mount(nestedSubagentToolCall(), prefsWith({ autoExpandSubagentCalls: true }));
  const headers = container.querySelectorAll('.subagent-header');
  // Expect at least 2: the outer worker header + the inner scout header.
  assert.ok(headers.length >= 2, `expected >=2 subagent headers, got ${headers.length}`);
  const agentNames = Array.from(headers).map((h) => h.querySelector('.subagent-agent-name')?.textContent ?? '');
  assert.ok(agentNames.includes('worker'), `outer header should show worker, got ${JSON.stringify(agentNames)}`);
  assert.ok(agentNames.includes('scout'), `inner header should show scout, got ${JSON.stringify(agentNames)}`);
});

test('nested subagent: collapsed by default hides the inner subagent entirely', () => {
  mount(nestedSubagentToolCall(), prefsWith({ autoExpandSubagentCalls: false }));
  const headers = container.querySelectorAll('.subagent-header');
  assert.equal(headers.length, 1, 'only the outer (collapsed) header should render');
  // Body must not be mounted when collapsed.
  assert.ok(!container.querySelector('.subagent-messages'), 'no subagent body when collapsed');
});

test('nested subagent: expanding the outer reveals the inner subagent header', () => {
  mount(nestedSubagentToolCall(), prefsWith({ autoExpandSubagentCalls: false }));
  assert.equal(container.querySelectorAll('.subagent-header').length, 1, 'starts with one header');

  // Click the outer header to expand.
  const outerHeader = container.querySelector('.subagent-header') as HTMLElement;
  act(() => {
    outerHeader.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  // Now the outer body mounts, and the inner subagent header renders (still
  // collapsed by default, but its header is present).
  const headers = container.querySelectorAll('.subagent-header');
  assert.equal(headers.length, 2, 'outer + inner header after expanding outer');
  const innerHeader = headers[1];
  assert.equal(innerHeader.querySelector('.subagent-agent-name')?.textContent, 'scout');
  assert.equal(innerHeader.getAttribute('aria-expanded'), 'false', 'inner is collapsed');
});

test('nested subagent: expanding outer then inner reveals the innermost transcript text', () => {
  mount(nestedSubagentToolCall(), prefsWith({ autoExpandSubagentCalls: false }));

  // Expand outer.
  const outerHeader = container.querySelector('.subagent-header') as HTMLElement;
  act(() => { outerHeader.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

  // Expand inner (the second header).
  const headers = container.querySelectorAll('.subagent-header');
  const innerHeader = headers[1] as HTMLElement;
  act(() => { innerHeader.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

  // The innermost scout transcript text should now be in the DOM.
  assert.match(container.textContent ?? '', /Recon complete/);
});

test('nested subagent: toggling the inner header does not collapse the outer', () => {
  mount(nestedSubagentToolCall(), prefsWith({ autoExpandSubagentCalls: true }));

  const headersBefore = container.querySelectorAll('.subagent-header');
  assert.equal(headersBefore.length, 2, 'two headers auto-expanded');

  // Collapse the inner header.
  const innerHeader = headersBefore[1] as HTMLElement;
  act(() => { innerHeader.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

  // Outer stays expanded (its body still present), inner body unmounts.
  const outerHeader = container.querySelector('.subagent-header') as HTMLElement;
  assert.equal(outerHeader.getAttribute('aria-expanded'), 'true', 'outer stays expanded');
  const headersAfter = container.querySelectorAll('.subagent-header');
  assert.equal(headersAfter.length, 2, 'both headers still present');
  assert.equal(headersAfter[1].getAttribute('aria-expanded'), 'false', 'inner collapsed');
});

// ─── Nested sticky/scroll/overlap fix (depth ≥ 2) ───────────────────────────
// A nested subagent renders inside a parent subagent's bounded scroll region.
// Its body must NOT establish a second nested scroll container (else two
// stacked capped scroll regions), so it flows inside the parent's scroll
// region. Headers are non-detaching (`relative`, no pinning) at every depth —
// depth-1 used to pin and read as a detaching bar; the bottom
// `CollapsibleCloseFooter` now keeps the close reachable without the pin.

test('nested subagent: depth-1 header is non-detaching, nested header carries the nested modifier', () => {
  mount(nestedSubagentToolCall(), prefsWith({ autoExpandSubagentCalls: true }));
  const headers = container.querySelectorAll('.subagent-header');
  assert.equal(headers.length, 2, 'outer (depth 1) + inner (depth 2)');
  assert.ok(!headers[0].classList.contains('subagent-header-nested'), 'depth-1 header has no nested modifier');
  assert.ok(headers[1].classList.contains('subagent-header-nested'), 'nested header has subagent-header-nested');
});

test('nested subagent: depth-1 body is a bounded scroll region, nested body flows', () => {
  mount(nestedSubagentToolCall(), prefsWith({ autoExpandSubagentCalls: true }));
  const scrolls = container.querySelectorAll('.subagent-messages-scroll');
  assert.equal(scrolls.length, 2, 'outer + inner scroll element');
  assert.ok(!scrolls[0].classList.contains('subagent-messages-scroll-nested'), 'depth-1 body is a bounded scroll region');
  assert.ok(scrolls[1].classList.contains('subagent-messages-scroll-nested'), 'nested body flows (subagent-messages-scroll-nested)');
});

test('nested subagent: no resize handles on the nested (free-flowing) body', () => {
  mount(nestedSubagentToolCall(), prefsWith({ autoExpandSubagentCalls: true }));
  const nestedScroll = container.querySelectorAll('.subagent-messages-scroll.subagent-messages-scroll-nested')[0];
  assert.ok(nestedScroll, 'nested scroll element present');
  const resizeHandles = nestedScroll.parentElement?.querySelectorAll('.resize-handle') ?? [];
  assert.equal(resizeHandles.length, 0, 'nested body has no resize handles');
});

test('nested subagent CSS: every header is relative (non-detaching); nested body unbounded', async () => {
  const css = await readFile(new URL('../../../../src/webview/panel/styles/tool-call.css', import.meta.url), 'utf8');
  assert.match(css, /\.subagent-header\.subagent-header-nested\s*\{[^}]*position:\s*relative/);
  assert.match(css, /\.subagent-header\.subagent-header-nested\s*\{[^}]*top:\s*auto/);
  assert.match(css, /\.subagent-header\.subagent-header-nested\s*\{[^}]*z-index:\s*auto/);
  assert.match(css, /\.subagent-messages-scroll\.subagent-messages-scroll-nested\s*\{[^}]*max-height:\s*none/);
  assert.match(css, /\.subagent-messages-scroll\.subagent-messages-scroll-nested\s*\{[^}]*overflow-y:\s*visible/);
  assert.match(css, /\.subagent-messages-scroll\.subagent-messages-scroll-nested\s*\{[^}]*min-height:\s*0/);
  // Depth-1 header is non-detaching (`relative`) too — it used to be sticky and
  // read as a detaching bar; the bottom close footer now keeps the close
  // reachable without the pin. The depth-1 body stays a capped scroll region.
  assert.match(css, /\.subagent-header\s*\{[^}]*position:\s*relative/);
  assert.match(css, /\.subagent-header\s*\{[^}]*top:\s*auto/);
  assert.match(css, /\.subagent-header\s*\{[^}]*z-index:\s*auto/);
  assert.match(css, /\.subagent-messages-scroll\s*\{[^}]*max-height:\s*var\(--expanded-section-max-height\)/);
});

test('depth-3 subagent: every level ≥ 2 is nested (non-detaching header, free-flowing body)', () => {
  mount(depth3SubagentToolCall(), prefsWith({ autoExpandSubagentCalls: true }));
  const headers = container.querySelectorAll('.subagent-header');
  assert.equal(headers.length, 3, 'worker (d1) + scout (d2) + reviewer (d3)');
  // Only the depth-1 header lacks the nested modifier; both nested headers get it.
  assert.ok(!headers[0].classList.contains('subagent-header-nested'), 'depth-1 header has no nested modifier');
  assert.ok(headers[1].classList.contains('subagent-header-nested'), 'depth-2 header is nested');
  assert.ok(headers[2].classList.contains('subagent-header-nested'), 'depth-3 header is nested');
  const scrolls = container.querySelectorAll('.subagent-messages-scroll');
  assert.equal(scrolls.length, 3, 'three scroll elements');
  assert.ok(!scrolls[0].classList.contains('subagent-messages-scroll-nested'), 'depth-1 body is a bounded scroll region');
  assert.ok(scrolls[1].classList.contains('subagent-messages-scroll-nested'), 'depth-2 body flows');
  assert.ok(scrolls[2].classList.contains('subagent-messages-scroll-nested'), 'depth-3 body flows');
});