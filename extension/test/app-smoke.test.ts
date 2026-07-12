/**
 * Smoke test: mounts the App shell with a canned ViewState and asserts basic
 * rendering + interactions work without acquireVsCodeApi.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './_helpers/dom';
installDom();

// Stub DOMPurify before any component imports
import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { App, EMPTY_VIEW_STATE } from '../src/webview/panel/app';
import type { AppAdapter } from '../src/webview/panel/app';
import type { ViewState, ChatMessage, HostToWebviewMessage } from '../src/shared/protocol';
import { DEFAULT_CHAT_PREFS, EMPTY_TRANSCRIPT_WINDOW } from '../src/shared/protocol';

function makeAdapter(): AppAdapter & { messages: any[] } {
  const messages: any[] = [];
  return {
    messages,
    postMessage: (msg: any) => messages.push(msg),
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
  const stateMsg: HostToWebviewMessage = {
    type: 'state',
    hostInstanceId: 'host-1',
    revision: 1,
    state: sessionViewState(),
  } as any;
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
  // The main transcript area shows the loading wheel + status indicator.
  assert.ok(html.includes('transcript-loading'), 'main transcript area should show a loading wheel');
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
  const stateMsg: HostToWebviewMessage = {
    type: 'state',
    hostInstanceId: 'host-1',
    revision: 1,
    state: sessionViewState(),
  } as any;

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

test('stateApplied telemetry samples DOM after render commit', async () => {
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

  const loadedStateMsg: HostToWebviewMessage = {
    type: 'state',
    hostInstanceId: 'host-1',
    revision: 2,
    state: sessionViewState(),
  } as any;

  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: loadedStateMsg }));
    await Promise.resolve();
  });

  const applied = adapter.messages
    .filter((m) => m.type === 'stateApplied')
    .at(-1);

  assert.ok(applied, 'Should emit stateApplied after applying host state');
  assert.equal(applied.payload.revision, 2);
  assert.equal(applied.payload.backendReady, true);
  assert.equal(applied.payload.transcriptLoaded, true);
  assert.equal(applied.payload.domTranscriptLoaderPresent, false);
  assert.equal(applied.payload.domTabsConnectingPresent, false);
  assert.equal(applied.payload.domRenderSignature, applied.payload.renderSignature);
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
  const stateMsg: HostToWebviewMessage = {
    type: 'state',
    hostInstanceId: 'host-1',
    revision: 1,
    state: sessionViewState({ pendingComposerInputs: [] }),
  } as any;
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
  const confirmedMsg: HostToWebviewMessage = {
    type: 'state',
    hostInstanceId: 'host-1',
    revision: 2,
    state: sessionViewState({ pendingComposerInputs: [imgInput] }),
  } as any;
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: confirmedMsg }));
  });

  assert.ok(container.querySelector('.attachment-card'), 'attachment still shown from the host snapshot after override clears');
});

test('Brief D: stale/duplicate state envelope (revision <= lastApplied, same host) is discarded totally — no new stateApplied, no transcript regression', () => {
  // Transport is snapshots-only; a delayed or re-posted envelope whose
  // revision is not strictly newer than the last applied one (same host
  // instance) is stale. Applying it would regress viewState.transcript to
  // older content while a newer snapshot is already rendered — the "old + new
  // message at once" symptom. The revision guard discards it TOTALLY (returns
  // before setViewState), so no new stateApplied fires and the rendered
  // transcript is untouched. (Asserting via stateApplied telemetry rather than
  // DOM text because the transcript is virtualized — off-fold messages aren't
  // in textContent.)
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState();

  act(() => { render(h(App, { adapter }), container); });

  const state2: HostToWebviewMessage = {
    type: 'state', hostInstanceId: 'host-1', revision: 2, state: sessionViewState(),
  } as any;
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: state2 })); });
  let applied = adapter.messages.filter((m) => m.type === 'stateApplied');
  assert.equal(applied.at(-1)?.payload.revision, 2, 'rev 2 applied');
  const countAfter2 = applied.length;

  // A stale (older revision) snapshot arrives out-of-order — must be
  // DISCARDED: no new stateApplied, last applied still rev 2.
  const state1: HostToWebviewMessage = {
    type: 'state', hostInstanceId: 'host-1', revision: 1, state: sessionViewState(),
  } as any;
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: state1 })); });
  applied = adapter.messages.filter((m) => m.type === 'stateApplied');
  assert.equal(applied.length, countAfter2, 'stale rev 1 discarded — no new stateApplied');
  assert.equal(applied.at(-1)?.payload.revision, 2, 'last applied still rev 2 (no regression)');

  // A duplicate (same revision) is also discarded.
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: state2 })); });
  applied = adapter.messages.filter((m) => m.type === 'stateApplied');
  assert.equal(applied.length, countAfter2, 'duplicate rev 2 discarded — no new stateApplied');
  assert.equal(applied.at(-1)?.payload.revision, 2, 'last applied still rev 2');
});

test('Brief D: a host-instance change rebases the revision guard (a fresh host\'s rev 1 is accepted, not discarded as stale)', () => {
  // On a host restart the revision counter resets to 1. The guard must ACCEPT
  // the first envelope from the new host instance (rebasing lastRevisionRef),
  // not discard it as stale — otherwise the webview would freeze after a host
  // restart until the new host's revision climbed past the old one.
  const adapter = makeAdapter();
  adapter.initialState = sessionViewState();
  act(() => { render(h(App, { adapter }), container); });

  const state5: HostToWebviewMessage = {
    type: 'state', hostInstanceId: 'host-1', revision: 5, state: sessionViewState(),
  } as any;
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: state5 })); });
  assert.equal(adapter.messages.filter((m) => m.type === 'stateApplied').at(-1)?.payload.revision, 5);

  // Host restart: new instance, revision resets to 1 — must be ACCEPTED.
  const state1NewHost: HostToWebviewMessage = {
    type: 'state', hostInstanceId: 'host-2', revision: 1, state: sessionViewState(),
  } as any;
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: state1NewHost })); });
  assert.equal(adapter.messages.filter((m) => m.type === 'stateApplied').at(-1)?.payload.revision, 1, 'fresh host rev 1 accepted after host-instance change');
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
      data: { type: 'state', hostInstanceId: 'host-1', revision: 1, state: sessionViewState({
        notice: 'Pruning took too long to start this turn.',
        noticeKind: 'prepass-timeout',
      }) } as any,
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
      data: { type: 'state', hostInstanceId: 'host-1', revision: 1, state: sessionViewState({
        notice: "Couldn't send your message. Please try again.",
        noticeKind: 'send-failed',
      }) } as any,
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
      data: { type: 'state', hostInstanceId: 'host-1', revision: 1, state: sessionViewState({ busy: true, runningSessionPaths: ['/session/a'] }) } as any,
    }));
  });

  // While busy, the Stop button is shown (not the "Stopping…" state).
  const stopBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Interrupt response"]');
  assert.ok(stopBtn, 'Stop button rendered while busy');
  assert.ok((stopBtn!.textContent ?? '').includes('Stop'));

  // Click → the optimistic interrupting flag flips synchronously (one frame),
  // rendering "Stopping…" BEFORE the host round-trip clears `busy`.
  const before = adapter.messages.length;
  act(() => { stopBtn!.click(); });
  assert.ok(container.querySelector('button[aria-label="Stopping response"]'), '"Stopping…" rendered within one frame');
  assert.ok((container.textContent ?? '').includes('Stopping…'));
  assert.ok(adapter.messages.slice(before).some((m) => m.type === 'interrupt'), 'interrupt posted to the host');

  // The host round-trip clears busy → interrupting clears → "Stopping…" is gone.
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'state', hostInstanceId: 'host-1', revision: 2, state: sessionViewState({ busy: false, runningSessionPaths: [] }) } as any,
    }));
  });
  assert.equal(container.querySelector('button[aria-label="Stopping response"]'), null, 'Stopping… clears once the host confirms the abort (busy false)');
});
