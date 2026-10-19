import { createHash } from 'node:crypto';

import { isJsonSafeValue, type JsonSafeValue } from '../../../lib/json-structural-patch.js';
import type { DetailJsonSegmentPayload, DetailPageRef } from '../../agent-processes/lib/rpc/subagent-detail.js';

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
export const DETAIL_PAGE_ENVELOPE_SLACK_BYTES = 384;

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
  const cursor = new DetailPageCursor(
    new StringCodePointReader(serialized), revision, maxPageBytes, segmentId,
    Buffer.byteLength(serialized, 'utf8'), countCodePoints(serialized), 1,
  );
  const pages: DetailSegmentPage[] = [];
  try {
    let page: DetailSegmentPage | undefined;
    while ((page = cursor.nextPage())) pages.push(page);
  } finally {
    cursor.close();
  }
  if (pages.length === 0) throw new Error('Detail serialization unexpectedly produced no pages.');
  return pages.map((page) => ({
    ...page, ref: { ...page.ref, pageCount: pages.length },
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

export interface CodePointRead {
  text: string;
  count: number;
}

export interface CodePointReader {
  read(maxCodePoints: number): CodePointRead;
  unread(text: string): void;
  close(): void;
}

export class StringCodePointReader implements CodePointReader {
  private index = 0;
  private pending = '';

  constructor(private readonly source: string) {}

  read(maxCodePoints: number): CodePointRead {
    const points: string[] = [];
    while (points.length < maxCodePoints) {
      let point: string | undefined;
      if (this.pending.length > 0) {
        const codePoint = this.pending.codePointAt(0)!;
        point = String.fromCodePoint(codePoint);
        this.pending = this.pending.slice(point.length);
      } else if (this.index < this.source.length) {
        const codePoint = this.source.codePointAt(this.index)!;
        point = String.fromCodePoint(codePoint);
        this.index += point.length;
      } else {
        break;
      }
      points.push(point);
    }
    return { text: points.join(''), count: points.length };
  }

  unread(text: string): void {
    if (text.length > 0) this.pending = text + this.pending;
  }

  close(): void { /* memory-backed */ }
}

export function takeCodePoints(value: string, maxCodePoints: number): CodePointRead {
  if (maxCodePoints <= 0 || value.length === 0) return { text: '', count: 0 };
  let end = 0;
  let count = 0;
  while (end < value.length && count < maxCodePoints) {
    const codePoint = value.codePointAt(end)!;
    end += codePoint > 0xffff ? 2 : 1;
    count += 1;
  }
  return { text: value.slice(0, end), count };
}

export class DetailPageCursor {
  private pageIndex = 0;
  private byteIndex = 0;
  private codePointIndex = 0;
  private readonly maxPageBytes: number;

  private readonly hash: ReturnType<typeof createHash> | undefined;

  constructor(
    private readonly reader: CodePointReader,
    private readonly revision: number,
    requestedPageBytes: number,
    private readonly segmentId: string,
    private readonly totalBytes: number,
    private readonly totalCodePoints: number,
    private readonly pageCount: number,
    private readonly expectedHash?: string,
  ) {
    this.maxPageBytes = requestedPageBytes;
    this.hash = expectedHash ? createHash('sha256') : undefined;
  }

  nextPage(): DetailSegmentPage | undefined {
    if (this.codePointIndex >= this.totalCodePoints) return undefined;
    const read = this.reader.read(Math.max(1, this.maxPageBytes - DETAIL_PAGE_ENVELOPE_SLACK_BYTES));
    if (read.count === 0) return undefined;
    let text = read.text;
    let count = read.count;
    let page = this.makePage(text, count);
    while (page.payloadBytes > this.maxPageBytes && count > 1) {
      const nextCount = Math.max(1, Math.floor(count / 2));
      const prefix = takeCodePoints(text, nextCount).text;
      this.reader.unread(text.slice(prefix.length));
      text = prefix;
      count = nextCount;
      page = this.makePage(text, count);
    }
    if (page.payloadBytes > this.maxPageBytes) {
      throw new Error(`Detail page budget ${this.maxPageBytes} cannot encode one Unicode code point.`);
    }
    this.pageIndex += 1;
    this.byteIndex = page.payload.endByte;
    this.codePointIndex = page.payload.endCodePoint;
    this.hash?.update(text);
    return page;
  }

  isComplete(): boolean {
    if (this.pageIndex !== this.pageCount
      || this.byteIndex !== this.totalBytes
      || this.codePointIndex !== this.totalCodePoints) return false;
    const trailing = this.reader.read(1);
    if (trailing.count !== 0) {
      this.reader.unread(trailing.text);
      return false;
    }
    return !this.expectedHash || this.hash!.digest('hex') === this.expectedHash;
  }

  close(): void { this.reader.close(); }

  private makePage(text: string, codePointCount: number): DetailSegmentPage {
    const payload = {
      kind: 'json-segment' as const,
      encoding: 'utf8-json' as const,
      segmentId: this.segmentId,
      semanticPath: [] as readonly (string | number)[],
      startByte: this.byteIndex,
      endByte: this.byteIndex + Buffer.byteLength(text, 'utf8'),
      totalBytes: this.totalBytes,
      startCodePoint: this.codePointIndex,
      endCodePoint: this.codePointIndex + codePointCount,
      totalCodePoints: this.totalCodePoints,
      text,
    };
    return {
      ref: { baselineRevision: this.revision, pageIndex: this.pageIndex, pageCount: this.pageCount },
      payload,
      payloadBytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
      checksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    };
  }
}

export function countCodePoints(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}
