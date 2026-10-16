import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { buildWindowsClipboardCommand, performImageAction, type ImageActionAdapter } from '../lib/image-actions.js';
import { MAX_IMAGE_PREVIEW_BYTES } from '../../lib/protocol/image-preview.js';

const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
const source = { kind: 'inline' as const, base64, mimeType: 'image/png' };
const adapter: ImageActionAdapter = {
  exists: async (filePath) => fs.stat(filePath).then(() => true, () => false),
  findFiles: async () => [],
  copyImage: async () => {}, openInBrowser: async () => {}, reveal: async () => {},
};

test('inline reveal writes exact bytes to an owned OS-temp copy before revealing', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-image-action-test-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  let revealed = '';
  await performImageAction({ action: 'reveal', source }, {
    ...adapter, tempRoot, reveal: async (filePath) => { revealed = filePath; },
  });
  assert.equal(path.basename(path.dirname(revealed)), 'pie-image-actions');
  assert.deepEqual(await fs.readFile(revealed), Buffer.from(base64, 'base64'));
});

test('later actions reap only owned artifacts older than the conservative retention window', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-image-action-test-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const directory = path.join(tempRoot, 'pie-image-actions');
  await fs.mkdir(directory);
  const now = 2_000_000_000_000;
  const stale = path.join(directory, 'image-action-1000-00000000-0000-0000-0000-000000000000.png');
  const fresh = path.join(directory, `image-action-${now}-00000000-0000-0000-0000-000000000001.html`);
  const unrelated = path.join(directory, 'user-image.png');
  await Promise.all([fs.writeFile(stale, 'stale'), fs.writeFile(fresh, 'fresh'), fs.writeFile(unrelated, 'unrelated')]);
  const oldTime = new Date(1_000);
  await fs.utimes(stale, oldTime, oldTime);
  await performImageAction({ action: 'reveal', source }, { ...adapter, tempRoot, now: () => now });
  await assert.rejects(fs.stat(stale), { code: 'ENOENT' });
  assert.equal(await fs.readFile(fresh, 'utf8'), 'fresh');
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'unrelated');
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

test('Windows native clipboard command passes the image path through its environment', () => {
  const invocation = buildWindowsClipboardCommand('C:\\images\\chart.png');
  assert.equal(invocation.command, 'powershell.exe');
  assert.deepEqual(invocation.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-STA']);
  assert.match(invocation.args[4], /Clipboard\]::SetImage\(\$image\)/);
  assert.equal(invocation.env.PIE_IMAGE_FILE, 'C:\\images\\chart.png');
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
