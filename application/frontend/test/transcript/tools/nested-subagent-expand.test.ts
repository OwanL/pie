import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../helpers/dom';
installDom();

// Stub DOMPurify before any component imports (matches webview-render.test.ts)
import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { SubagentToolRenderer } from '../../../transcript/tool-call-item.tsx';
import { ToolCallItem } from '../../../transcript/tool-call-item.tsx';
// Side-effect: registers all built-in tool renderers ('subagent', 'ask_user',
// …) so ToolCallItem dispatches nested subagent calls to SubagentToolRenderer
// instead of falling back to the generic card.
import '../../../transcript/register-builtins.ts';
import { clearCollapsibleCache } from '../../../transcript/use-collapsible-open';
import { AskUserContext } from '../../../lib/hooks/ask-user-context';
import { clearLazyDetailCache, receiveLazyDetailResult, setLazyDetailPostMessage } from '../../../transcript/lazy-detail-store';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CHAT_PREFS, type ChatPrefs, type ToolCall, type WebviewToHostMessage } from '../../../../lib/protocol/index.js';
import type { TokenPricingResolver } from '../../../session-tabs/token-usage';
import type { RenderToolCall, TranscriptContextMenuHandler } from '../../../transcript/types';

const noop = () => undefined;
const noopContextMenu: TranscriptContextMenuHandler = () => undefined;

let container: HTMLElement;

beforeEach(() => {
  clearCollapsibleCache();
  clearLazyDetailCache();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
  clearLazyDetailCache();
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

test('card task stays stable as live activity settles; transcript control activates once', () => {
  const prefs = prefsWith({ autoExpandSubagentCalls: false });
  const makeCall = (status: ToolCall['status'], child: object): ToolCall => ({
    id: 'outcome-transition', name: 'subagent', status, input: {},
    result: { details: { results: [{ agent: 'worker', task: 'Stable delegated task', messages: [], exitCode: status === 'running' ? -1 : 0, ...child }] } },
  });
  mount(makeCall('running', { streamingText: 'Live inspection' }), prefs);
  assert.match(container.textContent ?? '', /Live inspection/);
  mount(makeCall('completed', { streamingText: 'Stale activity', messages: [{ role: 'assistant', content: 'Real completed answer' }] }), prefs);
  assert.match(container.querySelector('.subagent-task')?.textContent ?? '', /Stable delegated task/);
  assert.match(container.querySelector('.subagent-outcome')?.textContent ?? '', /Real completed answer/);
  assert.doesNotMatch(container.textContent ?? '', /Stale activity|Live activity/);
  const control = container.querySelector<HTMLButtonElement>('.subagent-header')!;
  act(() => control.click());
  assert.equal(container.querySelector('.subagent-header')?.getAttribute('aria-expanded'), 'true');
  assert.equal(container.querySelector('.subagent-live-preview'), null);
  act(() => control.click());
  assert.equal(container.querySelector('.subagent-header')?.getAttribute('aria-expanded'), 'false');
});

test('settled outcome preserves exact paragraph separators without parsing prose', () => {
  const answer = 'First **literal** paragraph.\nA single line break.\n\nSecond paragraph.\r\n \r\nThird <literal> paragraph.';
  mount({ id: 'paragraph-outcome', name: 'subagent', status: 'completed', input: {},
    result: { details: { results: [{ agent: 'worker', task: 'Inspect', exitCode: 0,
      messages: [{ role: 'assistant', content: answer }],
    }] } },
  }, prefsWith({ autoExpandSubagentCalls: false }));
  const outcome = container.querySelector('.subagent-outcome')!;
  assert.equal(outcome.textContent, answer);
  assert.equal(outcome.querySelectorAll('p').length, 3);
  assert.equal(outcome.querySelector('strong'), null);
});

test('compact current input wraps raw content without retained tool output or duplicate expanded preview', () => {
  const command = 'run --value="' + 'long argument '.repeat(50) + '"\nsecond line';
  const call: ToolCall = { id: 'current-only', name: 'subagent', status: 'running', input: {}, result: { details: { results: [{
    agent: 'worker', task: 'One task', exitCode: -1, activityPhase: 'running_tool', messages: [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'old', name: 'custom', arguments: { path: 'old.ts' } }] },
      { role: 'toolResult', toolCallId: 'old', content: [{ type: 'text', text: 'Old output' }] },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'new', name: 'custom', arguments: { command } }] },
    ],
  }] } } };
  mount(call, prefsWith({ autoExpandSubagentCalls: false }));
  assert.equal(container.querySelector('.subagent-current-text')?.textContent, command);
  assert.doesNotMatch(container.querySelector('.subagent-live-preview')?.textContent ?? '', /Old output|old.ts/);
  assert.equal(container.querySelectorAll('.subagent-task').length, 1);
  act(() => container.querySelector<HTMLElement>('.subagent-header')!.click());
  assert.equal(container.querySelector('.subagent-live-preview'), null);
  assert.match(container.querySelector('.subagent-messages')?.textContent ?? '', /One task/);
});

test('parallel progress uses child lifecycle without changing independent disclosure', () => {
  const call: ToolCall = { id: 'mixed-progress', name: 'subagent', status: 'running', input: {}, result: { details: { results: [
    { agent: 'done', task: 'done', exitCode: 0, messages: [] },
    { agent: 'failed', task: 'failed', exitCode: 1, errorMessage: 'No access', messages: [] },
    { agent: 'queued', task: 'queued', exitCode: -1, activityPhase: 'queued', messages: [] },
    { agent: 'active', task: 'active', exitCode: -1, streamingText: 'Working', messages: [] },
  ] } } };
  mount(call, prefsWith({ autoExpandSubagentCalls: false }));
  assert.equal(container.querySelector('.subagent-parallel-progress'), null);
  assert.match(container.textContent ?? '', /No access|No answer text available/);
  act(() => container.querySelector<HTMLButtonElement>('.subagent-header')!.click());
  assert.deepEqual(Array.from(container.querySelectorAll('.subagent-header')).map((header) => header.getAttribute('aria-expanded')), ['true', 'false', 'false', 'false']);
});

function mount(toolCall: ToolCall, prefs: ChatPrefs, pricingForModel?: TokenPricingResolver, sessionPath?: string) {
  const renderToolCall = makeRenderToolCall(prefs);
  act(() => {
    const node = h(SubagentToolRenderer, {
        toolCall,
        prefs,
        workingDirectory: '/repo',
        onOpenFile: noop,
        onContextMenu: noopContextMenu,
        renderToolCall,
        pricingForModel,
      });
    render(sessionPath ? h(AskUserContext.Provider, {
      value: { sessionPath, postMessage: noop, pendingRequests: {}, registerInlineRequest: noop, unregisterInlineRequest: noop },
    }, node) : node, container);
  });
}

function prefsWith(overrides: Partial<ChatPrefs>): ChatPrefs {
  return { ...DEFAULT_CHAT_PREFS, ...overrides };
}

test('parallel children retain mixed disclosure across remount and attribute pending questions independently', () => {
  const toolCall: ToolCall = {
    id: 'parallel-disclosure', name: 'subagent', status: 'completed', input: {},
    result: { details: { results: ['first', 'second', 'third'].map((agent) => ({
      agent, task: agent, exitCode: 0, messages: [],
    })) } },
  };
  const prefs = prefsWith({ autoExpandSubagentCalls: false });
  const mountGroup = () => act(() => render(h(AskUserContext.Provider, {
    value: {
      sessionPath: '/session-a', postMessage: noop,
      pendingRequests: { question: { id: 'question', method: 'input', subagentCallId: 'parallel-disclosure:1' } } as any,
      registerInlineRequest: noop, unregisterInlineRequest: noop,
    },
  }, h(SubagentToolRenderer, {
    toolCall, prefs, workingDirectory: '/repo', onOpenFile: noop,
    onContextMenu: noopContextMenu, renderToolCall: makeRenderToolCall(prefs),
  })), container));
  const headers = () => Array.from(container.querySelectorAll<HTMLElement>('.subagent-header'));
  mountGroup();
  act(() => headers()[0].click());
  act(() => render(null, container));
  mountGroup();
  assert.deepEqual(headers().map((header) => header.getAttribute('aria-expanded')), ['true', 'false', 'false']);
  assert.deepEqual(Array.from(container.querySelectorAll('.tool-call-subagent')).map((card) => card.classList.contains('pending-ask-user')), [false, true, false]);
});

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
  assert.match(tooltip.textContent ?? '', /runtime-model/);
  assert.match(tooltip.textContent ?? '', /Requested: requested-model/);
  assert.doesNotMatch(tooltip.textContent ?? '', /provider\/requested-model|provider\/runtime-model/);
  assert.equal(container.querySelector('.subagent-model-label')?.getAttribute('title'), null, 'model label must not duplicate the tooltip natively');
});

test('responsive inline usage keeps valid zero channels, omits invalid groups, and preserves model identity', () => {
  const toolCall = telemetrySubagentToolCall('legacy');
  const child = (toolCall.result as any).details.results[0];
  child.usage = { input: 0, output: NaN, contextTokens: 0, cacheRead: 0, cacheWrite: 1200, turns: 1 };
  mount(toolCall, prefsWith({ autoExpandSubagentCalls: false }));
  assert.equal(container.querySelector('.subagent-inline-context')?.textContent, 'Context 0 / 200k (0.0%)');
  assert.equal(container.querySelector('.subagent-inline-tokens')?.textContent?.trim(), 'In 0');
  assert.equal(container.querySelector('.subagent-inline-cache')?.textContent, 'Cache write 1.2k');
  assert.equal(container.querySelector('.subagent-inline-turns')?.textContent, '1 provider turn');
  assert.equal(container.querySelector('.subagent-model-qualified')?.textContent, 'provider/worker-model');
  const trigger = container.querySelector('.subagent-model-details-trigger');
  assert.equal(trigger?.getAttribute('tabindex'), '0');
  assert.match(trigger?.getAttribute('aria-label') ?? '', /provider\/worker-model/);
});

test('wide model identity never combines a requested model with a different actual provider', () => {
  for (const selectedModel of ['requested/model', 'unqualified-model']) {
    const toolCall = telemetrySubagentToolCall('legacy');
    const child = (toolCall.result as any).details.results[0];
    Object.assign(child, { selectedModel, model: 'actual-model', provider: 'different-provider' });
    mount(toolCall, prefsWith({ autoExpandSubagentCalls: false }));
    assert.equal(container.querySelector('.subagent-model-qualified')?.textContent, selectedModel);
    assert.ok(container.querySelector('.subagent-model-details-trigger')?.getAttribute('aria-label')?.includes(selectedModel));
  }
});

test('responsive usage CSS uses per-card named thresholds without replacing tool-row containment', async () => {
  const css = await readFile(new URL('../../../styles/tool-call.css', import.meta.url), 'utf8');
  assert.match(css, /container: tool-row subagent-card \/ inline-size/);
  assert.match(css, /container: tool-row \/ inline-size/);
  for (const width of [760, 1050, 1350, 1600]) {
    assert.ok(css.includes(`@container subagent-card (min-width: ${width}px)`));
  }
  assert.match(css, /\.subagent-inline-usage \{[^}]*flex: 0 0 auto;/);
  assert.match(css, /\.subagent-header \{[^}]*flex-wrap: nowrap;/);
  assert.match(css, /\.subagent-header \.subagent-primary-meta \{[^}]*min-width: 52px;/);
  const runtimeRule = css.indexOf('.subagent-header .subagent-runtime-telemetry {');
  const elapsedRule = css.indexOf('.subagent-header .subagent-runtime-telemetry-stable {');
  assert.ok(elapsedRule > runtimeRule, 'elapsed owns its trailing order and zero margin after the shared telemetry rule');
  assert.match(css.slice(elapsedRule), /^\.subagent-header \.subagent-runtime-telemetry-stable \{ order: 5; margin-left: 0; \}/);
  assert.doesNotMatch(css, /\.subagent-footer/);
});

test('model interactions stay inside the single-row header while header Enter expands', async () => {
  mount(telemetrySubagentToolCall('legacy'), prefsWith({ autoExpandSubagentCalls: false }));
  const header = container.querySelector<HTMLElement>('.subagent-header')!;
  const model = header.querySelector<HTMLElement>('.subagent-model-details-trigger')!;
  for (const key of ['Enter', ' ']) {
    await act(async () => {
      model.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
    assert.equal(header.getAttribute('aria-expanded'), 'false');
  }
  await act(async () => { model.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  assert.equal(header.getAttribute('aria-expanded'), 'false');
  await act(async () => {
    header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  assert.equal(header.getAttribute('aria-expanded'), 'true');
});

test('responsive inline usage omits unknown and invalid values without inventing zero', () => {
  const toolCall = telemetrySubagentToolCall('legacy');
  const child = (toolCall.result as any).details.results[0];
  child.contextWindow = 0;
  child.usage = { input: -1, output: Infinity, contextTokens: 10, cacheRead: 0, cacheWrite: -2, turns: 0 };
  mount(toolCall, prefsWith({ autoExpandSubagentCalls: false }));
  assert.equal(container.querySelector('.subagent-inline-context'), null);
  assert.equal(container.querySelector('.subagent-inline-tokens'), null);
  assert.equal(container.querySelector('.subagent-inline-cache'), null);
  assert.equal(container.querySelector('.subagent-inline-turns')?.textContent, '0 provider turns');
});

test('completed legacy subagent keeps model, reasoning, elapsed, cost, and recovery inline while detailed metrics move to the model tooltip', async () => {
  mount(telemetrySubagentToolCall('legacy'), prefsWith({ autoExpandSubagentCalls: false }));
  const header = container.querySelector<HTMLElement>('.subagent-header');
  assert.ok(header);
  assert.equal(header?.getAttribute('aria-expanded'), 'false');
  assert.match(header?.querySelector('.subagent-telemetry-elapsed')?.textContent ?? '', /2s/);
  assert.equal(container.querySelector('.subagent-footer'), null);
  assert.match(header.querySelector('.subagent-model-label')?.textContent ?? '', /worker-model/);
  assert.match(header.textContent ?? '', /· off/);
  assert.equal(header.querySelector('.subagent-telemetry-cost')?.textContent, '$0.01');
  assert.match(header.querySelector('.subagent-telemetry-recovered')?.textContent ?? '', /Recovered/);

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
  assert.match(host?.textContent ?? '', /Context1\.5k \/ 200k tok \(0\.8%\)/);
  assert.match(host?.textContent ?? '', /Input1\.2k tok/);
  assert.match(host?.textContent ?? '', /Output300 tok/);
  assert.match(host?.textContent ?? '', /Latest generation.*1\.5s.*200\.0 tok\/s/s);
  assert.match(host?.textContent ?? '', /failed old-model/);
  assert.match(host?.textContent ?? '', /Exact inherited parent context/);
  assert.doesNotMatch(host?.textContent ?? '', /Cache read|Cache write|Provider turns|Total tokens/);
  const rowLabels = Array.from(host?.querySelectorAll<HTMLElement>('.subagent-detail-row') ?? [], (row) => row.firstElementChild?.textContent);
  assert.ok(rowLabels.indexOf('Recovery') < rowLabels.indexOf('Context'), 'recovery remains high priority');
  assert.ok(rowLabels.indexOf('Context') < rowLabels.indexOf('Cost'));
  assert.ok(rowLabels.indexOf('Cost') < rowLabels.indexOf('Output'));
  assert.ok(rowLabels.indexOf('Output') < rowLabels.indexOf('Latest generation'));
  assert.ok(rowLabels.indexOf('Input') > rowLabels.indexOf('Latest generation'), 'input follows high-priority generation metrics');
  assert.ok((host?.textContent ?? '').indexOf('Latest generation') < (host?.textContent ?? '').indexOf('Delegated task'), 'task and inherited packet follow runtime metrics');
});

test('live typed subagent preview retains model, reasoning, partial usage, and throughput in the model tooltip', async () => {
  mount(telemetrySubagentToolCall('live'), prefsWith({ autoExpandSubagentCalls: false }));
  const header = container.querySelector<HTMLElement>('.subagent-header');
  assert.ok(header);
  assert.equal(header?.getAttribute('aria-expanded'), 'false');
  assert.ok(header?.querySelector('.subagent-telemetry-elapsed'), 'live elapsed time should remain visible');
  assert.equal(container.querySelector('.subagent-footer'), null);
  assert.match(header?.querySelector('.subagent-model-label')?.textContent ?? '', /worker-model/);
  assert.match(header?.textContent ?? '', /· high/);

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
  assert.match(host?.textContent ?? '', /Output42 tok/);
  assert.match(host?.textContent ?? '', /Latest generation.*42 tok.*1\.5s.*28\.0 tok\/s/s);
  assert.doesNotMatch(host?.textContent ?? '', /Input|Cache read|Cache write/);
});

/** Open a details tooltip through its real hover wrapper or keyboard focus. */
async function openDetailsTooltip(element: HTMLElement, activation: 'hover' | 'focus' = 'hover'): Promise<HTMLElement> {
  const wrapper = element.closest<HTMLElement>('.pie-tooltip-trigger');
  assert.ok(wrapper, 'details target should have a tooltip wrapper');
  const originalSetTimeout = window.setTimeout;
  let showTooltip: TimerHandler | undefined;
  window.setTimeout = ((callback: TimerHandler) => {
    showTooltip = callback;
    return 1;
  }) as typeof window.setTimeout;
  try {
    await act(async () => {
      if (activation === 'focus') element.focus();
      else wrapper.dispatchEvent(new MouseEvent('mouseenter'));
      if (typeof showTooltip === 'function') showTooltip();
      await Promise.resolve();
    });
  } finally {
    window.setTimeout = originalSetTimeout;
  }
  const host = Array.from(document.querySelectorAll<HTMLElement>('.pie-tooltip-host'))
    .filter((candidate) => candidate.style.display === 'block')
    .at(-1);
  assert.ok(host, 'activation should open the details surface');
  return host;
}

async function openModelTooltip(): Promise<HTMLElement> {
  const modelTrigger = container.querySelector<HTMLElement>('.subagent-model-details-trigger');
  assert.ok(modelTrigger, 'model details trigger should render');
  const host = await openDetailsTooltip(modelTrigger);
  assert.equal(host.getAttribute('role'), 'tooltip');
  assert.ok(host.querySelector('.subagent-model-details-tooltip'), 'model text retains rich runtime details');
  return host;
}

function agentName(): HTMLElement {
  const name = container.querySelector<HTMLElement>('.subagent-agent-name');
  assert.ok(name, 'requested agent name should render');
  return name;
}

function requestedAgentToolCall(agent: 'worker' | 'reviewer' | 'scout'): ToolCall {
  const toolCall = telemetrySubagentToolCall('legacy');
  toolCall.id = `agent-name-${agent}`;
  (toolCall.input as any).agent = agent;
  (toolCall.result as any).details.results[0].agent = agent;
  return toolCall;
}

const captureSession = '/fixture/parent-session';
const capturedExchange = {
  produced: { name: 'subagent', arguments: { agent: 'captured-agent', task: 'EXACT captured task', opaque: ['unaltered', { value: 7 }] } },
  received: [{ type: 'text', text: 'EXACT captured output' }, { type: 'image', mimeType: 'image/png', data: 'EXACT_BINARY' }],
};

function captureRequests(): WebviewToHostMessage[] {
  const messages: WebviewToHostMessage[] = [];
  setLazyDetailPostMessage((message) => messages.push(message));
  return messages;
}

function assertCapturedInspector(host: HTMLElement) {
  assert.equal(host.getAttribute('role'), 'region', 'same raw inspector surface as tool icons');
  assert.ok(host.querySelector('.tool-call-raw-inspector'));
  assert.equal(host.querySelector('.subagent-model-details-tooltip'), null);
  assert.match(host.textContent ?? '', /Model produced/);
  assert.match(host.textContent ?? '', /Model received/);
  assert.doesNotMatch(host.textContent ?? '', /Usage & performance|Delegated task|Exact inherited parent context|Latest generation|worker-model|inspect telemetry|Keep telemetry visible|Context1\.5k|Output300 tok/);
}

function settleCapture(messages: WebviewToHostMessage[], toolCall: ToolCall, host: HTMLElement) {
  const request = messages.at(-1);
  assert.ok(request, 'agent-name inspection must lazily request the captured exchange');
  assert.equal(request.type, 'requestDetail');
  if (request.type !== 'requestDetail') return;
  assert.equal(request.sessionPath, captureSession);
  assert.deepEqual(request.ref, {
    key: JSON.stringify(['model-exchange', captureSession, toolCall.durableEntryId ?? toolCall.id, toolCall.id]),
    kind: 'model-exchange', source: 'durable', sessionPath: captureSession,
    messageId: toolCall.durableEntryId ?? toolCall.id, toolCallId: toolCall.id,
    sizeBytes: 0, summary: 'Captured model exchange', available: true,
  });
  act(() => receiveLazyDetailResult({ sessionPath: captureSession, key: request.ref.key, status: 'loaded', value: { ...capturedExchange, diagnostic: 'EXCLUDED_DIAGNOSTIC' }, sizeBytes: 500 }));
  assertCapturedInspector(host);
  const produced = host.querySelector('pre[aria-label="Model produced JSON"]');
  const received = host.querySelector('pre[aria-label="Model received JSON"]');
  assert.ok(produced);
  assert.ok(received);
  assert.deepEqual(JSON.parse(produced.textContent ?? ''), capturedExchange.produced);
  assert.deepEqual(JSON.parse(received.textContent ?? ''), capturedExchange.received);
  assert.doesNotMatch(host.textContent ?? '', /EXCLUDED_DIAGNOSTIC/);
}

test('worker, reviewer, and scout names lazily inspect exact captured subagent JSON while model text keeps telemetry', async () => {
  const messages = captureRequests();
  for (const agent of ['worker', 'reviewer', 'scout'] as const) {
    const toolCall = requestedAgentToolCall(agent);
    toolCall.durableEntryId = `original-entry-${agent}`;
    const before = messages.length;
    mount(toolCall, prefsWith({ autoExpandSubagentCalls: false }), undefined, captureSession);
    const modelHost = await openModelTooltip();
    assert.match(modelHost.textContent ?? '', /Context1\.5k \/ 200k tok/);
    assert.match(modelHost.textContent ?? '', /Latest generation.*200\.0 tok\/s/s);
    assert.equal(messages.length, before, 'mounting and model hover do not request a raw capture');
    act(() => render(null, container));
    mount(toolCall, prefsWith({ autoExpandSubagentCalls: false }), undefined, captureSession);
    assert.equal(agentName().textContent, agent);
    const host = await openDetailsTooltip(agentName());
    assert.equal(messages.length, before + 1);
    settleCapture(messages, toolCall, host);
    assert.equal(container.querySelector('.subagent-header')?.getAttribute('aria-expanded'), 'false', 'hover does not expand');
    act(() => render(null, container));
  }
});

test('agent-name raw inspection is available without a model label', async () => {
  const messages = captureRequests();
  const toolCall = requestedAgentToolCall('scout');
  const child = (toolCall.result as any).details.results[0];
  delete child.model;
  delete child.selectedModel;
  mount(toolCall, prefsWith({ autoExpandSubagentCalls: false }), undefined, captureSession);
  assert.equal(container.querySelector('.subagent-model-label'), null);
  assert.equal(container.querySelector('.subagent-model-details-trigger'), null);
  assert.equal(messages.length, 0);
  settleCapture(messages, toolCall, await openDetailsTooltip(agentName()));
});

test('parallel agent names inspect the same original parent capture, not synthetic child identities', async () => {
  const messages = captureRequests();
  const toolCall = requestedAgentToolCall('worker');
  toolCall.durableEntryId = 'parallel-original-entry';
  toolCall.input = { tasks: [{ agent: 'worker', task: 'first' }, { agent: 'reviewer', task: 'second' }, { agent: 'scout', task: 'third' }] };
  const details = (toolCall.result as any).details;
  details.mode = 'parallel';
  const originalChild = details.results[0];
  details.results = ['worker', 'reviewer', 'scout'].map((agent, index) => ({ ...originalChild, id: `runtime-child-${index}`, agent, task: `display child ${index}` }));
  mount(toolCall, prefsWith({ autoExpandSubagentCalls: true }), undefined, captureSession);
  assert.equal(messages.length, 0);
  const names = Array.from(container.querySelectorAll<HTMLElement>('.subagent-agent-name'));
  assert.deepEqual(names.map((name) => name.textContent), ['worker', 'reviewer', 'scout']);
  for (const name of names) {
    const before: number = messages.length;
    const host = await openDetailsTooltip(name);
    assert.equal(messages.length, before + 1);
    settleCapture(messages, toolCall, host);
    assert.doesNotMatch(host.textContent ?? '', /runtime-child-|display child/);
    act(() => { name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    assert.equal(host.style.display, 'none');
  }
  const keys = messages.filter((message) => message.type === 'requestDetail').map((message) => message.ref.key);
  assert.equal(new Set(keys).size, 1, 'every child uses the original parent ToolCall identity');
});

test('nested agent-name inspection is safely unavailable when the exact child session is unknown', async () => {
  const messages = captureRequests();
  mount(nestedSubagentToolCall(), prefsWith({ autoExpandSubagentCalls: true }), undefined, captureSession);
  const names = container.querySelectorAll<HTMLElement>('.subagent-agent-name');
  assert.equal(names.length, 2);
  assert.equal(names[1].textContent, 'scout');
  const host = await openDetailsTooltip(names[1]);
  assertCapturedInspector(host);
  assert.match(host.textContent ?? '', /child durable session identity is not available/);
  assert.equal(messages.length, 0, 'must not request the parent session with a nested tool ID');
  assert.doesNotMatch(host.textContent ?? '', /Recon complete|recon the codebase/);
});

test('long agent names retain their full accessible inspection label and bounded ellipsis styling', async () => {
  const toolCall = requestedAgentToolCall('worker');
  const agent = 'worker'.repeat(100);
  (toolCall.result as any).details.results[0].agent = agent;
  mount(toolCall, prefsWith({ autoExpandSubagentCalls: false }));
  assert.equal(agentName().textContent, agent);
  assert.equal(agentName().getAttribute('aria-label'), `Inspect ${agent} model exchange`);
  const css = await readFile(new URL('../../../styles/tool-call.css', import.meta.url), 'utf8');
  assert.match(css, /\.subagent-agent-trigger\s*\{[^}]*max-width:\s*100%[^}]*flex:\s*0 1 auto/);
  assert.match(css, /\.subagent-agent-trigger > \.pie-tooltip-trigger\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/);
  assert.match(css, /\.subagent-agent-name\s*\{[^}]*flex:\s*0 1 auto[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.subagent-messages-scroll\[tabindex="0"\]:focus-visible\s*\{[^}]*outline:/);
});

test('agent-name raw inspection retains focus and dismissal without toggling the header', async () => {
  const messages = captureRequests();
  const toolCall = requestedAgentToolCall('reviewer');
  mount(toolCall, prefsWith({ autoExpandSubagentCalls: false }), undefined, captureSession);
  const name = agentName();
  assert.equal(name.tabIndex, 0);
  const host = await openDetailsTooltip(name, 'focus');
  settleCapture(messages, toolCall, host);
  assert.equal(document.activeElement, name);
  const header = container.querySelector<HTMLElement>('.subagent-header');
  assert.ok(header);
  assert.equal(header.getAttribute('aria-expanded'), 'false', 'focus alone does not expand');
  for (const key of ['Enter', ' ', 'Escape']) {
    if (host.style.display === 'none') await openDetailsTooltip(name);
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    act(() => { name.dispatchEvent(event); });
    assert.equal(header.getAttribute('aria-expanded'), 'false');
    assert.equal(host.style.display, 'none', 'activation dismisses inspection');
    assert.equal(document.activeElement, name);
    assert.equal(event.defaultPrevented, true);
  }
  for (const expanded of ['true', 'false']) {
    act(() => header.click());
    assert.equal(header.getAttribute('aria-expanded'), expanded);
    const clickHost = await openDetailsTooltip(name);
    act(() => { name.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.equal(header.getAttribute('aria-expanded'), expanded);
    assert.equal(clickHost.style.display, 'none');
  }
});

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

test('subagent tooltip omits unknown and known-zero cache rows while preserving output zero', async () => {
  const toolCall = costEvidenceToolCall({ output: 0, cacheRead: 0, cacheWrite: 0 });
  mount(toolCall, prefsWith({ autoExpandSubagentCalls: false }));
  const host = await openModelTooltip();
  assert.match(host.textContent ?? '', /Output0 tok/);
  assert.doesNotMatch(host.textContent ?? '', /Cache read|Cache write/, 'known-zero cache rows are omitted');
  assert.doesNotMatch(host.textContent ?? '', /More usage/, 'no empty additional-metrics section');
  const rowLabels = Array.from(host.querySelectorAll<HTMLElement>('.subagent-detail-row'), (row) => row.firstElementChild?.textContent);
  assert.deepEqual(rowLabels, ['Output'], 'unknown and known-zero metrics are omitted');

  act(() => render(null, container));
  mount(costEvidenceToolCall({ input: 10, output: 5, cacheRead: 0, cacheWrite: 20 }), prefsWith({ autoExpandSubagentCalls: false }));
  const cacheHost = await openModelTooltip();
  assert.doesNotMatch(cacheHost.textContent ?? '', /Cache read/);
  assert.match(cacheHost.textContent ?? '', /Cache write20 tok/, 'nonzero reported cache traffic still renders');
});

test('subagent tooltip omits the handoff section for task-only calls but distinguishes inherited, empty, and unavailable context', async () => {
  const cases = [
    { name: 'task-only', expected: undefined as RegExp | undefined },
    { name: 'inherited', expected: /Inherited latest context · 1 user prompt/ },
    { name: 'empty', expected: /Empty all context · task only/ },
    { name: 'unavailable', expected: /Requested latest context · exact packet unavailable/ },
  ] as const;

  for (const entry of cases) {
    const toolCall = costEvidenceToolCall(undefined);
    toolCall.id = `context-${entry.name}`;
    const child = (toolCall.result as any).details.results[0];
    if (entry.name === 'inherited') {
      child.parentUserContextMode = 'latest';
      child.parentUserContext = '[User prompt]\nParent request';
    } else if (entry.name === 'empty') {
      child.parentUserContextMode = 'all';
      child.parentUserContext = '';
    } else if (entry.name === 'unavailable') {
      (toolCall.input as any).userContext = 'latest';
    }
    act(() => render(null, container));
    mount(toolCall, prefsWith({ autoExpandSubagentCalls: false }));
    const host = await openModelTooltip();
    if (entry.expected) {
      assert.match(host.textContent ?? '', entry.expected, `${entry.name} context summary`);
      const summary = Array.from(host.querySelectorAll<HTMLElement>('.subagent-context-tooltip-summary'))
        .find((item) => item.previousElementSibling?.textContent === 'Context handoff');
      assert.ok(summary, `${entry.name} has a concise context summary line`);
      assert.ok((summary.textContent?.length ?? Infinity) < 100, `${entry.name} summary should stay concise`);
    } else {
      assert.doesNotMatch(host.textContent ?? '', /Context handoff|Task only|Delegated task|report cost evidence/,
        'explicit task-only calls render no handoff section');
    }
  }
});

test('subagent tooltip treats provider-prefix-only model differences as the same model and labels real fallback', async () => {
  const toolCall = costEvidenceToolCall(undefined);
  const child = (toolCall.result as any).details.results[0];
  child.selectedModel = 'provider/worker-model';
  child.model = 'worker-model';
  child.thinkingLevel = 'high';
  mount(toolCall, prefsWith({ autoExpandSubagentCalls: false }));
  const sameModelHost = await openModelTooltip();
  assert.match(sameModelHost.textContent ?? '', /worker-model/);
  assert.match(sameModelHost.textContent ?? '', /Provider provider · reasoning high/);
  assert.doesNotMatch(sameModelHost.textContent ?? '', /Requested:|Actual runtime model:/);
  assert.equal(container.querySelector('.subagent-model-label')?.getAttribute('title'), null);

  act(() => render(null, container));
  toolCall.id = 'model-identity-fallback';
  child.selectedModel = 'provider/requested-model';
  child.model = 'provider/runtime-model';
  mount(toolCall, prefsWith({ autoExpandSubagentCalls: false }));
  const fallbackHost = await openModelTooltip();
  assert.match(fallbackHost.textContent ?? '', /runtime-model/);
  assert.match(fallbackHost.textContent ?? '', /Requested: requested-model/);
  assert.doesNotMatch(fallbackHost.textContent ?? '', /provider\/requested-model|provider\/runtime-model/);
});

test('subagent tooltip keeps failure details ahead of lower-priority metrics', async () => {
  const toolCall = costEvidenceToolCall({ input: 100, output: 20 });
  const child = (toolCall.result as any).details.results[0];
  child.exitCode = 1;
  child.failureClass = 'provider';
  child.stderr = 'upstream connection failed';
  mount(toolCall, prefsWith({ autoExpandSubagentCalls: false }));

  const host = await openModelTooltip();
  const failure = host.querySelector<HTMLElement>('.subagent-detail-failure');
  assert.ok(failure, 'failure remains visible even when runtime metrics are available');
  assert.match(failure.textContent ?? '', /Failure: provider.*upstream connection failed/s);
  assert.ok((host.textContent ?? '').indexOf('Failure: provider') < (host.textContent ?? '').indexOf('Usage & performance'));
});

test('subagent without cost evidence omits the inline cost and tooltip row', async () => {
  mount(costEvidenceToolCall({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, contextTokens: 100 }), prefsWith({ autoExpandSubagentCalls: false }));

  assert.equal(container.querySelector('.subagent-telemetry-cost'), null);
  assert.equal(container.querySelector('.subagent-runtime-telemetry:not(.subagent-runtime-telemetry-stable)'), null);

  const host = await openModelTooltip();
  assert.match(host.textContent ?? '', /Input100 tok/);
  assert.doesNotMatch(host.textContent ?? '', /Cost/);
});

test('subagent with reported zero cost renders two decimals', async () => {
  mount(costEvidenceToolCall({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, contextTokens: 150, cost: 0 }), prefsWith({ autoExpandSubagentCalls: false }));

  assert.equal(container.querySelector('.subagent-telemetry-cost')?.textContent, '$0.00');

  const host = await openModelTooltip();
  assert.match(host.textContent ?? '', /Cost\$0\.0000/);
});

test('subagent with provider-reported cost renders only the two-decimal USD amount inline', async () => {
  mount(costEvidenceToolCall({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, contextTokens: 150, cost: 0.64 }), prefsWith({ autoExpandSubagentCalls: false }));

  const cost = container.querySelector<HTMLElement>('.subagent-telemetry-cost');
  assert.ok(cost, 'reported cost evidence stays visible in the header');
  assert.ok(cost.closest('.subagent-header'));
  assert.equal(container.querySelector('.subagent-header .subagent-telemetry-cost'), cost);
  assert.equal(cost.closest('[aria-hidden="true"]'), null, 'cost must not depend on header-fit measurement');
  assert.equal(cost.textContent, '$0.64');

  const host = await openModelTooltip();
  assert.match(host.textContent ?? '', /Cost\$0\.6400/);
});

test('small positive reported cost uses two decimals inline and keeps detail precision in the tooltip', async () => {
  mount(costEvidenceToolCall({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, contextTokens: 150, cost: 0.0004 }), prefsWith({ autoExpandSubagentCalls: false }));

  assert.equal(container.querySelector('.subagent-telemetry-cost')?.textContent, '$0.00');
  const host = await openModelTooltip();
  assert.match(host.textContent ?? '', /Cost\$0\.0004/);
});

test('estimated cost has no inline estimate decoration but keeps semantics in hover details', async () => {
  const pricingForModel: TokenPricingResolver = () => ({ input: 4, output: 4, cacheRead: 4, cacheWrite: 4 });
  mount(costEvidenceToolCall({ input: 100_000, output: 60_000, cacheRead: 0, cacheWrite: 0, contextTokens: 160_000 }), prefsWith({ autoExpandSubagentCalls: false }), pricingForModel);

  assert.equal(container.querySelector('.subagent-telemetry-cost')?.textContent, '$0.64');
  assert.doesNotMatch(container.querySelector('.subagent-telemetry-cost')?.textContent ?? '', /~|</);
  const costTelemetry = container.querySelector<HTMLElement>('.subagent-telemetry-cost')?.parentElement;
  assert.match(costTelemetry?.getAttribute('title') ?? '', /Estimated cost: ~\$0\.6400/);
  const host = await openModelTooltip();
  assert.match(host.textContent ?? '', /Estimated cost~\$0\.6400/);
});

test('recovery telemetry remains when no cost is available', () => {
  const toolCall = costEvidenceToolCall(undefined);
  const details = (toolCall.result as any).details;
  details.results[0].retryCount = 1;
  details.results[0].fallback = true;
  mount(toolCall, prefsWith({ autoExpandSubagentCalls: false }));

  assert.equal(container.querySelector('.subagent-telemetry-cost'), null);
  assert.ok(container.querySelector('.subagent-header .subagent-telemetry-recovered'));
});

test('parallel child costs stay separate instead of repeating the group total', () => {
  const toolCall = {
    id: 'parallel-costs',
    name: 'subagent',
    input: { agent: 'worker', task: 'parallel work' },
    status: 'completed',
    result: {
      billing: [
        { path: '0', usage: { cost: 0.01 } },
        { path: '1', usage: { cost: 0.02 } },
      ],
      details: {
        mode: 'parallel',
        results: [
          { agent: 'worker', task: 'first', exitCode: 0, model: 'provider/model', messages: [] },
          { agent: 'scout', task: 'second', exitCode: 0, model: 'provider/model', messages: [] },
        ],
      },
    },
  } as unknown as ToolCall;
  mount(toolCall, prefsWith({ autoExpandSubagentCalls: false }));

  const costs = Array.from(container.querySelectorAll('.subagent-telemetry-cost'), (chip) => chip.textContent);
  assert.deepEqual(costs, ['$0.01', '$0.02']);
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
  assert.equal(scrolls[0].getAttribute('role'), 'region');
  assert.equal(scrolls[0].getAttribute('aria-label'), 'worker subagent transcript');
  assert.equal(scrolls[0].getAttribute('tabindex'), '0');
  act(() => (scrolls[0] as HTMLElement).focus());
  assert.equal(document.activeElement, scrolls[0]);
  for (const attribute of ['role', 'aria-label', 'tabindex']) {
    assert.equal(scrolls[1].getAttribute(attribute), null);
  }
});

test('nested subagent: no resize handles on the nested (free-flowing) body', () => {
  mount(nestedSubagentToolCall(), prefsWith({ autoExpandSubagentCalls: true }));
  const nestedScroll = container.querySelectorAll('.subagent-messages-scroll.subagent-messages-scroll-nested')[0];
  assert.ok(nestedScroll, 'nested scroll element present');
  const resizeHandles = nestedScroll.parentElement?.querySelectorAll('.resize-handle') ?? [];
  assert.equal(resizeHandles.length, 0, 'nested body has no resize handles');
});

test('nested subagent CSS: every header is relative (non-detaching); nested body unbounded', async () => {
  const css = await readFile(new URL('../../../styles/tool-call.css', import.meta.url), 'utf8');
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