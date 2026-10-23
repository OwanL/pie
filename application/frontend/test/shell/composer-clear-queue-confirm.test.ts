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
let posted: WebviewToHostMessage[];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  posted = [];
});

afterEach(() => {
  render(null, container);
  container.remove();
});

const queuedMessage: ChatMessage = {
  id: 'msg-1',
  role: 'user',
  createdAt: new Date().toISOString(),
  markdown: 'queued while busy',
  status: 'queued',
};

function makeProps(sessionPath: string | null): ComponentProps<typeof Composer> {
  return {
    busy: true,
    commandsAvailable: true,
    retryStatus: null,
    sessionPath,
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
    transcript: [queuedMessage],
    transcriptWindow: EMPTY_TRANSCRIPT_WINDOW,
    pendingComposerInputs: [],
    tokenRateBySession: {},
    workingTimeBySession: {},
    compacting: false,
    lastCompaction: null,
    postMessage: (msg: WebviewToHostMessage) => { posted.push(msg); },
    onSend: () => {},
    onRetrySend: () => {},
    onInterrupt: () => {},
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

test('primary intent is visible and dispatches busy, attachment-only, and authorized continue submissions', () => {
  for (const intent of ['Queue', 'Send', 'Continue'] as const) {
    const props = makeProps('/sessions/current.jsonl');
    props.busy = intent === 'Queue';
    props.capabilities = { billableActivity: props.busy, canContinue: intent === 'Continue', canInterrupt: props.busy, canCompact: false };
    props.pendingComposerInputs = intent === 'Continue' ? [] : [{ id: 'path', kind: 'filesystemPathRef', path: '/included.txt', name: 'included.txt', source: 'picker' }];
    let sends = 0;
    props.onSend = () => { sends++; return true; };
    act(() => render(h(Composer, props), container));
    const button = container.querySelector<HTMLButtonElement>('.composer-action-submit')!;
    assert.equal(button.getAttribute('aria-label'), {
      Queue: 'Queue message', Send: 'Send message', Continue: 'Continue agent work',
    }[intent]);
    assert.equal(button.textContent, '', 'icon-only submit button has no visible text');
    assert.ok(button.querySelector('svg'), 'submit intent is represented by its icon');
    assert.equal(button.disabled, false);
    if (intent !== 'Continue') {
      assert.equal(container.querySelector('.composer-attachments-summary')?.textContent, 'Included: 1 path');
    }
    act(() => button.click());
    assert.equal(sends, 1);
    act(() => render(null, container));
  }
});

test('reading a dropped image explains the temporary send block and clears when ready', async () => {
  const props = makeProps('/sessions/current.jsonl');
  props.busy = false;
  props.draftText = 'with image';
  props.activeModelId = 'images';
  props.activeProvider = 'test';
  props.availableModels = [{ id: 'images', name: 'Images', provider: 'test', reasoning: false, inputKinds: ['text', 'image'] }];
  let sends = 0;
  const added: unknown[] = [];
  props.onSend = () => { sends++; return true; };
  props.onAddInput = (input) => { added.push(input); };
  let resolve!: (buffer: ArrayBuffer) => void;
  const transfer = { types: ['Files'], getData: () => '', files: [{ name: 'image.gif', type: 'image/gif', size: 1,
    arrayBuffer: () => new Promise<ArrayBuffer>(done => { resolve = done; }) }] } as unknown as DataTransfer;
  act(() => render(h(Composer, props), container));
  // happy-dom lacks the native ondrop property, so Preact registers onDrop
  // case-sensitively as "Drop" rather than the browser's lowercase "drop".
  const drop = new Event('Drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: transfer });
  await act(async () => { container.querySelector('.composer-shell')!.dispatchEvent(drop); });
  assert.equal(typeof resolve, 'function', 'the drop starts the delayed image read');
  assert.match(container.querySelector('.composer-send-progress')!.textContent!, /Reading attachments/);
  assert.equal(container.querySelector<HTMLButtonElement>('.composer-action-submit')!.disabled, true);
  act(() => {
    container.querySelector<HTMLButtonElement>('.composer-action-submit')!.click();
    container.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  assert.equal(sends, 0, 'neither click nor Enter dispatches while the image is being read');
  assert.equal(added.length, 0);
  await act(async () => { resolve(new Uint8Array([1]).buffer); await new Promise(done => setTimeout(done, 0)); });
  assert.equal(container.querySelector('.composer-send-progress'), null);
  assert.equal(added.length, 1, 'the completed image is accepted');
  assert.equal(container.querySelector<HTMLButtonElement>('.composer-action-submit')!.disabled, false);
  act(() => container.querySelector<HTMLButtonElement>('.composer-action-submit')!.click());
  assert.equal(sends, 1);
});

test('stop and reconciliation show transient progress without allowing dispatch', () => {
  for (const stopping of [true, false]) {
    const props = makeProps('/sessions/current.jsonl');
    props.draftText = 'do not send';
    props.interrupting = stopping;
    props.capabilities = {
      billableActivity: true, canContinue: false, canInterrupt: true, canCompact: false,
      primaryOperation: { operationId: 'op', kind: stopping ? 'message.interrupt' : 'message.send', phase: 'ambiguous', attempt: 1, committed: false, recovery: 'reconcile' },
    };
    let sends = 0;
    props.onSend = () => { sends++; };
    act(() => render(h(Composer, props), container));
    const button = container.querySelector<HTMLButtonElement>('.composer-action-submit')!;
    assert.equal(button.disabled, true);
    assert.match(container.querySelector('.composer-send-progress')!.textContent!, stopping ? /Stopping/ : /Reconciling/);
    act(() => button.click());
    assert.equal(sends, 0);
    act(() => render(null, container));
  }
});

test('ordinary busy work has no duplicate guidance banner and automatic retry is explicit', () => {
  const props = makeProps('/sessions/current.jsonl');
  act(() => render(h(Composer, props), container));
  assert.equal(container.querySelector('.composer-send-progress'), null);
  props.retryStatus = { attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: 'Temporary error' };
  act(() => render(h(Composer, { ...props }), container));
  assert.match(container.querySelector('.composer-retry-label')!.textContent!, /Automatic retry 1 of 3/);
});

test('one click clears queued messages directly for the explicit session path without a dialog', () => {
  act(() => { render(h(Composer, makeProps('/sessions/current.jsonl')), container); });

  const clearButton = container.querySelector<HTMLButtonElement>('[data-action="clear-queue"]');
  assert.ok(clearButton, 'queued messages expose the clear affordance');
  act(() => { clearButton.click(); });

  assert.deepEqual(posted, [{ type: 'clearQueue', sessionPath: '/sessions/current.jsonl' }]);
  assert.equal(container.querySelector('[role="dialog"]'), null, 'clearing does not require confirmation');
});
