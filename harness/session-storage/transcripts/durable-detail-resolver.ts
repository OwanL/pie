import type { ChatMessage, DetailResult, LazyDetailRef } from '../../agent-processes/lib/rpc/message-contract.js';
import { LIVE_PIPELINE_LIMITS } from '../../agent-processes/lib/rpc/live-pipeline.js';
import { findDurableDetail } from './lazy-details';
import { findToolModelExchange, type CapturedModelExchangeEntry } from './tool-model-exchange';

/** Resolve only durable evidence; ownership and fingerprint fences remain caller-owned. */
export function resolveDurableLazyDetail(
  sessionPath: string,
  transcript: readonly ChatMessage[],
  entries: readonly CapturedModelExchangeEntry[],
  ref: LazyDetailRef,
): DetailResult {
  const base = { sessionPath, key: ref.key };
  if (ref.source !== 'durable') {
    return { ...base, status: 'unavailable', message: 'Live detail is owned by the execution runtime.' };
  }
  const found = ref.kind === 'model-exchange'
    ? findToolModelExchange(transcript, entries, ref)
    : findDurableDetail(transcript, ref);
  if (found.status === 'unavailable') {
    return { ...base, status: 'unavailable', message: 'message' in found && typeof found.message === 'string'
      ? found.message : 'The durable detail is no longer available.' };
  }
  if (found.sizeBytes > LIVE_PIPELINE_LIMITS.previewBytes) {
    return { ...base, status: 'unavailable', message: 'The detail exceeds the supported retrieval size.' };
  }
  if (found.sizeBytes !== ref.sizeBytes && !(ref.kind === 'model-exchange' && ref.sizeBytes === 0)) {
    return { ...base, status: 'stale', message: 'The durable detail changed; refresh the session and retry.' };
  }
  return { ...base, status: 'loaded', value: found.value, sizeBytes: found.sizeBytes };
}
