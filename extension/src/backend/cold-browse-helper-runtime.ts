import { deduplicateToolCallResultsForTransport } from '../shared/chat-message-parts';
import { findDurableDetail } from '../shared/lazy-details';
import { LIVE_PIPELINE_LIMITS } from '../shared/live-pipeline-protocol';
import type { DetailResult, SessionOpenedPayload, TranscriptPagePayload } from '../shared/protocol';
import { ColdBrowseProjectionCache } from './cold-browse-projection-cache';
import {
  coldBrowseSourceBytes,
  readColdBrowseFingerprintSync,
  type ColdBrowseHelperFence,
  type ColdBrowseHelperOperation,
} from './cold-browse-helper-protocol';
import { buildBrowseSessionOpenedPayload, openSessionBrowseSnapshot, type SessionBrowseSnapshot } from './session-browser';
import { normalizeDanglingTranscript } from './session-opened';
import { buildPagedTranscriptWindow } from './transcript-window';
import { boundTranscriptSnapshot } from '../shared/transcript-window';
import type { SdkModule } from './sdk';

interface LoadedProjection {
  readonly browse: SessionBrowseSnapshot;
  readonly fingerprint: string;
}

export interface ColdBrowseHelperRuntimeOptions {
  readonly sdk: Pick<SdkModule, 'SessionManager'>;
  readonly startupCwd: string;
  readonly maxSourceBytes?: number;
  readonly maxEntries?: number;
  /** Test-only override; production uses the shared 30 MiB producer budget. */
  readonly maxResponseLineBytes?: number;
}

/**
 * Read-only, manager-free durable projection authority for one helper process.
 * SessionManager is used only while filling the cache; no manager is retained.
 */
export class ColdBrowseHelperRuntime {
  private readonly cache: ColdBrowseProjectionCache<SessionBrowseSnapshot>;
  private readonly loads = new Map<string, Promise<LoadedProjection>>();

  constructor(private readonly options: ColdBrowseHelperRuntimeOptions) {
    this.cache = new ColdBrowseProjectionCache(options.maxSourceBytes, options.maxEntries);
  }

  async execute(payload: ColdBrowseHelperOperation): Promise<{
    result: SessionOpenedPayload | TranscriptPagePayload | DetailResult | { invalidated: true };
    fingerprint?: string;
  }> {
    if (payload.operation === 'invalidate') {
      this.cache.invalidatePath(payload.sessionPathKey);
      return { result: { invalidated: true } };
    }

    const loaded = await this.getProjection(payload.fence);
    this.assertFingerprint(payload.fence);
    if (payload.operation === 'open') {
      return this.finishResponse(payload.fence, loaded.fingerprint, () => (
        buildBrowseSessionOpenedPayload({
          browse: loaded.browse,
          modelSettings: payload.options.modelSettings,
          availableModels: payload.options.availableModels,
          selectionToken: payload.options.selectionToken,
          operationId: payload.options.operationId,
          operationAttempt: payload.options.operationAttempt,
          transcript: payload.options.transcript,
          transport: payload.options.transport,
          systemPromptDisabledEntries: payload.options.systemPromptDisabledEntries,
        })
      ));
    }

    if (payload.operation === 'page') {
      return this.finishResponse(payload.fence, loaded.fingerprint, () => {
        const page = buildPagedTranscriptWindow(loaded.browse.cache, {
          direction: payload.direction,
          loadedStart: payload.loadedStart,
          loadedEnd: payload.loadedEnd,
        });
        const result: TranscriptPagePayload = {
          sessionPath: payload.fence.sessionPath,
          transcript: normalizeDanglingTranscript(page.transcript)
            .map(deduplicateToolCallResultsForTransport),
          transcriptWindow: page.transcriptWindow,
          busy: false,
        };
        // Fit the exact eventual backend response while the full projection is
        // still helper-owned. This keeps an oversized page from crossing IPC
        // and triggering a synchronous coordinator reopen.
        return boundTranscriptSnapshot(result, {
          transport: payload.options.transport,
          requestedEdge: payload.direction === 'older' ? 'older' : 'newer',
          requiredMessageId: payload.options.requiredMessageId,
          maxLineBytes: this.options.maxResponseLineBytes,
        });
      });
    }

    let result: DetailResult;
    if (payload.ref.source !== 'durable') {
      result = {
        sessionPath: payload.fence.sessionPath,
        key: payload.ref.key,
        status: 'unavailable',
        message: 'Live detail is owned by the execution runtime.',
      };
    } else {
      const found = findDurableDetail(loaded.browse.cache.transcript, payload.ref);
      if (found.status === 'unavailable') {
        result = {
          sessionPath: payload.fence.sessionPath,
          key: payload.ref.key,
          status: 'unavailable',
          message: 'The durable detail is no longer available.',
        };
      } else if (found.sizeBytes > LIVE_PIPELINE_LIMITS.previewBytes) {
        result = {
          sessionPath: payload.fence.sessionPath,
          key: payload.ref.key,
          status: 'unavailable',
          message: 'The detail exceeds the supported retrieval size.',
        };
      } else if (found.sizeBytes !== payload.ref.sizeBytes) {
        result = {
          sessionPath: payload.fence.sessionPath,
          key: payload.ref.key,
          status: 'stale',
          message: 'The durable detail changed; refresh the session and retry.',
        };
      } else {
        result = {
          sessionPath: payload.fence.sessionPath,
          key: payload.ref.key,
          status: 'loaded',
          value: found.value,
          sizeBytes: found.sizeBytes,
        };
      }
    }
    return this.finishResponse(payload.fence, loaded.fingerprint, () => result);
  }

  dispose(): void {
    this.loads.clear();
    this.cache.clear();
  }

  private async getProjection(fence: ColdBrowseHelperFence): Promise<LoadedProjection> {
    this.assertFingerprint(fence);
    const key = cacheKey(fence);
    this.cache.invalidatePath(fence.sessionPathKey, key);
    const cached = this.cache.get(key);
    if (cached) {
      this.assertFingerprint(fence);
      return { browse: cached, fingerprint: fence.fingerprint };
    }

    const existing = this.loads.get(key);
    if (existing) return await existing;
    this.cache.recordMiss();
    const loading = Promise.resolve().then(async () => {
      this.assertFingerprint(fence);
      const manager = this.options.sdk.SessionManager.open(fence.sessionPath);
      this.assertFingerprint(fence);
      const browse = await openSessionBrowseSnapshot({
        manager,
        sessionPath: fence.sessionPath,
        startupCwd: this.options.startupCwd,
      });
      this.assertFingerprint(fence);
      this.cache.invalidatePath(fence.sessionPathKey, key);
      this.cache.set({
        key,
        sessionPathKey: fence.sessionPathKey,
        value: browse,
        sourceBytes: coldBrowseSourceBytes(fence.fingerprint)
          ?? Buffer.byteLength(JSON.stringify(browse), 'utf8'),
      });
      return { browse, fingerprint: fence.fingerprint };
    });
    this.loads.set(key, loading);
    try {
      return await loading;
    } finally {
      if (this.loads.get(key) === loading) this.loads.delete(key);
    }
  }

  private assertFingerprint(fence: ColdBrowseHelperFence): void {
    if (readColdBrowseFingerprintSync(fence.sessionPath) !== fence.fingerprint) {
      throw new Error(`COLD_BROWSE_FINGERPRINT_CHANGED: ${fence.sessionPath}`);
    }
  }

  private finishResponse<T>(
    fence: ColdBrowseHelperFence,
    fingerprint: string,
    build: () => T,
  ): { result: T; fingerprint: string } {
    let result: T;
    try {
      result = build();
    } catch (error) {
      // A typed producer error is authoritative only for the exact durable
      // image that produced it. Prefer a fingerprint-change retry otherwise.
      this.assertFingerprint(fence);
      throw error;
    }
    this.assertFingerprint(fence);
    return { fingerprint, result };
  }
}

function cacheKey(fence: ColdBrowseHelperFence): string {
  return JSON.stringify([
    fence.sessionPathKey,
    fence.coordinatorGeneration,
    fence.ownershipRevision,
    fence.fingerprint,
  ]);
}
