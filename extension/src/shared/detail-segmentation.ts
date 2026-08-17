import { createHash } from 'node:crypto';

import { isJsonSafeValue, type JsonSafeValue } from './json-structural-patch.js';
import type { DetailJsonSegmentPayload, DetailPageRef } from './protocol/subagent-detail.js';

/** Shared UTF-8-safe, checksummed detail segmentation. The live worker store,
 *  the host durable fallback, and the backend durable store all split one
 *  serialized JSON detail into exact ordered pages with the same envelope
 *  semantics so a receiver can verify contiguity, non-overlap, byte/code-point
 *  totals, and checksums before committing a baseline. Splits occur only
 *  between Unicode code points, so a multibyte character is never cut
 *  mid-sequence. */
export const MIN_DETAIL_PAGE_BYTES = 512;
export const DEFAULT_DETAIL_PAGE_BYTES = 128 * 1024;
export const MAX_DETAIL_PAGE_BYTES = 192 * 1024;

/** Reserved envelope bytes for the JSON-wrapped page payload fields. */
const DETAIL_PAGE_ENVELOPE_SLACK_BYTES = 384;

export interface DetailSegmentPage {
  ref: DetailPageRef;
  payload: DetailJsonSegmentPayload;
  payloadBytes: number;
  checksum: string;
}

export function detailSegmentChecksum(payload: DetailJsonSegmentPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** Split one serialized JSON detail into ordered pages. `maxPageBytes` must be
 *  clamped by the caller to its envelope budget; `segmentId` must be stable for
 *  the same source content so a re-fetch of an evicted page yields the exact
 *  same segment identity. */
export function segmentDetailPages(
  serialized: string,
  revision: number,
  maxPageBytes: number,
  segmentId: string,
): DetailSegmentPage[] {
  const points = [...serialized];
  const totalBytes = Buffer.byteLength(serialized, 'utf8');
  const raw: Array<Omit<DetailSegmentPage, 'ref'>> = [];
  let pointIndex = 0;
  let byteIndex = 0;
  while (pointIndex < points.length) {
    let end = Math.min(points.length, pointIndex + Math.max(1, maxPageBytes - DETAIL_PAGE_ENVELOPE_SLACK_BYTES));
    let payload: DetailJsonSegmentPayload;
    let payloadBytes: number;
    for (;;) {
      const text = points.slice(pointIndex, end).join('');
      const bytes = Buffer.byteLength(text, 'utf8');
      payload = {
        kind: 'json-segment', encoding: 'utf8-json', segmentId, semanticPath: [],
        startByte: byteIndex, endByte: byteIndex + bytes, totalBytes,
        startCodePoint: pointIndex, endCodePoint: end, totalCodePoints: points.length, text,
      };
      payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
      if (payloadBytes <= maxPageBytes || end === pointIndex + 1) break;
      end = pointIndex + Math.max(1, Math.floor((end - pointIndex) / 2));
    }
    if (payloadBytes > maxPageBytes) {
      throw new Error(`Detail page budget ${maxPageBytes} cannot encode one Unicode code point.`);
    }
    raw.push({ payload, payloadBytes, checksum: detailSegmentChecksum(payload) });
    byteIndex = payload.endByte;
    pointIndex = payload.endCodePoint;
  }
  if (raw.length === 0) throw new Error('Detail serialization unexpectedly produced no pages.');
  return raw.map((page, pageIndex) => ({
    ref: { baselineRevision: revision, pageIndex, pageCount: raw.length },
    ...page,
  }));
}

/** Verify page order, contiguity, byte/code-point totals, payload sizes, and
 *  checksums; return the pages in canonical order or throw. */
export function verifySegmentPages(pages: readonly DetailSegmentPage[]): DetailSegmentPage[] {
  if (pages.length === 0) throw new Error('Detail baseline has no pages.');
  const ordered = [...pages].sort((left, right) => left.ref.pageIndex - right.ref.pageIndex);
  let nextByte = 0;
  let nextPoint = 0;
  let text = '';
  for (let index = 0; index < ordered.length; index += 1) {
    const page = ordered[index]!;
    if (page.ref.pageIndex !== index || page.ref.pageCount !== ordered.length
      || page.payload.startByte !== nextByte || page.payload.startCodePoint !== nextPoint
      || page.payloadBytes !== Buffer.byteLength(JSON.stringify(page.payload), 'utf8')
      || page.checksum !== detailSegmentChecksum(page.payload)) {
      throw new Error('Detail baseline page order, contiguity, or checksum is invalid.');
    }
    text += page.payload.text;
    nextByte = page.payload.endByte;
    nextPoint = page.payload.endCodePoint;
  }
  const last = ordered[ordered.length - 1]!.payload;
  if (nextByte !== last.totalBytes || nextPoint !== last.totalCodePoints
    || Buffer.byteLength(text, 'utf8') !== last.totalBytes
    || [...text].length !== last.totalCodePoints) {
    throw new Error('Detail baseline is incomplete.');
  }
  return ordered;
}

/** Verify and reassemble a complete baseline into its JSON-safe value. */
export function reassembleDetailPages(pages: readonly DetailSegmentPage[]): JsonSafeValue {
  const ordered = verifySegmentPages(pages);
  const text = ordered.map((page) => page.payload.text).join('');
  const value = JSON.parse(text) as unknown;
  if (!isJsonSafeValue(value)) throw new Error('Detail baseline did not decode to bounded JSON-safe data.');
  return value;
}
