/**
 * Parameter schema and durable sidecar types for the `defer_trigger` tool.
 *
 * Normalized trigger specs come from the shared wake-condition contract so the
 * tool and host use the same periodic-predicate defaults and bounds. The host
 * registry reads the remaining JSON shapes from this file's mirrored types.
 */

import type {
  TriggerKind,
  TriggerSpec,
  TriggerSpecInput,
} from '../../../shared/wake-conditions.js';

export type { TriggerKind, TriggerSpec, TriggerSpecInput };

export type DeferAction = 'register' | 'cancel' | 'list';

export interface DeferTriggerParams {
  action: DeferAction;
  /** `register`: one or more trigger specs (OR semantics). */
  triggers?: TriggerSpecInput[];
  /** `register`: required task message replayed when the trigger fires. */
  message?: string;
  /** `register`: persisted target session path; omitted means the caller. */
  targetSession?: string;
  /** `cancel`: specific trigger id (from `register`); omit to cancel all owned triggers. */
  triggerId?: string;
}

/** The op-log shapes written to `triggers.jsonl` (must match the host store). */
export interface TriggerOp {
  id?: string;
  op: 'register' | 'cancel' | 'claim' | 'dispatch-started' | 'release' | 'failed' | 'fire';
  /** Creator/owner session path. Legacy records also used this as the target. */
  sessionPath: string;
  /** Delivery target for a new registration; omitted in legacy records. */
  targetSession?: string;
  triggers?: TriggerSpec[];
  /** New registrations use message; note is retained for legacy records. */
  message?: string;
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
  /** Creator/owner session path used for list and cancel authorization. */
  sessionPath: string;
  /** Session that receives the wake; legacy records default this to sessionPath. */
  targetSession: string;
  triggers: TriggerSpec[];
  /** Normalized message; legacy note records are surfaced here too. */
  message: string;
  /** Compatibility alias for callers/renderers that still display legacy notes. */
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

const triggerSpecSchema = {
  type: 'object',
  oneOf: [
    {
      properties: {
        kind: { const: 'session_finished' },
        sessionPath: {
          type: 'string',
          description: 'Specific watched session path; omit for any open session.',
        },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    {
      properties: {
        kind: { const: 'timer' },
        ms: { type: 'integer', minimum: 1, description: 'Delay in milliseconds.' },
      },
      required: ['kind', 'ms'],
      additionalProperties: false,
    },
    {
      properties: {
        kind: { const: 'user_input' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    {
      properties: {
        kind: { const: 'command' },
        command: {
          type: 'string',
          minLength: 1,
          description: 'Shell command that exits 0 when satisfied and 1 when not yet satisfied; other exits are evaluation errors.',
        },
        cwd: {
          type: 'string',
          minLength: 1,
          description: 'Working directory; resolved relative to the registration cwd.',
        },
        intervalMs: {
          type: 'integer',
          minimum: 1_000,
          description: 'Poll interval in milliseconds (default 30000).',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: 300_000,
          description: 'Per-poll timeout in milliseconds (default 10000).',
        },
      },
      required: ['kind', 'command'],
      additionalProperties: false,
    },
  ],
} as const;

export const deferTriggerSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['register', 'cancel', 'list'],
      description:
        'register: persist a wake condition without ending this turn. ' +
        'cancel: cancel one wake by id, or all wakes owned by this session. ' +
        'list: show this session\'s active wakes.',
    },
    triggers: {
      type: 'array',
      minItems: 1,
      items: triggerSpecSchema,
      description: 'register: one or more ORed conditions; the first satisfied condition consumes the wake.',
    },
    message: {
      type: 'string',
      minLength: 1,
      description: 'register: required task message replayed in the wake-up message.',
    },
    targetSession: {
      type: 'string',
      minLength: 1,
      description: 'register: target session path; omit to target the calling session. The target must be open for delivery.',
    },
    triggerId: {
      type: 'string',
      minLength: 1,
      description: 'cancel: a specific wake id owned by this session; omit to cancel all wakes owned by this session.',
    },
  },
  required: ['action'],
  allOf: [{
    if: { properties: { action: { const: 'register' } } },
    then: { required: ['triggers', 'message'] },
  }],
  additionalProperties: false,
} as const;
