import assert from 'node:assert/strict';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { TurnActivityBlock } from '../src/webview/panel/transcript/turn-activity-tail.tsx';
import { TurnActivityTailBody, TAIL_RENDER_MAX_CHARS, streamContinues } from '../src/webview/panel/transcript/activity-tail-preview.tsx';
import type { TurnActivityState } from '../src/webview/panel/transcript/activity';
import {
  collapseSpaces,
  type TurnActivityTail,
} from '../src/webview/panel/transcript/activity-tail';

function tail(
  overrides: Partial<TurnActivityTail> & { kind: TurnActivityTail['kind'] },
): TurnActivityTail {
  return { lines: [], truncated: false, cursor: true, reservedRows: 2, ...overrides };
}

function countCaret(html: string): number {
  return (html.match(/turn-activity-tail-cursor/g) ?? []).length;
}

// ── composite merge (tool / subagent) ──────────────────────────────────────

test('TurnActivityTailBody merges the tool name + command onto one composite row', () => {
  const html = renderToString(h(TurnActivityTailBody, {
    tail: tail({
      kind: 'tool',
      label: 'bash',
      inputLine: 'npm run test',
      lines: ['somefile.py pass', 'somefile2.py pass'],
    }),
  }));
  assert.match(html, /turn-activity-tail-composite/);
  assert.match(html, /turn-activity-tail-label">bash</);
  assert.match(html, /turn-activity-tail-sep/);
  assert.match(html, /npm run test/);
  // both output lines render; exactly one caret, on the newest (last) line only
  assert.match(html, /somefile\.py pass/);
  assert.match(html, /somefile2\.py pass/);
  assert.equal(countCaret(html), 1);
});

test('TurnActivityTailBody puts the caret on the composite row before any output arrives', () => {
  const html = renderToString(h(TurnActivityTailBody, {
    tail: tail({ kind: 'tool', label: 'bash', inputLine: 'npm run test', lines: [] }),
  }));
  assert.match(html, /turn-activity-tail-composite/);
  assert.equal(countCaret(html), 1);
  // the content block still renders (reserving the output rows) even when empty
  assert.match(html, /turn-activity-tail-content/);
});

test('TurnActivityTailBody renders a composite with no input as just the label', () => {
  const html = renderToString(h(TurnActivityTailBody, {
    tail: tail({ kind: 'tool', label: 'running 2 tools', lines: ['→ bash', '→ read'] }),
  }));
  assert.match(html, /turn-activity-tail-label">running 2 tools</);
  assert.doesNotMatch(html, /turn-activity-tail-sep/);
  assert.match(html, /→ bash/);
  assert.match(html, /→ read/);
  assert.equal(countCaret(html), 1);
});

// ── reasoning / reply text (no header row) ──────────────────────────────────

test('TurnActivityTailBody renders reasoning text with no header label row', () => {
  const html = renderToString(h(TurnActivityTailBody, {
    tail: tail({ kind: 'reasoning', lines: ['planning the work', 'so we need to do some stuff'] }),
  }));
  assert.doesNotMatch(html, /turn-activity-tail-composite/);
  assert.doesNotMatch(html, /turn-activity-tail-label/);
  assert.match(html, /turn-activity-tail reasoning/);
  assert.match(html, /data-kind="reasoning"/);
  assert.match(html, /planning the work/);
  assert.match(html, /so we need to do some stuff/);
  assert.equal(countCaret(html), 1);
});

// ── truncation fade gating ─────────────────────────────────────────────────

test('TurnActivityTailBody applies the truncation fade only with >=2 content lines', () => {
  const single = renderToString(h(TurnActivityTailBody, {
    tail: tail({ kind: 'text', lines: ['only line'], truncated: true }),
  }));
  assert.doesNotMatch(single, /truncated/);

  const multi = renderToString(h(TurnActivityTailBody, {
    tail: tail({ kind: 'text', lines: ['line one', 'line two'], truncated: true }),
  }));
  assert.match(multi, /turn-activity-tail-content truncated/);
});

test('TurnActivityTailBody slides the content via an animated translateY transform', () => {
  const html = renderToString(h(TurnActivityTailBody, {
    tail: tail({ kind: 'text', lines: ['streaming text that wraps as it grows'] }),
  }));
  // The scroll offset is applied as a transform so reflow can animate instead of snap.
  assert.match(html, /translateY\(/);
});

// ── sourceText-driven streaming ───────────────────────────────────────────

test('TurnActivityTailBody renders from sourceText, ignoring the stale lines snapshot', () => {
  // Reasoning / reply / tool tails carry the raw source; the body re-windows
  // the *revealed* source itself, so its text follows sourceText rather than
  // the pre-windowed `lines`. Here `lines` is deliberately stale to prove it.
  const html = renderToString(h(TurnActivityTailBody, {
    tail: tail({
      kind: 'text',
      lines: ['stale lines snapshot that must not render'],
      sourceText: 'SOURCE-DRIVEN streaming content the body should render',
    }),
  }));
  assert.match(html, /SOURCE-DRIVEN streaming content the body should render/);
  assert.doesNotMatch(html, /stale lines snapshot/);
});

test('TurnActivityTailBody renders the full revealed sourceText with newlines collapsed', () => {
  // The body renders the *full* revealed tail (not a re-windowed char slice) so
  // the wrapped line count grows monotonically — which is what the row-scroll
  // animation keys on. `lines` is deliberately stale to prove the body renders
  // from `sourceText`, not the pre-windowed snapshot.
  const source = Array.from({ length: 60 }, (_, i) => `line${i}`).join('\n');
  const expected = collapseSpaces(source);
  const html = renderToString(h(TurnActivityTailBody, {
    tail: tail({ kind: 'reasoning', lines: ['placeholder'], sourceText: source }),
  }));
  assert.ok(html.includes(expected), 'body renders the full collapsed source, not a char-windowed slice');
  assert.doesNotMatch(html, /placeholder/);
});

test('TurnActivityTailBody caps the rendered tail at the safety bound for huge sources', () => {
  // A source well past the safety cap: only the last TAIL_RENDER_MAX_CHARS are
  // rendered (the newest content is kept; the oldest is dropped) so the layout
  // never has to wrap a huge string every frame.
  const marker = 'TAILMARKER';
  const source = `${'X'.repeat(TAIL_RENDER_MAX_CHARS + 5000)}${marker}`;
  const expected = collapseSpaces(source.slice(source.length - TAIL_RENDER_MAX_CHARS));
  const html = renderToString(h(TurnActivityTailBody, {
    tail: tail({ kind: 'reasoning', lines: ['placeholder'], sourceText: source }),
  }));
  assert.ok(html.includes(expected), 'body renders the safety-capped tail');
  assert.ok(html.includes(marker), 'the newest content (marker) is kept');
  assert.doesNotMatch(html, /placeholder/);
});

// ── TurnActivityBlock: a11y + empty fallback ───────────────────────────────

test('TurnActivityBlock announces status accessibly while keeping the tail decorative', () => {
  const state: TurnActivityState = {
    phase: 'runningTool',
    label: 'bash',
    tone: 'active',
    ariaLabel: 'Agent is running bash',
    tail: tail({ kind: 'tool', label: 'bash', inputLine: 'ls' }),
  };
  const html = renderToString(h(TurnActivityBlock, { state }));
  assert.match(html, /role="status"/);
  assert.match(html, /Agent is running bash/);
  // the live preview itself is hidden from assistive tech
  assert.match(html, /aria-hidden="true"/);
});

test('TurnActivityBlock renders nothing without a tail', () => {
  const state: TurnActivityState = {
    phase: 'thinking',
    label: 'thinking',
    tone: 'neutral',
    ariaLabel: 'Agent is thinking',
  };
  assert.equal(renderToString(h(TurnActivityBlock, { state })), '');
});

// ── streamContinues: the row-scroll suppression decision ─────────────────────
// This is the crux of the console-scroll fix: a *growing* source must count as
// a continuation (so it animates), while a replacement / mount / (re)appearance
// must not (so it suppresses and the first row just appears). Getting this wrong
// — e.g. comparing raw text equality — re-suppresses on every snapshot and cuts
// every in-flight glide, re-introducing the snap.

test('streamContinues is true when the source grows by appending (normal streaming)', () => {
  assert.equal(streamContinues('reasoning so far', 'reasoning so far, more', true, true), true);
  assert.equal(streamContinues('line\n', 'line\nline2', true, true), true);
});

test('streamContinues is true across many snapshots of the same growing stream', () => {
  let prev = 'seed';
  for (const next of ['seed a', 'seed a b', 'seed a b c', 'seed a b c d']) {
    assert.equal(streamContinues(prev, next, true, true), true);
    prev = next;
  }
});

test('streamContinues is false when the source is replaced, not grown', () => {
  // reasoning -> reply / tool A -> tool B: different content, not a forward extension.
  assert.equal(streamContinues('reasoning text', 'tool result output', true, true), false);
  assert.equal(streamContinues('bash stdout', 'read file output', true, true), false);
  // a status line changing is a replacement, not growth.
  assert.equal(streamContinues('agent: running bash', 'agent: running read', true, true), false);
});

test('streamContinues is false on mount / when content (re)appears', () => {
  // mount: no previous content.
  assert.equal(streamContinues('', 'first reasoning', false, true), false);
  // content disappears then reappears.
  assert.equal(streamContinues('old reasoning', 'new reasoning', false, true), false);
  // currently empty (no content) never continues.
  assert.equal(streamContinues('whatever', '', true, false), false);
});

test('streamContinues is false when the source shrinks within a continuing stream', () => {
  // A shrink is not a forward extension (next.startsWith(prev) fails) — treat as
  // a replacement so the baseline resets instead of animating a negative delta.
  assert.equal(streamContinues('longer source', 'longer', true, true), false);
});
