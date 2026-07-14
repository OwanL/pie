import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../_helpers/dom';
installDom();

// Stub DOMPurify before any component imports
import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useState } from 'preact/hooks';

import { useComposerInput } from '../../../src/webview/panel/composer/hooks';
import type { ComposerInputDraft, WebviewToHostMessage } from '../../../src/shared/protocol';
import { PENDING_SESSION_PREFIX } from '../../../src/shared/tab-behavior';

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
  };
});

// Minimal fake-timer registry so the draft-post debounce can be flushed
// deterministically instead of waiting out a real 300 ms timer.
interface PendingTimeout { fn: () => void; ms: number; id: number }
let pending: PendingTimeout[] = [];
let nextId = 1;
let originalSetTimeout: typeof globalThis.setTimeout;
let originalClearTimeout: typeof globalThis.clearTimeout;

function installFakeTimers() {
  originalSetTimeout = globalThis.setTimeout;
  originalClearTimeout = globalThis.clearTimeout;
  pending = [];
  nextId = 1;
  globalThis.setTimeout = window.setTimeout = ((fn: () => void, ms?: number) => {
    const id = nextId++;
    pending.push({ fn, ms: ms ?? 0, id });
    return id as unknown as number;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = window.clearTimeout = ((id: number) => {
    pending = pending.filter((t) => t.id !== id);
  }) as typeof globalThis.clearTimeout;
}

function restoreTimers() {
  globalThis.setTimeout = window.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = window.clearTimeout = originalClearTimeout;
}

/** Flush every pending timer in registration order. */
function flushTimers() {
  const ready = pending;
  pending = [];
  for (const t of ready) t.fn();
}

interface TestHarnessProps {
  sessionPath: string | null;
  draftText: string;
  postMessage: (msg: WebviewToHostMessage) => void;
}

function TestHarness({ sessionPath, draftText, postMessage }: TestHarnessProps) {
  const { text, textareaRef, handleInput } = useComposerInput({
    busy: false,
    onSend: () => {},
    onRetrySend: () => {},
    pendingComposerInputsLength: 0,
    sessionPath,
    draftText,
    postMessage,
    onAddInput: (_input: ComposerInputDraft) => {},
    supportsImageInputs: false,
  });

  return (
    h('textarea', {
      ref: textareaRef,
      value: text,
      onInput: handleInput,
      'aria-label': 'Message composer',
    })
  );
}

test('useComposerInput seeds text from draftText on mount and session switch', () => {
  const posted: WebviewToHostMessage[] = [];

  act(() => {
    render(
      h(TestHarness, {
        sessionPath: '/s',
        draftText: 'persisted draft',
        postMessage: (msg) => { posted.push(msg); },
      }),
      container,
    );
  });

  const textarea = container.querySelector('textarea');
  assert.ok(textarea);
  assert.equal((textarea as HTMLTextAreaElement).value, 'persisted draft');
});

test('useComposerInput posts setComposerDraft after debounced typing', async () => {
  const posted: WebviewToHostMessage[] = [];
  installFakeTimers();

  try {
    act(() => {
      render(
        h(TestHarness, {
          sessionPath: '/s',
          draftText: '',
          postMessage: (msg) => { posted.push(msg); },
        }),
        container,
      );
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    assert.ok(textarea);

    act(() => {
      textarea.value = 'typed draft';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // After typing, a 300 ms debounce timeout should be pending.
    const debounce = pending.find((t) => t.ms === 300);
    assert.ok(debounce, 'debounce timeout should be scheduled');

    // Flush the debounce timeout.
    pending = pending.filter((t) => t.id !== debounce.id);
    debounce.fn();

    const draftMsg = posted.find((m) => m.type === 'setComposerDraft');
    assert.ok(draftMsg, 'setComposerDraft should be posted');
    assert.equal(draftMsg.type, 'setComposerDraft');
    assert.equal((draftMsg as any).sessionPath, '/s');
    assert.equal((draftMsg as any).text, 'typed draft');
  } finally {
    restoreTimers();
  }
});

test('useComposerInput does not post setComposerDraft when sessionPath is null', async () => {
  const posted: WebviewToHostMessage[] = [];
  installFakeTimers();

  try {
    act(() => {
      render(
        h(TestHarness, {
          sessionPath: null,
          draftText: '',
          postMessage: (msg) => { posted.push(msg); },
        }),
        container,
      );
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    assert.ok(textarea);

    act(() => {
      textarea.value = 'orphan text';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Advance the debounce deterministically instead of a real 350 ms wait.
    act(() => {
      flushTimers();
    });

    assert.equal(posted.some((m) => m.type === 'setComposerDraft'), false);
  } finally {
    restoreTimers();
  }
});

test('useComposerInput preserves in-progress text across pending→resolved path resolution', () => {
  // Regression: while a new session is still loading (active path is the
  // pending tab path), the user types into the composer. When the backend
  // resolves the path, the host posts a state snapshot whose draftText for the
  // resolved path is '' (the debounced setComposerDraft never fired, and the
  // draft was keyed under the pending path). The composer's [sessionPath] seed
  // effect must NOT clobber the live `text` with that stale empty draft — the
  // typed message would otherwise be silently cut off when the session
  // finished loading.
  const posted: WebviewToHostMessage[] = [];
  const PENDING = `${PENDING_SESSION_PREFIX}abc-123`;
  const RESOLVED = '/workspace/sessions/real-session.jsonl';
  const post = (m: WebviewToHostMessage) => { posted.push(m); };

  installFakeTimers();
  try {
    act(() => {
      render(h(TestHarness, { sessionPath: PENDING, draftText: '', postMessage: post }), container);
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    assert.ok(textarea);

    // User types during the loading window. Do NOT flush the 300 ms debounce —
    // the session resolves mid-typing, before the draft reaches the host.
    act(() => {
      textarea.value = 'hello world';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(textarea.value, 'hello world');

    // Session finishes loading: host swaps the active path pending→resolved and
    // posts draftText='' for the resolved path (draft was never persisted).
    act(() => {
      render(h(TestHarness, { sessionPath: RESOLVED, draftText: '', postMessage: post }), container);
    });

    // The in-progress text must survive the path resolution.
    assert.equal(textarea.value, 'hello world');

    // Flushing the debounce now re-posts the draft under the RESOLVED path,
    // so the host's source of truth catches up to the real session.
    act(() => {
      flushTimers();
    });

    const draftMsgs = posted.filter((m) => m.type === 'setComposerDraft') as Array<{ sessionPath: string; text: string }>;
    const resolvedDraft = draftMsgs.find((m) => m.sessionPath === RESOLVED);
    assert.ok(resolvedDraft, 'setComposerDraft should be re-posted under the resolved path');
    assert.equal(resolvedDraft?.text, 'hello world');
  } finally {
    restoreTimers();
  }
});
