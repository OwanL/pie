import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { performImageAction, type ImageActionAdapter } from '../lib/image-actions.js';
import { MAX_IMAGE_PREVIEW_BYTES } from '../../lib/protocol/image-preview.js';

const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
const source = { kind: 'inline' as const, base64, mimeType: 'image/png' };
const adapter: ImageActionAdapter = {
  exists: async (filePath) => fs.stat(filePath).then(() => true, () => false),
  findFiles: async () => [],
  copyImage: async () => {}, openInBrowser: async () => {}, reveal: async () => {},
};

test('inline reveal writes exact bytes to an OS-temp copy before revealing', async () => {
  let revealed = '';
  await performImageAction({ action: 'reveal', source }, {
    ...adapter, reveal: async (filePath) => { revealed = filePath; },
  });
  try {
    assert.equal(path.dirname(path.dirname(revealed)), os.tmpdir());
    assert.deepEqual(await fs.readFile(revealed), Buffer.from(base64, 'base64'));
  } finally { await fs.rm(path.dirname(revealed), { recursive: true, force: true }); }
});

test('local actions use resolved source path and report failures', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-image-action-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'image.png');
  await fs.writeFile(filePath, Buffer.from(base64, 'base64'));
  let copied = '';
  await performImageAction({ action: 'copy', source: { kind: 'file', path: filePath } }, {
    ...adapter, copyImage: async (candidate) => { copied = candidate; },
  });
  assert.equal(copied, filePath);
  await assert.rejects(performImageAction({ action: 'copy', source: { kind: 'file', path: filePath } }, {
    ...adapter, copyImage: async () => { throw new Error('clipboard denied'); },
  }), /clipboard denied/);
});

test('browser action opens an HTML wrapper rather than an image file association', async () => {
  let opened = '';
  try {
    await performImageAction({ action: 'openInBrowser', source }, {
      ...adapter,
      openInBrowser: async (candidate) => { opened = candidate; },
    });
    assert.equal(path.extname(opened), '.html');
    assert.match(await fs.readFile(opened, 'utf8'), new RegExp(`data:image/png;base64,${base64.replace(/[+]/g, '\\+')}`));
  } finally {
    if (opened) await fs.rm(path.dirname(opened), { recursive: true, force: true });
  }
});

test('rejects malformed, unsupported, invalid-signature and oversized inline images', async () => {
  for (const bad of [
    { ...source, base64: '!!!!' },
    { ...source, mimeType: 'image/svg+xml' },
    { ...source, base64: Buffer.from('not an image').toString('base64') },
    { ...source, base64: Buffer.alloc(MAX_IMAGE_PREVIEW_BYTES + 1).toString('base64') },
  ]) {
    await assert.rejects(performImageAction({ action: 'reveal', source: bad }, adapter));
  }
});
