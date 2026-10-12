# State Contract Implementation Notes

Non-normative mechanics behind [STATE_CONTRACT.md](../contracts/STATE_CONTRACT.md): transport/protocol internals, byte budgets, thresholds, and file mappings. Tests must not pin this file; pin the normative contract instead.

Sections explain the corresponding contract areas.

## Session Selection — catalog and storage authority

The host resolves the configured agent/session authority and forwards it through `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`; without configuration, the embedded SDK retains its defaults. With a canonical session root configured, listing uses that root and its per-cwd subdirectories rather than continually scanning retired roots. The npm doctor session check detects legacy session files without a canonical counterpart; separately, installer migration receipts register displaced outcomes roots so `npm run doctor` can report durable outcome files written or changed there since their migration scan. Explicit resume/recovery does not migrate files.

The catalog uses a rebuildable SQLite metadata sidecar beside the session authority. Append checkpoints and bounded head/tail witnesses avoid rereading unchanged transcript prefixes. These witnesses are not full-prefix hashes: an interior rewrite followed by append triggers a full reparse only if a sampled boundary changes. Before publishing an existing catalog snapshot, a filename-only scan removes deleted rows; changed files reconcile in bounded background batches. An inaccessible root preserves the last complete catalog, while an unavailable sidecar falls back to SDK discovery. Transcript JSONL remains authoritative.

## Execution Ordering — delivered startup verification

- Runtime acquisition holds the canonical directory lock while fully verifying the selected output and creating its lease. It stops at the first valid generation, still verifying older candidates if the newest is damaged. It does not scan an unused prior runtime or perform retention cleanup before application activation. Publication and lease release retain their full current/prior verification and conservative leased-generation protection; no background cleanup or persistent trust cache is introduced.

## Execution Ordering — cold browsing and worker lifecycle

- The persistent cold browse helper handles exact-v3 projection misses with a bounded in-memory cache, not a disk transcript cache. It and the coordinator independently recheck generation, ownership, and file fingerprints before publication. Legacy-format migration, mutations, and helper failures retain the coordinator's SDK path. Oversized durable-detail fallback can still reopen a transcript on the coordinator event loop; helper isolation is not a guarantee that every read is off-thread.
- SDK create/open patch validation accepts only known pristine fingerprints or exactly reversible supported transforms. Create durably publishes its header before returning the manager retained for worker handoff; open reuses parsed entries rather than rereading the same JSONL. The coordinator owns patching; helpers only validate its identity.
- Restored-session preloads use one background slot and yield to foreground lifecycle work or generation. Cancellation fences publication and stops the local wait, but there is no JSON-RPC request-cancellation frame. The occupied slot remains reserved until the backend response or shutdown, preventing a cancelled preload from silently overlapping its replacement.
- Startup worker synchronization is a readiness fence. Live settings/catalog/auth/policy acknowledgement timeouts are nonfatal: retry the latest revision with bounded backoff rather than infer worker death. Same-revision retries must carry the same payload fingerprint and join or replay the original apply. Definite protocol/transport failure remains fatal.
- Worker bootstrap uses the shared **120-second initialization budget** from `harness/agent-processes/lib/rpc/runtime-initialization-timeout.ts`, also re-exported for backend startup and cold-send acknowledgement. It includes independent SDK artifact verification before `ready`; it is not the short hot-send acknowledgement or heartbeat budget. A genuine expiry still fails startup and confirms owned teardown before a fresh retry. Verification coverage and pre-dispatch prompt ownership are unchanged; no prompt is automatically replayed.

- A claimed definitive `SESSION_WORKER_EXITED` incident clears only the addressed runtime-readiness timeout hint, not snapshot knowledge. A nonstale authoritative `runtimeReady:false` attach does the same; incident deduplication prevents a repeated old exit from clearing replacement readiness. A later send/continue uses the initialization budget, while unrelated hot sessions retain their short acknowledgement budget.
- Operation-status `SESSION_NOT_FOUND` is reconciliation-unavailable, not proof of generation death: promotion may still finish and acknowledge the original send. Only a structured `SESSION_GENERATION_ENDED` code authorizes generation-ended rollback; diagnostic text does not. Ambiguous sends retain their prompt, block another submit, and never replay automatically.

## Backend Failure Recovery — transport budgets

- Backend JSONL records share a **32 MiB** byte limit. An overlong correlated stdout response is replaced before writing with a `RESPONSE_TOO_LARGE` error carrying the same request ID, so the stream stays synchronized and the backend stays available; an overlong stdout event remains a fatal transport fault. Overlong stdin records are discarded through LF; when the bounded preview contains a request ID, the backend returns a correlated `REQUEST_TOO_LARGE` response and subsequent requests remain readable.
- Session snapshot producers use a stricter **30 MiB** budget and measure the complete final serialized event/response envelope, including LF, before writer enqueue. If metadata plus one required durable row cannot fit losslessly, transcript-page RPCs fail with typed `SESSION_SNAPSHOT_TOO_LARGE` rather than relying on writer overflow replacement or fatal event handling.
- A `session.opened` producer that cannot fit its snapshot emits a bounded `snapshotUnavailable` snapshot: it first retains all ordinary metadata and drops only transcript/checkpoint bytes, with a final metadata-independent identity/lifecycle fallback if metadata itself exceeds the bound. That fallback never retains user session names, model catalogs, model settings, prompts, reviews, or usage; its required summary fields use fixed placeholders/caps, and path/session identity, lifecycle, selection, and live-recovery strings have fixed UTF-8 bounds, guaranteeing the complete event envelope remains below the producer budget.

- Private worker IPC validates JSON types and a maximum nesting depth of **64**, with no JSON-value-count cap. Existing frame byte limits bound payload size.
- Private worker IPC coalesces only explicitly tagged unsolicited hot, rich `session.opened` refreshes queued for the exact same worker/lease/session identity. The newest whole snapshot moves to the lifecycle tail before sequence assignment; intervening required events retain FIFO order. Initial hydration, selection/operation-correlated publications, replacements, unavailable/skipped snapshots, and active writes are never replaced. Transactional admission retains the old refresh on rejection; frame caps, queue reservations, and fatal handling for other saturation remain unchanged.

## Snapshot Recovery — protocol versions, build identity, and publication

- Live-turn semantic envelopes use protocol **v7** independently of `WEBVIEW_PROTOCOL_VERSION`, which versions the host↔webview protocol—not the RPC transport wire format. Every webview envelope carries `protocolVersion` and the deterministic compile-time `PIE_BUILD_ID`; Vite recomputes the build id on every watch emission before chunk hashing, and compile/validate fails if the emitted host/webview identities differ.
- Ordinary build/watch publication verifies and installs a complete immutable renderer generation, then exposes it through one append-only selection marker. Resolution skips invalid newest markers and retains the current plus prior generations, falling back to the packaged flat bundle.
- Host startup uses `application/hosts/lib/pi-runtime-resolution.ts` for exactly `<selected out>/pi-runtime`, with a bounded sanitized target probe of the selected backend Node executable. `BackendClient` forwards the verified descriptor through the explicit JSON `--sourceArtifactDescriptor` launch argument; the coordinator independently verifies it before selecting source loading. Development artifact overrides require `PIE_DEVELOPMENT_PI_RUNTIME` plus `PIE_ALLOW_DEVELOPMENT_RUNTIME=1`, never legacy SDK inference.
- Standalone reuses `runtime-generations.cjs` for managed selection/leases. Packaged flat output has package-install lifetime; explicit output has caller-owned immutable-until-confirmed-shutdown lifetime. Neither is represented as a generation lease or deleted by standalone teardown. A selected generation's lease is retained when full owned teardown cannot be confirmed, even if backend exit alone is confirmed.

## Snapshot Recovery — cold prompt inventory discovery worker

Cold `systemPrompts` and the empty-session `initialContextEstimate` are produced by a one-shot isolated worker:

- A public cold `session.open` emits its durable snapshot with a `promptInventoryToken` before discovery and sends the catalog later through metadata-only `session.promptInventory`. Background `session.preload` skips discovery. Cold create/duplicate and toggle confirmations keep synchronous inventory snapshots. Discovery obtains the catalog from normal unfiltered hot semantics (`_originalSystemPromptOptions`, all `getAllTools()` names with their real prompt snippets/guidelines, and extension `resources_discover` contributions). "All configured" excludes missing/uninstalled packages and resources excluded by Pi resource settings, because those were not discovered as runnable registrations. Internal promotion snapshots do not invoke the worker.
- It builds the complete system prompt once from those all-tool inputs plus loaded custom/append/context/skill metadata, then builds the same lossless `SystemPromptEntry[]` used by a hot runtime and adds every registered tool description/schema once to the empty-session estimate. Provider-hidden instructions, prompt-template bodies, and full skill bodies remain excluded.
- The coordinator reads the addressed session's disabled-entry sidecar, applies it to the discovered entries, and bounds the catalog through the ordinary snapshot fitter. Deferred publication additionally fences both the original and final cold snapshots; the host consumes only the matching token under unchanged backend/model ownership and rejects closed, executing or superseded sessions. Because discovery runs outside the ownership critical section, publication rechecks the final snapshot's cwd/model, empty-session estimate eligibility, and the sidecar set; concurrent cold settings/toggle/history mutation causes bounded rediscovery, and exhaustion fails closed without a mixed catalog or stale estimate. Toggle refresh uses the just-persisted complete disabled set. The one-shot inventory has no cross-session catalog cache.
- Inventory IPC permits records up to **30 MiB**, below the shared 32 MiB ceiling. It never truncates prompt text. An ordinary cold payload still carries its disabled-entry sidecar when an oversized/failing inventory is omitted; the host recognizes that target-specific discovery failure and clears any older catalog. By contrast, the explicit metadata-independent `snapshotUnavailable` fallback may omit the catalog solely for transport size and therefore preserves already-loaded prompt text while applying its bounded disabled-entry confirmation.
- It uses an in-memory session, starts with Pi/npm/yarn package and startup networking forced offline, installs an outbound-fetch and turn-producing-method deny boundary before extension `session_start`, and invalidates the inventory after even a caught network attempt so a partial provider-discovery catalog is never published. Provider-catalog refresh hooks skip this inventory mode.
- The child is disposed and process-tree-cleaned, with process-tree fallback if Windows guardian termination fails, and is neither used during internal promotion nor promoted/cached. Failure/timeout omits the catalog and estimate.
- Subagent registration loads its complete metadata, schema, render callbacks and provider-observation hook without importing the execution graph. Shared async-local context lives in a lightweight module; the actual executor is loaded on first execution, once per registration. Inventory still runs every factory and builds the fresh complete catalog before publication; no catalog or execution-readiness bypass is introduced.
- At most one spare preloads validated SDK modules only, without request-specific cwd, settings or resources. After successful discovery, confirmed cleanup and queue drain, the client replenishes that spare without delaying the result. Each spare serves one fresh inventory and is retired; disposal or uncertain cleanup blocks replacement. A failed replacement is not automatically retried.

## Performance diagnostics

- Inventory `initial-context-inventory.stage` discovery samples report `queueWaitDurationMs` separately from service `totalDurationMs`; `requestDurationMs` covers both, through cleanup but excluding optional replacement prewarming. These samples contain timings, not prompt content or paths.
- With `PI_DIAG=1`, host traces separate `host.projection.completed` from `host.renderer.compacted`. Renderer delivery's existing `host.snapshot.built` span covers view-state preparation and envelope construction; it overlaps these component spans and must not be added to them.

## Snapshot Recovery — detail subscription and paging

- `detail.subscribe` carries the current `viewGeneration`, stable `detailKey`, webview-minted monotonic `detailAttempt`, and immutable `address`; every returned frame echoes that attempt. Collapse sends `detail.unsubscribe`. Baseline pages, deltas, rebases, terminal handoffs, and errors are explicit key-scoped states; pages live in a bounded, visibly-pinned LRU transport cache and the renderable value is derived per record, so evicted or gap ranges are re-fetched through `detail.fetchPages`; legacy non-addressable refs keep the generic one-shot `session.loadDetail` preview path.
- The terminal/cold durable authority resolves the exact terminal tool result from the durable JSONL by its stable tool-call id and producer lineage, segments it into exact UTF-8-safe, checksummed pages, and streams `detail.start` (including the exact byte and Unicode-code-point manifest totals) → ordered `detail.page` → `detail.terminal`. A live `NOT_FOUND`/`NOT_LIVE_ADDRESSABLE` subscribe falls back to this durable path for the same subscription id. No single response approaches the 30 MiB transport ceiling, so details far larger than 64 MiB remain retrievable.

## Snapshot Recovery — live-turn checkpoint byte accounting

- The backend maintains a canonical conservative byte total incrementally across JSON escaping, every text/reasoning part and draft, tool inputs/metadata/previews/terminal results, collection syntax, and the structural envelope; an observation is rejected before its complete active checkpoint could exceed **30 MiB**, leaving **2 MiB** of JSON-RPC/record headroom under the shared 32 MiB ceiling. Semantic envelopes and `LiveTurnRecord` carry that total; the progress patch hot path trusts the backend total and never stringifies the reconstructed large preview; checkpoint recovery serializes once and verifies actual bytes against the cached total.
- Checkpoint requests address the exact `sessionPath` + `turnId` + `attemptId`; progress patches carry both turn `baseSeq`/`seq` and per-tool progress revisions.

## Snapshot Recovery — overflow compaction margin

Provider-forced overflow compaction is treated as resumable when the provider response failed, including an empty `length` response whose usage counters are all zero when the SDK's last-valid-usage estimate remains at least **98%** of the model window.

## Snapshot Recovery — compaction chip and readiness probe constants

- The per-session last-compaction chip record expires after a bounded TTL via the `ClearLastCompaction` effect → `LastCompactionCleared` event.
- `WebviewReadinessProbe` is bounded by `READINESS_PROBE_MAX_ATTEMPTS`; its reload-skip bails for the first ticks of a genuine reload but, past `RELOAD_STUCK_SKIPS` consecutive skips (~6s), treats `reloading` as stale, force-clears it, and probes. The per-renderer reload circuit uses the rolling wall-clock limit, then remains terminally open until a deliberate renderer command or genuinely new/resolved renderer resets it; commits, handshakes, visibility changes, automatic retries, and elapsed time do not clear it.

## Conserved Billable Accounting — file mappings

- The billable invocation ledger is stored as `billable-invocations.jsonl` per workspace analytics store (legacy analytics authority; under canonical authority settlements go to `<data-root>/analytics/analytics.sqlite` and this file is not written).
- The correlated activity timeline is stored as `activity-intervals.json` (idempotent busy, provider, retry-wait, non-overlapping tool, compaction, and auxiliary intervals).
- The activity timeline keeps a JSONL delta journal beside that snapshot (`activity-intervals.journal.jsonl`). Routine `start`/`settle`/`recordMany` mutations append fsynced canonical interval records instead of rewriting the snapshot. Explicit background `compact()` stages a replacement outside the lock, then revalidates signatures before committing; a reset-marker recovery journal makes interrupted two-file replacement replayable. Privacy/forget scrubs synchronously remove attributed data from both files under the shared workspace lock. Every access revalidates snapshot/journal/privacy signatures; unchanged snapshots support incremental sibling-journal replay, interval identity and first settlement are immutable, and torn journal lines are skipped. Async `initialize()` parses in bounded slices without holding the lock across yields. Snapshot/privacy replacement can still require a synchronous compatibility reload. Older journal-unaware hosts see only the last compacted snapshot, so all hosts sharing this store should run the same version.

## Execution Ordering — backend operation ledger fingerprints

Generation-scoped backend operation ledgers key mutation execution by `operationId` plus a canonical kind-specific intent fingerprint:

- send: `{ kind, sessionPath, text, inputs, localId }`
- edit: send's fields plus the immutable target entry
- interrupt: `{ kind, sessionPath }`
- continue: `{ kind, sessionPath }`
- manual compact: `{ kind, sessionPath, reason: 'manual' }`

## Execution Ordering — worker replacement handshake

- SDK replacement carries `replacesSessionPath` and atomically rekeys coordinator roots, supervisor/client lease identity, and host tab selection. After commit the worker must send the exact authorization nonce back through correlated `ownership.consume`/`ownership.consumed` frames; the coordinator accepts that owner/path/revision/nonce exactly once before the SDK may activate or write the destination.

## Multi-Renderer Ownership — browser ingress byte caps

- Decoded images are capped at ≤ 10 MiB each and ≤ 20 MiB aggregate; base64 appears only in the allowlisted `imageBlob`/`ComposerInputDraft` image fields; full frames are capped at ≤ 32 MiB; `extensionUiResponse` payloads must be closed.

## MCP Server State — override artifact

- The backend translates the session override set into a session-scoped config artifact (`<sessionPath>.mcp-overrides.json`), passed to that session's worker as `--mcp-config` so the adapter substitutes only its highest-precedence discovery layer for that session.
