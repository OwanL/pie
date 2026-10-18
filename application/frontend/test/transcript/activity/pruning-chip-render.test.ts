import assert from 'node:assert/strict';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import type { PruningDetails } from '../../../../lib/protocol/index.js';
import { PruningHeaderButton } from '../../../transcript/pruning-header';

function pruningDetails(overrides: Partial<PruningDetails> = {}): PruningDetails {
  return {
    mode: 'auto',
    includedSkills: ['systematic-debugging', 'verification-before-completion'],
    excludedSkills: Array.from({ length: 13 }, (_, index) => `skill-${index + 1}`),
    includedTools: ['read', 'grep', 'edit'],
    excludedTools: ['fetch_content'],
    skillTokensSaved: 1200,
    toolTokensSaved: 300,
    ...overrides,
  };
}

test('PruningHeaderButton renders compact prepass metadata with full summary in title', () => {
  const html = renderToString(h(PruningHeaderButton, {
    details: pruningDetails(),
    expanded: false,
    fallbackText: 'Fallback pruning summary',
    onToggle: () => undefined,
  }));

  assert.match(html, /panel-chip panel-chip-pruning panel-chip-muted panel-chip-interactive/);
  assert.match(html, /<span class="pruning-header-label">Prepass<\/span>/);
  assert.match(html, /<span class="panel-chip-label">\s*~1\.5k est\. tokens saved<\/span>/);
  assert.match(html, /title="Kept 2\/15 skills, Kept 3\/4 tools · ~1500 est\. tokens saved"/);
  assert.doesNotMatch(html, /max-w-\[30ch\]/);
});

test('shadow mode labels savings potential and never claims tokens were saved', () => {
  // Shadow mode evaluates pruning but never applies it to the outgoing
  // request, so the figure is potential savings, not actually saved tokens.
  const html = renderToString(h(PruningHeaderButton, {
    details: pruningDetails({ mode: 'shadow' }),
    expanded: false,
    fallbackText: 'Fallback pruning summary',
    onToggle: () => undefined,
  }));

  assert.match(html, /<span class="panel-chip-label">\s*~1\.5k potential savings \(est\.\)<\/span>/);
  assert.match(html, /title="Kept 2\/15 skills, Kept 3\/4 tools · ~1500 potential savings \(est\.\)"/);
  assert.doesNotMatch(html, /tokens saved/i);
  assert.doesNotMatch(html, /Saved/);
});

test('savings label is dropped for zero savings so fallback text survives', () => {
  const html = renderToString(h(PruningHeaderButton, {
    details: pruningDetails({ skillTokensSaved: 0, toolTokensSaved: 0 }),
    expanded: false,
    fallbackText: 'Fallback pruning summary',
    onToggle: () => undefined,
  }));

  assert.equal((html.match(/panel-chip-label">\s*Fallback pruning summary/) ?? []).length, 1);
  assert.doesNotMatch(html, /tokens saved|potential savings/);
});

test('PruningHeaderButton uses danger tone for failed pruning prepass', () => {
  const html = renderToString(h(PruningHeaderButton, {
    details: pruningDetails({ prepassError: 'model unavailable' }),
    expanded: false,
    fallbackText: 'Fallback pruning summary',
    onToggle: () => undefined,
  }));

  assert.match(html, /panel-chip-danger/);
  assert.match(html, /Pruning failed/);
  assert.match(html, /aria-label="Pruning failed: model unavailable"/);
});
