# Handoff: harden pie so subagent hangs are structurally impossible

You are picking up a hardening task in the **pie** repo (`C:/Users/OwanLazic/Documents/GitHub/pie`). A previous session diagnosed a freeze and got user approval on a 5-part structural fix plan, wrote one red TDD test file, then lost its tooling. Your job: finish the implementation via TDD, build, and verify. **Fail loud, never quiet. No timeouts as the primary fix — only as a last-resort net.**

## 0. Shell / test-runner notes (important)

- The previous harness's bash tool kept hanging on `cd` path resolution and on raw `npx tsx --test`. **Do not** use `cd /c/Users/...` or `cd c:/Users/...` (git-bash mangles it to `c:/c/Users/...`). Use `cd "C:/Users/OwanLazic/Documents/GitHub/pie"` (drive-absolute, forward slashes) or run commands with absolute paths from the repo root.
- **Run subagent tests via the repo runner**, not raw `tsx --test` (the never-settling fake promises in the new tests can make raw tsx hang; the repo runner enforces timeouts + coverage):
  ```
  cd "C:/Users/OwanLazic/Documents/GitHub/pie"
  node ./scripts/run-tests.mjs --package subagent
  ```
- Single-file iteration if needed (works from repo root): `npx tsx --test extensions/subagent/test/<file>.test.ts` — but prefer the repo runner for final verification. If a test file hangs, the fake SDK left a never-resolving promise; ensure your fakes don't hold the event loop (a bare `new Promise(()=>{})` is fine — it has no handle — but avoid stray `setTimeout` you never clear).
- Python (proxy): `cd "C:/Users/OwanLazic/Documents/GitHub/pie/proxy" && uv run python test/<file>.py`.

## 1. The incident (what must become impossible)

A parent session ("Build Out", Claude Sonnet 5, reveal orchestrator) froze for 45+ min on a `subagent` tool call. Diagnosis (from session-file forensics):

- **Hang class 1 — pre-spawn hang (the Build Out case):** the worker never spawned a session file. It was stuck *before* `createSession` — in `resourceLoader.reload()` / `inflightSemaphore.acquire()` / `sdk.createSession()`. The parent's **abort signal (Stop) was NOT wired to the pre-spawn phase** — only to `runPrompt()` — so Stop did nothing. AND `inflightSemaphore.release()` lives in a `finally` around `createSession()`, so a `createSession` that hangs **never releases the permit** → one hung createSession **permanently disables all subagents in the process** (poison). With capacity 2 this is latent; with capacity 1 it deadlocks the next call.
- **Hang class 2 — mid-stream dead provider stream:** a different worker (`ollama / glm-5.2:cloud`) emitted a `thinking` block then the provider stream died with no `message_end`. `session.prompt()` waits forever. `resolveSubagentTimeoutMs()` defaults to **0 (disabled)**, so there's no ceiling. Root owner of the stream is the **pie litellm proxy** (`pie/proxy/`), which today is a thin metrics wrapper (`pie_proxy_runtime.py`) and does NOT touch the streaming path — a stalled upstream just awaits the next chunk forever and the SDK hangs.

Consequence of either: the subagent tool's `execute()` never returns → the SDK never writes a `toolResult` → the **parent session dangles forever** (silent hang).

## 2. The approved plan (5 parts — implement all)

1. **Abort must work everywhere** (`extensions/subagent/runner.ts`): propagate the parent `signal` to `reload()`, `inflightSemaphore.acquire()`, and `createSession()` — each raced against abort. NOT a timeout; "Stop always works."
2. **A permit can never be held across an unbounded call** (`extensions/subagent/src/concurrency-limit.ts`): make `Semaphore.acquire(signal?)` abortable; a hung/aborted createSession rejects → `finally` releases → no poison.
3. **Dead upstream streams surface as errors** (`pie/proxy/pie_proxy_runtime.py`): wrap litellm streaming responses so a stalled upstream (no chunk within a liveness window) is terminated with an explicit error SSE event + close — the SDK then sees a terminal error instead of hanging. This is the transport's job; a liveness check at the transport layer is the correct mechanism (not a runner timer).
4. **Settlement guarantee (last-resort net)** (`extensions/subagent/src/execute.ts`): wrap the whole dispatch in a hard outer deadline; if `execute()` hasn't returned, abort the run, force-return an error toolResult so the SDK writes a result, and emit a loud signal. Defense-in-depth so the parent can *never* dangle even if a future bug reintroduces a hang.
5. **Loud, not quiet**: every timeout/force-settle/abort emits (a) a clear `errorMessage` in the tool result (visible in transcript), (b) an `onUpdate` message visible in the parent UI, (c) a structured `console.error` log with `[pie:subagent]` prefix carrying `toolCallId`/agent/task/stage/cause. (A dedicated webview chip is a nice-to-have follow-up, not required.)

## 3. Current state

- **`extensions/subagent/test/preflight-abort.test.ts` already exists** (written, currently **RED**). It covers: `Semaphore.acquire(signal)` already-aborted + abort-while-queued (waiter removed, no leak); `runSingleAgent` abort during createSession-hang and during reload-hang (returns promptly with abort error); and a poison-leak test (capacity 1: a hung createSession, once aborted, releases the permit so a follow-up call completes). Get this green first.
- No other changes made yet. Slices B, C not started.

## 4. Exact implementation

### Slice A — `extensions/subagent/src/concurrency-limit.ts`

`Semaphore` currently stores `waiters: Array<(release: Release) => void>` and `acquire()` takes no args. Change to:

- `waiters: Array<{ resolve: (r: Release) => void; reject: (e: unknown) => void }>`.
- `async acquire(signal?: AbortSignal): Promise<Release>`:
  - `const capacity = Math.max(0, Math.floor(this.capacityFn()));`
  - if `this.inFlight < capacity`: `this.inFlight++; return this.makeRelease();`
  - if `signal?.aborted`: throw `new Error("Subagent aborted (while waiting for subagent concurrency slot)")` (name it `AbortError`).
  - else: return a `new Promise<Release>((resolve, reject) => { const waiter = { resolve, reject }; this.waiters.push(waiter); if (signal) { const onAbort = () => { const idx = this.waiters.indexOf(waiter); if (idx >= 0) this.waiters.splice(idx,1); reject(new AbortError...); }; signal.addEventListener("abort", onAbort, { once: true }); } })`.
- `makeRelease`: `const next = this.waiters.shift(); if (next) { this.inFlight++; next.resolve(this.makeRelease()); }` (note: when handing to a waiter we do NOT decrement `inFlight` — the permit is transferred, not released; only an explicit `release()` call decrements). Preserve the existing idempotent-release + re-evaluate-capacity semantics. Keep the existing no-arg tests passing (`sem.acquire()` with no signal must still work).

Existing tests: `extensions/subagent/test/concurrency-limit.test.ts` must stay green.

### Slice A — `extensions/subagent/runner.ts`

Add a helper near the other helpers:

```ts
function abortError(stage: string): Error {
  const err = new Error(`Subagent aborted (while ${stage})`);
  err.name = "AbortError";
  return err;
}
/** Race `promise` against the parent abort signal. Rejects with an AbortError
 *  (carrying `stage`) if the signal fires first. No-op when signal is absent. */
async function raceAbort<T>(signal: AbortSignal | undefined, promise: Promise<T>, stage: string): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError(stage);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(stage));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}
```

Restructure the pre-spawn block (currently ~lines 715–733: `resourceLoader.reload()` → `release = await inflightSemaphore.acquire()` → `try { created = await sdk.createSession({...}) } finally { release() }`). Wrap in a try/catch that returns a loud `SingleResult`:

```ts
let session: SessionLike;
try {
  await raceAbort(signal, resourceLoader.reload(), "loading subagent resources");
  const release = await inflightSemaphore.acquire(signal);
  try {
    const created = await raceAbort(signal, sdk.createSession({ /* unchanged args */ }), "creating subagent session");
    session = created.session;
  } finally {
    release();
  }
} catch (err) {
  currentResult.exitCode = 1;
  currentResult.errorMessage = toErrorMessage(err);
  currentResult.stderr = currentResult.errorMessage;
  logLoud("subagent pre-spawn aborted/failed", { toolCallId: _toolCallId, agent: agentName, task, stage: "pre-spawn", error: currentResult.errorMessage });
  return currentResult;
}
```

Add a `logLoud` helper (export from a small module or inline in runner.ts):

```ts
function logLoud(event: string, details: Record<string, unknown>): void {
  console.error(JSON.stringify({ source: "pie:subagent", event, ...details }));
}
```

The existing `try { runPrompt()… } catch (err) { applyThrownError } finally { teardownSession }` block stays unchanged (it already handles prompt-phase abort). Keep the existing `parentAlreadyAborted` early-return branch.

### Slice B — `extensions/subagent/src/execute.ts` (settlement net)

Add config + helper (mirror `resolveSubagentTimeoutMs` style):

```ts
const SETTLEMENT_ENV = "PIE_SUBAGENT_SETTLEMENT_MS";
export const DEFAULT_SETTLEMENT_MS = 30 * 60 * 1000; // 30 min last-resort net
export function resolveSettlementMs(): number {
  const raw = process.env[SETTLEMENT_ENV];
  if (raw === undefined || raw === "") return DEFAULT_SETTLEMENT_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_SETTLEMENT_MS;
}
```

In `execute()`, the last statement is `return dispatchToMode(mode, params, ctx, agents, checkSessionLimit, runtimeCtx, makeDetailsBound, onUpdate, signal, selectionCtx, _toolCallId, ctx.hasUI ? (ctx.ui as unknown as ParentBridge) : undefined, parentSessionId, allToolNames);`. Replace with a settlement-wrapped version:

- `const settlementMs = resolveSettlementMs();`
- If `settlementMs <= 0`: `return dispatchToMode(... signal ...)` (unchanged).
- Else:
  - `const settlementController = new AbortController();`
  - `const runSignal = AbortSignal.any([signal, settlementController.signal]);` (Node 24 has `AbortSignal.any`; the runner already uses it.)
  - `const dispatchPromise = dispatchToMode(mode, params, ctx, agents, checkSessionLimit, runtimeCtx, makeDetailsBound, onUpdate, runSignal, selectionCtx, _toolCallId, ctx.hasUI ? (ctx.ui as unknown as ParentBridge) : undefined, parentSessionId, allToolNames);`
  - `const result = await Promise.race([dispatchPromise, settlementTimer]);` where `settlementTimer` is a promise that after `settlementMs` resolves with a sentinel `FORCE_SETTLE`.
  - If `dispatchPromise` wins: clear the timer, return its result (this is the normal case AND the abort-quickly case — because on settlement abort, runSingleAgent aborts and returns its own abort `SingleResult`, which `dispatchToMode` turns into the response).
  - If `FORCE_SETTLE` wins: `settlementController.abort(new Error("subagent settlement deadline exceeded"))`; emit loud `onUpdate` (`⚠ Subagent force-settled: did not return within Ns. See logs.`), `logLoud`, then give the downstream a short grace (e.g. race `dispatchPromise` against 5s) to return its abort result — prefer that if it arrives. If it still doesn't, return a synthesized `ErrorResponse`:
    ```ts
    { content: [{ type: "text", text: `Subagent did not settle within ${settlementMs/1000}s and was force-settled. This is a bug — please report.` }], details: makeDetailsBound(mode, []), isError: true }
    ```
  - Attach `dispatchPromise.catch(() => {})` early so an orphaned-then-rejected dispatch never surfaces as an unhandled rejection.
  - Clear the timer in a `finally`.

Write `extensions/subagent/test/settlement.test.ts` (TDD, red→green): call `execute(...)` with a fake `dispatchToMode`? `dispatchToMode` is not exported and lazy-imports `./modes.js`. Easier: test at the `execute()` level with a fake SDK whose `prompt` never resolves and **no parent signal**, with `PIE_SUBAGENT_SETTLEMENT_MS` set very small (e.g. 50). Assert `execute()` returns within ~1s with an `isError` response whose text matches `/force-settled|settle/i`. Also assert that aborting via the parent signal still works (settlement disabled, normal abort path). Mirror the `execute()` call shape from `extensions/subagent/test/execution-paths.test.ts` (it imports `execute` and builds `ctx`/params). You may need to pass a `SubagentParams` and a `ToolContext` mock — copy the construction from `execution-paths.test.ts`.

### Slice C — `pie/proxy/pie_proxy_runtime.py` (dead-stream surfacing)

Investigate how litellm returns streaming responses (it's a FastAPI `StreamingResponse` with a `body_iterator` yielding SSE `data: …` lines). Add a **middleware** (installed alongside the existing metrics patch) that, for streaming chat-completions responses, wraps the upstream `body_iterator` so each `await asyncio.wait_for(chunk, timeout=IDLE)` is bounded. On `TimeoutError`:

- Yield a terminal SSE error: `data: {"error":{"message":"upstream stream stalled: no chunk for <N>s","type":"upstream_stream_stalled"}}\n\n` then `data: [DONE]\n\n`, then stop.
- Log loudly (`print(..., flush=True)` or to stderr with a `[pie:proxy]` prefix): `{toolCallId/model, idleSeconds, cause}`.
- For non-SSE (JSON) responses, return a `JSONResponse({"error":{...}}, status_code=504)`.

Config: `PIE_PROXY_STREAM_IDLE_TIMEOUT_S` (default `120`); `0` disables. Add to `.env.example`.

Register it in a new `install_stream_liveness_middleware(app)` called from `pie_proxy.py` after `app` is imported:

```python
from litellm.proxy.proxy_server import app
install_stream_liveness_middleware(app)
```

You will likely need to monkeypatch the streaming response factory or add a Starlette `BaseHTTPMiddleware` that inspects `response.media_type == "text/event-stream"` and rewrites `response.body_iterator`. Read the litellm version installed in `proxy/.venv` to confirm the shape (`proxy/.venv/Lib/site-packages/litellm/proxy/proxy_server.py` and the chat completions route). Keep the metrics patch untouched.

Tests: add `proxy/test/test_stream_liveness.py`. Simulate a stalling async generator (yields one chunk, then `await asyncio.sleep(3600)`), wrap with the same wrapper function the middleware uses, assert it yields the original chunk then an error event within the idle window. Run: `cd "C:/Users/OwanLazic/Documents/GitHub/pie/proxy" && uv run python test/test_stream_liveness.py`. Keep `test_config.py` and `test_proxy_metrics.py` green.

### Slice D — loudness

`logLoud` in subagent (above) + `onUpdate` messages on settlement + proxy `[pie:proxy]` log. The transcript `errorMessage` already gives user-visible loudness via `applyTimeoutFailure`/`applyThrownError`/the new pre-spawn catch.

## 5. Build & verify (do exactly this, in order)

From repo root `C:/Users/OwanLazic/Documents/GitHub/pie`:

```bash
# 1. Subagent tests (repo runner — enforces timeouts + coverage 90 lines / 80 branches)
node ./scripts/run-tests.mjs --package subagent

# 2. Full typecheck (shared + extension + analytics + extensions)
npm run typecheck

# 3. Proxy tests
cd "C:/Users/OwanLazic/Documents/GitHub/pie/proxy" && uv run python test/test_config.py && uv run python test/test_proxy_metrics.py && uv run python test/test_stream_liveness.py

# 4. If you touched extension/src/ (you should NOT need to for Slices A–C, but if Slice B's execute changes bleed into extension build), rebuild:
cd "C:/Users/OwanLazic/Documents/GitHub/pie/extension" && npm run build
```

Coverage gate for subagent is **90% lines / 80% branches** — your new code must be covered (add tests for `raceAbort`, `logLoud`, settlement grace path, proxy wrapper).

## 6. Repo conventions (from AGENTS.md — do not violate)

- `models.yaml` is the single source of truth for model config. Never edit derived files (`models.json`, `model-profiles.yaml`, `proxy/litellm_config.yaml`, merged `settings.json`) directly — `extension/test/model-config-sync.test.ts` fails on drift.
- **Always rebuild after editing `extension/src/`** (`cd extension && npm run build` syncs to the installed VSIX). Slices A–C edit `extensions/` and `proxy/`, not `extension/src/`, so a build is only needed if you change `extension/src/`.
- Build/test commands: `cd extension && npm run build | npm run test | npm run typecheck | npm run package`.
- Three-layer context-lean model (history compaction / skill pruning / tool-result pruning) — don't conflate; not relevant here.

## 7. Acceptance criteria

- `preflight-abort.test.ts` GREEN; existing `concurrency-limit.test.ts` + `runner.test.ts` + `execution-paths.test.ts` still GREEN.
- New `settlement.test.ts` GREEN.
- `extensions/subagent` coverage ≥ 90% lines / 80% branches via `node ./scripts/run-tests.mjs --package subagent`.
- `npm run typecheck` clean.
- Proxy `test_stream_liveness.py` GREEN; existing proxy tests GREEN.
- Structurally: (1) parent abort interrupts every pre-spawn phase; (2) a hung createSession releases its permit (no process-wide poison); (3) a dead upstream stream surfaces as an SSE error at the proxy (SDK sees termination, not a hang); (4) `execute()` ALWAYS returns within `settlementMs` even if a downstream phase ignores abort; (5) every one of these logs + surfaces a user-visible message.
- Do NOT introduce a runner-level streaming-idle timeout — the user explicitly rejected timeouts-as-fix; the settlement net (#4) is the only timer in the runner, and it's a last-resort net, not the fix.

## 8. Suggested order

1. Slice A: edit `concurrency-limit.ts` + `runner.ts`, run `preflight-abort.test.ts` + `concurrency-limit.test.ts` + `runner.test.ts` → green.
2. Slice B: add settlement to `execute.ts`, write+run `settlement.test.ts` → green.
3. Slice A+B full: `node ./scripts/run-tests.mjs --package subagent` (coverage gate).
4. Slice C: edit `pie_proxy_runtime.py` + `pie_proxy.py`, write+run `test_stream_liveness.py` → green; existing proxy tests green.
5. `npm run typecheck` clean.
6. Final summary: files changed, tests added, coverage numbers, and a one-paragraph confirmation that each hang class is now structurally impossible.

Be concise in your responses. Verify before declaring done.