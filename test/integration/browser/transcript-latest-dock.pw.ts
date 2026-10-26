// Browser layout regression; run against a freshly built renderer.
import { expect, test } from './ui-smoke-fixtures.js';
import { EMPTY_VIEW_STATE } from '../../../application/frontend/lib/hooks/use-host-sync.js';

test.use({
  viewState: {
    transcript: [{
      id: 'dock-reader', role: 'assistant', status: 'completed',
      createdAt: '2026-10-21T00:00:00Z',
      markdown: Array.from({ length: 80 }, (_, i) => `Paragraph ${i}: stable transcript reading content.`).join('\n\n'),
    }],
    transcriptWindow: { ...EMPTY_VIEW_STATE.transcriptWindow, totalCount: 1, loadedEnd: 1 },
  },
});

for (const width of [320, 900]) {
  test(`Latest is a centered icon control at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const scroll = page.locator('.transcript-virtual');
    await expect(scroll).not.toHaveClass(/transcript-positioning/);
    const viewportBefore = await scroll.boundingBox();
    await scroll.dispatchEvent('pointerdown', { button: 0 });
    await scroll.evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight - 200; });
    const button = page.getByRole('button', { name: 'Jump to latest' });
    await expect(button).toBeVisible();
    await expect(button).toHaveText('');
    await expect(button.locator('svg')).toBeVisible();
    await button.evaluate(async (el) => {
      await Promise.all(el.getAnimations().map(animation => animation.finished));
    });
    await page.screenshot({ path: testInfo.outputPath('jump-to-latest.png') });
    expect(await scroll.boundingBox(), 'showing Latest must not shrink the transcript').toEqual(viewportBefore);
    const dock = (await page.locator('.transcript-latest-dock').boundingBox())!;
    const before = (await button.boundingBox())!;
    expect(before.y).toBeGreaterThan(viewportBefore!.y);
    expect(before.y + before.height).toBeLessThan(viewportBefore!.y + viewportBefore!.height);
    // The transparent space beside the floating control must still target the transcript.
    expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.transcript-virtual'), {
      x: viewportBefore!.x + 12, y: before.y + before.height / 2,
    })).toBe(true);
    expect(Math.abs(before.x + before.width / 2 - dock.x - dock.width / 2)).toBeLessThanOrEqual(1);
    expect(before.width).toBe(before.height);
    await button.hover();
    expect(await button.boundingBox()).toEqual(before);
    await button.focus();
    await button.press('Enter');
    await expect(button).toHaveCount(0);
    await expect.poll(() => scroll.evaluate(el => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop))).toBeLessThanOrEqual(1);
    await page.reload();
    await expect(scroll).not.toHaveClass(/transcript-positioning/);
    await expect(button).toHaveCount(0);
  });
}

test('Latest remains stable around the 24px boundary as its overlay mounts and resizes', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 900 });
  await page.goto('/');
  const scroll = page.locator('.transcript-virtual');
  const dock = page.locator('.transcript-latest-dock');
  await expect(scroll).toBeVisible();
  await expect(scroll).not.toHaveClass(/transcript-positioning/);
  await expect(dock).toHaveCount(0);
  // Acquire real manual ownership before changing scrollTop, just like a
  // native scrollbar drag. Keep the viewport away from virtualization edges.
  await scroll.dispatchEvent('pointerdown', { button: 0 });
  await scroll.evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight - 100; });
  await expect(dock).toBeVisible();
  const top = await scroll.evaluate(el => {
    el.scrollTop = el.scrollHeight - el.clientHeight - 25;
    return el.scrollTop;
  });
  await expect(dock).toBeVisible();
  // Changing the overlay's size must not change scroll geometry or visibility.
  await dock.evaluate(el => { (el as HTMLElement).style.paddingBlock = '12px'; });
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeCloseTo(top, 0);
  await page.setViewportSize({ width: 520, height: 899 });
  await expect(dock).toBeVisible();
  await page.setViewportSize({ width: 520, height: 905 });
  await expect(dock).toHaveCount(0);
  // Multiple frames catch mount/remove feedback oscillation.
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(dock).toHaveCount(0);
  }
  await page.setViewportSize({ width: 520, height: 890 });
  await expect(dock).toBeVisible();
  const viewportBottom = await page.locator('.transcript-viewport').evaluate(el => el.getBoundingClientRect().bottom);
  const dockBounds = (await dock.boundingBox())!;
  expect(dockBounds.y + dockBounds.height).toBeLessThan(viewportBottom);
  await page.getByRole('button', { name: 'Jump to latest' }).click();
  await expect(dock).toHaveCount(0);
  await expect.poll(() => scroll.evaluate(el => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop))).toBeLessThanOrEqual(1);
});
