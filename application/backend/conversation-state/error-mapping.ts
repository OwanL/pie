/**
 * User-facing error mapper.
 *
 * Maps internal RPC/backend error strings to **plain-language** notice
 * messages + a failure `kind` that the webview uses to render recovery action
 * buttons. This module is **pure** (string-in → `{ message, kind }` out, no
 * I/O, no `Date.now`, no randomness) so it can be called from the reducer
 * without violating `STATE_CONTRACT.md` § Reducer Purity.
 *
 * Hard contract: **no internal `req-NN` id ever reaches the user.** Every
 * error string produced by `RequestTracker` / `BackendClient`
 * carries a `req-NN` correlation id; this mapper strips it and names the
 * problem in plain language. The raw error is still logged host-side (via the
 * `Log` effect / `console.warn` in `handleLine`) so diagnostics are not lost.
 *
 * The classification is a contract with the error producers, which emit these
 * known error strings:
 *  - `RequestTracker` timeout: `"Timed out waiting for response to req-NN"`.
 *  - `RequestTracker` cancel:  `"Request req-NN was cancelled."` (or with a
 *    reason) — produced by `cancelledError` / the abort path (an interrupt
 *    cancels an in-flight send).
 *  - `BackendClient` dropped line: `"Backend sent an unparseable response for
 *    req-NN: <reason> :: <snippet> (stderr tail: …)"`.
 *  - `BackendClient` exit rejection: `"Backend exited unexpectedly with code
 *    N."` / `"Backend stopped."` / `"Backend is not running"`.
 *  - `EffectRunner` send-timer fire (`PreflightFailed`): `"Timed out waiting
 *    for the turn to start streaming (Ns)"` (prepass still running → genuine pruning
 *    timeout). There is no host-side model-start watchdog: after preflight
 *    success an accepted send is owned by the exact backend lifecycle, so the
 *    only remaining model-start-domain notice is provider concurrency
 *    saturation below.
 *
 * Recovery ACTIONS are renderer-side: the host surfaces the failure `kind`;
 * application/frontend/notifications/error-presentation.ts maps `kind` to
 * action buttons and labels. Keep that presentation mapping in sync with the
 * notice projection contract.
 */

import type { NoticeKind } from '../../lib/protocol/webview.js';

/** A mapped notice: a plain-language message (no `req-NN`) + a failure kind. */
export interface MappedNotice {
  message: string;
  kind: NoticeKind;
}

/** Which optimistic op the error is for — send ops get recovery buttons, edit
 *  ops get a prose action (re-editing is a separate affordance). */
export type OpKind = 'send' | 'edit';

// ─── Internal classification patterns (contract with the error producers) ────────────────

/** `req-NN` correlation id, anywhere in a string. Used to STRIP ids so none
 *  leaks to the user. */
const REQ_ID_PATTERN = /req-\d+/g;

/** `RequestTracker` pre-ack timeout: `"Timed out waiting for response to req-NN"`. */
const REQUEST_TIMEOUT_PATTERN = /^Timed out waiting for response to req-\d+$/;

/** `RequestTracker` user-initiated cancel: `"Request req-NN was cancelled."` (+ optional reason). */
const CANCELLED_PATTERN = /^Request req-\d+ was cancelled/;

/** `BackendClient` dropped line: `"Backend sent an unparseable response for req-NN: …"`. */
const DROPPED_LINE_PATTERN = /^Backend sent an unparseable response for req-\d+:/;

/** `BackendClient` exit rejection: `"Backend exited unexpectedly with code N."`,
 *  `"Backend stopped."`, `"Backend is not running"`, `"Backend client disposed."`. */
const BACKEND_EXIT_PATTERN = /^Backend (exited unexpectedly|stopped|is not running|client disposed)/;

/** `EffectRunner` send-timer fire while the prepass was still running
 *  (`PreflightFailed`): `"Timed out waiting for the turn to start streaming
 *  (Ns)"`. The budget is a whole-or-decimal second count (e.g. `120s` or
 *  `12.5s`) — the send-timer budget derives from `prepassTimeoutSec` +
 *  first-token headroom and may be fractional, so the capture group accepts an
 *  optional decimal. Without it a decimal budget (e.g. `12.5s`) would fail to
 *  match and the error would misclassify as a generic `prepass-failed`. This
 *  is a GENUINE pruning/prepass timeout (pruning had not yet
 *  completed when the budget elapsed). */
const PREPASS_TIMEOUT_PATTERN = /^Timed out waiting for the turn to start streaming \((\d+(?:\.\d+)?)s\)$/;

/** Host-side `ProviderGateSaturatedError` (provider concurrency gate): thrown
 *  when a send legitimately queued waiting for a free provider concurrency slot
 *  exceeded the `queueWaitSeconds` bound (a retryable 429, `isRetryable`). Its
 *  message is `Provider "<name>" concurrency cap reached: waited <ms>ms without
 *  a slot. Retry after a brief delay.` — the stable signature is
 *  `concurrency cap reached`. The error reaches the host as a `PreflightFailed`
 *  either verbatim (the gate rejection propagates as the error `.message`) or
 *  embedded inside an enriched `Connection error (<cause>)` string (if the SDK
 *  wrapped the fetch rejection); the signature survives both. This is NOT a
 *  pruning failure — recognize it before the `prepass-failed` fallback so the
 *  notice blames concurrency saturation, not the pruning prepass. */
const PROVIDER_SATURATED_PATTERN = /concurrency cap reached/;

/** Backend execution guard for a session whose retained model belongs to a
 * provider the user has since disabled. */
const PROVIDER_DISABLED_PATTERN = /^PROVIDER_DISABLED:/;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip every `req-NN` id from `text` so no internal correlation id reaches
 *  the user. Replaces with the neutral token `request`. Pure. */
export function stripReqIds(text: string): string {
  return text.replace(REQ_ID_PATTERN, 'request');
}

/** True if `error` is a user-initiated cancel. The reducer
 *  SUPPRESSES the notice for a cancel — the user initiated it, so an error
 *  banner would be noise. The rollback (optimistic message removal + composer
 *  input restore) still happens; only the error surfacing is skipped. */
export function isCancelErrorString(error: string | undefined): boolean {
  return !!error && CANCELLED_PATTERN.test(error);
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

/**
 * Map a pre-ack RPC error (`SendResult{ok:false}` / `EditResult{ok:false}`)
 * to a plain-language notice. Returns `null` for a user-initiated cancel
 * (suppress the notice — the rollback still happens, just no error banner).
 *
 * `opKind` selects send-style recovery buttons vs an edit-style prose action.
 * Never includes the raw error string (it may carry `req-NN`); the message is
 * fixed prose per category. The raw error remains logged host-side.
 */
export function mapSendOrEditError(
  error: string | undefined,
  opKind: OpKind,
): MappedNotice | null {
  if (isCancelErrorString(error)) {
    return null;
  }

  const err = error ?? '';

  if (PROVIDER_DISABLED_PATTERN.test(err)) {
    return {
      kind: opKind === 'edit' ? 'edit-failed' : 'provider-disabled',
      message: opKind === 'edit'
        ? "Couldn't edit the message because its model provider is disabled. Enable the provider or select another model, then try again."
        : 'This model provider is disabled. Enable it in settings or select a model from an enabled provider.',
    };
  }

  if (REQUEST_TIMEOUT_PATTERN.test(err)) {
    if (opKind === 'edit') {
      return {
        kind: 'edit-failed',
        message: "Couldn't edit the message: the backend took too long to respond. Try editing it again.",
      };
    }
    return {
      kind: 'send-timeout',
      message: 'The model took too long to start this turn. You can retry, or adjust pruning in settings.',
    };
  }

  if (DROPPED_LINE_PATTERN.test(err)) {
    if (opKind === 'edit') {
      return {
        kind: 'edit-failed',
        message: "Couldn't edit the message: the backend sent a malformed response. Try editing it again, or show the logs.",
      };
    }
    return {
      kind: 'dropped-line',
      message: 'The backend sent a malformed response. You can retry, or show the logs for details.',
    };
  }

  if (BACKEND_EXIT_PATTERN.test(err)) {
    if (opKind === 'edit') {
      return {
        kind: 'edit-failed',
        message: "Couldn't edit the message: the pie backend stopped unexpectedly. Restart the backend, then try editing it again.",
      };
    }
    return {
      kind: 'backend-exit',
      message: 'The pie backend stopped unexpectedly. Restart the backend, then retry your message.',
    };
  }

  // Generic fallback: the raw error is unknown (may carry req-NN or other
  // internals), so do NOT include it. The detail is logged host-side.
  if (opKind === 'edit') {
    return {
      kind: 'edit-failed',
      message: "Couldn't edit the message. Please try editing it again.",
    };
  }
  return {
    kind: 'send-failed',
    message: "Couldn't send your message. Please try again.",
  };
}

/**
 * Map a post-ack, pre-commit setup failure (`PreflightFailed`) to a
 * plain-language notice. SDK preflight covers model/auth checks, compaction,
 * input hooks, and every `before_agent_start` extension; it is not synonymous
 * with skill pruning.
 *
 * Three sub-categories:
 *  - **prepass timeout** (send-timer fire while pruning still running):
 *    `"Timed out waiting for the turn to start streaming (Ns)"` →
 *    `prepass-timeout` (send) / `edit-failed` (edit).
 *  - **provider saturation** (host-side `ProviderGate` queue-wait bound
 *    elapsed): the error message contains `concurrency cap reached` →
 *    `model-start-timeout` (send) / `edit-failed` (edit). The send legitimately
 *    queued waiting for a free provider concurrency slot (a retryable 429); the
 *    prepass is incidental — the real cause is concurrency saturation, NOT
 *    pruning. Reuses `model-start-timeout` (same remedy: retry — the gate
 *    re-queues) so no new kind is needed.
 *  - **backend-reported setup failure**: any other error → `send-failed` /
 *    `edit-failed`. The backend's error detail is included SANITIZED. Do not
 *    label this as pruning: pruning may be disabled or may have had no
 *    candidates, and other preflight stages can reject independently.
 *
 * Never returns `null` (a setup failure is always a real error worth
 * surfacing — the user did not initiate it).
 */
export function mapPreflightError(
  error: string | undefined,
  opKind: OpKind,
): MappedNotice {
  const err = error ?? '';

  const timeoutMatch = PREPASS_TIMEOUT_PATTERN.exec(err);
  if (timeoutMatch) {
    const budget = timeoutMatch[1];
    if (opKind === 'edit') {
      return {
        kind: 'edit-failed',
        message: "Couldn't edit the message: pruning took too long. Try editing it again, or disable pruning in settings.",
      };
    }
    return {
      kind: 'prepass-timeout',
      message: `Pruning took too long to start this turn${budget ? ` (it exceeded the ${budget}s budget)` : ''}. You can retry, retry without pruning, or adjust pruning in settings.`,
    };
  }

  // Provider concurrency saturation: the host-side ProviderGate queued the
  // send waiting for a free provider concurrency slot and the queue-wait
  // bound elapsed (a retryable 429). This is NOT a pruning failure — the
  // prepass is incidental; the real cause is concurrency saturation. Reuse
  // `model-start-timeout` (same domain + remedy: retry — the gate re-queues;
  // show-logs for detail) instead of blaming pruning. Checked before the
  // `prepass-failed` fallback so the saturated signature never mislabels as
  // a pruning-step failure.
  if (PROVIDER_SATURATED_PATTERN.test(err)) {
    if (opKind === 'edit') {
      return {
        kind: 'edit-failed',
        message: "Couldn't edit the message: the provider was busy and no concurrency slot freed up in time. Try editing it again in a moment.",
      };
    }
    return {
      kind: 'model-start-timeout',
      message: 'The model is busy — your turn waited for a free provider concurrency slot but none opened up in time. You can retry, or show the logs for details.',
    };
  }

  // Generic SDK preflight failure: include the sanitized detail (no req-NN),
  // but do not attribute it to skill pruning. This path also covers auth/model,
  // compaction, input-hook, and unrelated before_agent_start failures.
  const detail = err.trim() ? stripReqIds(err).trim() : '';
  if (opKind === 'edit') {
    return {
      kind: 'edit-failed',
      message: `Couldn't edit the message: turn setup failed${detail ? `: ${detail}` : ''}. Try editing it again.`,
    };
  }
  return {
    kind: 'send-failed',
    message: `Turn setup failed${detail ? `: ${detail}` : ''}. You can retry.`,
  };
}
