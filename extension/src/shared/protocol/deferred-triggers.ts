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
 * `TriggerKind` / `TriggerSpec` are defined here (not in the host store) so
 * both the host store and the protocol share one source of truth.
 */

export type TriggerKind = 'session_finished' | 'timer' | 'user_input';

export interface TriggerSpec {
  kind: TriggerKind;
  /** `session_finished`: specific watched session path; undefined = any open session. */
  sessionPath?: string;
  /** `timer`: delay in milliseconds. */
  ms?: number;
}

/**
 * A currently-active (registered, not yet fired/cancelled) deferred trigger,
 * projected to the webview. The webview resolves the watcher session's display
 * name from `ViewState.sessions` by `sessionPath`, so the name is not carried
 * here (keeps the projection lean and avoids a second source of truth for names).
 */
export interface DeferredTriggerView {
  id: string;
  /** The watcher's session path (the session that will be resumed on fire). */
  sessionPath: string;
  /** Trigger specs (OR semantics: the first to fire wins and consumes the trigger). */
  triggers: TriggerSpec[];
  /** Task reminder replayed in the wake-up message when the trigger fires. */
  note: string;
  /** ISO timestamp of registration (used to render elapsed "waiting" time). */
  registeredAt: string;
}
