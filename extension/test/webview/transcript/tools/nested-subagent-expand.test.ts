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

function telemetrySubagentToolCall(kind: 'legacy' | 'live'): ToolCall {
  const child = {
    id: 'telemetry-child',
    agent: 'worker',
    task: 'inspect telemetry',
    exitCode: kind === 'live' ? -1 : 0,
    model: 'provider/worker-model',
    provider: 'provider',
    selectedModel: 'provider/worker-model',
    thinkingLevel: kind === 'live' ? 'high' : 'off',
    contextWindow: 200_000,
    usage: kind === 'live'
      ? { output: 42, contextTokens: 1_000 }
      : { input: 1_200, output: 300, contextTokens: 1_500, cost: 0.0123 },
    turnThroughputSamples: [{ endedAt: '2026-01-01T00:00:02.000Z', outputTokens: kind === 'live' ? 42 : 300, generationDurationMs: 1_500, status: 'completed' }],
    startedAt: 1_000,
    completedAt: kind === 'live' ? undefined : 3_000,
    activityPhase: kind === 'live' ? 'streaming' : 'completed',
    streaming: kind === 'live',
    messages: [],
    parentUserContextMode: 'latest' as const,
    parentUserContext: '[User prompt]\nKeep telemetry visible.',
    retryCount: kind === 'live' ? undefined : 1,
    fallback: kind === 'live' ? undefined : true,
    failedModel: kind === 'live' ? undefined : 'provider/old-model',
  };
  return {
    id: `telemetry-${kind}`,
    name: 'subagent',
    input: { agent: 'worker', task: 'inspect telemetry', userContext: 'latest' },
    status: kind === 'live' ? 'running' : 'completed',
    result: kind === 'live'
      ? { kind: 'subagent', mode: 'single', omittedChildren: 0, children: [{ ...child, phase: 'running' }] }
      : { details: { mode: 'single', results: [child] } },
  } as ToolCall;
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

test('subagent model tooltip shows the exact inherited context packet', async () => {
  const toolCall = nestedSubagentToolCall();
  const details = (toolCall.result as any).details;
  details.results[0].model = 'provider/runtime-model';
  details.results[0].selectedModel = 'provider/requested-model';
  details.results[0].thinkingLevel = 'high';
  details.results[0].parentUserContextMode = 'latest';
  details.results[0].parentUserContext = '[User prompt]\nKeep the public API.\n\n[Recorded clarification]\nQuestion: Add tests?\nAnswer: Yes';
  mount(toolCall, prefsWith({ autoExpandSubagentCalls: false }));

  const modelTrigger = container.querySelector<HTMLElement>('.subagent-model-details-trigger');
  assert.ok(modelTrigger);
  assert.equal(modelTrigger?.tabIndex, 0, 'model detail trigger should be keyboard focusable');
  const trigger = modelTrigger?.closest<HTMLElement>('.pie-tooltip-trigger');
  assert.ok(trigger);
  const originalSetTimeout = window.setTimeout;
  let showTooltip: TimerHandler | undefined;
  window.setTimeout = ((callback: TimerHandler) => {
    showTooltip = callback;
    return 1;
  }) as typeof window.setTimeout;
  try {
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('mouseenter'));
      if (typeof showTooltip === 'function') showTooltip();
      await Promise.resolve();
    });
  } finally {
    window.setTimeout = originalSetTimeout;
  }
  const tooltip = Array.from(document.querySelectorAll<HTMLElement>('.pie-tooltip-host'))
    .find((host) => host.textContent?.includes('Keep the public API.'));
  assert.ok(tooltip, 'context tooltip should render the exact inherited packet');
  assert.match(tooltip.textContent ?? '', /Delegated taskdo the thing/);
  assert.match(tooltip.textContent ?? '', /Recorded clarification.*Add tests\?.*Yes/s);
  assert.match(tooltip.textContent ?? '', /Requested model: provider\/requested-model/);
  assert.match(tooltip.textContent ?? '', /Actual runtime model: provider\/runtime-model/);
});

test('completed legacy subagent keeps model, reasoning, elapsed, cost, and recovery inline while detailed metrics move to the model tooltip', async () => {
  mount(telemetrySubagentToolCall('legacy'), prefsWith({ autoExpandSubagentCalls: false }));
  const header = container.querySelector<HTMLElement>('.subagent-header');
  assert.ok(header);
  assert.match(header?.textContent ?? '', /worker-model · off/);
  assert.match(header?.textContent ?? '', /2s/);
  assert.match(header?.textContent ?? '', /\$0\.012/);
  assert.match(header?.textContent ?? '', /Recovered/);
  assert.doesNotMatch(header?.textContent ?? '', /ctx|tok|cached|tokens\/s|context latest/i);

  const modelTrigger = container.querySelector<HTMLElement>('.subagent-model-details-trigger');
  assert.ok(modelTrigger);
  assert.equal(modelTrigger?.tabIndex, 0);
  const originalSetTimeout = window.setTimeout;
  let showTooltip: TimerHandler | undefined;
  window.setTimeout = ((callback: TimerHandler) => {
    showTooltip = callback;
    return 1;
  }) as typeof window.setTimeout;
  try {
    await act(async () => {
      modelTrigger.closest<HTMLElement>('.pie-tooltip-trigger')?.dispatchEvent(new MouseEvent('mouseenter'));
      if (typeof showTooltip === 'function') showTooltip();
      await Promise.resolve();
    });
  } finally {
    window.setTimeout = originalSetTimeout;
  }
  const host = Array.from(document.querySelectorAll<HTMLElement>('.pie-tooltip-host'))
    .filter((candidate) => candidate.style.display === 'block')
    .at(-1);
  assert.ok(host, 'model hover should open the rich runtime tooltip');
  assert.equal(host?.getAttribute('role'), 'tooltip');
  assert.match(host?.textContent ?? '', /Context1,500 \/ 200,000 tokens/);
  assert.match(host?.textContent ?? '', /Input1,200 tokens/);
  assert.match(host?.textContent ?? '', /Output300 tokens/);
  assert.match(host?.textContent ?? '', /Cache read— tokens/);
  assert.match(host?.textContent ?? '', /Latest generation.*300 output tokens.*1\.5s.*200\.0 tokens\/s/s);
  assert.match(host?.textContent ?? '', /failed provider\/old-model/);
  assert.match(host?.textContent ?? '', /Exact inherited parent context/);
  assert.doesNotMatch(host?.textContent ?? '', /Cache read0 tokens/);
});

test('live typed subagent preview retains model, reasoning, partial usage, and throughput in the model tooltip', async () => {
  mount(telemetrySubagentToolCall('live'), prefsWith({ autoExpandSubagentCalls: false }));
  const header = container.querySelector<HTMLElement>('.subagent-header');
  assert.ok(header);
  assert.match(header?.textContent ?? '', /worker-model · high/);
  assert.ok(container.querySelector('.subagent-telemetry-elapsed'), 'live elapsed time should remain visible');

  const modelTrigger = container.querySelector<HTMLElement>('.subagent-model-details-trigger');
  assert.ok(modelTrigger);
  const originalSetTimeout = window.setTimeout;
  let showTooltip: TimerHandler | undefined;
  window.setTimeout = ((callback: TimerHandler) => {
    showTooltip = callback;
    return 1;
  }) as typeof window.setTimeout;
  try {
    await act(async () => {
      modelTrigger.closest<HTMLElement>('.pie-tooltip-trigger')?.dispatchEvent(new MouseEvent('mouseenter'));
      if (typeof showTooltip === 'function') showTooltip();
      await Promise.resolve();
    });
  } finally {
    window.setTimeout = originalSetTimeout;
  }
  const host = Array.from(document.querySelectorAll<HTMLElement>('.pie-tooltip-host'))
    .filter((candidate) => candidate.style.display === 'block')
    .at(-1);
  assert.ok(host);
  assert.match(host?.textContent ?? '', /Input— tokens/);
  assert.match(host?.textContent ?? '', /Output42 tokens/);
  assert.match(host?.textContent ?? '', /Latest generation.*42 output tokens.*1\.5s.*28\.0 tokens\/s/s);
  assert.doesNotMatch(host?.textContent ?? '', /Cache read0 tokens/);
});

/** Open the model-details tooltip and return the visible host element. */
async function openModelTooltip(): Promise<HTMLElement> {
  const modelTrigger = container.querySelector<HTMLElement>('.subagent-model-details-trigger');
  assert.ok(modelTrigger, 'model details trigger should render');
  const originalSetTimeout = window.setTimeout;
  let showTooltip: TimerHandler | undefined;
  window.setTimeout = ((callback: TimerHandler) => {
    showTooltip = callback;
    return 1;
  }) as typeof window.setTimeout;
  try {
    await act(async () => {
      modelTrigger.closest<HTMLElement>('.pie-tooltip-trigger')?.dispatchEvent(new MouseEvent('mouseenter'));
      if (typeof showTooltip === 'function') showTooltip();
      await Promise.resolve();
    });
  } finally {
    window.setTimeout = originalSetTimeout;
  }
  const host = Array.from(document.querySelectorAll<HTMLElement>('.pie-tooltip-host'))
    .filter((candidate) => candidate.style.display === 'block')
    .at(-1);
  assert.ok(host, 'model hover should open the rich runtime tooltip');
  return host;
}

function costEvidenceToolCall(usage: Record<string, number> | undefined): ToolCall {
  const child: Record<string, unknown> = {
    id: 'cost-evidence-child',
    agent: 'worker',
    task: 'report cost evidence',
    exitCode: 0,
    model: 'provider/worker-model',
    provider: 'provider',
    activityPhase: 'completed',
    startedAt: 1_000,
    completedAt: 3_000,
    messages: [],
    ...(usage ? { usage } : {}),
  };
  return {
    id: 'cost-evidence',
    name: 'subagent',
    input: { agent: 'worker', task: 'report cost evidence' },
    status: 'completed',
    result: { details: { mode: 'single', results: [child] } },
  } as unknown as ToolCall;
}

test('subagent without cost evidence renders no cost chip and no tooltip Cost row', async () => {
  mount(costEvidenceToolCall({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, contextTokens: 100 }), prefsWith({ autoExpandSubagentCalls: false }));

  assert.ok(!container.querySelector('.subagent-telemetry-cost'), 'a child without cost evidence must not display a fabricated $0.000 chip');

  const host = await openModelTooltip();
  assert.match(host.textContent ?? '', /Input100 tokens/);
  assert.doesNotMatch(host.textContent ?? '', /\$0\.000/);
  assert.doesNotMatch(host.textContent ?? '', /Cost/);
});

test('subagent with reported zero cost preserves known free usage', async () => {
  mount(costEvidenceToolCall({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, contextTokens: 150, cost: 0 }), prefsWith({ autoExpandSubagentCalls: false }));

  assert.equal(container.querySelector('.subagent-telemetry-cost')?.textContent, '$0.000');

  const host = await openModelTooltip();
  assert.match(host.textContent ?? '', /Cost\$0\.0000/);
});

test('subagent with provider-reported cost keeps the chip and tooltip row', async () => {
  mount(costEvidenceToolCall({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, contextTokens: 150, cost: 0.42 }), prefsWith({ autoExpandSubagentCalls: false }));

  const chip = container.querySelector<HTMLElement>('.subagent-telemetry-cost');
  assert.ok(chip, 'reported cost evidence stays visible in the header');
  assert.match(chip.textContent ?? '', /\$0\.420/);

  const host = await openModelTooltip();
  assert.match(host.textContent ?? '', /Cost\$0\.4200/);
});

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