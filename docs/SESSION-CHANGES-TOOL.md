# Session-changes tool

**Status:** **Implemented (2026-07-09).** Grill-passed, plan-audited against the live SDK/codebase — compaction non-lossiness, `ReadonlySessionManager` API, the pure derivation core, `resolveBaselineRef`, and subagent-transcript persistence all verified; the §5 toolCall↔toolResult join was under-specified and is now corrected. The code is now authoritative; this doc remains the design rationale. See `extensions/session-changes/` (tool) + `extension/src/shared/file-change-derivation.ts` / `git-baseline.ts` (extracted core). The §8 equivalence test (host `ChatMessage[]` vs extension `SessionEntry[]`) pins option A's "shared logic, not shared value" — its teeth are a subagent call whose separate `toolResult` carries inner transcripts (a) and a failed edit whose `toolResult.isError` is set (b).

A companion to `TOOL-RESULT-PRUNING.md` (same "grill-passed, not-yet-started" category). Sits alongside `session_review` as a second session-introspection tool.

---

## 1. Problem

An agent that just made edits has no first-class way to inspect *what it changed in this session* in a form it can reason over. Existing mechanisms are partial:

- `git diff` is repo-scoped (not session-scoped), lost the moment work is committed, and needs git.
- The `reviewer` subagent sees the *current filesystem state*, not "what this session changed," and only knows the scope if the parent describes it — which, after **history compaction**, the parent may no longer be able to enumerate accurately.
- `session_review` surfaces *transcript* data + open tabs; it does not surface file changes or diffs.

So there is no session-scoped, compaction-surviving change manifest an agent (or a reviewer subagent it feeds) can consume.

### Terminology — "review" is overloaded

- **Change manifest** (inspect) — the set of files a session changed + their diffs. *Data.*
- **Review** (judge) — an assessment of whether those changes are good. *Judgment.*

This tool is a **manifest** tool only. A model judging its own just-made changes in the same context is biased toward the decisions it already rationalised when it wrote them. The high-value composition is **manifest-tool → fresh-context `reviewer` subagent**: the working agent calls this tool, then pastes the compact manifest/diffs into the reviewer's task description. The reviewer never calls the tool (it runs in its own session and gets the manifest in its prompt).

---

## 2. Architecture (option A — new extension, re-derive from JSONL)

A new pi extension `extensions/session-changes/` mirrors `extensions/session-reviewer/` (`registerTool` + a self-contained JSONL reader). It re-derives file changes from the **session JSONL on disk** rather than querying host state at runtime — exactly the precedent `session_review` sets (read-from-disk, self-contained, works for any session file).

### Shared logic vs single source of truth (why A, not B)

This is the subtle point. A shares the **per-tool-call logic** — after extraction, both the host (the changed-files UI's derivation) and the tool call the same core (`deriveFileChangeFromToolCall` + accumulation + subagent recursion). But A does **not** share the **derived value**: the UI reads `archState.fileChanges.bySession` (host derives once, live, from the in-memory `ChatMessage[]` transcript), while the tool **re-derives** from the session JSONL (`SessionEntry[]`). So there are two derivations of the same logical result — same per-tool-call **core**, two traversal adapters (`ChatMessage.toolCalls` vs `SessionEntry.content` parts), two computations.

They are equivalent **in principle**: the derivation is deterministic over the same tool calls, the JSONL is non-lossy (below), and the host already derives from this same upstream source. The residual risk is **drift between the two traversals** — held by an **equivalence test** (derive from a fixture transcript's `ChatMessage` form and its `SessionEntry` form, assert equal `FileChangeEntry[]`).

The alternative that *would* be true single-source-of-truth for the value is **option B**: the host pushes its already-derived `fileChanges.bySession` to the backend (`PIE_FILE_CHANGES`, like `PIE_OPEN_TABS`) and the tool's `list` reads that value — guaranteed identical to the UI, subagents included, no re-derivation, no traversal drift. B was reconsidered specifically for single-source-of-truth and **kept rejected** in favour of A because:

- A **extracts shared logic** — the point of this work; under B the tool wouldn't run the derivation at all.
- A works for **any session file**, not only sessions attached to the host.
- A adds **no host→backend push surface** (B's `PIE_FILE_CHANGES` push would carry the usual env-staleness, same as `PIE_OPEN_TABS`).

Trade-off accepted: A is **shared logic, not a single derived value** — equivalence held by determinism + tests, not by sharing the value. If divergence ever bites (most likely subagent results — see below), revisit B for the `list` tier.

### Subagents

Yes — subagent-made changes are attributed to the **parent** session. The core recurses into subagent results (`deriveFileChangesFromSubagentResult` scans `result.details.results[].messages[].content[]` for `toolCall` parts); the host already uses this in-memory (`tools.ts` `onToolFinished`) so the UI shows files a subagent edited. A `session_changes` call on the parent therefore surfaces subagent changes; a subagent calling it on its own session gets its own session's changes.

*Verify-point (A-specific) — CONFIRMED (2026-07-09):* the persisted JSONL **does** retain the full subagent inner transcripts. Inspecting a real session file, a `{role:'toolResult', toolName:'subagent'}` entry carries `details.results[].messages[]` intact (108 inner messages in the sampled call), each inner message keeping its `content[]` (`toolCall` parts included). Nothing prunes inner transcripts pre-persistence, so re-deriving subagent-attributed changes from JSONL is sound. **But note the JSONL shape (see §5):** the subagent `details` lives on the *separate* `toolResult` entry, not on the assistant's `toolCall` part — the extension adapter must join the two by `toolCallId`. Keep the equivalence test: a fixture with a subagent tool call whose `toolResult` entry carries inner transcripts.

### Compaction is non-lossy for re-derivation

This was the one risk that could have sunk option A, and the SDK code settles it. Compaction does **not** delete prior entries: `session-manager.js` `appendCompaction()` calls `_appendEntry` (append), writing a `compaction` entry that carries a `firstKeptEntryId` **cursor**. The message-builder (lines ~171–204) honours that cursor only when constructing the model's *in-context* messages ("emit kept messages from `firstKeptEntryId`"). The on-disk JSONL **retains every tool-call entry** even after compaction, so re-deriving `fileChanges` from JSONL is non-lossy. (Contrast: the host's in-memory `transcript.bySession` may be windowed/compacted; `fileChanges.bySession` survives only because it's stored separately and re-derived incrementally, not from the truncated transcript. Re-deriving from the full JSONL matches that and is arguably *more* robust.)

---

## 3. Tool shape — one action-based tool

One tool, `session_changes`, with `action: 'list' | 'diff'` — mirroring `session_review`'s `listOpen` / `getTranscript` / `setReview` shape (one registration, one `promptGuidelines` block, discriminated-union schema). The two actions are the same domain (session changes) and `diff` takes a `path` returned by `list`.

```
session_changes { action: 'list', sessionPath? }                     → compact file list + sizes
session_changes { action: 'diff', sessionPath?, path[], context? }   → unified diff text
```

- `sessionPath` (optional) — defaults to the calling session via `ctx.sessionManager.getSessionFile()` (see §5). When provided (a session file path, same convention as `session_review.getTranscript`), targets another session through the same parse path.
- `path` (`diff` only) — **array** of file paths (relative to session cwd, as the manifest reports them). Pass `["path"]` for a single file.
- `context` (`diff` only, optional) — lines of surrounding diff context. **Default `0`** (changes-only); see §4.

---

## 4. Output formats — most-compact, empirically tuned

Goal: **agent-native + compact, no wasted tokens.** An experiment on a real 2-hunk diff transcoded into candidate formats (token estimate = `chars/4`, the SDK's own `estimateTokens` heuristic) settled the choices.

### `diff` action — minified unified diff, default `context=0`

| format | chars | tok | vs raw |
|---|---|---|---|
| A — raw unified diff + header | 412 | 103 | 1.00x |
| B — JSON with diff as escaped string | 488 | 122 | **1.18x worse** (`\n` escaping is pure overhead) |
| C — JSON structured hunks | 404 | 101 | 0.98x (a wash, but loses standard patch format) |
| **D — minified: header + `@@` hunks only** | **315** | **79** | **0.76x — 24% smaller, still standard patch** |

Then the context frontier (minified unified diff, same change):

| context lines | chars | tok | lines |
|---|---|---|---|
| 3 (git default) | 269 | 68 | 18 |
| 1 | 236 | 59 | 14 |
| **0 (changes-only)** | **211** | **53** | **10** |

Conclusions:

1. **Line-oriented text beats JSON** for the diff body — JSON's escaping/syntax is pure overhead here. JSON's only legitimate role is small metadata, not the diff body.
2. **Minified unified diff (D)** wins: drop the 4-line git preamble (`diff --git` / `index` / `---` / `+++`) — our header already carries path+kind, so those lines are redundant noise. Keep `@@` hunk headers (line refs) + diff lines. Standard patch format agents are heavily trained on; never worse than raw, 24% smaller on small/medium diffs.
3. **`context=0` default** is the most compact and still agent-native: git emits the **enclosing function/section label in the `@@` hunk header** (`@@ -2,2 +2,3 @@ export function foo() {`), so the agent keeps *semantic* context, losing only surrounding unchanged lines. `context` param is the escape hatch when surrounding code is needed (or the agent `read`s the file).

Honest caveat: D's 24% win is per-file-fixed (the ~97-char preamble), so for *large* diffs hitting the size cap it's negligible — but D is never worse, and small/medium per-file diffs are the common review case.

### `list` action — TSV

| format | chars | tok | vs table |
|---|---|---|---|
| L1 — line-oriented table | 126 | 32 | 1.00x |
| L2 — JSON array | 206 | 52 | **1.64x worse** |
| **L3 — TSV** | **87** | **22** | **0.69x (31% smaller)** |

TSV is the floor; "table is more legible" was human-aesthetics bias, not an agent-parsing concern (agents parse tab-delimited text fine).

### Concrete output shapes

```
# list  (TSV)
3 +14 -5 (1c/1m/1d)
M	src/widget.ts	+5	-2
A	src/new.ts	+9	-0
D	src/old.ts	+0	-3
```

```
# diff  (minified unified diff, context=0)
M src/widget.ts +5 -2 baseline=abc1234
@@ -2,2 +2,3 @@ export function foo() {
-  const x = 1;
-  return x;
+  const x = 2;
+  const y = 3;
+  return x + y;
@@ -9 +10,2 @@ export function bar() {
-  return a + b;
+  const c = 30;
+  return a + b + c;
```

- **No `details` object** — every byte is review-relevant signal. Truncation is signalled **inline** in the text (`… (truncated, N hunks omitted)`), exactly like `session_review`'s inline truncation markers.
- **Size budget** (mirrors `session_review`'s `MAX_MSG_CHARS` / `MAX_TOTAL_CHARS`): per-file ~8 KB, total ~32 KB, with inline truncation notices + remaining-hunk counts. The tool self-caps (primary control); tool-result pruning would only strip ANSI and we pass `--no-color`, so near-zero effect — no conflict.

---

## 5. Own-session default & the extraction boundary (refinements from digging into `ctx`)

Two things the grilling surfaced by cross-referencing the SDK:

### Own session is auto-available

`ExtensionContext.sessionManager` (a `ReadonlySessionManager`) exposes `getSessionFile()` / `getSessionId()` for the *calling* session. So `sessionPath` defaults to `ctx.sessionManager.getSessionFile()` — **no param needed for "review my own changes."** Since compaction appends (§2), parsing that JSONL is non-lossy. (Alternative `ctx.sessionManager.getEntries()` is live/in-memory but its compaction-completeness is unverified; prefer parsing `getSessionFile()` for certainty, matching the `session_review` read-from-disk philosophy. `getEntries()` is a future optimisation for live/mid-stream use.)

### The shared extract is the per-tool-call core, not the ChatMessage-typed wrapper

`deriveFileChangesFromTranscript(transcript: ChatMessage[])` is typed for pie's `ChatMessage[]` (tool calls as a top-level `toolCalls[]` array). But SDK `SessionEntry[]` / JSONL stores tool calls as `{type:'toolCall', name, arguments}` parts *inside `message.content`*. So "extract the derivation" cannot mean the ChatMessage-typed wrapper.

The good news: the **per-tool-call core** — `deriveFileChangeFromToolCall`, `deriveFileChangesFromToolCall`, `accumulateFileChange`, `deriveFileChangesFromSubagentResult` (+ helpers `computeLineStats` / `extractFilePath` / `looksLike*` / `describeEdit`) — is already generic over `{id, name, input}`. And `deriveFileChangesFromSubagentResult` *already* traverses `content[]` parts for `type==='toolCall'`. So the refined extraction is: **extract that core** (output type `FileChangeEntry` from `shared/protocol`, deps `shared/type-guards` + the shell-deletion parser — all pure). Each side keeps a thin traversal adapter:

- **Host** — `deriveFileChangesFromTranscript(ChatMessage[])` stays in `host/core/`, traverses `message.toolCalls`, calls the shared core. Existing host callers (`attach.ts`, `tools.ts`) keep their import paths unchanged.
- **Extension** — `deriveFileChangesFromSessionEntries()` plus a minimal JSONL reader (`getSessionFile()` lines → entries), extension-local (it needs tool-call *inputs*, so it cannot reuse `session-reviewer/src/transcript.ts`, which renders to compact `Turn[]` and drops inputs).

**Adapter caveat — the JSONL is *not* a merged `ChatMessage`.** This is the one place the two forms genuinely diverge, and it makes the extension adapter more than a content-parts scan. pie's `ChatMessage.toolCalls[]` is a **merged** view: each `ToolCall` is `{id, name, input, result, status}` — pie joins the assistant's tool call with its later result. The raw JSONL (`SessionEntry[]`) does **not** merge; it stores two separate entries:

  - assistant content part `{type:'toolCall', id, name, arguments}` — carries the **inputs** as `arguments` (not `input`), but **no** `result`/`status`;
  - a separate `{role:'toolResult', toolCallId, toolName, content, details, isError}` entry — carries the **result** (subagent inner transcripts live in its `details`, mapping to the core's `result.details`) and the error flag.

  So `deriveFileChangesFromSessionEntries()` is a **two-pass join keyed by `toolCallId`**, not a single content-parts scan: (1) index `toolResult` entries by `toolCallId`; (2) walk assistant `toolCall` parts, mapping `arguments`→`input`, skipping calls whose joined `toolResult.isError` is set (the JSONL equivalent of the host's `tool.status === 'failed'` skip), and — for `subagent` calls — feeding the joined `toolResult.details` object to `deriveFileChangesFromSubagentResult`. A plain content-parts scan alone would silently drop all subagent-attributed changes and include failed edits. This join is the substantive difference the equivalence test must pin.

### Composition

Working agent finishes a turn → calls `session_changes { list }` then `session_changes { diff, path }` on its own session → pastes the compact manifest/diffs into the `reviewer` subagent's task. The reviewer reasons over the manifest in a fresh context; it does not call the tool.

---

## 6. Edge cases

- **Non-git / untracked.** `list` is pure derivation (no git) → works anywhere. `diff` needs git; `resolveBaselineRef` falls back to `'HEAD'`. If no baseline resolves (untracked file, non-git repo), emit the stat header + inline note `no git baseline; use read to view` instead of a diff body. Never error.
- **Created files.** Diff vs empty → full content as additions. Cap (per-file budget); over-cap → truncate + line count. (For very large created files the agent is better served by `read`; the cap prevents a whole-file dump.)
- **Deleted files.** Removed lines as deletions (the old content), capped the same way.
- **Multi-commit-same-file** (the documented `resolveBaselineRef` limitation). The git baseline walks to the commit *before the last change*, so `diff` shows only the final delta while `list` stats are session-cumulative — a `+50 -2` (list) vs `+5 -2` (diff) mismatch. The diff header flags this; future enhancement = snapshot the session-start ref so the diff spans the whole session's churn. Surfaced honestly, not hidden.

---

## 7. Extraction plan

Two shared extractions (to `extension/src/shared/`, importable by extensions via relative path — precedent: `extensions/ask-user/src/types.ts` re-exports from `../../../extension/src/shared/…`):

1. **Derivation core** — lift `deriveFileChangeFromToolCall` + `deriveFileChangesFromToolCall` + `accumulateFileChange` + `deriveFileChangesFromSubagentResult` (+ helpers) out of `host/core/file-change-derivation.ts` into `extension/src/shared/file-change-derivation.ts`. Also lift `shell-deletion-parsing.ts` (its only non-`shared/` dep). Host keeps a thin `deriveFileChangesFromTranscript(ChatMessage[])` wrapper in `host/core/` that traverses `message.toolCalls` and delegates to the shared core — host callers unchanged.
2. **Git-baseline walk** — extract `resolveBaselineRef` / `differsFromCommit` / `execGit` out of `FileDiffService` (currently vscode + `ArchState` coupled) into a host-agnostic pure-node helper in `extension/src/shared/`. The host's `FileDiffService` imports it (its `openFileDiff` keeps the vscode `toGitUri`/`diff` wiring); the extension's `diff` action calls it + runs `git diff <baseline> --no-color --unified=<context> -- <file>` and minifies the output (drop the 4-line preamble).

Extension-local (not shared):
- A minimal JSONL reader + a `SessionEntry`→tool-call **join** in `extensions/session-changes/src/` — index `toolResult` entries by `toolCallId`, then walk assistant `toolCall` parts (mapping `arguments`→`input`, skipping `isError` results, feeding joined `details` to the subagent recursion). This is the substantive divergence from the host's already-merged `ChatMessage[]` (see §5 adapter caveat); it needs tool-call inputs, so it's distinct from `session-reviewer/src/transcript.ts`.
- TSV/minified-diff renderers + the inline-truncation budgeting (mirrors `session_review`'s `MAX_MSG_CHARS` / `MAX_TOTAL_CHARS`).

Build/test wiring mirrors `session-reviewer`: `package.json` (`pi.extensions: ["./index.ts"]`), `tsconfig.json` typecheck gate, `types-global.d.ts`, tests under `extensions/session-changes/test/`, and registration in `scripts/run-tests.mjs` + `extension/package.json`'s `extensions:test` / `extensions:typecheck`.

`list` totals can be computed inline (~10 lines) or by sharing `file-changes-stats.ts` (pure webview helpers) — prefer inline to avoid coupling the extension to webview modules.

---

## 8. Open questions / future

- **Equivalence test (A's single-source mitigation)** — pin that deriving from a fixture transcript's `ChatMessage` form (host path) and its `SessionEntry`/JSONL form (tool path) yields equal `FileChangeEntry[]`. The JSONL fixture must exercise the toolCall↔toolResult **join** (§5): (a) a subagent tool call whose *separate* `toolResult` entry carries inner transcripts (covers the §2 subagent path), and (b) a **failed** edit whose `toolResult.isError` is set (must be skipped, matching the host's `status==='failed'` skip). If a plain content-parts scan were used instead of the join, (a) drops all subagent changes and (b) leaks a failed edit — so these two cases are the test's teeth. This is what holds A's "shared logic, not shared value" together; if it can't be made to pass for some shape, that's the signal to revisit B for `list`.
- **Session-start ref snapshot** — the real fix for the multi-commit-same-file limitation: record the git ref at session start and diff against it for true whole-session churn. Out of scope for v1 (documented limitation instead).
- **`getEntries()` live path** — for mid-stream / live review, prefer `ctx.sessionManager.getEntries()` over parsing `getSessionFile()` JSONL; verify it returns the full path including pre-compaction entries first.
- **`sessionPath`-for-other-sessions as core** — currently secondary (the working-agent→reviewer composition avoids needing it). If a reviewer subagent ever needs to call the tool directly on another session, the JSONL reader already supports it via `sessionPath`; no design change, just a richer parser if inputs are needed across sessions.
- **Richer JSONL parser sharing** — if `session_review` later wants tool-call-input-level parsing (not just `Turn[]` rendering), lift the extension-local JSONL reader to `shared/` and have both consume it. YAGNI for now.

---

## 9. References

- `extension/src/host/core/file-change-derivation.ts` — the derivation to extract (pure; generic per-tool-call core + ChatMessage wrapper).
- `extension/src/host/core/file-diff-service.ts` — `resolveBaselineRef` / `differsFromCommit` / `execGit` to extract; `openFileDiff` keeps vscode wiring.
- `extension/src/host/session-service/handlers/tools.ts` (`onToolStarted`/`onToolFinished`) + `attach.ts:199` — host-side incremental + on-attach derivation call sites (unchanged by this work).
- `extensions/session-reviewer/index.ts` + `src/transcript.ts` + `src/store.ts` — the extension template (registerTool shape, JSONL read-from-disk, self-contained).
- `extensions/ask-user/src/types.ts` — precedent for extension→`extension/src/shared/` relative imports.
- `extension/src/backend/session-review-store.ts` + `backend/request-handler.ts` (`PIE_OPEN_TABS`) — the host→backend env-push precedent (option B, rejected here).
- `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` — `ExtensionContext.sessionManager` (`ReadonlySessionManager`: `getSessionFile` / `getSessionId` / `getEntries`).
- `@earendil-works/pi-coding-agent/dist/core/session-manager.js` `appendCompaction` → `_appendEntry` — compaction appends a cursor, doesn't delete (non-lossiness proof, verified). JSONL persists tool calls and results as **separate** entries: an assistant `{type:'toolCall', id, name, arguments}` content part and a sibling `{role:'toolResult', toolCallId, toolName, content, details, isError}` entry — the source of the §5 join (verified against real session files, incl. `details.results[].messages[]` retained for subagent calls).
- `docs/ARCHITECTURE.md` §2 (CQRS/Elm MVI), §7 (state ownership — `fileChanges` is ArchState), §8 (extension points).
- `docs/STATE_CONTRACT.md` § Webview-Local State (changed-files rail peek/pin is webview-local; this tool is host/backend-side and unaffected).
- `AGENTS.md` — context-lean terminology (history compaction / skill pruning / tool-result pruning); this tool is none of those, but its output is subject to tool-result pruning (no conflict — `--no-color`).
