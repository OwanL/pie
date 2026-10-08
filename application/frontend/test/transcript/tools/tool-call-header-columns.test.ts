import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { afterEach, beforeEach } from 'node:test';
import { installDom } from '../../helpers/dom';
installDom();
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { ToolCallHeader } from '../../../transcript/tool-call-card/tool-call-header';
import { ToolCallCard } from '../../../transcript/tool-call-card';
import { clearCollapsibleCache } from '../../../transcript/use-collapsible-open';
import { clearLazyDetailCache, receiveLazyDetailResult, setLazyDetailPostMessage } from '../../../transcript/lazy-detail-store';
import type { ToolCall, WebviewToHostMessage } from '../../../../lib/protocol/index.js';

let container: HTMLElement;
const noop = () => undefined;
const base: ToolCall = { id: 'read', name: 'read', input: { path: '/repo/a.ts' }, status: 'completed' };
beforeEach(() => {
  clearCollapsibleCache();
  clearLazyDetailCache();
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => { render(null, container); container.remove(); clearLazyDetailCache(); });
function paint(call: ToolCall, open = false) {
  act(() => render(h(ToolCallHeader, {
    open, name: call.name, status: call.status, summary: 'a.ts', summaryPath: '/repo/a.ts', toolCall: call,
    onOpenFile: noop, onToggle: noop,
  }), container));
}

test('raw inspection lives on the left tool icon, beside rather than inside the native toggle', () => {
  paint(base);
  const header = container.querySelector('.tool-call-header')!;
  const toggle = header.querySelector('.tool-call-toggle')!;
  const icon = header.querySelector('[aria-label="Inspect read model exchange"]')!;
  assert.ok(icon.querySelector('svg'), 'inspection uses the tool icon');
  assert.equal(icon.closest('.tool-call-header')?.firstElementChild?.contains(icon), true);
  assert.equal(header.children[1], toggle);
  assert.equal(toggle.querySelector('button, [role="button"]'), null);
  assert.equal(header.querySelector('.tool-call-actions .tool-call-raw-action'), null);
  assert.equal(header.querySelectorAll('[aria-label="Inspect read model exchange"]').length, 1);
  assert.ok(header.querySelector('.tool-call-actions [aria-label="Open file /repo/a.ts"]'));
});

test('only present metadata and file actions render; empty completed calls reserve no placeholders', () => {
  const calls: ToolCall[] = [base, { ...base, status: 'running' }, { ...base, status: 'failed' }, { ...base, name: 'custom', input: {} }];
  act(() => render(h('div', {}, calls.map((call, index) => h(ToolCallHeader, {
    key: index, open: false, name: call.name, status: call.status, summary: index === 3 ? null : 'a.ts',
    summaryPath: index === 3 ? undefined : '/repo/a.ts', toolCall: call,
    sizeHint: index === 0 ? '2 KB' : undefined, durationMs: index === 0 || index === 2 ? 1250 : undefined,
    errorDetail: index === 2 ? 'Read denied' : undefined,
    onOpenFile: noop, onToggle: noop,
  }))), container));
  const rows = [...container.querySelectorAll('.tool-call-header')];
  assert.equal(rows.length, 4);
  assert.deepEqual([...rows[0].querySelector('.tool-call-header-meta')!.children].map((item) => item.className), [
    'tool-call-size', 'tool-call-duration',
  ]);
  assert.equal(rows[0].querySelector('.tool-call-size')?.textContent, '2 KB');
  assert.ok(rows[0].querySelector('.tool-call-duration')?.textContent);
  assert.ok(rows[0].querySelector('.tool-call-actions [aria-label="Open file /repo/a.ts"]'));
  assert.deepEqual([...rows[1].querySelector('.tool-call-header-meta')!.children].map((item) => item.className), [
    'tool-call-status-spinner',
  ]);
  assert.deepEqual([...rows[2].querySelector('.tool-call-header-meta')!.children].map((item) => item.className), [
    'tool-call-duration', 'status-chip status-chip-failed has-error-detail',
  ]);
  assert.ok(rows[2].querySelector('.tool-call-actions [aria-label="Open file /repo/a.ts"]'));
  assert.equal(rows[3].querySelector('.tool-call-header-meta'), null);
  assert.equal(rows[3].querySelector('.tool-call-actions'), null);
  assert.equal(rows[3].querySelector('.tool-call-context, .tool-call-activity, .tool-call-state-column'), null);
});

test('file actions precede metadata so they cannot reserve space after the visible trailing item', () => {
  for (const status of ['completed', 'failed', 'running', 'ready'] as const) {
    for (const summaryPath of ['/repo/a.ts', undefined]) {
      act(() => render(h(ToolCallHeader, {
        open: false, name: summaryPath ? 'read' : 'bash', status, summary: 'target', summaryPath,
        durationMs: 1250, onOpenFile: noop, onToggle: noop,
      }), container));
      const header = container.querySelector('.tool-call-header')!;
      const metadata = header.querySelector('.tool-call-header-meta')!;
      assert.equal(header.lastElementChild, metadata);
      assert.equal(metadata.nextElementSibling, null, 'no hidden action after duration or activity');
      const actions = header.querySelector('.tool-call-actions');
      if (summaryPath) assert.equal(actions?.nextElementSibling, metadata);
      else assert.equal(actions, null, 'no empty action slot');
    }
  }
});

test('pending markers and running wheel render directly in metadata without stale duration', () => {
  for (const status of ['drafting', 'ready', 'running', 'completed'] as const) {
    act(() => render(h(ToolCallHeader, {
      open: false, name: base.name, status, summary: 'a.ts', durationMs: 1250,
      onOpenFile: noop, onToggle: noop,
    }), container));
    const meta = container.querySelector('.tool-call-header-meta')!;
    if (status === 'completed') {
      assert.equal(meta.querySelector('.tool-call-duration')?.textContent, '1.3s');
      assert.equal(meta.querySelector('[role="img"]'), null, 'no completion check');
    } else {
      assert.equal(meta.querySelector('.tool-call-duration'), null);
      assert.equal(meta.querySelectorAll('[role="img"]').length, 1);
      assert.equal(meta.querySelector('[role="img"]')?.getAttribute('aria-label'), status === 'running' ? 'Running' : status === 'ready' ? 'Ready' : 'Drafting');
    }
  }
});

test('rightmost metadata follows failure, activity, duration, pruning, then size precedence', () => {
  const cases: [ToolCall['status'], number | undefined, string][] = [
    ['failed', 1250, '.status-chip-failed'],
    ['failed', undefined, '.status-chip-failed'],
    ['failed', 0, '.status-chip-failed'],
    ['running', 1250, '.tool-call-status-spinner'],
    ['ready', 1250, '.tool-call-status-draft'],
    ['drafting', 1250, '.tool-call-status-draft'],
    ['completed', 1250, '.tool-call-duration'],
    ['completed', 0, '.tool-call-duration'],
    ['completed', undefined, '.tool-result-pruning-badge'],
  ];
  for (const [status, durationMs, rightmost] of cases) {
    act(() => render(h(ToolCallHeader, {
      open: false, name: 'read', status, summary: 'a.ts', summaryPath: '/repo/a.ts',
      durationMs, sizeHint: '2 KB', pruningBadge: { rules: ['strip-ansi'], tokensSaved: 42 },
      onOpenFile: noop, onToggle: noop,
    }), container));
    const header = container.querySelector('.tool-call-header')!;
    const meta = header.querySelector('.tool-call-header-meta')!;
    assert.equal(header.lastElementChild, meta);
    assert.ok(meta.lastElementChild?.matches(rightmost), `${status} with duration ${durationMs}: ${rightmost} wins`);
  }
  act(() => render(h(ToolCallHeader, {
    open: false, name: 'read', status: 'completed', summary: 'a.ts', sizeHint: '2 KB',
    onOpenFile: noop, onToggle: noop,
  }), container));
  assert.ok(container.querySelector('.tool-call-header-meta')?.lastElementChild?.matches('.tool-call-size'));
});

test('failure remains rightmost alongside execution time, and keeps its accessible copy control', () => {
  act(() => render(h(ToolCallHeader, {
    open: false, name: base.name, status: 'failed', summary: 'a.ts', sizeHint: '2 KB', durationMs: 1250,
    errorDetail: 'Read denied', pruningBadge: { rules: ['strip-ansi'], tokensSaved: 42 },
    onOpenFile: noop, onToggle: noop,
  }), container));
  const meta = container.querySelector('.tool-call-header-meta')!;
  const failure = meta.querySelector<HTMLElement>('.status-chip-failed')!;
  const duration = meta.querySelector('.tool-call-duration')!.textContent!;
  assert.deepEqual([...meta.children].map((item) => item.className), [
    'tool-call-duration', 'status-chip status-chip-failed has-error-detail',
  ]);
  assert.equal(meta.getAttribute('data-failed'), null);
  assert.equal(meta.querySelectorAll('.status-chip-failed').length, 1);
  assert.equal(failure.getAttribute('role'), 'button');
  assert.equal(failure.tabIndex, 0);
  assert.equal(failure.title, `Read denied · Tool execution time: ${duration}`);
  assert.equal(failure.getAttribute('aria-label'), 'Copy tool-call error detail');
  assert.equal(meta.querySelector('.tool-call-size, .tool-result-pruning-badge'), null);
});

test('pruning icon exposes its accessible savings label', () => {
  act(() => render(h(ToolCallHeader, {
    open: false, name: base.name, status: base.status, summary: 'a.ts', toolCall: base,
    pruningBadge: { rules: ['strip-ansi'], tokensSaved: 12345 },
    onOpenFile: noop, onToggle: noop,
  }), container));
  const badge = container.querySelector<HTMLElement>('.tool-call-header-meta .tool-result-pruning-badge')!;
  assert.equal(badge.textContent?.trim(), '✂');
  assert.equal(badge.title, 'Tool-result pruning saved 12345 tokens');
  assert.equal(badge.getAttribute('aria-label'), badge.title);
  assert.equal(badge.getAttribute('role'), 'img');
});

test('completed collapsed reads render one contiguous escaped, bounded preview adjacent to the filename', () => {
  const start = '<img src=x onerror=alert(1)> START ' + 'a'.repeat(200);
  const end = 'b'.repeat(200) + ' END <script>bad()</script>';
  paint({ ...base, result: `${start}\n${'middle\n'.repeat(1000)}${end}` });
  const preview = container.querySelector('.tool-call-read-preview')!;
  assert.equal(preview.getAttribute('aria-hidden'), 'true');
  assert.equal(preview.querySelector('img, script'), null);
  assert.equal(preview.children.length, 0, 'no separately flexed start/end fragments');
  assert.equal(preview.previousElementSibling?.className, 'tool-call-primary-summary');
  const [first, last] = (preview.textContent ?? '').split(' … ');
  assert.match(first, /^<img src=x onerror=alert\(1\)> START/);
  assert.match(last, /END <script>bad\(\)<\/script>$/);
  assert.ok(first.length <= 90 && last.length <= 90);
  assert.ok(preview.textContent?.includes(' … '));
  assert.doesNotMatch(preview.textContent ?? '', /middle/);
  paint({ ...base, result: 'short output' });
  assert.equal(container.querySelector('.tool-call-read-preview')?.textContent, 'short output');
  assert.equal(container.querySelector('.tool-call-read-preview')?.children.length, 0);
});

test('snippets appear only for completed reads with direct text and disappear while expanded', () => {
  for (const call of [
    ...(['drafting', 'ready', 'running', 'failed'] as const).map((status) => ({ ...base, status, result: 'output' })),
    ...['bash', 'write', 'edit', 'custom'].map((name) => ({ ...base, name, result: 'output' })),
    base, { ...base, result: { content: [{ type: 'image', mimeType: 'image/png', data: 'BINARY' }] } },
  ]) {
    paint(call);
    assert.equal(container.querySelector('.tool-call-read-preview'), null, `${call.name}/${call.status}`);
  }
  paint({ ...base, result: 'output' }, true);
  assert.equal(container.querySelector('.tool-call-read-preview'), null);
});

test('missing lazy direct result does not fetch or invent a collapsed snippet, including after expansion loads detail', () => {
  const messages: WebviewToHostMessage[] = [];
  setLazyDetailPostMessage((message) => messages.push(message));
  const call: ToolCall = { ...base, detailRef: {
    key: 'header-read', kind: 'tool-result', source: 'durable', sessionPath: '/fixture', messageId: 'm',
    toolCallId: base.id, sizeBytes: 100000, summary: 'not output', available: true,
  } };
  act(() => render(h(ToolCallCard, { toolCall: call, workingDirectory: '/repo', onOpenFile: noop, onContextMenu: noop }), container));
  assert.equal(container.querySelector('.tool-call-read-preview'), null);
  assert.equal(messages.length, 0);
  const toggle = container.querySelector('.tool-call-toggle') as HTMLButtonElement;
  act(() => toggle.click());
  assert.equal(messages.filter((message) => message.type === 'requestDetail').length, 1);
  act(() => receiveLazyDetailResult({ sessionPath: '/fixture', key: 'header-read', status: 'loaded', value: 'FULL OUTPUT', sizeBytes: 11 }));
  assert.equal(container.querySelector('.tool-call-read-preview'), null, 'expanded details never duplicate output in the header');
  act(() => toggle.click());
  assert.equal(container.querySelector('.tool-call-read-preview'), null, 'a cached lazy result is not a directly present result');
});

test('CSS keeps the header and optional metadata in flex flow, shows failure on narrow rows, and preserves inspection icons', async () => {
  const css = await readFile(new URL('../../../styles/tool-call.css', import.meta.url), 'utf8');
  assert.match(css, /\.tool-call-header\s*\{[^}]*display:\s*flex;/);
  assert.match(css, /\.tool-call-header-meta\s*\{[^}]*display:\s*flex;[^}]*gap:\s*8px;/);
  assert.doesNotMatch(css, /\.tool-call-header\s*\{[^}]*display:\s*grid;/);
  assert.doesNotMatch(css, /\.tool-call-header-meta\s*\{[^}]*display:\s*grid;/);
  assert.doesNotMatch(css, /\.tool-call-header(?:-meta)?\s*\{[^}]*grid-template-columns\s*:/);
  assert.doesNotMatch(css, /\.tool-call-header-meta\s*\{[^}]*(?:min-|max-)?width:\s*\d+px;/,
    'metadata grows naturally instead of reserving a fixed-width slot');
  assert.match(css, /\.tool-call-heading-content\s*\{[^}]*gap:\s*8px;[^}]*overflow:\s*hidden;/);
  assert.match(css, /\.tool-call-read-preview\s*\{[^}]*flex:\s*0 10 auto;[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/);
  assert.doesNotMatch(css, /\.tool-call-read-preview-(?:start|end|separator)/);
  assert.match(css, /\.tool-call-header-meta\s*\{[^}]*gap:\s*8px;/);
  assert.match(css, /\.tool-call-duration,\s*\.tool-call-size\s*\{[^}]*text-align:\s*right;/);
  const narrow = css.match(/@container tool-row \(max-width: 480px\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(narrow, 'expected narrow-row size and spacing adjustments');
  assert.match(narrow, /\.tool-call-size,\s*\.tool-call-header-meta:has\(> \.tool-call-size:only-child\)\s*\{\s*display:\s*none;/);
  assert.match(narrow, /\.tool-call-header-meta\s*\{\s*gap:\s*6px;/);
  assert.doesNotMatch(narrow, /\.(?:tool-call-header-meta|status-chip-failed|tool-call-duration)\s*\{[^}]*display:\s*none;/,
    'narrow rows retain the failure chip and its execution time');
  assert.match(css, /@container tool-row \(max-width:\s*640px\)\s*\{\s*\.tool-call-read-preview\s*\{\s*display:\s*none;/);
  assert.match(css, /@container tool-row \(max-width:\s*640px\)[\s\S]*?\.tool-call-secondary-detail\s*\{\s*display:\s*none;/);
  assert.match(css, /\.tool-call-read-preview\s*\{[^}]*font-weight:\s*400;[^}]*color:\s*var\(--panel-muted\);/);
  assert.match(css, /\.tool-call-kind-icon\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/);
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/\.tool-call-(?:kind-icon|icon-inspector|raw-action)\b/.test(rule[1])) continue;
    assert.doesNotMatch(rule[2], /(?:opacity:\s*0(?:;|\s)|visibility:\s*hidden|display:\s*none|pointer-events:\s*none)/,
      'the left inspection icon remains visible and interactive at rest');
  }
});
