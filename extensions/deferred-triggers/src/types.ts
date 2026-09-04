/**
 * Parameter schema + shared types for the `defer_trigger` tool.
 *
 * Types are defined locally (not imported from pie's host code) so the
 * extension stays decoupled from the host build — they mirror the JSON shapes
 * the host's `deferred-triggers/store.ts` reads/writes.
 */

export type DeferAction = 'register' | 'cancel' | 'list';
export type TriggerKind = 'session_finished' | 'timer' | 'user_input';

/** A single trigger spec (OR semantics across the array: first to fire wins). */
export interface TriggerSpec {
  kind: TriggerKind;
  /** `session_finished`: specific watched session path; omit for any open session. */
  sessionPath?: string;
  /** `timer`: delay in milliseconds. */
  ms?: number;
}

export interface DeferTriggerParams {
  action: DeferAction;
  /** `register`: one or more trigger specs (OR semantics). */
  triggers?: TriggerSpec[];
  /** `register`: task reminder replayed when the trigger fires. */
  note?: string;
  /** `cancel`: specific trigger id (from `register`); omit to cancel all for this session. */
  triggerId?: string;
}

/** The op-log shapes written to `triggers.jsonl` (must match the host store). */
export interface TriggerOp {
  id?: string;
  op: 'register' | 'cancel' | 'claim' | 'dispatch-started' | 'release' | 'failed' | 'fire';
  sessionPath: string;
  triggers?: TriggerSpec[];
  note?: string;
  at?: string;
  targetId?: string;
  reason?: string;
  wakeReason?: string;
  claimId?: string;
  ownerId?: string;
  ownerPid?: number;
  dispatchStartedAt?: string;
  recoveryState?: 'dead-owner-recovered';
}

export interface ActiveTrigger {
  id: string;
  sessionPath: string;
  triggers: TriggerSpec[];
  note: string;
  registeredAt: string;
  deliveryState: 'pending' | 'claimed' | 'retryable';
  recoveryState?: 'dead-owner-recovered' | 'acknowledgement-ambiguous';
  deliveryDetail?: string;
  claimId?: string;
  claimOwnerId?: string;
  claimOwnerPid?: number;
  claimAt?: string;
  dispatchStartedAt?: string;
  wakeReason?: string;
}

export const deferTriggerSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['register', 'cancel', 'list'],
      description:
        'register: register a deferred trigger that resumes this session when a condition fires. ' +
        'cancel: cancel a pending trigger (one id, or all for this session). ' +
        'list: show this session\'s currently-pending triggers.',
    },
    triggers: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['session_finished', 'timer', 'user_input'],
            description:
              'session_finished: fire when a session finishes streaming (a specific path, or any open session). ' +
              'timer: fire after `ms` milliseconds. ' +
              'user_input: fire when the user sends a message in this session.',
          },
          sessionPath: {
            type: 'string',
            description: 'session_finished: specific watched session path; omit for any open session. Never fires on this session\'s own completion.',
          },
          ms: { type: 'integer', minimum: 1, description: 'timer: delay in milliseconds.' },
        },
        required: ['kind'],
        additionalProperties: false,
      },
      description: 'register: one or more trigger specs (OR semantics — the first to fire wins and consumes the whole trigger).',
    },
    note: { type: 'string', description: 'register: task reminder replayed in the wake-up message when the trigger fires.' },
    triggerId: { type: 'string', description: 'cancel: a specific trigger id (from `register`); omit to cancel all pending triggers for this session.' },
  },
  required: ['action'],
  additionalProperties: false,
} as const;
