/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import type {
  DetailResult,
  LazyDetailRef,
  WebviewToHostMessage,
} from '../../../shared/protocol';

export type LazyDetailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; value: unknown }
  | { status: 'failure' | 'unavailable' | 'stale'; message: string };

const MAX_ENTRIES = 32;
const MAX_BYTES = 64 * 1024 * 1024;
const entries = new Map<string, { state: LazyDetailState; bytes: number }>();
const inFlight = new Set<string>();
const subscribers = new Set<() => void>();
let post: ((message: WebviewToHostMessage) => void) | undefined;

function notify(): void {
  for (const subscriber of subscribers) subscriber();
}

function touch(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  entries.set(key, entry);
}

function enforceBounds(): void {
  let bytes = [...entries.values()].reduce((total, entry) => total + entry.bytes, 0);
  while (entries.size > MAX_ENTRIES || bytes > MAX_BYTES) {
    const oldestKey = entries.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = entries.get(oldestKey);
    entries.delete(oldestKey);
    inFlight.delete(oldestKey);
    bytes -= oldest?.bytes ?? 0;
  }
}

export function setLazyDetailPostMessage(value: (message: WebviewToHostMessage) => void): void {
  post = value;
}

export function clearLazyDetailCache(): void {
  entries.clear();
  inFlight.clear();
  notify();
}

export function receiveLazyDetailResult(result: DetailResult): void {
  inFlight.delete(result.key);
  entries.delete(result.key);
  entries.set(result.key, result.status === 'loaded'
    ? { state: { status: 'loaded', value: result.value }, bytes: result.sizeBytes }
    : { state: { status: result.status, message: result.message }, bytes: 0 });
  enforceBounds();
  notify();
}

export function requestLazyDetail(sessionPath: string, ref: LazyDetailRef, force = false): void {
  const existing = entries.get(ref.key)?.state;
  if (!force && (existing?.status === 'loading' || existing?.status === 'loaded')) {
    touch(ref.key);
    return;
  }
  if (inFlight.has(ref.key)) return;
  inFlight.add(ref.key);
  entries.delete(ref.key);
  entries.set(ref.key, { state: { status: 'loading' }, bytes: 0 });
  notify();
  post?.({ type: 'requestDetail', sessionPath, ref });
}

export function useLazyDetail(
  ref: LazyDetailRef | undefined,
  expanded: boolean,
): { state: LazyDetailState; retry: () => void } {
  const [, setVersion] = useState(0);
  const wasExpanded = useRef(false);
  const previousKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    const subscriber = () => setVersion((value) => value + 1);
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  }, []);
  useEffect(() => {
    // Request on the expansion edge (or when detail first becomes available),
    // not on every live revision while an already-open row is streaming.
    const shouldRequest = expanded && ref
      && (!wasExpanded.current || previousKey.current === undefined);
    wasExpanded.current = expanded;
    previousKey.current = ref?.key;
    if (shouldRequest) requestLazyDetail(ref.sessionPath, ref);
  }, [expanded, ref?.key]);
  const retry = useCallback(() => {
    if (ref) requestLazyDetail(ref.sessionPath, ref, true);
  }, [ref?.key]);
  const state = ref ? entries.get(ref.key)?.state ?? { status: 'idle' as const } : { status: 'idle' as const };
  if (ref && state.status === 'loaded') touch(ref.key);
  return { state, retry };
}
