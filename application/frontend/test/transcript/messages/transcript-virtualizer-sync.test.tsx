/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import assert from 'node:assert/strict';
import test from 'node:test';
import { h, render, options } from 'preact';
import type { Virtualizer } from '@tanstack/virtual-core';
import { installDom } from '../../helpers/dom';
import { buildTranscriptRows, scopeTranscriptRowsToSession } from '../../../transcript/virtual-list-rows';

installDom();

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
    HTMLElement.prototype.getBoundingClientRect = boundingRect;
    render(null, root);
    root.remove();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
      else delete (HTMLElement.prototype as any)[key];
    }
  }
});
