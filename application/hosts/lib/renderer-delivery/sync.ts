import type { HostToWebviewMessage, ViewState } from '../../../lib/protocol/index.js';
import { PIE_BUILD_ID } from '../../../../lib/build-identity.js';
import { WEBVIEW_PROTOCOL_VERSION } from '../../../lib/protocol/envelopes.js';
import { omitRedundantToolCallMirrorForTransport } from '../../../frontend/transcript/message-parts.js';
import { transcriptRenderSignature } from '../../../frontend/transcript/render-signature';
import { isStreamDiagEnabled } from './stream-telemetry';

/** Process-wide envelope identity. Delivery/dirty ownership lives exclusively
 * in StateDeliveryController. */
export type SidebarSyncState = {
  hostInstanceId: string;
  globalRevision: number;
};

export interface StateEnvelopeContext {
  revision: number;
  viewGeneration: number;
  /** Host-assigned renderer session id (browser server plan §5.1). */
  rendererId: string;
  /** Reload/reconnect fence for this renderer (browser server plan §5.1). */
  rendererGeneration: number;
}

export function createSidebarSyncState(hostInstanceId: string): SidebarSyncState {
  return { hostInstanceId, globalRevision: 0 };
}

/** Measure the final wire envelope only for opt-in stream diagnostics. */
function measureSnapshotBytes(message: Extract<HostToWebviewMessage, { type: 'state' }>): number {
  try {
    // `snapshotBytes` is itself serialized, so its own digit width feeds back
    // into the measured size. Iterate to a fixed point (bounded, so a
    // pathological oscillation can never spin) rather than assuming two passes
    // converge: a digit-width rollover (e.g. 7 -> 8 digits) needs a third pass.
    for (let pass = 0; pass < 8; pass += 1) {
      const bytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
      if (message.snapshotBytes === bytes) return bytes;
      message.snapshotBytes = bytes;
    }
    return message.snapshotBytes;
  } catch {
    // Diagnostics must not make a recoverable snapshot build fail.
    return 0;
  }
}

/**
 * Builds one authoritative full snapshot for a controller-owned operation.
 * The expected identity is bounded by transcriptRenderSignature.
 */
export function buildStateEnvelope(
  syncState: SidebarSyncState,
  viewState: ViewState,
  context: StateEnvelopeContext | boolean,
): {
  nextSyncState: SidebarSyncState;
  message: Extract<HostToWebviewMessage, { type: 'state' }>;
  expectedTranscriptIdentity: string;
} {
  // Boolean support is retained only for existing synthetic perf callers; the
  // provider always supplies controller-owned revision/generation context.
  const envelopeContext = typeof context === 'boolean'
    ? { revision: syncState.globalRevision + 1, viewGeneration: 1, rendererId: 'perf', rendererGeneration: 1 }
    : context;
  if (envelopeContext.revision <= syncState.globalRevision) {
    throw new Error('State envelope revisions must increase monotonically.');
  }

  const transportTranscript = viewState.transcript.map(omitRedundantToolCallMirrorForTransport);
  const transportViewState = transportTranscript.some((message, index) => message !== viewState.transcript[index])
    ? { ...viewState, transcript: transportTranscript }
    : viewState;
  const expectedTranscriptIdentity = transcriptRenderSignature(transportViewState);
  const message: Extract<HostToWebviewMessage, { type: 'state' }> = {
    type: 'state',
    protocolVersion: WEBVIEW_PROTOCOL_VERSION,
    buildId: PIE_BUILD_ID,
    hostInstanceId: syncState.hostInstanceId,
    rendererId: envelopeContext.rendererId,
    rendererGeneration: envelopeContext.rendererGeneration,
    viewGeneration: envelopeContext.viewGeneration,
    revision: envelopeContext.revision,
    expectedTranscriptIdentity,
    snapshotBytes: 0,
    state: transportViewState,
  };
  if (isStreamDiagEnabled()) {
    // This intentionally stays host-side: serializing a live snapshot in the
    // renderer just to report diagnostics is expensive during streaming.
    message.snapshotBytes = measureSnapshotBytes(message);
  }

  return {
    nextSyncState: { ...syncState, globalRevision: envelopeContext.revision },
    expectedTranscriptIdentity,
    message,
  };
}
