# Harness benchmarks

Controlled, offline-by-default benchmark definitions for `scripts/experiments/`.

## Layout

- `tasks/<id>/task.json` fixes policy, scoring, allowed changes, and limits.
- `tasks/<id>/fixture/` is the realistic repository slice copied to the target.
- Tasks may declare benchmark-owned `resources.extensions` and `resources.skills`; paths resolve from the task directory but must remain inside the frozen benchmark tree, and the controller copies only those resources into the isolated bundle for both treatments. Custom extension tool names must also appear in `policy.allowedTools`.
- `scorers/private/` holds deterministic hidden-workload scorers resolved only by the controller.
- `recipes/` contains replayable harness treatments. A recipe may declare `apply.sourcePaths` to freeze repo-local extension dependencies beside the benchmark snapshot, `apply.bundlePaths` to mount them into the isolated treatment bundle, and a benchmark-only `settingsFile`; all paths are copied before target execution.
- `suites/` fixes task matrices and promotion constraints.
- `schemas/` defines durable manifests and results.

The bespoke optimization fixtures intentionally contain generated files, stale documentation, legacy names, incomplete tests, and plausible dead paths. Runtime code and tests provide an authoritative contract. This mess is fixed benchmark input—not license for ambiguous scoring. Only each task's `policy.allowedChangedPaths` may change; edits to generated or unrelated files invalidate the trial.

Public benchmarks provide immediate numeric feedback. Private scorers use unseen deterministic workloads and emit `{ valid, score, metrics }`, with normalized scores from 0 to 1. Hidden cases run in bounded child processes so candidate nontermination becomes a deterministic zero-score task failure rather than a censored trial.

Correctness and score eligibility are deliberately separate. Policy violations, timeouts, invalid solutions, and failed checks are primary benchmark outcomes: they reduce pass rate and may score zero, but are not discarded. Only failures that compromise measurement integrity—provider isolation violations, malformed events, missing startup attestation, controller/process failure, genuine provider failure, or scorer artifact overflow—are diagnostic-only. This prevents survivorship bias while preserving changed-file and resource limits as hard pass/fail gates.

Runtime identities, worktrees, raw events, and reports stay under git-ignored `data/experiments/`. The broker records request and token usage but does not cap either; agents may continue until completion within the trial's wall-clock liveness limit. Paid smoke/full runs require Docker. Each target runs non-root with a read-only root filesystem, dropped capabilities, bounded CPU/memory/PIDs, only its workspace and generated identity mounted, and only an internal Docker network. A separate broker container alone joins an egress network and holds the real Umans credential; the target receives only its expiring token. The evaluator/controller remains trusted host code.

Run only through `npm run experiment:*`. Materialization/capture freezes an immutable copy of benchmark inputs and runner sources before measurements begin. Controller exceptions block the experiment; inspect the journal, then use `npm run experiment:resume -- <id>` to preserve incomplete attempts and resume only missing trial IDs. `npm run experiment:clean -- <id>` removes every trial workspace and worktree while retaining durable evidence; add `--retain-failures` to keep failed workspaces deliberately.

Build the pinned runtime first with `npm run experiment:image:build`. Capture freezes the runtime digest and automatically calibrates the frozen suite; runs fail closed when either attestation is absent or inputs drift. `npm run experiment:calibrate` remains available as a preflight check.

A source-of-truth reference run uses the full frozen suite, both declared models, the default three repetitions, randomized paired order, and concurrency one. It must first pass the smoke gate. Smoke trials use distinct IDs and are excluded from the full analysis matrix, so the reference is not conditioned on favorable preflight outcomes. Accept it as a reusable reference only when every planned trial completed, every pair is primary-eligible, no provider/security integrity failure occurred, and the report and representative failures received human review. The comparison is paired and inferential: pass/fail uses an exact McNemar discordance test, while score uses a deterministic paired sign-randomization test. A score direction is actionable only when its two-sided p-value is at most 0.05 and its absolute mean delta is at least 0.03; complete integrity-valid comparisons without an actionable pass or score direction are `neutral`. This avoids declaring a stochastic no-op regression from an untested point estimate. It does not replace the contemporaneous matched baseline in a later experiment: provider/model drift makes historical scores context, not an unpaired control. Never repair or rerun individual completed outcomes; create a fresh experiment ID after harness changes.

Use `npm run experiment:status -- <id>` for a snapshot or `npm run experiment:watch -- <id>` to poll a live run. Real Umans requests require `UMANS_API_KEY`; tests use a local fake provider.
