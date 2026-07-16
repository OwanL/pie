# Draft plan: agent-operated harness experiments

> **Status:** draft; no implementation started.
>
> **Purpose:** let agents propose, implement, run, resume, and report controlled experiments against pie's harness without relying on one conversation's context and without allowing benchmark target processes to use the maintainer's other configured providers.

## 1. Goal

Build a repo-local experimentation workspace whose normal interface is an Agent Skill plus deterministic scripts.

An evaluator agent should be able to:

1. create or resume an experiment;
2. state one falsifiable harness hypothesis;
3. materialize matched baseline and candidate worktrees;
4. implement one treatment in the candidate;
5. capture the treatment as a replayable recipe;
6. run baseline and candidate target agents headlessly against fixed tasks;
7. score outcomes with external checks;
8. inspect failed trials;
9. write a comparison report;
10. stop without merging automatically.

The filesystem is the source of truth. Session history is optional evidence, not required state. Another agent session must be able to continue from the experiment manifest, journal, recipe, and run artifacts.

## 2. Core decision: skill as control plane, scripts as enforcement plane

The workflow should be exposed through `skills/harness-experiments/SKILL.md`, but it must not be implemented only as prose.

- **Skill:** teaches the lifecycle, decision rules, commands, interpretation, and handoff protocol.
- **Scripts:** enforce clean baselines, model/provider restrictions, path boundaries, timeouts, run state, scoring, and resumability.
- **Schemas/manifests:** make recipes, tasks, experiments, and results machine-readable.
- **Git worktrees:** isolate baseline, candidate, and task executions.
- **Headless pi process:** runs target agents and emits structured events.

A skill is not a security boundary. Any guarantee concerning credentials, providers, immutable fixtures, liveness limits, or cleanup must exist in executable code.

## 3. Scope

### 3.1 MVP scope

The first version covers harness treatments that can be expressed as isolated resource/configuration overlays:

- tool implementation or wrapper extensions;
- tool descriptions and schemas;
- system-prompt append/override text;
- skills;
- tool-result middleware;
- settings overlays;
- active-tool lists;
- subagent prompt/result behavior when explicitly enabled by a later suite.

These treatments can run through the pinned pi CLI or SDK without launching VS Code.

### 3.2 Later scope

- Changes to `extension/src/backend/` that require pie's custom backend process.
- Changes spanning generated model configuration.
- Multi-agent and provider-capacity experiments.
- Import of benchmark summaries into the analytics dashboard.

### 3.3 Out of scope for headless benchmarks

- Visual quality of the VS Code webview.
- Scroll, focus, accessibility, and rendering behavior.
- Human usefulness of UI controls.
- Automatic modification of the installed VS Code extension.
- Automatic merging, staging, or committing of a winning treatment.
- General autonomous self-improvement without a declared hypothesis and fixed task suite.

## 4. Threat model and provider isolation

### 4.1 The concern

A Git worktree contains source, not credentials. Copying pie does not by itself copy the secure `auth.json`, which lives outside the checkout. The real exposure paths are:

- inherited process environment variables such as provider API keys;
- inherited `PI_CODING_AGENT_DIR` causing standalone pi to derive `auth.json`, `models.json`, settings, packages, and sessions from the maintainer's normal agent directory;
- the normal `models.json` catalog exposing other providers/models;
- global pi packages/extensions loaded from the normal agent directory;
- OAuth credentials read from the normal auth store;
- subagents selecting models from the normal bucket configuration;
- candidate scripts accidentally spawning the ordinary globally configured `pi` process.

The benchmark runner must therefore create a **separate runtime identity**, not merely a separate source worktree.

### 4.2 Two trust boundaries

The plan distinguishes two processes:

1. **Evaluator agent:** the agent helping develop the experiment in the normal pie session.
2. **Target agent:** the headless agent being benchmarked.

The implemented Docker boundary protects the maintainer's host and providers from the **target agent**. It does not make a normal evaluator session hostile-safe: an evaluator running with the maintainer's ordinary shell permissions already has whatever filesystem/environment access the current pie session has.

If evaluator code or the evaluator model itself must be treated as malicious, the whole evaluator must run under a separate OS account, VM, or container with no normal auth directory and only the benchmark credential broker. That stronger boundary is optional for local trusted use but must be documented clearly.

### 4.3 Required target-process isolation

Every target trial must use all of the following:

- a generated temporary `PI_CODING_AGENT_DIR` containing only benchmark runtime files, including an empty `auth.json` and a minimal custom `models.json` defining:
  - `umans/umans-glm-5.2`;
  - `umans/umans-kimi-k2.7`;
- no `PI_CODING_AGENT_AUTH_DIR` assumption: that variable is a pie-backend feature, while standalone pi derives auth and model paths from `PI_CODING_AGENT_DIR`;
- for the SDK worker, explicit `AuthStorage.create(<temp>/auth.json)` and `ModelRegistry.create(authStorage, <temp>/models.json)` instances rather than default discovery;
- explicit provider/model selection for one allowed Umans model;
- no inherited global settings, packages, extensions, skills, prompts, context files, themes, or sessions;
- an in-memory session plus controller-owned event/output artifacts (not pi session persistence);
- only explicit baseline/candidate extension factories or paths;
- only skills/prompts/context supplied by the treatment or task manifest;
- project trust set to false and resource discovery disabled independently of task contents;
- an explicit tool allowlist;
- subagents absent by default because extension discovery is disabled; if a treatment explicitly loads the subagent extension, its disabled mode and zero depth are enforced separately;
- an environment constructed from an allowlist, not `{ ...process.env }` followed by a few deletions.

Pi's `ModelRegistry` always contains built-in model metadata, so the mere presence of other built-ins is not a policy failure. The runner must instead fail closed if:

- `modelRegistry.getAvailable()` contains any model outside the two-model allowlist;
- any non-Umans provider has configured auth;
- the selected model/provider differs from the trial manifest; or
- the broker observes a request for an unallowed model.

For CLI/RPC compatibility tests, equivalent controls are explicit `--provider`, `--model`, `--no-session`, `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-themes`, `--no-context-files`, `--no-approve`, and tool-allowlist flags, with only treatment resources added explicitly.

### 4.4 Environment allowlist

The child needs operational variables such as `PATH`, temporary-directory variables, locale, and a few Windows process variables. It must not receive arbitrary parent variables or paths that resolve to the maintainer's real profile.

The launcher should build a fresh environment from a cross-platform allowlist:

- `PATH`;
- `SystemRoot`, `ComSpec`, `PATHEXT`, `WINDIR` on Windows;
- `HOME`, `USERPROFILE`, `HOMEDRIVE`, and `HOMEPATH` rewritten to a run-local synthetic home;
- `LOCALAPPDATA`, `APPDATA`, and `XDG_CONFIG_HOME` rewritten under that synthetic home;
- `TMP`, `TEMP`, and `TMPDIR` pointed at run-local storage;
- locale/terminal variables required for UTF-8;
- benchmark-specific `PI_*`/`PIE_*` variables created by the launcher.

The ephemeral broker token should be written into the run-local `models.json`, not inherited as an environment variable. The launcher must reject known provider-secret names and broad secret patterns in the child environment. Tests should plant fake `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, Copilot tokens, arbitrary `*_TOKEN`/`*_SECRET` values, and canary auth files in the real home/profile, then prove a target bash call cannot observe them through env or normal `~`/profile-derived paths.

The generated identity is mounted read-only into the target container. The target cannot address arbitrary host paths because only its workspace, identity, config, and declared treatment bundle are mounted. The evaluator/controller remains outside this boundary.

### 4.5 Umans credential broker

Passing the real `UMANS_API_KEY` into the target process would still expose it through the target's bash/read capabilities. The implemented design is a small broker container owned by the controller:

1. The controller process reads the real `UMANS_API_KEY`.
2. It starts a per-trial broker container attached to the target's internal network and a separate egress bridge.
3. It generates a short-lived random bearer token for one trial.
4. Target `models.json` points `umans.baseUrl` at the broker's internal Docker DNS name and contains only the ephemeral token.
5. The broker accepts only the two allowed model IDs.
6. The broker injects the real Umans credential upstream.
7. It forwards the relevant OpenAI-compatible payload and Umans session-affinity/request-id headers transparently so the broker does not change routing behavior.
8. It strips target authorization before forwarding, never forwards arbitrary target headers, and validates the upstream destination.
9. It enforces provider/concurrency policy and the trial lifetime while recording redacted request and token metadata; it does not cap requests or output tokens.
10. The token expires and the broker closes when the trial or experiment ends.

The target may see the ephemeral token, but it cannot learn the real credential or use another provider. The broker must never log authorization headers or the upstream key.

A direct-key mode may exist only as an explicit insecure development escape hatch for a maintainer-run smoke test. It must be off by default and clearly marked in result metadata.

### 4.6 Model switching and hidden calls

Provider restriction applies to every model call, not only the main target turn:

- skill-pruner is disabled unless it is the treatment under test;
- subagents are disabled in the initial suites;
- history compaction is disabled for short benchmark tasks unless compaction is under test;
- retries stay on the selected Umans model and cannot fail over;
- no fallback chains may reference other providers;
- standalone pi does not enforce pie backend's `providers.<id>.concurrency` settings, so the benchmark broker is the sole target-request concurrency authority;
- any custom treatment that initiates a model call must route through the broker and allowed registry;
- the broker rejects unrecognized model IDs even if candidate code constructs a raw request.

A trial fails with classification `provider_policy_violation` if it attempts another model/provider.

### 4.7 Network boundary

Paid smoke/full runs require the hardened Docker mode and fail closed if Docker or the captured image digest is unavailable. For each trial the controller:

- creates a dedicated `--internal` Docker network;
- attaches the target only to that network;
- attaches the broker to both the internal network and Docker's egress bridge;
- mounts no Docker socket and no host paths except the trial workspace, generated identity, worker config, and declared treatment bundle;
- runs the target non-root with all capabilities dropped, `no-new-privileges`, a read-only root filesystem, bounded CPU/memory/PIDs, and bounded tmpfs storage;
- removes target/broker containers, network, and temporary credential file on completion or failure.

The command policy remains defense in depth. Integration tests prove that the target reaches the broker but cannot reach ordinary internet or host endpoints. This boundary does not make the trusted host evaluator/controller safe to treat as malicious; that requires a separate VM or host.

## 5. Proposed repository layout

```text
pie/
├─ skills/harness-experiments/
│  └─ SKILL.md
│
├─ benchmarks/
│  ├─ README.md
│  ├─ schemas/
│  │  ├─ experiment.schema.json
│  │  ├─ recipe.schema.json
│  │  ├─ task.schema.json
│  │  └─ result.schema.json
│  ├─ tasks/
│  │  └─ <task-id>/
│  │     ├─ task.yaml
│  │     ├─ prompt.md
│  │     ├─ fixture/ or fixture.patch
│  │     └─ public-checks/
│  ├─ recipes/
│  │  └─ <recipe-id>/
│  │     ├─ recipe.yaml
│  │     ├─ treatment.patch
│  │     ├─ overlay/
│  │     └─ notes.md
│  └─ suites/
│     └─ <suite-id>.yaml
│
├─ scripts/experiments/
│  ├─ cli.mjs
│  ├─ create.mjs
│  ├─ status.mjs
│  ├─ materialize.mjs
│  ├─ capture-recipe.mjs
│  ├─ run.mjs
│  ├─ trial-worker.mjs
│  ├─ broker.mjs
│  ├─ score.mjs
│  ├─ compare.mjs
│  ├─ clean.mjs
│  └─ lib/
│
└─ data/experiments/                 # git-ignored, machine-local
   └─ <experiment-id>/
      ├─ experiment.json
      ├─ journal.md
      ├─ lock.json
      ├─ worktrees.json
      ├─ runtime/
      ├─ runs/
      │  └─ <trial-id>/
      │     ├─ trial.json
      │     ├─ events.jsonl
      │     ├─ messages.json
      │     ├─ metrics.json
      │     ├─ final.patch
      │     ├─ checks.json
      │     └─ stderr.log
      └─ report.md
```

Tracked files define reusable tasks, suites, schemas, and accepted recipes. Raw events, worktrees, runtime identities, and reports-in-progress remain local under `data/experiments/`. A completed report may be copied deliberately into `docs/internal/experiments/`; the scripts must never commit it automatically.

## 6. Data contracts

### 6.1 Experiment manifest

The experiment manifest is the resumable state machine:

```yaml
schemaVersion: 1
id: anchored-edit-2026-07
status: candidate-ready
baseCommit: <full-sha>
hypothesis: >-
  Hash-anchored edits reduce failed edit calls without reducing task pass rate.
recipe: anchored-edit-v1
suite: edit-protocol-v1
models:
  - provider: umans
    id: umans-glm-5.2
    thinking: medium
  - provider: umans
    id: umans-kimi-k2.7
    thinking: medium
samples: 3
execution:
  maxConcurrency: 1
  randomizeOrder: true
  randomSeed: 417291
budgets:
  trialTimeoutMs: 3600000
completedTrialIds: []
```

Allowed status transitions:

```text
draft
  -> materialized
  -> baseline-ready
  -> candidate-ready
  -> smoke-running
  -> full-running
  -> analyzing
  -> complete

any non-terminal state -> blocked | cancelled
blocked -> prior valid state after an explicit journal entry
```

Writes must be atomic. A run lock prevents two sessions from executing the same experiment concurrently. Stale locks are recoverable only after confirming the owning PID is gone.

### 6.2 Recipe manifest

A recipe describes one treatment and how to replay it:

```yaml
schemaVersion: 1
id: anchored-edit-v1
baseCommit: <full-sha>
type: extension-overlay
hypothesisDimension: edit-protocol
changedPaths:
  - benchmarks/recipes/anchored-edit-v1/overlay/**
apply:
  extensions:
    - ./overlay/anchored-edit.ts
validation:
  - npm run test:file -- <focused-test>
  - npm run typecheck
```

Supported initial treatment types:

- `extension-overlay`;
- `source-patch`;
- `prompt-override`;
- `skill-override`;
- `settings-overlay`;
- `composite`, allowed only when every component is necessary for one declared protocol change.

The capture command records the candidate diff, untracked files, base SHA, and content hashes. It refuses unrelated modifications unless the recipe manifest explicitly includes them.

### 6.3 Task manifest

```yaml
schemaVersion: 1
id: repeated-block-edit
version: 1
promptFile: prompt.md
fixture:
  type: directory
  path: fixture
policy:
  network: deny
  subagents: deny
  allowedTools: [read, edit, write, bash, grep, find, ls]
limits:
  timeoutMs: 3600000
checks:
  public:
    - npm test
  privateScorer: repeated-block-edit-v1
metrics:
  primary: checksPassed
  secondary:
    - failedEditCalls
    - toolCalls
    - inputTokens
    - outputTokens
    - wallTimeMs
```

Private scorers should be resolved by the controller from outside the target task workspace. A target process must not be given their source path. For the initial trusted evaluator workflow, this prevents accidental leakage rather than defending against a malicious evaluator with full repository access.

### 6.4 Trial result

Each trial records:

- exact pie/base commit;
- recipe and content hash;
- task/version/fixture hash;
- model/provider/thinking level;
- treatment (`baseline` or `candidate`);
- repetition, deterministic random seed, and randomized order index;
- process/runtime versions;
- accepted/rejected provider requests;
- tool calls, errors, malformed calls, retries, and durations;
- token/cache usage and reported cost metadata;
- wall time and terminal state;
- final patch and changed-file manifest;
- public and private check results;
- policy violations;
- stderr and bounded event/message artifacts.

Raw secrets and authorization headers are forbidden in every artifact.

## 7. Headless execution design

### 7.1 Controller choice

Use a Node controller that spawns one fresh target process per trial. Two viable target interfaces are:

- `pi --mode rpc --no-session` with explicit resources and a JSONL controller;
- a small SDK-based `trial-worker.mjs` spawned as a child process.

The recommended MVP is the SDK worker because it can construct `AuthStorage`, `ModelRegistry`, `SettingsManager`, `DefaultResourceLoader`, and tool/resource overrides explicitly. The controller still gives every trial process isolation. RPC remains a compatibility acceptance test because it is the public headless protocol.

The SDK worker must not rely on CLI flags being conceptually equivalent. It must explicitly configure:

- `AuthStorage.create(<run-local-auth.json>)`;
- `ModelRegistry.create(authStorage, <run-local-models.json>)`;
- `SettingsManager.inMemory(<benchmark settings>, { projectTrusted: false })`;
- `DefaultResourceLoader` with `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, and `noContextFiles` set, then add only treatment resources explicitly;
- `SessionManager.inMemory(taskCwd)`;
- explicit model, thinking level, tools, and no fallback configuration.

A startup assertion serializes the effective available models, loaded resources, tools, project-trust state, agent/auth/model paths, and settings hash into `trial.json`. Any unexpected resource or available model aborts before the first provider request.

### 7.2 Trial lifecycle

1. Validate experiment, task, recipe, liveness limits, and lock.
2. Create a fresh task worktree/copy from the fixture hash.
3. Generate a temporary benchmark agent directory and minimal model catalog.
4. Start the credential broker and mint an ephemeral trial token.
5. Build the allowlisted child environment.
6. Spawn the target with explicit model, thinking, tools, and resources.
7. Stream JSONL events to a bounded artifact writer.
8. Enforce only the wall-clock liveness limit while observing uncapped request and output-token usage.
9. On settlement, terminate the target and broker cleanly.
10. Run scorers externally against the final task workspace.
11. Capture diff, metrics, checks, policy results, and hashes.
12. Atomically mark the trial complete.
13. Clean the task workspace unless retention was requested for a failed trial.

On interruption, completed trials remain immutable. A resumed run schedules only missing trial keys.

### 7.3 Pairing and randomization

The trial key is:

```text
experiment + task version + model + thinking + repetition + treatment
```

For each task/model/repetition pair:

- baseline and candidate start from identical fixture hashes;
- order is randomized from the manifest's fixed `randomSeed` and recorded;
- only one pair runs at a time initially;
- no target session/context is reused;
- provider cache fields are recorded but not assumed controllable;
- retry/failure outcomes remain part of the result rather than being silently rerun.

Umans advertises unlimited usage, not unlimited concurrency or perfect availability. Initial `maxConcurrency` is `1`; later it may rise to `2` only after provider-gate/broker evidence shows no throughput distortion.

## 8. Scoring and analysis

### 8.1 Evidence hierarchy

1. Private deterministic checks and invariants.
2. Public tests/typecheck/build.
3. Policy compliance and unrelated-file constraints.
4. Tool-protocol metrics such as first-attempt edit success.
5. Token, request, latency, and cost metrics.
6. Blind LLM judging only for outputs that cannot be scored deterministically.
7. Human review before promotion.

The evaluator agent does not assign the primary score.

Primary eligibility describes measurement integrity, not task success. Deterministic task failures—including invalid solutions, bounded scorer timeouts caused by candidate code, and policy violations—remain primary outcomes and reduce pass rate; excluding them would introduce survivorship bias. Provider/security isolation failures, malformed event streams, missing startup attestation, controller/process failures, genuine provider failures, and scorer infrastructure/artifact failures are diagnostic-only.

### 8.2 Comparison report

`compare` produces:

- pass rate by treatment/task/model;
- paired outcome table;
- confidence intervals or clearly labelled raw counts for small samples;
- first-attempt tool success and failure classifications;
- token/request/wall-time distributions;
- policy violations;
- candidate regressions even when aggregate performance improves;
- links/paths to representative successful and failed trials;
- methodology limitations;
- verdict: `promising`, `inconclusive`, `regressed`, or `invalid`.

No automatic winner is declared from one run. A reusable source-of-truth reference additionally requires the complete frozen suite, both declared models, three repetitions, concurrency one, all planned trials completed, every pair primary-eligible, no provider/security integrity failure, and human review of the report and representative failures. Historical reference scores do not replace a later experiment's contemporaneous matched baseline. Promotion thresholds belong in suite configuration and require, at minimum:

- no primary pass-rate regression;
- improvement on the declared hypothesis metric;
- no new safety/provider-policy violation;
- evidence on both GLM 5.2 and Kimi K2.7 unless the experiment is explicitly model-specific;
- human acceptance of the final diff.

## 9. Skill workflow

The skill should instruct an agent to use only this command vocabulary:

```bash
npm run experiment:create -- --hypothesis "..."
npm run experiment:status -- <id>
npm run experiment:materialize -- <id>
npm run experiment:capture -- <id>
npm run experiment:smoke -- <id>
npm run experiment:run -- <id>
npm run experiment:compare -- <id>
npm run experiment:clean -- <id>
```

Required behavior:

1. Run `status` and read `experiment.json` + `journal.md` before editing.
2. Work on one experiment and one hypothesis at a time.
3. Never edit the baseline worktree.
4. Never alter task/scorer definitions after baseline measurements begin; create a new task version instead.
5. Keep treatment changes within the recipe's declared paths.
6. Run deterministic focused tests before model trials.
7. Run a one-task/one-sample smoke matrix before a full suite.
8. Do not rerun an unfavorable completed trial; add a new repetition or invalidate the experiment with a reason.
9. Append decisions and anomalies to the journal.
10. Stop at a report; never stage, commit, install, or merge automatically.

The skill must explain recovery after session loss:

- `status` identifies the current phase and missing trials;
- stale worktrees are re-associated from `worktrees.json`;
- incomplete artifact directories are classified as aborted and never mistaken for completed trials;
- candidate changes are recoverable from either the worktree or captured recipe;
- a new session continues from the next legal state transition.

## 10. Implementation phases

### Phase 0 — contracts and security spike

Deliver:

- finalized threat model;
- schemas for experiment, recipe, task, and result;
- proof that `modelRegistry.getAvailable()` exposes only the two Umans models even though built-in metadata remains present;
- child-environment and synthetic-home scrubber tests with planted fake provider credentials and auth canaries;
- proof that standalone pi resolves `PI_CODING_AGENT_DIR`, auth, models, settings, and session state only under the run-local runtime identity;
- localhost broker prototype with model allowlist and redacted logs;
- process-tree timeout/cleanup proof on Windows Git Bash.

Acceptance:

- target bash cannot observe planted non-Umans credentials through environment or normal home/profile-derived paths;
- target available-model listing contains only the two allowed models, and startup aborts if any other model has configured auth;
- a request for another model is rejected and recorded;
- the real Umans key does not appear in target environment, files, events, stderr, or result artifacts;
- killing the controller terminates target and broker descendants.

No real benchmark corpus should run before this phase passes.

### Phase 1 — durable experiment workspace

Deliver:

- directory scaffold;
- create/status/materialize/capture/clean scripts;
- atomic manifest transitions and lock handling;
- baseline/candidate worktree lifecycle;
- append-only journal helper;
- git-ignore rules for runtime artifacts.

Acceptance:

- create → materialize → edit candidate → capture → clean → rematerialize reproduces the same candidate hash;
- baseline mutation is detected;
- a second session/process can resume from disk;
- stale locks and interrupted materialization recover safely.

### Phase 2 — headless trial runner

Deliver:

- trial worker/controller;
- exact resource/model/tool configuration;
- JSONL event capture;
- liveness limits, usage observation, and process-tree termination;
- immutable per-trial results;
- pairing/randomization/resume scheduler.

Acceptance:

- matched baseline/candidate no-op recipes produce equivalent configurations;
- a fixed experiment `randomSeed` reproduces treatment order across clean materialization and resume;
- completed trials are not repeated on resume;
- timeout, provider failure, malformed event, and controller interruption produce explicit terminal classifications;
- target cannot load global extensions, skills, sessions, context files, or auth.

### Phase 3 — scoring and comparison

Deliver:

- external public/private check runner;
- diff/change constraints;
- metric extraction;
- paired comparison report;
- small-sample warnings and invalid-experiment states.

Acceptance:

- deliberately correct and incorrect fixtures score differently;
- target cannot read private scorer files from its cwd;
- changing a task after baseline capture invalidates the experiment by hash;
- reports trace every aggregate to immutable trial IDs.

### Phase 4 — Agent Skill

Deliver:

- `skills/harness-experiments/SKILL.md`;
- command and state-transition guidance;
- hypothesis/recipe authoring rules;
- resume/handoff procedure;
- failure investigation checklist;
- explicit security and no-auto-merge rules.

Acceptance:

- a fresh agent session can resume a seeded interrupted experiment without conversational context;
- the agent uses scripts instead of manually spawning target processes;
- the agent refuses to continue when provider isolation checks are red.

### Phase 5 — pilot suite

Pilot hypothesis:

> A candidate edit protocol reduces failed edit calls and output tokens without reducing deterministic task success.

Initial task suite:

- repeated similar blocks;
- awkward whitespace/line endings;
- multi-location edits;
- stale-context rejection;
- targeted change in a larger file;
- edit followed by focused verification.

Matrix:

- `umans-glm-5.2`, medium thinking;
- `umans-kimi-k2.7`, medium thinking;
- baseline and candidate;
- one smoke sample, then three samples per task/model if smoke passes;
- concurrency one.

Acceptance:

- the system completes and resumes the full matrix without provider leakage;
- the report distinguishes correctness from efficiency;
- at least one deliberately seeded harness regression is caught;
- no treatment is promoted automatically.

### Phase 6 — hardening and optional analytics integration

Only after the pilot:

- keep the mandatory target/broker container boundary and image digest under integration test; use a separate VM/host if evaluator code becomes untrusted;
- add benchmark result summaries to the existing analytics preparation layer without mixing controlled and observational cohorts;
- support pie backend treatments that cannot run in standalone pi;
- add blind judge support for subjective tasks;
- add more models only through an explicit provider-policy revision.

## 11. Tests

Required automated coverage:

- schema validation and migration rejection;
- state-machine legal/illegal transitions;
- atomic manifest writes and crash recovery;
- lock acquisition, stale-lock recovery, and concurrent-run rejection;
- worktree path safety and baseline immutability;
- recipe capture/replay including untracked files;
- environment allowlist and synthetic-home/profile rewriting on Windows and POSIX;
- fake secret and auth-canary leakage tests through target bash;
- minimal auth configuration plus available-model allowlist validation;
- effective SDK resource/settings/tool snapshot validation;
- broker model allowlist, token expiry, request limits, session-affinity/header forwarding, and log redaction;
- JSONL framing and malformed-record handling;
- timeout/abort/process-tree cleanup;
- trial idempotency and resume scheduling;
- fixture/scorer hash invalidation;
- deterministic scoring and report traceability;
- no-op baseline/candidate configuration parity.

A fake local OpenAI-compatible provider should cover runner tests. Real Umans calls belong only in an opt-in smoke test.

## 12. Operational constraints

- Runtime data remains under `data/experiments/` and is never committed automatically.
- Real auth files remain outside Git and are never copied into worktrees; the run-local benchmark identity contains only an empty auth file and ephemeral broker credential under git-ignored runtime storage.
- Experiment subprocesses use the SDK version pinned by `extension/package-lock.json`.
- Candidate changes under `extension/src/` still require the normal extension build when that treatment tier is introduced.
- Raw events and task source may contain sensitive code; follow `SECURITY.md` storage rules.
- The runner should cap artifact sizes and preserve a bounded tail plus an explicit raw-artifact path when truncation occurs.
- Request and output-token usage are observed but uncapped so target agents can finish. Wall-clock liveness, provider isolation, and concurrency constraints remain enforced.

## 13. Open questions before implementation

1. **Evaluator boundary (resolved for current scope):** target sessions require Docker isolation; evaluator/controller sessions remain trusted host processes. Move the whole evaluator to a separate VM/host before treating evaluator code as malicious.
2. **Broker implementation:** Use a small purpose-built Node reverse proxy, or restore an off-the-shelf local gateway with virtual keys? A purpose-built broker has a smaller benchmark-specific surface; an off-the-shelf gateway has stronger mature policy controls.
3. **Target interface:** SDK worker as primary with RPC acceptance tests, or RPC for every trial? SDK is easier to configure exactly; RPC exercises the public headless path.
4. **Private scorers:** Keep them in a local path outside the pie checkout, or accept that the trusted evaluator can inspect them while only the target is isolated?
5. **Task fixtures:** Commit small synthetic fixtures directly, or generate temporary Git repositories from declarative setup scripts?
6. **Candidate scope:** Should the MVP permit source patches, or only extension/prompt/settings overlays until the runner is proven?
7. **Thinking levels:** Use medium for both models initially, or run model-specific recommended levels? Paired treatment comparison matters more than cross-model ranking.
8. **Result retention:** Keep all failed trial worktrees for inspection, or retain only artifacts unless explicitly requested?

## 14. Recommended draft defaults

Unless the open questions change them:

- protect target processes from accidental provider/credential access;
- document that the normal evaluator is trusted;
- require the localhost ephemeral-token broker;
- use a spawned SDK worker per trial;
- allow extension/prompt/settings overlays first, source patches second;
- keep private scorers outside target workspaces;
- run both Umans models at medium thinking;
- use concurrency one;
- disable subagents, compaction, skill pruning, global resources, and fallback models unless directly under test;
- retain failed trial artifacts but clean worktrees by default;
- require human review before any recipe is applied to pie.
