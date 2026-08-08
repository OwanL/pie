import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { h } from 'preact';
import renderToString from 'preact-render-to-string';

import { FileChangesPanel, FileChangeContextMenu, computeDiffTotals } from '../../../src/webview/panel/file-changes-panel';
import type { FileChangeEntry } from '../../../src/shared/protocol';

function entry(path: string, additions: number, deletions: number, kind: FileChangeEntry['kind'] = 'modified'): FileChangeEntry {
  return {
    path,
    kind,
    additions,
    deletions,
    toolCallId: 'tc',
    messageId: 'm',
    description: '',
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// computeDiffTotals — pure helper driving the aggregate header + diff bars.
// ---------------------------------------------------------------------------

test('computeDiffTotals sums additions/deletions', () => {
  assert.deepEqual(computeDiffTotals([]), { additions: 0, deletions: 0 });
  assert.deepEqual(computeDiffTotals([entry('a', 20, 5), entry('b', 10, 7)]), {
    additions: 30,
    deletions: 12,
  });
});

test('computeDiffTotals treats missing line stats as zero', () => {
  const noStats: FileChangeEntry = {
    path: 'c',
    kind: 'created',
    toolCallId: 'tc',
    messageId: 'm',
    description: '',
    timestamp: '2026-01-01T00:00:00.000Z',
    // additions/deletions omitted
  };
  assert.deepEqual(computeDiffTotals([noStats, entry('d', 4, 1)]), {
    additions: 4,
    deletions: 1,
  });
});

// ---------------------------------------------------------------------------
// FileChangesPanel — SSR render safety + markup contract.
// (Interactive state — hover-peek timers, click-outside, drag — is
// webview-local and effect-driven, so it is not exercised by SSR; the initial
// render path must stay side-effect-free.)
// ---------------------------------------------------------------------------

const noop = () => undefined;

test('FileChangesPanel collapsed: renders sliver + aggregate header (SSR-safe)', () => {
  const html = renderToString(
    h(FileChangesPanel, {
      fileChanges: [entry('src/a.ts', 20, 5), entry('src/b.ts', 10, 7)],
      expanded: false,
      onToggleExpanded: noop,
      onOpenDiff: noop,
      onOpenInEditor: noop,
      onRevertFile: noop,
      readFilePaths: [],
      onSetFileRead: noop,
    }),
  );
  // Collapsed sliver carries the count.
  assert.match(html, /class="file-changes-sliver"/);
  assert.match(html, /<span class="file-changes-sliver-count">2<\/span>/);
  // Aggregate header: count + totals. ASCII hyphen matches the per-row
  // LineStats (no U+2212 inconsistency).
  assert.match(html, /2 files/);
  assert.match(html, /\+30/);
  assert.match(html, /-12/);
  assert.doesNotMatch(html, /−/);
  // Collapsed sliver carries the count and total +/- magnitude (how much
  // changed at a glance). Kind is encoded by coloring each per-file name —
  // no dot/bar legend. Both entries are modified.
  assert.match(html, /file-changes-sliver-magnitude/);
  assert.match(html, /sliver-add">\+30/);
  assert.match(html, /sliver-del">-12/);
  assert.doesNotMatch(html, /sliver-kind/);
  assert.doesNotMatch(html, /sliver-kind-dot/);
  assert.doesNotMatch(html, /sliver-kind-glyph/);
  // The collapsed sliver also lists the affected files, two rows each: row 1
  // is the kind-colored truncated basename; row 2 is the per-file +/- churn,
  // so the tall sliver surfaces per-file magnitude at a glance. Each entry's
  // outer span carries the full path + kind label as a hover title.
  assert.match(html, /file-changes-sliver-files/);
  assert.match(html, /sliver-file kind-modified/);
  assert.doesNotMatch(html, /sliver-file-dot/);
  assert.doesNotMatch(html, /sliver-file-glyph/);
  assert.match(html, /sliver-file-name">src\/a.ts/);
  assert.match(html, /sliver-file-name">src\/b.ts/);
  assert.match(html, /sliver-file-stats/);
  assert.match(html, /sliver-file-add">\+20/);
  assert.match(html, /sliver-file-del">-5/);
  assert.match(html, /sliver-file-add">\+10/);
  assert.match(html, /sliver-file-del">-7/);
  // The per-kind legend is gone entirely (each per-file name is colored).
  assert.doesNotMatch(html, /sliver-kind/);
  // The per-row red/green diff bar is gone (space reclaimed for the path).
  assert.doesNotMatch(html, /file-change-diff-bar/);
  // Sliver title carries the full summary: count + kind breakdown + line totals.
  assert.match(html, /title="2 changed files · 2 modified · \+30 \/ -12"/);
  // Drawer rows have no A/M/D status labels and no sliding action buttons.
  assert.doesNotMatch(html, /file-change-status/);
  assert.doesNotMatch(html, /file-change-actions/);
  assert.doesNotMatch(html, /file-change-diff/);
  assert.doesNotMatch(html, /file-change-open/);
  // The full path (dir + basename) is the open-in-editor hitbox: the
  // path-text button carries the kind-labeled aria-label, and the basename
  // rides in a name span (colored by kind).
  assert.match(html, /<button class="file-change-path-text"[^>]*aria-label="Modified: open src\/a\.ts in the editor"/);
  assert.match(html, /<button class="file-change-path-text"[^>]*aria-label="Modified: open src\/b\.ts in the editor"/);
  assert.match(html, /<span class="file-change-name">a\.ts</);
  assert.match(html, /<span class="file-change-name">b\.ts</);
  // A native title hint rides on both buttons (path → open file; stats → diff).
  assert.match(html, /<button class="file-change-path-text"[^>]*title="Open src\/a\.ts in the editor"/);
  assert.match(html, /<button class="file-change-path-text"[^>]*title="Open src\/b\.ts in the editor"/);
  // ...and the +/- stats open the diff.
  assert.match(html, /<button class="file-change-stats"[^>]*aria-label="View diff of src\/a\.ts"/);
  assert.match(html, /<button class="file-change-stats"[^>]*aria-label="View diff of src\/b\.ts"/);
  assert.match(html, /<button class="file-change-stats"[^>]*title="Open diff: src\/a\.ts"/);
  assert.match(html, /<button class="file-change-stats"[^>]*title="Open diff: src\/b\.ts"/);
  // Copy path + Revert remain in the right-click context menu only.
  assert.doesNotMatch(html, /file-change-copy/);
  assert.doesNotMatch(html, /file-change-revert/);
});

test('FileChangesPanel collapsed: per-file list colors one entry per kind', () => {
  const html = renderToString(
    h(FileChangesPanel, {
      fileChanges: [
        entry('a.ts', 5, 0, 'created'),
        entry('b.ts', 2, 0, 'created'),
        entry('c.ts', 3, 1, 'modified'),
        entry('d.ts', 0, 4, 'deleted'),
      ],
      expanded: false,
      onToggleExpanded: noop,
      onOpenDiff: noop,
      onOpenInEditor: noop,
      onRevertFile: noop,
      readFilePaths: [],
      onSetFileRead: noop,
    }),
  );
  // 2 added · 1 modified · 1 deleted — the per-file list renders one colored
  // entry per kind (name text colored via `kind-*`); no dot/bar legend remains.
  assert.match(html, /sliver-file kind-created/);
  assert.match(html, /sliver-file kind-modified/);
  assert.match(html, /sliver-file kind-deleted/);
  assert.doesNotMatch(html, /sliver-kind/);
  assert.doesNotMatch(html, /sliver-file-dot/);
  // Count at the top is the file total (4), not a per-kind value.
  assert.match(html, /<span class="file-changes-sliver-count">4<\/span>/);
  // Collapsed file list renders one entry per file (4 here), each with a
  // second row of per-file +/- churn (a.ts created → +5; d.ts deleted → -4).
  assert.match(html, /file-changes-sliver-files/);
  assert.match(html, /sliver-file-name">a.ts/);
  assert.match(html, /sliver-file-add">\+5/);
  assert.match(html, /sliver-file-del">-4/);
});

test('FileChangesPanel pinned: renders right resize handle + close, no sliver', () => {
  const html = renderToString(
    h(FileChangesPanel, {
      fileChanges: [entry('src/a.ts', 1, 0)],
      expanded: true,
      onToggleExpanded: noop,
      onOpenDiff: noop,
      onOpenInEditor: noop,
      onRevertFile: noop,
      readFilePaths: [],
      onSetFileRead: noop,
    }),
  );
  // Pinned: the sliver is not rendered (the drawer header carries unpin).
  assert.doesNotMatch(html, /file-changes-sliver/);
  // Right-edge resize handle present (drag-right = wider; the rail docks left,
  // so the transcript-facing edge is its right edge).
  assert.match(html, /class="resize-handle resize-handle-right"/);
  // Close (unpin) affordance present.
  assert.match(html, /file-changes-close/);
  // Tooltips were removed from the expanded drawer (they obscured the list):
  // neither the path nor the aggregate header is wrapped in a tooltip trigger.
  // (Native HTML title attributes remain on the row buttons for hover hints.)
  assert.doesNotMatch(html, /pie-tooltip-trigger/);
  // Native title hints on the single pinned file's row buttons.
  assert.match(html, /<button class="file-change-path-text"[^>]*title="Open src\/a\.ts in the editor"/);
  assert.match(html, /<span class="file-change-name">a\.ts</);
  assert.match(html, /<button class="file-change-stats"[^>]*title="Open diff: src\/a\.ts"/);
});

test('FileChangesPanel pinned: deleted row is disabled with a Deleted title', () => {
  const html = renderToString(
    h(FileChangesPanel, {
      fileChanges: [entry('gone.ts', 0, 4, 'deleted')],
      expanded: true,
      onToggleExpanded: noop,
      onOpenDiff: noop,
      onOpenInEditor: noop,
      onRevertFile: noop,
      readFilePaths: [],
      onSetFileRead: noop,
    }),
  );
  // Deleted files can't be opened: the path button is disabled and titled
  // "Deleted — <path>" (not the open-file hint), while the stats still open
  // the diff. Covers the disabled branch of the native-title affordance.
  assert.match(html, /<button class="file-change-path-text"[^>]*disabled/);
  assert.match(html, /<button class="file-change-path-text"[^>]*title="Deleted — gone\.ts"/);
  assert.match(html, /<span class="file-change-name">gone\.ts</);
  assert.match(html, /<button class="file-change-stats"[^>]*title="Open diff: gone\.ts"/);
  assert.doesNotMatch(html, /title="Open gone\.ts in the editor"/);
});

test('FileChangesPanel renders nothing when there are no file changes', () => {
  const html = renderToString(
    h(FileChangesPanel, {
      fileChanges: [],
      expanded: false,
      onToggleExpanded: noop,
      onOpenDiff: noop,
      onOpenInEditor: noop,
      onRevertFile: noop,
      readFilePaths: [],
      onSetFileRead: noop,
    }),
  );
  assert.equal(html, '');
});

// ---------------------------------------------------------------------------
// Read / unread behaviour: read files sort to the bottom, render darkened
// (is-read), are separated from the unread group by a "Reviewed" divider, and
// the collapsed sliver darkens them in place. The right-click menu labels its
// mark-read action by the captured read state.
// ---------------------------------------------------------------------------

test('FileChangesPanel pinned: read files sort to the bottom and render darkened', () => {
  const html = renderToString(
    h(FileChangesPanel, {
      fileChanges: [
        entry('src/a.ts', 1, 0), // unread
        entry('src/b.ts', 2, 0), // read
        entry('src/c.ts', 3, 0), // unread
      ],
      expanded: true,
      onToggleExpanded: noop,
      onOpenDiff: noop,
      onOpenInEditor: noop,
      onRevertFile: noop,
      readFilePaths: ['src/b.ts'],
      onSetFileRead: noop,
    }),
  );
  // Exactly one read row, carrying the darkened `is-read` class.
  assert.match(html, /file-change-item kind-modified is-read/);
  const isReadCount = (html.match(/file-change-item kind-modified is-read/g) ?? []).length;
  assert.equal(isReadCount, 1);
  // b.ts (read) is demoted below the Reviewed divider, after the unread c.ts.
  const divider = html.indexOf('file-change-group-divider');
  const bIdx = html.indexOf('Open src/b.ts in the editor');
  const cIdx = html.indexOf('Open src/c.ts in the editor');
  assert.notEqual(divider, -1, 'group divider present');
  assert.ok(cIdx < divider, 'unread c.ts renders above the divider');
  assert.ok(divider < bIdx, 'read b.ts renders below the divider');
});

test('FileChangesPanel pinned: no Reviewed divider when there are no read files', () => {
  const html = renderToString(
    h(FileChangesPanel, {
      fileChanges: [entry('src/a.ts', 1, 0), entry('src/b.ts', 2, 0)],
      expanded: true,
      onToggleExpanded: noop,
      onOpenDiff: noop,
      onOpenInEditor: noop,
      onRevertFile: noop,
      readFilePaths: [],
      onSetFileRead: noop,
    }),
  );
  assert.doesNotMatch(html, /file-change-group-divider/);
  assert.doesNotMatch(html, /file-change-item kind-modified is-read/);
});

test('FileChangesPanel pinned: all-read list has no divider but darkens every row', () => {
  // When every file is read, the unread group is empty -> no divider (the
  // divider only separates two non-empty groups), but each row is darkened.
  const html = renderToString(
    h(FileChangesPanel, {
      fileChanges: [entry('a.ts', 1, 0), entry('b.ts', 2, 0)],
      expanded: true,
      onToggleExpanded: noop,
      onOpenDiff: noop,
      onOpenInEditor: noop,
      onRevertFile: noop,
      readFilePaths: ['a.ts', 'b.ts'],
      onSetFileRead: noop,
    }),
  );
  assert.doesNotMatch(html, /file-change-group-divider/);
  const isReadCount = (html.match(/file-change-item kind-modified is-read/g) ?? []).length;
  assert.equal(isReadCount, 2);
});

test('FileChangesPanel collapsed sliver: read entries are darkened in place', () => {
  const html = renderToString(
    h(FileChangesPanel, {
      fileChanges: [entry('a.ts', 5, 0, 'created'), entry('b.ts', 2, 0, 'created')],
      expanded: false,
      onToggleExpanded: noop,
      onOpenDiff: noop,
      onOpenInEditor: noop,
      onRevertFile: noop,
      readFilePaths: ['b.ts'],
      onSetFileRead: noop,
    }),
  );
  // b.ts (read) carries is-read; a.ts does not. Exactly one darkened entry.
  assert.match(html, /sliver-file kind-created is-read/);
  const isReadCount = (html.match(/sliver-file kind-created is-read/g) ?? []).length;
  assert.equal(isReadCount, 1);
  // The sliver keeps derivation order (a.ts before b.ts) — read entries are
  // darkened, not reordered, in the narrow preview.
  assert.ok(html.indexOf('a.ts') < html.indexOf('b.ts'));
});

test('FileChangeContextMenu: labels the mark-read action by captured read state', () => {
  const baseMenu = { x: 10, y: 10, path: 'src/a.ts', kind: 'modified' as const };
  const readHtml = renderToString(
    h(FileChangeContextMenu, {
      menu: { ...baseMenu, read: true },
      onRevert: noop,
      onSetFileRead: noop,
      onClose: noop,
    }),
  );
  const unreadHtml = renderToString(
    h(FileChangeContextMenu, {
      menu: { ...baseMenu, read: false },
      onRevert: noop,
      onSetFileRead: noop,
      onClose: noop,
    }),
  );
  // A read file offers "Mark as unread"; an unread file offers "Mark as read".
  assert.match(readHtml, /Mark as unread/);
  assert.doesNotMatch(readHtml, /Mark as read/);
  assert.match(unreadHtml, /Mark as read/);
  assert.doesNotMatch(unreadHtml, /Mark as unread/);
});

// ---------------------------------------------------------------------------
// Scroll behaviour when packed with many files (regression guard).
// Both the collapsed sliver preview (.file-changes-sliver-files) and the
// pinned/peek drawer list (.file-changes-list) must scroll, and their rows
// must NOT be collapsed by flex-shrink. Root cause: each row carries
// `overflow: hidden`, which zeroes its automatic min-height; without
// `flex-shrink: 0` the flex-column scroll container shrinks the rows to fit
// instead of overflowing into a scroll — the sliver didn't scroll at all (it
// clipped with a fade), and the drawer scrolled but its rows shrank below
// their line height, clipping the path/stats text vertically.
// ---------------------------------------------------------------------------

async function readFileChangesCss() {
  return readFile(new URL('../../../src/webview/panel/styles/file-changes.css', import.meta.url), 'utf8');
}

/** Pull the first CSS rule whose selector starts with `sel` (exact, so
 * `.foo` won't match `.foo:hover` / `.foo-bar`). */
function rule(css: string, sel: string): string | undefined {
  const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`${escaped}\\s*\\{[\\s\\S]*?\\n\\}`));
  return m ? m[0] : undefined;
}

test('changed-file rows are flex-shrink:0 so a packed list scrolls instead of collapsing', async () => {
  const css = await readFileChangesCss();

  // Drawer rows keep their content height so the scrollable list overflows and
  // scrolls (without this they shrank below the line height and clipped text).
  const itemRule = rule(css, '.file-change-item');
  assert.ok(itemRule, 'expected .file-change-item rule in file-changes.css');
  assert.match(itemRule, /flex-shrink:\s*0;/);

  // Sliver preview rows: same fix — without it the sliver's rows shrank to fit
  // the box and the preview never overflowed (no scroll, just a fade clip).
  const sliverFileRule = rule(css, '.sliver-file');
  assert.ok(sliverFileRule, 'expected .sliver-file rule in file-changes.css');
  assert.match(sliverFileRule, /flex-shrink:\s*0;/);
});

test('collapsed sliver preview scrolls (overflow-y:auto) and drops the static fade mask', async () => {
  const css = await readFileChangesCss();
  const filesRule = rule(css, '.file-changes-sliver-files');
  assert.ok(filesRule, 'expected .file-changes-sliver-files rule in file-changes.css');
  assert.match(filesRule, /overflow-y:\s*auto;/);
  assert.match(filesRule, /overscroll-behavior:\s*contain;/);
  // The fade mask is gone: a static mask would permanently dim the last file
  // once scrolled to the bottom, and the scrollbar now signals "more below".
  assert.doesNotMatch(filesRule, /mask-image:/);
});

test('drawer list keeps a stable scrollbar gutter and scrolls when packed', async () => {
  const css = await readFileChangesCss();
  const listRule = rule(css, '.file-changes-list');
  assert.ok(listRule, 'expected .file-changes-list rule in file-changes.css');
  assert.match(listRule, /overflow-y:\s*auto;/);
  assert.match(listRule, /overscroll-behavior:\s*contain;/);
  // Stable gutter so rows don't reflow horizontally as files stream in mid-run
  // and the scrollbar appears/disappears across the scroll threshold.
  assert.match(listRule, /scrollbar-gutter:\s*stable;/);
});
