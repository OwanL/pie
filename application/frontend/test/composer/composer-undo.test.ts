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

// Some engines cannot cancel the native mutation behind historyUndo/historyRedo
// (noncancelable beforeinput) and additionally deliver the matched trusted
// input event after the mutation landed.
function beforeinputNoncancelable(textarea: HTMLTextAreaElement, inputType: 'historyUndo' | 'historyRedo') {
  const event = new InputEvent('beforeinput', { bubbles: true, cancelable: false, inputType });
  act(() => {
    textarea.dispatchEvent(event);
  });
  return event;
}

/** A native pair gesture: noncancelable beforeinput followed by its matched
 * trusted input over a natively mutated DOM value (the blocker engine shape). */
function nativePair(textarea: HTMLTextAreaElement, inputType: 'historyUndo' | 'historyRedo', nativeValue: string) {
  const event = beforeinputNoncancelable(textarea, inputType);
  nativeHistoryInput(textarea, inputType, nativeValue);
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

test(`beforeinput historyUndo immediately after a keyboard undo does not double-apply`, () => {
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
    // beforeinput right after — the echo latch swallows the duplicate.
    ctrlZ(textarea);
    assert.equal(textarea.value, 'first');
    const echoed = beforeinput(textarea, 'historyUndo');
    assert.ok(echoed.defaultPrevented, 'echo is still prevented');
    assert.equal(textarea.value, 'first', 'echo does not undo a second time');

    // The echo consumed the latch: a genuinely later NATIVE gesture — even in
    // the immediately following task, with no wallclock delay — still applies.
    beforeinput(textarea, 'historyUndo');
    assert.equal(textarea.value, '', 'a later native undo is applied without any 250 ms gap');
  } finally {
    restoreTimers();
  }
});

test('two genuine native gestures in successive tasks without 250 ms delay both apply', () => {
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

    // Two native same-direction gestures in immediate successive tasks (no
    // keydown, no wallclock spacing). Neither is an echo: both must apply.
    beforeinput(textarea, 'historyUndo');
    assert.equal(textarea.value, 'two', 'first native undo applies');
    beforeinput(textarea, 'historyUndo');
    assert.equal(textarea.value, 'one', 'second native undo, sub-250 ms later, is not deduped away');

    // And two native redos in the same shape.
    beforeinput(textarea, 'historyRedo');
    assert.equal(textarea.value, 'two', 'first native redo applies');
    beforeinput(textarea, 'historyRedo');
    assert.equal(textarea.value, 'three', 'second native redo, sub-250 ms later, is not deduped away');
  } finally {
    restoreTimers();
  }
});

test('echo right after a redo that flush-discards the pending burst never overwrites the live text', () => {
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

    // Fresh typing leaves a pending checkpoint burst on top of the undone state;
    // the redo stack still holds 'B' until the burst is flushed.
    typeRapid(textarea, 'A2');

    // The redo itself is consumed by the flush-discard: the burst becomes the
    // present and the redo stack is cleared.
    ctrlShiftZ(textarea);
    assert.equal(textarea.value, 'A2', 'flush-discard keeps the live burst');

    // The engine echoes the just-consumed redo gesture through beforeinput.
    // A stale canRedo/future closure would replay the DISCARDED 'B' entry over
    // the live text — the echo latch must swallow it instead.
    const echoed = beforeinput(textarea, 'historyRedo');
    assert.ok(echoed.defaultPrevented, 'echo is still prevented');
    assert.equal(textarea.value, 'A2', 'echo of a flush-discarded redo never overwrites the live text');

    // The live value is still the real editor state: undo and redo converge on it.
    ctrlZ(textarea);
    assert.equal(textarea.value, 'A', 'undo steps back to the pre-burst checkpoint');
    ctrlShiftZ(textarea);
    assert.equal(textarea.value, 'A2', 'redo replays the burst exactly');
    ctrlZ(textarea);
    assert.equal(textarea.value, 'A');
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

// This models the observed Chromium execCommand event sequence, not a
// synthetic beforeinput stand-in: trusted native input arrives after mutation
// with NO beforeinput. Browser availability still needs browser qualification.
function nativeHistoryInput(textarea: HTMLTextAreaElement, inputType: 'historyUndo' | 'historyRedo', nativeValue: string) {
  act(() => {
    textarea.value = nativeValue;
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
  });
}

test('input-only native history after keyboard undo/redo uses custom checkpoints', () => {
  installFakeTimers();
  try {
    act(() => {
      render(h(TestHarness, { sessionPath: '/s', draftText: '', postMessage: () => {}, onSend: () => {} }), container);
    });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    typeRapid(textarea, 'exact draft');
    ctrlZ(textarea);
    ctrlShiftZ(textarea);
    act(() => flushTimers()); // distinct native command, not a keyboard echo
    assert.equal(textarea.value, 'exact draft');
    nativeHistoryInput(textarea, 'historyUndo', 'exact draft');
    assert.equal(textarea.value, '', 'even a no-change native undo steps custom history');
    nativeHistoryInput(textarea, 'historyRedo', 'exact draftexact draftexact draft');
    assert.equal(textarea.value, 'exact draft', 'stale native redo cannot corrupt text');
    ctrlZ(textarea);
    assert.equal(textarea.value, '');
    ctrlShiftZ(textarea);
    assert.equal(textarea.value, 'exact draft');
  } finally {
    restoreTimers();
  }
});

test('input-only history flushes the pre-native live burst and preserves boundary values', () => {
  installFakeTimers();
  try {
    act(() => {
      render(h(TestHarness, { sessionPath: '/s', draftText: '', postMessage: () => {}, onSend: () => {} }), container);
    });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    typeValue(textarea, 'A');
    typeRapid(textarea, 'AB');
    nativeHistoryInput(textarea, 'historyUndo', 'native garbage');
    assert.equal(textarea.value, 'A');
    nativeHistoryInput(textarea, 'historyRedo', 'native garbage');
    assert.equal(textarea.value, 'AB', 'redo recovers live text, not the mutated native value');
    nativeHistoryInput(textarea, 'historyRedo', 'native garbage');
    assert.equal(textarea.value, 'AB', 'no-op redo repairs native DOM mutation');
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

// --- beforeinput/input pair coordination (review blocker: a noncancelable
// --- beforeinput(historyUndo) followed by input(historyUndo) applied twice) ---

test('noncancelable beforeinput + matched input applies the undo exactly once', () => {
  installFakeTimers();
  try {
    act(() => {
      render(h(TestHarness, { sessionPath: '/s', draftText: '', postMessage: () => {}, onSend: () => {} }), container);
    });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    typeValue(textarea, 'first');
    typeValue(textarea, 'second');

    // The engine cannot stop the native mutation: beforeinput reports
    // cancelable=false and the matched trusted input follows the mutation.
    beforeinputNoncancelable(textarea, 'historyUndo');
    assert.equal(
      textarea.value,
      'second',
      'the noncancelable beforeinput does not apply the custom history early',
    );

    // The matched input must repair the native DOM mutation and apply the
    // custom history once — not repeat the traversal twice.
    nativeHistoryInput(textarea, 'historyUndo', 'native garbage');
    assert.equal(textarea.value, 'first', 'the pair applies exactly one undo step');
  } finally {
    restoreTimers();
  }
});

test('cancelable beforeinput then a stray matched input does not repeat the traversal', () => {
  installFakeTimers();
  try {
    act(() => {
      render(h(TestHarness, { sessionPath: '/s', draftText: '', postMessage: () => {}, onSend: () => {} }), container);
    });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    typeValue(textarea, 'first');
    typeValue(textarea, 'second');

    const evt = beforeinput(textarea, 'historyUndo');
    assert.ok(evt.defaultPrevented, 'cancelable historyUndo is prevented');
    assert.equal(textarea.value, 'first', 'the cancelable beforeinput applies exactly once');

    // An engine that still delivers the matched input after a prevented
    // beforeinput must not make our history step a second time.
    nativeHistoryInput(textarea, 'historyUndo', 'stray garbage');
    assert.equal(textarea.value, 'first', 'the stray input only repairs, never repeats');

    // And the same for a prevented redo.
    typeRapid(textarea, 'first again');
    const evtRedo = beforeinput(textarea, 'historyRedo');
    assert.ok(evtRedo.defaultPrevented);
    assert.equal(textarea.value, 'first again');
    nativeHistoryInput(textarea, 'historyRedo', 'stray garbage');
    assert.equal(textarea.value, 'first again', 'stray redo input does not repeat the traversal');
  } finally {
    restoreTimers();
  }
});

test('a later genuine input-only gesture after a cancelable beforeinput still applies', () => {
  installFakeTimers();
  try {
    act(() => {
      render(h(TestHarness, { sessionPath: '/s', draftText: '', postMessage: () => {}, onSend: () => {} }), container);
    });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    typeValue(textarea, 'first');
    typeValue(textarea, 'second');

    beforeinput(textarea, 'historyUndo');
    assert.equal(textarea.value, 'first');

    // Task boundary: the applied marker expires so a later GENUINE native
    // gesture (no wallclock gap required) is never swallowed as its echo.
    act(() => {
      flushTimers();
    });
    nativeHistoryInput(textarea, 'historyUndo', 'native garbage');
    assert.equal(textarea.value, '', 'the later genuine input-only undo applies');
  } finally {
    restoreTimers();
  }
});

test('keydown undo followed by a noncancelable beforeinput+input echo pair applies exactly once', () => {
  installFakeTimers();
  try {
    act(() => {
      render(h(TestHarness, { sessionPath: '/s', draftText: '', postMessage: () => {}, onSend: () => {} }), container);
    });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    typeValue(textarea, 'first');
    typeValue(textarea, 'second');

    ctrlZ(textarea);
    assert.equal(textarea.value, 'first');

    // Both echo events of the same keydown gesture: neither may re-apply.
    beforeinputNoncancelable(textarea, 'historyUndo');
    nativeHistoryInput(textarea, 'historyUndo', 'echo garbage');
    assert.equal(textarea.value, 'first', 'the echo pair is swallowed after the keydown route applied');
  } finally {
    restoreTimers();
  }
});

test('keydown undo followed by a cancelable beforeinput+input echo pair applies exactly once', () => {
  installFakeTimers();
  try {
    act(() => {
      render(h(TestHarness, { sessionPath: '/s', draftText: '', postMessage: () => {}, onSend: () => {} }), container);
    });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    typeValue(textarea, 'first');
    typeValue(textarea, 'second');

    ctrlZ(textarea);
    assert.equal(textarea.value, 'first');

    const echoed = beforeinput(textarea, 'historyUndo');
    assert.ok(echoed.defaultPrevented, 'echo beforeinput is still prevented');
    nativeHistoryInput(textarea, 'historyUndo', 'echo garbage');
    assert.equal(textarea.value, 'first', 'the echo pair is swallowed after the keydown route applied');
  } finally {
    restoreTimers();
  }
});

test('input-only echo right after a keyboard undo is swallowed without a task-gap requirement', () => {
  installFakeTimers();
  try {
    act(() => {
      render(h(TestHarness, { sessionPath: '/s', draftText: '', postMessage: () => {}, onSend: () => {} }), container);
    });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    typeValue(textarea, 'first');
    typeValue(textarea, 'second');

    ctrlZ(textarea);
    assert.equal(textarea.value, 'first');

    // An input-only echo (no beforeinput at all) inside the same task-chain
    // window as the keydown must not step the custom history a second time.
    nativeHistoryInput(textarea, 'historyUndo', 'echo garbage');
    assert.equal(textarea.value, 'first', 'the input-only echo does not double-apply');
  } finally {
    restoreTimers();
  }
});

test('rapid successive native pair gestures each apply exactly once', () => {
  installFakeTimers();
  try {
    act(() => {
      render(h(TestHarness, { sessionPath: '/s', draftText: '', postMessage: () => {}, onSend: () => {} }), container);
    });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    typeValue(textarea, 'one');
    typeValue(textarea, 'two');
    typeValue(textarea, 'three');

    // Back-to-back pair gestures, no flushTimers between them, no wallclock
    // gap: every pair applies exactly one step.
    nativePair(textarea, 'historyUndo', 'garbage 1');
    assert.equal(textarea.value, 'two', 'first pair applies one undo step');
    nativePair(textarea, 'historyUndo', 'garbage 2');
    assert.equal(textarea.value, 'one', 'second pair is not deduped away');

    nativePair(textarea, 'historyRedo', 'garbage 3');
    assert.equal(textarea.value, 'two', 'first pair applies one redo step');
    nativePair(textarea, 'historyRedo', 'garbage 4');
    assert.equal(textarea.value, 'three', 'second pair is not deduped away');
  } finally {
    restoreTimers();
  }
});

test('native undo pair over a pending live burst records the burst and steps exactly once', () => {
  installFakeTimers();
  try {
    act(() => {
      render(h(TestHarness, { sessionPath: '/s', draftText: '', postMessage: () => {}, onSend: () => {} }), container);
    });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    typeValue(textarea, 'A');
    typeRapid(textarea, 'AB');

    // The pending burst must be captured before the step; the pair itself is
    // one gesture, so the result is exactly 'A' (never an extra empty step).
    nativePair(textarea, 'historyUndo', 'native garbage');
    assert.equal(textarea.value, 'A', 'the pair undoes exactly the burst');

    // The captured burst remains recoverable.
    ctrlShiftZ(textarea);
    assert.equal(textarea.value, 'AB', 'the burst is recoverable after the pair undo');

    // And the mirrored burst case for redo: a pending burst on top of an
    // undone state flush-discards through a full pair gesture; the burst
    // becomes the live present and the redo stack is cleared.
    typeRapid(textarea, 'A2');
    nativePair(textarea, 'historyRedo', 'native garbage');
    assert.equal(textarea.value, 'A2', 'a redo pair flush-discards and preserves the live burst');
    ctrlZ(textarea);
    assert.equal(textarea.value, 'AB', 'undo after the pair steps to the checkpoint the burst was flushed onto');
  } finally {
    restoreTimers();
  }
});

test('input echo pair of a flush-discarded keyboard redo never overwrites the live text', () => {
  installFakeTimers();
  try {
    act(() => {
      render(h(TestHarness, { sessionPath: '/s', draftText: '', postMessage: () => {}, onSend: () => {} }), container);
    });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    typeValue(textarea, 'A');
    typeValue(textarea, 'B');
    ctrlZ(textarea);
    assert.equal(textarea.value, 'A');
    typeRapid(textarea, 'A2');

    // The keyboard redo is consumed by the flush-discard; the paired echo
    // events must not rewrite the live value with a stale future entry.
    ctrlShiftZ(textarea);
    assert.equal(textarea.value, 'A2');
    beforeinput(textarea, 'historyRedo');
    nativeHistoryInput(textarea, 'historyRedo', 'stale garbage');
    assert.equal(textarea.value, 'A2', 'the echo pair preserves the live burst');

    // The live value is still the real editor state: history converges on it.
    ctrlZ(textarea);
    assert.equal(textarea.value, 'A');
    ctrlShiftZ(textarea);
    assert.equal(textarea.value, 'A2');
  } finally {
    restoreTimers();
  }
});
