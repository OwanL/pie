# Webview Transcript Rendering — Code Review

Scope: `extension/src/webview/panel/transcript/` (transcript rendering), `extension/src/webview/panel/styles/`, and top-level panel files (`app.tsx`, `app-body.tsx`, `panel.tsx`, `ui.tsx`). Reviewed as a skeptical senior engineer. No fixes proposed.

## Files reviewed

| File | Lines |
|---|---|
| `extension/src/webview/panel/transcript/use-transcript-scroll.ts` | 668 |
| `extension/src/webview/panel/transcript/tool-call-card.tsx` | 822 |
| `extension/src/webview/panel/styles/composer.css` | 1009 |
| `extension/src/webview/panel/transcript/tool-call-item.tsx` | 550 |
| `extension/src/webview/panel/styles/tabs.css` | 717 |
| `extension/src/webview/panel/transcript/virtual-list.tsx` | 445 |
| `extension/src/webview/panel/transcript/turn-activity-tail.tsx` | 360 |
| `extension/src/webview/panel/transcript/activity-tail.ts` | 342 |
| `extension/src/webview/panel/transcript/tools/web-search-tool.tsx` | 323 |
| `extension/src/webview/panel/app-body.tsx` | 656 |
| `extension/src/webview/panel/transcript/activity.ts` | 250 |
| `extension/src/webview/panel/transcript/virtual-list-rows.ts` | 249 |
| `extension/src/webview/panel/ui.tsx` | 266 |
| `extension/src/webview/panel/transcript/subagent.ts` | 261 |
| `extension/src/webview/panel/transcript/highlight.ts` | 261 |
| `extension/src/webview/panel/transcript/message-item/hooks.ts` | 237 |
| `extension/src/webview/panel/transcript/tools/ask-user-tool.tsx` | 214 |
| `extension/src/webview/panel/transcript/message-item/content.tsx` | 209 |
| `extension/src/webview/panel/transcript/message-item/inner.tsx` | 205 |
| `extension/src/webview/panel/transcript/message-item.tsx` | 190 |
| `extension/src/webview/panel/transcript/transcript-host.tsx` | 181 |
| `extension/src/webview/panel/transcript/use-buffered-text.ts` | 173 |
| `extension/src/webview/panel/transcript/message-item/reasoning-block.tsx` | 162 |
| `extension/src/webview/panel/transcript/buffered-text-part.tsx` | 157 |
| `extension/src/webview/panel/transcript/pruning-details.tsx` | 152 |
| `extension/src/webview/panel/styles/layout.css` | 146 |
| `extension/src/webview/panel/transcript/use-transcript-scroll-anchor.ts` | 119 |
| `extension/src/webview/panel/transcript/status-chip.tsx` | 118 |
| `extension/src/webview/panel/transcript/pruning.ts` | 111 |
| `extension/src/webview/panel/transcript/index.tsx` | 99 |
| `extension/src/webview/panel/transcript/pruning-inline.tsx` | 97 |
| `extension/src/webview/panel/transcript/pruning-header.tsx` | 96 |
| `extension/src/webview/panel/transcript/header.ts` | 89 |
| `extension/src/webview/panel/transcript/message-item/footer.tsx` | 86 |
| `extension/src/webview/panel/transcript/registry.ts` | 84 |
| `extension/src/webview/panel/transcript/message-equal.ts` | 83 |
| `extension/src/webview/panel/transcript/turn-activity-region.tsx` | 81 |
| `extension/src/webview/panel/transcript/turn-activity-strip.tsx` | 81 |
| `extension/src/webview/panel/transcript/inline-editor.tsx` | 79 |
| `extension/src/webview/panel/transcript/message-item/header.tsx` | 74 |
| `extension/src/webview/panel/transcript/transcript-message-list.tsx` | 72 |
| `extension/src/webview/panel/transcript/scroll-anchor.ts` | 61 |
| `extension/src/webview/panel/transcript/transcript-click-handler.ts` | 62 |
| `extension/src/webview/panel/transcript/rows/message-row.tsx` | 61 |
| `extension/src/webview/panel/transcript/message-item/error-detail.tsx` | 55 |
| `extension/src/webview/panel/transcript/types.ts` | 53 |
| `extension/src/webview/panel/transcript/parts.ts` | 41 |
| `extension/src/webview/panel/transcript/use-collapsible-open.ts` | 38 |
| `extension/src/webview/panel/transcript/subagent-call-context.ts` | 30 |
| `extension/src/webview/panel/transcript/subagent-score-display.ts` | 27 |
| `extension/src/webview/panel/transcript/tools/default-tool.tsx` | 28 |
| `extension/src/webview/panel/transcript/activity-label.tsx` | 20 |
| `extension/src/webview/panel/transcript/register-builtins.ts` | 17 |
| `extension/src/webview/panel/app.tsx` | 17 |
| `extension/src/webview/panel/transcript/rows/top-gap-row.tsx` | 16 |
| `extension/src/webview/panel/transcript/rows/bottom-gap-row.tsx` | 16 |
| `extension/src/webview/panel/transcript/state.ts` | 16 |
| `extension/src/webview/panel/transcript/rows/typing-indicator-row.tsx` | 17 |
| `extension/src/webview/panel/transcript/tools/subagent-tool.ts` | 12 |
| `extension/src/webview/panel/transcript/rows/system-prompts-row.tsx` | 11 |
| `extension/src/webview/panel/transcript/virtual-list-row.tsx` | 10 |
| `extension/src/webview/panel/panel.tsx` | 92 |
| `extension/src/webview/panel/styles/transcript.css` | 1133 |
| `extension/src/webview/panel/styles/tool-call.css` | 766 |
| `extension/src/webview/panel/styles/index.css` | 476 |
| `extension/src/webview/panel/tool-call-summary.ts` | 272 |
| `extension/src/webview/panel/pruning-banner.tsx` | (separate) |
| `extension/src/webview/panel/auto-scroll.ts` | (separate) |

Approx. 13,700 LOC reviewed across ~70 files.

## Notable issues

### Critical
None. Nothing observed that would corrupt data or crash under normal use; the worst issues are performance and maintainability.

### High

- **`transcript-host.tsx:1-6` (stale/misleading doc comment) vs `:144-181` (implementation)** — The file's leading comment claims it renders one `TranscriptView` per open tab path and keeps inactive surfaces "mounted but hidden via visibility:hidden + position:absolute to preserve virtualizer measurements, scroll position, and collapsible state." The implementation renders **only the active surface** (`activeSessionPath && openTabPaths.includes(activeSessionPath)`, line 144) — there is no per-tab mounting, no `visibility:hidden`, no `position:absolute`. The persistence/virtualizer-preservation design described in the comment does not exist. Misleads any maintainer reasoning about scroll/collible state across tab switches. *Verified by reading both the comment and the render block.*

- **`ui.tsx:266` (`export const Composer = memo(ComposerView)`) defeated** — `Composer`'s props include `transcript` (a fresh array reference on every host snapshot, posted ~7/sec while streaming), `postMessage`, and many handler closures. `memo` does a shallow compare, so the new `transcript` ref re-renders `Composer` on every snapshot. The memo is near-useless as wired.

- **`app-body.tsx:218-248, 393-432` — non-memoized subtrees re-render every snapshot** — `PanelMain` and `BottomSection` are plain function components (not `memo`). Host posts a fresh `ViewState` ~7/sec while streaming → `AppBody` re-renders → both subtrees re-render regardless of whether their props actually changed. Combined with `useAppBodyDerivedState` returning a brand-new object literal every call (~line 145), the whole panel subtree re-renders on every streaming delta. Single biggest perf risk in scope.

- **`use-transcript-scroll.ts:1-668` — oversized orchestrator (668 LOC)** — `useSessionResetEffect` takes ~17 positional parameters, `usePaginationTrackingEffect` ~14, `useSmoothAutoFollow` 10. Threading refs through this many positional params is a strong signal it should be a class/instance or a single hook with closures. Any new ref must be threaded through multiple call sites; high maintenance hazard.

- **Two parallel anchor systems with near-identical names** — `scroll-anchor.ts:1-61` (`MessageScrollAnchor` / `captureMessageScrollAnchor` / `restoreMessageScrollAnchor`, DOM-query + `getBoundingClientRect`) vs `auto-scroll.ts` (`ScrollAnchorSnapshot` / `captureScrollAnchor` / `resolveScrollAnchorDelta`, virtualizer-key based). Both serve "pin a row across a height change" but use incompatible representations and are invoked from different code paths (`use-transcript-scroll.ts` pagination vs `use-transcript-scroll-anchor.ts` in-place pin). Confusing and a drift source.

- **`registry.ts:34,53` — silent override, no diagnostics, bare-string keys** — `registerRowRenderer`/`registerToolRenderer` do `map.set` with no `has()` check, no override warning, no return value. 
Tool-name typos (e.g. `'web-serch'`) register/look up against an empty slot with zero compile-time feedback (keys are `string`, not a union). A second registration for the same key silently replaces the renderer.

- **`virtual-list-row.tsx:9` — `return renderer(props) as any;`** — `as any` defeats return-type checking of all registered renderers and hides future signature drift between `RowRendererProps` and individual renderers.

- **`tool-call-card.tsx` (822 LOC) and `tool-call-item.tsx` (550 LOC) — oversized, mixed concerns** — `tool-call-card.tsx` bundles shell tokenizer + summary-model construction + `TerminalOutput` + `ToolCallBody` + a 5-state lifecycle machine. `tool-call-item.tsx` is both the registry dispatch entry AND the subagent renderer (`SubagentBlock`, `SubagentSingleBlock`, `SubagentMessages`, `ScoreBar`, `ModelLabel`, `PrimaryMeta`, `StatusIndicator`, …). Acknowledged in an inline comment (`subagent-tool.ts:6-7`) but not fixed. Both files are strong split candidates.

- **`VirtualRow` not memoized** (`virtual-list.tsx:195-260`) — plain function component receiving a large prop bag (`transcript`, `systemPrompts`, `prefs`, `pruningResult`, `transcriptWindow`, …) whose identities change every snapshot. Every parent render re-renders all visible `VirtualRow` wrappers and re-invokes `renderMessage` / the `useRecovery` loop per visible row per snapshot. No `React.memo`/`useMemo` at the row boundary.

- **CSS: orphaned selectors with zero `*.tsx` references** (verified by grep across `extension/src/webview/panel`):
  - `transcript.css:286` `.activity-status-indicator`
  - `transcript.css:296` `.activity-status-content`
  - `transcript.css:304` `.activity-status-bar`
  - `transcript.css:312` `.agent-activity-indicator`
  - `transcript.css:320` `.typing-indicator` (class; `typing-indicator-row.tsx` uses `activity-status-row` + `TurnActivityRegion` instead)
  - `transcript.css:643` `.message-typing-indicator`

- **`composer.css:4` and `:114` — `.context-window-indicator-anchor` defined twice** — The first (misfiled under the "Run action button" comment block) sets `margin-left: auto`; the second omits it and silently overrides the first. Duplicate + misplaced + behavioral divergence.

### Medium

- **Two `scroll` listeners on the same element** — `use-transcript-scroll.ts` `useScrollEventsEffect` (~line 205) and `use-transcript-scroll-anchor.ts:38-44` each attach their own `scroll` listener to `scrollRef.current`. The anchor hook's `captureAnchor` runs unconditionally on every programmatic scroll produced by the auto-follow rAF loop (it does not gate on `autoFollowRef.current`), doing O(visible+overscan) candidate-building work every frame for nothing during streaming.

- **`scroll-anchor.ts` load-older restore is race-prone** — `requestOlderPage` captures the anchor via `getBoundingClientRect` before the host loads older; `usePaginationTrackingEffect` restores after `loadedStart` decreases. Between capture and restore the virtualizer re-measures rows; `restoreMessageScrollAnchor` does a fresh `querySelectorAll` + `getBoundingClientRect` (forced reflow) and a single `scrollTop += delta`. If the anchored message isn't yet rendered (below the render window after prepend, or its height estimate hasn't settled), `match` is `undefined` and the restore silently no-ops → visible jump. No retry/defer.

- **`auto-scroll.ts` `resolveAutoFollowState` (~line 90) — latent disengage-on-prune** — The content-shrink clamp's "does not falsely disengage" guarantee only holds when the shrink lands within `AUTO_SCROLL_BOTTOM_THRESHOLD_PX` (24px) of the bottom. A shrink above the viewport while the user is mid-transcript clamps `scrollTop` downward → `nextScrollTop < previousScrollTop - epsilon` → auto-follow disenges even though the user never touched the wheel.

- **`tool-call-card.tsx` and `tool-call-item.tsx` — duplicated card chrome** — The card-root className in `web-search-tool.tsx:257-264` repeats verbatim the className in `tool-call-card.tsx:640-649` (`overflow-clip rounded-xl border-l-2 border-l-transparent …`, `forced-colors:border…`, status borders, `tool-call-just-completed`). Two sources of truth for the card look. The `justCompleted` + `prevRunningRef` + `pulseTimerRef` completion-pulse `useEffect` is also re-implemented in `web-search-tool.tsx:226-251` vs `tool-call-card.tsx:602-617`.

- **`handleContextMenu` boilerplate repeated 5+ times** — `const contextType = getToolCallContextType(...); const handleContextMenu = (e) => onContextMenu(contextType, JSON.stringify(toolCall, null, 2), e);` appears in `default-tool.tsx:8-13`, `ask-user-tool.tsx:67-68` (and inline `:84, :158, :210`), `web-search-tool.tsx:213-215` (+ fallback `:198-202`), `tool-call-item.tsx:466-470`, and `SubagentToolRenderer` at `:525-529`. No shared helper.

- **`e as unknown as MouseEvent` double-cast** — `tool-call-card.tsx:663`, `tool-call-item.tsx:394,437`, `ask-user-tool.tsx:84,158`, `web-search-tool.tsx:276`. Papers over a Preact-vs-DOM `MouseEvent` mismatch between the registry's `onContextMenu: (e: MouseEvent) => void` and `TranscriptContextMenuHandler`'s `(type, rawData, e: MouseEvent) => void`. Indicates a props-type mismatch that should be reconciled at the type level.

- **`tool-call-item.tsx:461-471` — effectively dead fallback** — `const Renderer = getToolRenderer(rendererName) ?? getToolRenderer('__default'); if (Renderer) return <Renderer/>;` followed by a fallback `<ToolCallCard .../>`. Since `__default` is always registered by `register-builtins.ts`, the fallback only runs if the registry was never initialized (a broken state that should arguably error, not silently render a card). Either dead code or a hidden error path.

- **`getToolCallPresentation` / `buildToolCallHeaderSummaryModel` recomputed multiple times per render** — `tool-call-card.tsx:580` (unconditional, no `useMemo`), `:619` again, and inside `ToolCallHeader` at `:217` as the `??` fallback. Three layers of summary computation per render.

- **`hasPendingAskUser` O(n) scan every render, unmemoized** (`tool-call-item.tsx:339-342`) — `Object.values(askUserCtx.pendingRequests).some(...)` on every `SubagentSingleBlock` render. With many pending requests and many subagent blocks, quadratic-ish.

- **Pruning *summary* math duplicated ~5×** (the backend-vs-webview duplication premise is mostly false — actual skill pruning lives in `extensions/skill-pruner/`, and message compaction is done upstream by the SDK; the webview only displays payloads). But the "kept X/Y skills · tools · tokens saved" arithmetic is recomputed independently in: host `derivePruningResult` (`extension/src/host/core/projection.ts:88-95`), webview `pruningTotals` (`pruning.ts:81-96`), `formatPruningChipLabel` (`pruning-header.tsx:38-46`), `PruningInlineCard` summaryParts (`pruning-inline.tsx:46-56`), and `PruningBanner` summaryParts (`pruning-banner.tsx:75-82`). The host's `PruningResult` is the source of truth, yet the webview re-derives the same numbers instead of consuming `pruningResult`. Drift risk.

- **`TurnActivityState.phase` and `TurnActivityPhase` — two parallel string unions maintained in two files** — `activity.ts:53-55` vs `turn-activity-strip.tsx:4-10`. They currently match but are not derived from a single source; a new phase in one could silently miss styling in the strip's `activityPhaseHasRunningDot`/`data-phase`.

- **`activity.ts:~120,248` — deprecated path returns an out-of-enum label via cast** — `derivePendingActivityState` returns `label: 'reasoning'` (not in `AGENT_ACTIVITY_LABELS`) for the reasoning-tail branch; `derivePendingActivityLabel` casts `state?.label as AgentActivityLabel`. The deprecated path can return a value violating its declared return type.

- **`message-item/error-detail.tsx:10-55` — error content not announced to SR** — `ErrorDetailWithFallback` renders error text in a plain `<span>` with no `role="alert"`/`aria-live`. The dismiss/copy buttons have titles/aria-labels, but the error content itself is passive to screen readers.

- **`use-collapsible-open.ts:5-6` — module-level global mutable `Map`s** — `collapsibleOpenByKey`/`collapsibleDefaultByKey` are process-global singletons shared across every hook instance and every session. Correctness depends on `clearCollapsibleCache()` being called on session/host change; stale open/closed state can leak across sessions if a caller forgets. Test isolation risk.

- **`turn-activity-region.tsx:~46` `lastTailStateRef` never cleared** — after a turn ends (`state` becomes null) the cached tail-bearing state lingers in the ref for the session. Bounded (one object) and not rendered once collapsed, but an unbounded-lifetime ref surviving across turns.

- **`panel.tsx:44-67,71-78` — `any` casts + innerHTML-built error overlay** — `(options as any).__e`, `(error as any)?.stack`, `postMessage({ ... } as any)` bypass the message union at exactly the error/reporting path. `showRenderErrorOverlay` builds the overlay via `innerHTML` concatenation; `escapeHtml` (line 22) only escapes `& < >` (not `"` / `'`) — currently safe because content lands in `<pre>`/`<p>` text nodes, but a fragile XSS surface if the template is ever restructured. No `role`/`aria` on the overlay.

- **`transcript-host.tsx:115` — `postMessage: (msg: any) => void`** — drops the `WebviewToHostMessage` contract used everywhere else, at the boundary where it matters most.

- **CSS: duplicated rules** — `tool-call.css:54-59` vs `:149-152` (`.tool-call-header` and `.subagent-header` repeat the same sticky rule set + near-identical multi-line `overflow: clip` explanation prose); `tabs.css:683,694,706` (three byte-identical `@keyframes` `session-tab-unread-flash`/`-attention-pulse`/`-attention-idle`, all `0%,100%{opacity:0} 50%{opacity:1}`); `composer.css:756-758` (`.pref-toggle*` explicitly marked "legacy, kept for backward compat" with zero tsx refs — dead weight).

- **CSS: orphaned utility classes** — `index.css` `.transition-defaults` and `.press-effect` have no `*.tsx` references anywhere in the panel tree.

- **CSS specificity/ordering dependence** — `.subagent-header` background is set by three ordering-dependent selectors (`tool-call.css:5,164,177`); collapsed variant needs 3-class+attribute specificity to win. `tabs.css:425-437` active+focus-within re-declares the full `box-shadow` stack plus the focus ring. Fragile under edits.

### Low

- **`message-equal.ts:60-65` — `jsonEqual` uses `JSON.stringify`** — `NaN`/`Infinity` serialize to `null` so `{x:NaN}` would compare equal to `{x:null}`; latent footgun (token/usage counts are integers in practice). Also key-order differences yield spurious inequality (perf only, not correctness).

- **`message-equal.ts:39-58` — completeness is process-guaranteed, not type-guaranteed** — the comparer enumerates fields explicitly; a new top-level `ChatMessage` field would be silently ignored, causing stale renders. Only guarded by a manual test (`test/webview/transcript/messages/message-equal.test.ts:8-15`). No `keyof ChatMessage` exhaustiveness check. (Streaming/tool-call deltas ARE handled correctly — `parts`/`toolCalls`/`userParts`/`usage`/`customDetails` all flow through `jsonEqual`.)

- **`use-transcript-scroll-anchor.ts:18-25` `buildCandidates` skips `size <= 0`** (unmeasured) rows — during initial measurement the topmost rendered row may have size 0, so the anchor captures a later row; the layout-commit re-pin then targets that later row, producing a one-frame offset jump on first settle.

- **`use-transcript-scroll-anchor.ts:47-105` — double-capture per cycle** — layout-commit effect calls `captureAnchor()` unconditionally at the end, *and* the programmatic `el.scrollTop += delta` triggers a `scroll` event which re-runs the listener's `captureAnchor`. Minor wasted work.

- **`rows/message-row.tsx:34` — inert child `key`** — `<MessageItem key={row.message.id}>` is the sole child of the row wrapper; the real key is `key={virtualRow.key}` on `VirtualRow` in `virtual-list.tsx:~290`. Dead code implying a misunderstanding of reconciliation scope.

- **`virtual-list-rows.ts` — constant-string row keys unguarded** — `'system-prompts'`, `'gap:older'`, `'gap:newer'`, `'typing-indicator'` are safe today (each appears at most once) but the row model does not enforce uniqueness; a second `typingIndicator`/`bottomGap` row would collide keys and cause reconciliation reuse across positions.

- **`useRecovery` named with `use` prefix but is a pure function called inside `renderMessage`** (`message-item/footer.tsx:64`) — not a Preact component; the comment acknowledges it, but rules-of-hooks linters will flag it and the naming misleads future editors.

- **`tool-call-item.tsx:523` — inline `import('./registry').ToolRendererProps` as a parameter annotation** for `SubagentToolRenderer` — unusual and fragile; should be a top-level `import type`.

- **`tool-call-card.tsx:355-364` — unchecked structural casts** on `toolCall.result as { details?: { truncation?: … } }` and `toolCall.input as { command?: unknown }` then `as { command: string }`. `ToolCall.result` is loosely typed.

- **`tool-call-item.tsx:425` — `key={index}` for parallel subagent results** — array index as key; if parallel results reorder/retry, reconciliation may misalign state (collapsible open/closed).

- **`ask-user-tool.tsx:162-193` — loading-prompt branches lack `onContextMenu`** while running (`:156`) and completed (`:79`) branches attach it. Right-click copy unavailable in the loading state.

- **`ask-user-tool.tsx:170-171` — `renderMarkdown` called directly in render** (loading branch) while the completed branch (`:71`) uses `useMemo`. Inconsistent; loading path re-parses markdown each render.

- **`tool-call-item.tsx:130,148` — `normalizeTaskScoresForDisplay` called twice per subagent header** (ScoreBar + PrimaryMeta hasScores check); recomputes the same object, unmemoized.

- **`footer.tsx:55` `availableRecoveryByUserId` Map grows unbounded across a session** — one entry per distinct user-message id, cleared only on webview reload (not on session switch). Bounded by # user messages but accumulates in long sessions.

- **`pruning-inline.tsx:96-103` `isPruningDetails` accepts any string for `mode`** — `typeof v.mode === 'string'` lets `'banana'` pass while `PruningDetails.mode` is `'auto'|'shadow'|'off'`. Compare the stricter `pruningMode()` in `pruning.ts:30-32`.

- **`tool-call-card.tsx:78` and `tool-call-summary.ts:30` — mid-file `import` statements** placed after other code rather than at top level.

- **`index.tsx:11-26` — barrel mixes re-exports with a `TranscriptView` component definition** — makes import provenance hard to trace.

- **`subagent.ts:11-17` — re-export shim** preserving `from './subagent'` imports; transitional indirection.

- **`status-chip.tsx:76` / `transcript-click-handler.ts:21` — magic `1200` ms copied-state timeout** duplicated in two files.

- **`inline-editor.tsx:18,38` — magic `240` px fallback and `e.keyCode === 229` legacy IME check.**

- **`header.ts:67` — `formatThinkingLevelLabel('xhigh')` returns `'max'`** — value/label mismatch; consumers display "max" for the `xhigh` level (likely intentional but easy to misread).

- **`interactions.ts:20,26` — `candidate.closest!(…)` non-null assertions** relying on `resolveClosestCapableTarget` invariants; type-unsafe.

- **`use-transcript-scroll.ts:~75, ~405-430`, `use-transcript-scroll-anchor.ts:88-98`, `scroll-anchor.ts:45-57` — `scroll-behavior` save/override/restore pattern reimplemented 4×** with no shared helper.

- **`use-transcript-scroll.ts:~165` — dual positioning ownership** — `useSessionResetEffect` positioning rAF (per-frame `scrollToBottom` for up to 600ms with "2 stable frames" settle check) runs concurrently with `useSmoothAutoFollow`'s rAF which *also* has an `isInitialPositioningRef` snap branch. Both write `scrollTop`/`lastScrollTopRef` in the same window. Both target bottom so they don't fight, but redundant dual ownership.

- **CSS magic numbers (pervasive)** — `transcript.css:235` `64px`/`8px`, `:560` `320px` collapsed-code max-height, `:367-373` `9px` strip font / `40%` min-width, `:519-521` `6px`×`14px` cursor, `:181` `44px` gap row, `:205-211` `32px` jump-latest button. Z-index ladder ad-hoc across files (`10`, `200`, `210`, `240`, `280`, `99999`) with no token; collisions possible.

- **`transcript.css:609` — `aria-expanded` (JS-managed) and `.code-block-collapsed` (CSS-toggled) hand-maintained separately** — consistency is enforced by hand (`transcript-click-handler.ts:38`), not by structure.

- **`turn-activity-tail.tsx` (360 LOC) mixes the tail body renderer with the `useTailConsoleScroll` animation hook** (peak detection, suppression, rAF, layout-effect masking). The hook is independently testable and would be clearer split out.

## Smaller nits

- `registry.ts:65-72` `getRegisteredRowKinds`/`getRegisteredToolNames` have no production callers (test-only per comment) — dead-ish in production.
- `useTranscriptRenderToolCall` (`virtual-list.tsx:~140`) assigns `renderToolCallRef.current = renderToolCall` during render — a render-time mutation; acceptable here but worth noting.
- `app-body.tsx:101-112` `isAskUserHandledInline` `useMemo` lists `transcript` as a dep; since `transcript` is a new ref every snapshot, the memo recomputes (walking the whole transcript via `.some`) on essentially every snapshot anyway — memo's value is limited.
- `ui.tsx:140` `canSend` computed inline each render (not memoized); cheap, but inconsistent with the `attachmentSummary` `useMemo` right above it.
- `transcript-host.tsx:28-35,142` and `panel.tsx:30-37` — long inline `style="…"` strings embed layout in TSX, duplicating values that also live in CSS and evading the design-token system.
- `tool-call-card.tsx:577-660` `ToolCallCard` lifecycle: five `useState` + five timer refs + `completedAtRef` + `renderBodyRef` + three mirror refs + three `useEffect`s — high cognitive load for a collapse animation; the `useEffect` at `:598` has dep `[toolCall.status, isShell]` but reads/writes six refs.
- `transcript.css:337` `.agent-activity-label::after { display: none; }` — `.agent-activity-label` is used but has no `::after` in any tsx; the override is dead.
- `activity.ts:103,130` `assistantPartsFromMessage` called twice on the same assistant message per snapshot (once for tail derivation, once inside `toolCallsFromAssistant`); un-memoized.
- `auto-scroll.ts:~150` `SMOOTH_SCROLL_LARGE_DELTA_SNAP_PX` snap-vs-ease heuristic
 plus per-frame idle gate plus positioning-window snap branch plus inline `scroll-behavior` toggling — correct-as-tuned but extremely brittle; tuned constants (480px threshold, 240px cap, 2 stable frames, 600ms safety timeout) silently shift if row estimates, snapshot cadence, or `useAnimationFrameWithResizeObserver` semantics change. Strong candidate for a behavioral test suite (none visible) before further edits.

## Summary assessment

The transcript rendering is **complex but largely coherent** — not reckless. The virtualization, scroll-anchoring, and message-equality logic is the genuine hard part of a streaming transcript UI and the code shows evidence of tuning to many real past bugs. The main concerns are not correctness bugs but:

1. **Maintainability** — oversized files (`use-transcript-scroll.ts` 668, `tool-call-card.tsx` 822, `tool-call-item.tsx` 550, `app-body.tsx` 656) and duplicated subsystems (two anchor systems, two parallel "collapsible tool card" implementations, `handleContextMenu` boilerplate ×5, completion-pulse ×2, pruning-summary math ×5).
2. **Re-render hot path** — host snapshots ~7/sec produce fresh `transcript`/`ViewState` refs that pierce every `memo` and re-render the entire panel subtree on every streaming delta. `Composer`'s memo is defeated; `PanelMain`/`BottomSection`/`VirtualRow` are not memoized. This is the highest-leverage perf issue in scope.
3. **Type safety at boundaries** — `any` leaks at exactly the error/postMessage boundaries (`transcript-host.tsx:115`, `panel.tsx:71-78`), `as unknown as MouseEvent` double-casts across the tool-call renderer contract, `as any` in `virtual-list-row.tsx:9`, bare-string registry keys.
4. **Stale documentation** — `transcript-host.tsx` leading comment describes a per-tab mounting design that does not exist in the implementation.
5. **CSS hygiene** — 1133-line `transcript.css` mixing ~10 concerns; 6 confirmed orphaned selectors; duplicated rules and prose; ad-hoc z-index ladder; no `!important` abuse (good); `forced-colors` and `:focus-visible` coverage is decent (good).

The backend-vs-webview pruning-duplication premise is **mostly false**: actual pruning decisions live in `extensions/skill-pruner/` (skills/tools, via LLM prepass) and message compaction is done upstream by the SDK. The webview only *displays* pruning payloads. The real duplication is in *summary-math rendering* (5 independent recomputations of the same "kept X/Y" numbers), not in pruning logic itself.

Overall: **bordering on over-engineered** in the scroll/auto-follow subsystem (tuned constants, dual anchor representations, dual positioning loops) and the tool-call card lifecycle, but the complexity is largely earned by real streaming-UI constraints. The clearest wins are: memoize the render boundary (`VirtualRow`, `PanelMain`, `BottomSection`, fix `Composer`'s `transcript` prop), split the two oversized tool-call files, unify the two anchor systems, and de-orphan the CSS.
