/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { installDom } from '../helpers/dom';
installDom();

import { h, render, type ComponentProps } from 'preact';
import { act } from 'preact/test-utils';

import {
  DEFAULT_CHAT_PREFS,
  DEFAULT_PRUNING_SETTINGS,
  DEFAULT_SESSION_TITLES_SETTINGS,
  DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
  EMPTY_PROVIDER_GATE_STATS,
  EMPTY_TRANSCRIPT_WINDOW,
  type ChatMessage,
  type WebviewToHostMessage,
} from '../../../lib/protocol/index.js';
import { Composer } from '../../shell/ui';

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
  document.querySelector('[data-inline-confirm]')?.remove();
});

const queuedMessage: ChatMessage = {
  id: 'msg-1',
  role: 'user',
  createdAt: new Date().toISOString(),
  markdown: 'queued while busy',
  status: 'queued',
};

interface ComposerScenario {
  sessionPath: string | null;
  transcript: ChatMessage[];
  commandsAvailable?: boolean;
  busy?: boolean;
}

function makeProps(scenario: ComposerScenario): ComponentProps<typeof Composer> {
  return {
    busy: scenario.busy ?? true,
    commandsAvailable: scenario.commandsAvailable ?? true,
    retryStatus: null,
    sessionPath: scenario.sessionPath,
    draftText: '',
    modelSettings: null,
    availableModels: [],
    availableExtensions: [],
    contextUsage: null,
    initialContextEstimate: null,
    prefs: { ...DEFAULT_CHAT_PREFS },
    pruningSettings: DEFAULT_PRUNING_SETTINGS,
    pruningCatalog: { skills: [], tools: [] },
    pruningResult: null,
    toolResultPruningSettings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
    sessionTitlesSettings: DEFAULT_SESSION_TITLES_SETTINGS,
    providerGateStats: EMPTY_PROVIDER_GATE_STATS,
    systemPrompts: [],
    transcript: scenario.transcript,
    transcriptWindow: EMPTY_TRANSCRIPT_WINDOW,
    pendingComposerInputs: [],
    tokenRateBySession: {},
    workingTimeBySession: {},
    compacting: false,
    lastCompaction: null,
    postMessage: (msg: WebviewToHostMessage) => { posted.push(msg); },
    onSend: () => {},
    onRetrySend: () => {},
    onInterrupt: () => { interrupts += 1; },
    onAddInput: () => {},
    onRemoveInput: () => {},
    onModelChange: () => {},
    onSetPrefs: () => {},
    mcpServers: [],
    mcpPendingApply: false,
    mcpSessionServers: [],
    mcpSessionPendingApply: false,
    onMcpListRequested: () => {},
    onMcpSetServerEnabled: () => {},
    onMcpSetServerEnabledForSession: () => {},
    onSetSystemPromptToggles: () => {},
    onSetPruningSettings: () => {},
    onSetToolResultPruningSettings: () => {},
    onSetSessionTitlesSettings: () => {},
  };
}

let posted: WebviewToHostMessage[];
let interrupts: number;

function mount(scenario: ComposerScenario): void {
  posted = [];
  interrupts = 0;
  act(() => { render(h(Composer, makeProps(scenario)), container); });
}

function reRender(scenario: ComposerScenario): void {
  act(() => { render(h(Composer, makeProps(scenario)), container); });
}

function clearQueueButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('[data-action="clear-queue"]');
  assert.ok(button, 'queued messages must expose the clear affordance');
  return button;
}

function dialog(): HTMLElement {
  const node = container.querySelector('[role="dialog"]');
  assert.ok(node, 'confirm dialog must be open');
  return node as HTMLElement;
}

function dialogOk(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-inline-confirm-ok]')!;
}

function click(element: HTMLElement): void {
  act(() => { element.click(); });
}

function clearQueuePosts(): WebviewToHostMessage[] {
  return posted.filter((msg) => msg.type === 'clearQueue');
}

function escapeKey(target: Element): void {
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })); });
}

test('clicking clear opens the confirm; cancel posts nothing to the host', () => {
  mount({ sessionPath: '/s/a.jsonl', transcript: [queuedMessage] });

  const icon = clearQueueButton();
  click(icon);
  const node = dialog();
  assert.equal(node.textContent, 'Clear queued messages?CancelClear', 'concise message, no added hints');
  const cancel = container.querySelector<HTMLButtonElement>('[data-inline-confirm-cancel]')!;
  assert.equal(cancel.textContent, 'Cancel');
  assert.equal(dialogOk().textContent, 'Clear');

  click(cancel);
  assert.deepEqual(clearQueuePosts(), [], 'cancel must not dispatch clearQueue');
  assert.equal(container.querySelector('[role="dialog"]'), null, 'confirm resolves the dialog');
});

test('confirm dispatches clearQueue exactly once to the explicitly captured session path', () => {
  mount({ sessionPath: '/s/a.jsonl', transcript: [queuedMessage] });

  click(clearQueueButton());
  click(dialogOk());
  assert.deepEqual(posted, [{ type: 'clearQueue', sessionPath: '/s/a.jsonl' }], 'one dispatch with the captured session');
  assert.equal(container.querySelector('[role="dialog"]'), null, 'the dialog resolves after confirming, leaving nothing to re-confirm');

  // A resolved confirm cannot double-post: the second dispatch below only
  // happens after the affordance opened a *fresh* intent.
  click(clearQueueButton());
  click(dialogOk());
  assert.deepEqual(posted, [
    { type: 'clearQueue', sessionPath: '/s/a.jsonl' },
    { type: 'clearQueue', sessionPath: '/s/a.jsonl' },
  ], 'each confirm interaction dispatches at most once');
});

test('Escape cancels the pending clear without posting', () => {
  mount({ sessionPath: '/s/a.jsonl', transcript: [queuedMessage] });

  click(clearQueueButton());
  escapeKey(dialog());

  assert.deepEqual(clearQueuePosts(), []);
  assert.equal(container.querySelector('[role="dialog"]'), null);
});

test('a session switch closes the pending confirm and leaves nothing to dispatch when returning', () => {
  mount({ sessionPath: '/s/first.jsonl', transcript: [queuedMessage] });

  const icon = clearQueueButton();
  click(icon);
  reRender({ sessionPath: '/s/second.jsonl', transcript: [queuedMessage] });
  assert.equal(container.querySelector('[role="dialog"]'), null, 'session change invalidates the pending intent');
  assert.deepEqual(clearQueuePosts(), []);

  // Returning to the original session must not resurrect a stale confirm: it
  // was bound to the session at capture time and was cancelled, not deferred.
  reRender({ sessionPath: '/s/first.jsonl', transcript: [queuedMessage] });
  assert.equal(container.querySelector('[role="dialog"]'), null, 'no stale confirm returns');
  assert.deepEqual(clearQueuePosts(), []);
  click(clearQueueButton());
  assert.equal(container.querySelector('[role="dialog"]')!.textContent, 'Clear queued messages?CancelClear', 'a fresh intent opens a fresh confirm');
  click(dialogOk());
  assert.deepEqual(clearQueuePosts(), [{ type: 'clearQueue', sessionPath: '/s/first.jsonl' }]);
});

test('a disconnected renderer (commands unavailable) cannot clear, even on explicit confirm', () => {
  mount({ sessionPath: '/s/a.jsonl', transcript: [queuedMessage] });

  click(clearQueueButton());
  reRender({ sessionPath: '/s/a.jsonl', transcript: [queuedMessage], commandsAvailable: false });
  assert.equal(container.querySelector('[role="dialog"]'), null, 'disconnect immediately invalidates the pending intent');

  reRender({ sessionPath: '/s/a.jsonl', transcript: [queuedMessage], commandsAvailable: true });
  assert.equal(container.querySelector('[role="dialog"]'), null, 'reconnect does not resurrect the stale intent');
  assert.deepEqual(clearQueuePosts(), [], 'no clearQueue without an available host connection');
});

test('a drained queue invalidates the pending intent so confirm clears nothing', () => {
  mount({ sessionPath: '/s/a.jsonl', transcript: [queuedMessage] });

  click(clearQueueButton());
  reRender({ sessionPath: '/s/a.jsonl', transcript: [], busy: false });
  assert.equal(container.querySelector('[role="dialog"]'), null, 'draining the queue immediately invalidates the pending intent');

  reRender({ sessionPath: '/s/a.jsonl', transcript: [queuedMessage] });
  assert.equal(container.querySelector('[role="dialog"]'), null, 'a later queue does not resurrect the stale intent');
  assert.deepEqual(clearQueuePosts(), [], 'an empty queue must not produce a clearQueue dispatch');
});

test('the stop flow still works while the clear confirm is open', () => {
  mount({ sessionPath: '/s/a.jsonl', transcript: [queuedMessage] });

  click(clearQueueButton());
  const stop = container.querySelector<HTMLButtonElement>('[data-action="stop"]');
  assert.ok(stop, 'stop stays available with the confirm open');
  click(stop);
  assert.equal(interrupts, 1, 'interrupt is not disturbed by the pending clear intent');
  assert.deepEqual(clearQueuePosts(), [], 'stop must not dispatch clearQueue');
});

test('focus returns to the clear-queue icon when the confirm resolves', () => {
  mount({ sessionPath: '/s/a.jsonl', transcript: [queuedMessage] });

  const icon = clearQueueButton();
  act(() => { icon.focus(); });
  click(icon);
  assert.equal(document.activeElement, container.querySelector('[data-inline-confirm-cancel]'), 'the safety default owns initial focus');

  click(container.querySelector<HTMLButtonElement>('[data-inline-confirm-cancel]')!);
  assert.equal(document.activeElement, icon, 'focus restores to the initiating icon');
});
