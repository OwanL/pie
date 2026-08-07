/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useMemo } from 'preact/hooks';
import type { VirtualItem, Virtualizer } from '@tanstack/virtual-core';

import type { ChatMessage, UserContentPart } from '../../../shared/protocol';
import { getRenderableUserParts } from './parts';
import type { TranscriptRow } from './virtual-list-rows';

/** Default hit-area height per marker (px) when no pref is supplied. The
 *  user-configurable `uiMessageRailSize` pref overrides this; the visible dot
 *  scales with it via the `--message-rail-marker-size` CSS var. */
const DEFAULT_MARKER_HIT_HEIGHT_PX = 20;
/** Minimum vertical gap between consecutive marker centers (px). Set equal to
 *  the hit height so adjacent hit areas touch without overlapping — every
 *  visible marker is individually clickable. In very long sessions dense
 *  clusters collapse the later messages into the nearest kept marker (jumping
 *  there lands near the collapsed ones anyway). */
const PREVIEW_MAX_CHARS = 160;

interface RailMarker {
  rowIndex: number;
  messageId: string;
  /** Center position within the rail (px from top), clamped to the rail bounds. */
  top: number;
  preview: string;
}

type UserTextPart = Extract<UserContentPart, { kind: 'text' }>;

function buildUserMessagePreview(message: ChatMessage): string {
  const parts = getRenderableUserParts(message);
  let text = '';
  if (parts && parts.length > 0) {
    text = parts
      .filter((part): part is UserTextPart => part.kind === 'text')
      .map((part) => part.text)
      .join(' ')
      .trim();
  }
  if (!text) {
    text = (message.markdown || '').trim();
  }
  if (!text) {
    const imageCount = parts?.filter((part) => part.kind === 'image').length ?? 0;
    return imageCount > 0 ? `(${imageCount} image${imageCount > 1 ? 's' : ''})` : '(empty)';
  }
  const single = text.replace(/\s+/g, ' ').slice(0, PREVIEW_MAX_CHARS);
  return single.length === PREVIEW_MAX_CHARS ? `${single}…` : single;
}

interface BuildMarkersArgs {
  rows: readonly TranscriptRow[];
  measurements: readonly VirtualItem[];
  railHeight: number;
  totalSize: number;
  markerHitHeight: number;
}

function buildMarkers({ rows, measurements, railHeight, totalSize, markerHitHeight }: BuildMarkersArgs): RailMarker[] {
  if (railHeight <= 0 || totalSize <= 0) return [];
  const half = markerHitHeight / 2;
  const maxCenter = Math.max(half, railHeight - half);
  // Adjacent hit areas touch without overlapping; in dense clusters the later
  // messages collapse into the nearest kept marker.
  const minGap = markerHitHeight;
  const markers: RailMarker[] = [];
  let lastCenter = -Infinity;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row?.kind !== 'message' || row.message.role !== 'user') continue;
    const measured = measurements[i];
    if (!measured) continue;
    const ratio = totalSize > 0 ? measured.start / totalSize : 0;
    const center = Math.min(maxCenter, Math.max(half, ratio * railHeight));
    if (center - lastCenter < minGap) continue;
    markers.push({
      rowIndex: i,
      messageId: row.message.id,
      top: center,
      preview: buildUserMessagePreview(row.message),
    });
    lastCenter = center;
  }
  return markers;
}

interface MessageRailProps {
  rows: readonly TranscriptRow[];
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>;
  scrollRef: { current: HTMLDivElement | null };
  setAutoFollow: (v: boolean) => void;
  /** Hit-area height (px) per marker — the user-configurable
   *  `uiMessageRailSize` pref. The visible dot scales with it via the
   *  `--message-rail-marker-size` CSS var. */
  markerSize: number;
  /** Suppress rendering during the virtualizer's initial positioning phase
   *  (when `.transcript` is opacity:0) so markers don't flash in first. */
  hidden?: boolean;
}

/**
 * A thin vertical strip of clickable markers rendered in the gap just to the
 * left of the scrollbar. Each marker corresponds to a user message in the
 * loaded transcript window; clicking it instantly scrolls that message to the
 * top of the viewport.
 *
 * Marker positions are derived from the virtualizer's measurement cache
 * (`measurementsCache[i].start`), which uses real measured heights for rows
 * that have been rendered and `estimateSize` estimates for the rest — so the
 * rail behaves like a minimap: approximate for far/unseen messages, exact for
 * those already measured. The parent re-renders on every virtualizer change
 * (content growth, scroll, viewport resize) which keeps the rail live.
 */
export function MessageRail({ rows, virtualizer, scrollRef, setAutoFollow, markerSize, hidden }: MessageRailProps) {
  const railHeight = scrollRef.current?.clientHeight ?? 0;
  const totalSize = virtualizer.getTotalSize();
  const measurements = virtualizer.measurementsCache;
  const markerHitHeight = markerSize > 0 ? markerSize : DEFAULT_MARKER_HIT_HEIGHT_PX;

  const markers = useMemo(
    () => buildMarkers({ rows, measurements, railHeight, totalSize, markerHitHeight }),
    [rows, measurements, railHeight, totalSize, markerHitHeight],
  );

  const handleJump = useCallback((rowIndex: number) => {
    const el = scrollRef.current;
    if (!el) return;
    // Disengage auto-follow so exact pinning does not immediately return to the
    // bottom and fight the jump. A scroll event from the
    // programmatic scroll disengages it for upward jumps anyway, but a forward
    // jump to a mid-content message leaves autoFollow true (no upward motion
    // detected by resolveAutoFollowState), so this explicit toggle is required.
    setAutoFollow(false);
    // Instant jump: override the container's `scroll-behavior: smooth` for the
    // call. tanstack's scrollState reconciliation then corrects any estimate
    // drift (rows whose real measured height differs from their estimate) as
    // the target row renders into view.
    const prior = el.style.scrollBehavior;
    try {
      el.style.scrollBehavior = 'auto';
      virtualizer.scrollToIndex(rowIndex, { align: 'start' });
    } finally {
      el.style.scrollBehavior = prior;
    }
  }, [scrollRef, setAutoFollow, virtualizer]);

  if (hidden || markers.length === 0) return null;

  return (
    <div class="transcript-message-rail" aria-label="User message navigation">
      {markers.map((marker) => (
        <button
          type="button"
          key={marker.messageId}
          class="transcript-message-rail-marker"
          title={marker.preview}
          aria-label={`Jump to message: ${marker.preview}`}
          style={{ top: `${marker.top}px`, height: `${markerHitHeight}px` }}
          onClick={() => handleJump(marker.rowIndex)}
        />
      ))}
    </div>
  );
}
