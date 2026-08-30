import type { VirtualItem } from '@tanstack/virtual-core';

import { estimateTranscriptRowSize, type TranscriptRow } from './virtual-list-rows';

const WIDTH_BUCKET_PX = 8;
const DEFAULT_MAX_MEASUREMENTS = 640;

interface CachedMeasurement {
  key: string | number;
  widthBucket: number;
  size: number;
  estimatedSize: number;
  signature: string;
}

export interface InitialTranscriptMeasurements {
  measurements: VirtualItem[];
  reusedCount: number;
  widthBucket: number | null;
}

function widthBucket(width: number): number | null {
  if (!Number.isFinite(width) || width <= 0) return null;
  return Math.round(width / WIDTH_BUCKET_PX) * WIDTH_BUCKET_PX;
}

function sampledTextSignature(text: string | undefined): string {
  if (!text) return '0::';
  const head = text.slice(0, 48);
  const tail = text.length > 48 ? text.slice(-48) : '';
  return `${text.length}:${head}:${tail}`;
}

function stableRowSignature(row: TranscriptRow): string | null {
  if (row.kind !== 'message') return null;
  const { message } = row;
  if (message.status === 'streaming' || message.status === 'queued') return null;
  if (row.activityState || row.pruningHeaderState?.kind === 'pending') return null;

  const partSignature = (message.parts ?? []).map((part) => {
    if (part.kind === 'toolCall') {
      const call = part.toolCall;
      return `t:${call.id}:${call.status}:${call.seq ?? ''}:${call.detailRef?.key ?? ''}`;
    }
    return `${part.kind[0]}:${sampledTextSignature(part.text)}`;
  }).join(',');
  const toolCalls = message.toolCalls?.length
    ? message.toolCalls
    : (message.parts ?? []).flatMap((part) => part.kind === 'toolCall' ? [part.toolCall] : []);
  if (toolCalls.some((call) => call.status !== 'completed' && call.status !== 'failed')) return null;
  const toolSignature = toolCalls
    .map((call) => `${call.id}:${call.name}:${call.status}:${call.seq ?? ''}:${call.detailRef?.key ?? ''}`)
    .join(',');
  const userPartsSignature = (message.userParts ?? []).map((part) => part.kind === 'text'
    ? `t:${sampledTextSignature(part.text)}`
    : `i:${part.width ?? ''}x${part.height ?? ''}:${part.dataBase64.length}`).join(',');

  return [
    message.role,
    message.status,
    message.toolStateRevision ?? '',
    sampledTextSignature(message.markdown),
    sampledTextSignature(message.thinking),
    partSignature,
    toolSignature,
    userPartsSignature,
    row.pruningHeaderState?.kind ?? '',
  ].join('|');
}

export function isReusableTranscriptMeasurementRow(row: TranscriptRow): boolean {
  return stableRowSignature(row) !== null;
}

export function isReusableTranscriptMeasurementElement(element: HTMLElement): boolean {
  return !element.querySelector(
    'textarea, input, [contenteditable]:not([contenteditable="false"]), [aria-expanded="true"]',
  );
}

/**
 * Small in-memory LRU of real, collapsed row heights. It survives transcript
 * component remounts/tab switches, but only reuses a value for the same scoped
 * row identity, stable content signature, estimator revision, and width.
 */
export class TranscriptMeasurementCache {
  private readonly entries = new Map<string | number, CachedMeasurement>();
  private latestWidthBucket: number | null = null;

  constructor(private readonly maxMeasurements = DEFAULT_MAX_MEASUREMENTS) {}

  observeWidth(width: number): void {
    const currentWidthBucket = widthBucket(width);
    if (currentWidthBucket !== null) this.latestWidthBucket = currentWidthBucket;
  }

  remember(row: TranscriptRow, width: number, size: number): void {
    const currentWidthBucket = widthBucket(width);
    if (currentWidthBucket === null) return;
    this.observeWidth(width);

    const signature = stableRowSignature(row);
    if (!signature || !Number.isFinite(size) || size <= 0) return;
    const entry: CachedMeasurement = {
      key: row.key,
      widthBucket: currentWidthBucket,
      size,
      estimatedSize: estimateTranscriptRowSize(row),
      signature,
    };

    // Map insertion order is the LRU order. Refresh an existing key at the end.
    this.entries.delete(row.key);
    this.entries.set(row.key, entry);
    while (this.entries.size > this.maxMeasurements) {
      const oldestKey = this.entries.keys().next().value as string | number | undefined;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  createInitialMeasurements(rows: readonly TranscriptRow[]): InitialTranscriptMeasurements {
    const activeWidthBucket = this.latestWidthBucket;
    if (activeWidthBucket === null || rows.length === 0) {
      return { measurements: [], reusedCount: 0, widthBucket: activeWidthBucket };
    }

    // TanStack accepts a sparse initial cache: it extracts key/size pairs, then
    // rebuilds every start/end from index zero. Sparse entries avoid marking
    // estimator-only rows as measured.
    const measurements = new Array<VirtualItem>(rows.length);
    let reusedCount = 0;
    rows.forEach((row, index) => {
      const cached = this.entries.get(row.key);
      const signature = stableRowSignature(row);
      if (!cached
        || signature === null
        || cached.widthBucket !== activeWidthBucket
        || cached.estimatedSize !== estimateTranscriptRowSize(row)
        || cached.signature !== signature) {
        return;
      }

      measurements[index] = {
        index,
        key: row.key,
        lane: 0,
        start: 0,
        size: cached.size,
        end: cached.size,
      };
      reusedCount += 1;
      this.entries.delete(row.key);
      this.entries.set(row.key, cached);
    });

    return { measurements, reusedCount, widthBucket: activeWidthBucket };
  }
}

export const transcriptMeasurementCache = new TranscriptMeasurementCache();
