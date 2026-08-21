/**
 * Unit tests for `areMessageItemPropsEqual` — the custom `memo` comparer on
 * `MessageItem`. Symmetric to `message-equal.test.ts`: that file locks down
 * `chatMessageEqual` (the `message` field); this file locks down the OTHER
 * props, so a future prop added to `MessageItemProps` that the view or its
 * hooks depend on — if forgotten in the comparer — is caught here rather than
 * silently serving a stale render.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { areMessageItemPropsEqual, type MessageItemProps } from '../../../../src/webview/panel/transcript/message-item';
import type { ChatMessage, ChatPrefs } from '../../../../src/shared/protocol';
import { DEFAULT_CHAT_PREFS } from '../../../../src/shared/protocol';
import type { RenderToolCall, TranscriptContextMenuHandler } from '../../../../src/webview/panel/transcript/types';

// ─── Stable references (shared across prev/next so === passes) ──────────────
const stablePrefs: ChatPrefs = { ...DEFAULT_CHAT_PREFS };
const stableOnEditRequest = (_id: string): void => {};
const stableOnEditConfirm = (_id: string, _text: string): void => {};
const stableOnEditCancel = (): void => {};
const stableOnOpenFile = (_path: string): void => {};
const stableOnContextMenu = ((_t: never, _r: string, _e: MouseEvent): void => {}) as TranscriptContextMenuHandler;
const stableRenderToolCall = (() => null) as RenderToolCall;

function makeMessage(): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'hello world',
    status: 'completed',
    parts: [{ kind: 'text', text: 'hello world' }],
    toolCalls: [],
  };
}

function freshClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** The "previous" props: message is the canonical ref, everything else stable. */
function makeBaseProps(): MessageItemProps {
  return {
    message: makeMessage(),
    isStreaming: false,
    prefs: stablePrefs,
    readonly: false,
    workingDirectory: '/ws',
    editingId: null,
    onEditRequest: stableOnEditRequest,
    onEditConfirm: stableOnEditConfirm,
    onEditCancel: stableOnEditCancel,
    onOpenFile: stableOnOpenFile,
    onContextMenu: stableOnContextMenu,
    renderToolCall: stableRenderToolCall,
    isLastAssistantMessage: false,
    pruningHeaderState: undefined,
    activityState: undefined,
    sessionKey: 'sess',
  };
}

/**
 * The "next" props as they arrive on a host snapshot post: a fresh
 * structured-cloned message (different ref, identical content) but every other
 * prop reusing the same stable references the webview keeps across snapshots.
 * This is the case that must compare EQUAL so the row bails out of rendering.
 */
function makeEqualProps(): MessageItemProps {
  return {
    ...makeBaseProps(),
    message: freshClone(makeMessage()),
  };
}

test('areMessageItemPropsEqual returns true for a fresh-cloned message + identical stable props', () => {
  const prev = makeBaseProps();
  const next = makeEqualProps();
  assert.notEqual(prev.message, next.message);
  assert.equal(areMessageItemPropsEqual(prev, next), true);
});

// ─── Per-prop difference detection (each mutation flips the result to false) ──

test('detects message content difference', () => {
  const prev = makeBaseProps();
  const next = makeEqualProps();
  next.message.markdown = 'changed';
  assert.equal(areMessageItemPropsEqual(prev, next), false);
});

test('detects primitive render-policy and session-context differences', () => {
  const cases: Array<{ field: keyof MessageItemProps; value: unknown }> = [
    { field: 'isStreaming', value: true },
    { field: 'readonly', value: true },
    { field: 'isLastAssistantMessage', value: true },
    { field: 'deferHistoricalToolCalls', value: true },
    { field: 'requestCreatedAt', value: '2026-01-01T00:01:00.000Z' },
    { field: 'editingId', value: 'msg-9' },
    { field: 'workingDirectory', value: '/other' },
    { field: 'sessionKey', value: 'other-sess' },
  ];
  for (const { field, value } of cases) {
    const prev = makeBaseProps();
    const next = makeEqualProps();
    (next as unknown as Record<string, unknown>)[field] = value;
    assert.equal(areMessageItemPropsEqual(prev, next), false, `should detect ${field} difference`);
  }
});

test('detects prefs reference change (a different prefs object is not equal)', () => {
  const prev = makeBaseProps();
  const next = makeEqualProps();
  next.prefs = { ...stablePrefs };
  assert.notEqual(prev.prefs, next.prefs);
  assert.equal(areMessageItemPropsEqual(prev, next), false);
});

test('detects handler reference changes (onEditRequest / onEditConfirm / onEditCancel / onOpenFile / onContextMenu / renderToolCall)', () => {
  const replacements: Partial<Record<keyof MessageItemProps, unknown>> = {
    onEditRequest: (_id: string): void => {},
    onEditConfirm: (_id: string, _text: string): void => {},
    onEditCancel: (): void => {},
    onOpenFile: (_path: string): void => {},
    onContextMenu: (() => {}) as TranscriptContextMenuHandler,
    renderToolCall: (() => null) as RenderToolCall,
  };
  for (const [field, value] of Object.entries(replacements)) {
    const prev = makeBaseProps();
    const next = makeEqualProps();
    (next as unknown as Record<string, unknown>)[field] = value;
    assert.equal(areMessageItemPropsEqual(prev, next), false, `should detect ${field} reference change`);
  }
});

test('detects pruningHeaderState presence (undefined vs a value)', () => {
  const prev = makeBaseProps();
  const next = makeEqualProps();
  next.pruningHeaderState = { kind: 'result', details: {} as never, fallbackText: 'x' };
  assert.equal(areMessageItemPropsEqual(prev, next), false);
});

test('detects activityState presence (undefined vs a value)', () => {
  const prev = makeBaseProps();
  const next = makeEqualProps();
  next.activityState = { busy: true } as never;
  assert.equal(areMessageItemPropsEqual(prev, next), false);
});

test('treats both-undefined activityState / pruningHeaderState as equal', () => {
  const prev = makeBaseProps();
  const next = makeEqualProps();
  assert.equal(prev.activityState, next.activityState);
  assert.equal(prev.pruningHeaderState, next.pruningHeaderState);
  assert.equal(areMessageItemPropsEqual(prev, next), true);
});
