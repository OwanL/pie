/**
 * Parameter schema + shared types for the `session_review` tool.
 *
 * Types are defined locally (not imported from pie's protocol barrel) so the
 * extension stays decoupled from the host build — they mirror the JSON shapes
 * the host/backend push and the tool persists.
 */

export type ReviewAction = 'listOpen' | 'getTranscript' | 'setReview' | 'closeSelf';
export type Completion = 'fully' | 'partial' | 'setback';

/** A currently-open session summary pushed by the host via `PIE_OPEN_TABS`. */
export interface OpenTabSummary {
  path: string;
  name: string;
  cwd?: string;
  modifiedAt?: string;
  messageCount?: number;
  modelId?: string;
  thinkingLevel?: string;
  done?: boolean;
  rating?: number;
  completion?: Completion;
  reviewReason?: string;
  evaluatedAt?: string;
  /** True when this tab is pinned (browser-style pinned tab). Lets the
   *  listOpen output show which tabs are pinned so reviewers can skip them. */
  pinned?: boolean;
  /** True when this session is currently running (streaming a turn). Lets the
   *  listOpen output show which sessions are in-flight so the reviewer skips
   *  them (their transcript is incomplete). */
  isRunning?: boolean;
}

/** A review record the tool appends to the sidecar (`reviews.jsonl`). */
export interface ReviewRecord {
  sessionPath: string;
  done: boolean;
  rating: number;
  completion: Completion;
  reason: string;
  evaluatedAt: string;
  /** Sub-agent buckets whose judgments fed the rating (e.g. ['medium','small']).
   *  Optional for backward compat; older records have no field. */
  reviewerBuckets?: string[];
  /** Number of sub-agent reviewers that fed the rating. Optional for backward compat. */
  reviewerCount?: number;
  /** True when this review is a self-close marker written by the `closeSelf`
   *  action (the reviewer session closing its own tab once its work is done).
   *  Such records still drive tab auto-close (they carry `done: true`) but the
   *  host skips recording them as scored agent-review analytics, since a
   *  session rating itself is not an objective performance signal. */
  selfClose?: boolean;
}

export interface SessionReviewParams {
  action: ReviewAction;
  /** `getTranscript` / `setReview`: absolute path of the session JSONL file
   *  (as returned by `listOpen`). */
  sessionPath?: string;
  /** `setReview`: mark the session's task done. */
  done?: boolean;
  /** `setReview`: 1–5 quality rating. */
  rating?: number;
  /** `setReview`: task-completion classification. */
  completion?: Completion;
  /** `setReview`: free-text reason for the rating/completion. */
  reason?: string;
  /** `setReview`: sub-agent buckets whose judgments fed the rating (e.g.
   *  ['medium','small']) — records the multi-reviewer provenance so the host
   *  analytics can distinguish multi-reviewer agent reviews from single-shot ones. */
  reviewerBuckets?: string[];
  /** `setReview`: number of sub-agent reviewers that fed the rating. */
  reviewerCount?: number;
  /** `getTranscript`: cap on the number of most-recent turns returned (default 40). */
  maxTurns?: number;
}

export const sessionReviewSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['listOpen', 'getTranscript', 'setReview', 'closeSelf'],
      description:
        'listOpen: list currently-open sessions with their review status. ' +
        'getTranscript: read a session\'s inputs/outputs from its JSONL file. ' +
        'setReview: record a done/rating/completion/reason review for a session. ' +
        'closeSelf: close THIS (the reviewer) session once its review work is complete.',
    },
    sessionPath: {
      type: 'string',
      description: 'Absolute path of the session JSONL file (from listOpen). Required for getTranscript and setReview.',
    },
    done: { type: 'boolean', description: 'setReview: mark the session\'s task done.' },
    rating: { type: 'integer', minimum: 1, maximum: 5, description: 'setReview: 1–5 quality rating.' },
    completion: {
      type: 'string',
      enum: ['fully', 'partial', 'setback'],
      description: 'setReview: fully = task completed; partial = work done but unresolved; setback = left things worse (regression/failed approach).',
    },
    reason: { type: 'string', description: 'setReview: free-text reason for the rating/completion.' },
    reviewerBuckets: {
      type: 'array',
      items: { type: 'string' },
      description: 'setReview: sub-agent buckets whose judgments fed the rating (e.g. ["medium","small"]) — records the multi-reviewer provenance for analytics.',
    },
    reviewerCount: { type: 'integer', minimum: 0, description: 'setReview: number of sub-agent reviewers that fed the rating.' },
    maxTurns: { type: 'integer', minimum: 1, maximum: 200, description: 'getTranscript: cap on most-recent turns returned (default 40).' },
  },
  required: ['action'],
  additionalProperties: false,
} as const;