import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { installDom } from '../../helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import type { PruningDetails } from '../../../../lib/protocol/index.js';
import { PruningDiagnostics } from '../../../transcript/pruning-details';
import { PruningHeaderChip, PruningHeaderPanel } from '../../../transcript/pruning-header';
import { AGENT_ACTIVITY_LABELS } from '../../../transcript/activity';

async function readPanelChipCss(): Promise<string> {
  return readFile(new URL('../../../styles/panel-chip.css', import.meta.url), 'utf8');
}

function details(extra: Partial<PruningDetails> = {}): PruningDetails {
  return {
    includedSkills: ['check-ui'], excludedSkills: ['develop-pie', 'diagnose'],
    includedTools: ['read', 'edit'], excludedTools: ['bash'],
    mode: 'auto', skillTokensSaved: 800, toolTokensSaved: 400,
    prepassProvider: 'test-provider', prepassModel: 'test-model',
    prepassThinkingLevel: 'low', prepassLatencyMs: 123,
    prepassThinking: 'Keep the relevant catalog.',
    prepassSystemPrompt: 'System diagnostic', prepassUserMessage: 'User diagnostic',
    prepassResponse: 'Raw diagnostic', ...extra,
  };
}

function withContainer(run: (container: HTMLDivElement) => void) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  try { run(container); } finally {
    act(() => render(null, container));
    container.remove();
  }
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const result = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  assert.ok(result, `expected ${label}`);
  return result;
}

test('completed prepass is a compact summary with deliberate expansion', () => withContainer((container) => {
  let toggles = 0;
  act(() => render(h(PruningHeaderChip, {
    state: { kind: 'result', details: details() }, expanded: false,
    onToggle: () => { toggles++; },
  }), container));
  const summary = container.querySelector<HTMLButtonElement>('button');
  assert.ok(summary);
  const primary = summary.querySelector<HTMLElement>('.pruning-header-label');
  const adjacent = summary.querySelector<HTMLElement>('.panel-chip-label');
  assert.equal(primary?.textContent, 'Prepass');
  assert.equal(adjacent?.textContent?.trim(), '1.2k tokens saved');
  assert.match(summary.textContent ?? '', /Prepass 1\.2k tokens saved/);
  assert.doesNotMatch(summary.textContent ?? '', /skills|tools/);
  assert.equal(summary.getAttribute('aria-expanded'), 'false');
  assert.match(summary.getAttribute('aria-label') ?? '', /Kept 1\/3 skills/);
  assert.equal(summary.title, 'Kept 1/3 skills, Kept 2/3 tools · Saved 1200 tokens');
  assert.equal(container.querySelector('.pruning-detail-list'), null);
  act(() => summary.click());
  assert.equal(toggles, 1);
}));

test('prepass hierarchy is explicitly styled without hover-promoting its summary', async () => {
  const css = await readPanelChipCss();
  const primary = css.match(/\.pruning-header-label\s*\{([^}]*)\}/)?.[1] ?? '';
  const summary = css.match(/\.panel-chip-pruning:not\(\.panel-chip-danger\) \.panel-chip-label\s*\{([^}]*)\}/)?.[1] ?? '';
  const hover = css.match(/\.panel-chip-pruning\.panel-chip-interactive:hover,\s*\.panel-chip-pruning\.panel-chip-interactive:focus-visible\s*\{([^}]*)\}/)?.[1] ?? '';

  assert.match(primary, /font-family:\s*var\(--vscode-font-family, sans-serif\)/);
  assert.match(primary, /font-size:\s*11px/);
  assert.match(primary, /font-weight:\s*400/);
  assert.match(primary, /color:\s*var\(--panel-muted\)/);
  assert.match(summary, /font-family:\s*var\(--vscode-font-family, sans-serif\)/);
  assert.match(summary, /font-size:\s*11px/);
  assert.match(summary, /font-weight:\s*400/);
  assert.match(summary, /color:\s*var\(--panel-muted\)/);
  assert.doesNotMatch(hover, /(?:^|[;\n])\s*color:/);
  assert.doesNotMatch(css, /\.panel-chip-pruning\.panel-chip-interactive:hover \.panel-chip-label/);
});

test('zero savings uses only a nonempty fallback and never invents Complete', () => withContainer((container) => {
  const draw = (fallbackText?: string) => act(() => render(h(PruningHeaderChip, {
    state: { kind: 'result', details: details({ skillTokensSaved: 0, toolTokensSaved: 0 }), fallbackText },
    expanded: false, onToggle: () => {},
  }), container));
  draw('No pruning needed');
  assert.equal(container.querySelector('.panel-chip-label')?.textContent?.trim(), 'No pruning needed');
  draw('  ');
  assert.equal(container.querySelector('.panel-chip-label')?.textContent, '');
}));

test('pending status preserves custom and fallback labels and cancellation', () => withContainer((container) => {
  let cancelled = 0;
  const draw = (label: string) => act(() => render(h(PruningHeaderChip, {
    state: { kind: 'pending', label }, expanded: false, onToggle: () => {},
    onCancel: () => { cancelled++; },
  }), container));
  draw('Selecting relevant tools');
  const status = container.querySelector('[role="status"]');
  assert.ok(status);
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(status.getAttribute('aria-label'), 'Selecting relevant tools');
  assert.equal(status.querySelector('.pruning-header-label')?.textContent, 'Prepass');
  assert.equal(status.textContent, 'Prepass');
  assert.equal(status.getAttribute('title'), 'Selecting relevant tools');
  assert.ok(status.querySelector('.pruning-header-active-marker[aria-hidden="true"]'));
  assert.equal(status.querySelector('.agent-activity-text'), null);
  const cancel = button(container, 'Cancel pruning prepass');
  assert.equal(cancel.textContent, 'Cancel');
  act(() => cancel.click());
  assert.equal(cancelled, 1);
  draw('  ');
  assert.equal(container.querySelector('[role="status"]')?.textContent, 'Prepass');
  assert.equal(container.querySelector('[role="status"]')?.getAttribute('aria-label'), AGENT_ACTIVITY_LABELS.pruning);
}));

test('pending elapsed uses host timing, updates live, and cleans up on completion', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10_000 });
  const clear = t.mock.method(globalThis, 'clearInterval');
  withContainer((container) => {
    const draw = (prepassStartedAt?: number | null) => act(() => render(h(PruningHeaderChip, {
      state: { kind: 'pending', label: 'Selecting relevant tools', prepassStartedAt },
      expanded: false, onToggle: () => {},
    }), container));
    draw(5_000);
    const status = container.querySelector('[role="status"]');
    assert.equal(status?.textContent, 'Prepass5s');
    assert.equal(status?.getAttribute('title'), 'Selecting relevant tools · 5s elapsed');
    assert.equal(status?.getAttribute('aria-label'), 'Selecting relevant tools', 'stable accessible status avoids announcing every tick');
    act(() => t.mock.timers.tick(2_000));
    assert.equal(status?.textContent, 'Prepass7s');
    draw(11_000);
    assert.equal(status?.textContent, 'Prepass1s', 'changed host start resets elapsed');
    draw(60_000);
    assert.equal(status?.textContent, 'Prepass0s', 'future timestamps never show negative elapsed');
    draw(null);
    assert.equal(status?.textContent, 'Prepass');
    draw(Number.NaN);
    assert.equal(status?.textContent, 'Prepass', 'invalid timing is unavailable, not made up');
    draw(5_000);
    const clearedBeforeCompletion = clear.mock.callCount();
    act(() => render(h(PruningHeaderChip, {
      state: { kind: 'result', details: details() }, expanded: false, onToggle: () => {},
    }), container));
    assert.equal(clear.mock.callCount(), clearedBeforeCompletion + 1, 'completion clears the live timer');
    act(() => t.mock.timers.tick(10_000));
    assert.equal(container.querySelector('[role="status"]'), null);
    assert.equal(container.querySelector('.pruning-header-elapsed'), null);
  });
});

test('failure remains visible in summary and expanded alert', () => withContainer((container) => {
  const failed = details({ prepassError: 'Provider unavailable' });
  act(() => render(h(PruningHeaderChip, {
    state: { kind: 'result', details: failed }, expanded: true, onToggle: () => {},
  }), container));
  const summary = button(container, 'Pruning failed: Provider unavailable');
  assert.match(summary.textContent ?? '', /Prepass failed/);
  assert.ok(summary.classList.contains('panel-chip-danger'));
  assert.equal(summary.title, 'Provider unavailable');
  act(() => render(h(PruningHeaderPanel, {
    details: failed, rawExpanded: false, onRawToggle: () => {},
  }), container));
  assert.equal(container.querySelector('[role="alert"]')?.textContent?.trim(), '⚠Provider unavailable');
}));

test('expanded diagnostics show counts once, quiet metadata, full tags and nested data', () => withContainer((container) => {
  let rawOpen = false;
  const draw = () => act(() => render(h(PruningHeaderPanel, {
    details: details({ prepassSafeguardReason: 'Empty selection rejected' }),
    rawExpanded: rawOpen, onRawToggle: () => { rawOpen = !rawOpen; draw(); },
  }), container));
  draw();
  assert.deepEqual(Array.from(container.querySelectorAll('.pruning-category-count'), (node) => node.textContent), ['kept 1 of 3', 'kept 2 of 3']);
  assert.equal(container.querySelector('.pruning-stat-tile'), null);
  assert.equal(container.querySelector('.pruning-mode-badge'), null);
  const metadata = container.querySelector('.pruning-meta-line')?.textContent ?? '';
  assert.match(metadata, /test-provider · test-model · thinking low · 123ms · mode Auto/);
  assert.doesNotMatch(metadata, /tokens saved/);
  assert.equal((container.textContent?.match(/tokens saved/g) ?? []).length, 0);
  assert.deepEqual(Array.from(container.querySelectorAll('.pruning-tag-kept'), (node) => node.textContent), ['check-ui', 'read', 'edit']);
  assert.deepEqual(Array.from(container.querySelectorAll('.pruning-tag-pruned'), (node) => node.textContent), ['develop-pie', 'diagnose', 'bash']);
  assert.match(container.querySelector('.pruning-banner-warning')?.textContent ?? '', /Keep-all safeguard — Empty selection rejected/);
  const reasoning = button(container, 'Toggle pruning prepass reasoning');
  const raw = button(container, 'Diagnostics');
  assert.equal(raw.textContent, 'Diagnostics');
  assert.equal(reasoning.getAttribute('aria-expanded'), 'false');
  assert.equal(raw.getAttribute('aria-expanded'), 'false');
  assert.equal(container.querySelector('pre'), null);
  act(() => reasoning.click());
  assert.match(container.textContent ?? '', /Keep the relevant catalog\./);
  act(() => raw.click());
  assert.deepEqual(Array.from(container.querySelectorAll('.pruning-raw-label'), (node) => node.textContent), ['System prompt', 'User prompt', 'Raw LLM output']);
  for (const data of ['System diagnostic', 'User diagnostic', 'Raw diagnostic']) assert.ok(container.textContent?.includes(data));
}));

test('inline diagnostics retain savings because no header summary is assumed', () => withContainer((container) => {
  act(() => render(h(PruningDiagnostics, {
    details: details(), rawExpanded: false, onRawToggle: () => {}, presentation: 'inline',
  }), container));
  const metadata = container.querySelector('.pruning-meta-line')?.textContent ?? '';
  assert.match(metadata, /1,200 tokens saved/);
  assert.equal((container.textContent?.match(/tokens saved/g) ?? []).length, 1);
}));

test('actual modes and explicit thinking off remain available without badges', () => withContainer((container) => {
  for (const mode of ['auto', 'shadow', 'off', 'custom'] as const) {
    act(() => render(h(PruningHeaderPanel, {
      details: details({ mode, prepassThinkingLevel: 'off' }), rawExpanded: true, onRawToggle: () => {},
    }), container));
    assert.match(container.querySelector('.pruning-meta-line')?.textContent ?? '', new RegExp(`thinking off.*mode ${mode[0].toUpperCase()}${mode.slice(1)}`));
    assert.equal(container.querySelector('.pruning-mode-badge'), null);
  }
}));
