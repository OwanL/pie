import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { requireComputerUseDependency } from '../dependency-owner.mjs';
import * as computer from '../image.mjs';
import * as playwright from '../../playwright/image.mjs';

const { PNG } = requireComputerUseDependency('pngjs');

async function imageFixture(width: number, height: number, run: (dir: string, source: string, bytes: Buffer) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pie-png-'));
  try {
    const image = new PNG({ width, height });
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i] = (i / 4) % 256;
      image.data[i + 1] = 73; image.data[i + 2] = 149; image.data[i + 3] = 127;
    }
    // A different compression level makes no-resize byte copying distinguishable from re-encoding.
    const bytes = PNG.sync.write(image, { deflateLevel: 0 });
    const source = path.join(dir, 'full.png');
    await writeFile(source, bytes);
    await run(dir, source, bytes);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

for (const [name, tools] of Object.entries({ computer, playwright })) {
  test(`${name}: rounded nearest-neighbor scaling preserves RGBA and original bytes`, async () => {
    await imageFixture(7, 3, async (dir, source, bytes) => {
      const display = path.join(dir, 'display.png');
      await writeFile(display, 'old display');
      assert.deepEqual(await tools.pngDimensions(source), { width: 7, height: 3 });
      assert.deepEqual(await tools.createDisplayPng(source, display, 4), { width: 4, height: 2, sourceWidth: 7, sourceHeight: 3 });
      assert.deepEqual(await tools.pngDimensions(display), { width: 4, height: 2 });
      const output = PNG.sync.read(await readFile(display));
      const original = PNG.sync.read(bytes);
      for (let y = 0; y < 2; y += 1) {
        for (let x = 0; x < 4; x += 1) {
          const from = (Math.floor(y / (4 / 7)) * 7 + Math.floor(x / (4 / 7))) * 4;
          const to = (y * 4 + x) * 4;
          assert.deepEqual(output.data.subarray(to, to + 4), original.data.subarray(from, from + 4));
        }
      }
      assert.deepEqual(await readFile(source), bytes);
      assert.deepEqual((await readdir(dir)).sort(), ['display.png', 'full.png']);
    });
  });

  test(`${name}: default bound does not upscale; only Playwright copies unscaled bytes`, async () => {
    await imageFixture(3, 2, async (dir, source, bytes) => {
      const display = path.join(dir, 'display.png');
      assert.deepEqual(await tools.createDisplayPng(source, display), { width: 3, height: 2, sourceWidth: 3, sourceHeight: 2 });
      const output = await readFile(display);
      if (name === 'playwright') assert.deepEqual(output, bytes);
      else assert.deepEqual(output, PNG.sync.write(PNG.sync.read(bytes)));
      assert.deepEqual(await readFile(source), bytes);
    });
  });

  test(`${name}: portrait scaling keeps the short edge at least one pixel`, async () => {
    await imageFixture(1, 9, async (dir, source) => {
      const display = path.join(dir, 'display.png');
      assert.deepEqual(await tools.createDisplayPng(source, display, 2), { width: 1, height: 2, sourceWidth: 1, sourceHeight: 9 });
      assert.deepEqual(await tools.pngDimensions(display), { width: 1, height: 2 });
    });
  });

  test(`${name}: failed publication cleans temporary files without changing source or destination`, async () => {
    await imageFixture(3, 2, async (dir, source, bytes) => {
      const destination = path.join(dir, 'occupied');
      await mkdir(destination);
      await writeFile(path.join(destination, 'keep'), 'evidence');
      // A nonempty directory rejects the final rename on all supported platforms.
      await assert.rejects(tools.createDisplayPng(source, destination));
      assert.deepEqual((await readdir(dir)).sort(), ['full.png', 'occupied']);
      assert.equal(await readFile(path.join(destination, 'keep'), 'utf8'), 'evidence');
      assert.deepEqual(await readFile(source), bytes);
      await assert.rejects(tools.createDisplayPng(source, path.join(dir, 'missing', 'display.png')));
      assert.deepEqual((await readdir(dir)).sort(), ['full.png', 'occupied']);
    });
  });

  test(`${name}: invalid PNG leaves an existing display untouched`, async () => {
    await imageFixture(1, 1, async (dir, source) => {
      const display = path.join(dir, 'display.png');
      await writeFile(display, 'previous');
      await writeFile(source, 'invalid PNG');
      await assert.rejects(tools.pngDimensions(source));
      await assert.rejects(tools.createDisplayPng(source, display));
      assert.equal(await readFile(display, 'utf8'), 'previous');
      assert.deepEqual((await readdir(dir)).sort(), ['display.png', 'full.png']);
    });
  });
}
