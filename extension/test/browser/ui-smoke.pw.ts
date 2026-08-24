// Playwright-only spec; the .pw.ts suffix keeps it out of pie's node:test discovery.
import { expect, test, type Page } from '@playwright/test';

interface BrowserSocketWindow extends Window {
  __pieTestSockets?: WebSocket[];
}

function captureUnexpectedErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
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

async function expectReadySurface(page: Page): Promise<void> {
  await expect(page.getByRole('textbox', { name: 'Message composer' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New session' })).toBeEnabled();
  await expect(page.locator('[data-connection-banner]')).toHaveCount(0);
}

test.describe('pie browser UI no-spend smoke', () => {
  test('loads and survives a full page reload', async ({ page }) => {
    const errors = captureUnexpectedErrors(page);
    await page.goto('/');
    await expectReadySurface(page);

    await page.reload();
    await expectReadySurface(page);
    expect(errors).toEqual([]);
  });

  test('keeps two renderer tabs independently usable', async ({ context, page }) => {
    const firstErrors = captureUnexpectedErrors(page);
    await page.goto('/');
    await expectReadySurface(page);

    const second = await context.newPage();
    const secondErrors = captureUnexpectedErrors(second);
    await second.goto('/');
    await expectReadySurface(second);

    await second.bringToFront();
    await expect(second.getByRole('textbox', { name: 'Message composer' })).toBeEditable();
    await page.bringToFront();
    await expect(page.getByRole('textbox', { name: 'Message composer' })).toBeEditable();
    expect([...firstErrors, ...secondErrors]).toEqual([]);
  });

  test('recovers after the browser context goes offline', async ({ context, page }) => {
    const errors = captureUnexpectedErrors(page);
    await captureBrowserSockets(page);
    await page.goto('/');
    await expectReadySurface(page);

    await context.setOffline(true);
    await page.evaluate(() => {
      const sockets = (window as BrowserSocketWindow).__pieTestSockets ?? [];
      sockets.at(-1)?.close(1000, 'playwright offline test');
    });
    await expect(page.locator('[data-connection-banner]')).toContainText('Reconnecting');
    await expect(page.getByRole('button', { name: 'New session' })).toBeDisabled();

    await context.setOffline(false);
    await expectReadySurface(page);
    expect(errors).toEqual([]);
  });

  test('keeps core controls reachable at phone and tablet sizes', async ({ page }) => {
    const errors = captureUnexpectedErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expectReadySurface(page);
    await expect(page.getByRole('textbox', { name: 'Message composer' })).toBeInViewport();

    await page.setViewportSize({ width: 820, height: 1_180 });
    await expectReadySurface(page);
    await expect(page.getByRole('textbox', { name: 'Message composer' })).toBeInViewport();
    expect(errors).toEqual([]);
  });
});
