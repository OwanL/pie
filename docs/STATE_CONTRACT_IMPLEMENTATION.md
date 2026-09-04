# State Contract Implementation Notes

Non-normative mechanics behind [STATE_CONTRACT.md](STATE_CONTRACT.md): transport/protocol internals, byte budgets, thresholds, and file mappings. Tests must not pin this file; pin the normative contract instead. Completed remediation chronology lives in [STATE_CONTRACT_HISTORY.md](STATE_CONTRACT_HISTORY.md).

Each section mirrors the corresponding contract section.

## Backend Failure Recovery — transport budgets

- Backend JSONL records share a **32 MiB** byte limit. An overlong correlated stdout response is replaced before writing with a `RESPONSE_TOO_LARGE` error carrying the same request ID, so the stream stays synchronized and the backend stays available; an overlong stdout event remains a fatal transport fault. Overlong stdin records are discarded through LF; when the bounded preview contains a request ID, the backend returns a correlated `REQUEST_TOO_LARGE` response and subsequent requests remain readable.
- Session snapshot producers use a stricter **30 MiB** budget and measure the complete final serialized event/response envelope, including LF, before writer enqueue. If metadata plus one required durable row cannot fit losslessly, transcript-page RPCs fail with typed `SESSION_SNAPSHOT_TOO_LARGE` rather than relying on writer overflow replacement or fatal event handling.
- A `session.opened` producer that cannot fit its snapshot emits a bounded `snapshotUnavailable` snapshot: it first retains all ordinary metadata and drops only transcript/checkpoint bytes, with a final metadata-independent identity/lifecycle fallback if metadata itself exceeds the bound. That fallback never retains user session names, model catalogs, model settings, prompts, reviews, or usage; its required summary fields use fixed placeholders/caps, and path/session identity, lifecycle, selection, and live-recovery strings have fixed UTF-8 bounds, guaranteeing the complete event envelope remains below the producer budget.

## Snapshot Recovery — protocol versions, build identity, and publication

- Backend semantic envelopes use live protocol **v7**, independently of the RPC transport wire version (`WEBVIEW_PROTOCOL_VERSION`). Every webview envelope carries `protocolVersion` and the deterministic compile-time `PIE_BUILD_ID`; Vite recomputes the build id on every watch emission before chunk hashing, and compile/validate fails if the emitted host/webview identities differ.
- Ordinary build/watch publication verifies and installs a complete immutable renderer generation, then exposes it through one append-only selection marker. Resolution skips invalid newest markers and retains the current plus prior generations, falling back to the packaged flat bundle.

## Snapshot Recovery — initial context estimate discovery worker

The cold `initialContextEstimate` is produced by a one-shot isolated worker:

- It obtains the catalog from normal unfiltered hot semantics (`_originalSystemPromptOptions`, all `getAllTools()` names with their real prompt snippets/guidelines, and extension `resources_discover` contributions). "All configured" excludes missing/uninstalled packages and resources excluded by Pi resource settings, because those were not discovered as runnable registrations.
- It builds the complete system prompt once from those all-tool inputs plus loaded custom/append/context/skill metadata, then adds every registered tool description/schema once. Provider-hidden instructions, prompt-template bodies, and full skill bodies remain excluded.
- It uses an in-memory session, starts with Pi/npm/yarn package and startup networking forced offline, installs an outbound-fetch and turn-producing-method deny boundary before extension `session_start`, and invalidates the inventory after even a caught network attempt so a partial provider-discovery catalog is never published. Provider-catalog refresh hooks skip this inventory mode.
- The child is disposed and process-tree-cleaned, with process-tree fallback if Windows guardian termination fails, and is neither used during internal promotion nor promoted/cached. Failure/timeout omits the estimate.

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
- `WebviewReadinessProbe` is bounded by `READINESS_PROBE_MAX_ATTEMPTS`; its reload-skip bails for the first ticks of a genuine reload but, past `RELOAD_STUCK_SKIPS` consecutive skips (~6s), treats `reloading` as stale, force-clears it, and probes. The per-renderer reload circuit uses a rolling wall-clock window that transcript commits cannot reset.

## Session Cleanup — open-tab registry worker sync

- `PIE_OPEN_TABS` is the compatible JSON array and `PIE_OPEN_TABS_REVISION` is its worker-sync revision fence. Reloadable control-plane broadcasts receive a 30-second acknowledgement grace; the auxiliary open-tab registry remains nonfatal and retries the newest revision with bounded backoff. Worker-sync retries at an equal revision are accepted only when the bounded payload fingerprint is identical; a changed equal-revision payload is a fatal protocol fault.

## Session Cleanup — review closure drain mechanics

- Drain reconciliation runs unconditionally on every backend startup/restart and uses both `fs.watch` as a low-latency hint and a bounded sidecar-fingerprint poll as the missed-event recovery path. A still-failing closure action becomes terminal `failed` after `MAX_CLOSURE_ATTEMPTS`.

## Conserved Billable Accounting — file mappings

- The billable invocation ledger is stored as `billable-invocations.jsonl` per workspace analytics store.
- The correlated activity timeline is stored as `activity-intervals.json` (idempotent busy, provider, retry-wait, non-overlapping tool, compaction, and auxiliary intervals).

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