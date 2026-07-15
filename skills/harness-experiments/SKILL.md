---
name: harness-experiments
description: Create, resume, execute, and compare controlled pie harness experiments through the repo-local benchmark scripts. Use for falsifiable baseline-versus-candidate harness evaluations; not for ad-hoc tests or UI evaluation.
---

# Harness experiments

Use scripts as the enforcement plane. Never manually spawn a target agent or pass credentials into its environment.

## Start or resume

1. Run `npm run experiment:status -- <id>`. While a run is active, use `npm run experiment:watch -- <id>` for a polling view of the PID, current trial/model/treatment, completed/remaining counts, last event/tool, request counts, and update time.
2. Read `data/experiments/<id>/experiment.json` and `journal.md` before editing.
3. Run `npm run experiment:image:build` when the pinned runtime inputs change. Confirm the immutable input manifest under `inputs/`, including its Docker image digest; newly captured recipes are frozen when they become candidate-ready. Confirm one falsifiable hypothesis, one recipe, one suite, the pinned base commit, and the suite's numeric primary score. For optimization suites, preserve validity gates and compare paired score deltas rather than substituting subjective judgment.
4. If creating:
   `npm run experiment:create -- --id <id> --hypothesis "<measurable claim>" --recipe <recipe> --suite <suite>`.

The filesystem is authoritative. Conversation history is not experiment state.

## Lifecycle

- `npm run experiment:materialize -- <id>` creates matched detached baseline/candidate worktrees.
- Never edit the baseline. Edit only the candidate and only paths belonging to the treatment.
- Run deterministic focused validation before capture.
- `npm run experiment:capture -- <id>` refuses a dirty baseline and records tracked/untracked candidate changes.
- `npm run experiment:smoke -- <id>` runs one task, one sample, both treatments/models.
- Inspect failures and policy results. Continue only if isolation is green.
- `npm run experiment:run -- <id>` runs missing full-matrix trial keys only.
- `npm run experiment:compare -- <id>` creates `report.md`; it never promotes or merges.
- Controller failures transition the experiment to `blocked`. After inspection, `npm run experiment:resume -- <id>` moves incomplete attempts under `aborted/`, preserves completed trials, and returns to `candidate-ready`.
- `npm run experiment:clean -- <id>` removes worktrees, runtime identities, and all trial workspaces while preserving durable state/results. Add `--retain-failures` only when failed workspaces are deliberately needed.

Treat `policy.allowedChangedPaths` as a hard boundary; generated files, benchmark scripts, stale docs, tests, and other plausible repository clutter are read-only even when changing them appears to improve the public score. Do not alter task, fixture, scorer, recipe, base commit, model, or random seed after baseline measurements begin. Version the task or create a new experiment instead. Do not rerun an unfavorable completed trial; add a declared repetition or invalidate with a journal reason.

## Security rules

The evaluator session and host controller are trusted. Paid runs require Docker and fail closed when the daemon or captured image digest is unavailable. Each target is a non-root, capability-free container with a read-only root, bounded resources, only its trial workspace/identity mounted, and an internal network. A separate broker container joins both that internal network and an egress bridge, owns the real `UMANS_API_KEY`, gives the target an ephemeral token, and rejects every model except `umans-glm-5.2` and `umans-kimi-k2.7`. The target has no Docker socket, host route, ordinary internet route, or normal host profile. Global resources, project trust, persistent sessions, compaction, retries, subagents, fallback models, and undeclared tools are disabled.

Stop immediately on `provider_policy_violation`, unexpected available models/resources/tools, leaked canaries, broker redaction failure, image-digest drift, or container/network cleanup failure. This isolates the target, not malicious evaluator/controller code; use a separate VM or host for that stronger threat model.

## Failure investigation

Inspect, in order:

1. `trial.json` terminal state, startup snapshot, fixture/recipe hashes;
2. `checks.json` deterministic failures;
3. `broker.json` accepted/rejected model requests (never authorization values);
4. `events.jsonl` tool sequence and malformed records;
5. `stderr.log` and retained failed workspace;
6. pairing/order and the corresponding baseline trial.

Classify interruption, timeout, provider failure, malformed event, policy violation, scorer failure, or treatment regression explicitly. Append decisions/anomalies to `journal.md` (append-only).

## Handoff after session loss

Run status. Completed `trial.json` files are immutable and must not be repeated. Directories without `trial.json` are aborted/incomplete, not completed. Re-associate worktrees from `worktrees.json`; if absent, rematerialize from the pinned commit and captured recipe. Recover candidate work from the candidate worktree or recipe. Continue at the next legal state transition.

End with a report and human review. Never stage, commit, install, merge, modify the installed extension, or declare a winner automatically.
