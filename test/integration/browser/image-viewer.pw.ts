// Offline regression: real built renderer, browser decoder and PhotoSwipe (no SDK).
import { deflateSync } from 'node:zlib';
import { test, expect } from './ui-smoke-fixtures.js';
import { EMPTY_VIEW_STATE } from '../../../application/frontend/lib/hooks/use-host-sync.js';

function rasterPng(): string {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(640, 0); header.writeUInt32BE(480, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(480 * (1 + 640 * 3));
  for (let y = 0; y < 480; y++) for (let x = 0; x < 640; x++) {
    const offset = y * (1 + 640 * 3) + 1 + x * 3;
    pixels[offset] = x < 320 ? 240 : 25;
    pixels[offset + 1] = y < 240 ? 170 : 50;
    pixels[offset + 2] = 100;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

const raster = rasterPng();

const toolCall = {
  id: 'synthetic-read', name: 'read', input: { path: 'synthetic.png' }, status: 'completed' as const,
  result: { content: [{ type: 'image', mimeType: 'image/png', data: raster }] },
};

test.use({ viewState: {
  imageActionCapabilities: { copy: true, openInBrowser: true, reveal: true },
  transcript: [{ id: 'synthetic-raster', role: 'user', createdAt: '2026-10-24T00:00:00.000Z', markdown: '',
    userParts: [{ kind: 'image', mimeType: 'image/png', dataBase64: raster, name: 'Synthetic four-color raster', width: 640, height: 480 },
      { kind: 'image', mimeType: 'image/png', dataBase64: Buffer.from('Not a decodable PNG').toString('base64'), name: 'Corrupt raster', width: 640, height: 480 }], status: 'completed' },
    { id: 'synthetic-tool', role: 'assistant', createdAt: '2026-10-24T00:00:01.000Z',
      markdown: 'Local image: `synthetic.png`', parts: [{ kind: 'text', text: 'Local image: `synthetic.png`' }, { kind: 'toolCall', toolCall }], toolCalls: [toolCall], status: 'completed' }],
  transcriptWindow: { ...EMPTY_VIEW_STATE.transcriptWindow, totalCount: 2, loadedEnd: 2, hasUserMessages: true },
} });

test('transcript raster remains visible inside real PhotoSwipe, zooms and closes with Escape', async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 400 });
  await page.goto('/');
  const thumbnail = page.getByRole('button', { name: 'Synthetic four-color raster', exact: true });
  await expect(thumbnail).toBeVisible();
  await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 640)).toBe(true);
  await thumbnail.click();
  const viewer = page.locator('.pswp.pie-image-viewer');
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('.image-viewer-status')).toBeHidden();
  const displayed = viewer.locator('.pswp__img:not(.pswp__img--placeholder)');
  await expect(displayed).toHaveCount(1);
  await expect.poll(() => displayed.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 640)).toBe(true);
  const layout = await displayed.evaluate(image => {
    return { viewport: { width: innerWidth, height: innerHeight }, image: { rect: image.getBoundingClientRect().toJSON() } };
  });
  expect.soft(layout.image.rect.width, 'loaded viewer image must have nonzero width').toBeGreaterThan(0);
  expect.soft(layout.image.rect.height, 'loaded viewer image must have nonzero height').toBeGreaterThan(0);
  expect.soft(layout.image.rect.left).toBeGreaterThanOrEqual(0);
  expect.soft(layout.image.rect.top).toBeGreaterThanOrEqual(0);
  expect.soft(layout.image.rect.right).toBeLessThanOrEqual(layout.viewport.width);
  expect.soft(layout.image.rect.bottom).toBeLessThanOrEqual(layout.viewport.height);
  await viewer.getByRole('button', { name: 'Zoom', exact: true }).click();
  await expect(viewer).toHaveClass(/pswp--zoomed-in/);
  await expect.poll(async () => (await displayed.boundingBox())?.width ?? 0).toBeGreaterThan(layout.image.rect.width);
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(thumbnail).toBeFocused();
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  for (const branch of ['tool result', 'local path preview'] as const) {
    test(`${branch} displays, zooms and closes in narrow tall viewport (${reducedMotion})`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 900 });
      await page.emulateMedia({ reducedMotion });
      // Only the ephemeral host preview response is synthetic; the handshake,
      // transcript, hover ownership, image decoder and viewer are real.
      await page.routeWebSocket('**/*', socket => {
        const server = socket.connectToServer();
        socket.onMessage(raw => {
          const message = JSON.parse(String(raw));
          if (message.type === 'requestImagePreview') {
            socket.send(JSON.stringify({ type: 'imagePreviewResult', requestId: message.requestId,
              sessionPath: message.sessionPath, viewGeneration: message.viewGeneration,
              status: 'ready', data: { mimeType: 'image/png', dataUrl: `data:image/png;base64,${raster}` } }));
          } else server.send(raw);
        });
      });
      await page.goto('/');
      let trigger = page.locator('.tool-call-result-image');
      if (branch === 'local path preview') {
        await page.getByText('synthetic.png', { exact: true }).first().hover();
        trigger = page.locator('.image-path-preview img');
      } else {
        await page.getByRole('button', { name: /read tool call, Completed.*Expand details/ }).click();
      }
      await expect(trigger).toBeVisible();
      await trigger.click();
      const viewer = page.locator('.pswp.pie-image-viewer');
      const displayed = viewer.locator('.pswp__img:not(.pswp__img--placeholder)');
      await expect(viewer).toBeVisible();
      await expect(displayed).toBeVisible();
      await expect.poll(() => displayed.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 640)).toBe(true);
      const toolbar = viewer.locator('.pswp__top-bar');
      await expect(toolbar).toBeVisible();
      expect((await toolbar.boundingBox())?.height).toBe(60);
      const toolbarButtons = viewer.locator('.pswp__top-bar .pswp__button:visible');
      await expect(toolbarButtons).toHaveCount(5);
      const buttonLayouts = await toolbarButtons.evaluateAll(buttons => buttons.map(button => {
        const rect = button.getBoundingClientRect();
        const icon = button.querySelector('svg.pswp__icn');
        const iconRect = icon?.getBoundingClientRect();
        return { rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
          icon: Boolean(icon && iconRect && iconRect.width > 0 && iconRect.height > 0 && getComputedStyle(icon).visibility !== 'hidden') };
      }));
      expect(buttonLayouts.every(({ rect }) => rect.left >= 0 && rect.right <= 320 && rect.top >= 0 && rect.bottom <= 900)).toBe(true);
      expect(buttonLayouts.every(({ rect }) => Math.abs(rect.top - buttonLayouts[0]!.rect.top) <= 1)).toBe(true);
      expect(buttonLayouts.every(({ icon }) => icon)).toBe(true);
      const zoomBounds = await viewer.getByRole('button', { name: 'Zoom', exact: true }).boundingBox();
      const closeBounds = await viewer.getByRole('button', { name: 'Close', exact: true }).boundingBox();
      expect(zoomBounds!.x).toBeGreaterThan(buttonLayouts[0]!.rect.left);
      expect(closeBounds!.x).toBeGreaterThan(zoomBounds!.x);
      expect(closeBounds!.x + closeBounds!.width).toBeLessThanOrEqual(320);
      const status = viewer.locator('.image-viewer-status');
      await expect(status).toBeAttached();
      expect(await status.evaluate(element => element.parentElement === element.closest('.pswp'))).toBe(true);
      const bounds = await displayed.boundingBox();
      expect(bounds!.width).toBeGreaterThan(0);
      expect(bounds!.height).toBeGreaterThan(0);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
      await viewer.getByRole('button', { name: 'Zoom', exact: true }).click();
      await expect.poll(async () => (await displayed.boundingBox())?.width ?? 0).toBeGreaterThan(bounds!.width);
      await viewer.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(viewer).toHaveCount(0);
    });
  }
}

test('native image action shows pending and isolated WebSocket error status', async ({ page }) => {
  let failAction: (() => void) | undefined;
  await page.routeWebSocket('**/*', socket => {
    const server = socket.connectToServer();
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'performImageAction') {
        failAction = () => socket.send(JSON.stringify({ type: 'imageActionResult', requestId: message.requestId,
          success: false, error: 'Clipboard unavailable' }));
      } else server.send(raw);
    });
  });
  await page.goto('/');
  const thumbnail = page.getByRole('button', { name: 'Synthetic four-color raster', exact: true });
  await thumbnail.click();
  const viewer = page.locator('.pswp.pie-image-viewer');
  await expect(viewer).toBeVisible();
  const copy = viewer.getByRole('button', { name: 'Copy image', exact: true });
  await copy.click();
  await expect(copy).toBeDisabled();
  const status = viewer.locator('.image-viewer-status');
  await expect(status).toHaveText('Working…');
  await expect.poll(() => Boolean(failAction)).toBe(true);
  failAction!();
  await expect(copy).toBeEnabled();
  await expect(status).toHaveText('Clipboard unavailable');
  await expect(status).toHaveCSS('pointer-events', 'none');
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
});

test('decoder failure has readable stage error and permits recovery', async ({ page }) => {
  await page.goto('/');
  const broken = page.getByRole('button', { name: 'Corrupt raster', exact: true });
  await expect(broken).toBeVisible();
  await broken.click();
  const viewer = page.locator('.pswp.pie-image-viewer');
  await expect(viewer).toBeVisible();
  const error = viewer.locator('.pswp__error-msg');
  await expect(error).toBeAttached();
  await expect.soft(error).toHaveText('Image could not be loaded.');
  await expect.soft(error).toBeVisible();
  await expect(viewer.locator('.image-viewer-status')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(broken).toBeFocused();
  await broken.click();
  await expect(viewer).toBeVisible();
  await viewer.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(viewer).toHaveCount(0);
  await page.getByRole('button', { name: 'Synthetic four-color raster', exact: true }).click();
  const displayed = viewer.locator('.pswp__img:not(.pswp__img--placeholder)');
  await expect(displayed).toBeVisible();
  await expect.poll(() => displayed.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 640)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
});
