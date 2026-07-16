import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeBarLayout,
  kindSuffixFor,
  remainingTokensForChart,
  segmentColor,
} from '../../../src/webview/panel/context-window/breakdown-chart';
import type { ContextWindowBreakdownEntry } from '../../../src/webview/panel/context-window/breakdown';

// `computeBarLayout` accepts a structural `{ tokens }` shape, so tests pass
// minimal objects rather than full render segments.
function seg(tokens: number): { tokens: number } {
  return { tokens };
}

const approxEqual = (a: number, b: number, epsilon = 1e-6): boolean => Math.abs(a - b) < epsilon;
function assertApprox(a: number, b: number, epsilon = 1e-6, msg?: string): void {
  assert.ok(approxEqual(a, b, epsilon), msg ?? `${a} ≈ ${b}`);
}

// ─── segmentColor ───────────────────────────────────────────────────────────

test('segmentColor maps known contributor categories to their fixed semantic colour', () => {
  assert.equal(segmentColor('System prompt'), '#b079f3');
  assert.equal(segmentColor('Read file'), '#4cc2ff');
  assert.equal(segmentColor('Skill'), '#3fb950');
  assert.equal(segmentColor('Skill: frontend-design'), '#3fb950');
  assert.equal(segmentColor('User message'), '#f0883e');
  assert.equal(segmentColor('Assistant responses'), '#58a6ff');
  assert.equal(segmentColor('Reasoning'), '#d2a8ff');
  assert.equal(segmentColor('System messages'), '#f85149');
  assert.equal(segmentColor('Tool: bash'), '#53b9bd');
  assert.equal(segmentColor('Tool: edit'), '#53b9bd');
  assert.equal(segmentColor('Other'), '#e3b341');
});

test('segmentColor is deterministic for unknown labels and always returns a palette colour', () => {
  const palette = new Set([
    '#53b9bd', '#d2a8ff', '#a5d6ff', '#db6d28', '#f85149',
  ]);
  // Same label → same colour across calls.
  assert.equal(segmentColor('some-custom-contributor'), segmentColor('some-custom-contributor'));
  // Every label — including adversarially long / high-codepoint ones that can
  // drive the hash accumulator to INT_MIN (`| 0` yields -2147483648, for which
  // `Math.abs` is still negative) — must resolve to a real palette entry,
  // never `undefined`. This is the regression guard for the negative-index bug.
  const adversarial = [
    'x'.repeat(64),
    'ÆØÅßçñê',
    'a'.repeat(33),
    'long-label-that-hashes-negative',
  ];
  for (const label of adversarial) {
    const color = segmentColor(label);
    assert.ok(
      palette.has(color),
      `expected a fallback palette colour for ${JSON.stringify(label)}, got ${color}`,
    );
  }
  // Distinct labels need not collide (sanity, not a hard guarantee).
  const colors = new Set(adversarial.map(segmentColor));
  assert.ok(colors.size >= 1);
});

// ─── kindSuffixFor ───────────────────────────────────────────────────────────

function entry(kind: ContextWindowBreakdownEntry['kind']): ContextWindowBreakdownEntry {
  return { key: 'k', value: 'v', kind };
}

test('kindSuffixFor maps breakdown kinds to legend suffixes', () => {
  assert.equal(kindSuffixFor(entry('estimated')), 'est');
  assert.equal(kindSuffixFor(entry('derived')), 'derived');
  assert.equal(kindSuffixFor(entry('unknown')), '?');
  assert.equal(kindSuffixFor(entry('exact')), undefined);
});

// ─── remainingTokensForChart ─────────────────────────────────────────────────

test('remainingTokensForChart does not present an unknown window as fully remaining', () => {
  assert.equal(remainingTokensForChart({
    usedTokens: null,
    usedKind: 'unknown',
    remainingTokens: null,
    remainingKind: 'unknown',
    totalWindow: 1000,
  }), 0);

  assert.equal(remainingTokensForChart({
    usedTokens: 250,
    usedKind: 'exact',
    remainingTokens: null,
    remainingKind: 'unknown',
    totalWindow: 1000,
  }), 750);
});

// ─── computeBarLayout ────────────────────────────────────────────────────────

test('computeBarLayout: non-positive total yields a zeroed layout', () => {
  assert.deepEqual(computeBarLayout([seg(50), seg(50)], null, 0), { widths: [0, 0], remainingPct: 0 });
  assert.deepEqual(computeBarLayout([seg(50)], null, -10), { widths: [0], remainingPct: 0 });
});

test('computeBarLayout: segments take their true share, remainder fills the tail', () => {
  const { widths, remainingPct } = computeBarLayout([seg(40), seg(30)], seg(30), 100);
  assertApprox(widths[0]!, 40);
  assertApprox(widths[1]!, 30);
  assertApprox(remainingPct, 30);
});

test('computeBarLayout: all-zero contributors leave the whole window as remainder', () => {
  const { widths, remainingPct } = computeBarLayout([seg(0), seg(0)], seg(100), 100);
  assert.deepEqual(widths, [0, 0]);
  assertApprox(remainingPct, 100);
});

test('computeBarLayout: no remaining segment means no tail', () => {
  const { widths, remainingPct } = computeBarLayout([seg(40), seg(30)], null, 100);
  assertApprox(widths[0]!, 40);
  assertApprox(widths[1]!, 30);
  assert.equal(remainingPct, 0);
});

test('computeBarLayout: tiny non-zero segments are bumped to the minimum visible width', () => {
  // 1 token of 100000 = 0.001% — far below the ~0.833% minimum. It must be
  // bumped up so the segment stays hoverable, with the extra taken from the tail.
  const minPct = (2 / 240) * 100;
  const { widths, remainingPct } = computeBarLayout([seg(1)], seg(99999), 100000);
  assertApprox(widths[0]!, minPct);
  assertApprox(remainingPct, 100 - minPct);
});

test('computeBarLayout: a saturated window scales used segments back to 100% and drops the tail', () => {
  // Three 40-token segments on a 100-token window: used (120%) overflows the
  // window. The segments must be scaled back proportionally so the bar sums to
  // 100% and the remaining tail is dropped (it would be negative).
  const { widths, remainingPct } = computeBarLayout([seg(40), seg(40), seg(40)], null, 100);
  assert.equal(widths.length, 3);
  assertApprox(widths.reduce((a, b) => a + b, 0), 100, 1e-4, 'scaled segments sum to ~100%');
  assertApprox(widths[0]!, widths[1]!, 1e-9, 'segments scale uniformly');
  assertApprox(widths[1]!, widths[2]!, 1e-9);
  assert.equal(remainingPct, 0);
});

test('computeBarLayout: many bumped segments that would overflow are scaled back together', () => {
  // 200 sub-minimum segments would each bump to ~0.833% (sum ~166%) — the
  // saturation path must scale them all back so the bar never exceeds 100%.
  const segments = Array.from({ length: 200 }, () => seg(0.01));
  const { widths, remainingPct } = computeBarLayout(segments, null, 100);
  assert.equal(widths.length, 200);
  assertApprox(widths.reduce((a, b) => a + b, 0), 100, 1e-4);
  assert.equal(remainingPct, 0);
});
