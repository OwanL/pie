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
const subscribersByKey = new Map<string, Set<() => void>>();
let cacheGeneration = 0;
let post: ((message: WebviewToHostMessage) => void) | undefined;

function notifyKey(key: string): void {
  for (const subscriber of subscribersByKey.get(key) ?? []) subscriber();
}

function notifyAll(): void {
  for (const subscribers of subscribersByKey.values()) {
    for (const subscriber of subscribers) subscriber();
  }
}

function touch(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  entries.set(key, entry);
}

function enforceBounds(): string[] {
  const evictedKeys: string[] = [];
  let bytes = [...entries.values()].reduce((total, entry) => total + entry.bytes, 0);
  while (entries.size > MAX_ENTRIES || bytes > MAX_BYTES) {
    const oldestKey = entries.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = entries.get(oldestKey);
    entries.delete(oldestKey);
    inFlight.delete(oldestKey);
    bytes -= oldest?.bytes ?? 0;
    evictedKeys.push(oldestKey);
  }
  return evictedKeys;
}

export function setLazyDetailPostMessage(value: (message: WebviewToHostMessage) => void): void {
  post = value;
}

export function clearLazyDetailCache(): void {
  entries.clear();
  inFlight.clear();
  cacheGeneration += 1;
  notifyAll();
}

export function receiveLazyDetailResult(result: DetailResult): void {
  inFlight.delete(result.key);
  entries.delete(result.key);
  entries.set(result.key, result.status === 'loaded'
    ? { state: { status: 'loaded', value: result.value }, bytes: result.sizeBytes }
    : { state: { status: result.status, message: result.message }, bytes: 0 });
  const evictedKeys = enforceBounds();
  notifyKey(result.key);
  for (const key of evictedKeys) {
    if (key !== result.key) notifyKey(key);
  }
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
  notifyKey(ref.key);
  post?.({ type: 'requestDetail', sessionPath, ref });
}

export function useLazyDetail(
  ref: LazyDetailRef | undefined,
  expanded: boolean,
): { state: LazyDetailState; retry: () => void } {
  const [, setVersion] = useState(0);
  const wasExpanded = useRef(false);
  const previousKey = useRef<string | undefined>(undefined);
  const lastLoaded = useRef<{
    key: string;
    toolCallId?: string;
    executionId?: string;
    value: unknown;
  } | undefined>(undefined);
  const loadedGeneration = useRef(cacheGeneration);
  if (loadedGeneration.current !== cacheGeneration) {
    loadedGeneration.current = cacheGeneration;
    lastLoaded.current = undefined;
  }
  useEffect(() => {
    if (!ref) return;
    const subscriber = () => setVersion((value) => value + 1);
    const subscribers = subscribersByKey.get(ref.key) ?? new Set<() => void>();
    subscribers.add(subscriber);
    subscribersByKey.set(ref.key, subscribers);
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) subscribersByKey.delete(ref.key);
    };
  }, [ref?.key]);
  useEffect(() => {
    // Request on the expansion edge (or when detail first becomes available),
    // not on every live revision while an already-open row is streaming.
    const shouldRequest = expanded && ref
      && (!wasExpanded.current
        || previousKey.current === undefined
        // Live subagent revisions can advance faster than a large detail can
        // round-trip. Reuse the last loaded preview during those revisions,
        // then fetch the stable durable terminal detail once.
        || (previousKey.current !== ref.key && ref.source === 'durable'));
    wasExpanded.current = expanded;
    previousKey.current = ref?.key;
    if (shouldRequest) requestLazyDetail(ref.sessionPath, ref);
  }, [expanded, ref?.key]);
  const retry = useCallback(() => {
    if (ref) requestLazyDetail(ref.sessionPath, ref, true);
  }, [ref?.key]);
  let state = ref ? entries.get(ref.key)?.state ?? { status: 'idle' as const } : { status: 'idle' as const };
  if (ref && state.status === 'loaded') {
    touch(ref.key);
    lastLoaded.current = { key: ref.key, toolCallId: ref.toolCallId, executionId: ref.executionId, value: state.value };
  } else if (
    ref?.kind === 'tool-result'
    && ref.toolCallId !== undefined
    && (state.status === 'idle' || state.status === 'loading')
    && lastLoaded.current
    && lastLoaded.current.key !== ref.key
    && lastLoaded.current.toolCallId === ref.toolCallId
    && lastLoaded.current.executionId === ref.executionId
  ) {
    state = { status: 'loaded', value: lastLoaded.current.value };
  }
  return { state, retry };
}
