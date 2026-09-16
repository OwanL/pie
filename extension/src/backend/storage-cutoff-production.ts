import path from 'node:path';

import type { Int64Value } from '../../../shared/analytics/contracts.js';
import { SqliteAnalyticsRecorder } from '../analytics/sqlite-recorder.js';
import { forgetLegacyReviewArtifacts } from './legacy-review-artifact-cleanup.js';
import {
  SessionFilesystemMutationBarrier,
  SessionLifecycleCleaner,
  type SessionCleanupRoots,
} from './session-filesystem-lifecycle.js';
import type { SessionLifecycleStore } from './session-lifecycle-store.js';
import { writeSystemPromptTogglesForSession } from './session-settings-store.js';

export interface ProductionStorageCutoffLifecycleOptions {
  readonly store: SessionLifecycleStore;
  readonly stateDir: string;
  readonly roots: SessionCleanupRoots;
  readonly analyticsDatabasePath: string;
}

/** Build the normal lifecycle cleanup owner for the detached P7b helper.
 *
 * Storage cutoff runs only after all hosts have drained analytics writers, so
 * the helper may open the canonical database directly for the coupled private
 * delete. The recorder is lazy: an all-public inventory does not acquire an
 * unnecessary analytics handle. */
export function createProductionStorageCutoffLifecycle(
  options: ProductionStorageCutoffLifecycleOptions,
): { readonly cleaner: SessionLifecycleCleaner; close(): void } {
  let analytics: SqliteAnalyticsRecorder | undefined;
  const barrier = new SessionFilesystemMutationBarrier({
    store: options.store,
    lockRoot: path.join(options.stateDir, 'session-mutation-locks'),
  });
  const analyticsDeletion = {
    deleteSession(
      rootSessionId: string,
      deleteSourceKey: string,
      deletedAtMs: Int64Value,
      pendingOperationId?: string,
    ): void {
      analytics ??= new SqliteAnalyticsRecorder(options.analyticsDatabasePath);
      analytics.deleteSession(rootSessionId, deleteSourceKey, deletedAtMs, pendingOperationId);
    },
  };
  const cleaner = new SessionLifecycleCleaner({
    store: options.store,
    barrier,
    roots: options.roots,
    analytics: analyticsDeletion,
    cleanupExternalArtifact: async (artifact) => {
      if (artifact.artifactId === 'review-sidecar-entry') {
        forgetLegacyReviewArtifacts(artifact.location, artifact.sessionId);
        return;
      }
      if (artifact.artifactId === 'prompt-setting-entry') {
        await barrier.runAdministrativeAsync(
          '__aggregate_session_prompt_settings__',
          'session.cleanup.prompt-setting-entry',
          () => writeSystemPromptTogglesForSession(artifact.location, [], true),
        );
        return;
      }
      throw new Error(`Unsupported external lifecycle artifact: ${artifact.artifactId}`);
    },
  });
  return {
    cleaner,
    close: () => analytics?.close(),
  };
}
