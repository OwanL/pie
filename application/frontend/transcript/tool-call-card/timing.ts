/** Grace period (ms) a shell tool's auto-shown body stays expanded after the
 *  command finishes, so the user can read/skim the output even for instant
 *  commands. Only applies to the auto-opened shell path — manual opens are
 *  sticky and never auto-close. */
export const TOOL_CALL_CLOSE_GRACE_MS = 1000;
/** Duration (ms) of the post-grace collapse animation. Must match the
 *  transition on `.tool-call-body-wrap` in styles/tool-call.css. Exported so
 *  tests can advance virtual clocks in lockstep with the tuning (D7). */
export const TOOL_CALL_CLOSE_TRANSITION_MS = 300;
/** Duration (ms) of the one-shot expand animation for the AUTO-shown shell
 *  body. Opacity-only (see @keyframes tool-call-body-expand in
 *  styles/tool-call.css) so it doesn't fight streaming height growth. Must
 *  match the `--panel-duration-entrance` token consumed by the keyframes. */
export const TOOL_CALL_EXPAND_MS = 280;
/** How long (ms) the completion pulse highlight remains on the card. */
export const TOOL_CALL_COMPLETION_PULSE_MS = 700;
