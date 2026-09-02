# First-class Playwright Tool

## Status

Implemented for Windows with Playwright `1.62.1`, Chromium revision `1234` (`151.0.7922.34`), and headless Chromium only.

The capability consists of:

- one pruneable Pi tool named `playwright` under `extensions/playwright/`;
- one pruneable workflow skill under `skills/playwright/`;
- one lazy Playwright sidecar per durable Pie session;
- one dedicated browser process and primary isolated `BrowserContext` per Playwright tool session.

It adds no host↔webview logic state. Ordinary mixed text/image tool-result rendering and the generic image-context guard handle results, so `STATE_CONTRACT.md` is unchanged.

## Interaction hierarchy

Use this order:

1. Prefer raw headless interfaces such as HTTP, CLI, MCP, `web_search`, or `fetch_content` when rendering is unnecessary.
2. Use `playwright` when work requires a browser DOM, client-side JavaScript, accessibility state, browser rendering, tabs, downloads, or page-local storage.
3. Use `computer` only for browser chrome, native dialogs, visible user profiles, extension pages, or another desktop surface outside the page boundary.

The implementation is application-neutral. It contains no site-specific branches.

## Runtime boundary

```text
model
  <-> first-class playwright Pi tool
  <-> durable-session RuntimeClient
  <-> bounded versioned JSONL
  <-> lazy Node sidecar
  <-> Playwright library 1.62.1
  <-> dedicated pinned headless Chromium process
  <-> isolated BrowserContexts and Pages
```

The parent Pi worker never imports Playwright or launches Chromium. The sidecar is the only process that loads the Playwright runtime.

Runtime ownership follows the same durable-session shape as computer-use without sharing native-input internals:

- canonical durable Pie session path → one lazy sidecar client;
- Playwright `sessionId` → one dedicated browser process plus primary context;
- stable `pageId` → one `Page` within that process;
- process-wide registry and teardown singleton live on `globalThis` so jiti reload cannot orphan module-scope clients;
- `session_shutdown`, replacement, fork, resume, reload, parent exit, cancellation recovery, timeout recovery, and explicit close are idempotent cleanup boundaries.

A tool session deliberately owns a dedicated process because trusted `run_code` can reach `page.context().browser()` and create more contexts. The backend reconciles all reachable contexts/pages after code execution, and closing the session destroys the whole dedicated process.

Chromium is started with `launchServer({ headless: true })`, then connected locally by the same sidecar. This gives the owner a deterministic process handle for graceful and forced cleanup. There is no CDP connection to machine Chrome/Edge, no channel fallback, no `userDataDir`, and no persistent profile.

## Public tool surface

One sequential tool exposes five actions:

```text
open | observe | act | run_code | close
```

The TypeBox schema is strict. All string enums, including discriminators, use `StringEnum` for provider compatibility. Semantic validation rejects invalid field combinations before runtime work.

### `open`

Creates one isolated session and first page, optionally navigates, and returns the initial bounded observation.

Main inputs:

- optional `sessionId`, otherwise generated as `pw-<uuid>`;
- optional URL;
- viewport `320..1920` by `200..1080` CSS pixels;
- optional Playwright storage-state JSON path;
- action/navigation defaults within `1,000..120,000` ms;
- observation settings.

The result states `headless: true` and `isolated: true` and returns the session ID, page ID, URL, title, revision, snapshot, event/tabs evidence, and optional screenshot paths.

A durable Pie session path is mandatory. Ephemeral sessions fail with `SESSION_PATH_REQUIRED` because ownership, cleanup, and artifacts require a stable boundary.

### `observe`

Returns current page evidence without changing the page.

Observation settings are a closed object:

- `mode`: `auto | full | none`;
- depth `1..50`;
- optional target by `{ ref, revision }` or `{ selector }`;
- explicit viewport screenshot;
- console/page-error/failed-request/download limits `0..200`;
- optional tab summaries.

Screenshots are never implicit. V1 captures the viewport only and writes both a bounded full PNG and a display PNG whose long edge is at most 1,600 pixels. Image-capable models receive the display PNG; text-only models receive an explicit unavailable notice and artifact path.

### `act`

Typed actions use Playwright strictness, auto-waiting, and finite deadlines.

Supported kinds:

- navigation: `navigate`, `back`, `forward`, `reload`;
- elements: `click`, `double_click`, `fill`, `type`, `press`, `select`, `check`, `uncheck`, `hover`, `focus`, `upload`;
- synchronization: `wait` for exactly one time, URL, text, or selector condition;
- tabs: `tab_open`, `tab_select`, `tab_close`.

Element targets are exactly one of:

```json
{ "ref": "e12", "revision": 4 }
```

or:

```json
{ "selector": "form#login button[type=submit]" }
```

A ref-targeted action also requires its owning `pageId`. Selector fields reject the `aria-ref` selector engine, so ephemeral snapshot refs can enter only through revision-checked fields.

A one-shot JavaScript dialog policy can accept (optionally with prompt text) or dismiss the next dialog. Without a policy, the sidecar dismisses it and reports `auto-dismissed`; no dialog remains open across serial requests.

Post-action observation mode defaults to `auto`. `full` requests maximum depth before source-level bounding. `none` deliberately skips the snapshot; refs remain invalid until a later observation.

### `run_code`

`run_code` executes a caller-supplied async JavaScript body or function inside the trusted sidecar. It is RCE-equivalent extension input, not a security sandbox.

Available objects:

- current Playwright `page`;
- primary `context`;
- a bounded `helpers.writeArtifact(name, value)` writer.

A body receives `page`, `context`, and `helpers` in scope. A full function receives one `{ page, context, helpers }` object. Browser globals such as `document`, `localStorage`, and `indexedDB` must be used through `page.evaluate()`.

`helpers.writeArtifact` accepts text, byte arrays, array buffers, or JSON-serializable values. It returns an opaque artifact ID and byte count, while the final tool result reports the owned path. It does not expose a raw writable path. Each call is checked atomically against the 8 MiB per-artifact and 512 MiB session aggregate limits, at most 100 helper artifacts may be finalized in one `run_code`, and the helper becomes inactive as soon as the submitted function/body resolves. Unawaited writes already started are settled before result serialization; delayed calls cannot create files.

The code field is capped at 64 KiB, the deadline at 120 seconds, and results at an 8 MiB artifact boundary. Cyclic, bigint, and function values get safe representations. Results larger than the inline 8 KiB budget spill to a complete session artifact. A result beyond 8 MiB fails with `ARTIFACT_TOO_LARGE`; no capped prefix is presented as a complete artifact.

Every dispatch invalidates all refs before execution. Afterwards the backend reconciles contexts/pages reachable through the dedicated browser and returns a fresh bounded observation by default.

Synchronous infinite loops or unresponsive cancellation cannot be safely interrupted in-process. The parent deadline force-terminates the sidecar process tree, invalidates all IDs, and returns reopen-required guidance. Ambiguous code is never replayed automatically.

### `close`

Close scopes:

- `session`: close one named tool session and all contexts/pages in its dedicated browser process;
- `runtime`: close every tool session owned by the durable Pie session.

Either scope can export the named session's primary context storage state before closing. Runtime export therefore requires a `sessionId` to identify the context.

Close is idempotent. An unknown/dead session yields an empty closed-session list, enabling cleanup after runtime loss. Runtime close reports at most 100 session IDs plus an explicit omitted count, while still closing every owned session.

## Accessibility refs and revisions

The compatibility contract is Playwright's pinned AI snapshot and ref engine:

```ts
await page.ariaSnapshot({ mode: "ai", depth });
await page.locator(`aria-ref=${ref}`).click();
```

Each page owns a monotonically increasing observation revision and the exact ref set parsed from the returned snapshot.

A ref is accepted only when:

- the tool session exists;
- the page ID exists;
- the page has a fresh observation;
- the supplied revision equals the page's current revision;
- the ref was present in that returned snapshot.

Every state-changing `act` and every `run_code` invalidates refs before dispatch, even on failure, timeout ambiguity, or `mode: none`. A successful fresh observation establishes the next usable set.

A locator timeout for a revision-checked ref is normalized to `STALE_REF`, never silently retried and never converted to coordinates or another element.

## Result bounding

### Model-facing observation limits

Ordinary observation text targets:

- at most 32 KiB;
- at most 250 accessibility lines;
- overlong individual lines bounded while preserving their structural prefix and `[ref=...]` token.

Snapshot bounding order:

1. capture the complete unrestricted AI snapshot;
2. return it directly if it fits and no explicit depth view is requested;
3. when automatic reduction is required, save the complete snapshot artifact;
4. recapture at the configured/default depth and halve depth until it fits;
5. at depth 1, bound pathological lines and line count;
6. report a structured reduction record plus text fidelity marker and complete artifact path.

No reduced snapshot is silently presented as complete.

Console warnings/errors, page errors, failed requests, and downloads use independent bounded queues. Each queue retains at most 200 entries and reports a cumulative dropped-entry count, including entries omitted by a caller limit or response-byte fitting. Each delivered category is capped at 96 KiB so a valid observation cannot breach the 1 MiB JSONL envelope. Results deliver newest tails and do not claim complete tracing. Tab summaries retain at most 100 pages, always preserve the active page when possible, and report an explicit dropped count.

### Artifact caps

| Artifact | Cap |
|---|---:|
| complete snapshot | 8 MiB |
| storage state | 8 MiB |
| `run_code` result | 8 MiB |
| viewport PNG | 16 MiB |
| download | 128 MiB |
| aggregate per tool session | 512 MiB |

A payload beyond its cap is deleted or stopped at its last safe boundary and reported with `ARTIFACT_TOO_LARGE`. The result never describes it as complete.

Artifacts live beneath the durable session's sibling `playwright/` directory, partitioned by durable transcript basename and Playwright `sessionId`:

```text
<session-dir>/playwright/<durable-session>/<playwright-session>/
  snapshots/
  screenshots/
  downloads/
  run-code/
  storage-state/
```

Both the canonical durable-session path and the unsanitized Playwright session ID contribute stable hash suffixes to their directory segments, preventing lossy filename sanitization from merging unrelated sessions.

Storage-state and download artifacts can contain authentication or private data. Paths are returned; storage JSON is never automatically inlined.

## Storage state

Open accepts only explicit Playwright storage-state JSON with `cookies` and `origins` arrays. Files over 8 MiB, unreadable JSON, or incompatible shapes fail with `INVALID_STORAGE_STATE`.

Export uses:

```ts
context.storageState({ indexedDB: true, path })
```

Round-trip coverage:

- cookies;
- local storage;
- IndexedDB.

Session storage is intentionally unsupported and does not round-trip.

## Events, downloads, and tabs

Every registered page captures bounded:

- console warnings/errors;
- uncaught page errors;
- failed requests;
- download lifecycle records;
- page/tab identity and titles.

Downloads stream through a counting writer. Completion gets a new event sequence, so a prior `saving` event cannot hide a later `saved`, `failed`, or `too_large` terminal record. Overflow deletes the partial file.

Pages created by typed tab actions or `run_code` receive stable `pN` IDs. Active-page selection is explicit. A closed/missing page fails with `PAGE_NOT_FOUND`; there is no implicit creation except `open` and `tab_open`.

## Transport and recovery

Parent↔sidecar transport is UTF-8 JSONL v1 with a 1 MiB record bound and request, response, cancel, ping, shutdown, and protocol-error frames.

Requests execute serially. Playwright defaults are 30 seconds for actions and 45 seconds for navigation; public overrides and waits are capped at 120 seconds. The parent owns a larger enclosing deadline so customized sidecar timeouts are never clipped.

Cancellation sends a correlated cancel frame. If the request does not settle within a five-second grace period, the parent kills the sidecar process tree and rejects with `CANCELLED`.

After a sidecar timeout, crash, or protocol loss:

- all Playwright session/page/ref IDs are invalid;
- no ambiguous action is replayed;
- calls other than `open`/cleanup fail with `RUNTIME_REOPEN_REQUIRED`;
- `open` lazily starts a fresh runtime.

Windows forced cleanup uses `taskkill /T /F` on the sidecar PID, so Chromium descendants are included. The sidecar also watches stdin and parent liveness; owner death without a shutdown frame triggers graceful browser close before exit.

## Stable error codes

Primary codes:

- `EXTENSION_DISABLED`
- `SESSION_PATH_REQUIRED`
- `BROWSER_NOT_INSTALLED`
- `BROWSER_LAUNCH_FAILED`
- `BROWSER_CRASHED`
- `SESSION_NOT_FOUND`
- `PAGE_NOT_FOUND`
- `STALE_REF`
- `AMBIGUOUS_TARGET`
- `NAVIGATION_FAILED`
- `ACTION_TIMEOUT`
- `RUN_CODE_TIMEOUT`
- `CANCELLED`
- `INVALID_STORAGE_STATE`
- `ARTIFACT_TOO_LARGE`
- `SIDECAR_PROTOCOL_ERROR`
- `RUNTIME_REOPEN_REQUIRED`

Validation uses `INVALID_ARGUMENTS`; uncategorized backend action failures use `REQUEST_FAILED`.

## Install and version ownership

`extensions/playwright/package.json` and its committed lockfile own the runtime dependencies independently of `extension/node_modules`:

- `playwright`: `1.62.1` exact;
- `pngjs`: `7.0.0` exact.

Pi packages remain optional `peerDependencies` with `"*"` ranges, preventing npm from installing a second SDK/TypeBox generation. Development tests resolve the embedded host's pinned Pi `0.80.6` and TypeBox `1.1.38` through a test-only runtime tsconfig, and an integration test loads the extension through that embedded Pi loader.

Repository dependency installation includes `extensions/playwright/`, then explicitly runs:

```bash
cd extensions/playwright
npx playwright install chromium
```

The runtime checks `chromium.executablePath()` and returns `BROWSER_NOT_INSTALLED` with the root repair command when the pinned executable is absent. It never falls back to machine Chrome or Edge.

## Context-lean integration

The tool and skill are ordinary skill-pruning candidates. `playwright` is not in `pruning.tools.alwaysKeep`, and no Playwright-specific dependency exception exists.

The tool bounds semantic output before returning it. Generic tool-result pruning may still remove whitespace or ANSI noise; it does not parse Playwright snapshots. Every source-level lossy snapshot/result reduction carries its own artifact and fidelity marker.

Tool prompt metadata is sufficient for basic use when the skill is omitted. Every active guideline names `playwright`, because prompt guidelines are appended flat to Pi's global guideline list.

## Deterministic verification

Package commands:

```bash
npm run playwright:typecheck
npm run playwright:test
npm test
npm run typecheck
```

Because `extension/src/shared/bundled-extensions.ts` includes the generic settings metadata, any implementation change there also requires:

```bash
npm run extension:build
```

The normal package suite includes a real pinned-browser smoke path and deterministic localhost fixtures. Coverage includes:

- strict schema and semantic validation;
- malformed/oversized JSONL, cancellation, timeout, protocol loss, and shutdown;
- lazy startup and durable-session registry isolation;
- open → observe → fill/click → verified changed snapshot → close;
- revision/ref invalidation, stale/wrong IDs, and `aria-ref` selector rejection;
- forms, navigation, history, waits, tabs, upload, iframe snapshots, dialogs, errors, failed requests, and bounded downloads;
- source snapshot reduction, overlong accessible values, fidelity artifacts, and explicit screenshots;
- `run_code` success, new context/page reconciliation, cycles, oversized results, throws, and timeout;
- cookie/local-storage/IndexedDB storage-state round-trip plus negative session-storage evidence;
- isolated session storage/cookies;
- browser crash and idempotent cleanup;
- forced sidecar tree death and parent death without a shutdown frame, followed by PID-exit proof for sidecar and Chromium.

The localhost fixture path is application-neutral and requires no external network or visible browser.

### Recorded acceptance evidence (2026-09-01)

- The Playwright package suite completed with `62 passed, 0 failed, 0 skipped`, including real Chromium, timeout/cancellation tree termination, failed-export cleanup, cumulative artifact quotas, bounded helper writers, bounded telemetry envelopes, last-page tab recovery, pathological-line bounding, and embedded Pi loader/schema compatibility. The release coverage gate completed at `95.1%` lines / `80.7%` branches (`61 passed, 1 intentionally skipped` because Node otherwise folds the external jiti compatibility child's alternate source maps into its experimental coverage). The final root affected suite completed with `6,656 passed, 0 failed, 30 skipped` and no flaky rerun; the full repository typecheck completed for every registered project.
- The public registered tool completed `open → ref-targeted fill → fresh ref-targeted click → changed accessibility snapshot → close` on the deterministic form fixture without emitting an image. A separate canvas pixel probe used `run_code`, and exactly one explicit visual assertion produced exactly one image part.
- The public registered tool drove Pie's real `analysis/site/` run-analytics UI: it filled the Start date control by revision-scoped ref, asserted one active filter in the rendered DOM, narrowed a fresh observation to the filter form, reset by a new revision-scoped ref, and asserted the rendered filter state was clear. The workflow emitted no screenshot.
- A hidden Win32 monitor polled `GetForegroundWindow()` every 20 ms across both public-tool dogfood runs. Each run retained its initial foreground HWND throughout (`FOREGROUND_CHANGES=[]`); Chromium remained headless and no desktop input tool was used.
- Lifecycle tests recorded the sidecar and dedicated Chromium PIDs, then proved all were gone after sidecar tree kill, `run_code` timeout, `run_code` cancellation, browser-close fallback, and owner death without a shutdown frame.
- The production extension TypeScript/Vite build completed through the supported `npm run build -- --no-sync` path with coordinated host/webview build ID `1032a1b72e4ac9a0da6b`. Atomic sync into the installed extension was intentionally deferred because this running Pie/VS Code process held the destination `out/` directory open.

A deterministic pinned-browser release probe measured the following actual outputs and artifacts. The token figures are conservative four-characters-per-token proxies, not provider tokenizer claims.

| Evidence | Measured size | Token proxy where model-facing |
|---|---:|---:|
| initial AI snapshot | 1,002 bytes | included in the 1,245-character tool result (~312 tokens) |
| initial open tool text | 1,245 bytes | ~312 tokens |
| explicit screenshot tool text | 1,473 bytes | ~369 tokens |
| viewport full PNG | 16,927 bytes | artifact/image content, not text tokens |
| viewport display PNG | 16,927 bytes | one explicit image part |
| completed download | 36 bytes | artifact only |
| `run_code` complete spilled JSON | 100,002 bytes | artifact only; preview tool text was 2,501 bytes (~626 tokens) |
| dense complete accessibility snapshot | 29,080 bytes | artifact only |
| dense reduced returned snapshot | 91 bytes | dense action tool text was 496 bytes (~124 tokens) |
| exported storage state | 36 bytes | artifact only |
| aggregate session artifacts before/after storage export | 162,972 / 163,008 bytes | quota-accounted, not model text |

Every measured model-facing text result remained below the 32 KiB bound, while complete recall data remained artifact-backed.

## Known v1 limits

- Chromium only; no Firefox or WebKit.
- Headless only; no headed option.
- Viewport screenshots only; no full-page screenshots or traces.
- Explicit Playwright storage state only; no persistent or named profiles.
- Session storage is not exported.
- Event queues are bounded telemetry, not complete network/console histories.
- Native dialogs, browser chrome, extensions pages, and visible profiles remain `computer` territory.
