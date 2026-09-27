import type { HostToWebviewMessage } from '../../lib/protocol/index.js';
import { isBoundedImagePreviewData } from '../../lib/protocol/image-preview.js';

export type ImagePreviewResult = Extract<HostToWebviewMessage, { type: 'imagePreviewResult' }>;

const pending = new Map<string, {
  sessionPath: string;
  receive: (result: ImagePreviewResult | undefined) => void;
}>();

/** Register one ephemeral renderer-local request owner. Disposing it makes all
 * later host results stale without retaining image bytes or ViewState data. */
export function registerImagePreviewRequest(
  requestId: string,
  sessionPath: string,
  receive: (result: ImagePreviewResult | undefined) => void,
): () => void {
  pending.set(requestId, { sessionPath, receive });
  return () => {
    pending.delete(requestId);
  };
}

export function receiveImagePreviewResult(result: ImagePreviewResult): void {
  const owner = pending.get(result.requestId);
  if (!owner) return;
  pending.delete(result.requestId);
  if (owner.sessionPath !== result.sessionPath) {
    owner.receive(undefined);
    return;
  }
  if (result.status === 'ready') {
    const data = result.data;
    if (!isBoundedImagePreviewData(data)) {
      owner.receive({ ...result, status: 'unavailable', data: undefined });
      return;
    }
  }
  owner.receive(result);
}

/** Drop pending subscriptions at a renderer disconnect/host replacement. */
export function clearImagePreviewRequests(): void {
  const owners = [...pending.values()];
  pending.clear();
  for (const owner of owners) owner.receive(undefined);
}
