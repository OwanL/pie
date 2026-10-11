import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { installDom } from '../../helpers/dom';
installDom();
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import renderToString from 'preact-render-to-string';
import { visualToolInput, liveToolPreview, isRedundantToolConfirmation } from '../../../transcript/tool-call-card/display-model';
import { ToolCallBody } from '../../../transcript/tool-call-card/tool-call-body';
import { RawToolInspector, serializeModelExchange } from '../../../transcript/tool-call-card/raw-tool-inspector';
import { clearLazyDetailCache, receiveLazyDetailResult, setLazyDetailPostMessage } from '../../../transcript/lazy-detail-store';
import { AskUserContext } from '../../../lib/hooks/ask-user-context';
import { SubagentCallContext } from '../../../transcript/subagent-call-context';
import type { ToolCall, WebviewToHostMessage } from '../../../../lib/protocol/index.js';

const base: ToolCall = { id: 'test', name: 'edit', input: {}, status: 'completed' };
const noop = () => undefined;
let container: HTMLElement;
beforeEach(() => { clearLazyDetailCache(); container = document.createElement('div'); document.body.appendChild(container); });
afterEach(() => { render(null, container); container.remove(); clearLazyDetailCache(); });

test('draft visual repair decodes partial replacements without changing the execution input', () => {
  const call = { ...base, status: 'drafting' as const, input: 'provider input', argumentsText: '{"path":"a.ts","edits":[{"oldText":"before","newText":"first\\nsecond\\u0041' };
  assert.deepEqual(visualToolInput(call), { path: 'a.ts', edits: [{ oldText: 'before', newText: 'first\nsecondA' }] });
  assert.equal(call.input, 'provider input');
  assert.equal(liveToolPreview(call)?.text, 'first\nsecondA');
});

test('unfinished escapes and incomplete unicode stay display-only and malformed JSON falls back safely', () => {
  assert.deepEqual(visualToolInput({ ...base, status: 'drafting', argumentsText: '{"content":"a\\u00' }), { content: 'a' });
  assert.deepEqual(visualToolInput({ ...base, status: 'drafting', argumentsText: '{"content":"a\\' }), { content: 'a' });
  const malformed = { ...base, status: 'drafting' as const, input: '<img onerror=alert(1)>', argumentsText: '{not-json' };
  assert.equal(visualToolInput(malformed), malformed.input);
  const html = renderToString(h(ToolCallBody, { toolCall: malformed, onOpenFile: noop }));
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /not executed|tool-call-provisional-notice/);
});

test('partial JSON preserves literal backslash-u suffixes in visual input, previews and expanded content', () => {
  for (const status of ['drafting', 'ready'] as const) {
    for (const content of [String.raw`prefix\u`, String.raw`prefix\u12`, String.raw`prefix\u0041`, String.raw`prefix\\u12`]) {
      const argumentsText = JSON.stringify({ content }).slice(0, -2);
      const input = Object.freeze({ content: 'execution input' });
      const call = Object.freeze({ ...base, name: 'write', status, input, argumentsText });
      assert.deepEqual(visualToolInput(call), { content });
      assert.equal(liveToolPreview(call)?.text, content);
      const html = renderToString(h(ToolCallBody, { toolCall: call, onOpenFile: noop }));
      assert.ok(html.replace(/<[^>]*>/g, '').includes(content));
      assert.equal(call.input, input);
      assert.equal(call.argumentsText, argumentsText);
      assert.equal(input.content, 'execution input');
    }
  }
});

test('partial JSON removes genuine incomplete unicode after literal backslashes without losing them', () => {
  for (const content of ['prefix', 'prefix\\', 'prefix\\\\', String.raw`prefix\u12`]) {
    for (const suffix of [String.raw`\u`, String.raw`\u1`, String.raw`\u12`, String.raw`\uAbC`, '\\']) {
      const argumentsText = JSON.stringify({ content }).slice(0, -2) + suffix;
      const call = { ...base, name: 'write', status: 'drafting' as const, input: 'execution input', argumentsText };
      assert.deepEqual(visualToolInput(call), { content });
      assert.equal(liveToolPreview(call)?.text, content);
      assert.equal(call.input, 'execution input');
      assert.equal(call.argumentsText, argumentsText);
    }
  }
});

test('running previews retain only a bounded output tail and disappear at completion', () => {
  const call = { ...base, name: 'bash', status: 'running' as const, result: { content: [{ type: 'text', text: 'old\n1\n2\n3\n4\n' }] } };
  assert.deepEqual(liveToolPreview(call, 100), { text: '2\n3\n4', provisional: false, truncated: true, lines: 3 });
  assert.equal(liveToolPreview({ ...call, status: 'completed' }), null);
  assert.equal(liveToolPreview({ ...call, result: undefined }), null);
});

test('short live previews do not reserve empty rows and growth stays bounded', () => {
  const call = { ...base, name: 'bash', status: 'running' as const, result: 'one line\n' };
  assert.equal(liveToolPreview(call, 3)?.lines, 1);
  assert.equal(liveToolPreview({ ...call, result: 'one line\r\n\r\n' }, 3)?.lines, 1);
  assert.equal(liveToolPreview({ ...call, result: 'one\ntwo\n' }, 3)?.lines, 2);
  assert.equal(liveToolPreview({ ...call, result: 'one\ntwo\nthree\nfour' }, 3)?.lines, 3);
  assert.equal(liveToolPreview({ ...base, status: 'drafting', argumentsText: '{"newText":"only one' }, 3)?.lines, 1);
});

test('edit details show requested replacements unless a successful result supplies an actual diff', () => {
  const call = { ...base, input: { path: 'a.ts', edits: [{ oldText: 'before', newText: 'after' }] }, result: { details: { diff: '- actual before\n+ actual after' } } };
  const html = renderToString(h(ToolCallBody, { toolCall: call, onOpenFile: noop }));
  assert.match(html, /Applied changes/);
  assert.match(html, /tool-call-diff-added/);
  assert.match(html, /actual after/);
  assert.doesNotMatch(html, /Requested replacement/);
  const failed = renderToString(h(ToolCallBody, { toolCall: { ...call, status: 'failed' }, onOpenFile: noop }));
  assert.match(failed, /Requested replacement/);
  assert.doesNotMatch(failed, /Applied changes/);
});

test('legacy edit input and writes receive visual content without inventing a before-state', () => {
  const legacy = renderToString(h(ToolCallBody, { toolCall: { ...base, input: { path: 'a', oldText: 'a', newText: 'b' } }, onOpenFile: noop }));
  assert.match(legacy, /Requested replacement/);
  const write = renderToString(h(ToolCallBody, { toolCall: { ...base, name: 'write', input: { path: 'a.ts', content: 'const value = 1;' } }, onOpenFile: noop }));
  assert.match(write, /File content/);
  assert.doesNotMatch(write, /Applied changes|tool-call-diff/);
});

const editConfirmation: ToolCall = {
  ...base,
  input: { path: 'a.ts', edits: [{ oldText: 'before', newText: 'after' }] },
  result: {
    content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in a.ts.' }],
    details: { diff: '- before\n+ after', patch: '--- a.ts\n+++ a.ts\n-before\n+after', firstChangedLine: 1 },
  },
};
const writeConfirmation: ToolCall = {
  ...base, name: 'write', input: { path: 'a.ts', content: 'const value = 1;' },
  result: { content: [{ type: 'text', text: 'Successfully wrote 16 bytes to a.ts' }] },
};

test('stock confirmations are redundant only with matching paths and visible applied content', () => {
  assert.equal(isRedundantToolConfirmation(editConfirmation), true);
  assert.equal(isRedundantToolConfirmation(writeConfirmation), true);
  const editResult = editConfirmation.result as { content: unknown[]; details: unknown };
  assert.equal(isRedundantToolConfirmation({ ...editConfirmation, result: { ...editResult, content: [{ type: 'text', text: 'Successfully replaced text in a.ts.' }] } }), true);
  for (const result of ['Successfully wrote 16 bytes to a.ts', 'Successfully wrote 16 bytes to a.ts.']) {
    assert.equal(isRedundantToolConfirmation({ ...writeConfirmation, result }), true);
  }
  for (const call of [editConfirmation, writeConfirmation]) {
    for (const status of ['drafting', 'ready', 'running', 'failed'] as const) {
      assert.equal(isRedundantToolConfirmation({ ...call, status }), false);
    }
    assert.equal(isRedundantToolConfirmation({ ...call, input: { path: 'other.ts', content: '' } }), false);
    assert.equal(isRedundantToolConfirmation({ ...call, name: 'custom' }), false);
  }
  for (const diff of ['', '   ', undefined]) {
    assert.equal(isRedundantToolConfirmation({ ...editConfirmation, result: { ...editResult, details: { diff } } }), false);
  }
  assert.equal(isRedundantToolConfirmation({ ...editConfirmation, result: 'Successfully replaced text in a.ts.' }), false);
  assert.equal(isRedundantToolConfirmation({ ...writeConfirmation, input: { path: 'a.ts' } }), false);
  assert.equal(isRedundantToolConfirmation({ ...writeConfirmation, input: { path: 'a.ts', content: '' } }), true);
});

test('confirmation filtering preserves errors, extra content and unfamiliar metadata', () => {
  for (const call of [editConfirmation, writeConfirmation]) {
    const result = call.result as { content: unknown[]; details?: unknown };
    for (const extra of [{ isError: true }, { error: 'failed' }, { errors: [] }, { warning: 'check this' }, { truncation: { truncated: true } }, { unfamiliar: 1 }]) {
      assert.equal(isRedundantToolConfirmation({ ...call, result: { ...result, ...extra } }), false);
    }
    for (const part of [{ type: 'text', text: 'Warning: inspect the file' }, { type: 'image', mimeType: 'image/png', data: 'BASE64' }]) {
      assert.equal(isRedundantToolConfirmation({ ...call, result: { ...result, content: [...result.content, part] } }), false);
    }
    assert.equal(isRedundantToolConfirmation({ ...call, result: { ...result, details: { ...(result.details as object), warning: 'check this' } } }), false);
    assert.equal(isRedundantToolConfirmation({ ...call, result: { ...result, content: [{ ...(result.content[0] as object), warning: 'check this' }] } }), false);
    assert.equal(isRedundantToolConfirmation({ ...call, result: { ...result, isError: false } }), true);
  }
  for (const text of ['Successfully wrote many bytes to a.ts', 'Successfully wrote 16 bytes to a.ts\nWarning: inspect the file', 'Saved a.ts', 'Successfully wrote 16 bytes to a.ts.\n']) {
    assert.equal(isRedundantToolConfirmation({ ...writeConfirmation, result: text }), false);
  }
});

test('completed stock acknowledgements disappear from the body but remain in raw inspection', () => {
  for (const call of [editConfirmation, writeConfirmation]) {
    const html = renderToString(h(ToolCallBody, { toolCall: call, onOpenFile: noop }));
    assert.doesNotMatch(html, /Successfully/);
    assert.doesNotMatch(html, /class="tool-call-section-label">(?:Input|Result)</);
    assert.match(serializeModelExchange({ received: (call.result as { content: unknown[] }).content }), /Successfully/);
  }
  const editHtml = renderToString(h(ToolCallBody, { toolCall: editConfirmation, onOpenFile: noop }));
  assert.match(editHtml, /Applied changes/);
  assert.match(editHtml, /tool-call-diff-added/);
  assert.match(editHtml, /after/);
  const writeHtml = renderToString(h(ToolCallBody, { toolCall: writeConfirmation, onOpenFile: noop }));
  assert.match(writeHtml, /File content/);
  assert.match(writeHtml.replace(/<[^>]*>/g, ''), /const value/);
});

test('failed, unfamiliar and warning-bearing outputs remain visible without generic headings', () => {
  const calls: ToolCall[] = [
    { ...writeConfirmation, status: 'failed' },
    { ...writeConfirmation, result: 'Saved with an unfamiliar response' },
    { ...writeConfirmation, result: { content: [{ type: 'text', text: 'Successfully wrote 16 bytes to a.ts\nWarning: inspect the file' }] } },
    { ...writeConfirmation, result: { content: [{ type: 'text', text: 'Successfully wrote 16 bytes to a.ts' }], warning: 'check this' } },
    { ...base, name: 'custom', input: { scope: 'all' }, result: 'meaningful output' },
  ];
  for (const call of calls) {
    const html = renderToString(h(ToolCallBody, { toolCall: call, onOpenFile: noop }));
    assert.match(html, /Successfully|unfamiliar response|meaningful output/);
    assert.doesNotMatch(html, /class="tool-call-section-label">(?:Input|Result)</);
  }
});

test('unknown tools preserve their scalar, structured and text inputs/results', () => {
  const html = renderToString(h(ToolCallBody, { toolCall: { ...base, name: 'mcp_custom', input: { scope: 'all', config: { enabled: true } }, result: 'done' }, onOpenFile: noop }));
  assert.match(html, /<dt>scope<\/dt>/);
  assert.match(html, /enabled/);
  assert.match(html, /true/);
  assert.match(html, /done/);
});

test('model exchange serialization retains binary payloads without diagnostic metadata', () => {
  const exchange = { produced: { name: 'original', arguments: { raw: 'exact' }, diagnostic: 'excluded' }, received: [{ type: 'image', data: 'BASE64', dataBase64: 'MORE' }], status: 'excluded' };
  assert.deepEqual(JSON.parse(serializeModelExchange(exchange)), {
    produced: { name: 'original', arguments: { raw: 'exact' } }, received: exchange.received,
  });
});

/** Only the tooltip's window-local show delay is virtualized. Detail-store
 * requests keep their real bounded recovery and are explicitly cleared. */
function openRaw(call: ToolCall, sessionPath?: string) {
  const original = window.setTimeout;
  const pending: Array<() => void> = [];
  window.setTimeout = ((fn: () => void) => { pending.push(fn); return pending.length; }) as typeof window.setTimeout;
  try {
    const node = h(RawToolInspector, { toolCall: call });
    act(() => render(sessionPath ? h(AskUserContext.Provider, { value: { sessionPath, postMessage: noop, pendingRequests: {}, registerInlineRequest: noop, unregisterInlineRequest: noop } }, node) : node, container));
    const trigger = container.querySelector('button')!;
    act(() => { trigger.dispatchEvent(new Event('focus')); });
    act(() => pending.splice(0).forEach((fn) => fn()));
    return trigger;
  } finally { window.setTimeout = original; }
}

test('raw tooltip copies only captured payload, bounds huge binary preview and freezes while visible', async () => {
  const messages: WebviewToHostMessage[] = [];
  setLazyDetailPostMessage((message) => messages.push(message));
  const call = { ...base, status: 'running' as const, input: 'wrong input', result: 'wrong output', argumentsText: '{repaired', detailRef: { key: 'diagnostic', kind: 'tool-result' as const, source: 'durable' as const, sessionPath: '/fixture', messageId: 'm', sizeBytes: 1, summary: '', available: true } };
  const trigger = openRaw(call);
  const request = messages.find((m) => m.type === 'requestDetail')!;
  assert.equal(request.type, 'requestDetail');
  if (request.type !== 'requestDetail') return;
  const exchange = { produced: { name: 'captured', arguments: { untouched: true } }, received: [{ type: 'image', data: 'B'.repeat(100000), dataBase64: 'FULL_BINARY' }, { type: 'text', text: 'first output' }] };
  act(() => receiveLazyDetailResult({ sessionPath: '/fixture', key: request.ref.key, status: 'loaded', value: { ...exchange, diagnostic: 'excluded' }, sizeBytes: 100000 }));
  let copied = '';
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied = text; } } });
  try {
    const host = document.querySelector('.pie-tooltip-host') as HTMLElement;
    assert.equal(host.getAttribute('role'), 'region');
    assert.equal(trigger.getAttribute('aria-label'), 'Inspect edit model exchange');
    assert.equal(host.getAttribute('aria-label'), 'Inspect edit model exchange');
    assert.match(host.textContent ?? '', /Model produced/);
    assert.match(host.textContent ?? '', /Model received/);
    assert.match(host.textContent ?? '', /preview shortened/);
    assert.doesNotMatch(host.textContent ?? '', /wrong input|wrong output|repaired|excluded/);
    assert.ok([...host.querySelectorAll('pre')].reduce((sum, pre) => sum + (pre.textContent?.length ?? 0), 0) <= 60000);
    assert.ok(host.querySelector('pre[tabindex="0"]'));
    act(() => render(h(RawToolInspector, { toolCall: { ...call, result: 'new output' } }), container));
    assert.match(host.textContent ?? '', /captured/);
    assert.doesNotMatch(host.textContent ?? '', /new output/);
    await act(async () => {
      (host.querySelector('.tool-call-raw-copy') as HTMLButtonElement).click();
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    assert.deepEqual(JSON.parse(copied), exchange);
    assert.match(host.textContent ?? '', /Copied/);
    act(() => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(host.style.display, 'none');
  } finally {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else Reflect.deleteProperty(navigator, 'clipboard');
  }
});

for (const side of ['above', 'below'] as const) {
  test(`async raw capture growth keeps the activatable text trigger clear ${side}`, () => {
    const originalObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
    const originalHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    const originalTimeout = window.setTimeout;
    const pending: Array<() => void> = [];
    const messages: WebviewToHostMessage[] = [];
    let notifyResize: (() => void) | undefined;
    let observed: Element | undefined;
    class MockResizeObserver {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        observed = target;
        notifyResize = () => this.callback([], this as unknown as ResizeObserver);
      }
      disconnect() {}
      unobserve() {}
    }
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: MockResizeObserver });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 640 });
    window.setTimeout = ((fn: () => void) => { pending.push(fn); return pending.length; }) as typeof window.setTimeout;
    setLazyDetailPostMessage((message) => messages.push(message));
    try {
      const call = { ...base, detailRef: { key: 'source', kind: 'tool-result' as const, source: 'durable' as const, sessionPath: '/fixture', messageId: 'm', sizeBytes: 1, summary: '', available: true } };
      act(() => render(h(RawToolInspector, { toolCall: call }, h('span', { tabIndex: 0, 'aria-describedby': 'existing-description' }, 'edit')), container));
      const trigger = container.querySelector('span[tabindex="0"]') as HTMLElement;
      const wrapper = container.querySelector('.pie-tooltip-trigger') as HTMLElement;
      const host = document.querySelector('.pie-tooltip-host') as HTMLElement;
      const anchorTop = side === 'above' ? 548 : 100;
      const anchorBottom = anchorTop + 14;
      const anchorRect = { top: anchorTop, bottom: anchorBottom, left: 100, right: 140, width: 40, height: 14 } as DOMRect;
      trigger.getBoundingClientRect = wrapper.getBoundingClientRect = () => anchorRect;
      let height = 142;
      host.getBoundingClientRect = () => ({ top: parseFloat(host.style.top) || 0, height, width: 320 } as DOMRect);
      act(() => { trigger.dispatchEvent(new Event('focus')); });
      act(() => pending.splice(0).forEach((fn) => fn()));
      assert.equal(host.style.top, side === 'above' ? '400px' : '120px');
      assert.ok(host.style.getPropertyValue('--pie-tooltip-available-height'), 'text trigger opts into anchor clearance');
      assert.equal(trigger.getAttribute('aria-describedby'), `existing-description ${host.id}`);
      assert.equal(observed, host.querySelector('.tool-call-raw-inspector'));
      assert.ok(notifyResize, 'raw inspector observes async content growth');
      assert.match(host.textContent ?? '', /Loading captured model exchange/);
      const request = messages[0];
      assert.equal(request.type, 'requestDetail');
      if (request.type !== 'requestDetail') return;
      act(() => receiveLazyDetailResult({ sessionPath: '/fixture', key: request.ref.key, status: 'loaded', value: { received: [{ type: 'text', text: 'ASYNC CAPTURE' }] }, sizeBytes: 100 }));
      assert.match(host.textContent ?? '', /ASYNC CAPTURE/);
      height = 400;
      if (side === 'above') {
        const oldClampedTop = Math.max(6, Math.min(400, window.innerHeight - height - 6));
        assert.equal(oldClampedTop, 234);
        assert.ok(oldClampedTop + height > anchorTop, 'old viewport-only clamp would overlap the trigger');
      }
      act(() => notifyResize!());
      assert.equal(host.style.top, side === 'above' ? '142px' : '120px');
      if (side === 'above') assert.equal(parseFloat(host.style.top) + height, anchorTop - 6);
      else assert.equal(parseFloat(host.style.top), anchorBottom + 6);
    } finally {
      act(() => render(null, container));
      window.setTimeout = originalTimeout;
      if (originalObserver) Object.defineProperty(globalThis, 'ResizeObserver', originalObserver);
      else Reflect.deleteProperty(globalThis, 'ResizeObserver');
      if (originalHeight) Object.defineProperty(window, 'innerHeight', originalHeight);
      else Reflect.deleteProperty(window, 'innerHeight');
      setLazyDetailPostMessage(noop);
    }
  });
}

test('inspection requests exact durable identity only when opened, retries failures and refreshes partial captures', () => {
  const messages: WebviewToHostMessage[] = [];
  setLazyDetailPostMessage((message) => messages.push(message));
  const call: ToolCall = { ...base, durableEntryId: 'durable', result: 'NEVER SUBSTITUTE', detailRef: { key: 'raw-detail', kind: 'tool-result', source: 'durable', sessionPath: '/fixture', messageId: 'm', toolCallId: 'test', sizeBytes: 100000, summary: 'large result', available: true } };
  act(() => render(h(RawToolInspector, { toolCall: call }), container));
  assert.equal(messages.length, 0);
  const trigger = openRaw(call);
  assert.equal(messages.length, 1);
  const request = messages[0];
  assert.equal(request.type, 'requestDetail');
  if (request.type !== 'requestDetail') return;
  assert.deepEqual(request.ref, { key: JSON.stringify(['model-exchange', '/fixture', 'durable', 'test']), kind: 'model-exchange', source: 'durable', sessionPath: '/fixture', messageId: 'durable', toolCallId: 'test', sizeBytes: 0, summary: 'Captured model exchange', available: true });
  const inspector = () => document.querySelector('.tool-call-raw-inspector')!;
  const settle = (value: unknown) => act(() => receiveLazyDetailResult({ sessionPath: '/fixture', key: request.ref.key, status: 'loaded', value, sizeBytes: 100 }));
  assert.match(inspector().textContent ?? '', /Loading captured model exchange/);
  act(() => receiveLazyDetailResult({ sessionPath: '/fixture', key: request.ref.key, status: 'failure', message: 'FAILED' }));
  assert.match(inspector().textContent ?? '', /FAILED/);
  act(() => (inspector().querySelector('button') as HTMLButtonElement).click());
  assert.equal(messages.length, 2);
  settle({ produced: { name: 'edit', arguments: {} } });
  assert.match(inspector().textContent ?? '', /Result not yet captured/);
  act(() => [...inspector().querySelectorAll('button')].find((b) => b.textContent === 'Refresh')!.click());
  assert.equal(messages.length, 3);
  assert.doesNotMatch(inspector().textContent ?? '', /Result not yet captured/);
  settle({ produced: { name: 'edit', arguments: {} }, received: [{ type: 'text', text: 'EXACT' }] });
  assert.match(inspector().textContent ?? '', /EXACT/);
  assert.doesNotMatch(inspector().textContent ?? '', /NEVER SUBSTITUTE/);
  act(() => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  openRaw(call);
  assert.equal(messages.length, 4);
  assert.doesNotMatch(inspector().textContent ?? '', /EXACT/);
  settle({});
  assert.match(inspector().textContent ?? '', /capture unavailable/);
  assert.doesNotMatch(inspector().textContent ?? '', /NEVER SUBSTITUTE/);
});

test('refresh and retry keep one focused control mounted across capture states', () => {
  const messages: WebviewToHostMessage[] = [];
  setLazyDetailPostMessage((message) => messages.push(message));
  openRaw(base, '/fixture');
  const request = messages[0];
  assert.equal(request.type, 'requestDetail');
  if (request.type !== 'requestDetail') return;
  const host = document.querySelector('.pie-tooltip-host') as HTMLElement;
  const inspector = host.querySelector('.tool-call-raw-inspector')!;
  const control = inspector.querySelector('.tool-call-raw-refresh') as HTMLButtonElement;
  assert.ok(control, 'loading has the same refresh control as settled states');
  assert.equal(control.getAttribute('aria-disabled'), 'true');
  assert.equal(control.disabled, false, 'native disabled would drop keyboard focus');
  const settle = (value: unknown) => act(() => receiveLazyDetailResult({ sessionPath: '/fixture', key: request.ref.key, status: 'loaded', value, sizeBytes: 100 }));
  const checkFocus = () => {
    assert.equal(inspector.querySelector('.tool-call-raw-refresh'), control);
    assert.equal(document.activeElement, control);
    assert.notEqual(host.style.display, 'none');
    assert.equal(control.isConnected, true);
  };
  act(() => control.focus());
  checkFocus();
  act(() => control.click());
  assert.equal(messages.length, 1, 'aria-disabled control ignores activation');
  settle({ produced: { name: 'edit', arguments: {} } });
  checkFocus();
  assert.equal(control.textContent, 'Refresh');
  assert.notEqual(inspector.querySelector('.tool-call-raw-copy'), control);
  act(() => control.click());
  checkFocus();
  assert.equal(control.getAttribute('aria-disabled'), 'true');
  assert.equal(messages.length, 2);
  settle({ produced: { name: 'edit', arguments: {} }, received: [{ type: 'text', text: 'EXACT' }] });
  checkFocus();
  act(() => control.click());
  checkFocus();
  act(() => receiveLazyDetailResult({ sessionPath: '/fixture', key: request.ref.key, status: 'failure', message: 'FAILED' }));
  checkFocus();
  assert.equal(control.textContent, 'Retry');
  assert.equal(inspector.querySelector('.tool-call-raw-copy'), null);
  act(() => control.click());
  checkFocus();
  assert.equal(messages.length, 4);
  settle({ received: [{ type: 'text', text: 'RECOVERED' }] });
  checkFocus();
  assert.match(inspector.textContent ?? '', /RECOVERED/);
  assert.doesNotMatch(inspector.textContent ?? '', /Snapshot at inspection time/);
  act(() => { container.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  assert.equal(host.style.display, 'none');
});

test('root session context is resolved before mounting the detached tooltip', () => {
  const messages: WebviewToHostMessage[] = [];
  setLazyDetailPostMessage((message) => messages.push(message));
  openRaw(base, '/context');
  const request = messages[0];
  assert.equal(request.type, 'requestDetail');
  if (request.type !== 'requestDetail') return;
  assert.equal(request.sessionPath, '/context');
  assert.equal(request.ref.messageId, base.id);
  assert.equal(request.ref.toolCallId, base.id);
  assert.equal(request.ref.kind, 'model-exchange');
});

test('missing session and nested subagent identity are explicitly unavailable without requests', () => {
  const messages: WebviewToHostMessage[] = [];
  setLazyDetailPostMessage((message) => messages.push(message));
  openRaw({ ...base, input: 'NEVER SUBSTITUTE', result: 'NEVER SUBSTITUTE' });
  assert.equal(messages.length, 0);
  assert.match(document.querySelector('.tool-call-raw-inspector')?.textContent ?? '', /session identity is not available/);
  act(() => render(null, container));
  const ctx = { sessionPath: '/root', postMessage: noop, pendingRequests: {}, registerInlineRequest: noop, unregisterInlineRequest: noop };
  // openRaw's render must retain the providers for the detached-root test.
  const original = window.setTimeout;
  const pending: Array<() => void> = [];
  window.setTimeout = ((fn: () => void) => { pending.push(fn); return pending.length; }) as typeof window.setTimeout;
  try {
    act(() => render(h(AskUserContext.Provider, { value: ctx }, h(SubagentCallContext.Provider, { value: { id: 'child', agent: 'worker', depth: 1 } }, h(RawToolInspector, { toolCall: base }))), container));
    act(() => { container.querySelector('button')!.dispatchEvent(new Event('focus')); });
    act(() => pending.splice(0).forEach((fn) => fn()));
    assert.equal(messages.length, 0);
    assert.match(document.querySelector('.tool-call-raw-inspector')?.textContent ?? '', /child durable session identity/);
  } finally { window.setTimeout = original; }
});
