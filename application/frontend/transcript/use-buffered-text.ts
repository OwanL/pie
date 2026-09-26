import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * Buffered text streaming hook.
 *
 * When `streaming` is true, reveals *new* text (text that arrives after mount)
 * progressively at a smooth rate to prevent jarring layout shifts from large
 * text chunks arriving at once. Text already present at mount time is shown
 * immediately. When `streaming` is false (message complete), returns the full text.
 *
 * The hook uses requestAnimationFrame to advance the visible portion of text
 * at a configurable characters-per-frame rate, producing a smooth typewriter
 * effect that keeps the chat from jumping.
 */

/** Characters revealed per animation frame (~60fps → ~6000 chars/sec). */
const DEFAULT_CHARS_PER_FRAME = 100;
/** Minimum characters to reveal per tick (avoids single-char stuttering). */
const DEFAULT_MIN_ADVANCE = 20;
/** When remaining buffer is small, reveal instantly to avoid trailing lag. */
const DEFAULT_SNAP_THRESHOLD = 40;

/** Tunable reveal rate for {@link useBufferedText}. Callers that want a more
 *  visible "typing in" effect (e.g. the compact activity tail) pass a smaller
 *  `charsPerFrame` so new text streams in over several frames instead of
 *  snapping in a single frame. Defaults match the fast-reveal tune used by
 *  streaming message bodies, so omitting this preserves the original behavior. */
export interface BufferedTextRate {
  /** Characters revealed per animation frame before catch-up scaling. */
  charsPerFrame?: number;
  /** Floor on characters revealed per tick (avoids single-char stuttering). */
  minAdvance?: number;
  /** When remaining buffer is at or below this, reveal instantly to avoid trailing lag. */
  snapThreshold?: number;
  /** Cap on the catch-up scale factor applied when the buffer is large (fast
   *  bursts). Lower values keep the reveal slow and readable even when a lot of
   *  text has accumulated, strengthening the "buffer then stream in" feel.
   *  Defaults to 8 (fast catch-up, matching streaming message bodies). */
  maxScaleFactor?: number;
}

/** True when `next` is `prev` grown by appending characters — a clean
 *  continuation of the same stream. The buffer keeps its revealed length across
 *  such growth so the typewriter effect is continuous. When the source is
 *  replaced by a *different* stream (e.g. the activity tail switches from
 *  reasoning to reply, or from one tool's output to another's), this returns
 *  false so the caller re-seeds to the new current text instead of carrying
 *  the old stream's revealed length forward — which would suppress animation
 *  until the new stream surpassed the old length. An empty `prev` is treated
 *  as a continuation (mount / reset state). */
export function isForwardExtension(prev: string, next: string): boolean {
  return prev.length === 0 || (next.length >= prev.length && next.startsWith(prev));
}

export function useBufferedText(
  fullText: string,
  streaming: boolean,
  rate?: BufferedTextRate,
): string {
  const charsPerFrame = rate?.charsPerFrame ?? DEFAULT_CHARS_PER_FRAME;
  const minAdvance = rate?.minAdvance ?? DEFAULT_MIN_ADVANCE;
  const snapThreshold = rate?.snapThreshold ?? DEFAULT_SNAP_THRESHOLD;
  // Start at current text length — text already present at mount is visible immediately.
  const [visibleLength, setVisibleLength] = useState(() => fullText.length);
  const rafRef = useRef<number | null>(null);
  const targetLengthRef = useRef(fullText.length);
  // Latest revealed length, kept in sync so the growth effect can decide whether
  // to re-arm the rAF loop without depending on `visibleLength` state (which
  // would re-run the effect every animation frame).
  const visibleLengthRef = useRef(fullText.length);
  // Previously-seen source text, used to detect when the underlying stream is
  // replaced (not a forward extension) so the buffer re-seeds to the new text.
  const prevTextRef = useRef(fullText);

  targetLengthRef.current = fullText.length;

  // When streaming stops, immediately show all text and stop the loop.
  useEffect(() => {
    if (!streaming) {
      visibleLengthRef.current = fullText.length;
      setVisibleLength(fullText.length);
      prevTextRef.current = fullText;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }
  }, [streaming, fullText.length]);

  // Reveal loop. Advances the visible length toward the target at a bounded
  // rate, but STOPS itself once it catches up (current >= target) instead of
  // rescheduling a no-op rAF every frame for the whole streaming duration. The
  // effect re-arms the loop whenever new text arrives (fullText grows) and the
  // view has fallen behind, so each text part runs at most one rAF chain
  // rather than a never-stopping loop that no-ops every frame.
  useEffect(() => {
    if (!streaming) return;

    // If the source was replaced by a different stream (not a forward
    // extension), re-seed the reveal length to the new current text so the new
    // stream animates from its own start instead of inheriting the old stream's
    // revealed length (which would hide animation until the new stream grew
    // past it). Depending on `fullText` (value) — not just its length — also
    // catches same-length replacements (e.g. a subagent status line changing).
    // The render below returns the full new text on replacement (via the same
    // check against prevTextRef), so this post-render re-seed causes no flash;
    // subsequent growth then types in via the normal rAF reveal.
    if (!isForwardExtension(prevTextRef.current, fullText)) {
      visibleLengthRef.current = fullText.length;
      setVisibleLength(fullText.length);
      prevTextRef.current = fullText;
      return; // caught up to the new current text; re-armed on its next growth
    }
    prevTextRef.current = fullText;

    const tick = () => {
      rafRef.current = null;
      const current = visibleLengthRef.current;
      const target = targetLengthRef.current;
      if (current >= target) {
        return; // caught up — loop stops; re-armed on next growth
      }
      const remaining = target - current;
      let next: number;
      if (remaining <= snapThreshold) {
        next = target;
      } else {
        // Scale rate by how much buffer we have — larger buffers reveal faster
        // to prevent the visible text falling too far behind. The scale factor
        // is capped (default 8) so a fast burst can't make the reveal outrun a
        // readable pace; callers that want a stronger buffer/typing effect pass
        // a lower `maxScaleFactor`.
        const maxScaleFactor = rate?.maxScaleFactor ?? 8;
        const scaleFactor = Math.min(maxScaleFactor, 1 + Math.floor(remaining / 100));
        const advance = Math.max(minAdvance, charsPerFrame * scaleFactor);
        next = Math.min(target, current + advance);
      }
      visibleLengthRef.current = next;
      setVisibleLength(next);
      if (next < targetLengthRef.current) {
        rafRef.current = requestAnimationFrame(tick); // still behind — keep going
      }
      // else caught up; loop stops here, re-armed when fullText grows.
    };

    // (Re-)arm whenever new text arrives and we're behind.
    if (visibleLengthRef.current < targetLengthRef.current && rafRef.current === null) {
      rafRef.current = requestAnimationFrame(tick);
    }

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [streaming, fullText]);

  // If not streaming, always return full text (handles initial non-streaming render)
  if (!streaming) {
    return fullText;
  }

  // If the source was just replaced by a different stream (detected against
  // the last-seen text, which the effect updates after each render), show it in
  // full on this render so there is no truncation flash before the effect
  // re-seeds the reveal length for the new stream.
  if (prevTextRef.current.length > 0 && !isForwardExtension(prevTextRef.current, fullText)) {
    return fullText;
  }

  return fullText.slice(0, visibleLength);
}
