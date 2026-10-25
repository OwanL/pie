// Playwright-only: real renderer, stateful disposable host, no SDK or ambient settings.
import path from 'node:path';
import os from 'node:os';
import { mkdir } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { ModelInfo, ViewState } from '../../../application/lib/protocol/index.js';
import { BrowserServer } from '../../../application/hosts/browser/http/browser-server.js';
import { EMPTY_VIEW_STATE } from '../../../application/frontend/lib/hooks/use-host-sync.js';
import { expect, test as base } from './ui-smoke-fixtures.js';

const models: ModelInfo[] = [
  { id: 'swift-2', name: 'Swift 2', provider: 'openai', reasoning: true, inputKinds: ['text', 'image'], subagent: { eligible: true, pricing: { input: 0, output: 0.5, cacheRead: 0, cacheWrite: 0 } } },
  { id: 'pro-2', name: 'Pro 2', provider: 'anthropic', reasoning: true, inputKinds: ['text'], subagent: { eligible: true, pricing: { input: 2, output: 10, cacheRead: 1, cacheWrite: 2 } } },
  { id: 'very-long-model-name-for-layout-stress-testing-with-many-words-and-a-version-2026', name: 'Very Long Model Name for Layout Stress Testing with Many Words and Version 2026', provider: 'long-provider-name', reasoning: false, inputKinds: ['text'], subagent: { eligible: true, pricing: { input: 10, output: 10, cacheRead: 1, cacheWrite: 2 } } },
  { id: 'unknown-price', name: 'Unknown Price Model', provider: 'google', reasoning: true, inputKinds: ['text', 'image'] },
];
const test = base.extend({
  isolatedHost: async ({}, use) => {
    const session = { path: path.join(os.tmpdir(), 'pie-model-picker-fake-session.jsonl'), name: 'Disposable UI smoke session', cwd: os.tmpdir(), modifiedAt: new Date().toISOString(), messageCount: 0 };
    let state: ViewState = { ...EMPTY_VIEW_STATE, backendReady: true, transcriptLoaded: true, sessions: [session], openTabPaths: [session.path], activeSession: session,
      modelSettings: { defaultModel: 'swift-2', defaultProvider: 'openai', defaultThinkingLevel: 'medium' as const },
      availableModels: models, prefs: { ...EMPTY_VIEW_STATE.prefs, modelFavorites: [] } };
    const server: BrowserServer = new BrowserServer({
      getSettings: () => ({ enabled: true, port: 0, allowLan: false, requirePreferredPort: true }),
      getViewState: () => state, getRunningSessionCount: () => 0,
      assetDir: path.resolve(process.env.PIE_BROWSER_ASSET_DIR ?? 'application/hosts/vscode/out-dev/webview/panel'),
      routeMessage: async (message, context) => {
        if (message.type === 'setPrefs') {
          state = { ...state, prefs: { ...state.prefs, ...message.prefs } };
          server.scheduleState();
        } else if (['ready', 'refreshState', 'requestSnapshot'].includes(message.type)) server.requestState(context.rendererId);
      },
    });
    try {
      const outcome = await server.start();
      if (outcome.kind !== 'started') throw new Error(`Fake host failed: ${outcome.kind}`);
      await use({ url: outcome.url, publishState: (patch) => { state = { ...state, ...patch } as typeof state; server.scheduleState(); } });
    } finally { await server.stop(); server.dispose(); }
  },
});

async function open(page: Page, width = 600) {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(4);
}
async function bounded(page: Page) {
  const bounds = await page.locator('.model-picker-dropdown').evaluate(el => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight, overflow: el.scrollWidth - el.clientWidth };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
  expect(bounds.overflow).toBeLessThanOrEqual(1);
}
async function capture(page: Page, name: string) {
  if (!process.env.PIE_PICKER_SCREENSHOTS) return;
  await mkdir(process.env.PIE_PICKER_SCREENSHOTS, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(process.env.PIE_PICKER_SCREENSHOTS, name), animations: 'disabled' });
}

test('table headers toggle both directions and sort costs numerically with missing last', async ({ page }) => {
  await open(page);
  const orders: Record<string, [string[], string[]]> = {
    Model: [['long-provider-name', 'google', 'openai', 'anthropic'], ['anthropic', 'openai', 'google', 'long-provider-name']],
    Provider: [['anthropic', 'google', 'long-provider-name', 'openai'], ['openai', 'long-provider-name', 'google', 'anthropic']],
    In: [['openai', 'anthropic', 'long-provider-name', 'google'], ['long-provider-name', 'anthropic', 'openai', 'google']],
    Out: [['openai', 'anthropic', 'long-provider-name', 'google'], ['anthropic', 'long-provider-name', 'openai', 'google']],
    Img: [['anthropic', 'long-provider-name', 'openai', 'google'], ['openai', 'google', 'anthropic', 'long-provider-name']],
  };
  // The first Tab from search must reach a real sortable header.
  await page.getByRole('combobox', { name: 'Model', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Sort by Model', exact: true })).toBeFocused();
  for (const name of ['Model', 'Provider', 'In', 'Out', 'Img']) {
    const button = page.getByRole('button', { name: `Sort by ${name}`, exact: true });
    const description = () => button.evaluate(el => document.getElementById(el.getAttribute('aria-describedby')!)?.textContent);
    // Model initially starts ascending; other columns start inactive.
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(await description()).toBe(name === 'Model' ? 'Sorted descending' : 'Sorted ascending');
    await expect(page.locator('.model-picker-col-provider')).toHaveText(orders[name]![0]);
    await page.keyboard.press('Space');
    expect(await description()).toBe(name === 'Model' ? 'Sorted ascending' : 'Sorted descending');
    await expect(page.locator('.model-picker-col-provider')).toHaveText(orders[name]![1]);
  }
  await page.getByRole('button', { name: 'Sort by In', exact: true }).click();
  await expect(page.locator('.model-picker-col-price').filter({ hasText: /^\$0\.00$/ })).toHaveCount(1);
  const prices = () => page.getByRole('option').evaluateAll(rows => rows.map(row => row.querySelector('.model-picker-col-price')?.textContent?.trim()));
  expect(await prices()).toEqual(['$0.00', '$2.00', '$10.00', '—']);
  await page.getByRole('button', { name: 'Sort by In', exact: true }).click();
  expect(await prices()).toEqual(['$10.00', '$2.00', '$0.00', '—']);
});

test('right-click favorites share intent across composer and compact settings, survive reload, and do not select', async ({ page }) => {
  await open(page);
  const selected = () => page.getByRole('option', { selected: true });
  await expect(selected()).toContainText('Swift 2');
  const row = page.getByRole('option').filter({ hasText: 'Pro 2' });
  const star = row.locator('.model-picker-name + .model-picker-favorite');
  await row.click({ button: 'right' });
  await expect(star).toHaveText('★');
  await expect(star).toHaveAttribute('aria-hidden', 'true');
  await expect(row.getByRole('button')).toHaveCount(0);
  await expect(page.locator('.model-picker-header > span')).toHaveCount(5);
  await expect(row.locator(':scope > .model-picker-col')).toHaveCount(5);
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(selected()).toContainText('Swift 2');
  await expect(page.getByRole('option').first()).toContainText('Pro 2');
  await page.getByRole('combobox', { name: 'Model', exact: true }).focus();
  await row.click({ button: 'right' });
  await expect(star).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toBeFocused();
  await expect(selected()).toContainText('Swift 2');
  await row.click({ button: 'right' });
  await expect(star).toHaveText('★');
  await expect(selected()).toContainText('Swift 2');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Models', exact: true }).click();
  const compact = page.getByRole('button', { name: 'Chat default model', exact: true });
  await compact.click();
  await expect(star).toHaveText('★');
  await bounded(page);
  await page.getByRole('combobox', { name: 'Chat default model', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.model-picker-dropdown')).toHaveCount(0);
  await expect(page.locator('.toolbar-settings-menu')).toBeVisible();
  await expect(compact).toBeFocused();
  await page.reload();
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await expect(star).toHaveText('★');
  await expect(selected()).toContainText('Swift 2');
});

test('keyboard context-menu shortcuts toggle the active favorite without closing or moving focus', async ({ page }) => {
  await open(page);
  const search = page.getByRole('combobox', { name: 'Model', exact: true });
  await search.fill('Pro 2');
  const active = await search.getAttribute('aria-activedescendant');
  const row = page.getByRole('option');
  await expect(row).toContainText('Pro 2');
  await page.evaluate(() => {
    (window as any).pickerKeys = [];
    document.addEventListener('keydown', event => {
      if (event.key === 'ContextMenu' || event.key === 'F10')
        setTimeout(() => (window as any).pickerKeys.push({ key: event.key, prevented: event.defaultPrevented }), 0);
    }, true);
  });
  for (const [key, starred] of [['Shift+F10', true], ['ContextMenu', false]] as const) {
    await search.press(key);
    await expect(row.locator('.model-picker-favorite')).toHaveCount(starred ? 1 : 0);
    await expect(search).toBeFocused();
    await expect(search).toHaveAttribute('aria-activedescendant', active!);
    await expect(page.locator('.model-picker-dropdown')).toBeVisible();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Model', exact: true })).toContainText('Swift 2');
  }
  await expect.poll(() => page.evaluate(() => (window as any).pickerKeys)).toEqual([
    { key: 'F10', prevented: true }, { key: 'ContextMenu', prevented: true },
  ]);
});

test('table remains bounded at baseline widths including long provider and model labels', async ({ page }) => {
  for (const width of [600, 360]) {
    await open(page, width);
    for (const label of ['Pro 2', 'Very Long Model Name']) {
      const row = page.getByRole('option').filter({ hasText: label });
      if (await row.locator('.model-picker-favorite').count() === 0) await row.click({ button: 'right' });
      await expect(row.locator('.model-picker-name + .model-picker-favorite')).toHaveText('★');
    }
    await page.mouse.move(0, 0);
    await bounded(page);
    await capture(page, `${width}-model-open.png`);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Models', exact: true }).click();
    await page.getByRole('button', { name: 'Chat default model', exact: true }).click();
    await bounded(page);
    const long = page.getByRole('option').filter({ hasText: 'Very Long Model Name' });
    await expect(long.locator('.model-picker-favorite')).toBeVisible();
    expect(await long.locator('.model-picker-name').evaluate(el => el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight)).toBe(true);
    await capture(page, `${width}-settings-model-open.png`);
  }
});
