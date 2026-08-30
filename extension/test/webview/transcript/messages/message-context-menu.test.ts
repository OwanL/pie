/**
 * Transcript item menus: message-level context-menu metadata binding.
 *
 * `MessageItemView` binds ONE `TranscriptMessageMenuInfo` per row and a
 * row-level generic-message fallback, so right-clicks anywhere in the row
 * (assistant text, reasoning, tool cards, user bubbles, system messages,
 * compaction-summary shells) reach the same enriched menu — while nested
 * specific menus (tool cards, file paths, reasoning) keep precedence: the
 * shell fallback honors `defaultPrevented` and never overwrites them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../../_helpers/dom';
installDom();

// MessageItemView renders markdown, which routes through DOMPurify. Stub it to
// identity (same perf/app-smoke pattern) so no real sanitizer is needed.
import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import type { ChatMessage, ChatPrefs, LazyDetailRef } from '../../../../src/shared/protocol';
import { DEFAULT_CHAT_PREFS } from '../../../../src/shared/protocol';
import { MessageItemView } from '../../../../src/webview/panel/transcript/message-item';
import { isTruncateEligibleMessage } from '../../../../src/webview/panel/transcript/message-item/hooks';
import { clearLazyDetailCache, receiveLazyDetailResult } from '../../../../src/webview/panel/transcript/lazy-detail-store';
import type { TranscriptContextMenuType } from '../../../../src/webview/panel/chat-prefs';
import type {
  RenderToolCall,
  TranscriptContextMenuHandler,
  TranscriptMessageMenuInfo,
} from '../../../../src/webview/panel/transcript/types';
const PREFS: ChatPrefs = { ...DEFAULT_CHAT_PREFS };

// ─── isTruncateEligibleMessage (menu gating per message kind) ───────────────

test('isTruncateEligibleMessage: durable settled messages qualify; streaming/queued/local do not', () => {
  const base: ChatMessage = {
    id: 'durable-1', role: 'user', createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'hello', status: 'completed',
  };
  assert.equal(isTruncateEligibleMessage(base), true);
  assert.equal(isTruncateEligibleMessage({ ...base, status: 'interrupted' }), true);
  assert.equal(isTruncateEligibleMessage({ ...base, status: 'error' }), true);
  assert.equal(isTruncateEligibleMessage({ ...base, status: 'streaming' }), false);
  assert.equal(isTruncateEligibleMessage({ ...base, status: 'queued' }), false);
  assert.equal(isTruncateEligibleMessage({ ...base, id: 'local:abc' }), false);
  assert.equal(isTruncateEligibleMessage({ ...base, id: 'local:edit:abc' }), false);
});

// ─── Row rendering harness ─────────────────────────────────────────────────

interface CapturedMenu {
  type: TranscriptContextMenuType;
  rawData: string;
  event: MouseEvent;
  message: Partial<TranscriptMessageMenuInfo> | undefined;
}

interface RowHarness {
  host: HTMLDivElement;
  menus: CapturedMenu[];
  contextMenuAt: (selector: string, prevent?: boolean) => void;
}

function renderRow(message: ChatMessage, options?: {
  readonly?: boolean;
  renderToolCall?: RenderToolCall;
}): RowHarness {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const menus: CapturedMenu[] = [];
  const onContextMenu: TranscriptContextMenuHandler = (type, rawData, e, meta) => {
    menus.push({ type, rawData, event: e, message: meta });
  };
  act(() => {
    render(h(MessageItemView, {
      message,
      isStreaming: false,
      prefs: PREFS,
      readonly: options?.readonly ?? false,
      workingDirectory: '/ws',
      editingId: null,
      onEditRequest: () => {},
      onEditConfirm: () => {},
      onEditCancel: () => {},
      onOpenFile: () => {},
      onContextMenu,
      renderToolCall: options?.renderToolCall ?? (() => null),
      sessionKey: '/sessions/rendered-old',
    }), host);
  });
  return {
    host,
    menus,
    contextMenuAt(selector, prevent = false) {
      const target = host.querySelector(selector);
      assert.ok(target, `expected an element matching ${selector}`);
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      if (prevent) event.preventDefault();
      act(() => {
        target.dispatchEvent(event);
      });
    },
  };
}

function unmount(harness: RowHarness): void {
  act(() => { render(null, harness.host); });
  harness.host.remove();
}

function userMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'u-durable',
    role: 'user',
    createdAt: '2026-01-01T12:00:00.000Z',
    markdown: 'Please fix the test',
    status: 'completed',
    ...overrides,
  };
}

// ─── Keyboard invocation (ContextMenu/Menu key, Shift+F10) ─────────────────

function keydown(key: string, shiftKey = false): KeyboardEvent {
  return new window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
}

function stubRect(el: HTMLElement, left: number, top: number, width: number, height: number): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => null }),
  });
}

test('message shells are keyboard tab stops for the row context menu', () => {
  const harness = renderRow(userMessage());
  const shell = harness.host.querySelector<HTMLElement>('[data-role="user"]');
  assert.ok(shell);
  assert.equal(shell!.getAttribute('tabindex'), '0');
  unmount(harness);
});

test('Shift+F10 focused on the shell opens the generic row menu at the shell rect', () => {
  const harness = renderRow(userMessage());
  const shell = harness.host.querySelector<HTMLElement>('[data-role="user"]')!;
  stubRect(shell, 40, 80, 200, 60);
  act(() => { shell.focus(); });
  act(() => { shell.dispatchEvent(keydown('F10', true)); });
  assert.equal(harness.menus.length, 1);
  const menu = harness.menus[0];
  assert.equal(menu.type, 'message', 'the keyboard request routes through the row onContextMenu open path');
  // The synthetic contextmenu is grounded at the center of the focused shell.
  assert.equal(menu.event.clientX, 140);
  assert.equal(menu.event.clientY, 110);
  // Row metadata is still bound (Copy text / Edit / Delete from here work).
  assert.equal(menu.message?.messageId, 'u-durable');
  assert.equal(menu.message?.plainText, 'Please fix the test');
  unmount(harness);
});

test('the ContextMenu and Menu keys open the same row menu from the focused shell', () => {
  for (const key of ['ContextMenu', 'Menu']) {
    const harness = renderRow(userMessage());
    const shell = harness.host.querySelector<HTMLElement>('[data-role="user"]')!;
    act(() => { shell.dispatchEvent(keydown(key)); });
    assert.equal(harness.menus.length, 1, `${key} key opens the row menu`);
    assert.equal(harness.menus[0].type, 'message');
    unmount(harness);
  }
});

test('plain F10 does not open the row menu (Shift+F10 only)', () => {
  const harness = renderRow(userMessage());
  const shell = harness.host.querySelector<HTMLElement>('[data-role="user"]')!;
  act(() => { shell.dispatchEvent(keydown('F10', false)); });
  assert.equal(harness.menus.length, 0);
  unmount(harness);
});

// ─── Reasoning menu value (lazy-detail display text) ───────────────────────

test('a loaded reasoning detail is the reasoning menu value, not the compacted summary', () => {
  clearLazyDetailCache();
  try {
    const detailRef: LazyDetailRef = {
      key: 'durable:reasoning:a-1:0', kind: 'reasoning', source: 'durable',
      sessionPath: '/session', messageId: 'a-1', partIndex: 0,
      sizeBytes: 1200, summary: 'Compact summary', available: true,
    };
    // Preload the shared lazy-detail store with the durable detail (same
    // pattern as tool-call-lazy-detail.test.ts).
    receiveLazyDetailResult({
      sessionPath: detailRef.sessionPath, key: detailRef.key,
      status: 'loaded', value: 'THE FULL DETAIL BODY', sizeBytes: detailRef.sizeBytes,
    });
    const message: ChatMessage = {
      id: 'a-1', role: 'assistant', createdAt: '2026-01-01T12:00:02.000Z',
      markdown: 'Plan',
      parts: [{ kind: 'reasoning', text: 'Compact summary', detailRef }],
      status: 'completed',
    };
    const harness = renderRow(message);
    const header = harness.host.querySelector('.reasoning-block .collapsible-header') as HTMLElement | null;
    assert.ok(header, 'reasoning block renders with its collapsible header');
    act(() => {
      header!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    assert.equal(harness.menus.length, 1);
    assert.equal(harness.menus[0].type, 'reasoning');
    // rawData AND the bound plainText are the loaded detail — Copy raw / Copy
    // text target what the block displays, not the short summary.
    assert.equal(harness.menus[0].rawData, 'THE FULL DETAIL BODY');
    assert.equal(harness.menus[0].message?.plainText, 'THE FULL DETAIL BODY');
  } finally {
    clearLazyDetailCache();
  }
});

test('reasoning without a lazy detail keeps the complete part text as the menu value', () => {
  const message: ChatMessage = {
    id: 'a-2', role: 'assistant', createdAt: '2026-01-01T12:00:03.000Z',
    markdown: 'Done',
    parts: [{ kind: 'reasoning', text: 'complete reasoning body' }],
    status: 'completed',
  };
  const harness = renderRow(message);
  harness.contextMenuAt('.reasoning-block');
  assert.equal(harness.menus.length, 1);
  assert.equal(harness.menus[0].type, 'reasoning');
  assert.equal(harness.menus[0].rawData, 'complete reasoning body');
  assert.equal(harness.menus[0].message?.plainText, 'complete reasoning body');
});

test('user message row binds message metadata and opens the generic menu (Edit + Delete from here eligible)', () => {
  const harness = renderRow(userMessage());
  harness.contextMenuAt('[data-role="user"]');
  assert.equal(harness.menus.length, 1);
  const menu = harness.menus[0];
  assert.equal(menu.type, 'message');
  const raw = JSON.parse(menu.rawData) as { role?: string; markdown?: string };
  assert.equal(raw.role, 'user');
  assert.equal(raw.markdown, 'Please fix the test');
  assert.ok(menu.message);
  assert.equal(menu.message.messageId, 'u-durable');
  assert.equal(menu.message.role, 'user');
  assert.equal(menu.message.sessionPath, '/sessions/rendered-old');
  assert.equal(menu.message.plainText, 'Please fix the test');
  assert.equal(menu.message.editable, true);
  assert.equal(menu.message.canTruncate, true);
  assert.equal(menu.event.defaultPrevented, true);
});

test('queued user messages stay editable but cannot anchor a truncation', () => {
  const harness = renderRow(userMessage({ id: 'u-queued', status: 'queued' }));
  harness.contextMenuAt('[data-role="user"]');
  assert.equal(harness.menus.length, 1);
  assert.equal(harness.menus[0].message?.editable, true);
  assert.equal(harness.menus[0].message?.canTruncate, false);
});

test('system message rows get the generic menu with Edit ineligible and truncation eligible', () => {
  const harness = renderRow({
    id: 'sys-1',
    role: 'system',
    createdAt: '2026-01-01T12:00:01.000Z',
    markdown: 'System note',
    status: 'completed',
  });
  harness.contextMenuAt('[data-role="system"]');
  assert.equal(harness.menus.length, 1);
  assert.equal(harness.menus[0].message?.role, 'system');
  assert.equal(harness.menus[0].message?.plainText, 'System note');
  assert.equal(harness.menus[0].message?.editable, false);
  assert.equal(harness.menus[0].message?.canTruncate, true);
});

test('local optimistic user rows are never truncation anchors', () => {
  const harness = renderRow(userMessage({ id: 'local:abc' }));
  harness.contextMenuAt('[data-role="user"]');
  assert.equal(harness.menus[0].message?.canTruncate, false);
});

test('nested subagent rows (readonly) may not offer truncation or edit', () => {
  // Nested subagent transcripts render MessageItem with `readonly` and
  // synthetic ids that no durable session entry would match.
  const harness = renderRow(userMessage({ id: 'sub-tool-1-0' }), { readonly: true });
  harness.contextMenuAt('[data-role="user"]');
  assert.equal(harness.menus[0].message?.editable, false);
  assert.equal(harness.menus[0].message?.canTruncate, false);
});

test('tool card menus keep precedence: preventDefault stops the row-level message fallback', () => {
  const message: ChatMessage = {
    id: 'a-1',
    role: 'assistant',
    createdAt: '2026-01-01T12:00:02.000Z',
    markdown: 'Working',
    parts: [
      { kind: 'text', text: 'Working' },
      { kind: 'toolCall', toolCall: {
        id: 'tool-1', name: 'read_file', input: {}, argumentsText: '{}',
        status: 'completed', startedAt: 1767225602100, durationMs: 300,
      } },
    ],
    status: 'completed',
  };
  const renderToolCall: RenderToolCall = (toolCall, onContext) => h('div', {
    class: 'fake-tool-card',
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      onContext('toolCalls', '{"name":"read_file"}', e);
    },
    'data-tool-menu': 'true',
  }, toolCall.name);

  const harness = renderRow(message, { renderToolCall });
  harness.contextMenuAt('.fake-tool-card');
  assert.equal(harness.menus.length, 1, 'tool menu opens; the bubbling generic fallback must not overwrite it');
  assert.equal(harness.menus[0].type, 'toolCalls');
  // The message metadata is STILL bound for the tool menu (host can enrich).
  assert.equal(harness.menus[0].message?.messageId, 'a-1');
  assert.equal(harness.menus[0].message?.role, 'assistant');
  assert.equal(harness.menus[0].message?.canTruncate, true);
});

test('tool card body without its own menu falls through to the generic message menu', () => {
  const message: ChatMessage = {
    id: 'a-2',
    role: 'assistant',
    createdAt: '2026-01-01T12:00:03.000Z',
    markdown: 'Answer',
    parts: [{ kind: 'text', text: 'Answer' }],
    status: 'completed',
  };
  const harness = renderRow(message, {
    renderToolCall: () => null,
  });
  // Right-click the assistant row (outside any specific menu region).
  harness.contextMenuAt(`[data-message-id="${message.id}"]`);
  assert.equal(harness.menus.length, 1);
  assert.equal(harness.menus[0].type, 'message');
  assert.equal(harness.menus[0].message?.plainText, 'Answer');
});