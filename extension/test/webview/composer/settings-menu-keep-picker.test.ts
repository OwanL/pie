import assert from 'node:assert/strict';
import test, { describe, it } from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { AlwaysKeepPicker, computeKeepCatalog, computeToolKeepCatalog, filterKeepCatalog } from '../../../src/webview/panel/composer/settings-menu';

describe('computeKeepCatalog', () => {
  it('returns empty when no inputs', () => {
    assert.deepEqual(computeKeepCatalog([], null, []), []);
  });

  it('unions discovered + included + excluded + currently-selected and sorts', () => {
    const result = computeKeepCatalog(
      ['f', 'b'],
      { included: ['b', 'a'], excluded: ['d', 'c'] },
      ['e', 'a'],
    );
    assert.deepEqual(result, ['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('preserves currently-selected items even when pruning result lacks them', () => {
    // Always-keep items are filtered out of the prepass and therefore won't
    // appear in included/excluded after a turn — they must still be in catalog.
    const result = computeKeepCatalog(['x'], { included: ['x'], excluded: [] }, ['pinned-name']);
    assert.ok(result.includes('pinned-name'));
    assert.ok(result.includes('x'));
  });

  it('includes discovered names even before the pruner has emitted a result', () => {
    const result = computeKeepCatalog(['subagent', 'web_search'], null, []);
    assert.deepEqual(result, ['subagent', 'web_search']);
  });

  it('deduplicates names that appear in multiple inputs', () => {
    const result = computeKeepCatalog(
      ['a', 'b'],
      { included: ['a'], excluded: ['a', 'b'] },
      ['a'],
    );
    assert.deepEqual(result, ['a', 'b']);
  });

  it('tolerates missing included/excluded arrays', () => {
    assert.deepEqual(computeKeepCatalog([], {}, ['only-selected']), ['only-selected']);
  });
});

describe('computeToolKeepCatalog', () => {
  it('seeds provider search tools even when pruning analytics only reports kept file tools', () => {
    const result = computeToolKeepCatalog(['bash', 'edit', 'find', 'grep', 'read'], null, ['bash', 'edit', 'find', 'grep', 'read']);

    assert.ok(result.includes('web_search'));
    assert.ok(result.includes('fetch_content'));
    assert.ok(result.includes('get_search_content'));
    assert.ok(result.includes('source_check'));
    assert.ok(result.includes('session_changes'));
    assert.ok(result.includes('session_review'));
  });
});

describe('filterKeepCatalog', () => {
  const catalog = ['bash', 'edit', 'read', 'subagent', 'web_search'];

  it('hides items already selected', () => {
    assert.deepEqual(filterKeepCatalog(catalog, ['bash', 'edit']), ['read', 'subagent', 'web_search']);
  });

  it('returns all options when nothing is selected', () => {
    assert.deepEqual(filterKeepCatalog(catalog, []), catalog);
  });

  it('returns empty when every option is already selected', () => {
    assert.deepEqual(filterKeepCatalog(catalog, catalog), []);
  });
});

test('AlwaysKeepPicker renders an enum select instead of a raw text input', () => {
  const html = renderToString(h(AlwaysKeepPicker, {
    label: 'Omitted tools (never pruned)',
    selected: ['read'],
    catalog: ['bash', 'read', 'subagent'],
    category: 'tool',
    onChange: () => undefined,
  }));

  assert.match(html, /<select[^>]*toolbar-settings-keep-select/);
  assert.match(html, /Select tool to omit from pruning\.\.\./);
  assert.match(html, />bash<|value="bash"/);
  assert.match(html, />subagent<|value="subagent"/);
  assert.doesNotMatch(html, /type="text"/);
});
