import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from '../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { ContextMenu } from '../../../src/webview/panel/components/context-menu';
import { writeTextToClipboard } from '../../../src/webview/panel/components/clipboard';
import { useMenuListeners } from '../../../src/webview/panel/components/useMenuListeners';
import { useMenuTriggerAria } from '../../../src/webview/panel/components/useMenuTriggerAria';
import { useMenuViewportClamp } from '../../../src/webview/panel/components/useMenuViewportClamp';
import type { ChatPrefs } from '../../../src/shared/protocol';
import type { TranscriptMessageMenuInfo } from '../../../src/webview/panel/transcript/types';

const prefs = {} as ChatPrefs;
let container: HTMLDivElement;

function PrimitiveMenu({
  triggerEl,
  onClose,
  closeOnScroll = false,
  showLast = true,
  refocusKey,
}: {
  triggerEl?: HTMLElement | null;
  onClose: () => void;
  closeOnScroll?: boolean;
  showLast?: boolean;
  refocusKey?: unknown;
}) {
  const { ref, pos } = useMenuViewportClamp({
    x: 10,
    y: 10,
    triggerEl,
    restoreFocusOnClose: true,
    refocusKey,
  });
  useMenuTriggerAria(triggerEl);
  useMenuListeners(ref, onClose, { closeOnScroll });
  return h('div', { ref, role: 'menu', style: `top:${pos.top}px;left:${pos.left}px` },
    h('button', { class: 'context-menu-item', type: 'button' }, 'First'),
    h('button', { class: 'context-menu-item', type: 'button', disabled: true }, 'Disabled'),
    showLast ? h('button', { class: 'context-menu-item', type: 'button' }, 'Last') : null);
}

function keydown(key: string): void {
  const target = document.activeElement;
  assert.ok(target instanceof HTMLElement);
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

test('file-path context menu offers Open File and Copy Path without Copy raw', () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  const opened: string[] = [];

  act(() => {
    render(h(ContextMenu, {
      menu: {
        type: 'filePath',
        rawData: '/workspace/pie/reveal/docs/foo.md',
        sessionPath: null,
        selectionText: '',
        x: 10,
        y: 10,
        triggerEl: null,
      },
      prefs,
      onSetPrefs: () => {},
      onOpenFile: (path: string) => opened.push(path),
      onEditMessage: () => {},
      onTruncateAfter: () => {},
      onClose: () => {},
    }), container);
  });

  const labels = Array.from(container.querySelectorAll('button')).map((button) => button.textContent?.trim());
  assert.deepEqual(labels, ['Open File', 'Copy Path']);

  act(() => {
    (container.querySelector('button') as HTMLButtonElement).click();
  });
  assert.deepEqual(opened, ['/workspace/pie/reveal/docs/foo.md']);

  render(null, container);
  container.remove();
});

test('shared menu navigation wraps and skips disabled items', () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => render(h(PrimitiveMenu, { onClose: () => {} }), container));

  const items = container.querySelectorAll<HTMLButtonElement>('.context-menu-item');
  assert.equal(document.activeElement, items[0], 'first enabled item receives initial focus');
  keydown('ArrowDown');
  assert.equal(document.activeElement, items[2], 'disabled items are skipped');
  keydown('ArrowDown');
  assert.equal(document.activeElement, items[0], 'down navigation wraps');
  keydown('ArrowUp');
  assert.equal(document.activeElement, items[2], 'up navigation wraps');
  keydown('Home');
  assert.equal(document.activeElement, items[0]);
  keydown('End');
  assert.equal(document.activeElement, items[2]);

  act(() => render(null, container));
  container.remove();
});

test('shared menu repairs focus when a focused item is removed', () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => render(h(PrimitiveMenu, { onClose: () => {}, refocusKey: 'first' }), container));
  const last = container.querySelectorAll<HTMLButtonElement>('.context-menu-item')[2];
  last.focus();

  act(() => render(h(PrimitiveMenu, { onClose: () => {}, refocusKey: 'second', showLast: false }), container));
  assert.equal(document.activeElement, container.querySelector('.context-menu-item'));

  act(() => render(null, container));
  container.remove();
});

test('shared menu dismisses on outside mousedown, optional scroll, and one Escape closes the top menu', () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  let closes = 0;
  let laterListenerCalled = false;
  const laterListener = () => { laterListenerCalled = true; };

  let lowerCloses = 0;
  act(() => render(h('div', null,
    h(PrimitiveMenu, { onClose: () => { lowerCloses += 1; } }),
    h(PrimitiveMenu, { onClose: () => { closes += 1; }, closeOnScroll: true })), container));
  document.addEventListener('keydown', laterListener);
  keydown('Escape');
  assert.equal(closes, 1);
  assert.equal(lowerCloses, 0, 'Escape closes only the top overlay');
  assert.equal(laterListenerCalled, false, 'Escape propagation stops after the top menu');
  document.removeEventListener('keydown', laterListener);

  const outside = document.createElement('button');
  document.body.appendChild(outside);
  act(() => { outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
  assert.equal(closes, 2);
  act(() => { window.dispatchEvent(new Event('scroll')); });
  assert.equal(closes, 3);

  act(() => render(null, container));
  outside.remove();
  container.remove();
});

test('menu trigger ARIA and focus restore use the explicit trigger', () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  const trigger = document.createElement('button');
  document.body.appendChild(trigger);
  trigger.focus();

  act(() => render(h(PrimitiveMenu, { triggerEl: trigger, onClose: () => {} }), container));
  assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.notEqual(document.activeElement, trigger);

  act(() => render(null, container));
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, trigger);

  trigger.remove();
  container.remove();
});

test('clipboard writes are safe when unavailable or rejected', async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    assert.equal(await writeTextToClipboard('missing'), false);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('denied'); } },
    });
    assert.equal(await writeTextToClipboard('rejected'), false);
  } finally {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  }
});

// ─── Transcript item menus: message-scoped actions ──────────────────────────

const USER_MESSAGE_MENU: TranscriptMessageMenuInfo = {
  messageId: 'msg-1',
  role: 'user',
  plainText: 'Fix the failing test',
  editable: true,
  canTruncate: true,
};

interface MenuCapture {
  container: HTMLDivElement;
  edits: string[];
  truncates: string[];
  closes: () => number;
  labels: () => Array<string | undefined>;
  click: (label: string) => HTMLButtonElement;
}

function renderTranscriptMenu(options: {
  type?: Parameters<typeof ContextMenu>[0]['menu']['type'];
  rawData?: string;
  selectionText?: string;
  message?: Partial<TranscriptMessageMenuInfo> | null;
}): MenuCapture {
  const menuContainer = document.createElement('div');
  document.body.appendChild(menuContainer);
  const edits: string[] = [];
  const truncates: string[] = [];
  let closeCount = 0;
  act(() => {
    render(h(ContextMenu, {
      menu: {
        type: options.type ?? 'message',
        rawData: options.rawData ?? '{"role":"user"}',
        sessionPath: '/sessions/origin',
        selectionText: options.selectionText ?? '',
        message: options.message === undefined ? USER_MESSAGE_MENU : options.message,
        x: 10,
        y: 10,
        triggerEl: null,
      },
      prefs,
      onSetPrefs: () => {},
      onOpenFile: () => {},
      onEditMessage: (sessionPath, messageId) => { edits.push(`${sessionPath}:${messageId}`); },
      onTruncateAfter: (sessionPath, messageId) => { truncates.push(`${sessionPath}:${messageId}`); },
      onClose: () => { closeCount += 1; },
    }), menuContainer);
  });
  return {
    container: menuContainer,
    edits,
    truncates,
    closes: () => closeCount,
    labels: () => Array.from(menuContainer.querySelectorAll('button')).map((b) => b.textContent?.trim()),
    click: (label: string) => {
      const button = Array.from(menuContainer.querySelectorAll('button'))
        .find((el) => el.textContent?.trim().includes(label));
      assert.ok(button, `expected a ${label} button`);
      act(() => { (button as HTMLButtonElement).click(); });
      return button as HTMLButtonElement;
    },
  };
}

test('transcript message menu offers Copy text alongside Copy raw for a plain-text message', async () => {
  const writes: Array<{ call: string; text: string }> = [];
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { writes.push({ call: 'plain', text }); } },
    });
    const menu = renderTranscriptMenu({ rawData: '{"role":"user","markdown":"Fix the failing test"}' });
    assert.deepEqual(menu.labels(), ['Copy text', 'Copy raw', 'Edit', 'Delete from here']);
    menu.click('Copy text');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(writes, [{ call: 'plain', text: 'Fix the failing test' }]);
    render(null, menu.container);
    menu.container.remove();
  } finally {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  }
});

test('transcript message menu wires Edit to the startEdit path for eligible messages', () => {
  const menu = renderTranscriptMenu({});
  menu.click('Edit');
  assert.deepEqual(menu.edits, ['/sessions/origin:msg-1']);
  assert.equal(menu.closes(), 1);
  render(null, menu.container);
  menu.container.remove();
});

test('transcript message menu guards Delete from here behind a two-step confirm', () => {
  const menu = renderTranscriptMenu({});
  const first = menu.click('Delete from here');
  assert.match(first.textContent ?? '', /Confirm delete\?/);
  assert.deepEqual(menu.truncates, [], 'first click only arms the confirm');
  assert.equal(menu.closes(), 0);
  menu.click('Confirm delete?');
  assert.deepEqual(menu.truncates, ['/sessions/origin:msg-1']);
  assert.equal(menu.closes(), 1);
  render(null, menu.container);
  menu.container.remove();
});

test('assistant tool menu keeps auto-expand + Copy raw and omits message-only actions', () => {
  const menu = renderTranscriptMenu({
    type: 'toolCalls',
    rawData: '{"name":"read_file"}',
    message: null,
  });
  assert.deepEqual(menu.labels(), ['Auto-expand tool calls', 'Copy raw']);
  render(null, menu.container);
  menu.container.remove();
});

test('message menu without metadata keeps only the copy surface', () => {
  const menu = renderTranscriptMenu({ message: null });
  assert.deepEqual(menu.labels(), ['Copy raw']);
  render(null, menu.container);
  menu.container.remove();
});

test('message action visibility follows the captured metadata (read-only/assistant rows)', () => {
  const menu = renderTranscriptMenu({
    message: { messageId: 'msg-2', role: 'assistant', plainText: 'Answer body', editable: false, canTruncate: true },
  });
  assert.deepEqual(menu.labels(), ['Copy text', 'Copy raw', 'Delete from here']);
  render(null, menu.container);
  menu.container.remove();
});

test('reasoning menus copy the reasoning block while tool menus omit Copy text without renderer metadata', () => {
  const reasoning = renderTranscriptMenu({
    type: 'reasoning',
    rawData: 'private reasoning block',
    message: { role: 'assistant', plainText: 'private reasoning block', editable: false, canTruncate: false },
  });
  assert.deepEqual(reasoning.labels(), ['Auto-expand reasoning', 'Copy text', 'Copy raw']);
  render(null, reasoning.container);
  reasoning.container.remove();

  const tool = renderTranscriptMenu({
    type: 'toolCalls',
    rawData: '{"name":"bash"}',
    message: { role: 'assistant', plainText: undefined, editable: false, canTruncate: false },
  });
  assert.deepEqual(tool.labels(), ['Auto-expand tool calls', 'Copy raw']);
  render(null, tool.container);
  tool.container.remove();
});
