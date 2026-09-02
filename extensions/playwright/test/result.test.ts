import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import pngjs from 'pngjs';

import { buildToolError, buildToolResult, modelAcceptsImages, renderPlaywrightText, truncateUtf8 } from '../src/result.js';
import { MAX_OBSERVATION_BYTES, type RuntimeResponse } from '../src/types.js';

const { PNG } = pngjs;

const BASE_OBSERVATION = {
  pageId: 'p1', url: 'https://example.test/', title: 'Example', revision: 3,
  snapshot: '- heading "Example" [level=1] [ref=e2]',
  events: {
    console: [{ seq: 7, type: 'error', text: 'boom' }],
    pageErrors: [{ seq: 8, message: 'uncaught' }],
    failedRequests: [{ seq: 9, method: 'GET', url: 'https://example.test/x', failure: 'net::ERR' }],
    downloads: [{ seq: 10, suggestedFilename: 'a.txt', url: 'http://x/a.txt', state: 'saved' as const, path: 'C:/a.txt', bytes: 12 }],
    dropped: { console: 1, pageErrors: 0, failedRequests: 0, downloads: 0 },
  },
  tabs: [{ pageId: 'p1', url: 'https://example.test/', title: 'Example', active: true }],
};

test('renderPlaywrightText surfaces session/page/revision, events, and fidelity markers', () => {
  const result: RuntimeResponse = {
    sessionId: 'pw-1', headless: true, isolated: true, actionKind: 'click',
    observation: {
      ...BASE_OBSERVATION,
      reduction: { reason: 'depth reduced to 12', fullSnapshotPath: 'C:/art/full.yaml', depthUsed: 12 },
    },
    dialogs: [{ result: 'auto-dismissed', type: 'alert', message: 'hi' }],
  };
  const text = renderPlaywrightText('act', result);
  assert.match(text, /playwright act: ok/);
  assert.match(text, /session: pw-1/);
  assert.match(text, /headless Chromium/);
  assert.match(text, /revision: 3/);
  assert.match(text, /dialog: auto-dismissed alert/);
  assert.match(text, /console_error: boom/);
  assert.match(text, /page_error: uncaught/);
  assert.match(text, /failed_request: GET https:\/\/example\.test\/x/);
  assert.match(text, /download: a\.txt .* saved 12 bytes/);
  assert.match(text, /event_telemetry_dropped: console=1/);
  assert.match(text, /tab: p1 https:\/\/example\.test\/ \(active\)/);
  assert.match(text, /snapshot_reduction: depth reduced to 12/);
  assert.match(text, /complete_snapshot: C:\/art\/full\.yaml/);
  assert.match(text, /snapshot:\n- heading "Example"/);
});

test('rendering preserves a complete in-limit snapshot and marks omitted telemetry instead of generic tail truncation', () => {
  const snapshot = `- textbox "${'S'.repeat(14 * 1024)}" [ref=e1]`;
  const noisy = Array.from({ length: 200 }, (_, seq) => ({ seq, type: 'error' as const, text: 'E'.repeat(500) }));
  const text = renderPlaywrightText('observe', {
    sessionId: 's',
    observation: {
      ...BASE_OBSERVATION,
      snapshot,
      events: { ...BASE_OBSERVATION.events, console: noisy },
    },
  });
  assert.ok(Buffer.byteLength(text) <= MAX_OBSERVATION_BYTES);
  assert.ok(text.includes(snapshot), 'the revision-establishing snapshot must remain complete');
  assert.match(text, /event_lines_omitted:/);
  assert.doesNotMatch(text, /\[result text truncated\]/);
});

test('renderPlaywrightText flags invalidated refs when no snapshot is returned', () => {
  const text = renderPlaywrightText('act', {
    sessionId: 's', actionKind: 'wait',
    observation: { pageId: 'p1', url: 'u', title: 't', refsInvalidated: true, events: { console: [], pageErrors: [], failedRequests: [], downloads: [], dropped: { console: 0, pageErrors: 0, failedRequests: 0, downloads: 0 } } },
  });
  assert.match(text, /refs_invalidated: true/);
  assert.doesNotMatch(text, /revision:/);
});

test('run_code results, storage state, close summaries, and screenshots render', () => {
  const text = renderPlaywrightText('run_code', {
    sessionId: 's',
    runCode: { text: '{\n  "ok": true\n}', bytes: 14, truncated: true, artifactPath: 'C:/art/rc.json' },
  });
  assert.match(text, /run_code_result_artifact: C:\/art\/rc\.json/);
  assert.match(text, /run_code_result_truncated: true/);

  const closeText = renderPlaywrightText('close', {
    sessionId: 's', storageStatePath: 'C:/art/state.json', closed: { scope: 'session', sessionIds: ['s'] },
  });
  assert.match(closeText, /storage_state: C:\/art\/state\.json/);
  assert.match(closeText, /closed_session: s/);

  const shot = renderPlaywrightText('observe', {
    sessionId: 's',
    screenshot: { fullImagePath: 'C:/f.png', displayImagePath: 'C:/d.png', imageWidth: 1600, imageHeight: 900, sourceWidth: 1600, sourceHeight: 900 },
  });
  assert.match(shot, /display_png: C:\/d\.png/);
  assert.match(shot, /full_png: C:\/f\.png/);
});

test('close summaries bound session IDs with an explicit omission count', () => {
  const ids = Array.from({ length: 400 }, (_, index) => `${index}-${'x'.repeat(120)}`);
  const text = renderPlaywrightText('close', { closed: { scope: 'runtime', sessionIds: ids, omittedSessionIds: 7 } });
  assert.ok(Buffer.byteLength(text) <= MAX_OBSERVATION_BYTES);
  assert.match(text, /closed_sessions_omitted: 387/);
});

test('truncateUtf8 caps bytes on UTF-8 boundaries', () => {
  const text = 'é'.repeat(MAX_OBSERVATION_BYTES);
  const { text: truncated, truncated: flag } = truncateUtf8(text);
  assert.equal(flag, true);
  assert.ok(Buffer.byteLength(truncated) <= MAX_OBSERVATION_BYTES);
  assert.match(truncated, /\[result text truncated\]$/);
  assert.equal(truncateUtf8('small').truncated, false);
});

test('buildToolResult attaches images only for image-capable models and otherwise reports them unavailable', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pw-result-'));
  try {
    const display = path.join(dir, 'display.png');
    const png = new PNG({ width: 2, height: 2 });
    png.data.fill(128);
    await writeFile(display, PNG.sync.write(png));
    const result: RuntimeResponse = {
      sessionId: 's', observation: BASE_OBSERVATION,
      screenshot: { fullImagePath: path.join(dir, 'full.png'), displayImagePath: display, imageWidth: 2, imageHeight: 2, sourceWidth: 2, sourceHeight: 2 },
    };
    const imageModel = await buildToolResult('observe', result, modelAcceptsImages({ input: ['text', 'image'] }));
    assert.equal(imageModel.content.length, 2);
    assert.equal(imageModel.content[1].type, 'image');
    assert.deepEqual((imageModel.details as { observation?: { snapshot?: unknown } }).observation?.snapshot, undefined);

    const textModel = await buildToolResult('observe', result, modelAcceptsImages({ input: ['text'] }));
    assert.equal(textModel.content.length, 1);
    const text = (textModel.content[0] as { type: 'text'; text: string }).text;
    assert.match(text, /image_delivery: unavailable/);
    assert.ok(text.includes(display), 'expected the artifact path in the unavailable notice');
    assert.ok(text.indexOf('image_delivery: unavailable') < text.indexOf('snapshot:'), 'the unavailable notice must survive truncation of the snapshot');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildToolError produces bounded, coded errors', () => {
  const error = buildToolError(Object.assign(new Error('broke'), { code: 'STALE_REF', retryable: true }));
  assert.equal((error as unknown as { code: string }).code, 'STALE_REF');
  assert.equal((error as unknown as { retryable: boolean }).retryable, true);
  assert.match(error.message, /^playwright error \[STALE_REF\]: broke/);
  const unknown = buildToolError('string failure');
  assert.equal((unknown as unknown as { code: string }).code, 'PLAYWRIGHT_ERROR');
});
