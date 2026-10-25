// Real renderer + disposable socket host; no backend or provider calls.
import type { Page } from '@playwright/test';
import { expect, test } from './ui-smoke-fixtures.js';

const longName = 'A deliberately very long current model name that must yield to its reasoning suffix';
test.use({ viewState: {
  modelSettings: { defaultModel: 'shared', defaultProvider: 'alpha', defaultThinkingLevel: 'high' },
  availableModels: [
    { id: 'shared', name: longName, provider: 'alpha', reasoning: true, thinkingLevels: ['off', 'high', 'low'], inputKinds: ['text'], contextWindow: 128000 },
    { id: 'shared', name: 'Other provider model', provider: 'beta', reasoning: true, thinkingLevels: ['low', 'max', 'off', 'high'], inputKinds: ['text'], contextWindow: 128000 },
    { id: 'plain', name: 'Plain model', provider: 'alpha', reasoning: false, thinkingLevels: ['off'], inputKinds: ['text'], contextWindow: 128000 },
  ],
} });

async function open(page: Page, width = 600) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => {
    const target = window as unknown as { pickerCommands: unknown[] };
    target.pickerCommands = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === 'string') {
        try { target.pickerCommands.push(JSON.parse(data)); } catch { /* non-JSON frame */ }
      }
      return send.call(this, data);
    };
  });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message composer' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}
async function commands(page: Page) {
  return page.evaluate(() => (window as unknown as { pickerCommands: Array<Record<string, unknown>> }).pickerCommands
    .filter(command => JSON.stringify(command).includes('setModel')));
}
async function bounded(page: Page) {
  for (const selector of ['.model-picker-dropdown', '[data-model-reasoning-submenu]']) {
    const rect = await page.locator(selector).boundingBox();
    expect(rect).not.toBeNull();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.y).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(900);
  }
}

test('pins current once, transfers actual hover to descending supported levels and commits provider plus level atomically', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  const root = page.locator('.model-picker-rows');
  await expect(root.getByRole('option')).toHaveCount(3);
  await expect(root.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await expect(root.getByRole('option', { selected: true })).toHaveCount(1);
  const row = root.getByRole('option').filter({ hasText: 'Other provider model' });
  await row.hover();
  const submenu = page.getByRole('listbox', { name: /Reasoning for .*Other provider model/ });
  await expect(submenu).toBeVisible();
  await expect(submenu.locator('.choice-picker-label')).toHaveText(['max', 'high', 'low', 'off']);
  await bounded(page);
  const start = await row.boundingBox();
  const end = await submenu.getByRole('option', { name: 'max', exact: true }).boundingBox();
  await page.mouse.move(start!.x + start!.width - 4, start!.y + start!.height / 2);
  await page.mouse.move(end!.x + end!.width / 2, end!.y + end!.height / 2, { steps: 20 });
  await expect(submenu).toBeVisible();
  expect(await commands(page)).toEqual([]);
  await submenu.getByRole('option', { name: 'max', exact: true }).click();
  await expect(submenu).toBeHidden();
  const sent = await commands(page);
  expect(sent).toHaveLength(1);
  // Browser transport wraps commands; assert the actual atomic command payload.
  const payload = JSON.stringify(sent[0]);
  expect(payload).toContain('"defaultProvider":"beta"');
  expect(payload).toContain('"defaultModel":"shared"');
  expect(payload).toContain('"defaultThinkingLevel":"max"');
});

test('keyboard explicit open, cancel child, cancel root and select', async ({ page }) => {
  await open(page);
  const trigger = page.getByRole('button', { name: 'Model', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const search = page.getByRole('combobox', { name: 'Model', exact: true });
  await expect(search).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-model-reasoning-submenu]')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  const submenu = page.locator('[data-model-reasoning-submenu]');
  await expect(submenu).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(search).toBeFocused();
  expect(await commands(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(search).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(submenu).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(submenu).toBeHidden();
  expect(await commands(page)).toHaveLength(1);
});

test.describe('touch', () => {
  test.use({ contextOptions: { hasTouch: true } });
  test('360px tap keeps inset child and parent usable and long-label suffix unclipped', async ({ page }) => {
    await open(page, 360);
    const suffix = page.locator('.model-picker-reasoning-suffix');
    await expect(suffix).toHaveText('high');
    const metrics = await suffix.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const parent = element.parentElement!.getBoundingClientRect();
      return { left: rect.left - parent.left, right: parent.right - rect.right, width: element.clientWidth, content: element.scrollWidth };
    });
    expect(metrics.left).toBeGreaterThanOrEqual(0);
    expect(metrics.right).toBeGreaterThanOrEqual(0);
    expect(metrics.content).toBeLessThanOrEqual(metrics.width);
    await page.getByRole('button', { name: 'Model', exact: true }).tap();
    const row = page.locator('.model-picker-rows').getByRole('option').first();
    await row.tap();
    const submenu = page.locator('[data-model-reasoning-submenu]');
    await expect(submenu).toHaveAttribute('data-side', 'inset');
    await bounded(page);
    // The parent name remains exposed: the inset must not replace the entire root.
    const name = row.locator('.model-picker-name');
    const parentBox = await name.boundingBox();
    const childBox = await submenu.boundingBox();
    expect(parentBox!.x).toBeLessThan(childBox!.x);
    await submenu.getByRole('option', { name: 'low', exact: true }).tap();
    await expect(submenu).toBeHidden();
    expect(await commands(page)).toHaveLength(1);
  });
});
