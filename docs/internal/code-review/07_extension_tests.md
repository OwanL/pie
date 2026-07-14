# 07 — `extension/test/` suite review

Scope: `extension/test/` (~165 `*.test.ts` files, ~1574 `test()` cases) + `_helpers/`, `fixtures/`, `perf/`. Runner: `tsx --test ./test/**/*.test.ts` (Node's built-in test runner — no vitest). DOM via happy-dom (`_helpers/dom.ts`).

## Files reviewed (sampled)

- `extension/test/_helpers/dom.ts`, `extension/test/_helpers/render-counter.ts` — only shared helpers
- `extension/test/host/core/architecture/arch-effect-runner.test.ts` (full) — riskiest-code coverage
- `extension/test/host/core/architecture/arch-boundary-guards.test.ts` (full) — source-text guards
- `extension/test/host/core/lifecycle/create-session-ordering.test.ts` (full) — integration-style ordering test
- `extension/test/host/core/architecture/arch-reducer.test.ts` (head), `host/core/state/state-reducer-invariants.test.ts` (head) — reducer coverage
- `extension/test/webview/components/webview-render.test.ts` (head), `webview/transcript/messages/transcript-virtual-list-rows.test.ts` (head) — virtualization
- `extension/test/webview/components/webview-style-contract.test.ts` (full), `webview/transcript/tools/tool-call-heading-css.test.ts` (head) — CSS/source-text tests
- `extension/test/backend/sessions/backend-session-event-handler.test.ts` (head) — message-router-adjacent
- `extension/test/webview/components/app-smoke.test.ts`, `webview/transcript/tools/nested-subagent-expand.test.ts` (heads) — mount-based UI tests
- `extension/test/webview/transcript/activity/auto-scroll.test.ts` (head), `host/core/reducer/transcript-helpers.test.ts` (head) — pure-logic tests
- `extension/test/perf/auto-follow-reflow.test.ts` (head) — perf harness
- Suite-wide greps: renderToString (14 files), `readFileSync`/`fs.readFile` (19 files), `EffectRunnerDeps` (7 files), `installDom` (16 files), `backendReady: true` readyState (13 files), factory-helper duplication (10+ files)

## Notable issues

### High

**H1. No dedicated test for `src/host/core/message-router.ts`.** `grep` shows `message-router.ts` exists but no `*message-router*` test file; only `arch-boundary-guards.test.ts` (a source-text guard) and `close-session-ordering.test.ts` reference it indirectly. The message-router is the impure plumbing layer that the boundary guards exist specifically to keep separate from the pure reducer spine — and it's the layer that translates SDK events into arch Events. It is covered only incidentally through `backend-session-event-handler.test.ts` (which tests `handleSdkSessionEvent`, a different module) and end-to-end ordering tests. *Why it matters:* the riskiest translation layer (SDK event → arch Event, ordering, error paths) has no targeted unit coverage; regressions there only surface via slow integration tests.

**H2. Source-text / regex structural tests pin implementation text, not behavior.** ~19 test files read source via `readFileSync`/`fs.readFile`. Worst offenders:
- `webview-style-contract.test.ts`: asserts regexes against CSS source and TSX source, e.g. `assert.match(appBody, /setProperty\(['"]--panel-font-size['"],\s*\`\$\{prefs\.uiBaseFontSize\}px\`\)/)` and `assert.match(indexCss, /--panel-font-size:\s*13px/)`. Reformatting a template literal, renaming a CSS var, or changing whitespace fails the test while behavior is unchanged.
- `arch-boundary-guards.test.ts`: regex-scans `PURE_SPINE_FILES` source for `Date.now()`, `Math.random()`, `new Date()`, `console.`, `process.env`, and scans import strings. The `new Date()` regex `new Date\(\s*\)` will false-positive on `new Date(timestamp)` only by luck of spacing; the import-string scan is a structural lock on module paths.
- `tool-call-heading-css.test.ts`: asserts on rendered Tailwind class strings (`/flex min-w-0 flex-1 items-center/`, `/transcript-header-path-prefix/`). Reordering classes or renaming a BEM-ish class breaks tests with no behavioral change.
*Why it matters:* these are refactor-hostile — they enforce the *shape of the code*, not what it does. Any non-behavioral edit (formatter, var rename, class reordering) trips red and trains the team to ignore or weaken test failures.

**H3. UI tests assert on rendered HTML strings, not DOM behavior — `@testing-library/preact` is a devDependency but used by 0 test files.** 14 files use `preact-render-to-string` + `assert.match` on the resulting HTML (`webview-render.test.ts` alone has 150 `assert.match` calls). Only 16 files `installDom()` and mount via `preact/test-utils`'s `act`; none query the DOM the way a user would (click/focus/keyboard). *Why it matters:* interaction behavior (click handlers, focus management, keyboard shortcuts, portal interactions) is effectively untested — tests verify *what HTML is produced at render time*, not *what happens when a user acts*. The settings-menu-* tests partly compensate via mount+act, but they still mostly assert markup.

### Medium

**M1. `EffectRunnerDeps` mocks hand-built and duplicated across 7 files, with `as any` casts that defeat the type checker.** `arch-effect-runner.test.ts` builds the canonical ~50-line `makeDeps()`; `close/open/duplicate-session-ordering.test.ts`, `arch-interrupt-integration.test.ts`, `session-tab-actions.test.ts` each rebuild a near-identical `EffectRunnerDeps` literal with `fileDiffService: { ... } as any` and `service: { ... } as any`. *Why it matters:* (a) drift — when `EffectRunnerDeps` gains a required method, the `as any`-cast mocks compile fine while silently missing the method, so a real call path breaks at runtime instead of at test compile; (b) duplication means each fix must be applied 7×.

**M2. Transcript virtualization has no real behavior coverage.** `transcript-virtual-list-rows.test.ts` unit-tests `buildTranscriptRows` row ordering (good, pure-logic), but the actual windowing/measure/`totalSize`-driven auto-follow is exercised only by `perf/auto-follow-reflow.test.ts`, whose own header admits happy-dom has no layout engine (`scrollHeight`/`clientHeight` always 0) so the forced-reflow cost "can't be measured here (that needs a real browser)". *Why it matters:* the perf harness proves the *logic* of the follow loop but cannot catch virtualization regressions that only manifest with real layout — these are exactly the bugs that slip through.

**M3. Tests import `core/*` internals directly (41 files → `arch-state`, 35 → `reducer`, 35 → `events`).** The reducer CQRS spine is tested as isolated units rather than through a public entry point. *Why it matters:* moving a handler between `core/reducer.ts` and `core/reducer/*.ts` (the file layout is already split: `session-handlers.ts` 638 lines, `streaming-handlers.ts`, `set-model-handlers.ts`, `ui-handlers.ts`) breaks import paths across dozens of test files even when the reducer's behavior is identical. Couples test stability to module layout.

### Low

**L1. Duplicated test-state factories diverge in shape.** `makeMessage`/`assistantMessage`/`userMessage` are redefined in 10+ files with inconsistent fields (some set `parts`, some `toolCalls`, some `customType`/`customDetails`, some `content`/`markdown` both). `ChatMessage` carries legacy aggregate fields (`markdown`, `thinking`, `toolCalls`) alongside `parts`; the divergent factories mean a test's fixture may not match the shape real code produces, hiding shape-dependent bugs. *Why it matters:* factory drift quietly weakens the fidelity of every UI render test that uses them.

**L2. `readyState` (backendReady:true) boilerplate duplicated across 13 files**, each writing `const readyState: ArchState = { ...initialArchState, settings: { ...initialArchState.settings, backendReady: true } }`. A `makeReadyState()` helper in `_helpers/` would remove 13 copies and make the "ready" precondition explicit.

**L3. DOMPurify stub + `installDom()` boilerplate copy-pasted in 16 webview files.** The 2-line `DOMPurify.sanitize = (html) => html` override is repeated verbatim rather than wrapped in `_helpers/dom.ts` (which already exists and is the natural home). Not a bug, but a missed consolidation.

## Smaller nits

- `webview-render.test.ts` (48KB, ~1300 lines, 150 matches) is a monolith — a single failing assertion early in the file makes the rest hard to read. Consider splitting by component (`message-item`, `tool-call-card`, `system-prompts`, `turn-activity-strip`); the module already hoists 6 sub-component imports, signaling it grew by accretion.
- `webview-render.test.ts` u
ses `require()` at module scope (with a comment explaining tsx compiles to CJS) purely to keep the first test under 200ms — a test-runner-billing workaround that bakes in CJS semantics and will silently break if the project moves to ESM `tsx --test`.
- `arch-effect-runner.test.ts`'s `settle()` drains microtasks with a fixed `for (let i=0; i<5; i++) await setImmediate`. The magic 5 is brittle: a future effect adding one more async hop will flake. The ordering tests use 10. No shared `settle()` helper.
- `manifest-commands.test.ts` reads `package.json` to assert a command + activation event exist — mild structural test, acceptable as a cheap guard against manifest drift, but it's existence/structure not behavior.
- `dispatch-purity.test.ts` is a 1-assertion test that `dispatch` returns `{state, effects}` deterministically — low value given `arch-boundary-guards` already scans the spine for impurity; harmless redundancy, but the test name oversells what it checks.
- No snapshot files (good — no `*.snap`); the word "snapshot" in 10 filenames refers to state-snapshot *behavior* tests (`arch-edit-snapshot-preserve`, `arch-set-model`), not snapshot-matchers.
- Tests are fast overall: the only real `setTimeout` calls are 0ms/10ms microtask drains (`backend-request-handler`, `session-tab-actions`, `shared-request-tracker`); `FakeTimerSink`/`TimerSink` is used where timers matter (`arch-effect-runner`, `composer-draft`, `composer-undo`, `session-selection-timeout`, `tooltip`). No wall-clock sleeps found.

## Summary verdict

The pure-logic core (reducer, effect-runner, transcript-helpers, auto-scroll, transcript row building) is genuinely well tested as **behavior** with deterministic fake timers and clear, sentence-style test names — this is the suite's strength. The weaknesses are concentrated in (1) the UI/webview layer, which tests rendered-HTML strings and source-text regexes instead of DOM behavior, (2) the impure plumbing layer (message-router) with no targeted unit test, and (3) duplicated, `as any`-cast mock plumbing the type checker can't catch drift in. The source-text guards in `arch-boundary-guards` and `webview-style-contract` are the most refactor-hostile artifacts in the suite — they will trip on cosmetic edits and should be the first target if reducing test friction is a goal.
