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

test('Latest remains stable around the 24px boundary as its flow dock mounts and resizes', async ({ page }) => {
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
    const height = document.querySelector('.transcript-latest-dock')!.getBoundingClientRect().height;
    el.scrollTop = el.scrollHeight - el.clientHeight - height - 25;
    return el.scrollTop;
  });
  await expect(dock).toBeVisible();
  // Real flex layout changes (not stubbed clientHeight) must not feed back
  // into visibility or move the reader's top position.
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
  expect((await dock.boundingBox())!.y).toBeGreaterThanOrEqual(viewportBottom);
  await page.getByRole('button', { name: 'Jump to latest' }).click();
  await expect(dock).toHaveCount(0);
  await expect.poll(() => scroll.evaluate(el => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop))).toBeLessThanOrEqual(1);
});
