# JavaScript and general best-practice skills experiment — 2026-07-19

## Executive summary

Experiment `javascript-general-skills-r1-2026-07-19` tested whether giving coding agents two optional native skills—general software-engineering guidance and JavaScript/Node.js guidance—meaningfully improved outcomes on the existing `bespoke-optimization-v1` benchmark suite.

The preregistered hypothesis was **not supported**. The candidate's mean paired score was 0.0431 higher than the contemporaneous control, exceeding the declared practical-effect threshold of 0.03, but the result was not statistically significant (paired randomization p = 0.2000). Both treatments passed 23/24 trials (95.8%), with exact paired pass p = 1.0000. The experiment's decision-rule verdict is therefore **neutral**.

The aggregate hides substantial task variation. The skills treatment improved the inference scheduler markedly, was nearly neutral on the feature-cache and vector-shard tasks, and regressed the sensor-anomaly task. It also increased output tokens by 46.3% and tool calls by 31.2%. This is evidence against enabling this combined pack globally on the strength of one run. It is not proof that language-specific guidance can never help; it suggests that any benefit is task-dependent and may come with material execution cost.

## Research question and hypothesis

The research question was:

> Does making general engineering and language-specific best-practice guidance available as native skills meaningfully improve coding-agent outcomes?

The preregistered hypothesis required all of the following on the unchanged suite:

- a positive mean paired primary-score delta of at least 0.03;
- a two-sided paired randomization p-value at most 0.05;
- no paired pass-rate regression;
- no policy or measurement-integrity regression.

The experiment used a contemporaneous matched baseline. Historical no-op results were context only and were not substituted for the control.

## Experimental design

### Shared setup

Control and candidate used exactly the same:

- pinned base commit: `217573a054cdb0ba0f094294430bad1af35ba12b`;
- benchmark suite: `bespoke-optimization-v1`;
- four unchanged JavaScript (`.mjs`) optimization tasks:
  - `inference-batch-scheduler`;
  - `vector-shard-rebalancer`;
  - `feature-cache-planner`;
  - `sensor-anomaly-pipeline`;
- task prompts, fixtures, public checks, private scorers, allowed changed paths, and tool policy;
- models:
  - `umans/umans-glm-5.2`, medium thinking;
  - `umans/umans-kimi-k2.7`, medium thinking;
- three repetitions per task/model/treatment;
- paired randomized treatment order with seed `417291`;
- concurrency one and a one-hour wall-clock limit per trial;
- isolated Docker runtime, network denial, credential broker, no subagents, no retries, and no history compaction.

This produced 24 matched full-run pairs: four tasks × two models × three repetitions, with one control and one candidate trial in each pair. Smoke trials were separate from the analysis matrix.

### What the control included

The control was the standard benchmark coding agent. It received:

- the benchmark's minimal coding-agent system prompt;
- the task-specific prompt and repository fixture;
- only the task's declared tools (`read`, `edit`, `write`, `bash`, `grep`, `find`, and `ls` where allowed);
- normal test and evaluation commands exposed by the fixture;
- no benchmark skills and no best-practice prompt overlay.

The control therefore still had the model's pretrained software-engineering knowledge and the common harness instruction to inspect, implement, and verify the requested change. “No skills” means no additional benchmark-provided skill metadata or bodies; it does not mean an instruction-free or knowledge-free agent.

Startup attestations confirmed that all 24 control trials exposed zero native skills.

### What the candidate included

The candidate was identical to the control except that two native skills were available through recipe `javascript-general-best-practices-v1`:

#### `engineering-best-practices`

General guidance for safe changes in an existing codebase:

- establish the runtime and API contract before editing;
- reproduce or measure current behavior;
- form a root-cause hypothesis;
- prefer the smallest coherent change;
- consider boundaries, failure modes, ordering, duplicates, and resource limits;
- avoid fixture-specific hardcoding and unrelated cleanup;
- verify with focused and broader checks;
- inspect the final diff and report trade-offs.

#### `javascript-best-practices`

JavaScript and Node.js guidance covering:

- preservation of exports, return shapes, mutation semantics, ordering, and errors;
- explicit control flow, scoping, and coercion;
- data-structure selection by access pattern;
- avoidance of accidental quadratic work and redundant allocation;
- numeric boundaries, tie-breaking, and deterministic comparators;
- asynchronous ownership, bounded concurrency, and cleanup;
- caller-owned data and copying costs;
- validation against tests and realistic evaluation.

The bodies contained generic advice only. They did not mention benchmark task names, fixtures, private workloads, scorer behavior, or desired implementations.

The skills were advertised through the native skill mechanism rather than appended to every system prompt. The agent could decide whether to read them. Startup attestations confirmed two skills in all 24 candidate trials. Agents read at least one skill in 23/24 candidate trials, making 68 skill-file reads in total. Thus the neutral result cannot be explained by the skills simply being unavailable or universally ignored.

## Integrity and execution

The smoke gate completed with four primary-eligible passing trials and correct treatment isolation: zero exposed skills for control and two for candidate.

The run experienced two controller interruptions:

1. a transient `git init` failure during smoke preparation;
2. Docker Desktop stopping after 28/48 full trials.

Both interruptions occurred at controller boundaries. Completed trial artifacts remained immutable, incomplete attempts were handled through the declared resume process, and only missing trial IDs were subsequently run. The interruptions did not alter the recipe, tasks, models, seed, or completed results.

All 48 full trials and 24 matched pairs were primary-eligible. There were:

- zero rejected broker requests;
- no provider, model, credential, image, or startup-attestation integrity violation;
- no remaining owned Docker resources after cleanup;
- one resource-policy outcome in each treatment, both on `sensor-anomaly-pipeline`;
- passing deterministic checks for both resource-policy outcomes.

The run is accepted as an integrity-valid source-of-truth comparison for this combined two-skill treatment.

## Results

### Aggregate results

| Treatment / model | Mean score | Passed | Eligible | Output tokens | Tool calls |
|---|---:|---:|---:|---:|---:|
| Control / GLM 5.2 | 0.6683 | 11/12 | 12/12 | 284,615 | 340 |
| Control / Kimi K2.7 | 0.7145 | 12/12 | 12/12 | 248,039 | 379 |
| Skills / GLM 5.2 | 0.7541 | 12/12 | 12/12 | 428,666 | 481 |
| Skills / Kimi K2.7 | 0.7150 | 11/12 | 12/12 | 350,385 | 462 |
| **Control total** | **0.6914** | **23/24** | **24/24** | **532,654** | **719** |
| **Skills total** | **0.7346** | **23/24** | **24/24** | **779,051** | **943** |

The model split is important: GLM's mean increased by approximately 0.0858, while Kimi's increased by only approximately 0.0005. The aggregate effect was not consistent across models.

### Paired inference

- Mean paired score delta: **+0.0431**
- Declared minimum practical delta: **0.03**
- Two-sided paired randomization p-value: **0.2000**
- Control pass rate: **95.8%**
- Candidate pass rate: **95.8%**
- Discordant pass pairs: **1 candidate win / 1 candidate loss**
- Exact paired pass p-value: **1.0000**
- Protocol verdict: **neutral**

The observed mean is practically large under the preregistered threshold, but uncertainty and task-level variance are too high to declare a reliable positive direction. The correct interpretation is “promising point estimate, insufficient evidence,” not “a proven 4.3-point improvement.”

### Results by task

| Task | Control mean | Skills mean | Delta |
|---|---:|---:|---:|
| Inference batch scheduler | 0.3150 | 0.5305 | **+0.2155** |
| Feature cache planner | 0.7151 | 0.7380 | +0.0229 |
| Vector shard rebalancer | 0.8375 | 0.8349 | -0.0026 |
| Sensor anomaly pipeline | 0.8980 | 0.8348 | **-0.0632** |

The scheduler result supplied most of the aggregate improvement. Four scheduler pairs improved and two were unchanged. By contrast, the sensor task had five negative pairs and one unchanged pair. This heterogeneity argues against treating “best-practice skills” as one universally beneficial intervention.

### Cost and behavior

Compared with control, the candidate used:

- **246,397 additional output tokens**, an increase of **46.3%**;
- **224 additional tool calls**, an increase of **31.2%**.

These are not hard budget violations, but they matter operationally. The skill treatment appears to have encouraged more investigation or deliberation. A treatment that improves quality only selectively while increasing output and interaction substantially should not be enabled globally without stronger evidence or a routing mechanism.

The experiment did not measure the causal contribution of each skill separately. Because both were introduced together, the result identifies only the effect of the combined pack. It cannot establish whether the scheduler gain came from general engineering guidance, JavaScript guidance, their interaction, or ordinary model variance.

## Conclusion

This experiment does **not** establish that adding generic engineering and JavaScript best-practice skills meaningfully improves overall coding-agent outcomes on the existing benchmark suite.

The combined pack produced a positive but non-significant aggregate score estimate, unchanged pass rate, much higher token/tool usage, and materially different effects by task and model. The preregistered positive hypothesis therefore failed and the formal verdict is neutral.

The strongest follow-up signal is the inference scheduler, not the pack as a global default. The sensor regression and execution-cost increase are equally important findings and should not be averaged away.

## Recommended next steps

### 1. Do not promote the combined pack globally yet

Keep the recipe as an experimental treatment. Do not add both skills to every normal coding session based on this result. The evidence does not meet the declared significance rule, and the cost increase is substantial.

### 2. Replicate the scheduler signal as a new preregistered experiment

Run a fresh matched experiment focused on optimization tasks with scheduler-like characteristics, using new repetitions or a versioned suite rather than rerunning completed trial IDs. Predeclare the expected score direction and retain the same pass and integrity gates. Treat the current scheduler result as hypothesis-generating because it was identified after looking across task-level outcomes.

### 3. Separate the two treatment factors

Use independent experiments for:

1. general engineering skill only;
2. JavaScript skill only;
3. both skills, if interaction remains of interest.

A factorial interpretation would reveal whether one skill drives quality or cost. Each comparison still needs a contemporaneous control, correction or caution for multiple comparisons, and an unchanged benchmark within that experiment.

### 4. Investigate the sensor regression before revising content

Review representative candidate/control traces to identify whether the skill treatment caused unnecessary rewrites, poor numeric assumptions, excess search, or merely correlated with stochastic model behavior. Do not rewrite the skill from scorer knowledge or tune directly to these four fixtures. Any revised skill must remain generic and be evaluated under a new recipe and experiment ID.

### 5. Test a shorter, more selective skill design

The current bodies are already moderate in size, but agents repeatedly read them and then used materially more output and tools. A future treatment could test:

- tighter descriptions that trigger only on relevant tasks;
- shorter checklists;
- one-time immediate loading instead of repeated reads;
- task- or language-aware routing rather than universal availability.

Quality and cost should be co-reported. The current benchmark's primary score should remain the primary outcome, while output tokens, tool calls, and skill reads remain declared secondary metrics.

### 6. Broaden languages only after establishing a useful JavaScript treatment

The current suite is entirely JavaScript, so it says nothing about Python, TypeScript-specific typing practices, Rust, Go, or other languages. A claim about “language-specific skills” in general requires calibrated tasks in those languages. First establish that the treatment formulation is useful and economical on JavaScript; then add language suites without changing existing benchmark tasks or retrofitting conclusions from this run.

### 7. Require replication before promotion

A reasonable promotion gate is:

- a fresh significant and practically meaningful paired score improvement;
- no pass-rate or policy regression;
- no material regression on any task family without an explicit routing rule;
- acceptable token/tool overhead;
- consistent evidence across both configured models, or a justified model-specific policy.

Until those conditions are met, the appropriate product decision is **no global default change**.

## Durable evidence

- Human-readable comparison: `data/experiments/javascript-general-skills-r1-2026-07-19/report.md`
- Experiment manifest and journal: `data/experiments/javascript-general-skills-r1-2026-07-19/`
- Treatment recipe: `benchmarks/recipes/javascript-general-best-practices-v1/`
- General skill: `benchmarks/recipes/javascript-general-best-practices-v1/skills/engineering-best-practices/SKILL.md`
- JavaScript skill: `benchmarks/recipes/javascript-general-best-practices-v1/skills/javascript-best-practices/SKILL.md`

The durable experiment directory contains immutable trial JSON, events, messages, broker logs, checks, metrics, and the generated paired report. Runtime workspaces, identities, worktrees, and owned Docker resources were cleaned after review.
