# Codebase review — complete

Orchestrated pass over `docs/internal/code-review/SUMMARY_structural_issues.md`
(backlog S1–S11). All items done; deferred follow-ups are collected in the
"Discovered follow-ups" section below with rationale. Status legend:
planned / scouting / in progress / in review / done / deferred.

| Item | Issue | Status | Commit |
|---|---|---|---|
| W1 — Re-render hot path (memoize render boundary, stabilize `availableModels`) | S5 | done | `bd1eced` |
| W8 — Extract `evictSession(state, sp, {removeSummary, removeTabs})` | S1 / 02 C1 | done | `034ef31` |
| W9a — Archive/delete one-shot codemods | S10 | done | `58c7adf` (move `73073e1` prior) |
| W6 — Reconcile docs with `STATE_CONTRACT.md` | S7 | done | `2310d2e` |
| W2a — Thinking-level enum shared module | S1 | done | `c66b38e` |
| W2b — Pruning-summary math helper | S1 | done | `0c1b01d` |
| W2c — Checkpoint parse/read helpers | S1 | done | `dec9284` |
| W2d — Path utilities shared module | S1 | done | `99681d7` |
| W2e — Token formatting factory | S1 | done | `b267880` |
| W2f — Pricing logic across 3 packages | S1 | done | `f2253ca` |
| W2g — Coercion / failure-kind taxonomy (4 kind unions → shared/) | S1 | done | `d978b67` |
| W3 — Decompose `EffectRunner.run()` into dispatch table | S2 / 02 H1-H2 | done | `c909d1b` |
| W4 — Tighten boundary-typing ring | S6 | done (4 commits: W4a `915c4aa`, W4b `a6c205c`, W4c `f99b797`, W4d `5dcba6d`) | `915c4aa`+`a6c205c`+`f99b797`+`5dcba6d` |
| W5 — Fix silent error swallowing + atomic persistence + versioned migration | S3 | done (5 commits: W5a `cd16d2b`, W5d `16ceeee`, W5e `66a9f8b`, W5b `c17f46f`, W5c `cfed164`) | `cd16d2b`+`16ceeee`+`66a9f8b`+`c17f46f`+`cfed164` |
| W9b — Install-script portability | S10 | done (install.sh `shasum`→portable, install.ps1 exit-nonzero) | — |
| W7 — Refactor-hostile tests → behavior tests (scoped: EffectRunnerDeps typed factory) | S8 | done (scoped `6ba0293`) | `6ba0293` |

## Decisions pending (resolve before resuming)
- **W5 versioned-migration design — RESOLVED (user discretion):** option (a) —
  a migrations registry (`Array<{from, to, up}>` up-step functions) consulted by
  `parseCheckpoint`; it walks the chain from the file's `schemaVersion` up to
  `RUN_ANALYTICS_SCHEMA_VERSION`, then validates. Empty for v1 (no migrations
  yet); forward-looking, no behavior change for existing v1 data. Scoped to the
  `RunCheckpoint` (the single schema-versioned user-data artifact; the export
  payload's `schemaVersion` is a regenerated snapshot, not a migrated store).
  Implement before atomic persistence.
- **W2g type ownership — RESOLVED (user discretion):** option (a) — `shared/`
  owns the canonical 4 kind unions; both `extension/src/shared/tool-call-analysis`
  and `analysis/scripts/contracts.ts` re-export from there. Matches the W2f
  `shared/pricing-core.ts` precedent (shared/ already bridges analysis + extension
  via relative `.js` imports under NodeNext; a direct analysis↔extension cross-tree
  import would clash across bundler-vs-NodeNext resolution). Scope = the 4 unions +
  their `*_KINDS` const arrays (the taxonomy); the heavier coercion-*function*
  dedup (`coerceToolUsageRollup` etc.) is left as a follow-up.

## Discovered follow-ups (not in original backlog)
- **Streaming perf — SDK `SessionManager.getBranch()` is O(n²) (quadratic)**
  due to repeated `Array.unshift` in its leaf→root walk. Root cause of the pie
  extension "chugging regardless of provider" on long conversations: the pie
  backend called `emitContextUsageChanged` → `deriveContextUsageFromBranch(
  getBranch(), …)` on EVERY `message_update` token, making streaming O(n²)
  per token (measured: 5µs→2.6ms per call from 100→4000 branch entries; ×4 per
  doubling). Fixed on the pie side — `session-event-handler.ts` no longer
  calls `emitContextUsageChanged` on deltas (usage only lands at
  `message_end`). The SDK `getBranch()` itself remains O(n²); now only hit per
  turn (context build / compaction / branch ops) which is tolerable, but
  should be made O(n) (build with `push` + single `reverse`, or index from
  root) in the `@earendil-works/pi-coding-agent` repo to defuse the latent
  quadratic for very long sessions and to benefit the pi CLI/TUI.
- **Stray stderr debug in `session-event-handler.ts` `tool_execution_start`**
  (`process.stderr.write` per tool call, captured into the host's 64KB stderr
  ring buffer). Not a perf issue (per tool call, not per token) but is debug
  litter; remove when file-changes tracking debug is no longer needed.
- **`pruning-settings.ts:24` `VALID_MODES`** omits `'custom'` (mirrors the
  `VALID_PRUNING_MODES` drift W2a fixed in protocol-validation). Host-side
  persistence may reject a `custom` pruning mode. Fix in a follow-up.
- **Analysis 95% line-coverage gate is already failing** (70.4% baseline, measured
  with the original pre-W2f `analysis/scripts/pricing.ts`). Pre-existing, NOT a
  W2f regression (W2f: 70.4%→70.4%, branches 87.3%→87.2%). The 95% gate in
  `scripts/run-tests.mjs:28` is hostile to cross-package extraction (extracted,
  well-covered code leaves the package's coverage scope). Revisit the threshold
  or the coverage-include strategy.
- **`isTaskBoundaryIntent`** in `stats-service/helpers.ts` is now unused after
  W2c (inlined into the shared checkpoint-io module). Safe to remove in a
  follow-up.
- **Dead `truncateText` wrapper** in `tool-call-summary.ts` after W2d (no
  remaining callers). Safe to remove.
- **W2g follow-up — `*_KINDS` const arrays remain duplicated** between
  `extension/src/host/run-analytics/coercion-rollups.ts` and
  `analysis/scripts/source.ts`. `VERIFICATION_COMMAND_KINDS` /
  `TOOL_FAILURE_KINDS` / `TOOL_RESULT_ISSUE_KINDS` are byte-identical arrays in
  both trees; `TREATMENT_CHANGE_KINDS` is an `array` in `coercion-rollups.ts`
  but a `new Set<TreatmentChangeKind>([…])` in `source.ts` (structural
  divergence → not merged). The coercion *functions*
  (`coerceToolUsageRollup`, `createEmpty*KindRecord`, `LEGACY_*_MAP`, sample
  splitting) also remain duplicated. A follow-up could converge all `*_KINDS`
  into `shared/tool-analysis-kinds.ts` (blessing the array form, with
  `source.ts` constructing its `Set` from it) and dedup the coercion functions
  into a shared `coercion-core.ts` — a larger, separate effort.
- **W4 deferred S6 follow-ups (lower-priority boundary `any`/double-casts,
  not in the core ring tightened by W4a–W4d):**
  - `extension/src/backend/session-event-handler.ts:261`
    `mapAssistantMessage(messageId, event.message as any, …)` on the hot
    assistant path — `event.message`'s SDK shape could be typed via the same
    local minimal-event pattern used in W4d.
  - `extension/src/webview/panel/transcript/virtual-list-row.tsx:9`
    `return renderer(props) as any` defeats return-type checking of registered
    renderers; `registry.ts` uses bare `string` keys (no union, silent
    override). Tighten the renderer-registry signature.
  - Double-casts: `session-metadata.ts:~172` `as unknown as`; tool-call
    renderers `e as unknown as MouseEvent` (~5 sites).
  - `coercion-snapshots.ts:~164` `const c = candidate as RunSnapshot` after a
    partial predicate — any `RunSnapshot` field added without a matching
    `validateX` becomes silently unvalidated on read. Strengthen the predicate
    to cover all required fields (or cast only the validated subset).
- **W5 follow-ups (deferred, lower priority):**
  - **`++this.seq` on persist failure** was intentionally NOT restructured (W5c).
    `seq` labels checkpoint snapshots and the reader takes the higher-seq slot,
    so a missed intermediate seq is not data loss (snapshot semantics).
    Restructuring to increment-seq-only-on-success would risk the slot/pointer
    ordering invariant. Revisit only if a per-seq audit/gap signal is wanted.
  - **Persist failure with no subsequent `schedulePersist`** is recorded only
    when the next `schedulePersist`'s leading `.catch` observes the rejected
    queue (inherent to the promise-chain design). A bare `flush()` after a
    failure may show a stale/absent `getPersistError()`. Fixing would require a
    side-effecting rejection observer on the queue — out of scope for the
    behavior-preserving W5c fix.
  - **`error.data` on `ErrorPayload`**: W5d threads `BackendError.data`
    additively through `extractRequestError`'s return type (`ErrorPayload &
    { data?: unknown }`) WITHOUT formally adding `data?` to the `ErrorPayload`
    interface (which has `requestId?`). Formally add `data?` to `ErrorPayload`
    if a consumer starts reading it.
- **W9b — install.sh vs install.ps1 feature gap (S10, documented):**
  `install.sh` (Linux/macOS) is a SUBSET of `install.ps1` (Windows). The ps1
  script additionally: (a) migrates legacy session files into the local
  sessions dir (`Merge-LegacySessionFiles`), (b) patches `sessionDir` in
  `settings.json` to point at the local sessions dir, (c) builds/packages the
  VS Code extension and installs the `.vsix`. `install.sh` does NONE of these
  — it only migrates `auth.json`, relocates the secret, and runs `pi update`.
  Linux/macOS users get an incomplete install (no session migration, no
  settings patch, no extension build). Closing the gap means porting those
  three ps1 steps to bash (and deciding whether `settings.json` patching is
  desirable cross-platform). Deferred — the gap is now documented.
  **W9b done in this pass:** `install.sh` `shasum` → portable resolver
  (`shasum -a 256` → `sha256sum` fallback → degrade-with-warn) so the
  auth-relocation no longer aborts mid-flight on Linux under `set -euo
  pipefail`; `install.ps1` extension build/package/install failures now set a
  flag and `exit 1` (were `Write-Warning` + exit 0).
  **W9b remaining ps1 follow-ups (Medium, deferred — need careful testing on a
  clean Windows box):**
  - `settings.json` rewrite via `ConvertTo-Json` loses key order/formatting
    (lines ~238, ~256). Preserve order with an ordered approach
    (`[ordered]@{}` reconstruction or a surgical string patch).
  - VS Code path probe checks only the User install (`%LOCALAPPDATA%\Programs\
    Microsoft VS Code`); no Insiders/probe fallback.
  - ACL applied after source deletion in the auth-relocation path — apply ACL
    to the target BEFORE deleting the in-tree source so a failure between
    delete+ACL doesn't leave the secret un-protected.
- **W7 follow-ups (deferred — larger separate efforts):**
  - **`FileDiffServiceLike` interface**: the W7 typed factory types `service`/
    `statsService` directly against their `*Like` interfaces (full drift
    detection), but `fileDiffService` is `Pick<FileDiffService, 3 methods>` +
    `as unknown as FileDiffService` because `FileDiffService` is a CLASS with
    private members (a literal can't satisfy it). A newly-added PUBLIC method on
    `FileDiffService` beyond the 3 runner-used ones would NOT be caught. Fix:
    introduce a `FileDiffServiceLike` interface in `effect-runner.ts` (production
    change) and type the dep + the factory against it.
  - **Source-text/regex structural tests → behavior tests (S8 H2, highest-value):
    `webview-style-contract.test.ts`, `arch-boundary-guards.test.ts`,
    `tool-call-heading-css.test.ts`** read source files and assert regexes/
    strings on the SOURCE TEXT (a formatter pass or var rename trips red with
    zero behavior change). Rewriting each to assert on OBSERVABLE BEHAVIOR
    (rendered DOM, actual guard outcomes) is a per-file effort — deferred.
  - **Dedicated `message-router.test.ts` (S8 H1)** — the riskiest impure-plumbing
    layer (SDK event → arch Event translation, ordering, error paths) has only
    incidental coverage. Deferred.
  - **UI tests assert rendered HTML strings (S8 H3)** — 14 files use
    `preact-render-to-string` + `assert.match`; `@testing-library/preact` is a
    devDep used by 0 files. Migrating to DOM-behavior interactions is a larger
    effort — deferred.
- **`header.ts` token grouping** changed from host-locale to `en-US` in W2e
  (intentional, deterministic). Confirmed acceptable.
- **`handleSessionClosed`** now drops the session summary (via
  `evictSession({removeSummary:true})`) where the old `removeSessionFromState`
  retained it. Currently unobservable (`SessionClosed` has no dispatch site) and
  aligns with full-eviction intent. Flagged by the W8 reviewer for awareness.
- **Bash hang safeguard — IMPLEMENTED, NOT YET LOADED (commit `9584640`).**
  `extensions/safeguard` now applies a 600s default `timeout` to every `bash`
  call that omits a positive finite one, so hung commands (whole-PC filesystem
  walks, infinite loops, blocked prompts) are killed instead of hanging
  forever. Genuine long tasks are unaffected (typecheck ~18s, test ~22s, build
  ~30s; 600s = 20× headroom); the per-call `timeout` override is preserved.
  112 safeguard tests pass. **CAVEAT:** the repo `settings.json` `extensions`
  array only loads `pi-web-access`, so the safeguard extension (both the new
  timeout AND its pre-existing hard-block safety) is dormant at runtime. No
  `~/.pi` user-scoped config exists on this machine. **User action required:**
  add `extensions/safeguard` to `settings.json`'s `extensions` array (the user
  will do this — orchestrator is forbidden from editing the runtime-managed
  `settings.json`). Enabling it also turns on the destructive-command
  hard-block/prompt safety (a runtime behavior change).

---

# Nested subagent expandable UI — sticky/scroll/overlap fix (2026-06-25)

The nested (depth ≥ 2) subagent header was `position: sticky` inside the
parent subagent's bounded scroll region, so it pinned to the parent's scroll
port and bled over the parent's own sticky header (12–19px measured overlap
via headless-Chrome CDP), and the nested body opened a second stacked 240px
scroll container (nested-scroll hell). Fixed for depth ≥ 2 only (depth-1
unchanged):

- `tool-call-item.tsx`: `SubagentSingleBlock` computes `isNested =
  subagentDepth > 1`; nested header gets `subagent-header-nested`;
  `SubagentMessages` gains `isNested` → body gets `subagent-messages-scroll-
  nested` and skips resize handles.
- `tool-call.css`: `.subagent-header-nested { position: relative; top: auto;
  z-index: auto; }` (relative preserves the pending-ask-user `::after`
  anchor; z-index auto lets the parent's z-10 sticky header cover it instead
  of the nested header bleeding over); `.subagent-messages-scroll-nested {
  max-height: none; min-height: 0; overflow-y: visible; }` (flows inside the
  parent's single bounded scroll region).
- `test/webview/transcript/tools/nested-subagent-expand.test.ts` (NEW, 10 tests): nested recursion
  expand/collapse + toggle independence, depth-1-vs-nested class/CSS
  assertions, and a depth-3 fixture proving `subagentDepth` keeps
  incrementing so every level ≥ 2 is nested.

Verified: `npm test` (1591 pass), `typecheck`, `lint` green; real-browser CDP
confirms depth-1 stays sticky/capped and nested is relative/free-flowing with
no nested-over-outer bleed.

---

# Nested Subagent Enablement — Work Plan

Goal: make agents trigger nested subagents more often, safely.

## Scope (decided)
- **A** — `worker.md`: prompt encourages delegating independent sub-steps (scout for recon, worker for sub-impl), parallel when independent.
- **B** — `subagent` tool `description`/`promptSnippet`: advertise that subagents may delegate further (depth-limited).
- **C** — Open `scout` to nesting via new `canSpawn` frontmatter allowlist → preserves read-only invariant (scout can only spawn `scout`). `reviewer` stays a leaf.
- **D** — `MAX_DEPTH` env-configurable (`PIE_SUBAGENT_MAX_DEPTH`), exposed in the pie settings menu.
- **E** — Tree-wide session budget (shared counter via AsyncLocalStorage), env-configurable (`PIE_SUBAGENT_MAX_TREE_SESSIONS`), exposed in the pie settings menu.

## Protections (kept)
- `MAX_DEPTH` (default 3, now configurable) — caps nesting depth.
- `MAX_SESSIONS_PER_CALL` = 20 — per-tool-call breadth.
- `MAX_PARALLEL_TASKS` = 8 / `MAX_CONCURRENCY` = 4.
- `checkTrailLoop` — same agent ≥2× in ancestry blocked.
- **NEW** `canSpawn` allowlist — caller-restricted spawning.
- **NEW** tree-wide session budget — caps total sessions across the nested tree (default 50).

## Tasks

### Subagent extension (self-contained)
- [x] `agents.ts`: add `canSpawn?: string[]` to `AgentConfig`; parse from frontmatter (reuse list parser).
- [x] `runner.ts`: extend `SubagentRuntimeContext` (`canSpawn?`, `budget?`); add `getMaxDepth()` + `getMaxTreeSessions()` resolvers + `consumeTreeSlot()`; fix stale `noExtensions` comment.
- [x] `src/execute.ts`: use `getMaxDepth()`; canSpawn enforcement; ensure budget at root; new error responses.
- [x] `src/modes.ts`: `buildRuntime` threads `canSpawn` (child's) + shared `budget`; consume tree slot at each spawn point.
- [x] `agents/scout.md`: add `subagent` to `tools`, add `canSpawn: [scout]`.
- [x] `agents/worker.md`: delegation guidance (A).
- [x] `src/register.ts`: advertise nesting (B).
- [x] `README.md`: update Limits section.
- [x] tests: canSpawn enforcement; tree budget; configurable depth (`nesting-controls.test.ts`).

### Pie settings menu plumbing (live runtime prefs, mirrors `subagentAlwaysParentModel`)
- [x] `shared/protocol/settings.ts`: `subagentMaxDepth`, `subagentMaxTreeSessions` in `ChatPrefs` + defaults.
- [x] `shared/protocol-validation.ts`: numericRanges entries.
- [x] `backend/rpc.ts`: `RuntimePrefsSetParams` + validation.
- [x] `backend/request-handler.ts`: set `PIE_SUBAGENT_*` env vars.
- [x] `host/session-service/startup.ts`: send on startup.
- [x] `host/session-service/service.ts`: send on setPrefs.
- [x] `webview/panel/composer/settings-menu-subcomponents.tsx`: two range sliders in `SubagentSettings`.

### Verify
- [x] `npm run extensions:test -- --package subagent` (454 pass, 96.6% lines / 90.4% branches)
- [x] `cd extension && npm run typecheck && npm run build` (synced)
- [x] `cd extension && npm test` (1579 pass, 0 fail in isolation)
- [~] reviewer subagent: blocked by stale in-process module cache (running pi loaded old extension source at startup); self-review completed instead. **Restart pi** to load the new extension source and exercise nesting live.

## Known limitations / deferred
- Model-retry path (`runWithModelRetry`) may spawn up to `MAX_MODEL_RETRIES+1` sessions but consumes only one tree slot — consistent with the existing per-call `MAX_SESSIONS_PER_CALL` counter. Acceptable for a safety cap; revisit if model-failure cascades become a cost problem.
- New knobs are NOT added to `FunctionalSettingsSnapshot` (run-analytics) — they're runtime config, not per-run analytics. Add later if per-run depth/budget analytics are wanted.
- `reviewer` remains a leaf (no `subagent` tool) by design.

---

# Expandable UI refinement — aria-controls wired (2026-06-25)

- `aria-controls`/`id` is now wired between every expandable header and its
  body. `Collapsible` (reasoning / pruning-details / pruning-inline),
  `ToolCallCard` (`.tool-call-body-wrap`), and `SubagentSingleBlock`
  (`.subagent-messages`) each generate a stable `useId()` per instance: the
  header carries `aria-controls={bodyId}` and the body carries `id={bodyId}`.
  Because the bodies are lazily mounted only when open (perf: bodies are
  heavy), `aria-controls` is set ONLY when the body is actually mounted and
  omitted when collapsed — so the reference never points at a missing element
  (WAI-ARIA-correct). No mount-strategy / perf change. Pinned by
  `extension/test/webview/components/aria-controls-wiring.test.ts`.
- Composite headers (`ToolCallHeader`, `SubagentSingleBlock`) use a
  `role="button"` div rather than a real `<button>` because they contain nested
  interactive controls (copy-error `StatusChip`, file/path buttons). A real
  `<button>` cannot contain button descendants, so this is the established
  pattern. A future pass could split the leading label into a real `<button>`
  toggle and lift action buttons out as siblings (changes hitbox UX).

---

# Pruning keep-all safeguard labeling — done; deferred follow-ups

The prepass panel labeled any 100%-prune keep-all as "Fail-open" with reason
"keeping all as fail-open", which misframes a *legitimate* full prune (e.g. a
non-coding query needing zero dev-skills) as an LLM error. Fixed (behavior
unchanged): label → "Keep-all safeguard", reason strings → "keeping all as a
safeguard", comments/README/protocol doc reworded, and the skill comment no
longer claims "almost always a misunderstanding".

Deferred (intentionally NOT done in this pass):
- **Field rename** `prepassFailOpenReason` / `failOpenReason` → something neutral
  (e.g. `prepassSafeguardReason`). **DONE 2026-06-25**: renamed to
  `prepassSafeguardReason` / `safeguardReason` (+ `skillSafeguardReason` /
  `toolSafeguardReason` locals) across the extension webview + skill-pruner
  producer/consumer (commit `964e133`). The host passes pruning details JSON
  through opaquely, so producer + consumer ship together; historical analytics
  query text mentioning the old name was left unchanged. Extension + skill-pruner
  tests green.
- **Distinguish legitimate full-prune from over-prune** (declined). The keep-all
  safeguard still fires for correct 100% prunes. A future heuristic (e.g. detect
  non-coding queries, or trust the prepass when reasoning explicitly justifies
  a full prune) could let correct full-prunes through. Tools stay fail-open
  regardless (zero tools is fatal).
  **Updated 2026-07-08**: the *skill* safeguard now only fires when no tools
  remain either — an agent with zero skills but its tools is fully functional,
  so a legitimate full skill-prune is allowed through whenever >=1 tool survives.
  The tool safeguard is unchanged (zero tools is fatal). Subagent inheritance
  still treats an empty parent kept-set as keep-all (an independent safety net,
  no longer a mirror of the pruner's safeguard).

---

# Dead-code / styling pruning — deferred (2026-06-25)

Committed in `f6ec55f`. The following were intentionally NOT committed:

## Left in working tree (concurrent WIP interleaved) — LANDED in `245f351`
Dead-code cleanups that were deferred because the files carried concurrent
files-reviewed feature work. They landed with that feature in `245f351`:
- `analysis/scripts/source.ts` — removed dead export `DEFAULT_SITE_DIST_DIR`
- `analysis/test/pipeline-e2e.test.ts` — removed unused imports (`deepClone`, `RunOutcome`, `SiteDataBundle`, `PreparedRunRow`)
- `analysis/test/stratified-ranker.test.ts` — removed unused import `RunOutcomeResolution`

## Pre-existing lint debt (not introduced by this pass)
- 6 `prefer-const` errors in extension test files (`let runner: EffectRunner;`
  declared early, assigned late because a hoisted `dispatchArch` closure
  references it). **RESOLVED 2026-06-25 maintenance pass**: converted to a plain
  `const runner = new EffectRunner(deps);` reorder — verified this repo's eslint
  config has `no-use-before-define` OFF and TS does not flag deferred-body
  references, so no use-before-declaration error. `npm run lint` + `typecheck`
  now clean (5 test files: close/create/duplicate/open-session-ordering +
  session-tab-actions).
- `@typescript-eslint/no-unused-vars` is `off` for `extension/test/**` by project
  convention, so ~20 unused test imports/vars there are tolerated.
- skylos reports ~24 extension source files + `extensions/subagent/src/execute.ts`
  as having "unused imports"; `tsc --noUnusedLocals` confirms these are false
  positives (extension `src/` is fully clean). Not dead — do not remove.
  **Re-verified 2026-06-25**: `tsc --noUnusedLocals` across extension / subagent /
  skill-pruner reports ZERO unused symbols in any `src/` file; the only
  genuinely-unused import in the repo was `sum` in
  `analysis/site/charts/toolduration.ts` (removed).

---

# Files-reviewed analytics — optional follow-ups (2026-06-25)

`readCountsByFile` capture + `filesReviewedCount` / `readRevisitRate` derivations
+ the "Files reviewed per run" dashboard chart landed in `245f351`. Deliberately
scoped out (revisit only if wanted):
- DuckDB `runs` table columns for `files_reviewed_count` / `read_revisit_rate` (and
  a `file_review` view) for ad-hoc SQL. Omitted to match the `editRevisitRate`
  precedent — churn rates live only in `run-summary.json`, not in DuckDB.
- A "files reviewed" aggregate (median/mean across runs) in `OverviewData`.
- `filesReviewedCount` as a complexity signal / leaderboard dimension — would shift
  rankings; add only if a breadth-of-investigation quality signal is wanted.

---

# Changed-files rail moved to the LEFT — deferred follow-ups (2026-06-25)

Committed in `8548ce0`. The rail was relocated from the right side of the panel
to the left, so the collapsed sliver no longer collides with the transcript's
right-edge scrollbar (scroll-overshoot was accidentally opening the peek/pin).
Sliver + peek/pin behavior and visuals are unchanged, only mirrored. No
gating heuristics were added — left placement removes the collision
structurally (no scrollbar on the left; reading-rest never reaches the rail).

Deferred / out of scope (revisit if wanted):
- **Doc drift**: `docs/CHANGED-FILES-UI-PLAN.md` previously described the rail
  as "right-side" with a "left-edge handle" and "left-casting shadow".
  **RESOLVED 2026-06-25 maintenance pass**: corrected the 7 stale positional
  descriptors to match the left-side reality AND added a move-note under
  "Post-implementation revisions" referencing commit `8548ce0`. Also fixed the
  stale `left-edge handle` → `right-edge handle` header comment in
  `extension/src/webview/panel/styles/file-changes.css`.
- **Peek covering**: peek (overlay) now anchors `left:0` and covers the start
  of agent replies during a *deliberate* glance (~260px). Acceptable since
  left placement makes peeks deliberate-only, but if the covering cost
  matters, narrow the peek `--file-changes-drawer-width` (260→~190) or make
  peek in-flow (nudge) so it covers nothing. Pin is in-flow and unaffected.

LANDED in `eb7edc0` ("Make file path the open-in-editor hitbox"): the
`FileName` button↔span refactor (whole path is the click hitbox; row DOM
`<button class="file-change-name">` → `<button class="file-change-path-text">
<span class="file-change-name">`) was committed together with updates to the 3
`FileChangesPanel` tests. **Verified 2026-06-25**: all 3 tests pass green on
clean HEAD; no outstanding work here.

---

# Codebase-maintenance pass (2026-06-25)

Ran the `codebase-maintenance` skill (dead-code → smells → duplicates →
complexity → large-files → lint/test → gitignore → doc-drift). All green;
smells (semgrep) clean. Outcomes:

Done:
- **Dead code**: `tsc --noUnusedLocals` verified the skylos import findings in
  `extension/src/` + `extensions/subagent/src/` are false positives (src fully
  clean). Removed the one real dead import: `sum` in
  `analysis/site/charts/toolduration.ts`. (Test-file unused imports tolerated
  by convention — `no-unused-vars` off for `extension/test/**`.)
- **Lint debt**: 6 pre-existing `prefer-const` errors fixed via plain `const`
  reorder (see section above).
- **Duplicates**: extracted shared `loadModelsJsonProviders()` into
  `analysis/scripts/load-models.ts` (DRY for `model-family.ts` + `pricing.ts`,
  same package, behavior-preserving). Documented the cross-package
  `coercion-rollups.ts` ↔ `analysis/scripts/source.ts` duplication with
  "keep synchronized" headers (mirrors `backend/pricing.ts` pattern; extraction
  undesirable — would create a cross-package dep). Other dupes justified
  (test fixtures, documented structural dup).
- **Large files / complexity**: split `settings-menu-subcomponents.tsx`
  (996→535, UI-appearance block → new `ui-appearance-settings.tsx`) and
  `skill-pruner/src/pruning.ts` (553→246, prepass → new `prepass.ts`). All 10
  high-complexity functions are domain-appropriate dispatchers/validators
  (left as-is). Removed a stale "TEMP DIAGNOSTICS" console.log block in
  `composer/hooks.ts`.
- **Doc drift**: corrected `CHANGED-FILES-UI-PLAN.md` positional descriptors
  (see section above). Markdown-drift scan otherwise clean (only 2 README
  `npmjs.com` URLs return 403 — bot-blocking, verified not broken; left as-is).

New deferred follow-ups (from this pass):
- **`extension/src/host/sidebar/provider.ts` (677loc)** — soft multi-concern
  split. **DONE 2026-06-25** (commit `d49fbcf`-1): extracted `SidebarHotReloader`
  (`hot-reloader.ts`, 186loc) + `StateAppliedWatchdog` (`state-applied-watchdog.ts`,
  198loc) into siblings; provider.ts now 422loc as the orchestrator. Behavior-
  preserving; added `test/host/sidebar/state-applied-watchdog.test.ts` for the throttle
  window + ack-clearing logic.
- **`extensions/skill-pruner` has no `tsconfig.json`** → no standing typecheck
  gate; 2 genuine pre-existing type issues were undetected by CI. **DONE
  2026-06-25** (commit `57aa6ab`): added `tsconfig.json` (ESM/bundler config +
  ambient stubs for the `@mariozechner/pi-*` peer packages so the gate covers
  internal types without flagging pi-API drift) + `types-global.d.ts`; fixed
  the 2 issues (`llm-scorer.ts` filter type predicate, `logger.test.ts`
  stale PruningDecision fixtures); wired `extensions:typecheck` into the root
  `typecheck` chain. pi-API drift (pi-tui theme signature, AgentToolResult/
  CustomMessage) remains a separate follow-up.
- **`AlwaysKeepPicker` promotion** to `components/` **DONE 2026-06-25** (commit
  `d49fbcf`): co-located `filterKeepCatalog` (its only consumer) with the picker
  in `components/always-keep-picker.tsx` so the move needs no `components/ →
  composer/` back-dependency; barrel re-exports preserved.

---

# UX & Reliability Remediation — planned (2026-06-27)

Plan: `docs/UX_RELIABILITY_PLAN.md`. Wave-orchestrated briefs targeting the
`Failed to send message: Timed out waiting for response to req-NN` errors,
clunky edit/interrupt/multi-prompt UX, stale-state ("old + new message at
once"), pasted-image stickiness, pruning-prepass slowness, and general
fragility — judged against Nielsen's 10 usability heuristics. Status:
DONE — Rounds 1-4 complete (A, G, B, C, E, D, F, H ✅ reviewer-approved; A's edit-path rollback regression, B's send-timer-budget orphaned-reply risk, D's watchdog-resnapshot-vs-revision-guard, F's aborted-worker host-side, and H's req-NN leak in revertSetModel/handleError all caught in review and fixed). Actual rounds (re-scheduled from the plan's §1 diagram to honor its 'parallel only when file-disjoint' rule — A & B share client.ts/effect-runner.ts and B is post-A, so sequential):

| Brief | Issue | Wave | Bucket | Depends on |
|---|---|---|---|---|
| A ✅(R1) | Decouple `message.send` RPC from pruning prepass (root cause of req-NN timeout + image stick + prepass perception) | 1 | frontier | — |
| B ✅(R2) | Request timeout strategy & correlation hardening (de-dupe the 30s/60s racing timers; dropped-line diagnostics; cancel hook) | 1 | frontier | — |
| C ✅(R2) | Optimistic lifecycle for composer inputs (pasted-image stickiness) | 2 | medium | A |
| F ✅(R4) | Pruning prepass UX: live, cancelable status indicator + skip/bypass | 2 | medium | A, E |
| E ✅(R3) | Edit / interrupt UX clunkiness (instant interrupt, no truncate-flash; second send rejected with clear message, no queue) | 2 | medium | A, B |
| G ✅(R1) | Projection memoization & render-path perf (O(1) unchanged-delta projection) | 2 | medium | — |
| D ✅(R3) | Stale-state / "old + new message at once" (webview revision + length/identity guards made total; G-enabled debounce cut; watchdog **unchanged** — resnapshot already self-heals while streaming, force-reload suppression is a correct invariant) | 3 | frontier | G |
| H ✅(R4) | Error prevention, messaging & graceful degradation (no `req-NN` in UI; plain-language errors + recovery actions) | 3 | medium | A, B |

Execution (actual): Round 1 = A (frontier) ∥ G (medium) — disjoint files; Round 2 = B (frontier) ∥ C (medium) — B builds on A's early-ack; Round 3 = E (medium) ∥ D (frontier) — D builds on G; Round 4 = F (medium) ∥ H (medium). Each round: parallel worker(s) → orchestrator serial typecheck+test+build → `reviewer` gate. (Re-scheduled from the plan's §1 diagram, which drew A/B parallel and F in wave 2: A & B share `client.ts`/`effect-runner.ts` and B's timer design is explicitly post-A, and F depends on E — so the disjoint-file rule governs.) Preserve all `STATE_CONTRACT.md` invariants (§11 of the plan); any relaxation updates the contract in the same change.

## Grilling decisions (2026-06-27, `grill-with-docs` skill)
Decisions recorded inline in `STATE_CONTRACT.md` + `docs/UX_RELIABILITY_PLAN.md`;
terminology in `AGENTS.md`. Summary:

1. **Brief A post-ack prepass failure** — distinct `PreflightFailed` event (not a
   reused `SendResult{ok:false}`); rollback snapshot retained in a new
   `pending.promoted[corrId]` past the ack; **commit point = first streaming `Delta`**
   for the `requestId`, after which a failure is an in-turn error, not a rollback.
   (`STATE_CONTRACT.md` § Optimistic Reconciliation now has a "Two failure windows"
   subsection.)
2. **Brief E second send** — reject with a clear plain-language message; **no
   deferred-prompt queue** (the FIFO-queue acceptance criterion was an invented
   requirement). `Execution Ordering` unchanged.
3. **Brief B timers** — **phase-scoped, not "single timer"**: short `req-XX` owns
   pre-ack; one send-timer owns pre-ack-to-first-delta and dispatches
   `PreflightFailed` on timeout; both cleared by the commit-point event. The
   original "two racing timers" framing is mooted by Brief A's early ack.
   (`STATE_CONTRACT.md` § Optimistic Reconciliation "Timer ownership" bullet.)
4. **Brief D re-diagnosis** — the watchdog's `runningCount > 0` suppression is **a
   correct invariant, not the prime suspect**. The resnapshot path already self-heals
   while streaming; only the nuclear force-reload is suppressed, and that prevents
   the very "old + new at once" symptom. Brief D re-anchored on webview revision +
   length/identity guards (made total) + G-enabled debounce cut. Watchdog untouched.
   (`STATE_CONTRACT.md` § Snapshot Recovery new bullet.)
5. **Brief F live chip** — host-timer-driven (start at send dispatch; clear on
   earliest of {first `message.custom`, `PreflightFailed`, commit-point `Delta`});
   `message.custom` fires on completion, not start, so it cannot drive the chip.
   `prepassPhase`/`prepassStartedAt` live in host ViewState (webview stays passive).
6. **Terminology** — `prepass` (the pruning LLM call, user-facing) vs `preflight`
   (the SDK `before_agent_start` acceptance gate / `preflightResult` callback,
   host-internal; broader than just the prepass). Plan no longer uses them
   interchangeably. (`AGENTS.md` § Terminology → Chat / RPC lifecycle.)

## Cross-repo follow-up (out of this repo's scope)
- **SDK `preflightStarted` event** in `@earendil-works/pi-coding-agent` /
  `skill-pruner`. Today there is no SDK event at prepass start; the host infers it
  at send dispatch. A real `preflightStarted` event would replace the inferred
  start with a precise signal for Brief F's chip. **Refinement, not a blocker** —
  the host-timer chip ships first; consume the SDK event when it lands. Coordinated
  PR to the other repo; not executable by in-repo `worker` subagents.

## In-repo deferred follow-ups (Brief F/H, non-blocking)
- **Brief H — NoticeBanner recovery action buttons not wired.** **DONE.** The
  buttons are now wired (`app-body.tsx` passes `kind={viewState.noticeKind}` +
  `onAction`→`handleNoticeAction`; a `sendRetryDraftRef` bridges the AppBody-level
  notice to the composer's live draft via `sendAsRetry`). Retry re-sends the LIVE
  draft as a `retrySend`; Retry+Restart dismiss, Show-logs/Open-settings do not.
  Covered by 5 app-smoke Brief H tests. (commit `2683402`)
- **Brief H — `retrySend` with `disablePruning` leaves pruning permanently off.**
  **DONE.** `onRetrySend` captures the prior mode (only when not already `off` —
  a chained-retry guard) before disabling; it rides on the Send command →
  SendRpcEffect → InFlightSend, and the EffectRunner restores it at commit/fire/
  pre-ack-failure (exactly once). Threaded through both send queues + the
  backend-ready-watchdog DROP path. Covered by 4 effect-runner + 2 reducer tests.
  Narrow known limitation: a concurrent retry whose commit fires mid a 2nd retry's
  prepass may re-enable pruning for that prepass (the original mode is restored
  correctly). (commit `2683402`)
- **Brief H — `PREPASS_TIMEOUT_PATTERN` won't match decimal-second budgets.**
  **DONE.** `(\d+)` → `(\d+(?:\.\d+)?)`; covered by `error-mapping.test.ts`.
  (commit `140fb5d`)
- **Brief H — `onShowLogs` creates a fresh empty `pie` OutputChannel** (boot
  logs go to `console.warn`, not the channel). **Still open** (low priority,
  dormant until exercised — the button now renders, but the channel is empty).
  Either route boot logs to the channel or point `showLogs` at the existing log
  surface.
- **Brief F — host-side prepass transition tests.** **DONE.** `running→succeeded`
  (pruning-result CustomMessage) + `running→idle` (commit-point MessageStarted)
  transition tests added to `arch-reducer.test.ts`, asserting the projected
  `prepassPhase`/`startedAt`/`latencyMs` each step. (commit `792cd9d`)
- **Brief D — `resnapshot bumps revision` lock-in test + missed-ack-while-streaming
  end-to-end test.** `resnapshot bumps revision` lock-in **DONE**
  (`sidebar-sync.test.ts` — a resnapshot produces a strictly-higher revision +
  buildStateEnvelope mints strictly-increasing revisions). The
  missed-ack-while-streaming end-to-end is **documented as a §12 manual smoke-test
  item** (`docs/UX_RELIABILITY_SMOKE_TEST.md` scenario 6) — a full
  streaming-wedge harness is too heavy; the mechanism is code-read-verified +
  covered by the revision-discard unit test. (commit `792cd9d`)

## §12 manual smoke-test matrix
- `docs/UX_RELIABILITY_SMOKE_TEST.md` is the human-executable checklist for the
  scenarios that need a real backend / wedged transport (slow prepass, wedged
  webview, forced stderr, + paste-image/edit/interrupt/second-send). The
  automatable scenarios (interrupt one-frame feedback, NoticeBanner buttons,
  revision-discard, paste-image clear/restore) are covered by `app-smoke.test.ts`.
