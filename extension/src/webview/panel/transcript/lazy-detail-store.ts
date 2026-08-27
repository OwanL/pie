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
// A single detail can approach the JSONL record ceiling. Do not allow several
// deliberate expansions to make those responses queue behind one another in
// the backend process: dispatch the next request only after the prior result
// has crossed the host/webview boundary.
const MAX_CONCURRENT_REQUESTS = 1;
/** Keep this just beyond the host's ordinary 30 s RPC deadline. A request the
 * host accepted should normally settle first; a frame rejected after the
 * browser transport accepted it still releases the sole detail lane instead
 * of leaving every later expansion queued forever. */
export const LAZY_DETAIL_REQUEST_TIMEOUT_MS = 35_000;
const entries = new Map<string, { state: LazyDetailState; bytes: number }>();
const inFlight = new Set<string>();
const activeRequests = new Set<string>();
const requestTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const pendingRequests: Array<{ sessionPath: string; ref: LazyDetailRef }> = [];
const subscribersByKey = new Map<string, Set<() => void>>();
let cacheGeneration = 0;
let post: ((message: WebviewToHostMessage) => unknown) | undefined;

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
    // Loading entries represent explicit user intent and are not cache
    // candidates. Evict the oldest settled entry instead.
    const oldestKey = [...entries].find(([, entry]) => entry.state.status !== 'loading')?.[0];
    if (!oldestKey) break;
    const oldest = entries.get(oldestKey);
    entries.delete(oldestKey);
    inFlight.delete(oldestKey);
    bytes -= oldest?.bytes ?? 0;
    evictedKeys.push(oldestKey);
  }
  return evictedKeys;
}

function clearRequestTimeout(key: string): void {
  const timer = requestTimeouts.get(key);
  if (timer === undefined) return;
  clearTimeout(timer);
  requestTimeouts.delete(key);
}

function clearRequestTimeouts(): void {
  for (const timer of requestTimeouts.values()) clearTimeout(timer);
  requestTimeouts.clear();
}

function armRequestTimeout(key: string): void {
  clearRequestTimeout(key);
  const timer = setTimeout(() => {
    requestTimeouts.delete(key);
    if (!activeRequests.delete(key)) return;
    inFlight.delete(key);
    const entry = entries.get(key);
    if (entry?.state.status === 'loading') {
      entries.delete(key);
      entries.set(key, {
        state: {
          status: 'failure',
          message: 'Detail loading timed out. Retry to try again.',
        },
        bytes: 0,
      });
      notifyKey(key);
    }
    // The timed-out request no longer owns the serialized lane. Dispatch the
    // next explicit expansion immediately instead of waiting for another UI
    // action to wake the queue.
    pumpRequests();
  }, LAZY_DETAIL_REQUEST_TIMEOUT_MS);
  // Node-based component tests should not be kept alive solely by a webview
  // recovery timer. Browser timer handles are numbers and simply skip this.
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  requestTimeouts.set(key, timer);
}

function pumpRequests(): void {
  if (!post) return;
  while (activeRequests.size < MAX_CONCURRENT_REQUESTS) {
    const next = pendingRequests.shift();
    if (!next) return;
    if (!inFlight.has(next.ref.key)) continue;
    activeRequests.add(next.ref.key);
    let accepted: unknown = false;
    try {
      accepted = post({ type: 'requestDetail', sessionPath: next.sessionPath, ref: next.ref });
    } catch {
      // Treat a synchronous transport failure like an explicit rejection: the
      // request stays queued and does not consume the active lane.
      accepted = false;
    }
    if (accepted === false) {
      // The browser can lose its renderer route between expansion and send.
      // Keep the explicit request queued, but do not occupy the single active
      // slot forever. `setLazyDetailPostMessage` pumps it again when the
      // transport connection changes.
      activeRequests.delete(next.ref.key);
      pendingRequests.unshift(next);
      return;
    }
    // A test seam or local transport may settle synchronously from inside
    // post(). Do not arm a stale timer after receiveLazyDetailResult removed
    // this key from the active set.
    if (activeRequests.has(next.ref.key)) armRequestTimeout(next.ref.key);
  }
}

export function setLazyDetailPostMessage(value: (message: WebviewToHostMessage) => unknown): void {
  post = value;
  pumpRequests();
}

export function clearLazyDetailCache(): void {
  clearRequestTimeouts();
  entries.clear();
  inFlight.clear();
  activeRequests.clear();
  pendingRequests.length = 0;
  cacheGeneration += 1;
  notifyAll();
}

export function receiveLazyDetailResult(result: DetailResult): void {
  clearRequestTimeout(result.key);
  inFlight.delete(result.key);
  activeRequests.delete(result.key);
  entries.delete(result.key);
  entries.set(result.key, result.status === 'loaded'
    ? { state: { status: 'loaded', value: result.value }, bytes: result.sizeBytes }
    : { state: { status: result.status, message: result.message }, bytes: 0 });
  const evictedKeys = enforceBounds();
  notifyKey(result.key);
  for (const key of evictedKeys) {
    if (key !== result.key) notifyKey(key);
  }
  pumpRequests();
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
  pendingRequests.push({ sessionPath, ref });
  pumpRequests();
}

export function useLazyDetail(
  ref: LazyDetailRef | undefined,
  expanded: boolean,
): { state: LazyDetailState; load: () => void; retry: () => void } {
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
  const load = useCallback(() => {
    if (ref) requestLazyDetail(ref.sessionPath, ref);
  }, [ref?.key]);
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
  return { state, load, retry };
}
