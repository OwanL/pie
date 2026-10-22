/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import assert from 'node:assert/strict';
import test from 'node:test';
import { h, render, options } from 'preact';
import { act } from 'preact/test-utils';
import type { Virtualizer } from '@tanstack/virtual-core';
import { installDom } from '../../helpers/dom';
import { buildTranscriptRows, scopeTranscriptRowsToSession } from '../../../transcript/virtual-list-rows';

installDom();

function fakeTranscriptLayout(): () => void {
  const descriptors = ['offsetWidth', 'offsetHeight', 'clientHeight', 'scrollHeight'].map(
    (key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)] as const);
  const boundingRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 320, height: this.classList.contains('transcript-virtual') ? 552 : 100,
      top: 0, left: 0, right: 320, bottom: 100, x: 0, y: 0, toJSON() {} } as DOMRect;
  };
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 320 },
    offsetHeight: { configurable: true, get() { return this.classList.contains('transcript-virtual') ? 552 : 100; } },
    clientHeight: { configurable: true, get: () => 552 },
    scrollHeight: { configurable: true, get() {
      return Number.parseFloat(this.querySelector('.transcript-virtual-inner')?.style.height ?? '0') || 0;
    } },
  });
  return () => {
    HTMLElement.prototype.getBoundingClientRect = boundingRect;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
      else delete (HTMLElement.prototype as any)[key];
    }
  };
}

test('real tool disclosure pins only while focused; editor pin and saved expansion are independent', async () => {
  await import('../../../transcript/rows/message-row');
  const { TranscriptVirtualList } = await import('../../../transcript/virtual-list');
  const previousCSS = (globalThis as any).CSS;
  (globalThis as any).CSS = (window as any).CSS;
  const root = document.createElement('div');
  document.body.append(root);
  let instance: Virtualizer<any, any> | undefined;
  const originalVNode = options.vnode;
  options.vnode = (vnode) => {
    originalVNode?.(vnode);
    const current = (vnode.props as any)?.virtualizer;
    if (current) instance = current;
  };
  const restoreLayout = fakeTranscriptLayout();
  const toolCall = { id: 'pin-disclosure-tool', name: 'bash', args: { command: 'echo saved' }, status: 'completed', result: 'saved' };
  const props = {
    sessionKey: '/pin-disclosure',
    transcriptWindow: { loadedStart: 0, loadedEnd: 3, totalCount: 3, hasOlder: false,
      hasNewer: false, isPartial: false, hasUserMessages: true },
    transcript: [
      { id: 'pin-tail', role: 'user', createdAt: '', markdown: 'tail', status: 'completed' },
      { id: 'pin-editor', role: 'user', createdAt: '', markdown: 'edit me', status: 'completed' },
      { id: 'pin-tool-message', role: 'assistant', createdAt: '', markdown: '', status: 'completed',
        parts: [{ kind: 'toolCall', toolCall }], toolCalls: [toolCall] },
    ],
    busy: false, prefs: { showPruningMessages: true }, pruningSettings: {}, systemPrompts: [],
    pruningResult: null, workingDirectory: null, editingId: null as string | null,
    onEditRequest() {}, onEditConfirm() {}, onEditCancel() {}, onOpenFile() {}, onContextMenu() {},
  };
  const paint = async () => {
    // Flush mount effects (including disclosure-cache synchronization) before
    // interacting. A wall-clock delay can leave those effects pending until
    // the click's act(), where they overwrite the newly toggled state.
    await act(() => render(h(TranscriptVirtualList, props as never), root));
    // The virtualizer publishes its measured range on the next animation frame.
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
  };
  try {
    await paint();
    const toggle = root.querySelector<HTMLButtonElement>('.tool-call-header .tool-call-toggle')!;
    assert.ok(toggle, `list renders the real ToolCallHeader: ${root.innerHTML}`);
    const index = Number(toggle.closest<HTMLElement>('[data-index]')!.dataset.index);
    const range = { startIndex: 0, endIndex: 0, overscan: 0, count: 3 };
    toggle.focus();
    act(() => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.equal(root.querySelector('.tool-call-toggle')?.getAttribute('aria-expanded'), 'true');
    assert.ok(instance!.options.rangeExtractor(range).includes(index), 'focused tool stays in an offscreen range');
    toggle.blur();
    assert.deepEqual(instance!.options.rangeExtractor(range), [0], 'blurred expanded tool follows normal virtualization');
    props.editingId = 'pin-editor';
    await paint();
    assert.deepEqual(instance!.options.rangeExtractor(range), [0, 1], 'inline editor remains pinned without focus');
    await act(() => render(null, root));
    props.editingId = null;
    await paint();
    assert.equal(root.querySelector('.tool-call-toggle')?.getAttribute('aria-expanded'), 'true',
      'disclosure cache preserves expansion across list unmount/remount');
    assert.deepEqual(instance!.options.rangeExtractor(range), [0]);
  } finally {
    await act(() => render(null, root));
    options.vnode = originalVNode;
    if (previousCSS === undefined) delete (globalThis as any).CSS;
    else (globalThis as any).CSS = previousCSS;
    restoreLayout();
    root.remove();
  }
});

test('same mounted list uses current catalog row keys and count on every render', async () => {
  await import('../../../transcript/rows/message-row');
  const { TranscriptVirtualList } = await import('../../../transcript/virtual-list');
  const root = document.createElement('div');
  document.body.append(root);
  const transcript = Array.from({ length: 60 }, (_, index) => ({
    id: `message-${240 + index}`, role: 'user' as const, createdAt: '',
    markdown: `tail-marker-${240 + index}`, status: 'completed' as const,
  }));
  const transcriptWindow = { loadedStart: 240, loadedEnd: 300, totalCount: 300,
    hasOlder: true, hasNewer: false, isPartial: true, hasUserMessages: true };
  let expectedKeys: string[] = [];
  let renders = 0;
  let instance: Virtualizer<any, any> | undefined;
  const originalVNode = options.vnode;
  const check = (current: Virtualizer<any, any>) => {
    assert.equal(current, instance, 'catalog changes must not remount the virtualizer');
    assert.equal(current.options.count, expectedKeys.length, 'render must use current count');
    assert.deepEqual(expectedKeys.map((_, index) => current.options.getItemKey(index)), expectedKeys);
  };
  options.vnode = (vnode) => {
    originalVNode?.(vnode);
    const current = (vnode.props as any)?.virtualizer as Virtualizer<any, any> | undefined;
    if (!current) return;
    if (instance) { check(current); return; }
    instance = current;
    check(current);
    const original = current.getVirtualItems;
    // Virtual-core installs this method on each instance, not its prototype.
    // Capture it from the first child vnode, before later list renders consume it.
    current.getVirtualItems = Object.assign(function (this: Virtualizer<any, any>) {
      check(this);
      const items = original.call(this);
      for (const item of items) assert.equal(item.key, expectedKeys[item.index]);
      renders++;
      return items;
    }, { updateDeps: original.updateDeps });
  };
  const restoreLayout = fakeTranscriptLayout();
  try {
    for (const count of [7, 0, 7]) {
      expectedKeys = scopeTranscriptRowsToSession(buildTranscriptRows({
        transcript, systemPromptCount: count, hasOlder: true, hasNewer: false,
        olderCount: 240, newerCount: 0, busy: false, showPruningMessages: true,
      }), '/warm').map((row) => row.key);
      render(h(TranscriptVirtualList, {
        sessionKey: '/warm', transcript, transcriptWindow, busy: false,
        prefs: { showPruningMessages: true }, pruningSettings: {},
        systemPrompts: Array.from({ length: count }, (_, index) => ({ id: `catalog-${index}`, title: 'catalog', content: 'catalog' })),
        pruningResult: null, workingDirectory: null, editingId: null,
        onEditRequest() {}, onEditConfirm() {}, onEditCancel() {}, onOpenFile() {}, onContextMenu() {},
      } as never), root);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const scrollBox = root.querySelector<HTMLElement>('.transcript-virtual')!;
      for (let settle = 0; settle < 5; settle++) {
        scrollBox.scrollTop = Math.max(0, scrollBox.scrollHeight - scrollBox.clientHeight);
        scrollBox.dispatchEvent(new Event('scroll'));
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      assert.ok(root.textContent?.includes('tail-marker-299'), `settled physical bottom must contain the tail: ${root.textContent} / ${scrollBox.scrollTop} / ${scrollBox.scrollHeight}`);
    }
    assert.ok(renders >= 3);
  } finally {
    options.vnode = originalVNode;
    render(null, root);
    root.remove();
    restoreLayout();
  }
});
