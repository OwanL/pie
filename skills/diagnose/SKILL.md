---
name: diagnose
description: "Use when the user asks for diagnosis/debugging or the cause is genuinely uncertain; not for straightforward fixes with an obvious failing line and remedy."
---

# Diagnose

A discipline for hard bugs. Skip phases only when explicitly justified.

When exploring a codebase, first read its applicable repository instructions (`AGENTS.md` and, when present, `CONTEXT.md`), then follow that repository's documented entry point and relevant docs and structure to build a mental model of the affected modules. Use the vocabulary and patterns established there. When working in pie, start from its curated `docs/INDEX.md` instead of scanning `docs/` directly, read the INDEX-listed docs relevant to the bug, and use the `develop-pie` skill for Pie-specific workflow and references. For other repositories, follow their `AGENTS.md`/`CONTEXT.md`/docs conventions and relevant structure instead; do not assume Pie's docs, filenames, or workflow.

## Phase 1 — Build a feedback loop

**This is the skill.** Everything else is mechanical. If you have a fast, deterministic, agent-runnable pass/fail signal for the bug, you will find the cause — bisection, hypothesis-testing, and instrumentation all just consume that signal. If you don't have one, no amount of staring at code will save you.

Spend disproportionate effort here. **Be aggressive. Be creative. Refuse to give up.**

### Ways to construct one — try them in roughly this order

1. **Failing test** at whatever seam reaches the bug — unit, integration, e2e.
2. **Curl / HTTP script** against a running dev server.
3. **CLI invocation** with a fixture input, diffing stdout against a known-good snapshot.
4. **Headless browser script** (Playwright / Puppeteer) — drives the UI, asserts on DOM/console/network. In pie, run `npm run extension:test:browser` from the repository root. Pass a focused Playwright file after `--` when needed, for example `npm run extension:test:browser -- provider-gate.pw.ts` or `npm run extension:test:browser -- live-races.pw.ts`. Pie's loopback browser server serves the real Preact UI from the VS Code extension host over `127.0.0.1` HTTP/WebSocket (see pie's `docs/BROWSER_SERVER_PLAN.md`). In another repository, use its configured browser/e2e command and documentation.
5. **Replay a captured trace.** Save a real network request / payload / event log to disk; replay it through the code path in isolation. Sanitize before replaying: redact credentials, tokens, and identifiable session paths, stub live endpoints where possible, and run in a disposable environment. If replay could produce side effects (writes, network mutation, session changes), get explicit user confirmation first.
6. **Throwaway harness.** Spin up a minimal subset of the system (one service, mocked deps) that exercises the bug code path with a single function call.
7. **Property / fuzz loop.** If the bug is "sometimes wrong output", run 1000 random inputs and look for the failure mode.
8. **Bisection harness.** If the bug appeared between two known states (commit, dataset, version), automate "boot at state X, check, repeat" so you can `git bisect run` it.
9. **Differential loop.** Run the same input through old-version vs new-version (or two configs) and diff outputs.
10. **HITL bash script.** Last resort. If a human must click, drive _them_ with a small shell script that prompts, captures the result, and feeds it back to you so the loop is still structured.

For visible desktop UI bugs, use the repository's supported UI-driving path and observe before acting; confirm with the user before any side-effectful or destructive input. In pie, route the loop through its `computer` tool (see pie's `docs/COMPUTER-USE.md`) and use screenshot-relative coordinates.

Build the right feedback loop, and the bug is 90% fixed.

### Iterate on the loop itself

Treat the loop as a product. Once you have _a_ loop, ask:

- Can I make it faster? (Cache setup, skip unrelated init, narrow the test scope.)
- Can I make the signal sharper? (Assert on the specific symptom, not "didn't crash".)
- Can I make it more deterministic? (Pin time, seed RNG, isolate filesystem, freeze network.)

A 30-second flaky loop is barely better than no loop. A 2-second deterministic loop is a debugging superpower.

### Non-deterministic bugs

The goal is not a clean repro but a **higher reproduction rate**. Loop the trigger 100×, parallelise, add stress, narrow timing windows, inject sleeps. A 50%-flake bug is debuggable; 1% is not — keep raising the rate until it's debuggable.

### When you genuinely cannot build a loop

Stop and say so explicitly. List what you tried. Ask the user for: (a) access to whatever environment reproduces it, (b) a captured artifact (HAR file, log dump, core dump, screen recording with timestamps), or (c) permission to add temporary production instrumentation. Do **not** proceed to hypothesise without a loop.

Do not proceed to Phase 2 until you have a loop you believe in.

## Phase 2 — Reproduce

Run the loop. Watch the bug appear.

Confirm:

- [ ] The loop produces the failure mode the **user** described — not a different failure that happens to be nearby. Wrong bug = wrong fix.
- [ ] The failure is reproducible across multiple runs (or, for non-deterministic bugs, reproducible at a high enough rate to debug against).
- [ ] You have captured the exact symptom (error message, wrong output, slow timing) so later phases can verify the fix actually addresses it.

Do not proceed until you reproduce the bug.

## Phase 3 — Hypothesise

Generate **3–5 ranked hypotheses** before testing any of them. Single-hypothesis generation anchors on the first plausible idea.

Each hypothesis must be **falsifiable**: state the prediction it makes.

> Format: "If <X> is the cause, then <changing Y> will make the bug disappear / <changing Z> will make it worse."

If you cannot state the prediction, the hypothesis is a vibe — discard or sharpen it.

**Show the ranked list to the user before testing.** They often have domain knowledge that re-ranks instantly ("we just deployed a change to #3"), or know hypotheses they've already ruled out. Cheap checkpoint, big time saver. Don't block on it — proceed with your ranking if the user is AFK.

## Phase 4 — Instrument

Each probe must map to a specific prediction from Phase 3. **Change one variable at a time.**

Tool preference:

1. **Debugger / REPL inspection** if the env supports it. One breakpoint beats ten logs.
2. **Targeted logs** at the boundaries that distinguish hypotheses.
3. Never "log everything and grep".

**Tag every debug log** with a unique prefix, e.g. `[DEBUG-a4f2]`. Cleanup at the end becomes a single grep. Untagged logs survive; tagged logs die.

**Instrument the owning process.** Do not add ad-hoc logging in another layer first. In pie, the distinct roles are the VS Code extension host (application state), embedded Pi backend and worker child processes, passive webview renderer, and separated computer-use sidecar; choose the role that owns the behavior.

**Protect protocol stdout.** In pie, never write instrumentation to the backend's stdout: the host parses it as UTF-8 JSONL protocol records, so a stray `console.log` can corrupt the envelope or terminate the transport. Send backend logs to stderr in the structured `[pie:backend] {json}` envelope with an explicit `level` field (`debug`/`info`/`warn`/`error`; see `extension/src/host/backend/stderr-classifier.ts`) or to pie's credential-redacted log at `%TEMP%\pie-logs\pie.log`.

**Perf branch.** For performance regressions, logs are usually wrong. Instead: establish a baseline measurement (timing harness, `performance.now()`, profiler, query plan), then bisect. Measure first, fix second.

## Phase 5 — Fix + regression test

Write the regression test **before the fix** — but only if there is a **correct seam** for it.

A correct seam is one where the test exercises the **real bug pattern** as it occurs at the call site. If the only available seam is too shallow (single-caller test when the bug needs multiple callers, unit test that can't replicate the chain that triggered the bug), a regression test there gives false confidence.

**If no correct seam exists, that itself is the finding.** Note it. The codebase architecture is preventing the bug from being locked down. Flag this for the next phase.

If a correct seam exists:

1. Turn the minimised repro into a failing test at that seam.
2. Watch it fail.
3. Apply the fix.
4. Watch it pass.
5. Re-run the Phase 1 feedback loop against the original (un-minimised) scenario.

## Phase 6 — Cleanup + post-mortem

Required before declaring done:

- [ ] Original repro no longer reproduces (re-run the Phase 1 loop)
- [ ] Regression test passes (or absence of seam is documented)
- [ ] All `[DEBUG-...]` instrumentation removed (`grep` the prefix)
- [ ] Throwaway prototypes deleted (or moved to a clearly-marked debug location)
- [ ] The hypothesis that turned out correct is stated in the commit / PR message — so the next debugger learns

**Then ask: what would have prevented this bug?** If the answer involves architectural change (no good test seam, tangled callers, hidden coupling), propose investigating the deepening opportunity — use the `codebase-maintenance` skill with the specifics. Make the recommendation **after** the fix is in, not before — you have more information now than when you started.
