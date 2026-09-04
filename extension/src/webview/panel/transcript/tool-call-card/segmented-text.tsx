/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useMemo } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { utf8ByteLength } from '../../../../shared/utf8';

/**
 * Bounded rendering of oversized tool input/output text.
 *
 * A single huge string must never become one giant DOM text node (highlighting
 * and layout cost scale with the node, and one node cannot be independently
 * virtualized). Above a threshold the text is split into exact UTF-8-safe
 * segments at code-point boundaries (preferring newline breaks) and each
 * segment renders as its own bounded block keyed by its stable semantic
 * identity (tool call id + field + byte range). Segments are exact: their
 * byte ranges sum to the total with no truncation or ellipsis.
 */

export const TOOL_TEXT_SEGMENT_DEFAULT_CHARS = 128 * 1024;

let segmentThreshold = TOOL_TEXT_SEGMENT_DEFAULT_CHARS;

/** Test injection: shrink the threshold so oversized-segment behavior is
 *  exercisable with tiny fixtures. */
export function setToolTextSegmentThreshold(chars: number): void {
  segmentThreshold = Math.max(64, Math.floor(chars));
}

export interface TextSegment {
  /** Inclusive code-point start (semantic identity). */
  start: number;
  /** Exclusive code-point end. */
  end: number;
  /** Exact UTF-8 byte range of this segment inside the full text. */
  startByte: number;
  endByte: number;
  totalBytes: number;
  text: string;
}

/** Split one string into bounded, UTF-8-safe segments. Splits only between
 *  Unicode code points, preferring a newline boundary near the budget so code
 *  lines stay intact. Returns the full text as one segment when it fits. */
export function splitOversizedText(text: string, maxChars: number): TextSegment[] {
  const points = [...text];
  const totalBytes = utf8ByteLength(text);
  const limit = Math.max(1, Math.floor(maxChars));
  const segments: TextSegment[] = [];
  let start = 0;
  let byteOffset = 0;
  while (start < points.length) {
    let end = Math.min(points.length, start + limit);
    if (end < points.length) {
      // Back off to the last newline inside the trailing half of the budget.
      const floor = start + Math.max(1, Math.floor(limit / 2));
      let breakAt = -1;
      for (let index = end - 1; index >= floor; index -= 1) {
        if (points[index] === '\n') {
          breakAt = index;
          break;
        }
      }
      if (breakAt !== -1) end = breakAt + 1;
    }
    const segmentText = points.slice(start, end).join('');
    const segmentBytes = utf8ByteLength(segmentText);
    segments.push({
      start,
      end,
      startByte: byteOffset,
      endByte: byteOffset + segmentBytes,
      totalBytes,
      text: segmentText,
    });
    byteOffset += segmentBytes;
    start = end;
  }
  return segments.length > 0 ? segments : [{ start: 0, end: 0, startByte: 0, endByte: 0, totalBytes: 0, text: '' }];
}

export function getToolTextSegmentThreshold(): number {
  return segmentThreshold;
}

interface SegmentedTextProps {
  text: string;
  /** Stable semantic identity prefix (e.g. `${toolCall.id}:result`). */
  identity: string;
  /** Renders one bounded segment's content (e.g. highlighted `<code>`). */
  renderSegment: (segmentText: string) => ComponentChildren;
  /** Optional per-segment override; defaults to the module threshold. */
  maxChars?: number;
}

export function SegmentedText({ text, identity, renderSegment, maxChars }: SegmentedTextProps) {
  const limit = maxChars ?? segmentThreshold;
  const segments = useMemo(
    () => (text.length <= limit ? null : splitOversizedText(text, limit)),
    [text, limit],
  );
  if (!segments) {
    return <>{renderSegment(text)}</>;
  }
  return (
    <div class="tool-call-segmented">
      {segments.map((segment) => (
        <div class="tool-call-segment" key={`${identity}:${segment.start}`}>
          <div class="tool-call-segment-range" aria-label={`Output segment ${segment.startByte}-${segment.endByte} of ${segment.totalBytes} bytes`}>
            bytes {segment.startByte}–{segment.endByte} / {segment.totalBytes}
          </div>
          {renderSegment(segment.text)}
        </div>
      ))}
    </div>
  );
}
