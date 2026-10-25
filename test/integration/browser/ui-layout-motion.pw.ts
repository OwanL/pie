// Real renderer and stateful disposable host; no providers or ambient settings.
import os from 'node:os';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { BrowserServer } from '../../../application/hosts/browser/http/browser-server.js';
import { EMPTY_VIEW_STATE } from '../../../application/frontend/lib/hooks/use-host-sync.js';
import type { ModelInfo, ViewState } from '../../../application/lib/protocol/index.js';
import { expect, test as base } from './ui-smoke-fixtures.js';

const models: ModelInfo[] = [
  ['haiku', 'Claude Haiku 4.5', 'anthropic'], ['sonnet', 'Claude Sonnet 4.5', 'anthropic'],
  ['gemini', 'Gemini 2.5 Pro', 'google'], ['gpt5', 'GPT 5', 'openai'], ['o3', 'OpenAI o3', 'openai'],
].map(([id, name, provider]) => ({ id: id!, name: name!, provider: provider!, reasoning: true, inputKinds: ['text'] }));

const test = base.extend({
  isolatedHost: async ({}, use) => {
    const session = { path: path.join(os.tmpdir(), 'pie-layout-motion-session.jsonl'), name: 'Review interface changes',
      cwd: os.tmpdir(), modifiedAt: new Date().toISOString(), messageCount: 1 };
    let state: ViewState = { ...EMPTY_VIEW_STATE, backendReady: true, transcriptLoaded: true,
      sessions: [session], openTabPaths: [session.path], activeSession: session,
      transcript: [{ id: 'reply', role: 'assistant', status: 'completed', createdAt: session.modifiedAt,
        markdown: '### Interface changes ready for review\n\nReview the changed files while keeping this conversation in view.\n\nThe model picker preserves the selected model when you mark a favorite.' }],
      transcriptWindow: { ...EMPTY_VIEW_STATE.transcriptWindow, totalCount: 1, loadedEnd: 1 },
      fileChanges: ['src/app.tsx', 'src/motion.css', 'test/layout.test.ts'].map((file, i) => ({
        path: file, kind: 'modified', additions: 24 + i, deletions: 8, description: '',
        toolCallId: 'tool', messageId: 'reply', timestamp: session.modifiedAt,
      })),
      modelSettings: { defaultModel: 'sonnet', defaultProvider: 'anthropic', defaultThinkingLevel: 'medium' },
      availableModels: models, prefs: { ...EMPTY_VIEW_STATE.prefs, modelFavorites: [] },
    };
    const server = new BrowserServer({
      getSettings: () => ({ enabled: true, port: 0, allowLan: false, requirePreferredPort: true }),
      getViewState: () => state, getRunningSessionCount: () => 0,
      assetDir: path.resolve(process.env.PIE_BROWSER_ASSET_DIR ?? 'application/hosts/vscode/out-dev/webview/panel'),
      routeMessage: async (message, context) => {
        if (message.type === 'setPrefs') {
          state = { ...state, prefs: { ...state.prefs, ...message.prefs } };
          server.scheduleState();
        } else if (message.type === 'setFileChangesExpanded') {
          state = { ...state, fileChangesExpanded: message.expanded };
          server.scheduleState();
        } else if (['ready', 'refreshState', 'requestSnapshot'].includes(message.type)) server.requestState(context.rendererId);
      },
    });
    try {
      const outcome = await server.start();
      if (outcome.kind !== 'started') throw new Error(`Isolated host failed: ${outcome.kind}`);
      await use({ url: outcome.url, publishState: patch => { state = { ...state, ...patch }; server.scheduleState(); } });
    } finally { await server.stop(); server.dispose(); }
  },
});

async function open(page: Page, width = 550) {
  await page.setViewportSize({ width, height: 800 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args: Parameters<typeof animate>) {
      const animation = animate.apply(this, args);
      if (this.matches('.file-changes-rail, .model-picker-row')) { animation.pause(); animation.currentTime = 0; }
      return animation;
    };
    document.addEventListener('transitionrun', event => {
      if (!(event.target instanceof Element) || !event.target.matches('.transcript')) return;
      for (const animation of event.target.getAnimations()) {
        if (animation instanceof CSSTransition && animation.transitionProperty.startsWith('padding')) {
          animation.pause(); animation.currentTime = 0;
        }
      }
    }, true);
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Model', exact: true })).toBeVisible();
  await expect(page.locator('.transcript-virtual')).not.toHaveClass(/transcript-positioning/);
  await page.evaluate(() => document.fonts.ready);
}

async function finish(locator: Locator) {
  await locator.evaluateAll(async elements => {
    const animations = elements.flatMap(el => el.getAnimations());
    animations.forEach(animation => animation.finish());
    await Promise.all(animations.map(animation => animation.finished.catch(() => undefined)));
  });
}
const width = (element: Locator) => element.evaluate(el => el.getBoundingClientRect().width);
const top = (element: Locator) => element.evaluate(el => el.getBoundingClientRect().top);

for (const viewport of [550, 900]) {
  test(`file rail eases its whole footprint, reverses and resizes without replay at ${viewport}`, async ({ page }) => {
    await open(page, viewport);
    const rail = page.locator('.file-changes-rail');
    const drawer = page.locator('.file-changes-drawer');
    const sliver = page.getByRole('button', { name: /^File changes: 3/ });
    const collapsed = await width(rail);
    expect(await rail.evaluate(el => el.getAnimations().length)).toBe(0);
    await sliver.hover();
    await expect(drawer).toHaveClass(/is-peek/);
    // The hidden drawer's transparent border can contribute one CSS pixel.
    expect(Math.abs(await width(rail) - collapsed)).toBeLessThanOrEqual(1);
    expect(await drawer.evaluate(el => getComputedStyle(el).transitionDuration)).toContain('0.12s');
    const heading = page.getByRole('heading', { name: 'Interface changes ready for review' });
    const textLeft = await heading.evaluate(el => el.getBoundingClientRect().left);
    await page.getByRole('button', { name: 'Keep file changes open (pin)', exact: true }).click();
    await expect(rail).toHaveAttribute('data-layout-moving', '');
    await expect(rail).not.toHaveClass(/is-peeking/); // This render must not erase motion-owned state.
    expect(Math.abs(await width(rail) - collapsed)).toBeLessThanOrEqual(1);
    expect(Math.abs(await heading.evaluate(el => el.getBoundingClientRect().left) - textLeft), 'transcript inset must not snap when pinning').toBeLessThanOrEqual(1);
    const target = await rail.evaluate(el => {
      const animation = el.getAnimations()[0]!;
      if (animation.effect!.getTiming().duration !== 120) throw new Error('Rail must stay snappy');
      const frames = animation.effect!.getKeyframes();
      animation.currentTime = 60;
      return Number.parseFloat(String(frames[frames.length - 1]!.width));
    });
    await page.locator('.transcript').evaluate(el => el.getAnimations().forEach(animation => { animation.currentTime = 60; }));
    const midpoint = await width(rail);
    expect(midpoint).toBeGreaterThan(collapsed + 2);
    expect(midpoint).toBeLessThan(target - 2);
    await page.getByRole('button', { name: 'Collapse file changes', exact: true }).click();
    await expect(rail).toHaveAttribute('data-layout-closing', '');
    expect(Math.abs(await width(rail) - midpoint)).toBeLessThanOrEqual(1);
    await finish(page.locator('.file-changes-rail, .transcript'));
    await expect(rail).not.toHaveAttribute('data-layout-moving');
    expect(Math.abs(await width(rail) - collapsed)).toBeLessThanOrEqual(1);
    await sliver.click();
    await expect(rail).toHaveAttribute('data-layout-moving', '');
    // An intentional keyboard resize interrupts motion and takes effect immediately.
    await page.getByRole('separator', { name: 'Drag to resize file-changes rail', exact: true }).press('ArrowRight');
    await expect(rail).not.toHaveAttribute('data-layout-moving');
    expect(await width(rail)).toBeGreaterThan(target);
    expect(await rail.evaluate(el => el.getAnimations().length)).toBe(0);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Collapse file changes', exact: true })).toBeVisible();
    expect(await rail.evaluate(el => el.getAnimations().length)).toBe(0);
  });
}

test('favorite reorder moves real keyed rows, preserves focus/selection, reverses and never replays on filtering', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  const search = page.getByRole('combobox', { name: 'Model', exact: true });
  await expect(search).toBeFocused();
  const row = page.getByRole('option').filter({ hasText: 'GPT 5' });
  const original = await top(row);
  await row.click({ button: 'right' });
  await expect(page.getByRole('option').first()).toContainText('GPT 5');
  await expect(page.getByRole('option', { selected: true })).toContainText('Claude Sonnet 4.5');
  await expect(search).toBeFocused();
  await expect(row).toHaveAttribute('data-model-moving', '');
  await expect(row).toHaveAttribute('data-model-motion-primary', '');
  expect(Math.abs(await top(row) - original)).toBeLessThanOrEqual(1);
  await row.evaluate(el => {
    const animation = el.getAnimations()[0]!;
    if (animation.effect!.getTiming().duration !== 180) throw new Error('Unexpected favorite duration');
    animation.currentTime = 90;
  });
  const midpoint = await top(row);
  expect(midpoint).toBeLessThan(original - 2);
  // Pointer-highlight changes must preserve the opaque moving-row surface.
  await page.getByRole('option').filter({ hasText: 'Claude Haiku' }).hover();
  await expect(row).toHaveAttribute('data-model-moving', '');
  // Right-click again while in flight: reverse from its current visual location.
  await row.dispatchEvent('contextmenu', { button: 2 });
  await expect(page.getByRole('option').first()).toContainText('Claude Haiku');
  expect(Math.abs(await top(row) - midpoint)).toBeLessThanOrEqual(1);
  await finish(page.locator('[data-model-moving]'));
  await expect(page.locator('[data-model-moving]')).toHaveCount(0);
  await row.click({ button: 'right' });
  await expect(row).toHaveAttribute('data-model-moving', '');
  await search.fill('GPT');
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(page.locator('[data-model-moving]')).toHaveCount(0);
  await search.press('Escape');
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(5);
  await expect(page.locator('[data-model-moving]')).toHaveCount(0);
});

test('reduced motion cancels active rail and favorite animations and leaves interactions immediate', async ({ page }) => {
  await open(page);
  const rail = page.locator('.file-changes-rail');
  await page.getByRole('button', { name: /^File changes: 3/ }).click();
  await expect(rail).toHaveAttribute('data-layout-moving', '');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(rail).not.toHaveAttribute('data-layout-moving');
  expect(await rail.evaluate(el => el.getAnimations().length)).toBe(0);
  await page.getByRole('button', { name: 'Collapse file changes', exact: true }).click();
  await expect(page.getByRole('button', { name: /^File changes: 3/ })).toBeVisible();
  expect(await rail.evaluate(el => el.getAnimations().length)).toBe(0);
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  const row = page.getByRole('option').filter({ hasText: 'GPT 5' });
  await row.click({ button: 'right' });
  await expect(page.getByRole('option').first()).toContainText('GPT 5');
  await expect(page.locator('[data-model-moving]')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await row.click({ button: 'right' });
  await expect(row).toHaveAttribute('data-model-moving', '');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('[data-model-moving]')).toHaveCount(0);
});
