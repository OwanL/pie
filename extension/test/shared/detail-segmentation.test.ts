import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  MAX_DETAIL_PAGE_BYTES,
  MIN_DETAIL_PAGE_BYTES,
  detailSegmentChecksum,
  reassembleDetailPages,
  segmentDetailPages,
  verifySegmentPages,
  type DetailSegmentPage,
} from '../../src/shared/detail-segmentation';
import type { DetailJsonSegmentPayload } from '../../src/shared/protocol/subagent-detail';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function segmentIdFor(source: string, revision: number): string {
  return createHash('sha256').update(source).update(':').update(String(revision)).digest('hex').slice(0, 32);
}

/** A string fixture exercising multi-byte UTF-8: emoji (4 bytes), accents,
 *  CJK, and an RTL script, repeated to a target serialized size. */
function hugeDetailValue(megabytes: number): unknown {
  const payload = 'héllo 🌍 世界 مرحبا 👨‍👩‍👧‍👦 '.repeat(2500);
  const blocks: string[] = [];
  let bytes = 0;
  const block = JSON.stringify({ index: 0, payload });
  const perBlock = Buffer.byteLength(block, 'utf8');
  while (bytes < megabytes * 1024 * 1024) {
    blocks.push(JSON.stringify({ index: blocks.length, payload }));
    bytes += perBlock;
  }
  return { blocks };
}

test('segments split only between Unicode code points with exact byte ranges', () => {
  const value = JSON.stringify({ exitCode: 0, text: 'héllo 🌍 world '.repeat(80), nested: { list: [1, 2, 3] } });
  const segmentId = segmentIdFor(value, 7);
  const pages = segmentDetailPages(value, 7, 1024, segmentId);
  assert.ok(pages.length > 1, 'the value spans multiple pages');
  let expectedByte = 0;
  let expectedPoint = 0;
  for (const page of pages) {
    assert.ok(page.payloadBytes <= 1024, 'each page fits the budget');
    assert.equal(page.checksum, sha256(JSON.stringify(page.payload)));
    assert.equal(page.payload.encoding, 'utf8-json');
    assert.equal(page.payload.segmentId, segmentId);
    assert.equal(page.payload.startByte, expectedByte, 'pages are contiguous by byte');
    assert.equal(page.payload.startCodePoint, expectedPoint, 'pages are contiguous by code point');
    assert.equal(Buffer.byteLength(page.payload.text, 'utf8'), page.payload.endByte - page.payload.startByte);
    assert.equal([...page.payload.text].length, page.payload.endCodePoint - page.payload.startCodePoint);
    assert.equal(Buffer.from(page.payload.text, 'utf8').toString('utf8') === page.payload.text, true, 'each fragment is valid UTF-8');
    expectedByte = page.payload.endByte;
    expectedPoint = page.payload.endCodePoint;
  }
  assert.equal(expectedByte, Buffer.byteLength(value, 'utf8'));
  assert.equal(expectedPoint, [...value].length);
});

test('page refs are stable: the same source and revision always yield the same pages', () => {
  const value = JSON.stringify(hugeDetailValue(0.5));
  const first = segmentDetailPages(value, 42, 4096, segmentIdFor(value, 42));
  const second = segmentDetailPages(value, 42, 4096, segmentIdFor(value, 42));
  assert.deepEqual(second.map((page) => page.ref), first.map((page) => page.ref));
  assert.deepEqual(
    second.map((page) => ({ checksum: page.checksum, startByte: page.payload.startByte, startCodePoint: page.payload.startCodePoint })),
    first.map((page) => ({ checksum: page.checksum, startByte: page.payload.startByte, startCodePoint: page.payload.startCodePoint })),
  );
  for (const page of first) {
    assert.equal(page.ref.baselineRevision, 42);
    assert.equal(page.ref.pageCount, first.length);
  }
  assert.deepEqual(
    first.map((page) => page.ref.pageIndex),
    first.map((_, index) => index),
  );
});

test('reassembly verifies order, contiguity, totals, and checksums before decoding', () => {
  const value = JSON.stringify({ blocks: ['alpha', 'beta', '🌍'.repeat(500), 3] });
  const pages = segmentDetailPages(value, 9, 1024, segmentIdFor(value, 9));
  const reassembled = reassembleDetailPages(pages);
  assert.deepEqual(reassembled, JSON.parse(value) as unknown);

  // Out-of-order pages are accepted (sorted) but a missing page is rejected.
  const reversed = [...pages].reverse();
  assert.deepEqual(reassembleDetailPages(reversed), JSON.parse(value) as unknown);

  const missing = pages.filter((_, index) => index !== Math.floor(pages.length / 2));
  // A missing page breaks the ordered manifest before totals are ever checked.
  assert.throws(() => reassembleDetailPages(missing), /contiguity, or checksum is invalid/);

  // A corrupt payload checksum is rejected.
  const tampered = pages.map((page, index) => (index === 0
    ? { ...page, checksum: sha256('tampered') }
    : page));
  assert.throws(() => reassembleDetailPages(tampered), /checksum is invalid/);

  // A non-contiguous fragment (overlapping bytes) is rejected.
  const overlapping: DetailSegmentPage[] = pages.map((page, index) => {
    if (index === 0) return page;
    return {
      ...page,
      payload: { ...page.payload, startByte: page.payload.startByte - 1, startCodePoint: page.payload.startCodePoint - 1 },
    };
  });
  assert.throws(() => reassembleDetailPages(overlapping), /contiguity, or checksum is invalid/);

  // A page whose manifest differs from the set is rejected.
  const wrongCount: DetailSegmentPage[] = pages.map((page, index) => (index === 0
    ? { ...page, ref: { ...page.ref, pageCount: page.ref.pageCount + 1 } }
    : page));
  assert.throws(() => reassembleDetailPages(wrongCount), /contiguity, or checksum is invalid/);
});

test('verifySegmentPages enforces payload sizes and byte/code-point totals', () => {
  const value = JSON.stringify({ text: 'a'.repeat(2000) });
  const pages = segmentDetailPages(value, 1, 1024, segmentIdFor(value, 1));
  assert.equal(verifySegmentPages(pages).length, pages.length);

  // Inflated payloadBytes is rejected.
  const inflated = pages.map((page, index) => (index === 0 ? { ...page, payloadBytes: page.payloadBytes + 1 } : page));
  assert.throws(() => verifySegmentPages(inflated), /checksum is invalid/);

  // A truncated fragment that still checksums (payload rewritten) must still
  // fail the total comparison.
  const truncated = pages.map((page, index) => {
    if (index !== pages.length - 1) return page;
    const text = page.payload.text.slice(0, -4);
    const payload: DetailJsonSegmentPayload = { ...page.payload, text, endByte: page.payload.startByte + Buffer.byteLength(text, 'utf8'), endCodePoint: page.payload.startCodePoint + [...text].length };
    return { ...page, payload, checksum: detailSegmentChecksum(payload), payloadBytes: Buffer.byteLength(JSON.stringify(payload), 'utf8') };
  });
  assert.throws(() => verifySegmentPages(truncated), /incomplete/);
});

test('a page budget below the minimum envelope is clamped by the caller contract', () => {
  // The segmenter honors the caller-supplied budget; MIN_DETAIL_PAGE_BYTES is
  // the floor the stores enforce before calling (a one-code-point payload can
  // still exceed a too-tiny budget, which must be a hard error).
  const value = JSON.stringify({ emoji: '🌍' });
  assert.throws(
    () => segmentDetailPages(value, 1, 4, segmentIdFor(value, 1)),
    /cannot encode one Unicode code point/,
  );
  assert.ok(MIN_DETAIL_PAGE_BYTES >= 4);
  assert.ok(MAX_DETAIL_PAGE_BYTES > MIN_DETAIL_PAGE_BYTES);
  const pages = segmentDetailPages(value, 1, MIN_DETAIL_PAGE_BYTES, segmentIdFor(value, 1));
  assert.ok(pages.every((page) => page.payloadBytes <= MIN_DETAIL_PAGE_BYTES));
});

test('huge values segment into bounded pages and reassemble exactly (tiny budget)', () => {
  const value = JSON.stringify(hugeDetailValue(0.5));
  const pages = segmentDetailPages(value, 3, 4096, segmentIdFor(value, 3));
  assert.ok(pages.length > 100, 'a multi-hundred-KiB detail yields many pages');
  for (const page of pages) {
    assert.ok(page.payloadBytes <= 4096, 'every page fits the tiny budget');
    assert.ok(page.payloadBytes > 0);
  }
  assert.deepEqual(reassembleDetailPages(pages) as unknown, JSON.parse(value) as unknown);
});

// The >64 MiB serialized verification is opt-in: it is excluded from `npm test`
// (test discovery only picks up *.test.ts) and runs under
// `npm run test:large-detail` -> test/large-detail.e2e.ts.

test('the same fragment text always yields the same checksum and segment id', () => {
  const payload: DetailJsonSegmentPayload = {
    kind: 'json-segment', encoding: 'utf8-json', segmentId: 'seg', semanticPath: [],
    startByte: 0, endByte: 11, totalBytes: 11, startCodePoint: 0, endCodePoint: 3, totalCodePoints: 3,
    text: 'héllo 🌍',
  };
  assert.equal(detailSegmentChecksum(payload), detailSegmentChecksum({ ...payload }));
  assert.equal(detailSegmentChecksum(payload), sha256(JSON.stringify(payload)));
});
