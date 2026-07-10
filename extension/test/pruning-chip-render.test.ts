import assert from 'node:assert/strict';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import type { PruningDetails } from '../src/shared/protocol';
import { PruningHeaderButton } from '../src/webview/panel/transcript/pruning-header';

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

test('PruningHeaderButton renders a compact shared chip label with full summary in title', () => {
  const html = renderToString(h(PruningHeaderButton, {
    details: pruningDetails(),
    expanded: false,
    fallbackText: 'Fallback pruning summary',
    onToggle: () => undefined,
  }));

  assert.match(html, /panel-chip panel-chip-pruning panel-chip-muted panel-chip-interactive/);
  assert.match(html, /<span class="panel-chip-label">2\/15 skills · 3\/4 tools<\/span>/);
  assert.match(html, /title="Kept 2\/15 skills, Kept 3\/4 tools · Saved 1500 tokens"/);
  assert.doesNotMatch(html, /max-w-\[30ch\]/);
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
