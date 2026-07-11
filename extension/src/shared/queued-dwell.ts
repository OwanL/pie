/**
 * Queued-message dwell thresholds (handoff §F: queued-message liveness).
 *
 * A queued steering/followUp message is tracked from send time. A **soft**
 * threshold is informational (UI-only: the webview computes elapsed wait from
 * the entry's pure `enqueuedAt` and may show an info chip — no reducer effect).
 * The **hard** threshold arms a per-localId watchdog; on fire the reducer marks
 * the dwell entry `watchdogFired` (actionable: Stop/Remove via the existing
 * Interrupt/ClearQueue commands). The watchdog does NOT auto-interrupt the
 * in-flight turn — healthy tools are not stopped just because a follow-up was
 * queued.
 *
 * Sized to outlast legitimate tool-heavy turns (a useful subagent can run for
 * many minutes producing tool progress without model tokens) while still
 * bounding a genuinely-stuck queue. Matches the model-start budget
 * (`MODEL_START_TIMER_TIMEOUT_MS`): a queued message waiting longer than a full
 * model-start budget is exceptional enough to surface.
 */
export const QUEUED_DWELL_HARD_MS = 600_000;
