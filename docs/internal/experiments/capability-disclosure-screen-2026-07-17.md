# Capability disclosure screening — 2026-07-17

## Question

Which recovery surface gets a model the hidden tool or skill it needs with the least unnecessary context and interaction?

The screening compared four forced-hidden treatments against contemporaneous all-visible baselines:

- unified catalog + immediate skill body;
- unified catalog + skill metadata followed by `read`;
- separate tool/skill catalogs + immediate skill body;
- separate tool/skill catalogs + skill metadata followed by `read`.

The model was `umans/umans-glm-5.2` at medium thinking, one repetition, on three deterministic tasks: no recovery needed, hidden tool needed, and hidden skill needed. All runs used isolated Docker targets and the benchmark credential broker. Context below is provider-reported input plus cache-read tokens. Advertised schemas is the sum of tool-schema counts across provider requests.

An earlier unified-immediate diagnostic run exposed a benchmark policy defect: declared skill files under `/bundle/skills` were blocked by the workspace path guard. Those results are excluded. The guard was narrowed to permit read-only access through the `read` tool to declared skill resources, the image was rebuilt, and all four R2 experiments were freshly captured and run.

## Results

All 24 R2 trials completed their deterministic checks with clean policy state. The dynamic treatments kept every hidden capability marker out of the initial provider request. A poll introduced names only; the selected tool schema or skill body appeared on a later model step. On the no-recovery task, hidden names never entered candidate context.

### Candidate results

| Variant | Task | Provider requests | Tool calls | Context tokens | Advertised schemas |
|---|---|---:|---:|---:|---:|
| Unified / immediate | no recovery | 4 | 3 | 2,609 | 12 |
| Unified / immediate | hidden tool | 7 | 6 | 6,054 | 25 |
| Unified / immediate | hidden skill | 6 | 5 | 5,968 | 18 |
| Unified / metadata | no recovery | 4 | 3 | 2,611 | 12 |
| Unified / metadata | hidden tool | 7 | 6 | 6,232 | 25 |
| Unified / metadata | hidden skill | 7 | 6 | 6,661 | 21 |
| Separate / immediate | no recovery | 4 | 3 | 2,718 | 16 |
| Separate / immediate | hidden tool | 8 | 11 | 14,683 | 41 |
| Separate / immediate | hidden skill | 7 | 8 | 8,247 | 28 |
| Separate / metadata | no recovery | 4 | 3 | 2,722 | 16 |
| Separate / metadata | hidden tool | 9 | 11 | 14,988 | 48 |
| Separate / metadata | hidden skill | 6 | 7 | 7,091 | 24 |

### Unified-immediate paired context

| Task | All-visible baseline | Dynamic candidate | Delta |
|---|---:|---:|---:|
| no recovery | 3,638 | 2,609 | -28.3% |
| hidden tool | 7,296 | 6,054 | -17.0% |
| hidden skill | 6,163 | 5,968 | -3.2% |
| **Total** | **17,097** | **14,631** | **-14.4%** |

Its summed advertised-schema count fell from 120 to 55 (-54.2%). Recovery added two model steps on the hidden-tool task and two on the hidden-skill task. Immediate skill delivery saved one request, one tool call, 693 context tokens, and three cumulative schemas versus unified metadata on the hidden-skill task.

## Behavioral findings

The unified protocol was followed directly:

```text
read task evidence
→ request_capability({})
→ request_capability({ exact type and name })
→ use selected tool / apply selected skill
```

The separate protocol caused substantial confusion despite explicit concise instructions. On hidden-tool trials the model repeatedly crossed between `request_tool` and `request_skill`, loaded irrelevant skills, and invoked an irrelevant provenance tool. The separate-immediate hidden-tool sequence reached eleven tool calls and 14,683 context tokens, over twice unified-immediate's context.

The unified no-recovery candidate did not poll. It retained only `read`, `write`, and `request_capability`, and none of the hidden names or skill markers appeared in any provider payload.

The all-visible baselines also showed distraction: on hidden-tool tasks the model loaded/read irrelevant skill material and invoked `package_provenance_lookup` in addition to the correct artifact tool. Dynamic unified recovery avoided that behavior.

## Decision

Promote **unified catalog + immediate skill loading** to the end-to-end stage.

The screening supports this model-facing contract:

- one always-visible `request_capability` tool;
- omit arguments to list grouped hidden names only;
- pass exact `capabilityType` and `capabilityName` to select;
- activate a selected tool for the next model step;
- return a selected trusted skill body immediately;
- hide all unselected descriptions, schemas, paths, and skill bodies;
- reconsider recovered tools at the next pruning decision.

This is a directional one-model, one-repetition screen, not a final source-of-truth comparison.

## Production end-to-end stage

The winning protocol was then implemented in the real skill-pruner and run with the actual GLM prepass against both configured main models (`capability-production-pruner-e2e-r2-2026-07-17`). All six pairs were primary-eligible. Treatment and baseline had identical deterministic pass rate (5/6); both Kimi hidden-skill trials made the same task-level normalization error.

The real prepass correctly removed every optional capability on no-recovery tasks and retained the explicit artifact tool and Quartz skill on their matching tasks. Dynamic context was materially lower on several pairs, but the prepass added one provider request and itself emitted substantial hidden reasoning (roughly 10–25 seconds and up to 1,346 output tokens in observed trials). Main-session usage metrics do not include those prepass tokens, so they must not be presented as total end-to-end savings.

The initial production tool trial also exposed an instruction-compliance issue: GLM used the correct retained artifact tool but polled the hidden catalog in parallel, then over-explored irrelevant provenance capabilities. The guideline was strengthened to forbid polling to verify, supplement, or replace a suitable active capability. A fresh focused run (`capability-production-tool-guideline-r1-2026-07-17`) reduced the candidate sequence to:

```text
read → one names-only poll → retained artifact tool → write → verify
```

It made no irrelevant activation and used 5,875 main-context tokens versus 9,018 for its contemporaneous all-visible baseline, though the single poll remained redundant. This is acceptable for the first production iteration but remains a measurable optimization target. The recovery API should not become a general exploration tool.

The end-to-end evidence supports shipping unified immediate recovery independently of broader prepass optimization: it fixes autonomous skill recovery, removes session-long tool accumulation, and keeps unselected schemas/bodies hidden. It does **not** establish that the current LLM prepass is always net-cheaper once its own latency and reasoning tokens are included.

## Durable evidence

R2 experiment roots:

- `data/experiments/capability-unified-immediate-screen-r2-2026-07-17/`
- `data/experiments/capability-unified-metadata-screen-r2-2026-07-17/`
- `data/experiments/capability-separate-immediate-screen-r2-2026-07-17/`
- `data/experiments/capability-separate-metadata-screen-r2-2026-07-17/`
- `data/experiments/capability-production-pruner-e2e-r2-2026-07-17/`
- `data/experiments/capability-production-tool-guideline-r1-2026-07-17/`

Each contains immutable trial JSON, raw events, messages, broker logs, checks, and its generated report. Runtime data remains git-ignored.
