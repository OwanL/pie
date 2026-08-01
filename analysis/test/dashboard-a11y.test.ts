import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const HTML_URL = new URL('../site/index.html', import.meta.url);

async function readHtml(): Promise<string> {
  return readFile(HTML_URL, 'utf8');
}

test('the page exposes a skip link to the main landmark', async () => {
  const html = await readHtml();
  assert.match(html, /class="skip-link"[^>]*href="#main"/);
  assert.match(html, /<main id="main">/);
});

test('the header is a banner and filters are a nav landmark', async () => {
  const html = await readHtml();
  assert.match(html, /role="banner"/);
  assert.match(html, /<nav class="filters"[^>]*aria-label/);
});

test('exactly one filter toggle remains (collapsibles use native details)', async () => {
  const html = await readHtml();
  assert.equal((html.match(/class="toggle"/g) ?? []).length, 1);
});

test('the model-choice section keeps the established sparse-evidence framing', async () => {
  const html = await readHtml();
  assert.match(html, /Sparse review evidence and overlapping rank intervals/);
});

test('the new insight, outcomes, and reliability containers are present', async () => {
  const html = await readHtml();
  assert.match(html, /id="actionability-insights"/);
  assert.match(html, /id="evidence-reliability-banner"/);
  assert.match(html, /id="leaderboard-cards"/);
  assert.match(html, /id="chart-quality-vs-cost"/);
  for (const dim of ['verificationUsage', 'compaction', 'thinkingLevel', 'promptSizeBand', 'pruningMode', 'subagentParentModel']) {
    assert.match(html, new RegExp(`id="chart-outcome-${dim}"`));
    assert.match(html, new RegExp(`id="outcome-${dim}-note"`));
  }
});

test('secondary telemetry and ingestion live behind collapsible diagnostics details', async () => {
  const html = await readHtml();
  assert.ok((html.match(/<details class="diagnostic-block"/g) ?? []).length >= 3, 'expected at least three diagnostic details blocks');
  // Review ingestion diagnostics remain present (not deleted), just relocated.
  assert.match(html, /id="session-review-analytics"/);
});

test('chart slots carry accessible role/aria-label landmarks', async () => {
  const html = await readHtml();
  assert.match(html, /role="img"[^>]*aria-label/);
  assert.match(html, /aria-labelledby="insights-heading"/);
  assert.match(html, /aria-labelledby="outcomes-heading"/);
});

test('a sticky section-nav provides jump links to every major page section', async () => {
  const html = await readHtml();
  assert.match(html, /<nav class="section-nav"[^>]*aria-label="Page sections"/);
  assert.match(html, /class="section-nav"[^>]*\bid="section-nav"/);
  // Extract the section-nav block and resolve every jump link to a real target id.
  const sectionNavBlock = html.split(/<nav class="section-nav"/)[1]!.split(/<\/nav>/)[0]!;
  const navTargets = [...sectionNavBlock.matchAll(/<a href="#([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(navTargets.length >= 6, 'section-nav should link to the major sections');
  for (const target of navTargets) {
    assert.ok(new RegExp(`id="${target}"`).test(html), `section-nav target #${target} must exist in the page`);
  }
  // Diagnostic details blocks are jump-link targets (auto-opened on jump in app.ts).
  for (const id of ['diagnostics-runtime', 'diagnostics-pruning', 'diagnostics-reviews']) {
    assert.match(html, new RegExp(`<details class="diagnostic-block" id="${id}">`));
  }
});

test('filters use an accessible collapsible details on mobile while preserving every control and landmark', async () => {
  const html = await readHtml();
  // The filters nav landmark is retained.
  assert.match(html, /<nav class="filters"[^>]*aria-label="Cohort filters"/);
  // The filter form and all controls survive inside a native <details>.
  assert.match(html, /<details class="filters-panel" id="filters-panel">/);
  assert.match(html, /<summary class="filters-summary">/);
  assert.match(html, /<form id="filters" class="filters-grid">/);
  for (const id of ['filter-start', 'filter-end', 'filter-model', 'filter-thinking', 'filter-experiment', 'filter-subagent-parent', 'filter-pruning-mode', 'filter-pure-only', 'filter-reset']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  // The active-filter count badge (surfaced when collapsed on mobile) is present.
  assert.match(html, /id="filters-active-count"[^>]*aria-live="polite"/);
});
