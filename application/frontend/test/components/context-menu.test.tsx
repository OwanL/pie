import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from '../helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useState } from 'preact/hooks';

import { ContextMenu, type ContextMenuState } from '../../lib/components/context-menu';
import { useAppHandlers, type AppHandlers } from '../../shell/use-app-handlers';
import { handleDelegatedFilePathContextMenu } from '../../transcript/file-path-interactions';
import { MARKDOWN_FILE_PATH_ATTRIBUTE } from '../../transcript/markdown-file-path';
import type { WebviewToHostMessage } from '../../../lib/protocol/index.js';
import { writeTextToClipboard } from '../../lib/components/clipboard';
import { useMenuListeners } from '../../lib/components/useMenuListeners';
import { useMenuTriggerAria } from '../../lib/components/useMenuTriggerAria';
import { useMenuViewportClamp } from '../../lib/components/useMenuViewportClamp';
import type { ChatPrefs } from '../../../lib/protocol/index.js';
import type { TranscriptMessageMenuInfo } from '../../transcript/types';

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

test('file-path context menu offers Open File and Copy Path without Copy raw', async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  const opened: Array<{ path: string; reference?: string; workingDirectory?: string }> = [];
  const copied: string[] = [];
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { copied.push(text); } },
    });

    act(() => {
      render(h(ContextMenu, {
        menu: {
          type: 'filePath',
          rawData: '/workspace/pie/reveal/docs/foo.md',
          filePath: { reference: 'reveal/docs/foo.md', workingDirectory: '/workspace/pie' },
          sessionPath: null,
          selectionText: '',
          x: 10,
          y: 10,
          triggerEl: null,
        },
        prefs,
        onSetPrefs: () => {},
        onOpenFile: (path, reference, workingDirectory) => opened.push({ path, reference, workingDirectory }),
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
    assert.deepEqual(opened, [{
      path: '/workspace/pie/reveal/docs/foo.md',
      reference: 'reveal/docs/foo.md',
      workingDirectory: '/workspace/pie',
    }]);

    act(() => {
      (container.querySelectorAll('button')[1] as HTMLButtonElement).click();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(copied, ['/workspace/pie/reveal/docs/foo.md'], 'Copy Path keeps using the resolved rawData');
  } finally {
    render(null, container);
    container.remove();
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  }
});

test('file-path Open File keeps its captured cwd after the active session changes', () => {
  const menuContainer = document.createElement('div');
  document.body.appendChild(menuContainer);
  const activeSessionPathRef = { current: '/sessions/old' };
  const posted: WebviewToHostMessage[] = [];
  let handlers: AppHandlers | undefined;

  function AppHandlerHarness() {
    const [menu, setMenu] = useState<ContextMenuState | null>(null);
    handlers = useAppHandlers(
      (message) => { posted.push(message); return true; },
      activeSessionPathRef,
      () => {},
      () => {},
      false,
      setMenu,
      () => {},
      true,
    );
    return menu ? h(ContextMenu, {
      menu,
      prefs,
      onSetPrefs: () => {},
      onOpenFile: handlers.handleOpenFile,
      onEditMessage: () => {},
      onTruncateAfter: () => {},
      onClose: () => setMenu(null),
    }) : null;
  }

  act(() => render(h(AppHandlerHarness, null), menuContainer));
  assert.ok(handlers, 'application handlers should mount');
  const link = document.createElement('a');
  link.setAttribute(MARKDOWN_FILE_PATH_ATTRIBUTE, 'README.md');
  document.body.appendChild(link);
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 14 });
  link.dispatchEvent(event);
  act(() => {
    assert.equal(handleDelegatedFilePathContextMenu(event, '/workspace/old', handlers!.handleOpenContextMenu), true);
  });

  // Switching the mutable active-session ref after the menu opens must not
  // replace the renderer-captured cwd used by basename fallback.
  activeSessionPathRef.current = '/sessions/new';
  const openButton = Array.from(menuContainer.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === 'Open File');
  assert.ok(openButton, 'the captured file menu should render Open File');
  act(() => { (openButton as HTMLButtonElement).click(); });
  assert.deepEqual(posted, [{
    type: 'openFile',
    path: '/workspace/old/README.md',
    reference: 'README.md',
    workingDirectory: '/workspace/old',
  }]);

  render(null, menuContainer);
  menuContainer.remove();
  link.remove();
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
  markdownText: 'Fix **the failing test**',
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
  selectionMarkdown?: string;
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
        selectionMarkdown: options.selectionMarkdown,
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

test('transcript message menu offers readable Copy and Copy as Markdown without exposing raw JSON', async () => {
  const writes: Array<{ call: string; text: string }> = [];
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { writes.push({ call: 'plain', text }); } },
    });
    const menu = renderTranscriptMenu({ rawData: '{"role":"user","markdown":"Fix the failing test"}' });
    assert.deepEqual(menu.labels(), ['Copy', 'Copy as Markdown', 'Edit', 'Delete from here']);
    menu.click('Copy');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(writes, [{ call: 'plain', text: 'Fix the failing test' }]);
    menu.click('Copy as Markdown');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(writes[1], { call: 'plain', text: 'Fix **the failing test**' });
    render(null, menu.container);
    menu.container.remove();
  } finally {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  }
});

test('both message copy actions use the pre-focus selection instead of the whole message', async () => {
  const writes: string[] = [];
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { writes.push(text); } },
    });
    const menu = renderTranscriptMenu({
      selectionText: 'selected text',
      selectionMarkdown: '**selected** text',
    });
    menu.click('Copy');
    await new Promise((resolve) => setTimeout(resolve, 0));
    menu.click('Copy as Markdown');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(writes, ['selected text', '**selected** text']);
    assert.equal(menu.closes(), 2);
    render(null, menu.container);
    menu.container.remove();
  } finally {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  }
});

test('keyboard Ctrl+C copies only the captured plain selection and leaves the menu open', async () => {
  const writes: string[] = [];
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { writes.push(text); } },
    });
    const menu = renderTranscriptMenu({ selectionText: 'plain selected text', selectionMarkdown: '**markdown selected text**' });
    const target = menu.container.querySelector('button')!;
    const event = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => { target.dispatchEvent(event); });
    assert.equal(event.defaultPrevented, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(writes, ['plain selected text']);
    assert.equal(menu.closes(), 0);
    assert.ok(menu.container.isConnected);
    render(null, menu.container);
    menu.container.remove();
  } finally {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  }
});

test('keyboard Ctrl+C is not intercepted without a selection or outside the menu', () => {
  const empty = renderTranscriptMenu({});
  const insideEvent = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
  act(() => { empty.container.querySelector('button')!.dispatchEvent(insideEvent); });
  assert.equal(insideEvent.defaultPrevented, false);

  const selected = renderTranscriptMenu({ selectionText: 'selected' });
  const outside = document.createElement('button');
  document.body.appendChild(outside);
  const outsideEvent = new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true });
  act(() => { outside.dispatchEvent(outsideEvent); });
  assert.equal(outsideEvent.defaultPrevented, false);

  render(null, empty.container);
  render(null, selected.container);
  empty.container.remove();
  selected.container.remove();
  outside.remove();
});

test('keyboard Ctrl+C is not intercepted from an editable menu input', () => {
  const menu = renderTranscriptMenu({ selectionText: 'selected' });
  const input = document.createElement('input');
  menu.container.appendChild(input);
  const event = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
  act(() => { input.dispatchEvent(event); });
  assert.equal(event.defaultPrevented, false);
  render(null, menu.container);
  menu.container.remove();
});

test('keyboard Ctrl+C rejection uses the existing copy failure notice without closing', async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('denied'); } },
    });
    const menu = renderTranscriptMenu({ selectionText: 'selected' });
    const event = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => { menu.container.querySelector('button')!.dispatchEvent(event); });
    assert.equal(event.defaultPrevented, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(menu.closes(), 0);
    assert.equal(menu.container.querySelector('[role="status"]')?.textContent, 'Couldn’t copy to clipboard.');
    render(null, menu.container);
    menu.container.remove();
  } finally {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  }
});

test('clipboard failure remains visible instead of closing as if copying succeeded', async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('denied'); } },
    });
    const menu = renderTranscriptMenu({});
    menu.click('Copy');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(menu.closes(), 0);
    assert.equal(menu.container.querySelector('[role="status"]')?.textContent, 'Couldn’t copy to clipboard.');
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

test('message menu without metadata never exposes the raw message JSON', () => {
  const menu = renderTranscriptMenu({ message: null });
  assert.deepEqual(menu.labels(), ['Copy', 'Copy as Markdown']);
  render(null, menu.container);
  menu.container.remove();
});

test('message action visibility follows the captured metadata (read-only/assistant rows)', () => {
  const menu = renderTranscriptMenu({
    message: { messageId: 'msg-2', role: 'assistant', plainText: 'Answer body', editable: false, canTruncate: true },
  });
  assert.deepEqual(menu.labels(), ['Copy', 'Copy as Markdown', 'Delete from here']);
  render(null, menu.container);
  menu.container.remove();
});

test('reasoning menus copy the reasoning block while tool menus omit Copy text without renderer metadata', () => {
  const reasoning = renderTranscriptMenu({
    type: 'reasoning',
    rawData: 'private reasoning block',
    message: { role: 'assistant', plainText: 'private reasoning block', editable: false, canTruncate: false },
  });
  assert.deepEqual(reasoning.labels(), ['Auto-expand reasoning', 'Copy', 'Copy as Markdown']);
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
