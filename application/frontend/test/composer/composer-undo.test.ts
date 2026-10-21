import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../helpers/dom';
installDom();

// Stub DOMPurify before any component imports
import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { useComposerInput } from '../../composer/hooks';
import type { ComposerInputDraft, WebviewToHostMessage } from '../../../lib/protocol/index.js';

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
});

interface TestHarnessProps {
  sessionPath: string | null;
  draftText: string;
  postMessage: (msg: WebviewToHostMessage) => void;
  onSend: (text: string) => void;
}

function TestHarness({ sessionPath, draftText, postMessage, onSend }: TestHarnessProps) {
  const { text, textareaRef, handleInput, handleKeyDown, handleBeforeInput } = useComposerInput({
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
      onBeforeInput: handleBeforeInput,
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

/** Simulate rapid typing: dispatch the input event but leave the 500 ms
 * checkpoint debounce (and the 300 ms draft post) pending. */
function typeRapid(textarea: HTMLTextAreaElement, value: string) {
  act(() => {
    textarea.value = value;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function beforeinput(textarea: HTMLTextAreaElement, inputType: 'historyUndo' | 'historyRedo') {
  const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType });
  act(() => {
    textarea.dispatchEvent(event);
  });
  return event;
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

test('undo during the rapid FIRST typing burst captures it and steps back exactly', () => {
  installFakeTimers();
  try {
    act(() => {
      render(
        h(TestHarness, {
          sessionPath: '/s',
          draftText: '',
          postMessage: () => {},
          onSend: () => {},
        }),
        container,
      );
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    assert.ok(textarea);

    // Rapid first burst after the empty seed: the 500 ms checkpoint is still pending.
    typeRapid(textarea, 'burst text');
    assert.equal(textarea.value, 'burst text');

    // Undo immediately: the pending burst must be captured, not skipped/lost.
    ctrlZ(textarea);
    assert.equal(textarea.value, '', 'undo steps back to the pre-burst seed');

    // The captured burst is recoverable — and exactly once per redo.
    ctrlY(textarea);
    assert.equal(textarea.value, 'burst text', 'redo restores the rapid burst exactly');
  } finally {
    restoreTimers();
  }
});

test('checkpoint followed by a recent edit: undo and redo hit the exact edges', () => {
  installFakeTimers();
  try {
    act(() => {
      render(
        h(TestHarness, {
          sessionPath: '/s',
          draftText: '',
          postMessage: () => {},
          onSend: () => {},
        }),
        container,
      );
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    assert.ok(textarea);

    // A settled checkpoint, then a still-pending recent edit on top of it.
    typeValue(textarea, 'checkpoint A');
    typeRapid(textarea, 'checkpoint A plus live edit');
    ctrlZ(textarea);
    assert.equal(textarea.value, 'checkpoint A', 'undo undoes exactly the recent edit');

    // Redo replays exactly the recent edit (no duplicate checkpoints in between).
    ctrlShiftZ(textarea);
    assert.equal(textarea.value, 'checkpoint A plus live edit', 'redo replays the recent edit exactly');

    // Undo again to confirm the redo did not add spurious entries.
    ctrlZ(textarea);
    assert.equal(textarea.value, 'checkpoint A');
  } finally {
    restoreTimers();
  }
});

test('typing after an undo discards the redo stack (pending burst flush wins)', () => {
  installFakeTimers();
  try {
    act(() => {
      render(
        h(TestHarness, {
          sessionPath: '/s',
          draftText: '',
          postMessage: () => {},
          onSend: () => {},
        }),
        container,
      );
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    assert.ok(textarea);

    typeValue(textarea, 'A');
    typeValue(textarea, 'B');
    ctrlZ(textarea);
    assert.equal(textarea.value, 'A');

    // Fresh typing while the checkpoint is still pending must discard redo…
    typeRapid(textarea, 'A2');
    ctrlShiftZ(textarea);
    assert.equal(textarea.value, 'A2', 'redo does not clobber the live burst with the redo entry');
  } finally {
    restoreTimers();
  }
});

test('native beforeinput historyUndo/historyRedo routes through the custom history', () => {
  installFakeTimers();
  try {
    act(() => {
      render(
        h(TestHarness, {
          sessionPath: '/s',
          draftText: '',
          postMessage: () => {},
          onSend: () => {},
        }),
        container,
      );
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    assert.ok(textarea);

    typeValue(textarea, 'root');
    typeRapid(textarea, 'rooting');

    // No keyboard event at all: the native beforeinput gesture alone must apply
    // our undo (and capture the pending burst first).
    const undoEvent = beforeinput(textarea, 'historyUndo');
    assert.ok(undoEvent.defaultPrevented, 'native historyUndo is still prevented');
    assert.equal(textarea.value, 'root');

    const redoEvent = beforeinput(textarea, 'historyRedo');
    assert.ok(redoEvent.defaultPrevented, 'native historyRedo is still prevented');
    assert.equal(textarea.value, 'rooting');
  } finally {
    restoreTimers();
  }
});

test(`beforeinput historyUndo immediately after a keyboard undo does not double-apply`, async () => {
  installFakeTimers();
  try {
    act(() => {
      render(
        h(TestHarness, {
          sessionPath: '/s',
          draftText: '',
          postMessage: () => {},
          onSend: () => {},
        }),
        container,
      );
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    assert.ok(textarea);

    typeValue(textarea, 'first');
    typeValue(textarea, 'second');

    // Keyboard route applies the undo; a non-compliant engine echoes it through
    // beforeinput right after — the duplicate window swallows the echo.
    ctrlZ(textarea);
    assert.equal(textarea.value, 'first');
    const echoed = beforeinput(textarea, 'historyUndo');
    assert.ok(echoed.defaultPrevented, 'echo is still prevented');
    assert.equal(textarea.value, 'first', 'echo does not undo a second time');

    // A genuinely later native gesture (no keyboard event) still applies.
    // UNDO_REDO_DUPLICATE_WINDOW_MS in hooks.ts is 250; clear it with real time.
    await new Promise((resolve) => originalSetTimeout(resolve, 300));
    beforeinput(textarea, 'historyUndo');
    assert.equal(textarea.value, '', 'a later native undo is applied');
  } finally {
    restoreTimers();
  }
});

test('repeated undo/redo steps exactly per checkpoint and stops at both boundaries', () => {
  installFakeTimers();
  try {
    act(() => {
      render(
        h(TestHarness, {
          sessionPath: '/s',
          draftText: '',
          postMessage: () => {},
          onSend: () => {},
        }),
        container,
      );
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    assert.ok(textarea);

    typeValue(textarea, 'one');
    typeValue(textarea, 'two');
    typeValue(textarea, 'three');

    for (const expected of ['two', 'one', '']) {
      ctrlZ(textarea);
      assert.equal(textarea.value, expected);
    }
    ctrlZ(textarea);
    assert.equal(textarea.value, '', 'undo past the boundary is a no-op');

    for (const expected of ['one', 'two', 'three']) {
      ctrlY(textarea);
      assert.equal(textarea.value, expected);
    }
    ctrlY(textarea);
    assert.equal(textarea.value, 'three', 'redo past the boundary is a no-op');
  } finally {
    restoreTimers();
  }
});

test('undo/redo leave the caret at the end of the restored text', () => {
  installFakeTimers();
  try {
    act(() => {
      render(
        h(TestHarness, {
          sessionPath: '/s',
          draftText: '',
          postMessage: () => {},
          onSend: () => {},
        }),
        container,
      );
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    assert.ok(textarea);

    typeValue(textarea, 'hello world');
    typeValue(textarea, 'hello world again');

    ctrlZ(textarea);
    assert.equal(textarea.value, 'hello world');
    assert.equal(textarea.selectionStart, 'hello world'.length, 'caret at end after undo');
    assert.equal(textarea.selectionEnd, 'hello world'.length, 'selection end after undo');

    ctrlY(textarea);
    assert.equal(textarea.value, 'hello world again');
    assert.equal(textarea.selectionStart, 'hello world again'.length, 'caret at end after redo');
    assert.equal(textarea.selectionEnd, 'hello world again'.length, 'selection end after redo');
  } finally {
    restoreTimers();
  }
});
