/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import { animateHeightChange, cancelHeightMotion } from '../lib/components/height-motion';
import { messageRenderIdentity } from './render-identity';
import type { TranscriptRow } from './virtual-list-rows';

type Entrance = { from: number; expires: number; claimed: boolean };
const DURATION = 170;
const isPlaceholder = (row: TranscriptRow) => row.kind === 'message'
  && row.message.id.startsWith('assistant-placeholder:');

/** List-owned arrivals: mounting a virtual row is not evidence of a new message. */
export function useLiveMessageArrivals(
  rows: readonly TranscriptRow[], sessionKey: string | null, busy: boolean, hasNewer: boolean,
) {
  const state = useRef<{
    session: string | null; rows: readonly TranscriptRow[]; busy: boolean; hasNewer: boolean;
    entrances: Map<string, Entrance>; seen: Set<string>;
  } | null>(null);
  const placeholders = useRef(new Map<string, HTMLDivElement>());
  const previous = state.current;
  if (!previous || previous.session !== sessionKey || previous.rows !== rows) {
    const messages = rows.filter((row) => row.kind === 'message');
    const seen = previous?.session === sessionKey ? previous.seen : new Set<string>();
    const entrances = previous?.session === sessionKey ? previous.entrances : new Map<string, Entrance>();
    const oldTail = previous?.rows.filter((row) => row.kind === 'message' && !isPlaceholder(row)).pop();
    const boundary = oldTail ? rows.findIndex((row) => row.key === oldTail.key) : -1;
    const oldPlaceholder = previous?.rows.find(isPlaceholder);
    let placeholderHeight: number | undefined;
    for (const row of messages) {
      if (row.kind !== 'message') continue;
      const identity = messageRenderIdentity(row.message);
      if (previous && previous.session === sessionKey && !previous.hasNewer && !hasNewer
        && (busy || previous.busy) && !seen.has(identity) && !isPlaceholder(row)
        && row.message.role === 'assistant' && (boundary >= 0 || oldPlaceholder)
        && rows.indexOf(row) > boundary) {
        // Read only the outgoing placeholder, before reconciliation removes it.
        if (oldPlaceholder && placeholderHeight === undefined) {
          placeholderHeight = placeholders.current.get(oldPlaceholder.key)?.getBoundingClientRect().height;
        }
        entrances.set(row.key, { from: placeholderHeight ?? 0, expires: Date.now() + DURATION, claimed: false });
        placeholderHeight = 0;
      }
      seen.add(identity);
    }
    for (const [key, entrance] of entrances) {
      if (entrance.expires <= Date.now()) entrances.delete(key);
    }
    state.current = { session: sessionKey, rows, busy, hasNewer, entrances, seen };
  } else {
    previous.busy = busy;
    previous.hasNewer = hasNewer;
  }
  const entrances = state.current!.entrances;
  return useMemo(() => ({ entrances, placeholders: placeholders.current }), [entrances]);
}

export function LiveMessageMotion({ children, enabled, entrance, placeholderKey, placeholders }: {
  children: ComponentChildren;
  enabled: boolean;
  entrance?: Entrance;
  placeholderKey?: string;
  placeholders: Map<string, HTMLDivElement>;
}) {
  const shell = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = shell.current;
    const inner = content.current;
    if (!node || !inner) return;
    if (placeholderKey) placeholders.set(placeholderKey, node);
    let observer: ResizeObserver | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { observer?.disconnect(); cancelHeightMotion(node); };
    if (entrance && !entrance.claimed && entrance.expires > Date.now()) {
      entrance.claimed = true;
      const remaining = () => Math.max(0, entrance.expires - Date.now());
      animateHeightChange(node, () => {}, { from: entrance.from, duration: remaining(), easing: 'ease-out' });
      let height = inner.getBoundingClientRect().height;
      // Observe natural content, not the animated shell. Never extend the deadline.
      if (typeof ResizeObserver !== 'undefined') observer = new ResizeObserver(() => {
        const next = inner.getBoundingClientRect().height;
        const grew = next > height;
        height = next;
        if (!grew) return;
        if (remaining() && node.hasAttribute('data-height-moving')) {
          animateHeightChange(node, () => {}, { duration: remaining(), easing: 'ease-out' });
        } else stop();
      });
      if (node.hasAttribute('data-height-moving')) {
        observer?.observe(inner);
        node.addEventListener('height-motion-end', stop);
        timer = setTimeout(stop, remaining());
      }
    }
    return () => {
      node.removeEventListener('height-motion-end', stop);
      stop();
      clearTimeout(timer);
      if (placeholderKey && placeholders.get(placeholderKey) === node) placeholders.delete(placeholderKey);
    };
  }, [entrance, placeholderKey, placeholders]);
  // User bubbles must remain direct flex children of the positioned row.
  if (!enabled) return <>{children}</>;
  return <div ref={shell} class="live-message-space w-full"><div ref={content} class="w-full">{children}</div></div>;
}
