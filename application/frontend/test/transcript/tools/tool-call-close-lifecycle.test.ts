import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../../helpers/dom';
installDom();
import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { ToolCallCard } from '../../../transcript/tool-call-card';
import { MessageContent } from '../../../transcript/message-item/content';
import { clearCollapsibleCache } from '../../../transcript/use-collapsible-open';
import { DEFAULT_CHAT_PREFS, type ToolCall } from '../../../../lib/protocol/index.js';

let container: HTMLElement;
beforeEach(() => { clearCollapsibleCache(); container = document.createElement('div'); document.body.appendChild(container); });
afterEach(() => { render(null, container); container.remove(); });
const noop = () => undefined;
function call(name: string, status: ToolCall['status'], id = name): ToolCall {
  return { id, name, input: name === 'bash' ? { command: 'pnpm test', timeout: 60 } : { path: '/repo/a.ts' }, result: { content: [{ type: 'text', text: 'first\nsecond\nthird\n' }] }, status };
}
function paint(toolCall: ToolCall) { act(() => render(h(ToolCallCard, { toolCall, autoExpand: true, activityTailLines: 2, workingDirectory: '/repo', onOpenFile: noop, onContextMenu: noop }), container)); }
function toggle() { act(() => (container.querySelector('.tool-call-toggle') as HTMLButtonElement).click()); }

for (const name of ['bash', 'read', 'custom_tool']) {
  test(`${name} stays header-first across running and completion, ignoring the retired auto-expand preference`, () => {
    paint(call(name, 'running'));
    assert.equal(container.querySelector('.tool-call-body-wrap'), null);
    assert.ok(container.querySelector('[aria-label="Running"]'));
    assert.equal(container.querySelector('.tool-call-live-preview pre')?.textContent, 'second\nthird');
    paint(call(name, 'completed'));
    assert.equal(container.querySelector('.tool-call-body-wrap'), null);
    assert.equal(container.querySelector('.tool-call-live-preview'), null);
  });
  test(`${name} manual expansion remains sticky across progress and completion`, () => {
    paint(call(name, 'running')); toggle();
    assert.ok(container.querySelector('.tool-call-body-wrap'));
    assert.equal(container.querySelector('.tool-call-live-preview'), null);
    assert.match(container.querySelector('.tool-call-body')?.textContent ?? '', /first[\s\S]*third/);
    paint(call(name, 'completed'));
    assert.ok(container.querySelector('.tool-call-body-wrap'));
    const footer = container.querySelector('.collapsible-close-footer') as HTMLButtonElement;
    assert.equal(footer.textContent?.trim(), 'Collapse details');
    assert.equal(container.querySelector('.collapsible-gutter')?.getAttribute('aria-label'), `Collapse ${name} details`);
    act(() => footer.click());
    assert.equal(container.querySelector('.tool-call-body-wrap'), null);
    paint(call(name, 'completed'));
    toggle();
    assert.ok(container.querySelector('.tool-call-body-wrap'));
    const rail = container.querySelector('.collapsible-gutter') as HTMLButtonElement;
    act(() => rail.click());
    assert.equal(container.querySelector('.tool-call-body-wrap'), null, 'the rail remains an independent collapse target');
    paint(call(name, 'running'));
    assert.equal(container.querySelector('.tool-call-body-wrap'), null, 'progress never undoes a manual close');
  });
}

test('live previews expose their context and omitted-content cue to assistive technology', () => {
  for (const status of ['running', 'drafting', 'ready'] as const) {
    const content = 'first\nsecond\nthird';
    const toolCall: ToolCall = status === 'running'
      ? call('read', status, `preview-${status}`)
      : { id: `preview-${status}`, name: 'write', status, input: { content }, argumentsText: JSON.stringify({ content }) };
    paint(toolCall);
    const preview = container.querySelector('.tool-call-live-preview')!;
    assert.equal(preview.getAttribute('role'), 'group');
    assert.match(preview.getAttribute('aria-label') ?? '', status === 'running' ? /live result preview/ : /draft input preview/);
    const cue = preview.querySelector('.tool-call-preview-truncation')!;
    assert.equal(cue.querySelector('[aria-hidden="true"]')?.textContent, '…');
    assert.equal(cue.querySelector('.sr-only')?.textContent, 'Earlier preview content omitted.');
    assert.equal(preview.querySelector('pre')?.textContent, 'second\nthird');
  }
});

test('one stable disclosure owns draft arguments, ready input and the execution result', () => {
  const draft: ToolCall = { id: 'draft', name: 'edit', input: '', argumentsText: '{"path":"/repo/a.ts","edits":[{"oldText":"before","newText":"after', status: 'drafting' };
  paint(draft);
  const root = container.querySelector('.tool-call-card');
  assert.equal(root?.getAttribute('data-provisional'), 'true');
  assert.equal(container.querySelector('.tool-call-live-preview pre')?.textContent, 'after');
  assert.doesNotMatch(container.textContent ?? '', /not executed|tool-call-provisional-notice|Generating arguments/);
  assert.equal(container.querySelector('.tool-call-body-wrap'), null);
  toggle();
  assert.match(container.textContent ?? '', /Requested replacement/);
  assert.doesNotMatch(container.textContent ?? '', /Applied changes|not executed|tool-call-provisional-notice/);
  const ready = { ...draft, status: 'ready' as const, argumentsText: `${draft.argumentsText}"}]}` };
  paint(ready);
  assert.equal(container.querySelector('.tool-call-card'), root);
  assert.equal(container.querySelector('.tool-call-toggle')?.getAttribute('aria-expanded'), 'true');
  assert.match(container.querySelector('.tool-call-body')?.textContent ?? '', /after/);
  assert.doesNotMatch(container.textContent ?? '', /not executed|tool-call-provisional-notice/);
  paint({ ...ready, input: { path: '/repo/a.ts', edits: [{ oldText: 'before', newText: 'after' }] }, status: 'completed', result: { details: { diff: '- before\n+ after' } } });
  assert.equal(container.querySelector('.tool-call-card'), root);
  assert.match(container.textContent ?? '', /Applied changes/);
  assert.equal(container.querySelector('.tool-call-toggle')?.getAttribute('aria-expanded'), 'true');
});

test('drafting and ready inputs stay visible without provisional disclaimers or a generating preview label', () => {
  for (const status of ['drafting', 'ready'] as const) {
    const argumentsText = status === 'drafting'
      ? '{"path":"/repo/draft.txt","content":"npm test'
      : '{"path":"/repo/draft.txt","content":"npm test"}';
    paint({ id: `${status}-input`, name: 'write', status, input: argumentsText, argumentsText });
    assert.equal(container.querySelector('.tool-call-live-preview pre')?.textContent, 'npm test');
    assert.equal(container.querySelector('.tool-call-preview-label'), null);
    assert.doesNotMatch(container.textContent ?? '', /not executed|tool-call-provisional-notice|Generating arguments/);
    assert.equal(container.querySelector('.tool-call-body-wrap'), null);

    toggle();
    assert.match(container.querySelector('.tool-call-body')?.textContent ?? '', /npm test/);
    assert.doesNotMatch(container.textContent ?? '', /not executed|tool-call-provisional-notice|Generating arguments/);
    toggle();
  }

  const edits = JSON.stringify({ path: '/repo/a.ts', edits: [
    { oldText: 'before one', newText: 'after one' },
    { oldText: 'before two', newText: 'after two' },
  ] });
  paint({ id: 'multi-edit-draft', name: 'edit', status: 'drafting', input: '', argumentsText: edits });
  assert.equal(container.querySelector('.tool-call-preview-label')?.textContent, 'replacement 2');
});

test('whole-row disclosure stays a focusable native button with accurate aria wiring', () => {
  paint(call('read', 'completed'));
  const header = container.querySelector('.tool-call-toggle') as HTMLButtonElement;
  assert.equal(header.tagName, 'BUTTON');
  assert.equal(header.type, 'button');
  assert.equal(header.disabled, false);
  assert.equal(header.tabIndex, 0, 'native button retains keyboard activation semantics');
  assert.ok(header.querySelector('.tool-call-disclosure'), 'ordinary rows keep the muted disclosure chevron');
  assert.equal(header.getAttribute('aria-expanded'), 'false');
  header.focus();
  assert.equal(document.activeElement, header);
  toggle();
  assert.equal(header.getAttribute('aria-expanded'), 'true');
  const bodyId = header.getAttribute('aria-controls');
  assert.ok(bodyId);
  assert.equal(document.getElementById(bodyId), container.querySelector('.tool-call-body-wrap'));
  toggle();
  assert.equal(header.getAttribute('aria-expanded'), 'false');
  assert.equal(header.getAttribute('aria-controls'), null);
});

test('file opening and raw inspection are distinct sibling actions, not children of the toggle', () => {
  let opened = '';
  act(() => render(h(ToolCallCard, { toolCall: call('read', 'completed'), workingDirectory: '/repo', onOpenFile: (path) => { opened = path; }, onContextMenu: noop }), container));
  const expand = container.querySelector('.tool-call-toggle')!;
  assert.equal(expand.querySelector('button, [role="button"]'), null);
  act(() => (container.querySelector('[aria-label="Open file /repo/a.ts"]') as HTMLButtonElement).click());
  assert.equal(opened, '/repo/a.ts');
  assert.equal(expand.getAttribute('aria-expanded'), 'false');
  act(() => (container.querySelector('[aria-label="Inspect read model exchange"]') as HTMLButtonElement).click());
  assert.equal(expand.getAttribute('aria-expanded'), 'false');
});

test('ordinary tool footer collapses, returns focus to its header, and exposes an accessible label', () => {
  paint(call('read', 'completed'));
  toggle();
  const header = container.querySelector('.tool-call-toggle') as HTMLButtonElement;
  const footer = container.querySelector('.collapsible-close-footer') as HTMLButtonElement;
  assert.equal(footer.getAttribute('aria-label'), 'Collapse details');
  header.focus();
  act(() => footer.click());
  assert.equal(container.querySelector('.tool-call-body-wrap'), null);
  assert.equal(document.activeElement, header, 'focus returns to the owning disclosure button');
});

test('ordinary tool rail collapses, returns focus to its header, and exposes an accessible label', () => {
  paint(call('read', 'completed'));
  toggle();
  const header = container.querySelector('.tool-call-toggle') as HTMLButtonElement;
  const rail = container.querySelector('.collapsible-gutter') as HTMLButtonElement;
  assert.equal(rail.getAttribute('aria-label'), 'Collapse read details');
  header.focus();
  act(() => rail.click());
  assert.equal(container.querySelector('.tool-call-body-wrap'), null);
  assert.equal(document.activeElement, header, 'focus returns to the owning disclosure button');
});

test('expanded Model exchange reuses inspection without closing details and Escape restores its trigger', () => {
  const original = window.setTimeout;
  const pending: Array<() => void> = [];
  window.setTimeout = ((fn: () => void) => { pending.push(fn); return pending.length; }) as typeof window.setTimeout;
  try {
    paint(call('read', 'completed'));
    assert.equal(container.querySelector('.tool-call-exchange-action'), null);
    toggle();
    const trigger = container.querySelector('.tool-call-exchange-action') as HTMLButtonElement;
    assert.equal(trigger.textContent, 'Model exchange');
    assert.ok(container.querySelector('[aria-label="Inspect read model exchange"]'), 'header shortcut remains');
    act(() => trigger.focus());
    act(() => pending.splice(0).forEach((fn) => fn()));
    const inspector = document.querySelector('.tool-call-raw-inspector');
    assert.match(inspector?.textContent ?? '', /Model exchange/);
    assert.ok(container.querySelector('.tool-call-body-wrap'));
    act(() => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(document.activeElement, trigger);
    assert.ok(container.querySelector('.tool-call-body-wrap'));
  } finally { window.setTimeout = original; }
});

test('expanded shell details retain options and the header can close them while output streams', () => {
  paint(call('bash', 'running')); toggle();
  assert.match(container.querySelector('.tool-call-body')?.textContent ?? '', /pnpm test[\s\S]*timeout[\s\S]*60/);
  assert.ok(container.querySelector('.collapsible-close-footer'));
  toggle();
  assert.equal(container.querySelector('.tool-call-body-wrap'), null);
  assert.ok(container.querySelector('.tool-call-live-preview'));
  paint(call('bash', 'completed'));
  assert.equal(container.querySelector('.tool-call-body-wrap'), null, 'completion does not undo a manual header close');
});

test('subagent fallback retains the close footer and collapsible gutter', () => {
  paint(call('subagent', 'completed'));
  assert.ok(container.querySelector('.tool-call-body-wrap'), 'auto-expand remains available for subagent fallback');
  assert.ok(container.querySelector('.collapsible-close-footer'));
  assert.ok(container.querySelector('.collapsible-gutter'));
  act(() => (container.querySelector('.collapsible-close-footer') as HTMLButtonElement).click());
  assert.equal(container.querySelector('.tool-call-body-wrap'), null);
});

test('completed parallel sibling retains its accessible status without a check or dimming while another sibling runs', () => {
  const completed = { ...call('read', 'completed', 'done'), parallelGroupId: 'batch' };
  const running = { ...call('read', 'running', 'active'), parallelGroupId: 'batch' };
  const renderToolCall = (toolCall: ToolCall) => h(ToolCallCard, { toolCall, workingDirectory: '/repo', onOpenFile: noop, onContextMenu: noop });
  act(() => render(h(MessageContent, { messageId: 'parallel', role: 'assistant', combinedParts: [{ kind: 'toolCall', toolCall: completed }, { kind: 'toolCall', toolCall: running }], renderableUserParts: undefined, html: '', isCurrentlyStreaming: true, messageBodyRef: { current: null }, workingDirectory: '/repo', onOpenFile: noop, prefs: DEFAULT_CHAT_PREFS, renderToolCall, onContextMenu: noop, getMessageRaw: () => '' }), container));
  const siblings = [...container.querySelectorAll('[data-parallel-group-id="batch"] .tool-call-card')];
  assert.equal(siblings.length, 2);
  assert.equal(siblings[0].querySelector('.tool-call-status-spinner'), null);
  assert.ok(siblings[1].querySelector('.tool-call-status-spinner'));
  assert.equal(siblings[0].querySelector('.tool-call-status-completed'), null);
  assert.match(siblings[0].querySelector('.tool-call-toggle')?.getAttribute('aria-label') ?? '', /read tool call, Completed\./);
  assert.equal(siblings[0].querySelector('.tool-call-state-column'), null);
  assert.equal(container.querySelector('.tool-call-parallel-item-done'), null);
  assert.ok(siblings[0].closest('.tool-call-parallel-start'));
  assert.ok(siblings[1].closest('.tool-call-parallel-end'));
});
