/**
 * Smoke test: mounts the App shell with a canned ViewState and asserts basic
 * rendering + interactions work without acquireVsCodeApi.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../_helpers/dom';
installDom();

// Stub DOMPurify before any component imports
import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { App, EMPTY_VIEW_STATE } from '../../../src/webview/panel/app';
import type { AppAdapter } from '../../../src/webview/panel/app';
import type { ViewState, ChatMessage, HostToWebviewMessage, ExtensionUIRequestPayload } from '../../../src/shared/protocol';
import { DEFAULT_CHAT_PREFS, EMPTY_TRANSCRIPT_WINDOW, WEBVIEW_PROTOCOL_VERSION } from '../../../src/shared/protocol';
import type { ClientTransport } from '../../../src/webview/transport/client-transport';

/** Minimal in-memory transport: records outbound, forwards inbound. Mirrors
 *  the real VS Code transport's `window` message channel so tests can keep
 *  dispatching `MessageEvent`s. */
function makeFakeTransport(): ClientTransport & { deliver: (msg: HostToWebviewMessage) => void } {
  const handlers = new Set<(message: HostToWebviewMessage) => void>();
  const stateHandlers = new Set<(state: 'connecting' | 'connected' | 'disconnected') => void>();
  const onWindowMessage = (event: MessageEvent): void => {
    if (!event.data || typeof event.data.type !== 'string') return;
    for (const handler of handlers) handler(event.data as HostToWebviewMessage);
  };
  window.addEventListener('message', onWindowMessage);
  return {
    postMessage: () => true,
    subscribe: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    getConnectionState: () => 'connected',
    onConnectionStateChange: (handler) => {
      stateHandlers.add(handler);
      return () => stateHandlers.delete(handler);
    },
    dispose: () => {
      window.removeEventListener('message', onWindowMessage);
      handlers.clear();
      stateHandlers.clear();
    },
    deliver: (msg) => {
      for (const handler of handlers) handler(msg);
    },
  };
}

function makeAdapter(): AppAdapter & { messages: any[] } {
  const messages: any[] = [];
  const transport = makeFakeTransport();
  const originalPost = transport.postMessage.bind(transport);
  transport.postMessage = (msg: any) => {
    messages.push(msg);
    return originalPost(msg);
  };
  return {
    messages,
    transport,
    postMessage: (msg: any) => messages.push(msg),
  };
}

function stateEnvelope(
  revision: number,
  state: ViewState,
  hostInstanceId = 'host-1',
  viewGeneration = 1,
): Extract<HostToWebviewMessage, { type: 'state' }> {
  return {
    type: 'state',
    protocolVersion: WEBVIEW_PROTOCOL_VERSION,
    hostInstanceId,
    rendererId: 'renderer-1',
    rendererGeneration: 1,
    viewGeneration,
    revision,
    expectedTranscriptIdentity: `identity-${hostInstanceId}-${viewGeneration}-${revision}`,
    snapshotBytes: 321,
    state,
  };
}

function sessionViewState(overrides: Partial<ViewState> = {}): ViewState {
  return {
    ...EMPTY_VIEW_STATE,
    backendReady: true,
    openTabPaths: ['/session/a'],
    activeSession: {
      path: '/session/a',
      name: 'Session A',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 2,
    },
    transcript: [
      {
        id: 'user-1',
        role: 'user',
        createdAt: '2026-01-01T12:00:00.000Z',
        markdown: 'Hello world',
        status: 'completed',
      } as ChatMessage,
      {
        id: 'assistant-1',
        role: 'assistant',
        createdAt: '2026-01-01T12:00:01.000Z',
        markdown: 'Hi there!',
        parts: [{ kind: 'text', text: 'Hi there!' }],
        status: 'completed',
        modelId: 'test-model',
        thinkingLevel: 'off',
      } as ChatMessage,
    ],
    transcriptWindow: { ...EMPTY_TRANSCRIPT_WINDOW, hasNewer: false, hasOlder: false },
    transcriptLoaded: true,
    ...overrides,
  };
}

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  container.id = 'app';
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
  };
});

test('App renders composer when session is active', () => {
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState();

  act(() => {
    render(h(App, { adapter }), container);
  });

  const textarea = container.querySelector('textarea');
  assert.ok(textarea, 'Composer textarea should be rendered');
});

test('App composer keeps the quiet prompt-box focus treatment', () => {
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState();

  act(() => {
    render(h(App, { adapter }), container);
  });

  const textarea = container.querySelector('textarea');
  assert.ok(textarea, 'Composer textarea should be rendered');
  assert.match(textarea.className, /outline-none/);

  const composerShell = textarea.parentElement;
  assert.ok(composerShell, 'Composer shell should wrap the textarea');
  assert.match(composerShell.className, /border-transparent/);
  assert.match(composerShell.className, /focus-within:border-border-subtle\/80/);
  assert.doesNotMatch(composerShell.className, /focus-within:border-accent/);
});

test('App renders transcript area when session is active', () => {
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState();

  act(() => {
    render(h(App, { adapter }), container);
  });

  // The transcript scroll container should be present even if virtualizer
  // doesn't render rows (no real layout in happy-dom).
  const panelMain = container.querySelector('.panel-main');
  assert.ok(panelMain, 'Should render panel-main container');
});

test('App keeps a fixed answer surface for a subagent question when its transcript card is stale', () => {
  const adapter = makeAdapter();
  const request: ExtensionUIRequestPayload = {
    id: 'ask-subagent-1',
    sessionPath: '/session/a',
    extensionId: 'ask-user',
    method: 'select',
    title: 'Keep the documentation block?',
    options: ['Keep it', 'Remove it'],
    subagentCallId: 'subagent-tool-1',
    toolCallId: 'subagent-tool-1',
  };
  adapter.initialState = sessionViewState({
    // Deliberately leave the transcript on its older content: the global
    // pending-request state can arrive before (or recover independently of)
    // the nested subagent transcript update.
    pendingExtensionUIRequestsBySession: {
      '/session/a': { [request.id]: request },
    },
    pendingExtensionUIRequest: request,
  });

  act(() => {
    render(h(App, { adapter }), container);
  });

  const prompt = container.querySelector('.ext-prompt');
  assert.ok(prompt, 'subagent ask_user must not depend exclusively on its inline transcript card');
  assert.match(prompt.textContent ?? '', /Keep the documentation block\?/);
  assert.match(prompt.textContent ?? '', /Subagent/);

  const keepButton = Array.from(prompt.querySelectorAll('button'))
    .find((button) => button.textContent === 'Keep it');
  assert.ok(keepButton);
  act(() => {
    keepButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  assert.ok(adapter.messages.some((message) =>
    message.type === 'extensionUiResponse'
      && message.sessionPath === '/session/a'
      && message.response?.id === request.id
      && message.response?.value === 'Keep it'
  ));
});

test('App does not keep the transcript loader for a loaded empty session', () => {
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState({
    activeSession: {
      path: '/session/a',
      name: 'Session A',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 0,
    },
    transcript: [],
    transcriptWindow: { ...EMPTY_TRANSCRIPT_WINDOW },
    transcriptLoaded: true,
    systemPrompts: [],
  });

  act(() => {
    render(h(App, { adapter }), container);
  });

  assert.equal(
    container.querySelector('.transcript-loading'),
    null,
    'Should stop showing the transcript loader once an empty session has loaded',
  );
  assert.ok(container.querySelector('textarea'), 'Composer should remain available for an empty session');
});

test('App posts ready message on mount', () => {
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState();

  act(() => {
    render(h(App, { adapter }), container);
  });

  assert.ok(
    adapter.messages.some((m) => m.type === 'ready'),
    'Should post ready message on mount',
  );
  assert.ok(
    adapter.messages.some((m) => m.type === 'refreshState'),
    'Should request a fresh host snapshot on mount',
  );
});

test('App posts send message when composer submits', () => {
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState();

  act(() => {
    render(h(App, { adapter }), container);
  });

  // The App seeds first paint from initialState, but handleSend gates on the
  // active-session ref, which is only populated when the host posts a `state`
  // message (use-host-sync.ts). Drive that round-trip so the composer submit
  // actually reaches the host — mirrors the "App handles host state message"
  // test below.
  const stateMsg = stateEnvelope(1, sessionViewState());
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: stateMsg }));
  });

  const textarea = container.querySelector('textarea');
  assert.ok(textarea);

  // Type text
  act(() => {
    (textarea as HTMLTextAreaElement).value = 'test message';
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // Submit: the composer has no <form>; Enter posts the send.
  act(() => {
    textarea!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });

  const sendMsg = adapter.messages.find((m) => m.type === 'send');
  assert.ok(sendMsg, 'Composer submit should post a send message to the host');
  assert.equal(sendMsg!.text, 'test message');
  assert.equal(sendMsg!.sessionPath, '/session/a');
});

test('App renders loading state when backend not ready', () => {
  const adapter = makeAdapter();
  adapter.initialState = { ...EMPTY_VIEW_STATE };

  act(() => {
    render(h(App, { adapter }), container);
  });

  const html = container.innerHTML;
  assert.ok(html.includes('Starting pie'), 'Should show loading state');
});

test('App suppresses the session-tab connecting wheel while the transcript surface is already loading (no double wheel)', () => {
  const adapter = makeAdapter();
  adapter.initialState = {
    ...EMPTY_VIEW_STATE,
    backendReady: false,
    sessions: [{
      path: '/session/a',
      name: 'Session A',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 0,
    }],
    openTabPaths: ['/session/a'],
    activeSession: {
      path: '/session/a',
      name: 'Session A',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 0,
    },
    transcript: [],
    transcriptLoaded: false,
    systemPrompts: [],
  };

  act(() => {
    render(h(App, { adapter }), container);
  });

  const html = container.innerHTML;
  // The main transcript area shows the loading wheel + status indicator. The lazy
  // transcript chunk may already be cached or may still be on its Suspense surface.
  assert.ok(
    html.includes('transcript-loading') || html.includes('transcript-suspense'),
    'main transcript area should show a loading wheel',
  );
  assert.ok(html.includes('loading-ellipsis'), 'a status indicator should accompany the wheel');
  // The session-tab connecting wheel is suppressed to avoid two wheels at once.
  assert.ok(!html.includes('session-tabs-connecting'), 'tabs should not show a competing connecting wheel while the main area is loading');
});

test('App renders empty state when no tabs open', () => {
  const adapter = makeAdapter();
  adapter.initialState = { ...EMPTY_VIEW_STATE, backendReady: true };

  act(() => {
    render(h(App, { adapter }), container);
  });

  const html = container.innerHTML;
  assert.ok(html.includes('Start a session'), 'Should show empty state');
});

test('App recovers when tabs exist but no active session is projected', () => {
  const adapter = makeAdapter();
  adapter.initialState = {
    ...EMPTY_VIEW_STATE,
    backendReady: true,
    sessions: [{
      path: '/session/a',
      name: 'Session A',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 2,
    }],
    openTabPaths: ['/session/a'],
    activeSession: null,
  };

  act(() => {
    render(h(App, { adapter }), container);
  });

  const html = container.innerHTML;
  assert.ok(html.includes('Restoring session'), 'Should show recovery state instead of a blank panel');
  assert.ok(
    adapter.messages.some((m) => m.type === 'openSession' && m.sessionPath === '/session/a'),
    'Should request reopening the first available tab',
  );
});

test('App waits for backend readiness before requesting session recovery', () => {
  const adapter = makeAdapter();
  adapter.initialState = {
    ...EMPTY_VIEW_STATE,
    backendReady: false,
    sessions: [{
      path: '/session/a',
      name: 'Session A',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 2,
    }],
    openTabPaths: ['/session/a'],
    activeSession: null,
  };

  act(() => {
    render(h(App, { adapter }), container);
  });

  assert.ok(container.innerHTML.includes('Restoring session'));
  assert.equal(
    adapter.messages.some((m) => m.type === 'openSession'),
    false,
    'Should not ask the host to open a restored tab before backend startup finishes',
  );
});

test('App retries session recovery request when projection stays unresolved', () => {
  const adapter = makeAdapter();
  adapter.initialState = {
    ...EMPTY_VIEW_STATE,
    backendReady: true,
    sessions: [{
      path: '/session/a',
      name: 'Session A',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 2,
    }],
    openTabPaths: ['/session/a'],
    activeSession: null,
    notice: null,
  };

  const originalSetInterval = window.setInterval;
  const originalClearInterval = window.clearInterval;
  const originalDateNow = Date.now;
  let intervalCallback: (() => void) | null = null;
  let nowMs = 1_000;

  Date.now = () => nowMs;

  window.setInterval = ((callback: TimerHandler) => {
    intervalCallback = callback as () => void;
    return 1 as unknown as number;
  }) as typeof window.setInterval;

  window.clearInterval = (() => {
    intervalCallback = null;
  }) as typeof window.clearInterval;

  try {
    act(() => {
      render(h(App, { adapter }), container);
    });

    const firstRecoveryRequests = adapter.messages.filter(
      (m) => m.type === 'openSession' && m.sessionPath === '/session/a',
    );
    assert.equal(firstRecoveryRequests.length, 1, 'Should send initial recovery request');
    assert.ok(intervalCallback, 'Should arm a retry timer while recovery is unresolved');

    nowMs += 3_000;
    act(() => {
      intervalCallback?.();
    });

    const allRecoveryRequests = adapter.messages.filter(
      (m) => m.type === 'openSession' && m.sessionPath === '/session/a',
    );
    assert.equal(allRecoveryRequests.length, 2, 'Should retry recovery request when state stays unresolved');
  } finally {
    window.setInterval = originalSetInterval;
    window.clearInterval = originalClearInterval;
    Date.now = originalDateNow;
  }
});

test('App handles host state message', () => {
  const adapter = makeAdapter();

  act(() => {
    render(h(App, { adapter }), container);
  });

  // Simulate host sending state
  const stateMsg = stateEnvelope(1, sessionViewState());

  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: stateMsg }));
  });

  // After receiving state with active session, the panel-main should contain
  // the transcript area (virtualizer may not render rows without layout).
  const panelMain = container.querySelector('.panel-main');
  assert.ok(panelMain, 'Should render panel-main after state message');
  // Composer should appear
  const textarea = container.querySelector('textarea');
  assert.ok(textarea, 'Composer should render after state message');
});

test('protocol-v4 stateReceived precedes outer appCommitted evidence', async () => {
  const adapter = makeAdapter();
  adapter.initialState = {
    ...EMPTY_VIEW_STATE,
    backendReady: false,
    openTabPaths: ['/session/a'],
    activeSession: {
      path: '/session/a',
      name: 'Session A',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 0,
    },
    transcript: [],
    transcriptWindow: { ...EMPTY_TRANSCRIPT_WINDOW },
    transcriptLoaded: false,
    systemPrompts: [],
  };

  act(() => {
    render(h(App, { adapter }), container);
  });

  const loadedStateMsg = stateEnvelope(2, sessionViewState());

  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: loadedStateMsg }));
    await Promise.resolve();
  });

  const receivedIndex = adapter.messages.findIndex((message) => message.type === 'stateReceived' && message.payload.revision === 2);
  const committedIndex = adapter.messages.findIndex((message) => message.type === 'appCommitted' && message.payload.revision === 2);
  assert.ok(receivedIndex >= 0, 'acceptance should emit stateReceived');
  assert.ok(committedIndex > receivedIndex, 'outer app commit must follow receipt');
  const received = adapter.messages[receivedIndex];
  assert.equal(received.payload.viewGeneration, 1);
  assert.equal(received.payload.snapshotBytes, 321, 'webview must forward the host-measured envelope bytes unchanged');
});

test('sendRejected.inputs restores composer attachments immediately (inputsRestore override) and the next state snapshot confirms', () => {
  // Brief C: on send rejection the host fires sendRejected carrying `inputs`;
  // the webview stages them as a transient override of pendingComposerInputs
  // so the attachments reappear instantly (before the debounced host snapshot
  // arrives). The next `state` message (host-restored inputs) clears the
  // override with no flicker.
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState();

  act(() => {
    render(h(App, { adapter }), container);
  });

  // Prime the active-session ref so the sendRejected handler can route the
  // draft restore to the active session.
  const stateMsg = stateEnvelope(1, sessionViewState({ pendingComposerInputs: [] }));
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: stateMsg }));
  });

  // No attachments yet.
  assert.equal(container.querySelector('.attachment-card'), null);

  // sendRejected carrying a pasted/dropped attachment.
  const imgInput = { id: 'in1', kind: 'filesystemPathRef' as const, path: '/f', name: 'f', source: 'picker' as const };
  const rejectedMsg: HostToWebviewMessage = {
    type: 'sendRejected',
    sessionPath: '/session/a',
    text: 'try again',
    inputs: [imgInput],
  } as any;
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: rejectedMsg }));
  });

  // The attachment reappears immediately via the inputsRestore override
  // (the host snapshot has not arrived yet).
  const card = container.querySelector('.attachment-card');
  assert.ok(card, 'composer should show the restored attachment immediately');
  assert.ok(card!.textContent!.includes('f'), 'attachment card should name the input');

  // The draft text is also restored.
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
  assert.equal(textarea.value, 'try again');

  // The next state snapshot carries the host-restored inputs; the override is
  // cleared and the authoritative snapshot takes over (no flicker, same card).
  const confirmedMsg = stateEnvelope(2, sessionViewState({ pendingComposerInputs: [imgInput] }));
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: confirmedMsg }));
  });

  assert.ok(container.querySelector('.attachment-card'), 'attachment still shown from the host snapshot after override clears');
});

test('background send rejection does not restore its draft or inputs into the active composer', () => {
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState();
  act(() => { render(h(App, { adapter }), container); });
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: stateEnvelope(1, sessionViewState()) }));
  });

  const backgroundInput = {
    id: 'background-input',
    kind: 'filesystemPathRef' as const,
    path: '/background-file',
    name: 'background-file',
    source: 'picker' as const,
  };
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'sendRejected',
        sessionPath: '/session/b',
        localId: 'local:background',
        text: 'background draft',
        inputs: [backgroundInput],
      } satisfies HostToWebviewMessage,
    }));
  });

  assert.equal((container.querySelector('textarea') as HTMLTextAreaElement).value, '');
  assert.equal(
    container.querySelector('.attachment-card'),
    null,
    'a background rejection must not attach files to the active session composer',
  );
});

test('Brief D: stale/duplicate state envelope is discarded without fresh receipt evidence', () => {
  // Transport is snapshots-only; a delayed or re-posted envelope whose
  // revision is not strictly newer than the last applied one (same host
  // instance) is stale. Applying it would regress viewState.transcript to
  // older content while a newer snapshot is already rendered — the "old + new
  // message at once" symptom. The revision guard discards it TOTALLY (returns
  // before setViewState), so no fresh receipt evidence fires and the rendered
  // transcript is untouched. (Asserting via protocol evidence rather than DOM
  // text because the transcript is virtualized.)
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState();

  act(() => { render(h(App, { adapter }), container); });

  const state2 = stateEnvelope(2, sessionViewState());
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: state2 })); });
  let received = adapter.messages.filter((m) => m.type === 'stateReceived');
  assert.equal(received.at(-1)?.payload.revision, 2, 'rev 2 accepted');
  const countAfter2 = received.length;

  // A stale (older revision) snapshot arrives out-of-order — it must be
  // discarded without fresh stateReceived evidence.
  const state1 = stateEnvelope(1, sessionViewState());
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: state1 })); });
  received = adapter.messages.filter((m) => m.type === 'stateReceived');
  assert.equal(received.length, countAfter2, 'stale rev 1 discarded — no fresh receipt');
  assert.equal(received.at(-1)?.payload.revision, 2, 'last accepted revision remains 2');

  // A duplicate (same revision) is also discarded.
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: state2 })); });
  received = adapter.messages.filter((m) => m.type === 'stateReceived');
  assert.equal(received.length, countAfter2, 'duplicate rev 2 discarded — no fresh receipt');
  assert.equal(received.at(-1)?.payload.revision, 2, 'last accepted revision remains 2');
});

test('Brief D: a host-instance change rebases the revision guard (a fresh host\'s rev 1 is accepted, not discarded as stale)', () => {
  // On a host restart the revision counter resets to 1. The guard must ACCEPT
  // the first envelope from the new host instance (rebasing lastRevisionRef),
  // not discard it as stale — otherwise the webview would freeze after a host
  // restart until the new host's revision climbed past the old one.
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState();
  act(() => { render(h(App, { adapter }), container); });

  const state5 = stateEnvelope(5, sessionViewState());
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: state5 })); });
  assert.equal(adapter.messages.filter((m) => m.type === 'stateReceived').at(-1)?.payload.revision, 5);

  // Host restart: new instance, revision resets to 1 — must be ACCEPTED.
  const state1NewHost = stateEnvelope(1, sessionViewState(), 'host-2');
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: state1NewHost })); });
  assert.equal(adapter.messages.filter((m) => m.type === 'stateReceived').at(-1)?.payload.revision, 1, 'fresh host rev 1 accepted after host-instance change');
});

// ─── Brief H: NoticeBanner recovery action buttons (wired) ─────────────────
// The NoticeBanner renders recovery action buttons for a projected noticeKind
// (Brief H). Retry / Retry-without-pruning re-send the live composer draft as a
// `retrySend` (the host disables pruning atomically first for the latter);
// Show logs / Open settings / Restart backend post the matching side-effect
// message. Retry + Restart dismiss the notice; Show logs / Open settings do not.

function findNoticeAction(container: HTMLElement, label: string): HTMLButtonElement | null {
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button.notice-action'));
  for (const b of buttons) {
    if ((b.textContent ?? '').trim() === label) return b;
  }
  return null;
}

test('Brief H: NoticeBanner renders recovery action buttons for a projected noticeKind', () => {
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState({
    notice: 'Pruning took too long to start this turn. You can retry, or retry without pruning.',
    noticeKind: 'prepass-timeout',
  });
  act(() => { render(h(App, { adapter }), container); });

  // prepass-timeout → [retry, retry-without-pruning, open-settings] (noticeActionsFor).
  assert.ok(findNoticeAction(container, 'Retry'), 'Retry button renders');
  assert.ok(findNoticeAction(container, 'Retry without pruning'), 'Retry-without-pruning button renders');
  assert.ok(findNoticeAction(container, 'Open settings'), 'Open settings button renders');
  // No restart-backend / show-logs for this kind.
  assert.equal(findNoticeAction(container, 'Restart backend'), null);
  assert.equal(findNoticeAction(container, 'Show logs'), null);
});

test('Brief H: NoticeBanner renders [retry, show-logs] for a model-start-timeout (concurrency wait, not pruning)', () => {
  // Pruning already succeeded; the elapsed budget was the model-start budget.
  // The notice blames model-start (concurrency/rate-limit), so the pruning
  // remedies (retry-without-pruning, open-settings) do NOT apply.
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState({
    notice: 'The model took too long to start this turn (it exceeded the 600s budget) — it may be waiting for an available concurrency slot or rate limit. You can retry, or show the logs for details.',
    noticeKind: 'model-start-timeout',
  });
  act(() => { render(h(App, { adapter }), container); });

  assert.ok(findNoticeAction(container, 'Retry'), 'Retry button renders');
  assert.ok(findNoticeAction(container, 'Show logs'), 'Show logs button renders');
  // Pruning remedies do NOT apply (pruning already succeeded).
  assert.equal(findNoticeAction(container, 'Retry without pruning'), null);
  assert.equal(findNoticeAction(container, 'Open settings'), null);
  assert.equal(findNoticeAction(container, 'Restart backend'), null);
});

test('operational error More reveals the exact backend diagnostic', () => {
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState({
    notice: 'The provider stopped producing semantic response events.',
    noticeKind: 'operational-error',
    noticeRaw: [
      'Code: PROVIDER_SEMANTIC_TIMEOUT',
      'Provider: umans',
      'Last provider error: upstream header phase stalled for 30000ms',
      'Request: req-provider-1',
    ].join('\n'),
  });
  act(() => { render(h(App, { adapter }), container); });

  const more = container.querySelector<HTMLButtonElement>('button.notice-detail');
  assert.equal(more?.textContent?.trim(), 'More');
  assert.equal(container.querySelector('.notice-raw-detail'), null);

  act(() => { more!.click(); });

  const detail = container.querySelector('.notice-raw-detail');
  assert.match(detail?.textContent ?? '', /PROVIDER_SEMANTIC_TIMEOUT/);
  assert.match(detail?.textContent ?? '', /upstream header phase stalled/);
  assert.equal(more?.textContent?.trim(), 'Less');
});

test('Brief H: Show logs posts showLogs WITHOUT dismissing (the error still stands)', () => {
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState({
    notice: 'The backend sent a malformed response.',
    noticeKind: 'dropped-line',
  });
  act(() => { render(h(App, { adapter }), container); });

  const before = adapter.messages.length;
  act(() => { findNoticeAction(container, 'Show logs')!.click(); });

  assert.ok(adapter.messages.slice(before).some((m) => m.type === 'showLogs'), 'showLogs posted');
  // Show logs does NOT dismiss the notice — the error still stands.
  assert.ok(!adapter.messages.slice(before).some((m) => m.type === 'dismissNotice'), 'no dismissNotice on Show logs');
});

test('Brief H: Restart backend posts restartBackend AND dismisses the notice', () => {
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState({
    notice: 'The pie backend stopped unexpectedly. Restart the backend, then retry your message.',
    noticeKind: 'backend-exit',
  });
  act(() => { render(h(App, { adapter }), container); });

  const before = adapter.messages.length;
  act(() => { findNoticeAction(container, 'Restart backend')!.click(); });

  assert.ok(adapter.messages.slice(before).some((m) => m.type === 'restartBackend'), 'restartBackend posted');
  assert.ok(adapter.messages.slice(before).some((m) => m.type === 'dismissNotice'), 'Restart dismisses the notice');
});

test('Brief H: Retry without pruning re-sends the LIVE draft as a retrySend (disablePruning: true) + dismisses', () => {
  // The retry button re-sends the composer's current draft (not the stale
  // draftRestore snapshot), so an edit between rejection and retry is honored.
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState({
    notice: 'Pruning took too long to start this turn.',
    noticeKind: 'prepass-timeout',
  });
  act(() => { render(h(App, { adapter }), container); });
  // Seed activeSessionPathRef (handleRetrySend guards on it) via a state msg,
  // mirroring the existing send test.
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data: stateEnvelope(1, sessionViewState({
        notice: 'Pruning took too long to start this turn.',
        noticeKind: 'prepass-timeout',
      })),
    }));
  });

  // Type a (corrected) draft into the composer — the retry must send THIS text,
  // not a stale restored snapshot.
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
  act(() => {
    textarea.value = 'try again, edited';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const before = adapter.messages.length;
  act(() => { findNoticeAction(container, 'Retry without pruning')!.click(); });
  const after = adapter.messages.slice(before);

  const retry = after.find((m) => m.type === 'retrySend');
  assert.ok(retry, 'retrySend posted on Retry-without-pruning');
  assert.equal(retry!.sessionPath, '/session/a', 'retrySend targets the active session');
  assert.equal(retry!.text, 'try again, edited', 'retrySend carries the LIVE (edited) draft text');
  assert.equal(retry!.disablePruning, true, 'retrySend disables pruning for "retry without pruning"');
  assert.ok(typeof retry!.localId === 'string' && retry!.localId.length > 0, 'retrySend mints a localId for the optimistic message');
  assert.ok(after.some((m) => m.type === 'dismissNotice'), 'Retry dismisses the notice');
  // The composer cleared its draft (the message moved to the transcript).
  assert.equal((container.querySelector('textarea') as HTMLTextAreaElement).value, '', 'composer draft cleared after retry');
});

test('Brief H: plain Retry re-sends the live draft as a retrySend (no disablePruning) + dismisses', () => {
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState({
    notice: "Couldn't send your message. Please try again.",
    noticeKind: 'send-failed',
  });
  act(() => { render(h(App, { adapter }), container); });
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data: stateEnvelope(1, sessionViewState({
        notice: "Couldn't send your message. Please try again.",
        noticeKind: 'send-failed',
      })),
    }));
  });

  const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
  act(() => {
    textarea.value = 'redo';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const before = adapter.messages.length;
  act(() => { findNoticeAction(container, 'Retry')!.click(); });
  const after = adapter.messages.slice(before);

  const retry = after.find((m) => m.type === 'retrySend');
  assert.ok(retry, 'retrySend posted on plain Retry');
  assert.equal(retry!.text, 'redo', 'retrySend carries the live draft');
  assert.equal(retry!.disablePruning, undefined, 'plain Retry does NOT disable pruning');
  assert.ok(after.some((m) => m.type === 'dismissNotice'), 'Retry dismisses the notice');
});

// ─── Brief E: interrupt one-frame "Stopping…" feedback (automatable §12 item) ─
test('Brief E: interrupt reflects "Stopping…" within one frame (optimistic, before the host round-trip clears busy)', () => {
  // The webview sets `interrupting` synchronously in handleInterrupt so the
  // Stop button reflects "Stopping…" within one frame — BEFORE the host
  // round-trip clears `busy` (the host clears busy only once the abort
  // completes). Without this local flag the button would keep showing "Stop"
  // until the round-trip lands.
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState({ busy: true, runningSessionPaths: ['/session/a'] });
  act(() => { render(h(App, { adapter }), container); });
  // Seed activeSessionPathRef (handleInterrupt guards on it) via a state msg.
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data: stateEnvelope(1, sessionViewState({ busy: true, runningSessionPaths: ['/session/a'] })),
    }));
  });

  // While busy, the Stop button is shown (not the "Stopping…" state).
  const stopBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Interrupt response"]');
  assert.ok(stopBtn, 'Stop button rendered while busy');

  // Click → the optimistic interrupting flag flips synchronously (one frame),
  // rendering "Stopping…" BEFORE the host round-trip clears `busy`.
  const before = adapter.messages.length;
  act(() => { stopBtn!.click(); });
  assert.ok(container.querySelector('button[aria-label="Stopping response"]'), '"Stopping…" rendered within one frame');
  assert.ok(adapter.messages.slice(before).some((m) => m.type === 'interrupt'), 'interrupt posted to the host');

  // The host round-trip clears busy → interrupting clears → "Stopping…" is gone.
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data: stateEnvelope(2, sessionViewState({ busy: false, runningSessionPaths: [] })),
    }));
  });
  assert.equal(container.querySelector('button[aria-label="Stopping response"]'), null, 'Stopping… clears once the host confirms the abort (busy false)');
});
