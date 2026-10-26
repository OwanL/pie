// Playwright-only spec; uses the real renderer with isolated, synthetic usage.
import { EMPTY_AGGREGATE_STATS } from '../../../application/lib/protocol/index.js';
import { expect, test } from './ui-smoke-fixtures.js';

const providers = [
  { provider: 'openai-codex', cost: 516.50 },
  { provider: 'github-copilot', cost: 97.54 },
  { provider: 'ollama', cost: 11.12 },
];
const models = [
  ['gpt-6.1-sol', 63.64], ['gpt-6-astra', 31.74], ['gpt-6-luna', 1.28],
  ['claude-haiku-5.5', 0.8873], ['claude-fable-5.1', 0], ['claude-opus-5.5', 0],
  ['claude-sonnet-5.5', 0], ['gemini-3.8-flash', 0], ['gpt-5.6-luna', 0],
  ['gpt-5.6-sol', 0], ['gpt-6-sol', 0],
] as const;
const series = Array.from({ length: 35 }, (_, i) => ({
  ms: new Date('2026-10-21T10:00:00').getTime() + i * 4 * 3_600_000,
  byProvider: providers.map(p => ({ key: p.provider, value: p.cost * Math.pow(i / 34, 1.7) })),
  byModel: models.map(([model, value]) => ({ key: model, model, provider: 'github-copilot', value: value * Math.pow(i / 34, 1.7) })),
}));
const stats = {
  ...EMPTY_AGGREGATE_STATS, ready: true, todayCost: 89.8, weekCost: 625.16,
  weekCostByProvider: providers.map(p => ({ ...p, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })),
  weekCostSeries: series,
};

test.use({ deviceScaleFactor: 2, viewState: { aggregateStats: stats } });

test('provider costs stay single-line and zero-spend models are omitted', async ({ page, isolatedHost }, testInfo) => {
  for (const width of [1100, 320]) {
    await page.setViewportSize({ width, height: 780 });
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
    const cost = page.locator('[data-stat="week"] .aggregate-strip-cost:visible');
    if (!await cost.isVisible()) {
      await page.getByRole('button', { name: 'More composer options', exact: true }).click();
    }
    await expect(cost).toBeVisible();
    await page.keyboard.press('ArrowRight'); // Use keyboard focus-visible semantics after opening overflow by mouse.
    await cost.focus();
    const host = page.locator('body > .pie-tooltip-host--rich:visible');
    await expect(host).toBeVisible();
    const provider = host.getByRole('button', { name: 'github-copilot $97.54. Focus for model breakdown.', exact: true });
    await provider.focus();
    const detail = host.locator('.rich-tooltip-legend-detail:visible');
    await expect(detail).toBeVisible();
    await expect(detail.locator('.rich-tooltip-legend-detail-row')).toHaveCount(4);
    await expect(detail).not.toContainText('claude-fable');
    await expect(detail).not.toContainText('github-copilot');
    await expect(detail).not.toContainText('$97.54');
    await expect(detail).toContainText('$0.8873');
    await expect(detail.locator('.rich-tooltip-legend-detail-model').first()).toHaveText('gpt-6.1-sol');

    const checkLayout = async () => {
      const layout = await detail.evaluate(root => {
        const bounds = root.getBoundingClientRect();
        const values = [...root.querySelectorAll<HTMLElement>('.rich-tooltip-legend-detail-value')];
        return {
          left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
          overflow: root.scrollWidth > root.clientWidth,
          rows: values.map(value => ({
            height: value.getBoundingClientRect().height,
            lineHeight: parseFloat(getComputedStyle(value).lineHeight),
            right: value.getBoundingClientRect().right,
          })),
        };
      });
      expect(layout.left).toBeGreaterThanOrEqual(0);
      expect(layout.right).toBeLessThanOrEqual(width);
      expect(layout.top).toBeGreaterThanOrEqual(0);
      expect(layout.bottom).toBeLessThanOrEqual(780);
      expect(layout.overflow).toBe(false);
      for (const row of layout.rows) {
        expect(row.height).toBeLessThanOrEqual(row.lineHeight + 1);
        expect(Math.abs(row.right - layout.rows[0]!.right)).toBeLessThan(1);
      }
    };
    await checkLayout();
    if (width === 1100) {
      const hostBox = (await host.boundingBox())!;
      const detailBox = (await detail.boundingBox())!;
      const y = Math.min(hostBox.y, detailBox.y) - 16;
      const screenshot = testInfo.outputPath('provider-cost-tooltip.png');
      await page.screenshot({ path: screenshot, clip: { x: hostBox.x - 16, y, width: hostBox.width + 32, height: hostBox.y + hostBox.height - y + 16 } });
      console.log(`Provider tooltip screenshot: ${screenshot}`);
    }

    await page.keyboard.press('Escape');
    await expect(host).toBeHidden();
    if (width === 1100) await expect(cost).toBeFocused();
    else await expect(page.getByRole('button', { name: 'More composer options', exact: true })).toBeFocused();

    // Pure mouse entry: cross the gap without a focused provider keeping it open.
    if (width === 1100) {
      await page.getByRole('textbox', { name: 'Message composer', exact: true }).click();
      await cost.hover();
      await provider.hover();
      const panel = (await detail.boundingBox())!;
      await page.mouse.move(panel.x + panel.width / 2, panel.y + panel.height + 2);
      await expect(detail).toBeVisible();
      await detail.locator('.rich-tooltip-legend-detail-model').first().hover();
      await expect(detail).toBeVisible();
      await page.keyboard.press('Escape');
    }
  }

  // Refresh through the real host projection, including an unbroken model id.
  const longModel = `long-model-${'identifier'.repeat(20)}`;
  isolatedHost.publishState({ aggregateStats: {
    ...stats,
    weekCostSeries: series.map(point => ({ ...point, byModel: point.byModel.map((entry, index) => index === 0 ? { ...entry, model: longModel } : entry) })),
  } });
  await page.reload();
  await page.getByRole('button', { name: 'More composer options', exact: true }).click();
  await page.keyboard.press('ArrowRight');
  await page.locator('[data-stat="week"] .aggregate-strip-cost:visible').focus();
  const provider = page.getByRole('button', { name: 'github-copilot $97.54. Focus for model breakdown.', exact: true });
  await provider.focus();
  const name = page.locator('.rich-tooltip-legend-detail:visible .rich-tooltip-legend-detail-model').first();
  await expect(name).toHaveText(longModel);
  await expect(name).toHaveAttribute('title', `${longModel} (github-copilot)`);
  const detail = page.locator('.rich-tooltip-legend-detail:visible');
  expect(await detail.evaluate(root => root.scrollWidth <= root.clientWidth)).toBe(true);
});
