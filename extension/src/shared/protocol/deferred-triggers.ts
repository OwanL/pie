/**
 * Deferred-trigger view types shared between the host and the webview.
 *
 * The host-side `DeferredTriggerRegistry` (extension host process) owns the
 * live active-trigger set, replayed from the `triggers.jsonl` sidecar. The
 * backend `defer_trigger` tool (backend process) appends `register` / `cancel`
 * ops to that sidecar; the host registry watches the file and re-arms. These
 * types are the serializable projection of an active trigger that the host
 * merges into `ViewState.deferredTriggers` (see `PieExtension.buildViewState`)
 * so the webview can render the waiting triggers in the bottom status strip.
 *
 * `TriggerKind` / `TriggerSpec` come from the shared wake-condition contract
 * (not from the host store) so the tool, host, and renderer share one source
 * of truth, including normalized periodic predicates.
 */

import type {
  CommandTrigger,
  TriggerKind,
  TriggerSpec,
} from '../../../../shared/wake-conditions';

export type { CommandTrigger, TriggerKind, TriggerSpec };

/**
 * A currently-active (registered, not yet fired/cancelled) deferred trigger,
 * projected to the webview. `sessionPath` is the creator/owner used for list
 * and cancel authorization. `targetSession` is the delivery target; legacy
 * records omit it and are projected with the creator as their target.
 */
export interface DeferredTriggerView {
  id: string;
  /** Creator session path; targeted cancellation is authorized against this path. */
  sessionPath: string;
  /** Delivery target path. Optional only for old test/renderer fixtures; host
   * projections always populate it and fall back to sessionPath when reading. */
  targetSession?: string;
  /** Trigger specs (OR semantics: the first to fire wins and consumes the trigger). */
  triggers: TriggerSpec[];
  /** New registration message, or the normalized value of a legacy note. */
  message?: string;
  /** Compatibility projection for legacy note records and existing renderers. */
  note: string;
  /** ISO timestamp of registration (used to render elapsed "waiting" time). */
  registeredAt: string;
  /** Durable delivery state. Claimed triggers remain visible but cannot be
   * dispatched by another host; retryable triggers were not consumed. */
  deliveryState: 'pending' | 'claimed' | 'retryable';
  /** Distinguishes a safely recovered pre-dispatch owner crash from an
   * acknowledgement-ambiguous claim that must remain fail-closed. */
  recoveryState?: 'dead-owner-recovered' | 'acknowledgement-ambiguous';
  /** Human-readable delivery explanation or bounded unsatisfied-condition
   * diagnostic for a pending periodic predicate. */
  deliveryDetail?: string;
}
