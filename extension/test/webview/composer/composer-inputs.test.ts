import test from 'node:test';
import assert from 'node:assert/strict';

import type { ComposerInput } from '../../../src/shared/protocol';
import {
  composerInputDetail,
  composerInputDisplayName,
  composerInputTitle,
  describeComposerInputSummary,
  formatImageMeta,
} from '../../../src/webview/panel/composer/inputs';

const imageInput: Extract<ComposerInput, { kind: 'imageBlob' }> = {
  id: 'image-1',
  kind: 'imageBlob',
  mimeType: 'image/png',
  name: 'image.png',
  sizeBytes: 41 * 1024,
  dataBase64: 'abc123',
  width: 1440,
  height: 900,
  source: 'paste',
};

const pathInput: Extract<ComposerInput, { kind: 'filesystemPathRef' }> = {
  id: 'path-1',
  kind: 'filesystemPathRef',
  path: '/workspace/src/panel.tsx',
  name: '',
  source: 'picker',
};

test('composerInputDisplayName falls back to the basename for filesystem paths', () => {
  assert.equal(composerInputDisplayName(pathInput), 'panel.tsx');
});

test('formatImageMeta combines dimensions and size into a compact detail line', () => {
  assert.equal(formatImageMeta(imageInput), '1440×900 · 41 KB');
});

test('composerInputDetail uses full path detail for filesystem references', () => {
  assert.equal(composerInputDetail(pathInput), '/workspace/src/panel.tsx');
});

test('composerInputTitle combines the visible label and detail for tooltips', () => {
  assert.equal(composerInputTitle(imageInput), 'image.png · 1440×900 · 41 KB');
});

test('describeComposerInputSummary distinguishes pure image, pure path, and mixed selections', () => {
  assert.equal(describeComposerInputSummary([imageInput]), '1 image');
  assert.equal(describeComposerInputSummary([pathInput, { ...pathInput, id: 'path-2', path: '/workspace/package.json' }]), '2 paths');
  assert.equal(describeComposerInputSummary([imageInput, pathInput]), '2 attachments');
});
