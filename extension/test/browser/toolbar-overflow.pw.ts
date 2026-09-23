// Playwright-only spec; the .pw.ts suffix keeps it out of pie's node:test discovery.
import { expect, test, type Page } from '@playwright/test';

interface BrowserSocketWindow extends Window {
  __pieTestSockets?: WebSocket[];
}

async function captureBrowserSockets(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const socketWindow = window as BrowserSocketWindow;
    const NativeWebSocket = window.WebSocket;
    socketWindow.__pieTestSockets = [];
    class TrackedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        socketWindow.__pieTestSockets?.push(this);
      }
    }
    window.WebSocket = TrackedWebSocket;
  });
}

async function openComposer(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await expect(page.locator('.composer-bottom-bar')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Model' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reasoning level' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function getToolbarHitboxOverlaps(page: Page): Promise<Array<{ a: string; b: string; overlapX: number; overlapY: number }>> {
  return page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll<HTMLElement>(
      '.composer-bottom-bar button, .composer-bottom-bar [role="button"]',
    )).filter((element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    });
    const hitboxes = controls.map((element) => {
      const rect = element.getBoundingClientRect();
      const pseudo = getComputedStyle(element, '::before');
      const inset = (side: 'top' | 'right' | 'bottom' | 'left') => {
        const value = Number.parseFloat(pseudo[side]);
        return Number.isFinite(value) ? value : 0;
      };
      return {
        name: element.getAttribute('aria-label') || element.textContent?.trim() || element.className.toString(),
        left: rect.left + inset('left'),
        right: rect.right - inset('right'),
        top: rect.top + inset('top'),
        bottom: rect.bottom - inset('bottom'),
      };
    });
    const overlaps: Array<{ a: string; b: string; overlapX: number; overlapY: number }> = [];
    for (let first = 0; first < hitboxes.length; first += 1) {
      for (let second = first + 1; second < hitboxes.length; second += 1) {
        const a = hitboxes[first]!;
        const b = hitboxes[second]!;
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapX > 0.25 && overlapY > 0.25) {
          overlaps.push({ a: a.name, b: b.name, overlapX, overlapY });
        }
      }
    }
    return overlaps;
  });
}

test.describe('composer toolbar overflow in Chromium', () => {
  test('keeps pinned controls and every visible hitbox separate at phone widths', async ({ page }) => {
    for (const width of [390, 320, 240]) {
      await openComposer(page, width, 640);
      await expect(page.getByRole('button', { name: 'More composer options' })).toBeVisible();
      const modelLabel = page.locator('.composer-pinned-controls .model-picker-trigger-label');
      await expect(modelLabel).toBeVisible();
      const modelTextWidth = await modelLabel.evaluate((element) => element.getBoundingClientRect().width);
      expect(modelTextWidth, `model text width at ${width}px`).toBeGreaterThan(8);
      if (width === 240) expect(modelTextWidth, 'model text yields before pinned controls').toBeLessThan(30);
      expect(await page.getByRole('button', { name: 'Model' }).evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(28);
      expect(await page.getByRole('button', { name: 'Settings', exact: true }).evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(26);
      expect(await page.getByRole('button', { name: 'Reasoning level' }).evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(42);
      expect(await getToolbarHitboxOverlaps(page), `toolbar hitboxes at ${width}px`).toEqual([]);
    }
  });

  test('overflow remains usable while disconnected and does not disable status indicators', async ({ context, page }) => {
    await captureBrowserSockets(page);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/');
    await expect(page.locator('.composer-bottom-bar')).toBeVisible();
    await expect(page.getByRole('button', { name: 'More composer options' })).toBeVisible();

    // Complete the close handshake before blocking reconnection: going offline
    // first can strand the socket in CLOSING without notifying the transport.
    await page.evaluate(() => {
      const sockets = (window as BrowserSocketWindow).__pieTestSockets ?? [];
      sockets.at(-1)?.close(1000, 'toolbar overflow browser regression');
    });
    await expect(page.locator('[data-connection-banner]')).toContainText('Reconnecting');
    await context.setOffline(true);

    const trigger = page.getByRole('button', { name: 'More composer options' });
    await expect(trigger).toBeEnabled();
    await trigger.click();
    const popover = page.getByRole('dialog', { name: 'Additional composer options' });
    await expect(popover).toBeVisible();
    await expect(page.getByRole('button', { name: /Enable autonomous mode|Autonomous mode on/ })).toBeDisabled();

    const indicator = popover.locator('.composer-toolbar-indicator-item [tabindex="0"]').first();
    await expect(indicator).toBeVisible();
    expect(await indicator.evaluate((element) => element.closest('fieldset:disabled'))).toBeNull();
    await indicator.focus();
    await expect(indicator).toBeFocused();
    await context.setOffline(false);
  });

  test('keeps the short-height overflow panel bounded and treats its rich tooltip as owned', async ({ page }) => {
    await openComposer(page, 390, 300);
    await page.getByRole('button', { name: 'More composer options' }).click();
    const popover = page.getByRole('dialog', { name: 'Additional composer options' });
    await expect(popover).toBeVisible();
    const bounds = await popover.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        viewportHeight: window.innerHeight,
        overflowY: getComputedStyle(element).overflowY,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      };
    });
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight + 0.5);
    expect(bounds.overflowY).toBe('auto');
    if (bounds.scrollHeight > bounds.clientHeight) {
      expect(bounds.clientHeight).toBeGreaterThan(0);
    }

    const contextIndicator = popover.locator('[data-toolbar-item="context-window"] [tabindex="0"]');
    test.skip(await contextIndicator.count() === 0, 'the attached session has no context-window indicator');
    await contextIndicator.scrollIntoViewIfNeeded();
    await contextIndicator.hover();
    const tooltip = page.locator('.pie-tooltip-host--rich:visible');
    await expect(tooltip).toBeVisible();
    const tooltipOwner = await tooltip.getAttribute('data-composer-toolbar-overflow-owner');
    const overflowOwner = await popover.getAttribute('data-composer-toolbar-overflow-owner');
    expect(tooltipOwner).toBeTruthy();
    expect(tooltipOwner).toBe(overflowOwner);

    const legendEntry = tooltip.locator('.ctx-legend-item').first();
    if (await legendEntry.count() > 0) await legendEntry.click();
    await expect(popover).toBeVisible();

    const browserTrigger = popover.getByRole('button', { name: 'Browser network access' });
    await browserTrigger.scrollIntoViewIfNeeded();
    await browserTrigger.click();
    const browserPopover = page.getByRole('dialog', { name: 'Browser network access' });
    await expect(browserPopover).toBeVisible();
    const nestedBounds = await browserPopover.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
    });
    expect(nestedBounds.top).toBeGreaterThanOrEqual(0);
    expect(nestedBounds.left).toBeGreaterThanOrEqual(0);
    expect(nestedBounds.right).toBeLessThanOrEqual(390);
    expect(nestedBounds.bottom).toBeLessThanOrEqual(300);
    await expect(popover).toBeVisible();
  });
});
