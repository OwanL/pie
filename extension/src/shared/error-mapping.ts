/**
 * User-facing error mapper (Brief H).
 *
 * Maps internal RPC/backend error strings to **plain-language** notice
 * messages + a failure `kind` that the webview uses to render recovery action
 * buttons. This module is **pure** (string-in → `{ message, kind }` out, no
 * I/O, no `Date.now`, no randomness) so it can be called from the reducer
 * without violating `STATE_CONTRACT.md` § Reducer Purity.
 *
 * Hard contract: **no internal `req-NN` id ever reaches the user.** Every
 * error string produced by Brief B's `RequestTracker` / `BackendClient`
 * carries a `req-NN` correlation id; this mapper strips it and names the
 * problem in plain language. The raw error is still logged host-side (via the
 * `Log` effect / `console.warn` in `handleLine`) so diagnostics are not lost.
 *
 * The classification is a contract with Brief B, which produces these known
 * error strings:
 *  - `RequestTracker` timeout: `"Timed out waiting for response to req-NN"`.
 *  - `RequestTracker` cancel:  `"Request req-NN was cancelled."` (or with a
 *    reason) — produced by `cancelledError` / the abort path (Brief E
 *    interrupt cancels an in-flight send).
 *  - `BackendClient` dropped line: `"Backend sent an unparseable response for
 *    req-NN: <reason> :: <snippet> (stderr tail: …)"`.
 *  - `BackendClient` exit rejection: `"Backend exited unexpectedly with code
 *    N."` / `"Backend stopped."` / `"Backend is not running"`.
 *  - `EffectRunner` send-timer fire (`PreflightFailed`): `"Timed out waiting
 *    for the turn to start streaming (Ns)"`.
 *
 * Recovery ACTIONS are webview-side: the host surfaces the failure `kind`;
 * the webview maps `kind → action buttons` via {@link noticeActionsFor} and
 * `noticeActionLabel`. See `docs/UX_RELIABILITY_PLAN.md` §10.
 */

/** User-facing failure category. Drives the recovery action buttons the
 *  webview renders. `edit-failed` carries no buttons (re-editing is a separate
 *  affordance Brief E owns; the message names the next action in prose). */
export type NoticeKind =
  | 'send-timeout'
  | 'prepass-timeout'
  | 'prepass-failed'
  | 'dropped-line'
  | 'backend-exit'
  | 'operational-error'
  | 'send-failed'
  | 'edit-failed';

/** A recovery action the webview can render as a button for a notice kind. */
export type NoticeAction =
  | 'retry'
  | 'retry-without-pruning'
  | 'show-logs'
  | 'open-settings'
  | 'restart-backend';

/** A mapped notice: a plain-language message (no `req-NN`) + a failure kind. */
export interface MappedNotice {
  message: string;
  kind: NoticeKind;
}

/** Which optimistic op the error is for — send ops get recovery buttons, edit
 *  ops get a prose action (re-editing is a separate affordance). */
export type OpKind = 'send' | 'edit';

// ─── Internal classification patterns (contract with Brief B) ────────────────

/** `req-NN` correlation id, anywhere in a string. Used to STRIP ids so none
 *  leaks to the user. */
const REQ_ID_PATTERN = /req-\d+/g;

/** `RequestTracker` pre-ack timeout: `"Timed out waiting for response to req-NN"`. */
const REQUEST_TIMEOUT_PATTERN = /^Timed out waiting for response to req-\d+$/;

/** `RequestTracker` cancel (Brief E abort): `"Request req-NN was cancelled."` (+ optional reason). */
const CANCELLED_PATTERN = /^Request req-\d+ was cancelled/;

/** `BackendClient` dropped line: `"Backend sent an unparseable response for req-NN: …"`. */
const DROPPED_LINE_PATTERN = /^Backend sent an unparseable response for req-\d+:/;

/** `BackendClient` exit rejection: `"Backend exited unexpectedly with code N."`,
 *  `"Backend stopped."`, `"Backend is not running"`, `"Backend client disposed."`. */
const BACKEND_EXIT_PATTERN = /^Backend (exited unexpectedly|stopped|is not running|client disposed)/;

/** `EffectRunner` send-timer fire (`PreflightFailed`): `"Timed out waiting for the turn to start streaming (Ns)"`.
 *  The budget is a whole-or-decimal second count (e.g. `120s` or `12.5s`) — the
 *  send-timer budget derives from `prepassTimeoutSec` + first-token headroom and
 *  may be fractional, so the capture group accepts an optional decimal. Without
 *  it a decimal budget (e.g. `12.5s`) would fail to match and the error would
 *  misclassify as a generic `prepass-failed` (Brief H follow-up). */
const PREPASS_TIMEOUT_PATTERN = /^Timed out waiting for the turn to start streaming \((\d+(?:\.\d+)?)s\)$/;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip every `req-NN` id from `text` so no internal correlation id reaches
 *  the user. Replaces with the neutral token `request`. Pure. */
export function stripReqIds(text: string): string {
  return text.replace(REQ_ID_PATTERN, 'request');
}

/** True if `error` is a user-initiated cancel (Brief E abort). The reducer
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
 * Map a post-ack, pre-commit prepass failure (`PreflightFailed`) to a
 * plain-language notice. The `message.send` RPC already succeeded (the prompt
 * was queued); the pruning prepass then failed.
 *
 * Two sub-categories:
 *  - **timeout** (send-timer fire): `"Timed out waiting for the turn to start
 *    streaming (Ns)"` → `prepass-timeout` (send) / `edit-failed` (edit).
 *  - **backend-reported failure**: any other error → `prepass-failed` (send) /
 *    `edit-failed` (edit). The backend's error detail is included SANITIZED
 *    (any `req-NN` stripped) since it is not an internal id the host minted —
 *    it can name the real cause (e.g. a model error).
 *
 * Never returns `null` (a prepass failure is always a real error worth
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

  // Backend-reported prepass failure: include the sanitized detail (no req-NN).
  const detail = err.trim() ? stripReqIds(err).trim() : '';
  if (opKind === 'edit') {
    return {
      kind: 'edit-failed',
      message: `Couldn't edit the message: the pruning step failed${detail ? `: ${detail}` : ''}. Try editing it again, or disable pruning in settings.`,
    };
  }
  return {
    kind: 'prepass-failed',
    message: `The pruning step failed to start this turn${detail ? `: ${detail}` : ''}. You can retry, or retry without pruning.`,
  };
}

// ─── Recovery actions (webview-side) ─────────────────────────────────────────

/** The recovery action buttons the webview should render for a notice kind.
 *  `edit-failed` carries none — the message names the next action in prose
 *  (re-editing is a separate affordance Brief E owns). Pure; the webview
 *  imports this so the kind → actions mapping has one source of truth. */
export function noticeActionsFor(kind: NoticeKind): NoticeAction[] {
  switch (kind) {
    case 'send-timeout':
      return ['retry', 'open-settings'];
    case 'prepass-timeout':
      return ['retry', 'retry-without-pruning', 'open-settings'];
    case 'prepass-failed':
      return ['retry', 'retry-without-pruning'];
    case 'dropped-line':
      return ['retry', 'show-logs'];
    case 'backend-exit':
      return ['restart-backend', 'show-logs'];
    case 'operational-error':
      return ['show-logs'];
    case 'send-failed':
      return ['retry'];
    case 'edit-failed':
      return [];
  }
}

/** The human-readable label for a recovery action button. */
export function noticeActionLabel(action: NoticeAction): string {
  switch (action) {
    case 'retry':
      return 'Retry';
    case 'retry-without-pruning':
      return 'Retry without pruning';
    case 'show-logs':
      return 'Show logs';
    case 'open-settings':
      return 'Open settings';
    case 'restart-backend':
      return 'Restart backend';
  }
}
