# Session titles

Pie can generate a compact title for a new session with a low-priority asynchronous LLM request. The coordinator owns the assigned-title namespace for live sessions through the building blocks described under “Title authority” below; the session-control bridge integration retains ownership of wiring these blocks into the tool surface.

## User experience

1. The first user prompt immediately becomes a literal, whitespace-normalized tab snippet, bounded to the same 25-character base-title allowance as newly assigned titles (a trailing ellipsis marks truncation). Existing assigned titles are never bulk-shortened.
2. A small wheel appears in the tab while title generation is armed or running.
3. Generation starts at the first assistant-start commit point, not the user append: that append can still be rolled back. Candidate inference runs outside the host mutation queue and worker FIFO, with one in-flight generation per worker, so provider latency does not hold up session mutations.
4. A valid generated title replaces the snippet after durable assignment. On generation failure or timeout, Pie attempts to assign the bounded prompt snippet through the same title authority. A successfully assigned fallback is stable and addressable, not a provisional label to retry automatically. Assignment failure leaves the provisional snippet; the wheel stops and the attempt is consumed.

An explicit SDK/manual session name always wins. The worker checks for one both before the model request and immediately before writing, so a rename racing an in-flight request is not overwritten.

## Settings

Settings → Chat → Session titles provides:

- an enable/disable toggle, enabled by default;
- a provider-qualified model picker containing enabled text-capable models;
- a thinking-level selector, defaulting to `off`;
- a 1–60 second timeout selector, defaulting to 15 seconds.

The default is `ollama/deepseek-v4-flash:0731-cloud`. `models.yaml` seeds missing settings, while existing `settings.json.sessionTitles` values remain user-owned. Enabling the feature affects new unnamed sessions only; Pie does not bulk-retitle history.

## Worker contract

The host calls the backend `session.title.generate` RPC, classified as low-priority `session-title` provider work. The worker compacts the first prompt to at most 4,000 characters, removing code fences and retaining bounded beginning/end context. It requests a complete title of at most 25 characters, preferring 2–3 short words where appropriate for the language, with action and subject first, and passes the configured thinking budget (off by default). The Ollama-native request uses temperature zero.

Validation accepts one nonempty line after wrapper/label and whitespace normalization, at most 25 JavaScript string characters, containing a Unicode letter or number and no disallowed control characters. There is no English-word or word-count requirement. Oversized output is rejected, never salvaged by chopping trailing words or splitting identifiers. Invalid output permits at most one corrective model request for a complete replacement; authentication and both inference attempts share one overall configured deadline. Errors fail open without a user-blocking error.

That deadline bounds the candidate stage, not the full reserve/persist/publish operation. The host RPC timeout is the configured duration plus five seconds; it is not a durable-assignment deadline or a strict end-to-end bound. Assignment can wait on the owning worker's serialized writer after inference finishes.

Generation is candidate-only: model output is never published or written as a final name by the generation seam. The coordinator reserves a unique title, the owning session durably persists that assigned title, and only then may the title authority publish it for display or addressing. Newly assigned base titles (including create input, generated candidates, and snippet fallbacks) are 1–25 characters after trimming; automatic collision suffixes are additional, and oversize input is rejected rather than shortened. Existing assigned titles are preserved verbatim (see below).

No generated-title cache is used. Each new unnamed session has one automatic attempt (including the optional correction), and host results are fenced by session path plus correlation ID. Invalidated results are discarded before assignment. Once a reservation is made and its durable write dispatched, that commit must settle; cancellation or a host timeout is not a remote cancellation fence and cannot promise that metadata remains unchanged.

## Title authority

The coordinator owns allocation for live sessions and in-progress name reservations — never retained closed history or the bounded tool-list page — through `harness/agent-processes/coordinator/live-session-titles.ts` (`LiveSessionTitles`). The unique namespace is unavailable until startup reconciliation of restored live sessions completes; failures leave it closed, and callers must report it as unavailable rather than guessing from partial live membership or waiting for unrelated archive indexing.

`reconcile(entries, persist)` establishes (and repeatably refreshes) the namespace from restored live-session metadata. Entries supply `sessionPath`, a stable `sessionId` (resolved by the caller through `resolveSessionIdentity`, including its deterministic normalized-path fallback for legacy headers), the durable `headerTimestamp`, and the existing durable `title` if any. Existing literal titles are reserved first, so an existing `Review (2)` blocks a newly suffixed `Review`. Collisions keep the original on the entry with the oldest durable header creation timestamp (invalid/missing timestamps sort after valid ones, session identity breaks ties); other entries receive deterministic `(n)` suffixes, and each suffix assignment is persisted through the caller's fenced cold mutation callback (`persist(path, title)`) before the name is published. A failed persistence frees that reservation and leaves readiness failed closed.

`reserve(baseTitle, identity)` allocates synchronously — the occupied-title check and its reservation complete in one synchronous turn, so concurrent allocations cannot collide and no allocation critical section is held through a worker callback. New base titles must be 1–25 characters after trimming; automatic suffixes are additional and must not consume the input allowance; oversize input is rejected, never silently shortened. Legacy assigned titles longer than the new limit are preserved verbatim. `confirm` publishes a reservation only after the owning worker durably persisted the assigned title; `release` frees the name on confirmed close/deletion — closing retains the reservation until that confirmed release, pending/failed close keeps it, and ordinary close retains the recorded title in historical metadata without keeping a live reservation or historical alias. `resolve(title)` matches exactly after trimming outer whitespace (no fuzzy matching; provisional labels never resolve); `assigned(path)` returns the published assigned title; `list()` snapshots reserved and assigned names.

Background admission failures retain the affected path as unavailable and back off from one to sixty seconds, retried only by subsequent membership snapshots. They do not block admission of later healthy members or revoke existing title readiness. An explicit open can retry immediately through the same per-path single-flight gate; confirmed retirement and disposal clear retry state.

Cold-side title writes go through the lease-fenced `ColdSessionStore` mutation APIs (`setSessionTitle`, `setHandleSessionTitle`), mirroring the cold model-settings append: one coordinator-side `session_info` entry under the ownership fence, browse-cache retirement and catalog refresh on commit, and no coordinator JSONL write while a worker owns the session's lease. Hot writes go through the owning worker. Catalog/index refresh and host publication follow confirmed assignment.

## State ownership

`ArchState.sessions.titleGenerationBySession` owns `armed`, `pending`, and `failed` lifecycle state. Projection publishes only `ViewState.generatingTitleSessionPaths`; the webview does not own title lifecycle. Pending-path replacement rekeys the state to the real JSONL path. Session close/invalidation clears it. Send rollback clears an armed attempt and restores the original summary.
