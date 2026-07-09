# Task: Add a transparent, segment-aware search-pruning guard to the warm-bash extension

## Problem
The workspace holds ~510k files (~98% node_modules in twin-api/twin-ui). Raw
`grep -r`/`find .` run via the `bash` tool traverse all of them:
  - `grep -rn PAT .`      → hangs >120s (times out)
  - `find . -name '*.ts'` → 6–77s
Dedicated `grep`/`find` tools already use `rg` (gitignore-aware, fast), but agents embed
search INSIDE compound bash (echo headers + find + grep + fallback chains), which no
dedicated tool can express. So bash itself must be fast. Fix: transparently rewrite the
bash command string to inject exclusions approximating what rg/.gitignore apply — zero
agent awareness (no banners, no AGENTS.md notes).

Note: this is an approximation, not exact parity with rg. rg's exclusions are dynamic,
derived per-repo from actual `.gitignore` contents (nested files, global excludes, etc).
This guard uses one static hardcoded prune-dir list (see Behavior §1). The two will
diverge in both directions — e.g. twin-api's `.gitignore` also lists `typings/`,
`.grunt`, `lib-cov`, `bower_components` (not in our static list), while our list adds
`.venv`/`.turbo`/`.moon` for other repos in the workspace that twin-api doesn't use.
That's an accepted trade-off (deriving the list from `.gitignore` at rewrite time would
defeat the "cheap regex rewrite" design) — do not claim exact parity in code comments or
docs, just "approximates."

## Decision (made + experimentally validated)
Direction B: make bash find/grep ignore certain dirs. Implement as a segment-aware
command-string rewriter in the warm-bash extension.

## Location
File: extensions/warm-bash/src/operations.ts
Function: createWarmBashOperations → returned exec(command, cwd, opts).
Insert the rewrite as the FIRST thing in exec(), BEFORE `const c = classify(command);`,
reassigning `command`. Operating pre-classify covers all three layers (fast/warm/fallback)
consistently and lets cd-peel + marker protocol proceed on the rewritten string.

## Gate
Env `PIE_BASH_AUTO_PRUNE` (default "1" = on; "0" = skip rewrite entirely, preserving the
"never worse than status quo" guarantee).

**Read it the same way every other `PIE_BASH_*` flag in this file is read — NOT cached at
module load.** Checked `index.ts`: `poolSize()`, `fastPathEnabled()`, `shellPath()`, etc.
are all small functions invoked fresh on every `getTool()` call via `currentConfig()`,
which is what lets `toolConfig` diffing hot-reload settings without a restart. Add
`autoPruneEnabled()` as the same kind of function, thread it through `WarmBashOpsOpts`
(like `fastPathEnabled`) rather than a module-scope constant in operations.ts. This keeps
it live-toggleable via settings like its siblings, and keeps it trivially unit-testable
(pass a boolean via opts in tests instead of mutating `process.env` + re-importing).

Also gate on a **runtime GNU-grep capability probe** (see FIX #3) — auto-prune should be
effectively off (grep segments passed through) on non-GNU grep even if the env var is "1".

## Behavior
Split the command into top-level segments on `;` `&&` `||` `|` `&` and newlines —
QUOTE / backtick / `$(…)` / PAREN aware (never split inside those), AND heredoc-aware
(see FIX #5 — detect a heredoc anywhere in the command and passthrough the whole thing
before attempting to split). For each segment, peel leading `VAR=val` assignments, then:

1. **grep/egrep/fgrep**, recursive (`-r`/`-R`, incl. combined `-rnI`), NOT already carrying
   `--exclude-dir=node_modules`, AND only when the runtime grep is confirmed GNU (FIX #3):
   → inject exclude flags IMMEDIATELY AFTER the program token (pipe-safe):
     `grep --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.venv
       --exclude-dir=dist --exclude-dir=build --exclude-dir=.next --exclude-dir=coverage
       --exclude-dir=.turbo --exclude-dir=.moon -rn PAT .`
   → Safe for explicit node_modules paths: GNU grep's --exclude-dir prunes only during
     recursive descent, not explicitly-passed paths (verified identical results).

2. **find** with bare path (`.`/`./`/absent), NO action
   (-print/-print0/-printf/-exec/-execdir/-ok/-delete/-ls/-quit/etc), NO existing -prune,
   NO global option (-maxdepth/-mindepth/-mount/-xdev/-follow/-regextype/etc), NO shell
   operators in the segment, AND the expression does NOT reference a prune-dir by name
   (`-name`/`-iname`/`-path`/`-ipath` node_modules|.git — see FIX #2, include the
   case-insensitive variants too):
   → `find . \( -name node_modules -o -name .git \) -prune -o \( <expr> \) -print`
     (wrap user expr in `\( … \)` to preserve OR-chain precedence, append -print).
   → Verified byte-identical to explicit `-path '*/node_modules' -prune` (4/4).

3. **Everything else** (rg, scoped `find src …`, find with actions/-prune/globals,
   already-excluded grep, `xargs grep ...` — first token isn't grep/find so it won't
   match, known accepted gap — search inside `$(…)`): PASSTHROUGH unchanged.

Reassemble segments (see FIX #1 — byte-preserving). Conservative: when in doubt, passthrough.

## FIX #1 (Critical) — byte-preserving reassembly; do NOT normalize
Do NOT rebuild the command with normalized ` ${op} ` separators, and do NOT convert
newlines to `;`. That breaks control structures (`for … do\n grep\n done` → `do ; …`
syntax error) and swallows trailing `#` comments (`grep … # note\n echo` → echo lost).

**Important**: the reference prototype's `splitSegments` already violates this — it has
`if (c === "\n") { flush(";"); continue; }`, which discards whether the original
separator was a newline or a semicolon at the *splitting* stage, before reassembly even
happens. Do not just patch `guard()`'s join logic and call FIX #1 done — `splitSegments`
itself must be rewritten to track `[start,end)` byte offsets per segment (or otherwise
retain the literal original separator text), so reassembly has something faithful to
splice back.

Instead:
  - Track original segment [start,end) offsets and splice ONLY changed segment substrings
    back in place, leaving every other byte (operators, newlines, whitespace) identical.
  - Additionally, PASSTHROUGH the ENTIRE command (no rewrite) if it contains a `#` comment
    or any shell control keyword (for/while/until/if/then/case/do/function) — conservative.
    Match these against the **quote-stripped** command (mirror classifier.ts's own
    `stripped = rest.replace(QUOTED, "")`) using **word-boundary regex** (`\b(for|...)\b`),
    not a naive substring/`includes` check. A naive check would false-trigger on
    `grep -rn foreach .` or `grep -n '#include' file.c` — safe (just passthrough) but
    quietly kills the optimization for common real searches, so get this precise rather
    than maximally lazy.
  - Known accepted coverage gap: this blanket keyword rule means loops
    (`for f in $(find ...); do grep ...; done`) — a common agent batch pattern — are
    never rewritten. That's fine (conservative-by-design), but don't assume the
    validation targets below (measured on bare single commands) generalize to
    loop-wrapped searches; say so if reporting results.
This restores the "never worse than status quo" guarantee for multiline/compound commands.

## FIX #2 (Critical) — don't defeat explicit prune-dir searches
`find . -name node_modules` (or `-iname`/`-path`/`-ipath` equivalents) must NOT be
rewritten (the prune branch would match and yield zero results). If a find segment's
expression references node_modules/.git via any of these four flags, PASSTHROUGH.

## FIX #3 (Critical — upgraded from Moderate) — GNU-grep assumption
`--exclude-dir` + "explicit path not pruned" are GNU-grep semantics (true on this box:
Git Bash = GNU grep). A BSD grep (macOS default) or busybox/minimal-container grep lacking
`--exclude-dir` would **ERROR the command outright** — strictly worse than status quo, not
just "not faster." An env var the user has to discover after something breaks is not an
adequate safety net for a stated "never worse than status quo" invariant.

Mitigation: probe grep's flavor at runtime once per process (`grep --version`, check for
"GNU grep" in the output — or a cheap `grep --exclude-dir=x -r . /dev/null 2>&1` no-error
probe as a fallback if `--version` parsing is fragile cross-platform), cache the boolean,
and gate the grep injection on it (independent of the env var, which remains an
additional manual override). Document the GNU-grep dependency in a code comment near the
injection either way.

## FIX #4 (Moderate) — GNU-grep assumption doc note
(superseded by FIX #3 above — keep only as a code comment reminder near the injection
site, not as the sole mitigation.)

## FIX #5 (Critical, new) — heredocs must short-circuit the whole rewrite
`classify()` already has an explicit `HEREDOC` check (`/<<-?\s*['"]?\w/`) and bails to
`"shell"` before doing further parsing — because a heredoc body is unquoted text that can
contain `;`, `&&`, arbitrary newlines, and even literal substrings that look like
`grep -rn foo .` (e.g. an agent doing `cat <<'EOF' > script.sh ... EOF` to write a file).
The segment splitter has NO heredoc awareness. Left unguarded, it could mis-split a
heredoc body (corrupting a generated file) or, worse, pattern-match and rewrite text
*inside* a heredoc that was never meant to execute.

Mitigation: run the same heredoc detection `classify()` uses (or reuse its regex) as the
very first check in the guard, BEFORE any segment splitting is attempted. If detected,
passthrough the entire raw command unchanged. Add this as an explicit test case (see
Tests below) — do not rely on FIX #1's keyword/comment passthrough to accidentally catch it.

## Transparency & logging (FIX #6 — plumbing, was FIX #4)
- NO output/banner reaches the agent; only fast, correct results.
- operations.ts has no `pi`/logger today. Thread a `log?: (payload) => void` callback into
  WarmBashOpsOpts (wired from index.ts) and log each rewrite with the repo's established
  pattern — `console.error(JSON.stringify({ source: "pie:warm-bash:auto-prune", before, after }))`
  (match the existing `source: "pie:<name>"` prefix convention used in
  extensions/subagent/runner.ts — the earlier draft's `"warm-bash:auto-prune"` ordering
  was inconsistent with that precedent). Reaches the pie OutputChannel, NOT the tool
  result. Note: this logs full before/after command text, which may include sensitive
  search patterns/paths — same trade-off existing logging already accepts elsewhere, not
  a new category of risk, but worth a one-line acknowledgment in the comment.

## Why this is safe
Dropping node_modules/.git/etc. approximates what rg and the dedicated grep/find tools
return (they respect .gitignore; we use a static superset list — see Problem note above),
so bash search becomes close to CONSISTENT rather than surprising, not byte-for-byte
identical. Genuine node_modules searches still work (explicit grep path unaffected;
explicit find -name passthrough per FIX #2). Overridable via env; further gated by a
GNU-grep runtime probe (FIX #3) so non-GNU environments never get a broken grep.

## Reference implementation (core validated 15/15)
  local_utils/bash-guard-segment.mjs   (splitter + per-segment rewriters + battery)
  local_utils/find-correctness.sh      (ground-truth correctness + speed proof)
Port to TypeScript in operations.ts, reusing classifier.ts tokenize/unquote where
possible. NOTE: the prototype's `guard()` reassembly is NOT correct as-is, AND its
`splitSegments` normalizes `\n` → `;` at the splitting stage — apply FIX #1 (rewrite
splitSegments to track raw offsets, byte-preserving splice) rather than porting either
function verbatim. Keep the quote/backtick/$()/paren-aware scanning logic, incl. the
"grep inside $() not rewritten" case, but add heredoc detection (FIX #5) as a pre-check
the prototype doesn't have.

## Validation targets
  - grep -rn PAT .      : >120s → 0.88s  (>200×)
  - find . -name '*.ts' : 6–77s → 1.4s   (~55×)
  - find rewrite 4/4 byte-identical to explicit-prune ground truth
  - segment battery 15/15 + the new FIX cases below
  - These targets are measured on bare single commands; loop-wrapped searches
    (for/while around grep|find) are out of scope per FIX #1 and won't show this win —
    don't imply otherwise when reporting results.

## Tests to add (extensions/warm-bash/test/, node:test style — match classifier.test.ts)
  - Port the 15-case battery + 4 find correctness cases (run find in a temp tree with a
    node_modules dir; assert output identical to explicit prune).
  - FIX #1 regressions (MUST pass): multiline `for … do\n grep\n done` unchanged/valid;
    `while`/`if…then…fi`; trailing `# comment` before a newline+command not swallowed;
    byte-identical passthrough when no segment changes; word-boundary check does NOT
    false-trigger passthrough-detection tests for `grep -rn foreach .` and
    `grep -n '#include' file.c` (these SHOULD still get rewritten, not passthrough).
  - FIX #2: `find . -name node_modules` AND `-iname`/`-path`/`-ipath` node_modules/.git
    variants → passthrough.
  - FIX #3: mock/stub the GNU-grep probe both ways — non-GNU detected → grep segments
    passthrough even with PIE_BASH_AUTO_PRUNE=1.
  - FIX #5: heredoc anywhere in the command (`cat <<'EOF' ... EOF` containing a literal
    `grep -rn foo .`-looking line) → entire command passthrough, byte-identical.
  - Env-gate: PIE_BASH_AUTO_PRUNE=0 → no rewrite. Confirm it's read as a function/opts
    field (live-toggleable), not a module-load-time constant — test by constructing
    `createWarmBashOperations` twice with different opts in the same process, no
    re-import needed.

## Out of scope (do NOT do)
  - Do NOT touch the dedicated grep/find tools.
  - Do NOT add AGENTS.md / convention notes.
  - Do NOT rewrite rg, `ls -R`, du, or globstar (du --exclude is a follow-up).
  - Do NOT rewrite find segments with actions/-prune/globals/shell-ops, commands with
    control keywords/comments/heredocs, or `xargs grep ...` — passthrough.
  - Do NOT attempt to derive the prune-dir list from actual `.gitignore` contents — the
    static list is an accepted approximation (see Problem note); real `.gitignore`
    parsing is future scope if the drift ever matters in practice.

## Build/verify
Build & test the warm-bash extension (NOT extension/ — that's the VS Code GUI). Use the
**repo's actual test runner**, not an ad-hoc `node --test` invocation — `run-tests.mjs`
applies a package-level coverage gate for warm-bash (90% lines / 77% branches):

```bash
cd C:/Users/OwanLazic/Documents/GitHub/pie
npm run test -- --package warm-bash
```

This new logic (splitter rewrite, 3 rewrite rules, 5 FIXes incl. heredoc/keyword/GNU-probe
bailouts) adds substantial branching — if coverage falls short, add tests to hit the
threshold rather than silently lowering it; only bump the threshold in
`scripts/run-tests.mjs`'s `PACKAGE_CONFIGS` entry for `warm-bash` if a specific branch is
genuinely untestable (documented with a comment, matching the pattern already used for
other packages' threshold notes in that file).

Then confirm in a real session: `grep -rn foo .` in twin-api returns fast with correct
(source-only) results and no visible indication of rewriting; a multiline `for` loop
containing grep still runs correctly and unmodified; and a heredoc containing a
grep-looking literal string is not touched.
