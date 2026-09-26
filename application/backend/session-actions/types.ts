import type { SessionCompletionEvent } from '../composition/completion-attention.js';
import type { HostToWebviewMessage } from '../../lib/protocol/index.js';

export type ScheduleRender = () => void;
export type PostImperative = (message: HostToWebviewMessage) => void;
export type OnSessionCompleted = (event: SessionCompletionEvent) => void;

export type SelectionRequest = {
  token: string;
  requestedPath: string;
  pendingPath?: string;
  insertedPlaceholder: boolean;
  previousActivePath: string | null;
  wasOpenTab: boolean;
  requestEpoch?: number;
  /** Backend/model ownership captured before the lifecycle request starts. */
  backendGeneration: number;
  modelWriteFence: number;
  modelHydrationRevision: number;
  catalogHydrationRevision: number;
  /** Exact request-start fences for overlapping create retry attempts. */
  modelFencesByOperationAttempt?: Record<number, {
    backendGeneration: number;
    modelWriteFence: number;
    modelHydrationRevision: number;
    catalogHydrationRevision: number;
  }>;
  /** Stable create/duplicate identity retained after a local timeout. */
  operationId?: string;
  /** Attempt fence for a retried operation sharing the same token. */
  operationAttempt?: number;
};
