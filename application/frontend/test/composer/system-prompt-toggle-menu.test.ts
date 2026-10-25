import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../helpers/dom';
installDom();
import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
const sanitizer = DOMPurify(new JSDOM('').window as unknown as Parameters<typeof DOMPurify>[0]);
const originalSanitize = DOMPurify.sanitize;

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { scopePendingOverlay, SystemPromptToggleMenu } from '../../composer/system-prompt-toggle-menu';
import type { SystemPromptEntry } from '../../../lib/protocol/index.js';
import { NoticeContext } from '../../lib/hooks/notice-context';

let container: HTMLElement;

type TestOnSetToggles = (ids: string[]) => unknown;
type ToggleApplyResult = void | boolean | Promise<void | boolean>;

beforeEach(() => {
  DOMPurify.sanitize = sanitizer.sanitize;
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  DOMPurify.sanitize = originalSanitize;
  render(null, container);
  container.remove();
});

function providerEntry(): SystemPromptEntry {
  return {
    source: 'provider',
    id: 'provider',
    availability: 'unknown',
    title: 'Provider system prompt',
    text: 'Not directly exposed.',
    summary: 'provider',
    toggleable: false,
  };
}

function entry(id: string, title: string, disabled = false): SystemPromptEntry {
  return {
    source: 'harness',
    id,
    availability: 'available',
    title,
    text: `${title} body`,
    summary: `${title} summary`,
    disabled,
  };
}

function mount(
  prompts: SystemPromptEntry[],
  onSetToggles: TestOnSetToggles,
  sessionPath: string | null = null,
  notice: string | null = null,
  noticeSessionPath: string | null = null,
  commandsAvailable = true,
): void {
  act(() => {
    render(
      h(NoticeContext.Provider, { value: { notice, sessionPath: noticeSessionPath, dismiss: null } },
        h(SystemPromptToggleMenu, { prompts, sessionPath, commandsAvailable, onSetToggles: onSetToggles as (ids: string[]) => ToggleApplyResult })),
      container,
    );
  });
}

const rerender = mount;

function click(text: string): void {
  const button = [...document.querySelectorAll<HTMLButtonElement>('.system-instructions-dialog button')].find(el => el.textContent === text);
  assert.ok(button, text);
  act(() => button.click());
}
function toggle(title: string): void {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="Include ${title}"]`)!;
  assert.ok(input);
  act(() => input.click());
}
function badge(): string | null { return container.querySelector('.system-prompt-toggle-badge')?.textContent ?? null; }

function openMenu(): void {
  const trigger = container.querySelector('.system-prompt-toggle-trigger') as HTMLButtonElement | null;
  assert.ok(trigger, 'toggle trigger should render');
  act(() => {
    trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}


test('rapid draft edits only send one complete set on Apply; Cancel discards', () => {
  const calls: string[][] = [];
  mount([entry('a','A'), entry('b','B')], ids => { calls.push(ids); });
  openMenu(); toggle('A'); toggle('B'); toggle('A');
  assert.deepEqual(calls, []); assert.equal(badge(), null);
  click('Cancel'); openMenu();
  assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="Include B"]')!.checked, true);
  toggle('A'); toggle('B'); click('Apply changes');
  assert.deepEqual(calls, [['a','b']]); assert.equal(badge(), '2');
});
test('failed apply rolls back; confirmations release overlay', () => {
  mount([entry('a','A')], () => false); openMenu(); toggle('A'); click('Apply changes');
  assert.equal(badge(), null);
  const send = () => undefined;
  rerender([entry('a','A')], send); openMenu(); toggle('A'); click('Apply changes');
  assert.equal(badge(), '1');
  rerender([entry('a','A',true)], send); rerender([entry('a','A')], send);
  assert.equal(badge(), null);
});
test('draft and stale async failures cannot cross A B A', async () => {
  const rejects: Array<() => void> = [];
  const send = () => new Promise<void>((_, reject) => rejects.push(() => reject(new Error('late'))));
  mount([entry('a','A')], send, 'a'); openMenu(); toggle('A'); click('Apply changes');
  rerender([entry('a','A')], send, 'b'); openMenu(); toggle('A');
  rerender([entry('a','A')], send, 'a'); openMenu();
  assert.equal(document.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked, true);
  toggle('A'); click('Apply changes');
  await act(async () => { rejects[0](); await Promise.resolve(); });
  assert.equal(badge(), '1');
  assert.deepEqual(scopePendingOverlay({sessionPath:'a',sessionGeneration:0,intents:{a:true}},'a',2), {});
});
test('provider information is inspectable; resolved preview excludes unavailable and disabled text', () => {
  mount([providerEntry(),entry('a','A',true),{...entry('b','B'),availability:'unknown'},entry('c','C')], () => undefined);
  openMenu();
  assert.equal(document.querySelectorAll('.system-instructions-list input').length, 3);
  assert.match(document.querySelector('.system-instructions-list')!.textContent!, /Provider system prompt/);
  click('Resolved preview');
  const preview = document.querySelector('.system-instructions-resolved')!;
  assert.match(preview.textContent!, /C body/); assert.doesNotMatch(preview.textContent!, /A body|B body/);
  const search = document.querySelector<HTMLInputElement>('[aria-label="Search assembled preview"]')!;
  act(() => { search.value='no match'; search.dispatchEvent(new Event('input',{bubbles:true})); });
  assert.match(preview.textContent!, /No matching sources/);
});
test('copy exports the complete assembled preview independent of search', async () => {
  let copied = '';
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied = text; } } });
  mount([entry('a','A'), entry('b','B',true)], () => undefined);
  openMenu(); click('Resolved preview');
  const search = document.querySelector<HTMLInputElement>('[aria-label="Search assembled preview"]')!;
  act(() => { search.value = 'no match'; search.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => { click('Copy'); await Promise.resolve(); });
  assert.match(copied, /A body/); assert.doesNotMatch(copied, /B body/);
  assert.match(copied, /not a record of a sent request/);
  assert.ok([...document.querySelectorAll('button')].some(button => button.textContent === 'Copied'));
  rerender([entry('a', 'A', true), entry('b', 'B')], () => undefined);
  assert.ok([...document.querySelectorAll('button')].some(button => button.textContent === 'Copy'));
});

test('modal initial focus, Tab wrap, Escape restore and backdrop discard', () => {
  mount([entry('a','A')], () => { throw new Error('must not send'); }); openMenu();
  const close = document.querySelector<HTMLButtonElement>('[aria-label="Close system instructions"]')!;
  assert.equal(document.activeElement, close);
  act(() => { close.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true})); });
  assert.equal(document.activeElement?.textContent, 'Cancel');
  toggle('A');
  act(() => { document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); });
  assert.equal(document.querySelector('[aria-modal=true]'), null);
  assert.equal(document.activeElement, container.querySelector('.system-prompt-toggle-trigger'));
  openMenu();
  assert.equal(document.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked, true);
  act(() => { document.querySelector('.system-instructions-backdrop')!.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); });
  assert.equal(document.querySelector('[aria-modal=true]'), null);
});

test('unchanged Apply is disabled and source labels only inspect', () => {
  mount([providerEntry(), entry('a', 'A')], () => undefined); openMenu();
  assert.equal(document.querySelector<HTMLButtonElement>('.primary')!.disabled, true);
  click('Provider system prompt');
  assert.equal(document.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked, true);
  assert.match(document.querySelector('article')!.textContent!, /provider information only/);
});
test('draft keeps unrelated updates but removed entries lose edits and selection follows identity', () => {
  const send = () => undefined;
  mount([entry('a','A'), entry('b','B')], send); openMenu(); toggle('A'); click('B');
  rerender([entry('b','B',true), entry('a','A')], send);
  assert.equal(document.querySelector('article h3')!.textContent, 'B');
  assert.equal(document.querySelector<HTMLInputElement>('[aria-label="Include A"]')!.checked, false);
  rerender([entry('b','B')], send); rerender([entry('b','B'), entry('a','A')], send);
  assert.equal(document.querySelector<HTMLInputElement>('[aria-label="Include A"]')!.checked, true);
  rerender([entry('a','A')], send);
  assert.equal(document.querySelector('article h3')!.textContent, 'A');
});
test('provider-only inspector and real harness tools classification', () => {
  mount([providerEntry()], () => undefined); openMenu();
  assert.equal(document.querySelectorAll('input[type=checkbox]').length, 0);
  assert.match(document.querySelector('article')!.textContent!, /provider information only/);
  click('Cancel');
  rerender([entry('tools','Tools')], () => undefined); openMenu(); click('Tool definitions');
  assert.match(document.querySelector('article')!.textContent!, /separate from system-message/);
  click('Resolved preview');
  const sections = document.querySelectorAll('.system-instructions-preview > section');
  assert.doesNotMatch(sections[0].textContent!, /Tools body/);
  assert.match(sections[1].textContent!, /Tools body/);
});
test('notice rolls back applied overlay', () => {
  const send = () => undefined;
  mount([entry('a','A')], send); openMenu(); toggle('A'); click('Apply changes');
  rerender([entry('a','A')], send, null, 'Failed to save the system-prompt setting.');
  assert.equal(badge(), null);
});
test('a reversed Apply survives an older acknowledgement before its confirmation', () => {
  const calls: string[][] = [];
  const send = (ids: string[]) => { calls.push(ids); };
  const initial = [entry('a', 'A')];
  mount(initial, send);
  openMenu(); toggle('A'); click('Apply changes');
  openMenu(); toggle('A'); click('Apply changes');
  assert.deepEqual(calls, [['a'], []]);
  assert.equal(badge(), null);
  rerender([entry('a', 'A', true)], send);
  assert.equal(badge(), null, 'older disable confirmation cannot replace the enable intent');
  openMenu();
  assert.equal(document.querySelector<HTMLInputElement>('[aria-label="Include A"]')!.checked, true);
  click('Cancel');
  rerender([entry('a', 'A')], send);
  rerender([entry('a', 'A', true)], send);
  assert.equal(badge(), '1', 'after confirmation a later backend setting is authoritative');
});

test('newer same-session apply survives older async failure', async () => {
  let rejectOld!: () => void;
  let calls = 0;
  const send = () => ++calls === 1 ? new Promise<void>((_, reject) => { rejectOld = () => reject(new Error('old')); }) : undefined;
  mount([entry('a','A'),entry('b','B')], send); openMenu(); toggle('A'); click('Apply changes');
  openMenu(); toggle('B'); click('Apply changes');
  await act(async () => { rejectOld(); await Promise.resolve(); });
  assert.equal(badge(), '2');
});
test('an open inspector cannot apply while disconnected and retains the draft until reconnect', () => {
  const prompts = [entry('a', 'A')];
  const calls: string[][] = [];
  const send = (ids: string[]) => { calls.push(ids); };
  mount(prompts, send);
  openMenu(); toggle('A');
  rerender(prompts, send, null, null, null, false);
  assert.ok(document.querySelector<HTMLButtonElement>('.primary')!.disabled);
  assert.match(document.querySelector('footer')!.textContent!, /Reconnect to apply/);
  assert.deepEqual(calls, []);
  rerender(prompts, send);
  assert.equal(document.querySelector<HTMLButtonElement>('.primary')!.disabled, false);
  click('Apply changes');
  assert.deepEqual(calls, [['a']]);
});

test('tabs use arrow navigation and Markdown code controls remain usable', async () => {
  let copied = '';
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text: string) => { copied = text; },
  } });
  const code = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
  mount([{ ...entry('a', 'A'), text: `\`\`\`text\n${code}\n\`\`\`` }], () => undefined);
  openMenu();
  const sourcesTab = document.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
  act(() => {
    sourcesTab.focus();
    sourcesTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  assert.equal(document.activeElement?.textContent, 'Resolved preview');
  assert.ok(document.querySelector('[role="tabpanel"][aria-labelledby]'));
  const showAll = document.querySelector<HTMLButtonElement>('.code-block-toggle')!;
  act(() => showAll.click());
  assert.equal(showAll.getAttribute('aria-expanded'), 'true');
  assert.ok(!showAll.closest('.code-block')!.classList.contains('code-block-collapsed'));
  await act(async () => {
    document.querySelector<HTMLButtonElement>('.code-block-copy')!.click();
    await Promise.resolve();
  });
  assert.equal(copied, code);
});

test('markdown links and tabindex targets participate in focus wrap', () => {
  mount([{...entry('a','A'), text:'[Link](https://example.com)'}], () => undefined); openMenu();
  const link = document.querySelector<HTMLAnchorElement>('.message-body a')!;
  assert.ok(link);
  const cancel = [...document.querySelectorAll<HTMLButtonElement>('.system-instructions-dialog button')].find(b => b.textContent === 'Cancel')!;
  cancel.hidden = true;
  const close = document.querySelector<HTMLButtonElement>('[aria-label="Close system instructions"]')!;
  act(() => { close.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true})); });
  assert.ok(document.activeElement === link);
  act(() => { link.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true})); });
  assert.ok(document.activeElement === close);
  const generatedTarget = document.createElement('a');
  generatedTarget.tabIndex = 0;
  generatedTarget.textContent = 'Generated markdown target';
  document.querySelector('.message-body')!.appendChild(generatedTarget);
  act(() => { close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })); });
  assert.ok(document.activeElement === generatedTarget);
  generatedTarget.style.display = 'none';
  act(() => { close.focus(); close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })); });
  assert.ok(document.activeElement === link);
});
