/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { renderMarkdown } from '../markdown';
import { useBufferedText } from './use-buffered-text';
import { useCommittedTextLeaf } from './commit-registry';

interface BufferedTextPartProps {
  messageId: string;
  index: number;
  text: string;
  streaming: boolean;
  onContextMenu: (e: JSX.TargetedMouseEvent<HTMLDivElement>) => void;
}

/** Re-parse streamed markdown at most this often (ms): bounds marked+DOMPurify cost and reduces mid-token flicker. */
const MARKDOWN_PARSE_THROTTLE_MS = 100;

/** While the user has an active text selection anchored in the streaming body,
 *  skip innerHTML updates (which would destroy the Selection). Poll this often
 *  (ms) to apply the deferred update once the selection clears. */
const SELECTION_DEFER_POLL_MS = 200;
/** Maximum total defer (ms) before the pending update is force-applied even if
 *  a selection is still active, so streaming output cannot fall behind
 *  indefinitely. */
const SELECTION_FORCE_APPLY_MS = 1500;

/** True when the user has a non-collapsed text selection rooted inside `el`. */
function hasSelectionInBody(el: HTMLDivElement | null): boolean {
  if (!el) return false;
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  const anchor = sel.anchorNode;
  if (!anchor) return false;
  return el.contains(anchor);
}

/**
 * Renders a text part with buffered smooth streaming.
 *
 * During streaming, text is revealed progressively to prevent layout jumps
 * when large chunks arrive at once. Once streaming ends, full text is shown.
 *
 * Markdown is re-parsed at most every `MARKDOWN_PARSE_THROTTLE_MS` during
 * streaming instead of on every rAF tick: the buffered text is sliced to the
 * revealed length each frame, so re-parsing every frame both wastes work
 * (marked + DOMPurify) and flickers, since mid-token slices yield malformed
 * markdown. When streaming ends the complete text is parsed immediately.
 *
 * While the user is selecting text inside the streaming body, innerHTML
 * updates are deferred (re-applied once the selection clears or after a short
 * timeout) — otherwise each distinct html string resets innerHTML, recreating
 * DOM nodes and clearing the user's Selection up to 10x/s.
 */
export function BufferedTextPart({ messageId, index, text, streaming, onContextMenu }: BufferedTextPartProps) {
  const visibleText = useBufferedText(text, streaming);
  const initialText = streaming ? visibleText : text;
  const [rendered, setRendered] = useState(() => ({
    html: renderMarkdown(initialText, !streaming),
    text: initialText,
  }));
  const lastParseAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const visibleTextRef = useRef(visibleText);
  visibleTextRef.current = visibleText;

  // Selection-aware update machinery: the body element, the latest desired
  // html, and a deferred-apply timer used while a selection is active.
  const bodyRef = useRef<HTMLDivElement>(null);
  const pendingHtmlRef = useRef<{ html: string; text: string } | null>(null);
  const deferTimerRef = useRef<number | null>(null);
  const deferStartedAtRef = useRef(0);

  /** Apply `nextHtml` now unless the user is mid-selection in the body, in
   *  which case defer it (re-checked on a poll, force-applied after a timeout). */
  function applyHtml(nextHtml: string, representedText: string) {
    pendingHtmlRef.current = { html: nextHtml, text: representedText };
    // A deferred apply is already scheduled — it will pick up the latest
    // pending html when it fires, so don't schedule another.
    if (deferTimerRef.current !== null) return;
    if (!hasSelectionInBody(bodyRef.current)) {
      setRendered({ html: nextHtml, text: representedText });
      pendingHtmlRef.current = null;
      return;
    }
    deferStartedAtRef.current = Date.now();
    scheduleDeferredApply();
  }

  function scheduleDeferredApply() {
    deferTimerRef.current = window.setTimeout(() => {
      deferTimerRef.current = null;
      if (pendingHtmlRef.current === null) return;
      const elapsed = Date.now() - deferStartedAtRef.current;
      if (elapsed >= SELECTION_FORCE_APPLY_MS || !hasSelectionInBody(bodyRef.current)) {
        setRendered(pendingHtmlRef.current);
        pendingHtmlRef.current = null;
        return;
      }
      // Still selecting — keep deferring.
      scheduleDeferredApply();
    }, SELECTION_DEFER_POLL_MS);
  }

  useEffect(() => {
    if (!streaming) {
      // Final render: parse the complete text immediately and cancel any
      // pending throttled parse.
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      applyHtml(renderMarkdown(visibleTextRef.current), visibleTextRef.current);
      return;
    }

    const now = Date.now();
    if (now - lastParseAtRef.current >= MARKDOWN_PARSE_THROTTLE_MS) {
      lastParseAtRef.current = now;
      applyHtml(renderMarkdown(visibleTextRef.current, false), visibleTextRef.current);
      return;
    }

    // Schedule a parse at the end of the throttle window if one isn't already
    // pending. The scheduled parse reads the latest revealed text via the ref
    // so it always reflects the most recent frame.
    if (timerRef.current === null) {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        lastParseAtRef.current = Date.now();
        applyHtml(renderMarkdown(visibleTextRef.current, false), visibleTextRef.current);
      }, MARKDOWN_PARSE_THROTTLE_MS);
    }
  }, [visibleText, streaming]);

  // Clear any pending throttled / deferred parse on unmount.
  useEffect(() => () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (deferTimerRef.current !== null) {
      clearTimeout(deferTimerRef.current);
      deferTimerRef.current = null;
    }
  }, []);

  useCommittedTextLeaf(messageId, index, rendered.text);

  return (
    <div
      key={`text-${messageId}-${index}`}
      class={`message-body${streaming ? ' streaming-text' : ''}`}
      ref={bodyRef}
      dangerouslySetInnerHTML={{ __html: rendered.html }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e);
      }}
    />
  );
}
