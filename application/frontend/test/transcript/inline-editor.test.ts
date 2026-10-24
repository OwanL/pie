import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { installDom } from '../helpers/dom';
installDom();
Object.defineProperty(globalThis, 'CSS', {
  configurable: true,
  value: { supports: () => false },
});

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import type { ComposerInput } from '../../../lib/protocol/index.js';
import { InlineEditor } from '../../transcript/inline-editor';
import { MessageItemShell } from '../../transcript/message-item/inner';

test('editing rows permanently opt out of the entrance animation (no restart flash on cancel)', async () => {
  const css = await readFile(new URL('../../styles/transcript.css', import.meta.url), 'utf8');
  assert.match(css, /\[data-role\]\[data-entered\]\s*\{\s*animation: panel-entrance/);
  assert.match(css, /\[data-role\]\[data-editing="true"\],\s*\[data-role\]\[data-edited="true"\]\s*\{\s*animation: none;/);
  // The negative-delay "seek and pause" hack must stay gone: it holds the
  // row at the transparent first frame in some restored states and restarts
  // the finished animation on cancel because the delay resets.
  assert.doesNotMatch(css, /animation-delay: calc\(0s - var\(--panel-duration-entrance\)\)/);
  assert.doesNotMatch(css, /\[data-role\]\[data-editing="true"\]\s*\{[^}]*animation:\s*none/);
});

const shellProps = (isEditing: boolean) => ({
  messageId: 'm1',
  renderIdentity: 'm1',
  role: 'user' as const,
  status: 'completed' as const,
  isCurrentlyStreaming: false,
  isClickableUserMsg: true,
  isEditing,
  handleMessageClick: undefined,
  children: 'content' as const,
});

test('MessageItemShell keeps the edited marker after exiting edit mode (persistent opt-out)', () => {
  act(() => { render(h(MessageItemShell, shellProps(true)), container); });
  const shell = container.querySelector<HTMLElement>('[data-role="user"]');
  assert.ok(shell);
  assert.equal(shell.hasAttribute('data-editing'), true);
  assert.equal(shell.getAttribute('data-edited'), 'true');

  act(() => { render(h(MessageItemShell, shellProps(false)), container); });
  assert.equal(shell.hasAttribute('data-editing'), false);
  assert.equal(shell.getAttribute('data-edited'), 'true');
});

test('MessageItemShell never claims the edited marker before editing', () => {
  act(() => { render(h(MessageItemShell, shellProps(false)), container); });
  assert.ok(container.querySelector('[data-edited="true"]') === null);
  assert.ok(container.querySelector('[data-editing="true"]') === null);
});

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
});

test('InlineEditor confirms at most once when Save and Enter both submit', () => {
  const confirmations: Array<{ text: string; inputCount: number }> = [];

  act(() => {
    render(h(InlineEditor, {
      queued: false,
      initialText: 'edited question',
      initialInputs: [],
      capturedHeight: null,
      onConfirm: (text, inputs) => confirmations.push({ text, inputCount: inputs.length }),
      onCancel: () => {},
    }), container);
  });

  const save = container.querySelector<HTMLButtonElement>('button.primary');
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
  assert.ok(save);
  assert.ok(textarea);

  act(() => {
    save.click();
    textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  });

  assert.deepEqual(confirmations, [{ text: 'edited question', inputCount: 0 }]);
});

for (const queued of [false, true]) {
  test(`InlineEditor labels ${queued ? 'queued save' : 'durable edit'}`, () => {
    act(() => render(h(InlineEditor, {
      queued, initialText: 'question', initialInputs: [], capturedHeight: null,
      onConfirm: () => {}, onCancel: () => {},
    }), container));
    assert.equal(container.querySelector('button.primary')?.textContent, queued ? 'Save' : 'Send');
    assert.doesNotMatch(container.textContent ?? '', /Resending replaces later messages\./);
    // The rejected shortcut paragraph stays gone: keys are documented behavior
    // (Enter saves, Shift+Enter newlines, Esc cancels), tested below.
    assert.doesNotMatch(container.textContent ?? '', /Shift\+Enter|Esc cancel|Enter save/);
    // Actions live in the compact footer row of the integrated shell.
    assert.ok(container.querySelector('.inline-editor-footer .inline-editor-actions'));
  });
}

test('inline editor is one integrated surface with a separate in-flow footer', async () => {
  const css = await readFile(new URL('../../styles/inline-editor.css', import.meta.url), 'utf8');
  // One surface: border/background/focus ring live on the shell...
  assert.match(css, /\.inline-editor\s*\{[^}]*border: 1px solid var\(--panel-accent\);/);
  assert.match(css, /\.inline-editor\s*\{[^}]*border-radius: 10px;/);
  assert.match(css, /\.inline-editor:focus-within\s*\{/);
  // ...never on the textarea, which scrolls normally above the footer.
  assert.doesNotMatch(css, /\.inline-editor-textarea\s*\{[^}]*border:/);
  assert.doesNotMatch(css, /\.inline-editor-textarea\s*\{[^}]*background: var/);
  // The footer is a layout region, NOT an overlay: no absolute positioning,
  // and the old reserved padding bands (40px/66px) are gone entirely.
  assert.doesNotMatch(css, /\.inline-editor-footer\s*\{[^}]*position:\s*absolute/);
  assert.doesNotMatch(css, /\.inline-editor-textarea\s*\{[^}]*padding-bottom:/);
  assert.doesNotMatch(css, /padding-bottom: 66px/);
  // The textarea caps at the same 240px height as the non-field-sizing
  // autoSize clamp, so long text scrolls but the editor stays compact.
  assert.match(css, /\.inline-editor-textarea\s*\{[^}]*max-height: 240px;/);
  assert.match(css, /\.inline-editor-textarea\s*\{[^}]*overflow-y: auto;/);
  // Removed resend warning and shortcut paragraph stay absent.
  assert.doesNotMatch(css, /inline-editor-note|inline-editor-hint/);
  // Shell floor keeps the bubble editor-suitable at short text.
  assert.match(css, /\.inline-editor\s*\{[^}]*min-width: 260px;/);
});

test('InlineEditor keeps captured transcript height on the wrapper, not the compact shell', () => {
  act(() => render(h(InlineEditor, {
    queued: false, initialText: 'long message', initialInputs: [], capturedHeight: 900,
    onConfirm: () => {}, onCancel: () => {},
  }), container));
  const wrapper = container.querySelector<HTMLElement>('.inline-editor-wrapper')!;
  const shell = container.querySelector<HTMLElement>('.inline-editor')!;
  assert.ok(wrapper && shell);
  assert.match(wrapper.style.minHeight, /900px/);
  assert.equal(shell.style.minHeight, '');
  assert.equal(shell.getAttribute('style'), null);
});

test('InlineEditor renders textarea and footer as flow siblings of one shell', () => {
  act(() => render(h(InlineEditor, {
    queued: false, initialText: 'question', initialInputs: [], capturedHeight: null,
    onConfirm: () => {}, onCancel: () => {},
  }), container));
  const shell = container.querySelector('.inline-editor')!;
  const textarea = shell.querySelector('.inline-editor-textarea')!;
  const footer = shell.querySelector('.inline-editor-footer')!;
  assert.ok(shell && textarea && footer);
  // Footer follows the textarea in document order (in-flow region below the
  // scrolling surface), and nothing inside the shell is positioned as an
  // overlay (no absolutely positioned children to collide with scrolling
  // text).
  assert.ok(
    footer.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_PRECEDING,
    'footer must come after the textarea in document order',
  );
});

test('InlineEditor preserves newline, IME, empty submission and Escape safeguards', () => {
  let confirmations = 0;
  let cancellations = 0;
  act(() => render(h(InlineEditor, {
    queued: false, initialText: '   ', initialInputs: [], capturedHeight: null,
    onConfirm: () => { confirmations++; }, onCancel: () => { cancellations++; },
  }), container));
  const textarea = container.querySelector('textarea')!;
  const key = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    act(() => { textarea.dispatchEvent(event); });
    return event;
  };
  assert.equal(container.querySelector<HTMLButtonElement>('button.primary')!.disabled, true);
  key({ key: 'Enter' });
  assert.equal(confirmations, 0);
  act(() => {
    textarea.value = 'edited';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(key({ key: 'Enter', shiftKey: true }).defaultPrevented, false);
  assert.equal(key({ key: 'Enter', isComposing: true }).defaultPrevented, false);
  key({ key: 'Enter', keyCode: 229 });
  assert.equal(confirmations, 0);
  key({ key: 'Escape' });
  assert.equal(cancellations, 1);
  assert.equal(key({ key: 'Enter' }).defaultPrevented, true);
  assert.equal(confirmations, 0);
});

test('InlineEditor permits attachment-only submission and preserves inputs', () => {
  const inputs = [{ id: 'path-1', kind: 'filesystemPathRef' as const, path: '/workspace/test.ts', name: 'test.ts', source: 'picker' as const }];
  const confirmations: unknown[] = [];
  act(() => render(h(InlineEditor, {
    queued: true, initialText: ' ', initialInputs: inputs, capturedHeight: null,
    onConfirm: (text, nextInputs) => confirmations.push({ text, inputs: nextInputs }), onCancel: () => {},
  }), container));
  const save = container.querySelector<HTMLButtonElement>('button.primary')!;
  assert.equal(save.disabled, false);
  act(() => { save.click(); save.click(); });
  assert.deepEqual(confirmations, [{ text: '', inputs }]);
});

for (const finish of ['send', 'cancel', 'unmount', 'reject'] as const) {
  test(`pending inline transfers guard submission and settle safely: ${finish}`, async () => {
    const confirmations: Array<{ text: string; inputs: ComposerInput[] }> = [];
    act(() => render(h(InlineEditor, {
      queued: false, initialText: 'draft', initialInputs: [], capturedHeight: null,
      onConfirm: (text, inputs) => confirmations.push({ text, inputs }), onCancel: () => {},
    }), container));
    const textarea = container.querySelector('textarea')!;
    const send = container.querySelector<HTMLButtonElement>('button.primary')!;
    const pending = [0, 1].map(() => {
      let resolve!: (value: ArrayBuffer) => void;
      let reject!: () => void;
      const promise = new Promise<ArrayBuffer>((yes, no) => { resolve = yes; reject = no; });
      return { promise, resolve, reject };
    });
    act(() => {
      pending.forEach((item, index) => {
        const event = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: {
          files: [{ name: `${index}.gif`, type: 'image/gif', arrayBuffer: () => item.promise }],
        } });
        textarea.dispatchEvent(event);
      });
      send.click();
      textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    });
    assert.equal(send.disabled, true);
    assert.equal(confirmations.length, 0);
    if (finish === 'cancel') act(() => container.querySelector<HTMLButtonElement>('button.secondary')!.click());
    if (finish === 'unmount') act(() => render(null, container));
    await act(async () => { pending[1].resolve(new ArrayBuffer(1)); });
    if (finish !== 'unmount') assert.equal(send.disabled, true);
    await act(async () => {
      if (finish === 'reject') pending[0].reject();
      else pending[0].resolve(new ArrayBuffer(1));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(confirmations.length, 0);
    if (finish === 'unmount') return;
    act(() => {
      send.click();
      textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    });
    if (finish === 'cancel') {
      assert.equal(confirmations.length, 0);
    } else {
      assert.equal(confirmations.length, 1);
      assert.equal(confirmations[0].text, 'draft');
      assert.deepEqual(confirmations[0].inputs.map((input) => input.name), finish === 'reject' ? ['1.gif'] : ['0.gif', '1.gif']);
      assert.equal(new Set(confirmations[0].inputs.map((input) => input.id)).size, confirmations[0].inputs.length);
    }
  });
}

test('InlineEditor retains batch read errors after a later success and clears on a fresh batch', async () => {
  act(() => render(h(InlineEditor, {
    queued: false, initialText: 'draft', initialInputs: [], capturedHeight: null,
    onConfirm: () => {}, onCancel: () => {},
  }), container));
  const textarea = container.querySelector('textarea')!;
  const paste = (promise: Promise<ArrayBuffer>) => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: {
      files: [{ name: 'image.gif', type: 'image/gif', arrayBuffer: () => promise }],
    } });
    textarea.dispatchEvent(event);
  };
  let rejectFirst!: () => void;
  let resolveSecond!: (value: ArrayBuffer) => void;
  const first = new Promise<ArrayBuffer>((_resolve, reject) => { rejectFirst = reject; });
  const second = new Promise<ArrayBuffer>((resolve) => { resolveSecond = resolve; });
  act(() => { paste(first); paste(second); });
  await act(async () => {
    rejectFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.match(container.querySelector('[role="status"]')?.textContent ?? '', /Cannot attach image\.gif/);
  await act(async () => {
    resolveSecond(new ArrayBuffer(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.match(container.querySelector('[role="status"]')?.textContent ?? '', /Cannot attach image\.gif/);
  act(() => { paste(Promise.resolve(new ArrayBuffer(1))); });
  assert.ok(container.querySelector('[role="status"]') === null);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.ok(container.querySelector('[role="status"]') === null);
});

for (const moved of [false, true]) {
  test('editor removal restores shell only while focus is owned: ' + moved, async () => {
    const shell = document.createElement('div');
    shell.className = 'message-item-shell';
    shell.tabIndex = 0;
    container.appendChild(shell);
    const outside = document.createElement('button');
    container.appendChild(outside);
    act(() => render(h(InlineEditor, {
      queued: false, initialText: 'edit', initialInputs: [], capturedHeight: null,
      onConfirm: () => {}, onCancel: () => {},
    }), shell));
    shell.querySelector('textarea')!.focus();
    if (moved) outside.focus();
    act(() => render(null, shell));
    await Promise.resolve();
    assert.ok(document.activeElement === (moved ? outside : shell));
  });
}
