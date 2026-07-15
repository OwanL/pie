# Harness benchmarks

Controlled, offline-by-default benchmark definitions for `scripts/experiments/`.

## Layout

- `tasks/<id>/task.json` fixes policy, scoring, allowed changes, and limits.
- `tasks/<id>/fixture/` is the realistic repository slice copied to the target.
- `scorers/private/` holds deterministic hidden-workload scorers resolved only by the controller.
- `recipes/` contains replayable harness treatments.
- `suites/` fixes task matrices and promotion constraints.
- `schemas/` defines durable manifests and results.

The bespoke optimization fixtures intentionally contain generated files, stale documentation, legacy names, incomplete tests, and plausible dead paths. Runtime code and tests provide an authoritative contract. This mess is fixed benchmark input—not license for ambiguous scoring. Only each task's `policy.allowedChangedPaths` may change; edits to generated or unrelated files invalidate the trial.

Public benchmarks provide immediate numeric feedback. Private scorers use unseen deterministic workloads and emit `{ valid, score, metrics }`, with normalized scores from 0 to 1. Validity, resource limits, and changed-file constraints are hard gates.

Runtime identities, worktrees, raw events, and reports stay under git-ignored `data/experiments/`. Paid smoke/full runs require Docker. Each target runs non-root with a read-only root filesystem, dropped capabilities, bounded CPU/memory/PIDs, only its workspace and generated identity mounted, and only an internal Docker network. A separate broker container alone joins an egress network and holds the real Umans credential; the target receives only its expiring token. The evaluator/controller remains trusted host code.

Run only through `npm run experiment:*`. Materialization/capture freezes an immutable copy of benchmark inputs and runner sources before measurements begin. Controller exceptions block the experiment; inspect the journal, then use `npm run experiment:resume -- <id>` to preserve incomplete attempts and resume only missing trial IDs. `npm run experiment:clean -- <id>` removes every trial workspace and worktree while retaining durable evidence; add `--retain-failures` to keep failed workspaces deliberately.

Build the pinned runtime first with `npm run experiment:image:build`; capture records its immutable image digest and runs fail closed if it changes. Run `npm run experiment:calibrate` before paid trials; it verifies deterministic baseline headroom and rejects intentionally invalid implementations for every bespoke task. Use `npm run experiment:status -- <id>` for a snapshot or `npm run experiment:watch -- <id>` to poll a live run. Real Umans requests require `UMANS_API_KEY`; tests use a local fake provider.
