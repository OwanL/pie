import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../_helpers/dom';
installDom();

// Stub DOMPurify before any component imports
import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { useComposerInput } from '../../../src/webview/panel/composer/hooks';
import type { ComposerInputDraft, WebviewToHostMessage } from '../../../src/shared/protocol';

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
  };
});

interface TestHarnessProps {
  sessionPath: string | null;
  draftText: string;
  postMessage: (msg: WebviewToHostMessage) => void;
  onSend: (text: string) => void;
}

function TestHarness({ sessionPath, draftText, postMessage, onSend }: TestHarnessProps) {
  const { text, textareaRef, handleInput, handleKeyDown } = useComposerInput({
    busy: false,
    onSend,
    onRetrySend: () => {},
    pendingComposerInputsLength: 0,
    initialRows: 1,
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
      onKeyDown: handleKeyDown,
      'aria-label': 'Message composer',
    })
  );
}

// Minimal fake timer registry so we can flush the 500 ms undo-checkpoint
// debounce (and the 300 ms draft-post debounce) deterministically.
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

/** Flush every pending timer (checkpoints + draft posts). */
function flushTimers() {
  const ready = pending;
  pending = [];
  for (const t of ready) t.fn();
}

function typeValue(textarea: HTMLTextAreaElement, value: string) {
  act(() => {
    textarea.value = value;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Commit the typing burst as a single undo checkpoint. Wrap in act() so the
  // reducer update from the debounced checkpoint flushes before the next event.
  act(() => {
    flushTimers();
  });
}

function keydown(textarea: HTMLTextAreaElement, init: KeyboardEventInit) {
  act(() => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  });
}

function ctrlZ(textarea: HTMLTextAreaElement) {
  keydown(textarea, { key: 'z', ctrlKey: true });
}

function ctrlShiftZ(textarea: HTMLTextAreaElement) {
  keydown(textarea, { key: 'Z', ctrlKey: true, shiftKey: true });
}

function ctrlY(textarea: HTMLTextAreaElement) {
  keydown(textarea, { key: 'y', ctrlKey: true });
}

function enter(textarea: HTMLTextAreaElement) {
  keydown(textarea, { key: 'Enter' });
}

test('Ctrl+Z recovers a deleted and already-sent prompt (word-processor undo)', () => {
  installFakeTimers();
  const sent: string[] = [];
  try {
    act(() => {
      render(
        h(TestHarness, {
          sessionPath: '/s',
          draftText: '',
          postMessage: () => {},
          onSend: (text) => { sent.push(text); },
        }),
        container,
      );
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    assert.ok(textarea);

    // Write prompt A, then delete it (user realises the work depends on something else).
    typeValue(textarea, 'prompt A');
    typeValue(textarea, '');
    // Write and send prompt B for the dependent work.
    typeValue(textarea, 'prompt B');
    enter(textarea);

    assert.deepEqual(sent, ['prompt B'], 'prompt B was sent');
    assert.equal(textarea.value, '', 'composer cleared after send');

    // First undo restores what was just sent (prompt B).
    ctrlZ(textarea);
    assert.equal(textarea.value, 'prompt B', 'undo restores the sent prompt B');

    // Keep undoing until the originally-deleted prompt A comes back.
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      ctrlZ(textarea);
      seen.push(textarea.value);
    }
    assert.ok(seen.includes('prompt A'), `undo recovers the deleted prompt A (saw: ${JSON.stringify(seen)})`);
  } finally {
    restoreTimers();
  }
});

test('Ctrl+Y and Ctrl+Shift+Z redo an undone change', () => {
  installFakeTimers();
  const sent: string[] = [];
  try {
    act(() => {
      render(
        h(TestHarness, {
          sessionPath: '/s',
          draftText: '',
          postMessage: () => {},
          onSend: (text) => { sent.push(text); },
        }),
        container,
      );
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    assert.ok(textarea);

    typeValue(textarea, 'first draft');
    typeValue(textarea, 'second draft');

    assert.equal(textarea.value, 'second draft');
    ctrlZ(textarea);
    assert.equal(textarea.value, 'first draft', 'undo steps back to the previous checkpoint');

    // Ctrl+Y redoes.
    ctrlY(textarea);
    assert.equal(textarea.value, 'second draft', 'Ctrl+Y redoes the undone change');

    // Undo again, then Ctrl+Shift+Z redoes.
    ctrlZ(textarea);
    assert.equal(textarea.value, 'first draft');
    ctrlShiftZ(textarea);
    assert.equal(textarea.value, 'second draft', 'Ctrl+Shift+Z redoes the undone change');
  } finally {
    restoreTimers();
  }
});

test('switching sessions resets undo history (undo never crosses sessions)', () => {
  installFakeTimers();
  try {
    act(() => {
      render(
        h(TestHarness, {
          sessionPath: '/s1',
          draftText: '',
          postMessage: () => {},
          onSend: () => {},
        }),
        container,
      );
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    typeValue(textarea, 'prompt in session 1');

    // Switch to a different session — the composer instance persists (same tree
    // position), so the [sessionPath] effect fires and resets the history.
    act(() => {
      render(
        h(TestHarness, {
          sessionPath: '/s2',
          draftText: '',
          postMessage: () => {},
          onSend: () => {},
        }),
        container,
      );
    });

    const textareaAfterSwitch = container.querySelector('textarea') as HTMLTextAreaElement;
    assert.equal(textareaAfterSwitch.value, '', 'session 2 starts empty');

    ctrlZ(textareaAfterSwitch);
    assert.equal(
      textareaAfterSwitch.value,
      '',
      'undo in session 2 does not recover session 1 text',
    );
  } finally {
    restoreTimers();
  }
});
