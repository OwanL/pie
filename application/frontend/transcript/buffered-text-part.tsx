/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { renderMarkdown } from './markdown';
import { handleDelegatedFilePathClick, handleDelegatedFilePathContextMenu, handleDelegatedFilePathKeyDown } from './file-path-interactions';
import type { TranscriptContextMenuHandler } from './types';
import { useCommittedTextLeaf } from './commit-registry';
import { hasSelectionOverlapping } from './selection-overlap';

interface BufferedTextPartProps {
  messageId: string;
  index: number;
  text: string;
  streaming: boolean;
  workingDirectory: string | null;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: JSX.TargetedMouseEvent<HTMLDivElement>) => void;
  onFilePathContextMenu: TranscriptContextMenuHandler;
}

/** Re-parse streamed markdown at most this often (ms): bounds marked+DOMPurify cost and reduces mid-token flicker. */
const MARKDOWN_PARSE_THROTTLE_MS = 100;

/** While the user has an active text selection overlapping the body, skip
 *  innerHTML updates and poll until the selection clears. */
const SELECTION_DEFER_POLL_MS = 200;

/**
 * Renders a text part while it streams.
 *
 * The body does not typewriter-reveal host snapshots. A large snapshot is
 * already bounded by host delivery and must become visible as one truthful
 * DOM update; otherwise the renderer creates an artificial backlog behind the
 * host and cannot acknowledge the text it has actually received. Markdown is
 * still re-parsed at most every `MARKDOWN_PARSE_THROTTLE_MS` while streaming,
 * and the rendered text is kept alongside the HTML so commit evidence only
 * reports what is mounted in the body.
 *
 * While the user is selecting text overlapping the body, innerHTML updates
 * are deferred until the selection clears — otherwise each distinct html
 * string resets innerHTML, recreating DOM nodes and clearing the Selection.
 */
export function BufferedTextPart({ messageId, index, text, streaming, workingDirectory, onOpenFile, onContextMenu, onFilePathContextMenu }: BufferedTextPartProps) {
  // Advance this synchronously with prop replacement, before effects from the
  // previous render can run. A terminal/replacement render therefore fences an
  // already-queued streaming parse instead of allowing it to publish stale
  // text after the newer render wins.
  const streamGenerationRef = useRef({ text, streaming, generation: 0 });
  if (streamGenerationRef.current.text !== text || streamGenerationRef.current.streaming !== streaming) {
    streamGenerationRef.current = {
      text,
      streaming,
      generation: streamGenerationRef.current.generation + 1,
    };
  }
  const streamGeneration = streamGenerationRef.current.generation;
  const [rendered, setRendered] = useState(() => ({
    html: renderMarkdown(text, !streaming),
    text,
  }));
  const lastParseAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const timerGenerationRef = useRef<number | null>(null);
  const latestTextRef = useRef(text);
  latestTextRef.current = text;

  // Selection-aware update machinery: the body element, the latest desired
  // html, and a deferred-apply timer used while a selection is active.
  const bodyRef = useRef<HTMLDivElement>(null);
  const pendingHtmlRef = useRef<{ html: string; text: string } | null>(null);
  const deferTimerRef = useRef<number | null>(null);

  /** Apply `nextHtml` now unless a selection overlaps the body, in which case
   *  retain only the latest candidate until the selection clears. */
  function applyHtml(nextHtml: string, representedText: string) {
    pendingHtmlRef.current = { html: nextHtml, text: representedText };
    // A deferred apply is already scheduled — it will pick up the latest
    // pending html when it fires, so don't schedule another.
    if (deferTimerRef.current !== null) return;
    if (!hasSelectionOverlapping(bodyRef.current)) {
      setRendered({ html: nextHtml, text: representedText });
      pendingHtmlRef.current = null;
      return;
    }
    scheduleDeferredApply();
  }

  function scheduleDeferredApply() {
    deferTimerRef.current = window.setTimeout(() => {
      deferTimerRef.current = null;
      if (pendingHtmlRef.current === null) return;
      if (!hasSelectionOverlapping(bodyRef.current)) {
        setRendered(pendingHtmlRef.current);
        pendingHtmlRef.current = null;
        return;
      }
      // Keep the user's selection intact for its full lifetime. The next poll
      // applies whichever pending snapshot is newest when the selection clears.
      scheduleDeferredApply();
    }, SELECTION_DEFER_POLL_MS);
  }

  useEffect(() => {
    // If a newer streaming render superseded a deferred parse, re-arm it for
    // the current generation. This is needed when snapshots replace text more
    // quickly than the markdown throttle rather than merely append to it.
    if (timerRef.current !== null && timerGenerationRef.current !== streamGeneration) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
      timerGenerationRef.current = null;
    }

    if (!streaming) {
      // Final render: parse the complete text immediately and cancel any
      // pending throttled parse.
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
        timerGenerationRef.current = null;
      }
      applyHtml(renderMarkdown(latestTextRef.current), latestTextRef.current);
      return;
    }

    const now = Date.now();
    if (now - lastParseAtRef.current >= MARKDOWN_PARSE_THROTTLE_MS) {
      lastParseAtRef.current = now;
      applyHtml(renderMarkdown(latestTextRef.current, false), latestTextRef.current);
      return;
    }

    // Schedule a parse at the end of the throttle window if one isn't already
    // pending. The scheduled parse reads the latest host text via the ref, so
    // a newer snapshot wins even when it arrives before the timer fires.
    if (timerRef.current === null) {
      const generation = streamGeneration;
      const timerId = window.setTimeout(() => {
        if (timerRef.current === timerId) {
          timerRef.current = null;
          timerGenerationRef.current = null;
        }
        // Effects can be delayed across a terminal/replacement commit. Do not
        // let a stale callback acknowledge or render text from that old stream.
        if (streamGenerationRef.current.generation !== generation || !streamGenerationRef.current.streaming) return;
        lastParseAtRef.current = Date.now();
        applyHtml(renderMarkdown(latestTextRef.current, false), latestTextRef.current);
      }, MARKDOWN_PARSE_THROTTLE_MS);
      timerRef.current = timerId;
      timerGenerationRef.current = generation;
    }
  }, [text, streaming, streamGeneration]);

  // Clear any pending throttled / deferred parse on unmount.
  useEffect(() => () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
      timerGenerationRef.current = null;
    }
    if (deferTimerRef.current !== null) {
      window.clearTimeout(deferTimerRef.current);
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
      onClick={(e) => {
        handleDelegatedFilePathClick(e, workingDirectory, onOpenFile);
      }}
      onKeyDown={(e) => {
        handleDelegatedFilePathKeyDown(e, workingDirectory, onOpenFile);
      }}
      onContextMenu={(e) => {
        if (handleDelegatedFilePathContextMenu(e, workingDirectory, onFilePathContextMenu)) return;
        e.preventDefault();
        onContextMenu(e);
      }}
    />
  );
}
