import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pngjs from 'pngjs';

import { artifactDirectory } from '../src/artifacts.js';
import { createDisplayPng, pngDimensions } from '../src/image.mjs';
import { buildToolResult, modelAcceptsImages, renderComputerText, truncateUtf8 } from '../src/result.js';
const { PNG } = pngjs;
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;

test('artifact directories are beside the canonical session and sanitize names', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-artifacts-'));
  try {
    const session = path.join(dir, 'my session.jsonl'); await writeFile(session, '');
    const result = await artifactDirectory(session, 'computer:../unsafe');
    assert.equal(result, path.join(path.dirname(await realpath(session)), 'computer-use', 'my-session', 'computer-..-unsafe'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('display PNG preserves the full artifact and limits the long edge to 1600', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-image-'));
  try {
    const full = path.join(dir, 'full.png'); const display = path.join(dir, 'display.png');
    const image = new PNG({ width: 2000, height: 1000 }); image.data.fill(255); await writeFile(full, PNG.sync.write(image));
    const before = await readFile(full); const resized = await createDisplayPng(full, display, 1600);
    assert.deepEqual(resized, { width: 1600, height: 800, sourceWidth: 2000, sourceHeight: 1000 });
    assert.deepEqual(await pngDimensions(display), { width: 1600, height: 800 });
    assert.deepEqual(await readFile(full), before, 'full-resolution evidence is not rewritten');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('mixed text/image results are emitted only for image-capable models and survive tool-result pruning', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-result-'));
  try {
    const pngPath = path.join(dir, 'display.png'); const image = new PNG({ width: 1, height: 1 }); await writeFile(pngPath, PNG.sync.write(image));
    const response = { sessionId: 's', targetId: 't', revision: 1, displayImagePath: pngPath, fullImagePath: path.join(dir, 'full.png'), held: { keys: [], buttons: [] }, cursor: { x: 10, y: 20 } };
    const mixed = await buildToolResult('observe', response, true);
    assert.deepEqual(mixed.content.map((part) => part.type), ['text', 'image']);
    const [text] = mixed.content; assert.equal(text.type, 'text'); assert.match(text.text, /cursor: {"x":10,"y":20}/);
    const [{ runPipeline }, { DEFAULT_CONFIG }] = await Promise.all([
      dynamicImport(new URL('../../tool-result-pruner/pipeline.ts', import.meta.url).href),
      dynamicImport(new URL('../../tool-result-pruner/types.ts', import.meta.url).href),
    ]);
    assert.equal(runPipeline({ toolName: 'computer', toolCallId: 'x', input: {}, content: mixed.content, details: mixed.details, isError: false }, DEFAULT_CONFIG), null, 'multipart image content must be left untouched');
    const textOnly = await buildToolResult('observe', response, false);
    assert.deepEqual(textOnly.content.map((part) => part.type), ['text']);
    const [unavailable] = textOnly.content;
    assert.equal(unavailable.type, 'text');
    assert.match(unavailable.text, /image_delivery: unavailable/);
    assert.match(unavailable.text, /reason: active_model_does_not_accept_image_input/);
    assert.match(unavailable.text, new RegExp(`artifact: ${pngPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(unavailable.text, /modelRequirements\.inputKinds=\["image"\]/);
    assert.equal(JSON.stringify(textOnly.details).includes('base64'), false);
    assert.equal(modelAcceptsImages({ input: ['text', 'image'] }), true);
    assert.equal(modelAcceptsImages({ input: ['text'] }), false);
    assert.equal(modelAcceptsImages(undefined), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('text observations report display and full PNG dimensions and paths for image-less models', async () => {
  const response = {
    sessionId: 's', targetId: 't', revision: 1,
    fullImagePath: '/artifacts/full.png', displayImagePath: '/artifacts/display.png',
    imageWidth: 1600, imageHeight: 855, fullImageWidth: 2560, fullImageHeight: 1368,
    held: { keys: [], buttons: [] },
  };
  const textOnly = await buildToolResult('observe', response, false);
  assert.deepEqual(textOnly.content.map((part) => part.type), ['text']);
  const [text] = textOnly.content; assert.equal(text.type, 'text');
  assert.match(text.text, /image_delivery: unavailable/);
  assert.match(text.text, /artifact: \/artifacts\/display\.png/);
  assert.match(text.text, /display_png: \/artifacts\/display\.png/);
  assert.match(text.text, /display_size: 1600x855/);
  assert.match(text.text, /full_png: \/artifacts\/full\.png/);
  assert.match(text.text, /full_png_size: 2560x1368/);
  assert.equal(textOnly.details.imageWidth, 1600); assert.equal(textOnly.details.imageHeight, 855);
  assert.equal(textOnly.details.fullImageWidth, 2560); assert.equal(textOnly.details.fullImageHeight, 1368);
  assert.equal(JSON.stringify(textOnly.details).includes('base64'), false);
});

test('screenshot-disabled accessibility degradation reports no captured image in text and structured metadata', async () => {
  const response = {
    sessionId: 's', targetId: 't', revision: 1, accessibilityAvailable: false,
    degraded: { reason: 'Accessibility unavailable (UIA_TIMEOUT); no image captured.', fallback: 'none' },
    held: { keys: [], buttons: [] },
  };
  const result = await buildToolResult('observe', response, false);
  assert.equal(result.content[0].type, 'text');
  assert.match(result.content[0].text, /accessibility unavailable.*no image captured/i);
  assert.doesNotMatch(result.content[0].text, /captured pixels only/i);
  assert.deepEqual(result.details.degraded, response.degraded);
  assert.equal(result.details.fullImagePath, undefined);
  assert.equal('displayImagePath' in result.details, false);
});

test('text observations remain within 32KiB and report truncation concisely', () => {
  const raw = '🙂'.repeat(20000); const bounded = truncateUtf8(raw);
  assert.ok(Buffer.byteLength(bounded.text) <= 32 * 1024); assert.equal(bounded.truncated, true); assert.doesNotMatch(bounded.text, /�/);
  const text = renderComputerText('observe', { elements: Array.from({ length: 250 }, (_, i) => ({ ref: `e:1:${i}`, role: 'item', label: 'x'.repeat(1000) })), truncated: true });
  assert.ok(Buffer.byteLength(text) <= 32 * 1024); assert.match(text, /observation_truncated: true/);
});
