import assert from 'node:assert/strict';
import test, { describe, it } from 'node:test';

import { installDom } from '../helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import renderToString from 'preact-render-to-string';

import { AlwaysKeepPicker, computeKeepCatalog, computeToolKeepCatalog, filterKeepCatalog } from '../../settings/settings-menu';
import { reconcileSelectionEcho, sameSelection } from '../../settings/optimistic-selection';

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

/** In-order echo harness: the host contract delivers snapshot echoes strictly
 *  after and in the order of the values we submitted, so these tests only
 *  simulate monotonic echoed selections; out-of-order echo delivery is not
 *  imagined (the revision guard upstream discards stale snapshots either
 *  way). */
describe('AlwaysKeepPicker optimistic intended selection (in-order echoes)', () => {
  const catalog = ['bash', 'edit', 'read', 'subagent'];
  interface Harness {
    container: HTMLDivElement;
    calls: string[][];
    echo: (selected: string[]) => void;
    add: (name: string) => void;
    remove: (name: string) => void;
    chips: () => string[];
    options: () => string[];
    unmount: () => void;
  }

  function mount(selected: string[]): Harness {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const calls: string[][] = [];
    const props = () => ({
      label: 'Omitted tools (never pruned)',
      selected,
      catalog,
      category: 'tool' as const,
      onChange: (next: string[]) => calls.push(next),
    });
    act(() => render(h(AlwaysKeepPicker, props()), container));
    const add = (name: string) => {
      const select = container.querySelector<HTMLSelectElement>('select.toolbar-settings-keep-select');
      assert.ok(select, `select exists while adding ${name}`);
      act(() => {
        select!.value = name;
        select!.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };
    return {
      container,
      calls,
      echo: (next) => act(() => render(h(AlwaysKeepPicker, { ...props(), selected: next }), container)),
      add,
      remove: (name: string) => act(() => {
        const button = [...container.querySelectorAll<HTMLButtonElement>('.toolbar-settings-keep-chip-remove')]
          .find((candidate) => candidate.getAttribute('aria-label') === `Remove ${name}`);
        assert.ok(button, `remove button for ${name} exists`);
        button!.click();
      }),
      chips: () => [...container.querySelectorAll('.toolbar-settings-keep-chip > span')].map((chip) => chip.textContent),
      options: () => [...container.querySelectorAll<HTMLSelectElement>('select.toolbar-settings-keep-select option')]
        .map((option) => (option as unknown as HTMLSelectElement).value).filter((value) => value !== ''),
      unmount: () => {
        act(() => render(null, container));
        container.remove();
      },
    };
  }

  it('preserves a rapid add burst across delayed echoes', () => {
    const ui = mount([]);
    try {
      ui.add('bash');
      ui.add('edit');
      assert.deepEqual(ui.calls, [['bash'], ['bash', 'edit']], 'each edit emits its full intended selection');
      assert.deepEqual(ui.chips(), ['bash', 'edit']);
      assert.deepEqual(ui.options(), ['read', 'subagent'], 'just-added names leave the catalog immediately');
      // Echo of the first commit arrives while the second is still unconfirmed.
      ui.echo(['bash']);
      assert.deepEqual(ui.calls, [['bash'], ['bash', 'edit']]);
      assert.deepEqual(ui.chips(), ['bash', 'edit'], 'a newer local intent keeps leading');
      ui.echo(['bash', 'edit']);
      assert.deepEqual(ui.chips(), ['bash', 'edit'], 'converged on the echoed selection');
    } finally {
      ui.unmount();
    }
  });

  it('preserves a rapid remove burst across delayed echoes', () => {
    const ui = mount(['bash', 'edit', 'read']);
    try {
      ui.remove('bash');
      ui.remove('edit');
      assert.deepEqual(ui.calls, [['edit', 'read'], ['read']], 'removals accumulate on the intent');
      assert.deepEqual(ui.chips(), ['read']);
      ui.echo(['edit', 'read']);
      assert.deepEqual(ui.chips(), ['read'], 'intermediate echo does not resurrect the intent');
      ui.echo(['read']);
      assert.deepEqual(ui.chips(), ['read'], 'converged');
      assert.deepEqual(ui.options(), ['bash', 'edit', 'subagent']);
    } finally {
      ui.unmount();
    }
  });

  it('keeps add→remove pairs coherent before any echo', () => {
    const ui = mount(['read']);
    try {
      ui.add('bash');
      ui.remove('bash');
      ui.add('subagent');
      assert.deepEqual(ui.calls, [['read', 'bash'], ['read'], ['read', 'subagent']]);
      assert.deepEqual(ui.chips(), ['read', 'subagent']);
      ui.echo(['read', 'subagent']);
      assert.deepEqual(ui.chips(), ['read', 'subagent']);
    } finally {
      ui.unmount();
    }
  });

  it('guards duplicate adds against the optimistic intent', () => {
    const ui = mount([]);
    try {
      ui.add('bash');
      act(() => {
        const select = ui.container.querySelector<HTMLSelectElement>('select.toolbar-settings-keep-select')!;
        select.value = 'bash'; // value smuggled in even though the option is filtered
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      assert.equal(ui.calls.length, 1, 'no duplicate emit');
      assert.deepEqual(ui.chips(), ['bash']);
    } finally {
      ui.unmount();
    }
  });

  it('projects an external echo that matches no local edit and keeps no-op edits silent', () => {
    const ui = mount([]);
    try {
      ui.add('bash');
      assert.deepEqual(ui.calls, [['bash']]);
      ui.echo(['read']); // authoritative external value — matches no commit
      assert.deepEqual(ui.chips(), ['read'], 'host truth is projected');
      assert.deepEqual(ui.options(), ['bash', 'edit', 'subagent']);
      ui.echo(['read']);
      assert.deepEqual(ui.chips(), ['read'], 'stable');
    } finally {
      ui.unmount();
    }
  });

  it('unmounts cleanly with an unconfirmed echo pending', () => {
    const ui = mount([]);
    ui.add('bash');
    ui.unmount(); // no throw, no cleanup work needed beyond Preact teardown
  });
});

describe('reconcileSelectionEcho', () => {
  it('confirms the whole queue when the echo equals the newest emitted selection', () => {
    assert.deepEqual(reconcileSelectionEcho([['a'], ['a', 'b']], ['a', 'b']), []);
  });

  it('shifts one commit when the echo equals the oldest emitted selection', () => {
    assert.deepEqual(reconcileSelectionEcho([['a'], ['a', 'b']], ['a']), [['a', 'b']]);
  });

  it('clears the queue on an unrelated authoritative echo', () => {
    assert.deepEqual(reconcileSelectionEcho([['a'], ['a', 'b']], ['c']), []);
  });

  it('leaves an empty queue untouched', () => {
    const queue: string[][] = [];
    assert.equal(reconcileSelectionEcho(queue, ['a']), queue);
  });

  it('compares selections element-wise in order', () => {
    assert.equal(sameSelection(['a', 'b'], ['a', 'b']), true);
    assert.equal(sameSelection(['a', 'b'], ['b', 'a']), false);
    assert.equal(sameSelection(['a'], ['a', 'a']), false);
  });
});
