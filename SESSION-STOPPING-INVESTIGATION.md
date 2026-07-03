# Session-Stopping Investigation — Handoff Report

**Date:** 2026-07-03
**Repo:** `pie` (`c:\Users\OwanLazic\Documents\GitHub\pie`)
**Status:** Partially fixed; main-agent random stops remain unresolved.

## Problem

Sessions stop randomly, in both the pruning prepass and the main agent during reasoning.
Symptoms occur regardless of provider (seen on `github-copilot`, reported on `umans`).
A LiteLLM proxy was recently added in front of `umans` — it did **not** fix the stopping
but it solves the umans 4-concurrent limit and should be kept. User believes a recent
refactor introduced the issues.

## Fixed

### 1. Prepass 40s timeout abort (`extensions/skill-pruner/src/prepass.ts`)

- Commit `ddc23c5` (2026-06-11) introduced timeout budgets sized for a non-reasoning model:
  `minimal/low = 20s`.
- Pie's pruning config uses `gpt-5-mini` (reasoning model) at `low`; reasoning exceeded 20s,
  so `AbortSignal.timeout` fired mid-stream, producing `stopReason=aborted` +
  *"OpenAI Responses stream ended before a terminal response event"* at exactly `40013ms`
  (`low` 20s + `minimal` 40s after downgrade).
- Fix: raised budgets to `minimal: 30s, low: 45s, medium: 60s, high: 75s, xhigh: 90s`.
- Tests: 192/0.

### 2. Prepass OAuth race 400 (`extensions/skill-pruner/src/prepass.ts`)

- Pruning prepass runs before the first main-agent model call, so github-copilot's lazy
  OAuth refresh hasn't run yet; `getApiKeyAndHeaders` returned stale/empty keys →
  *"Authorization header is badly formatted"* 400.
- Fix: `resolveAuth` now returns `ResolvedAuth { apiKey?, headers?, authFailed? }`. When
  auth is attempted and returns no key, prepass fails open with a skip message instead of
  making a headerless request.

## Not fixed — main-agent random stops

A truncated stream from the provider surfaces as:
`errorMessage = "OpenAI Responses stream ended before a terminal response event"`.

- pi's retry classifier `_isRetryableError` (vendored in
  `dist/core/agent-session.js`) has `stream ended before message_stop` but **not**
  `stream ended before a terminal response event`. So the cut is never retried → stops.
- This classifier lives in the upstream `@earendil-works/pi-coding-agent` bundle
  (`AppData/Roaming/npm/...`); not safely editable from `pie`.
- Trigger not reproduced: a synthetic probe (`scripts/probe-stream.mjs`) tried proxy vs
  direct sequential ×8 and fanout ×4 under reasoning load. Both paths returned 200 OK and
  completed cleanly. The cut likely requires longer/more specific reasoning or timing.
- umans stops were not confirmed in session JSONLs because the scan only checked
  `stopReason === "aborted"|"error"`. Stops may present as `stopReason=stop` with
  incomplete content.

## Important files and docs

### Editable in `pie`

- `extensions/skill-pruner/src/prepass.ts` — prepass timeout table, retry loop,
  `ResolvedAuth`/`resolveAuth`, `runPruningPrepass`.
- `extensions/skill-pruner/test/pruning.test.ts` — 192/0 baseline.
- `extensions/skill-pruner/test/integration.test.ts:339` — why `aborted` must **not**
  be treated as a transport error (it must downgrade reasoning).
- `settings.json` — `httpIdleTimeoutMs: 0`, `retry.maxRetries: 6`,
  `retry.provider.maxRetries: 2`, pruning `thinkingLevel: low`.
- `proxy/litellm_config.yaml` — proxy config; keep `router_settings.timeout: 600`, do not
  re-add `litellm_settings.request_timeout`.
- `scripts/proxy.mjs` — proxy control.
- `scripts/probe-stream.mjs` — stream-truncation probe.
- `data/outcomes/sessions/` and `data/sessions/` — session JSONL records.
- `proxy/data/proxy.log` — LiteLLM logs.

### Vendored upstream (read-only, edits lost on update)

- `C:\Users\OwanLazic\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\dist\core\agent-session.js`
  — `_isRetryableError` regex (the open gap).
- `...\node_modules\@earendil-works\pi-ai\dist\api\openai-responses-shared.js:481`
  — stream terminal-event check.
- `...\node_modules\@earendil-works\pi-ai\dist\api\openai-responses.js:158`
  — `stopReason = signal.aborted ? "aborted" : "error"` branching.

### Repo memory

- `/memories/repo/pie-pruning-oauth-race.md`
- `/memories/repo/pie-prepass-timeout-abort.md`
- `/memories/repo/pie-proxy-not-streamcut-source.md`

## Next steps for handoff

1. Re-scan sessions for **incomplete content**, not just `stopReason == aborted|error`.
   Look for assistant messages ending mid-word on `umans`.
2. Test-origin: patch the upstream `_isRetryableError` regex in a throwaway copy to add
   `stream ended before a terminal response` and see if a cut then retries.
3. If confirmed, fix belongs upstream; consider patch-pinning the vendored bundle with a
   re-check-on-update comment.
