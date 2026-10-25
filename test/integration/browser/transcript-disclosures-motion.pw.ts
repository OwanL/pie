// Bounded real-renderer regressions; no SDK, provider, ambient session or screenshots.
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './ui-smoke-fixtures.js';
import { EMPTY_VIEW_STATE } from '../../../application/frontend/lib/hooks/use-host-sync.js';
import type { ChatMessage, ToolCall, ViewState } from '../../../application/lib/protocol/index.js';

const date = '2026-10-26T12:00:00Z';
const lines = (prefix: string, count = 18) => Array.from({ length: count }, (_, i) => `${prefix} ${i}: independent synthetic explanation.`).join('\n\n');
const reasoning = lines('Reasoning paragraph');
const bash: ToolCall = { id: 'bash', name: 'bash', seq: 0, status: 'running', input: { command: 'printf synthetic' }, result: 'Initial output' };
const child = { agent: 'scout', task: 'Inspect synthetic layout', model: 'fixture/model', exitCode: 0,
  activityPhase: 'completed', messages: [{ role: 'assistant', content: 'Nested initial response.' }] };
const subagent: ToolCall = { id: 'subagent', name: 'subagent', seq: 0, status: 'running',
  input: { agent: 'scout', task: child.task }, result: { mode: 'single', results: [child] } };
function message(id: string, markdown: string): ChatMessage {
  return { id, role: 'assistant', createdAt: date, status: 'completed', markdown };
}
function state(kind: 'reasoning' | 'tool' | 'code' | 'image' | 'compaction', tool = bash, text = reasoning): Partial<ViewState> {
  const main = message('target', '');
  if (kind === 'reasoning') main.parts = [{ kind: 'reasoning', text }];
  if (kind === 'tool') { main.parts = [{ kind: 'toolCall', toolCall: tool }]; main.toolCalls = [tool]; main.status = 'streaming'; }
  if (kind === 'code') main.markdown = '```text\n' + Array.from({ length: 45 }, (_, i) => `Code row ${i}`).join('\n') + '\n```';
  if (kind === 'image') main.markdown = '![Synthetic inline raster](synthetic-motion.png)\n\nIMAGE INTERNAL TRAILING MARKER';
  if (kind === 'compaction') { main.customType = 'compaction-summary'; main.markdown = reasoning; }
  const transcript: ChatMessage[] = [
    { ...message('user', 'Inspect these disclosures.'), role: 'user' },
    message('lead', lines('Leading context', 30)), main,
    message('tail', 'STABLE TRAILING MARKER\n\n' + lines('Stable tail', 4)),
  ];
  const session = { path: 'synthetic-motion-session', name: 'Disclosure motion', cwd: '.', modifiedAt: date, messageCount: transcript.length };
  return { activeSession: session, sessions: [session], openTabPaths: [session.path], busy: kind === 'tool', transcript, transcriptWindow: { ...EMPTY_VIEW_STATE.transcriptWindow,
    totalCount: transcript.length, loadedEnd: transcript.length, hasUserMessages: true } };
}
const owners = '[data-height-moving], [data-preview-moving], .collapsible-body-wrap, .tool-call-body-wrap, .inline-markdown-image, .code-block, .tool-call-preview-space';
async function open(page: Page) {
  await page.setViewportSize({ width: 550, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args: Parameters<typeof animate>) {
      const animation = animate.apply(this, args);
      if (this.matches('[data-height-moving], [data-preview-moving], .collapsible-body-wrap, .tool-call-body-wrap, .inline-markdown-image, .code-block, .tool-call-preview-space')) {
        animation.pause(); animation.currentTime = 0;
      }
      return animation;
    };
  });
  await page.goto('/');
  await expect(page.locator('.transcript-virtual')).not.toHaveClass(/transcript-positioning/);
  await page.evaluate(() => document.fonts.ready);
}
async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function finish(page: Page) {
  for (let i = 0; i < 5; i++) {
    const count = await page.locator(owners).evaluateAll(elements => {
      const animations = elements.flatMap(el => el.getAnimations()).filter(a => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition));
      animations.forEach(a => a.finish()); return animations.length;
    });
    await frames(page);
    if (!count) break;
  }
}
async function measure(page: Page, owner: Locator, marker = 'STABLE TRAILING MARKER') {
  const height = await owner.count() ? await owner.evaluate(el => el.getBoundingClientRect().height) : 0;
  const sibling = await page.getByText(marker, { exact: true }).evaluate(el =>
    el.getBoundingClientRect().top + document.querySelector('.transcript-virtual')!.scrollTop);
  return { height, sibling };
}
async function midpoint(owner: Locator) {
  await expect.poll(() => owner.evaluate(el => el.getAnimations().length)).toBeGreaterThan(0);
  await owner.evaluate(el => el.getAnimations().forEach(a => { a.currentTime = Number(a.effect!.getTiming().duration) / 2; }));
  await frames(owner.page()); // Virtual rows batch their ResizeObserver measurements.
}
async function interpolates(page: Page, owner: Locator, before: { height: number; sibling: number }, marker?: string) {
  const first = await measure(page, owner, marker);
  expect(Math.abs(first.sibling - before.sibling), 'no first-frame sibling displacement').toBeLessThanOrEqual(2);
  expect(Math.abs(first.height - before.height)).toBeLessThanOrEqual(2);
  await midpoint(owner);
  const mid = await measure(page, owner, marker);
  await finish(page);
  const end = await measure(page, owner, marker);
  expect(mid.height).toBeGreaterThan(Math.min(before.height, end.height) + 1);
  expect(mid.height).toBeLessThan(Math.max(before.height, end.height) - 1);
  expect(mid.sibling).toBeGreaterThan(Math.min(before.sibling, end.sibling) + 1);
  expect(mid.sibling).toBeLessThan(Math.max(before.sibling, end.sibling) - 1);
}
const toggle = (page: Page, kind: 'reasoning' | 'subagent') => page.getByRole('button', {
  name: kind === 'reasoning' ? 'Toggle reasoning details' : 'Toggle scout subagent', exact: true,
});
const wrap = (page: Page, kind: 'reasoning' | 'subagent') => page.locator(kind === 'reasoning'
  ? '.reasoning-block .collapsible-body-wrap' : '.tool-call-subagent .collapsible-body-wrap').first();

test('reasoning retains rendered HTML during closing and interpolates occupied space', async ({ page, isolatedHost }) => {
  isolatedHost.publishState(state('reasoning')); await open(page);
  const button = toggle(page, 'reasoning'), body = wrap(page, 'reasoning');
  const before = await measure(page, body);
  await button.evaluate((el: HTMLElement) => el.click());
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(body).toHaveAttribute('data-height-moving', 'true');
  await interpolates(page, body, before);
  const html = await body.locator('.reasoning-scroll').innerHTML(), expanded = await measure(page, body);
  await button.evaluate((el: HTMLElement) => el.click());
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(body).toHaveAttribute('data-height-moving', 'true');
  expect(await body.locator('.reasoning-scroll').innerHTML()).toBe(html);
  await expect(body).toHaveAttribute('aria-hidden', 'true');
  await interpolates(page, body, expanded);
  expect((await measure(page, body)).height).toBe(0);
});

for (const kind of ['reasoning', 'subagent'] as const) {
  test(`${kind}: mouse and role keyboard detach bottom-follow and preserve the reading header`, async ({ page, isolatedHost }) => {
    isolatedHost.publishState(state(kind === 'reasoning' ? 'reasoning' : 'tool', subagent)); await open(page);
    const button = toggle(page, kind), body = wrap(page, kind);
    for (const input of ['mouse', 'keyboard'] as const) {
      const scroll = page.locator('.transcript-virtual');
      await scroll.hover(); await page.mouse.wheel(0, 100000); await frames(page);
      // Focus without Playwright actionability scrolling; all subsequent samples
      // use actual viewport header geometry, not content coordinates.
      await button.evaluate((el: HTMLElement) => el.focus({ preventScroll: true }));
      const top = await button.evaluate(el => el.getBoundingClientRect().top);
      if (input === 'mouse') await button.evaluate((el: HTMLElement) => el.click());
      else await page.keyboard.press('Enter');
      await expect(button).toHaveAttribute('aria-expanded', 'true');
      await expect(body).toHaveAttribute('data-height-moving', 'true');
      for (const fraction of [0, .25, .5, .75]) {
        await body.evaluate((el, fraction) => el.getAnimations().forEach(a => { a.currentTime = Number(a.effect!.getTiming().duration) * fraction; }), fraction);
        await frames(page);
        expect(Math.abs(await button.evaluate(el => el.getBoundingClientRect().top) - top)).toBeLessThanOrEqual(2);
      }
      await finish(page);
      expect(Math.abs(await button.evaluate(el => el.getBoundingClientRect().top) - top)).toBeLessThanOrEqual(2);
      expect(await scroll.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(20);
      await button.evaluate((el: HTMLElement) => el.click()); await finish(page);
    }
  });
}

test('expanded bash growth shows current result immediately while its occupied space moves', async ({ page, isolatedHost }) => {
  isolatedHost.publishState(state('tool')); await open(page);
  await page.locator('.tool-call-toggle').evaluate((el: HTMLElement) => el.click()); await finish(page);
  const body = page.locator('.tool-call-body-wrap').first(), before = await measure(page, body);
  isolatedHost.publishState(state('tool', { ...bash, seq: 1, result: lines('Growing output', 12) }));
  await expect(body).toContainText('Growing output 11');
  await expect(body).toHaveAttribute('data-height-moving', 'true');
  await interpolates(page, body, before);
});

test('targeted lazy detail response animates space without delaying result truth', async ({ page, isolatedHost }) => {
  let deliver: (() => void) | undefined;
  isolatedHost.onRequest((request, reply) => {
    if (request.type === 'requestDetail') deliver = () => reply({ type: 'detailResult', result: {
      sessionPath: request.ref.sessionPath, key: request.ref.key, status: 'loaded', value: lines('Lazy delivered output', 12), sizeBytes: 2000,
    } });
  });
  const lazy: ToolCall = { ...bash, status: 'completed', detailRef: { key: 'motion-detail', kind: 'tool-result', source: 'durable',
    sessionPath: 'synthetic-motion-session', messageId: 'target', toolCallId: bash.id, available: true, summary: 'Initial output', sizeBytes: 2000 } };
  isolatedHost.publishState(state('tool', lazy)); await open(page);
  await page.locator('.tool-call-toggle').evaluate((el: HTMLElement) => el.click()); await finish(page);
  await expect.poll(() => Boolean(deliver)).toBe(true);
  const body = page.locator('.tool-call-body-wrap').first(), before = await measure(page, body);
  deliver!();
  await expect(body).toContainText('Lazy delivered output 11');
  await expect(body).toHaveAttribute('data-height-moving', 'true');
  await interpolates(page, body, before);
});

test('open subagent nested hydration animates independently and reduced motion releases it', async ({ page, isolatedHost }) => {
  isolatedHost.publishState(state('tool', subagent)); await open(page);
  const button = toggle(page, 'subagent'), body = wrap(page, 'subagent');
  await button.evaluate((el: HTMLElement) => el.click()); await finish(page);
  const before = await measure(page, body);
  isolatedHost.publishState(state('tool', { ...subagent, seq: 1, result: { mode: 'single', results: [
    { ...child, messages: [{ role: 'assistant', content: lines('Hydrated nested paragraph', 12) }] },
  ] } }));
  await expect(body).toContainText('Hydrated nested paragraph 11');
  await expect(body).toHaveAttribute('data-height-moving', 'true');
  expect(Math.abs((await measure(page, body)).sibling - before.sibling)).toBeLessThanOrEqual(2);
  await midpoint(body);
  const mid = await measure(page, body);
  expect(mid.height).toBeGreaterThan(before.height);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('[data-height-moving], [data-preview-moving]')).toHaveCount(0);
  expect((await measure(page, body)).height).toBeGreaterThan(mid.height);
  const naturalError = () => body.evaluate(el => Math.abs(el.getBoundingClientRect().height - el.firstElementChild!.getBoundingClientRect().height));
  await expect.poll(naturalError).toBeLessThanOrEqual(1);
  isolatedHost.publishState(state('tool', { ...subagent, seq: 2, result: { mode: 'single', results: [
    { ...child, messages: [{ role: 'assistant', content: lines('Reduced hydration paragraph', 18) }] },
  ] } }));
  await expect(body).toContainText('Reduced hydration paragraph 17');
  await expect.poll(naturalError).toBeLessThanOrEqual(1);
  await expect(body).not.toHaveAttribute('data-height-moving', 'true');
  await page.reload(); await expect(button).toHaveAttribute('aria-expanded', 'false');
  expect(await page.locator(owners).evaluateAll(elements => elements.flatMap(el => el.getAnimations()).length)).toBe(0);
});

test('hydration while subagent opens does not reverse the combined preview and body space', async ({ page, isolatedHost }) => {
  isolatedHost.publishState(state('tool', subagent)); await open(page);
  const body = wrap(page, 'subagent'), card = page.locator('.tool-call-subagent');
  const preview = card.locator('.tool-call-preview-space');
  await toggle(page, 'subagent').evaluate((el: HTMLElement) => el.click());
  await expect(body).toHaveAttribute('data-height-moving', 'true');
  await expect(preview).toHaveAttribute('data-preview-moving', 'true');
  for (const owner of [body, preview]) await owner.evaluate(el => el.getAnimations().forEach(a => {
    a.currentTime = Number(a.effect!.getTiming().duration) * 0.75;
  }));
  await frames(page);
  const before = await measure(page, card);
  const destination = () => body.evaluate(el => Number.parseFloat(String(
    (el.getAnimations()[0]?.effect as KeyframeEffect)?.getKeyframes().at(-1)?.height ?? '0',
  )));
  const initialDestination = await destination();
  isolatedHost.publishState(state('tool', { ...subagent, seq: 1, result: { mode: 'single', results: [
    { ...child, messages: [{ role: 'assistant', content: lines('Opening hydration paragraph', 18) }] },
  ] } }));
  await expect(body).toContainText('Opening hydration paragraph 17');
  await expect.poll(destination).toBeGreaterThan(initialDestination);
  // One frame after retarget: the retiring preview must not outrun the growing
  // body when the new height motion starts, briefly pulling following text up.
  await preview.evaluate(el => el.getAnimations().forEach(a => { a.currentTime = Number(a.effect!.getTiming().duration) * 0.85; }));
  await body.evaluate(el => el.getAnimations().forEach(a => { a.currentTime = 20; }));
  await frames(page);
  const next = await measure(page, card);
  expect(next.height).toBeGreaterThanOrEqual(before.height - 0.5);
  expect(next.sibling).toBeGreaterThanOrEqual(before.sibling - 1);
  await finish(page);
});

test('code Show all reversals expose truthful ARIA and continue from rendered height', async ({ page, isolatedHost }) => {
  isolatedHost.publishState(state('code')); await open(page);
  const button = page.locator('.code-block-toggle'), body = page.locator('.code-block').first();
  expect(await body.evaluate(el => el.getAnimations().length)).toBe(0);
  const before = await measure(page, body);
  await button.evaluate((el: HTMLElement) => el.click());
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await midpoint(body); const mid = await measure(page, body);
  expect(mid.height).toBeGreaterThan(before.height);
  await button.evaluate((el: HTMLElement) => el.click());
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  expect(Math.abs((await measure(page, body)).height - mid.height)).toBeLessThanOrEqual(2);
  await midpoint(body);
  await button.evaluate((el: HTMLElement) => el.click());
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await finish(page);
  expect((await measure(page, body)).height).toBeGreaterThan(mid.height);
});

for (const [width, height] of [[640, 480], [300, 1800]] as const) {
  test(`inline image ${width}×${height} protocol decode preserves aspect and interpolates geometry`, async ({ page, isolatedHost }) => {
    let deliver: (() => void) | undefined;
    isolatedHost.onRequest((request, reply) => {
      if (request.type === 'requestImagePreview') deliver = () => reply({ type: 'imagePreviewResult',
        requestId: request.requestId, sessionPath: request.sessionPath, status: 'ready',
        data: { mimeType: 'image/png', dataUrl: raster },
      });
    });
    isolatedHost.publishState(state('image')); await open(page);
    const raster = await page.evaluate(({ width, height }) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      canvas.getContext('2d')!.fillRect(0, 0, width, height); return canvas.toDataURL('image/png');
    }, { width, height });
    const body = page.locator('.inline-markdown-image');
    await expect.poll(() => Boolean(deliver)).toBe(true);
    const before = await measure(page, body, 'IMAGE INTERNAL TRAILING MARKER'); deliver!();
    await expect(body.locator('img')).toHaveCount(1);
    expect(await body.locator('img').evaluate(async (img: HTMLImageElement) => { await img.decode(); return img.complete && img.naturalWidth > 0; })).toBe(true);
    const aspect = await body.locator('img').evaluate(el => {
      const box = el.getBoundingClientRect();
      return box.width / box.height;
    });
    expect(aspect).toBeCloseTo(width / height, 2);
    await expect(body).toHaveAttribute('data-height-moving', 'true');
    await interpolates(page, body, before, 'IMAGE INTERNAL TRAILING MARKER');
  });
}

test('compaction summary retains its full Markdown through a measured close', async ({ page, isolatedHost }) => {
  isolatedHost.publishState(state('compaction')); await open(page);
  const button = page.getByRole('button', { name: 'Toggle compaction summary', exact: true });
  const body = page.locator('.compaction-summary-card .collapsible-body-wrap');
  const before = await measure(page, body);
  await button.evaluate((el: HTMLElement) => el.click());
  await expect(body).toHaveAttribute('data-height-moving', 'true');
  await interpolates(page, body, before);
  const html = await body.locator('.message-body').innerHTML(), expanded = await measure(page, body);
  await button.evaluate((el: HTMLElement) => el.click());
  await expect(body).toHaveAttribute('aria-hidden', 'true');
  expect(await body.locator('.message-body').innerHTML()).toBe(html);
  await interpolates(page, body, expanded);
  await expect(body).toHaveCount(0);
});

test('reasoning inline-to-collapsed threshold changes animate without replaying initial history', async ({ page, isolatedHost }) => {
  isolatedHost.publishState(state('reasoning', bash, 'Short reasoning.')); await open(page);
  expect(await page.locator(owners).evaluateAll(elements => elements.flatMap(el => el.getAnimations()).length)).toBe(0);
  const block = page.locator('.reasoning-space'), before = await measure(page, block);
  isolatedHost.publishState(state('reasoning'));
  await expect(toggle(page, 'reasoning')).toHaveAttribute('aria-expanded', 'false');
  const moving = page.locator('.reasoning-space[data-preview-moving], .reasoning-space[data-height-moving]').first();
  await expect(moving).toHaveCount(1);
  expect(Math.abs((await measure(page, block)).sibling - before.sibling)).toBeLessThanOrEqual(2);
  await midpoint(moving);
  const mid = await measure(page, block); await finish(page); const end = await measure(page, block);
  expect(mid.height).toBeGreaterThan(Math.min(before.height, end.height));
  expect(mid.height).toBeLessThan(Math.max(before.height, end.height));
  await page.reload(); await expect(toggle(page, 'reasoning')).toHaveAttribute('aria-expanded', 'false');
  expect(await page.locator(owners).evaluateAll(elements => elements.flatMap(el => el.getAnimations()).length)).toBe(0);
});
