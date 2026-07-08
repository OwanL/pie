# Host Service / State Layer Review

Scope: `extension/src/host/{session-service,stats-service,run-analytics,sidebar,backend,shared,webview,util}`, `extension-host.ts`, `token-rate-service.ts`. Reviewer stance: skeptical senior engineer. Read-only recon; no fixes proposed.

## Amendments (post-review)

> Findings below were captured at a point in time. The following have since been
> resolved and the original text is kept for history:

- **Finding #4 (parseCheckpoint / readOptionalText duplication)** — Resolved.
  The duplicated I/O helpers were consolidated into `shared/checkpoint-io.ts`
  (`parseCheckpoint`, `readOptionalText`, `parsePersistedSessionRunState`) and
  `run-analytics/coercion-utils.ts` (`isObjectRecord`). `stats-service/helpers.ts`
  and `run-analytics/query.ts` no longer define their own `parseCheckpoint` /
  `readOptionalText`; both import from `shared/checkpoint-io.ts`.
- **Finding #13 (schema versioning is exact-match-or-drop with no migration)** —
  Resolved. A versioned migration registry now exists at
  `shared/checkpoint-migrations.ts` (`CHECKPOINT_MIGRATIONS` + `migrateCheckpoint`
  walker with contiguity checks). `parseCheckpoint` (`shared/checkpoint-io.ts`)
  walks the registry for older files and **drops + warns** (via `appendPieLog`)
  on a missing step, a throwing `up`, or a newer-than-code file — no longer
  silent. The registry is empty only because v1 is the first schema version;
  the next bump appends a `1 → 2` entry per the documented append-only rules.

> Note: line counts in "## Files reviewed" and inline `:NNN` references are
> frozen at review time and may have drifted; trust the file paths, not the
> numbers.

## Files reviewed

| Path | Lines |
|---|---|
| `extension/src/host/stats-service/tracker.ts` | 576 |
| `extension/src/host/stats-service/storage.ts` | 387 |
| `extension/src/host/stats-service/run-state-manager.ts` | 321 |
| `extension/src/host/stats-service/service.ts` | 186 |
| `extension/src/host/stats-service/helpers.ts` | 153 |
| `extension/src/host/stats-service/types.ts` | 94 |
| `extension/src/host/stats-service/persistence.ts` | 56 |
| `extension/src/host/stats-service/index.ts` | 8 |
| `extension/src/host/run-analytics/coercion-rollups.ts` | 499 |
| `extension/src/host/run-analytics/types.ts` | 293 |
| `extension/src/host/run-analytics/coercion-snapshots.ts` | 263 |
| `extension/src/host/run-analytics/query.ts` | 187 |
| `extension/src/host/run-analytics/coercion-factors.ts` | 110 |
| `extension/src/host/run-analytics/storage.ts` | 94 |
| `extension/src/host/run-analytics/coercion-functional-settings.ts` | 53 |
| `extension/src/host/run-analytics/coercion-utils.ts` | 46 |
| `extension/src/host/run-analytics/coercion.ts` | 13 |
| `extension/src/host/run-analytics/index.ts` | 2 |
| `extension/src/host/session-service/state.ts` | 445 |
| `extension/src/host/session-service/startup.ts` | 349 |
| `extension/src/host/session-service/service.ts` | 253 |
| `extension/src/host/session-service/tab-actions.ts` | 281 |
| `extension/src/host/session-service/message-actions.ts` | 266 |
| `extension/src/host/session-service/events.ts` | 169 |
| `extension/src/host/session-service/pruning-settings.ts` | 186 |
| `extension/src/host/session-service/pruning-settings-persistence.ts` | 82 |
| `extension/src/host/session-service/backend-ready.ts` | 30 |
| `extension/src/host/session-service/types.ts` | 16 |
| `extension/src/host/session-service/index.ts` | 1 |
| `extension/src/host/session-service/handlers/attach.ts` | 312 |
| `extension/src/host/session-service/handlers/tools.ts` | 183 |
| `extension/src/host/session-service/handlers/session.ts` | 143 |
| `extension/src/host/session-service/handlers/streaming.ts` | 159 |
| `extension/src/host/sidebar/provider.ts` | 422 |
| `extension/src/host/sidebar/sync.ts` | 105 |
| `extension/src/host/sidebar/hot-reloader.ts` | 186 |
| `extension/src/host/sidebar/state-applied-watchdog.ts` | 198 |
| `extension/src/host/sidebar/completion-notification.ts` | 100 |
| `extension/src/host/backend/client.ts` | 275 |
| `extension/src/host/extension-host.ts` | 508 |
| `extension/src/host/shared/checkpoint-slots.ts` | 56 |
| `extension/src/host/webview/assets.ts` | 92 |
| `extension/src/host/webview/hot-reload.ts` | 38 |
| `extension/src/host/util/stream-telemetry.ts` | 158 |
| `extension/src/host/util/audit.ts` | 107 |
| `extension/src/host/util/error-message.ts` | 13 |
| `extension/src/host/token-rate-service.ts` | 171 |
| `docs/STATE_CONTRACT.md` | (contract reference) |

## Notable issues

### Critical

1. **Analytics persistence errors are silently swallowed** — `stats-service/storage.ts:94-122`, `:125`. `schedulePersist` chains `.catch(() => undefined)` ahead of the write `.then`, so any failure in `fs.mkdir`/`appendFile`/`writeCheckpoint`/`writeAutoExportSafely` inside the queue is dropped before it can surface. `seq` is still incremented (`++this.seq` at :95) regardless of outcome, so the checkpoint sequence advances past never-written snapshots. `flush()` re-swallows (`:125`), and every tracker handler (`tracker.ts:101–562`) calls `this.runState.persist()` synchronously and returns `void` — no tracker method ever propagates a write failure. A disk-full / permission / quota error on the analytics store is permanently invisible: no telemetry, no notice, no retry, corrupted monotonicity. This is the single largest error-handling gap in the layer.

2. **Checkpoint write is non-atomic with no rollback** — `stats-service/persistence.ts:38-48` `writeCheckpointToDisk`. Two sequential `await fs.writeFile` (slot JSON, then `open-runs.gen` pointer) with no try/catch. If the slot write succeeds and the gen-marker write fails, you get a fresh slot file with no pointer; `resolveCheckpointSlot` (`shared/checkpoint-slots.ts`) recovers via higher-`seq` fallback, so it's *recoverable*, but there is no rollback of the orphaned slot and no temp+rename. Combined with issue #1, a failure here is also silently dropped.

3. **Backend RPC payloads are unvalidated at the stdio boundary** — `backend/client.ts:230` `JSON.parse(line)`, `:144` `event.payload as BackendReadyPayload`, `:114`-area ready handling. `isResponseEnvelope`/`isEventEnvelope` are type guards on envelope shape only; the `payload` is cast unchecked. Malformed-but-JSON envelopes with a valid `type`/`event`/`id` field pass arbitrary payload shapes straight into event handlers (`session-service/handlers/attach.ts:287` `backend.onEvent((event: any) => void)`; `:284` `handleBackendEvent: (event: any) => void`). The backend is a trusted local process so practical risk is bounded, but the whole event-handler chain (`session-service/events.ts`, `handlers/*`) trusts TS types across an `any`-typed boundary — a backend bug or version skew silently produces wrong-shaped data reaching the reducer.

### High

4. **stats-service vs run-analytics are complementary, not redundant — but share real duplication**. They are two halves of one pipeline operating on the *same* persisted artifacts (`run-snapshots.jsonl`, `outcome-history.jsonl`, `open-runs.{a,b,gen}`) and the *same* schema (`RunSnapshot` et al. defined once in `run-analytics/types.ts:131-196`, `RUN_ANALYTICS_SCHEMA_VERSION = 1` at top of that file). `run-analytics` is the **read side** (defensive deserialization in `coercion-*` + query/export in `query.ts`) and the schema owner; `stats-service` is the **write side** (live state machine in `tracker.ts`/`run-state-manager.ts` + persistence orchestration in `storage.ts`/`persistence.ts`/`helpers.ts`). Dependency is strictly one-directional (`stats-service` imports from `run-analytics`; the reverse does not happen — no circular deps). So **not redundant**. However, there is concrete cross-half duplication that will drift:
   - `parseCheckpoint` exists twice: `stats-service/helpers.ts:79-122` and `run-analytics/query.ts:48-79` (near-identical, the query version uses an extra `parsePersistedSessionRunState`).
   - `readCheckpoint` exists twice: `stats-service/persistence.ts:23-43` (returns `{checkpoint, activeSlot}`) and `run-analytics/query.ts:82-95` (checkpoint only). Same 3 files, same `resolveCheckpointSlot`.
   - `readOptionalText` is copied **three times**: `stats-service/storage.ts:251-260`, `stats-service/persistence.ts:10-19`, `run-analytics/query.ts:18-27`.
   - `isObjectRecord` duplicated: `run-analytics/coercion-utils.ts:3` and inline at `run-analytics/query.ts:32-34`.
   Maintenance hazard: a fix to one `parseCheckpoint`/`readOptionalText` will not propagate. Worth consolidating into a small `run-analytics/io` shared module that both halves import.

5. **`SessionRunTracker` (576) is a god class** — `stats-service/tracker.ts`. ~20 distinct `on*` event handlers (prepareForSend, turn start/ended, tool started/finished, interrupted, messageEdited, truncatedAfter, backendError, contextUsage, busyChanged, modelConfig, analyticsFactors, unsupportedInput, sessionClosed, replaceSessionPath, recordOutcome, startNewTask/continueTask, experimentAssignment, finalizeOpenRunsForShutdown), each mutating `RunSnapshot` fields directly and calling `this.runState.persist()`. It also owns the global `busySessionPaths` set. No single huge method, but it's a flat event→mutation switchboard with no internal decomposition. Natural splits: tool-usage rollups, turn/throughput, treatment/config, lifecycle. Flag for decomposition.

6. **`RunAnalyticsStorage` (387) mixes four concerns** — `stats-service/storage.ts`: (a) persi
stence queue (`schedulePersist`/`flush`, :94-125), (b) checkpoint read/write, (c) **legacy migration** (`migrateLegacyStorage` + `mergeJsonlLogFiles` + `mergeCheckpointStates` + `mergeJsonlMergeCandidate` + `mergeCheckpointSessionState` + `getSessionStateRecencyKey`, ~:100-245 — roughly a third of the file), (d) auto-export (`writeAutoExportSafely`, :375-381). Migration is a distinct lifecycle concern that should be its own module. Also note `migrateLegacyStorage` rethrows non-`ENOENT` errors (`:168-171`) from inside `start()` with no cleanup of a half-copied legacy tree, so a partial `fs.cp` failure aborts startup with the merge unfinished.

7. **`buildRunSnapshot` casts `candidate as RunSnapshot` after a partial predicate** — `run-analytics/coercion-snapshots.ts:164-177`. `const c = candidate as RunSnapshot;` then reads `c.sessionPath`, `c.sendCount`, … directly. Correctness rests entirely on `isValidRunSnapshotCandidate` (above it) having validated every field. Any field added to `RunSnapshot` (`run-analytics/types.ts`) without a matching `validateX` predicate becomes **silently unvalidated on read**. Related: `:177` `c.thinkingLevel as ThinkingLevel | undefined` coerces to the union after only `validateOptionalStrings` (string|undefined) — any arbitrary string passes; mismatches `createRunSnapshot`'s source-of-truth enum. Same cast-then-`.includes()` pattern for `TreatmentChangeKind`/`ToolFailureKind`/`ToolResultIssueKind` in `coercion-rollups.ts:105,160,266,306` — each guarded by a string-array constant, but there is no single source-of-truth link between the union type and the runtime constant array, so widening the union without the array = silent acceptance of invalid values. This is the central "validation predicate must stay in sync with the type" hazard across the whole coercion layer.

8. **`webviewReady` is set on ANY inbound message, not just the `ready` handshake** — `sidebar/provider.ts:147-159`. The `if (!this.webviewReady)` block at `:151` runs after the `stateApplied` branch (`:145`). A stray/stale `stateApplied` (or any message type) flips the bridge ready and calls `watchdog.resetResnapshotFlag()`. STATE_CONTRACT designates the webview `ready` message as the bridge-ready signal, but the code conflates "received a message" with "webview is initialized." Mostly theoretical post-hot-reload (old context is destroyed) but a real contract deviation worth a guard.

9. **Watchdog can go permanently dormant with `resnapshotAttempted` latched true** — `sidebar/state-applied-watchdog.ts:107-167`. First-timeout takes the resnapshot branch (`:118-123`), sets `resnapshotAttempted = true`, and `return`s without re-arming the timer. Recovery relies on `onResnapshot` → provider `flushDirtyState()` posting a new snapshot → `postToWebview` re-arming (`provider.ts:69-74`). The `runningCount > 0` suppression at `:157-167` logs and `return`s **without calling `clear()`**, so `pendingStateAppliedRevision` stays set while the timer is already `undefined` (`:97`) — the watchdog is dormant mid-stream and only re-arms when a *new* state post happens. **Edge case**: after a streaming burst subsides with no further state change to flush, the watchdog stays dormant with `pendingStateAppliedRevision` set and `resnapshotAttempted = true`. A quiet-but-alive webview never gets a recovery reload because nothing re-arms the timer; the next state change that does re-arm will skip straight to the reload branch (resnapshot already attempted) — so a webview that merely went briefly quiet during a burst can be force-reloaded on the next trivial state change even though it was healthy. `resnapshotAttempted` is only reset by `recordStateApplied` ack (`:36-42`) or `resetResnapshotFlag` on bridge-ready (`provider.ts:152`); `dispose()` (`:170-176`) clears the timer but does not reset the flag.

10. **`postToWebview` arms the watchdog in an async `.then` racing with synchronous revision advance** — `sidebar/provider.ts` (postState advances `globalRevision`/`globalDirty` synchronously around `:245-256`; `postToWebview` posts then `armStateAppliedWatchdog` in the `.then` near `:395-397`). `armStateAppliedWatchdog` overwrites `pendingStateAppliedRevision` unconditionally (`watchdog.ts:64`). If two posts overlap, a slow `.then` from the older post can overwrite the newer pending revision with the older one. `recordStateApplied` uses `>=` so an ack would still clear correctly, but the timeout would then fire against the wrong (older) revision. Likely benign because `postMessage` `.then` resolution order matches post order, but the structure is fragile — the watchdog should be armed synchronously at post time, not in the delivery callback.

11. **`dispose()` does not clear `syncState` or null `view`; late async callbacks still mutate disposed state** — `sidebar/provider.ts:97-103`. `dispose()` clears `scheduleTimer` only. After dispose, `view` retains the dead `WebviewView`; in-flight `postToWebview` `.then(delivered)` callbacks (`:385-397`) still run `reconcilePostedMessageDelivery` and `armStateAppliedWatchdog`, mutating `syncState` and calling into the disposed watchdog. `view.webview.postMessage` on a disposed view is wrapped but the reconcile/arm side effects are not. Low severity (teardown) but unguarded.

12. **Backend client has no reconnect/backoff** — `backend/client.ts:62-71` on exit: sets `proc = undefined`, `rejectAll`, fires `onExit`, but no automatic re-spawn. Reconnection is entirely the caller's responsibility. Dispose/start race: `dispose()` (`:189-196`) kills proc and `rejectAll`s in-flight requests but the `start()` ready promise still has `proc.once('error', errorListener)` armed (`:121`) with `errorDisposable` only disposed on settle; if `dispose()` runs before `backend.ready` arrives, the ready promise never settles and a caller awaiting `start()` hangs until `READY_TIMEOUT_MS` (`:127`). No documented recovery path for a caller stuck awaiting a disposed-then-restarted client.

13. **Schema versioning is exact-match-or-drop with no migration** — `stats-service/helpers.ts:79-122` and `run-analytics/query.ts:48-79` `parseCheckpoint` return `null` when `schemaVersion !== RUN_ANALYTICS_SCHEMA_VERSION` (currently `1`). Any future schema bump silently drops the entire checkpoint / every legacy JSONL line is filtered out. There is a *legacy-format* migration (`storage.ts:migrateLegacyStorage`) but no *versioned* migration path — once `RUN_ANALYTICS_SCHEMA_VERSION` becomes `2`, all existing user data is discarded. Corrupt JSONL lines are silently skipped in `run-analytics/query.ts:55` (`readJsonlObjects` try/catch returning `null` then `.filter(value !== null)`) with no logging.

14. **Type unsafety: `any`-typed backend event stream, unvalidated storage reads, empty-record casts** —
    - `session-service/handlers/attach.ts:284,287` `handleBackendEvent: (event: any)` / `backend.onEvent((event: any) => void)`. The discriminated-union dispatch lives downstream but the boundary is `any`.
    - `session-service/handlers/streaming.ts:90` `archState.sessions.sessions.find((s: any) => s.path === sessionPath)` — explicit `any` on a `SessionSummary`; a shape mismatch silently yields `undefined` modelId rather than a type error.
    - `session-service/startup.ts:42` `globalState.get<Partial<ChatPrefs>>(...)` and `session-service/service.ts:248` `globalState.get<PruningSettings>(PRUNING_STORAGE_KEY)` are typed but **unvalidated at runtime**; a corrupted/truncated globalState payload flows straight into a Command dispatch (SetPrefs / PruningSettingsChanged) and is treated as authoritative, bypassing the on-disk validation in `pruning-settings.ts`.
    - `stats-service/tracker.ts:225,245` `{} as Record<ToolFailureKind, number>` / `{} as Record<ToolResultIssueKind, number>` — empty object cast to a full record keyed by a union; in practice it's a `Partial<Record<...>>` populated lazily by `incrementNamedCount`. The type lies about completeness.

### Medium

15. **Fire-and-forget persistence in `setPrefs` with swallowed backend error** — `session-service/service.ts:213-218`. `void this.context.globalState.update(PREFS_STORAGE_KEY, merged)` (no `.catch`), then `void this.backend.request('runtimePrefs.set', {...}).catch(() => { /* Non-fatal */ })`. `setPrefs` reads like a pure merge+resolve (the NOTE at :205-212 is explicitly about recursion, not side effects) but writes to globalState *and* fires a backend RPC. A globalState write failure is unobservable; the backend rejection is intentionally silent. Same fire-and-forget pattern: `startup.ts:99-107` `persistIfTabStateChanged` does `void globalState.update(...)` four times with no `.catch`; `:139` `void globalState.update(SDK_PATH_CACHE_KEY, sdkPath)`.

16. **`loadPersistedPruningSettings` writes to globalState inside what looks like a read** — `session-service/pruning-settings-persistence.ts:44-53`. "Load" reads the on-disk file **and** `await storage.update(settings)` to mirror file→globalState. A read with a write side effect violates a read-only mental model. Similarly `pruning-settings.ts:140-157` `writePruningSettings` reads + writes + re-reads (another `fs.readFile` + `JSON.parse` round trip) and returns the re-validated value.

17. **`hydrateModelState` has no epoch/op-queue guard** — `session-service/message-actions.ts:~80-110` (`Promise.all([settings.get, models.list])` dispatching `SetModel` + `AvailableModelsChanged`). Two concurrent `hydrateModelState` calls for the same path (rapid open) can interleave: `SetModel` from A, `AvailableModelsChanged` from B — final model selection nondeterministic. Not routed through `enqueueSessionOperation`. The `catch (err)` only `auditLog`s (silent to user) — UI silently lacks a model list on failure.

18. **`closeSession` host-side cleanup runs outside the per-session op queue** — `session-service/tab-actions.ts:155-180`. `clearSelectionRequestsForPath` and `clearSessionScope` run synchronously while a concurrent `enqueueSessionOperation` task (e.g. `message-actions.ts:loadTranscriptPage`) for the same path may still be in flight. Mitigated because in-flight handlers re-check `getSessionDataEpoch !== requestEpoch` and `clearSessionScope` deletes the epoch entry (`state.ts:323`) so the comparison becomes `0 !== requestEpoch` and aborts — but this safety relies on the epoch reset being a deliberate kill signal and is undocumented. `closeSession` then does `void this.openSession(nextPath)` (`:173`), fire-and-forget; the returned promise is dropped so an open failure is invisible to the close caller.

19. **`onError` with empty-string `sessionPath` sentinel** — `session-service/handlers/session.ts:25-27` (the `onError` handler). When no session path is resolved, it dispatches `Error` with `sessionPath: ''` rather than skipping; downstream consumers must handle the empty string as "global." Implicit sentinel instead of a discriminated path-or-global error. Also note `:135-140` an inline `auditLog` is redefined shadowing the imported one ("just use console for now") — dead/confusing path.

20. **`token-rate-service.ts` interval not `unref`'d; `tick()` has no try/catch** — `token-rate-service.ts:30-33` `start()` uses `setInterval(...)` without `.unref()` (contrast `util/stream-telemetry.ts:48` `timer.unref?.()`). Inconsistent with the documented pattern elsewhere; benign in a long-lived host but flag. `tick()` has no try/catch, so an exception in `tickTokenRate`/`computeIdleDisplayState` propagates into the `setInterval` callback and is swallowed by the event loop (Node logs uncaught), leaving `activeChanged` not surfaced. `dispose()` (`:35-39`) clears the interval but leaves the three maps populated — instance leak if recreated.

21. **Sync `globalRevision` advances on never-delivered snapshots** — `sidebar/sync.ts:44-52` (`postState` increments `globalRevision` and clears `globalDirty` synchronously *before* delivery is known) + `reconcilePostedMessageDelivery` (`:97-101`) re-marks dirty on failure. STATE_CONTRACT ("Snapshot Recovery") says revisions advance on each full snapshot; a never-delivered envelope still consumes a revision. Monotonicity is preserved and the invariant holds, but the contract wording and the code diverge on what "advances" means.

22. **`util/audit.ts` trace writes bypass the dev-only `auditLog` gate** — `audit.ts:44-49` `auditLog` is gated by `extensionMode === 1` (dev). But `:54-72` `bootLog`/`bootTraceSync` are gated only by `bootTraceEnabled` (`PI_BOOT_LOG=1`), not `extensionMode`. So in a packaged build with `PI_BOOT_LOG=1`, boot traces write but audit logs do not — inconsistent gating. `assertInvariant` (`:64-83`) throws only when `isEnabled(context)`; in production, invariant violations are logged but silently swallowed — so the watchdog/sync invariants (`provider.ts` postState assert) don't fail-fast in prod. `audit.ts:18-26` `appendBootTraceSync` does **synchronous** `mkdirSync` + `appendFileSync` on hot paths (`provider.ts` postState/flushDirtyState/scheduleState, watchdog timeouts) — blocks the extension host during streaming bursts when enabled (off by default).

23. **`util/stream-telemetry.ts` flush blocks the event loop** — `stream-telemetry.ts:81-87` `flush()` uses synchronous `fsSync.mkdirSync` + `fsSync.appendFileSync` on the extension host thread every active second during streaming bursts. Gated behind `PI_DIAG === '1'` (off in prod) so acceptable, but worth a note. On disable, in-flight `current` window data is discarded without flush (minor data loss for diagnostics).

### Low

24. **`coercion-rollups.ts` (499) large but intrinsic** — defensive deserialization of `ToolUsageRollup` plus legacy failure-kind split semantics. Not obviously splittable without losing locality; lower priority than tracker/storage decomposition.

25. **`session-service/state.ts` (445) is large but cohesive** — it is a runtime *side-table* (selection requests + timers, data epochs, op queues, preload set, suppression set, transcript-LRU, busy-seq guard), *not* the ArchState owner. No persistence, no derivation. Could split selection-request management into its own class but not urgent. The reducer-purity contract (`docs/STATE_CONTRACT.md` "Reducer Purity") is honored: random/time generation lives in the action layer (`tab-actions.ts:62` `createNewSession` uses `Math.random()`+`Date.now()`+`crypto.randomUUID()` *before* dispatching a Command carrying the id — the reducer itself stays pure).

26. **`run-analytics/storage.ts` is misnamed** — 94 lines of pure path/workspace-id key utilities (`getDataOutcomesRootPath`, `buildWorkspaceAnalyticsId`), no actual storage. The real storage lives in `stats-service/storage.ts`. Confusing naming given there's a `stats-service/persistence.ts` too.

## Smaller nits

- `sidebar/provider.ts:147` `const payload = msg.payload as any;` for the `stateApplied` branch — unchecked cast; `payload.renderError` read unvalidated. Define a typed `StateAppliedPayload`.
- `session-service/handlers/streaming.ts:90` `(s: any)` — use `SessionSummary`.
- `stats-service/tracker.ts:225,245` `{} as Record<...Kind, number>` — type as `Partial<Record<...>>` or pre-fill zero counts.
- `run-analytics/query.ts:184-185` `exportRunAnalyticsStore` writes non-atomically (no temp+rename); a crash mid-write leaves a truncated `targetPath`.
- `session-service/startup.ts:188-191` `sendRuntimePrefsWithLogging` `catch {}` swallows; unlike `startBackendWithLogging` (`:165`) which dispatches a `NoticeShown`, the runtime-prefs failure surfaces nothing to the user. `startup.ts:222-229` `listAndOpenFirstSession` catch only `bootLog`s.
- `backend/client.ts:160-167` comment acknowledges stray log lines cause "random hangs"; only parse failures are surfaced, not payload-shape failures.
- `sidebar/state-applied-watchdog.ts:170-176` `dispose()` clears timer but does not reset `resnapshotAttempted` or `pendingStateAppliedRevision` — if the watchdog instance is reused/restarted (it isn't currently, but) it would start in an inconsistent state.
- `token-rate-service.ts` maps (`accum
`, `runIdsBySession`, `statesBySession`) are not cleared on `dispose()`; pruning at `:99-118` only drops entries for sessions no longer in `openTabPaths`.
- `stats-service/persistence.ts:18` / `storage.ts:245` / `run-analytics/query.ts:35` cast caught errors `as NodeJS.ErrnoException` before `.code` access — unchecked cast; a thrown non-ErrnoException yields `.code === undefined` which falls through to rethrow (safe) but the cast is unverified.

## Findings (architecture summary)

- **stats-service vs run-analytics**: complementary halves of one analytics pipeline sharing one schema (`run-analytics/types.ts`) and one set of artifacts. stats-service = write side (live state machine + persistence orchestration); run-analytics = read side (defensive deserialization + query/export). Not redundant; one-directional dependency, no cycles. The real problem is *internal* duplication (parseCheckpoint/readCheckpoint/readOptionalText/isObjectRecord copied across the halves) that will drift — consolidate into a shared io module.
- **session-service vs sidebar sync**: architecture is sound against the classic mutate-without-emit hazard — session-service holds no ArchState; every state change goes through `dispatchArchEvent` → `extension-host.ts:189` synchronous reducer → effects → debounced `scheduleRender` → sidebar snapshot post (`provider.ts`). "Mutate-then-emit" cannot happen at the service layer. The service's own maps (state.ts) are the race surface; `enqueueSessionOperation` serializes per-session work, but `closeSession` and `hydrateModelState` bypass the queue. Host-side watchdog handling of stale acks is sound (uses `>=` / `Math.max`); the fragile spot is the async `.then`-based watchdog arming and the `resnapshotAttempted` latch that can leave the watchdog dormant.
- **Backend boundary**: the largest type-safety gap is the `any`-typed event stream and unvalidated `JSON.parse` at the stdio boundary — a version-skewed backend silently feeds wrong-shaped data to the reducer.
- **Persistence**: schema versioning is exact-match-or-drop with no versioned migration path; checkpoint writes are non-atomic (no temp+rename, no rollback of orphaned slots); analytics write errors are swallowed by the persistence queue's `.catch(() => undefined)`. These three together mean a future schema bump or a persistent disk failure can silently lose all user analytics with no signal.
