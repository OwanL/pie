// Real renderer, illustrative transcript, no SDK or provider calls.
import { expect, test } from './ui-smoke-fixtures.js';
import { EMPTY_VIEW_STATE } from '../../../application/frontend/lib/hooks/use-host-sync.js';

const prompts = [
  'Investigate the image viewer.',
  'Use PhotoSwipe and preserve the native controls.',
  'Keep the image viewer familiar, with standard controls and less bespoke UI. '.repeat(6).trim(),
];
const transcript = prompts.flatMap((markdown, index) => [
  {
    id: `prompt-${index}`, role: 'user' as const, markdown,
    status: 'completed' as const, createdAt: '2026-10-25T12:00:00Z',
  },
  {
    id: `response-${index}`, role: 'assistant' as const,
    markdown: Array.from({ length: 30 }, (_, paragraph) => `Check ${paragraph + 1}: reviewing image loading, keyboard navigation, and the native toolbar.`).join('\n\n'),
    status: 'completed' as const, createdAt: '2026-10-25T12:00:00Z',
  },
]);

test.use({
  viewState: {
    transcript,
    transcriptWindow: { ...EMPTY_VIEW_STATE.transcriptWindow, totalCount: transcript.length, loadedEnd: transcript.length, hasUserMessages: true },
  },
});

for (const width of [390, 1440]) {
  test(`sticky prompt stays quiet and reveals stable navigation at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const scroll = page.locator('.transcript-virtual');
    await expect(scroll).not.toHaveClass(/transcript-positioning/);
    await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const bar = page.getByRole('region', { name: 'User prompt context' });
    const preview = bar.locator('.transcript-prompt-context-preview');
    const previous = bar.getByRole('button', { name: 'Previous prompt', exact: true });
    const next = bar.getByRole('button', { name: 'Next prompt', exact: true });
    await expect(preview).toHaveText(prompts[2]!);
    await expect(previous).toBeEnabled();
    await expect(next).toBeDisabled();
    await expect(bar.locator('.transcript-prompt-context-meta, .transcript-prompt-navigation-position, svg')).toHaveCount(0);
    await page.mouse.move(0, 899);
    await expect(previous).toHaveCSS('opacity', '0');
    await expect(next).toHaveCSS('opacity', '0');
    await expect(preview).toHaveCSS('text-align', 'right');
    await expect(preview).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const restingBounds = await preview.boundingBox();
    expect(restingBounds).not.toBeNull();
    const barBounds = (await bar.boundingBox())!;
    const rowBounds = (await bar.locator('.transcript-prompt-context-row').boundingBox())!;
    const rightPadding = await bar.evaluate(el => Number.parseFloat(getComputedStyle(el).paddingRight));
    expect(Math.abs(rowBounds.x + rowBounds.width - (barBounds.x + barBounds.width - rightPadding))).toBeLessThanOrEqual(1);
    expect(await preview.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);

    await preview.hover();
    await expect(previous).toHaveCSS('opacity', '1');
    expect(await preview.boundingBox()).toEqual(restingBounds);
    await page.mouse.move(0, 899);
    await previous.focus();
    await expect(previous).toHaveCSS('opacity', '1');
    expect(await preview.boundingBox()).toEqual(restingBounds);

    const fade = await bar.evaluate(el => {
      const style = getComputedStyle(el, '::after');
      return { top: style.top, height: style.height, background: style.backgroundImage, pointerEvents: style.pointerEvents };
    });
    expect(fade.top).toBe(`${barBounds.height}px`);
    expect(fade.height).toBe('8px');
    expect(fade.background).toContain('linear-gradient');
    expect(fade.pointerEvents).toBe('none');

    await previous.press('Enter');
    await expect(page.locator('[data-message-id="prompt-1"]')).toBeInViewport();
    await expect(next).toBeEnabled();
    await preview.focus();
    await expect(previous).toHaveCSS('opacity', '1');
    await page.screenshot({ path: info.outputPath(`sticky-prompt-${width}.png`) });

    await page.emulateMedia({ forcedColors: 'active' });
    expect(await bar.evaluate(el => getComputedStyle(el, '::after').display)).toBe('none');
  });
}

test('touch navigation is discoverable without hover', async ({ browser, isolatedHost }) => {
  const context = await browser.newContext({ baseURL: isolatedHost.url, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await page.goto('/');
    const scroll = page.locator('.transcript-virtual');
    await expect(scroll).not.toHaveClass(/transcript-positioning/);
    await scroll.evaluate(el => { el.scrollTop = 0; });
    const previous = page.getByRole('button', { name: 'Previous prompt', exact: true });
    const next = page.getByRole('button', { name: 'Next prompt', exact: true });
    await expect(next).toBeEnabled();
    await expect(next).toHaveCSS('opacity', '1');
    await next.tap();
    await expect(previous).toBeEnabled();
    await expect(previous).toHaveCSS('opacity', '1');
    await expect(page.locator('[data-message-id="prompt-1"]')).toBeInViewport();
  } finally {
    await context.close();
  }
});
