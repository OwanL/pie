import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';

import { MAX_IMAGE_PREVIEW_BYTES } from '../../../lib/protocol/image-preview.js';
import { createStandaloneHostRuntimePlatform } from '../platform.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-image-preview-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const platform = createStandaloneHostRuntimePlatform({
    workspaceCwd: root,
    extensionPath: root,
    runtimeOutputDirectory: root,
    dataPaths: {
      rootDir: root, analyticsDir: root, sessionsDir: root,
      artifactsDir: root, stateDir: root, cacheDir: root,
    },
    dependencies: { nodePath: process.execPath, sdkPath: root },
    getBrowserServer: () => undefined,
  });
  assert.ok(platform.editor.previewImageFile);
  return { root, preview: platform.editor.previewImageFile };
}

test('standalone previews real PNG bytes at the exact supplied path', async (t) => {
  const { root, preview } = await fixture(t);
  const candidate = path.join(root, 'image.PNG');
  await fs.writeFile(candidate, png);
  assert.deepEqual(await preview(candidate, {
    reference: candidate,
    workingDirectory: path.join(root, 'other-session'),
  }), { mimeType: 'image/png', dataUrl: `data:image/png;base64,${png.toString('base64')}` });
});

test('standalone quietly rejects oversized, invalid, empty, unsupported, and missing images', async (t) => {
  const { root, preview } = await fixture(t);
  const oversized = path.join(root, 'oversized.png');
  const handle = await fs.open(oversized, 'w');
  try {
    await handle.write(png);
    await handle.truncate(MAX_IMAGE_PREVIEW_BYTES + 1);
  } finally {
    await handle.close();
  }
  const invalid = path.join(root, 'invalid.png');
  const empty = path.join(root, 'empty.png');
  const unsupported = path.join(root, 'image.svg');
  await fs.writeFile(invalid, '<svg/>');
  await fs.writeFile(empty, '');
  await fs.writeFile(unsupported, '<svg/>');
  for (const candidate of [oversized, invalid, empty, unsupported, path.join(root, 'missing.png'), root]) {
    assert.equal(await preview(candidate), undefined, candidate);
  }
});

test('standalone does not walk nested directories for a missing bare filename', async (t) => {
  const { root, preview } = await fixture(t);
  await fs.mkdir(path.join(root, 'nested'));
  await fs.writeFile(path.join(root, 'nested', 'image.png'), png);
  assert.equal(await preview(path.join(root, 'image.png'), {
    reference: 'image.png', workingDirectory: root,
  }), undefined);
});
