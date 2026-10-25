// Offline regression: real built renderer, browser decoder and Viewer.js (no SDK).
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

// Two solid-color frames, encoded with a clear code before each pixel so no
// LZW dictionary or external fixture-generation dependency is needed.
function animatedGif(): string {
  const width = 320, height = 240;
  const word = (value: number) => Buffer.from([value & 255, value >> 8]);
  const frames = [0, 1].map(color => {
    const codes = Array.from({ length: width * height }, () => [4, color]).flat();
    codes.push(5);
    const packed = Buffer.alloc(Math.ceil(codes.length * 3 / 8));
    codes.forEach((code, index) => {
      const bit = index * 3;
      packed[bit >> 3] |= code << (bit % 8);
      if (bit % 8 > 5) packed[(bit >> 3) + 1] |= code >> (8 - bit % 8);
    });
    const blocks: Buffer[] = [];
    for (let offset = 0; offset < packed.length; offset += 255) {
      const block = packed.subarray(offset, offset + 255);
      blocks.push(Buffer.from([block.length]), block);
    }
    return Buffer.concat([Buffer.from([0x21, 0xf9, 4, 0, 12, 0, 0, 0, 0x2c]),
      word(0), word(0), word(width), word(height), Buffer.from([0, 2]), ...blocks, Buffer.from([0])]);
  });
  return Buffer.concat([Buffer.from('GIF89a'), word(width), word(height),
    Buffer.from([0x80, 0, 0, 240, 20, 20, 20, 20, 240]),
    Buffer.from([0x21, 0xff, 11]), Buffer.from('NETSCAPE2.0'), Buffer.from([3, 1, 0, 0, 0]),
    ...frames, Buffer.from([0x3b])]).toString('base64');
}

const animation = animatedGif();

const toolCall = {
  id: 'synthetic-read', name: 'read', input: { path: 'synthetic.png' }, status: 'completed' as const,
  result: { content: [{ type: 'image', mimeType: 'image/png', data: raster }] },
};

test.use({ viewState: {
  imageActionCapabilities: { copy: true, openInBrowser: true, reveal: true },
  transcript: [{ id: 'synthetic-raster', role: 'user', createdAt: '2026-10-24T00:00:00.000Z', markdown: '',
    userParts: [{ kind: 'image', mimeType: 'image/png', dataBase64: raster, name: 'Synthetic four-color raster', width: 640, height: 480 },
      { kind: 'image', mimeType: 'image/png', dataBase64: Buffer.from('Not a decodable PNG').toString('base64'), name: 'Corrupt raster', width: 640, height: 480 },
      { kind: 'image', mimeType: 'image/gif', dataBase64: animation, name: 'Animated colors', width: 320, height: 240 }], status: 'completed' },
    { id: 'synthetic-tool', role: 'assistant', createdAt: '2026-10-24T00:00:01.000Z',
      markdown: 'Local image: `synthetic.png`', parts: [{ kind: 'text', text: 'Local image: `synthetic.png`' }, { kind: 'toolCall', toolCall }], toolCalls: [toolCall], status: 'completed' }],
  transcriptWindow: { ...EMPTY_VIEW_STATE.transcriptWindow, totalCount: 2, loadedEnd: 2, hasUserMessages: true },
} });

test('stock viewer wheel-zooms, rotates and resets the raster', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto('/');
  const thumbnail = page.getByRole('button', { name: 'Synthetic four-color raster', exact: true });
  await thumbnail.click();
  const viewer = page.locator('.viewer-container');
  const displayed = viewer.locator('.viewer-canvas > img');
  await expect(displayed).toBeVisible();
  await expect.poll(() => displayed.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 640)).toBe(true);
  const initialWidth = (await displayed.boundingBox())!.width;
  await page.mouse.move(400, 300);
  await page.mouse.wheel(0, -240);
  await expect.poll(async () => (await displayed.boundingBox())!.width).toBeGreaterThan(initialWidth);
  await viewer.locator('.viewer-rotate-right').click();
  await expect.poll(() => displayed.evaluate(image => image.style.transform)).toContain('rotate(90deg)');
  await viewer.locator('.viewer-reset').click();
  await expect.poll(() => displayed.evaluate(image => image.style.transform)).not.toContain('rotate(90deg)');
  await expect.poll(async () => (await displayed.boundingBox())!.width).toBeCloseTo(initialWidth, 0);
});

for (const mimeType of ['image/jpeg', 'image/webp'] as const) {
  test(`${mimeType} transcript image loads and zooms in the real viewer`, async ({ page, isolatedHost }) => {
    await page.setViewportSize({ width: 500, height: 400 });
    await page.goto('/');
    const dataUrl = await page.evaluate((mime) => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#e8a864';
      context.fillRect(0, 0, 320, 480);
      context.fillStyle = '#193264';
      context.fillRect(320, 0, 320, 480);
      return canvas.toDataURL(mime);
    }, mimeType);
    const dataBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    isolatedHost.publishState({
      transcript: [{ id: `synthetic-${mimeType}`, role: 'user', createdAt: '2026-10-24T00:00:00.000Z', markdown: '',
        userParts: [{ kind: 'image', mimeType, dataBase64, name: `${mimeType} raster`, width: 640, height: 480 }], status: 'completed' }],
      transcriptWindow: { ...EMPTY_VIEW_STATE.transcriptWindow, totalCount: 1, loadedEnd: 1, hasUserMessages: true },
    });
    const thumbnail = page.getByRole('button', { name: `${mimeType} raster`, exact: true });
    await expect(thumbnail).toBeVisible();
    await thumbnail.click();
    const viewer = page.locator('.viewer-container');
    const displayed = viewer.locator('.viewer-canvas > img');
    await expect(displayed).toBeVisible();
    await expect.poll(() => displayed.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 640)).toBe(true);
    const initialWidth = (await displayed.boundingBox())!.width;
    await viewer.locator('.viewer-zoom-in').click();
    await expect.poll(async () => (await displayed.boundingBox())!.width).toBeGreaterThan(initialWidth);
  });
}

test('transcript raster remains visible inside real Viewer.js, zooms, pans and closes with Escape', async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 400 });
  await page.goto('/');
  const thumbnail = page.getByRole('button', { name: 'Synthetic four-color raster', exact: true });
  await expect(thumbnail).toBeVisible();
  await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 640)).toBe(true);
  await thumbnail.click();
  const viewer = page.locator('.viewer-container');
  await expect(viewer).toBeVisible();
  const displayed = viewer.locator('.viewer-canvas > img');
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
  await viewer.locator('.viewer-zoom-in').click();
  await expect.poll(async () => (await displayed.boundingBox())?.width ?? 0).toBeGreaterThan(layout.image.rect.width);
  await displayed.evaluate(async image => { await Promise.all(image.getAnimations().map(animation => animation.finished)); });
  const beforePan = (await displayed.boundingBox())!;
  await page.mouse.move(beforePan.x + beforePan.width / 2, beforePan.y + beforePan.height / 2);
  await page.mouse.down();
  await page.mouse.move(beforePan.x + beforePan.width / 2 + 45, beforePan.y + beforePan.height / 2 + 30, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs((await displayed.boundingBox())!.x - beforePan.x)).toBeGreaterThan(20);
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
      const viewer = page.locator('.viewer-container');
      const displayed = viewer.locator('.viewer-canvas > img');
      await expect(viewer).toBeVisible();
      await expect(displayed).toBeVisible();
      await expect.poll(() => displayed.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 640)).toBe(true);
      const toolbar = viewer.locator('.viewer-toolbar');
      await expect(toolbar).toBeVisible();
      const toolbarButtons = toolbar.locator('[role="button"]:visible');
      expect(await toolbarButtons.count()).toBeGreaterThan(0);
      const buttonLayouts = await toolbarButtons.evaluateAll(buttons => buttons.map(button => {
        const rect = button.getBoundingClientRect();
        return { isPlay: button.classList.contains('viewer-play'), rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } };
      }));
      expect(buttonLayouts.every(({ rect }) => rect.left >= 0 && rect.right <= 320 && rect.top >= 0 && rect.bottom <= 900)).toBe(true);
      const alignedButtons = buttonLayouts.filter(({ isPlay }) => !isPlay);
      expect(alignedButtons.length).toBeGreaterThan(0);
      expect(alignedButtons.every(({ rect }) => Math.abs(rect.top - alignedButtons[0]!.rect.top) <= 1)).toBe(true);
      await expect(viewer.locator('.viewer-zoom-in')).toBeVisible();
      const closeBounds = await viewer.locator('.viewer-close').boundingBox();
      expect(closeBounds!.x).toBeLessThan(320);
      const bounds = await displayed.boundingBox();
      expect(bounds!.width).toBeGreaterThan(0);
      expect(bounds!.height).toBeGreaterThan(0);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
      await viewer.locator('.viewer-zoom-in').click();
      await expect.poll(async () => (await displayed.boundingBox())?.width ?? 0).toBeGreaterThan(bounds!.width);
      await viewer.locator('.viewer-close').click();
      await expect(viewer).toHaveCount(0);
      if (branch === 'tool result') await expect(trigger).toBeFocused();
    });
  }
}

test('animated GIF keeps changing frames after viewer zoom and real drag-pan', async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 400 });
  await page.goto('/');
  const thumbnail = page.getByRole('button', { name: 'Animated colors', exact: true });
  await thumbnail.click();
  const viewer = page.locator('.viewer-container');
  const displayed = viewer.locator('.viewer-canvas > img');
  await expect(displayed).toBeVisible();
  await expect.poll(() => displayed.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 320)).toBe(true);
  await page.mouse.move(0, 0);
  const screenshotFrame = () => displayed.screenshot({ animations: 'allow' });
  const assertAnimationAdvances = async () => {
    const firstFrame = await screenshotFrame();
    await expect.poll(async () => !(await screenshotFrame()).equals(firstFrame)).toBe(true);
  };
  await assertAnimationAdvances();
  const initial = (await displayed.boundingBox())!;
  await viewer.locator('.viewer-zoom-in').click();
  await expect.poll(async () => (await displayed.boundingBox())!.width).toBeGreaterThan(initial.width);
  await displayed.evaluate(async image => { await Promise.all(image.getAnimations().map(animation => animation.finished)); });
  const zoomed = (await displayed.boundingBox())!;
  await page.mouse.move(zoomed.x + zoomed.width / 2, zoomed.y + zoomed.height / 2);
  await page.mouse.down();
  await page.mouse.move(zoomed.x + zoomed.width / 2 + 45, zoomed.y + zoomed.height / 2 + 30, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs((await displayed.boundingBox())!.x - zoomed.x)).toBeGreaterThan(20);
  await page.mouse.move(0, 0);
  await assertAnimationAdvances();
  await viewer.locator('.viewer-close').click();
  await expect(viewer).toHaveCount(0);
  await expect(thumbnail).toBeFocused();
});

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
  await thumbnail.click({ button: 'right' });
  await expect(page.locator('.viewer-container')).toHaveCount(0);
  const copy = page.getByRole('menuitem', { name: 'Copy image', exact: true });
  await copy.click();
  const status = page.getByRole('status').filter({ hasText: 'Working…' });
  await expect(status).toHaveText('Working…');
  await expect.poll(() => Boolean(failAction)).toBe(true);
  failAction!();
  await expect(page.getByRole('alert').filter({ hasText: 'Clipboard unavailable' })).toBeVisible();
  await expect(page.locator('.viewer-container')).toHaveCount(0);
});

test('decoder failure has readable stage error and permits recovery', async ({ page }) => {
  await page.goto('/');
  const broken = page.getByRole('button', { name: 'Corrupt raster', exact: true });
  await expect(broken).toBeVisible();
  await broken.click();
  const viewer = page.locator('.viewer-container');
  await expect(page.getByRole('alert').filter({ hasText: 'Image could not be loaded.' })).toBeVisible();
  await expect(viewer).toHaveCount(0);
  await expect(broken).toBeFocused();
  await page.getByRole('button', { name: 'Synthetic four-color raster', exact: true }).click();
  const displayed = viewer.locator('.viewer-canvas > img');
  await expect(displayed).toBeVisible();
  await expect.poll(() => displayed.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 640)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
});
