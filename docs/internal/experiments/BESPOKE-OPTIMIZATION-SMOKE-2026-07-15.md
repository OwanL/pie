# Bespoke optimization smoke postmortem — 2026-07-15

## Status

Experiment `pilot-bespoke-optimization-2026-07-15` is blocked. Its four completed trials are immutable diagnostic evidence and must not be rerun. The task and harness were versioned before any replacement experiment.

## Outcome

No model produced a clean comparable pair.

| Model | Treatment | Hidden score | Terminal result |
|---|---|---:|---|
| GLM 5.2 | baseline | 0.1521 | resource policy violation (four retained scratch files) |
| GLM 5.2 | candidate | 0.7144 | target timeout at 600 seconds |
| Kimi K2.7 | baseline | 0.6753 | target timeout; public test then timed out |
| Kimi K2.7 | candidate | 0.6116 | request budget exceeded after 30 accepted calls |

Scores from non-complete trials are diagnostic only. They cannot be included in treatment aggregates.

## What worked

- Runtime startup snapshots exposed only the two Umans models and declared resources/tools.
- The broker recorded no provider leakage and rejected the request beyond its budget.
- Deterministic public and hidden scoring ran against retained workspaces.
- Hidden scores were materially below public scores for optimized implementations, demonstrating that unseen workloads detect public-workload overfitting.
- Final filesystem comparison detected undeclared scratch files.
- Polling accurately exposed live trial, request, tool, and terminal progress.
- Completed artifacts remained resumable and immutable.

## Root causes

### 1. Optimization horizon exceeded the trial budget

The candidate protocol encouraged repeated measurement without a cycle limit. GLM candidate used 41 tool calls and 29 model requests, including broad 100-seed diagnostic searches. Kimi candidate reached the 30-request broker limit after its implementation was already scoreable. GLM baseline spent its complete budget creating four successive diagnostic scripts without changing the accepted source file.

This was not just “models being slow”: the prompt rewarded open-ended search while the runner imposed an uncommunicated hard horizon.

### 2. The task workspace did not behave like a repository

Task fixtures were copied under the parent repository's ignored `data/` tree without their own Git repository. Kimi candidate naturally ran `git status`, `git diff`, `git rev-parse`, and `git ls-files`; those commands observed the parent pie checkout and treated the task file as ignored/untracked. Several calls were wasted resolving this mismatch.

A realistic codebase benchmark needs realistic local version-control semantics, not only realistic-looking files.

### 3. Contract and test fixture disagreed

The runtime workloads always supplied `arrivalMs` and `priority`, but the public unit tests omitted them. Kimi baseline introduced arrival-aware scheduling and entered an infinite loop on the incomplete test objects. Hidden scoring did not exercise that edge because hidden requests used the generator's complete shape.

The test was valuable in catching the issue, but omission was accidental ambiguity rather than a deliberate hidden requirement. Required fields must be explicit and consistent across docs, public tests, and private distributions.

### 4. Untrusted code could hang checks for the full agent timeout

The controller reused the 600-second target budget for every public check and private scorer. Kimi's infinite loop therefore consumed ten minutes in the target and another ten minutes in the external test. Private scorers also import candidate code directly in their subprocess; without a short scorer timeout, a hostile or buggy optimizer can stall evaluation.

### 5. Terminal state, checks, and score eligibility were conflated

Timed-out trials could have `checksPassed: true` and a high `primaryScore`, making them look successful in summaries. Token usage was zero for killed targets because usage was read only from the final `complete` event. A request-budget rejection was classified as generic `provider_failure` rather than a harness budget outcome.

The scorer should preserve useful diagnostic scores, but reports must exclude them from primary treatment aggregates.

### 6. Scratch-file policy needs explicit semantics

GLM baseline left four `scratch/*.mjs` files. The task clearly allowed only `src/scheduler.mjs`, so this is a legitimate agent outcome failure, not provider or harness corruption. Future reports must distinguish an invalid agent submission from an invalid experiment methodology. We should not silently delete arbitrary scratch files; prompts now bound scratch use and require cleanup.

## Implemented hardening

- Each task workspace is initialized as an independent Git repository with a fixture baseline commit.
- Every target bash call is capped at 60 seconds, including commands that omit a timeout.
- Public checks have a 30-second cap and private scorers a 10-second cap, independent of target wall time.
- Request-budget rejection is classified as `request_budget_exceeded`.
- Usage is reconstructed from streamed `message_end` events, so timed-out targets retain token metrics.
- Results now record `trialPassed` and `scoreEligibility`; failed/timeout/policy outcomes retain diagnostic scores but are excluded from primary aggregates.
- Comparison reports compute means only from primary-eligible trials.
- Optimization prompts permit at most one temporary diagnostic script and two refinement cycles, and require cleanup.
- The inference task contract now explicitly requires every request field used by the runtime, and public tests use complete requests.
- All bespoke tasks moved to manifest version 2 with explicit target, bash, public-check, and private-scorer budgets.
- New experiments default to 40 model requests rather than 30; the finite iteration protocol remains the main control.

## Remaining hardening before a full matrix

1. Run a new four-trial smoke under a new experiment ID; never reuse the blocked trials.
2. Verify that independent Git semantics remove Git-discovery calls and that bash timeouts let agents recover from hanging tests.
3. Add a scorer-timeout integration test using a deliberately non-terminating optimizer subprocess.
4. Add a target process-tree integration test that starts a hanging grandchild and proves timeout cleanup on Windows.
5. ~~Enforce cumulative output-token budgets during execution rather than only recording final usage.~~ Implemented in the hardening iteration.
6. ~~Add inactivity classification distinct from wall timeout and provider timeout.~~ Implemented in the hardening iteration.
7. Report paired score deltas only when both members are primary-eligible; list all other pairs as censored with reasons.
8. Calibrate task difficulty from multiple clean smoke samples before committing to three repetitions across the full suite.

## Decision rule

Do not start the full matrix unless the replacement smoke has:

- four primary-eligible trials;
- no provider-policy or resource-policy violations;
- no target, bash, check, or scorer timeout;
- no request-budget exhaustion;
- non-zero streamed token accounting;
- valid public and private scores for both models and treatments.
