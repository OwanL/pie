---
name: playwright
description: Automate rendered web pages in Pie's isolated headless Chromium using DOM state, JavaScript, AI accessibility snapshots, revision-checked refs, browser assertions, explicit screenshots, downloads, tabs, and storage-state import/export. Use when a task requires browser rendering or client-side behavior. Prefer HTTP/CLI/MCP/web-fetch tools for non-rendered work, and use computer for browser chrome, native dialogs, visible profiles, or desktop surfaces outside the page.
---

# Playwright browser automation

Use the first-class `playwright` tool for rendered page work without taking over the user's desktop.

## Choose the right boundary

Use this order:

1. Prefer raw headless interfaces such as HTTP, CLI, MCP, `web_search`, or `fetch_content` when rendering and client-side behavior are unnecessary.
2. Use `playwright` when the task requires a browser DOM, JavaScript execution, accessibility state, auto-waiting, browser rendering, tabs, downloads, or page-local storage.
3. Use `computer` only for browser chrome, a native file/permission dialog, an ordinary visible browser profile, extensions pages, or another desktop surface outside Playwright's page boundary.

Playwright always launches its pinned Chromium build with `headless: true`. It never attaches to Chrome or Edge, uses no persistent profile, and cannot inspect or affect the user's visible browser windows.

## Core workflow

### 1. Open an isolated session

Call `playwright` with `action: "open"` and an optional URL. Save the returned:

- `sessionId`
- `pageId`
- observation `revision`
- accessibility refs such as `[ref=e12]`

Each Playwright tool session owns a dedicated browser process and an isolated `BrowserContext`. Reusing a `sessionId` that is already live is an error.

Open can also set a bounded viewport, action/navigation defaults, and explicit Playwright storage state:

```json
{
  "action": "open",
  "url": "https://example.test/login",
  "viewport": { "width": 1280, "height": 720 },
  "storageStatePath": "C:/artifacts/storage-state.json"
}
```

### 2. Observe before using refs

The accessibility snapshot is the primary evidence format. Prefer it over screenshots for ordinary interaction.

A ref is valid only for:

- its owning `pageId`
- the exact observation `revision` that returned it
- the current ref set for that page

Pass refs through the structured target field, never through a selector:

```json
{
  "action": "act",
  "sessionId": "pw-...",
  "pageId": "p1",
  "input": {
    "kind": "click",
    "target": { "ref": "e12", "revision": 4 }
  }
}
```

Selector-targeted actions use `{ "selector": "..." }` and do not carry a revision. Do not put `aria-ref=e12` into a selector; the tool rejects that bypass.

Every state-changing `act` and every `run_code` dispatch invalidates prior refs before execution, including failed, ambiguous, and `observation.mode: "none"` calls. A returned fresh observation establishes the only usable ref set. On `STALE_REF`, observe again rather than blindly retrying.

### 3. Use typed actions by default

Typed actions use Playwright strictness, auto-waiting, and bounded deadlines:

- navigation: `navigate`, `back`, `forward`, `reload`
- elements: `click`, `double_click`, `fill`, `type`, `press`, `select`, `check`, `uncheck`, `hover`, `focus`, `upload`
- synchronization: `wait` for one time, URL, text, or selector condition
- tabs: `tab_open`, `tab_select`, `tab_close`

Selectors that resolve to multiple elements fail with `AMBIGUOUS_TARGET`; prefer a fresh accessibility ref or a more specific selector.

For an action that may open a JavaScript dialog, register the policy on the same call:

```json
{
  "action": "act",
  "sessionId": "pw-...",
  "input": { "kind": "click", "target": { "selector": "#confirm" } },
  "dialog": { "action": "accept" }
}
```

Use `promptText` only with dialog action `accept`. Without a policy, Playwright dismisses the dialog automatically and reports it; it never leaves a dialog blocking later requests.

### 4. Verify a postcondition

Default post-action mode is `auto`: the result includes fresh page ID, URL, title, bounded accessibility evidence, new dialogs/errors/failed requests/downloads, and tab summaries.

This proves the action settled, not that the intended outcome occurred. Verify an explicit condition:

- expected URL
- visible text or accessibility node
- selector presence/state
- a focused `run_code` assertion

Observation modes:

- `auto`: normal fresh bounded evidence
- `full`: request the deepest bounded snapshot
- `none`: deliberately skip the snapshot for repetitive work; refs remain invalid until a later observation

Use targeted observations for large pages:

```json
{
  "action": "observe",
  "sessionId": "pw-...",
  "pageId": "p1",
  "observation": { "target": { "selector": "main form" }, "depth": 12 }
}
```

If the tool reduces a snapshot, it reports the loss explicitly and saves the complete in-limit snapshot as an artifact. Event queues are intentionally bounded telemetry and include dropped-entry counts.

## Screenshots and visual assertions

Screenshots are explicit opt-in only. Request one with `observation.screenshot: true` when visual evidence matters, not for routine clicking.

V1 captures the viewport only. It saves:

- the full viewport PNG artifact
- a model/display PNG whose long edge is at most 1,600 pixels

Image-capable models receive the display image. Text-only models receive `image_delivery: unavailable` and the artifact path. Do not infer unavailable image contents; switch to an image-capable model or delegate the artifact with `modelRequirements.inputKinds=["image"]`.

Use screenshots for layout, canvas, rendering, clipping, colors, or other facts accessibility text cannot establish.

## `run_code` escape hatch

Prefer typed actions. Use `run_code` for uncommon Playwright APIs, focused assertions, network inspection, canvas/browser probes, or an atomic multi-step operation that would otherwise expand the public schema.

`run_code` executes trusted JavaScript in the isolated headless sidecar. It is RCE-equivalent extension input, not a security sandbox. It receives real Playwright objects and never runs inside the web page unless you explicitly call `page.evaluate()`.

Accepted styles:

```js
// Async function body: page, context, and helpers are in scope.
return await page.locator('canvas').evaluate((canvas) => ({
  width: canvas.width,
  height: canvas.height,
}));
```

```js
// Full function: one narrow argument object.
async ({ page, context, helpers }) => {
  const response = await page.request.get('/health');
  return { status: response.status() };
}
```

Write a bounded owned artifact through the helper rather than requesting a raw filesystem path:

```js
const saved = await helpers.writeArtifact('probe.json', { ok: true, values: [1, 2, 3] });
return saved; // The final tool result reports the owned artifact path.
```

The writer accepts text, bytes, array buffers, or JSON-serializable values. It enforces the per-artifact and session aggregate caps, permits at most 100 artifacts per call, settles unawaited writes that already started, and becomes inactive when the submitted function/body resolves. Delayed helper calls cannot create files.

Browser globals such as `localStorage`, `document`, and `indexedDB` belong inside `page.evaluate()`:

```js
return await page.evaluate(() => ({
  title: document.title,
  local: localStorage.getItem('key'),
}));
```

Returns are serialized and bounded. Cycles and non-JSON values receive safe textual representations. Oversized results spill to artifacts. After `run_code`, contexts and pages created through the session browser are reconciled into the registry and a fresh observation is returned by default.

A timeout or unresponsive cancellation may force-kill the sidecar and all Chromium descendants. Do not replay ambiguous code automatically; call `open` again after `RUNTIME_REOPEN_REQUIRED`.

## Storage state

Storage state is explicit and artifact-based; no named or persistent browser profile exists.

Export before close:

```json
{
  "action": "close",
  "scope": "session",
  "sessionId": "pw-auth",
  "exportStorageState": true
}
```

The returned sensitive JSON artifact may contain authentication cookies and other account state. Keep it artifact-only unless explicitly needed, and pass its path to a later `open` call.

Export/import covers:

- cookies
- local storage
- IndexedDB

Session storage is not exported and is unsupported in v1.

## Downloads and artifacts

Downloads are saved under the owning session's Playwright artifact directory and reported as bounded events. A download or other artifact that exceeds its cap is deleted or stopped at the safe boundary and reported as `ARTIFACT_TOO_LARGE`; never treat it as complete.

Storage state and downloads can contain sensitive material. Return paths instead of inlining them unless the task explicitly requires reading the artifact.

## Recovery and cleanup

Important failures:

- `SESSION_NOT_FOUND` / `PAGE_NOT_FOUND`: reopen or choose a current page
- `STALE_REF`: observe again
- `AMBIGUOUS_TARGET`: use a ref or stricter selector
- `BROWSER_NOT_INSTALLED`: run the repair command in the error
- `ACTION_TIMEOUT` / `RUN_CODE_TIMEOUT`: outcome may be ambiguous; inspect fresh evidence or reopen, never auto-replay
- `BROWSER_CRASHED` / `RUNTIME_REOPEN_REQUIRED`: every previous session/page/ref ID is invalid; call `open`

Always close resources when finished:

```json
{ "action": "close", "scope": "session", "sessionId": "pw-..." }
```

Use runtime scope to tear down every Playwright tool session owned by the durable Pie session:

```json
{ "action": "close", "scope": "runtime" }
```

Session replacement, reload, shutdown, parent death, timeout recovery, and forced sidecar death also trigger bounded cleanup. No cleanup path can close the user's visible browser because Playwright never attaches to one.
