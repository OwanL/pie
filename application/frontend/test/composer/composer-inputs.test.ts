import test from 'node:test';
import assert from 'node:assert/strict';

import { h } from 'preact';
import { renderToString } from 'preact-render-to-string';
import { ComposerAttachments } from '../../composer/attachments';

import type { ComposerInput } from '../../../lib/protocol/index.js';
import {
  composerInputDetail,
  composerInputDisplayName,
  composerInputTitle,
  describeComposerInputSummary,
  formatImageMeta,
} from '../../composer/inputs';

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

test('attachment sizes preserve bytes below one KB and rounded KB above it', () => {
  for (const [sizeBytes, expected] of [[0, '0 B'], [400, '400 B'], [1023, '1023 B'], [1024, '1 KB'], [1536, '2 KB'], [41984, '41 KB']] as const) {
    assert.equal(composerInputDetail({ ...imageInput, width: undefined, height: undefined, sizeBytes }), expected);
  }
});

test('attachment cards retain their accessible summary without a visual count badge', () => {
  const html = renderToString(h(ComposerAttachments, {
    pendingComposerInputs: [imageInput, pathInput],
    attachmentSummary: '2 attachments',
    onRemoveInput: () => {},
  }));
  assert.match(html, /role="group" aria-label="Pending attachments: 2 attachments"/);
  assert.doesNotMatch(html, /composer-attachments-summary/);
  assert.match(html, /image.png/);
  assert.match(html, /panel.tsx/);
  assert.equal(renderToString(h(ComposerAttachments, { pendingComposerInputs: [], attachmentSummary: '', onRemoveInput: () => {} })), '');
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
