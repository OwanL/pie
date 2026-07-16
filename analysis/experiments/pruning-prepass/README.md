# Skill-pruning prepass experiments

Date: 2026-07-16

## Decision rule

The human label is binary: **1 = keep** when the candidate has a greater-than-50% chance of being invoked before the current request is complete; **0 = prune** otherwise. Labels include implied exploration, editing, validation, debugging, and cleanup. Merely being generally useful is not enough.

The original benchmark has 10 sessions and 75 independently labelled candidates. It intentionally includes fresh tasks, follow-ups, an explicit pivot, read-only diagnosis, current web research, session review, and a request needing no capability. The incremental sweep adds 15 controlled cases (176 decisions per pass total) plus an 18-case, 143-decision holdout built from verbatim local session prompts. The holdout preserves the user's typo-heavy, vague, brain-dump wording and includes context-dependent prompts such as “Yes, go ahead with this” and “and in main ui.”

| Case | Candidates in model order | Human bits (1 = keep) |
|---|---|---|
| isolated-feature | tdd, codebase-maintenance, diagnose, read, edit, bash, web_search | `0001110` |
| diagnosis-read-only | diagnose, pi-logs, codebase-maintenance, read, bash, edit, session_review, web_search | `11011000` |
| controlled-experiment | harness-experiments, tdd, evaluate-sessions, read, edit, bash, web_search | `1001110` |
| pruner-model-research | harness-experiments, add-provider, codebase-maintenance, tdd, read, edit, bash, web_search, session_review | `110011110` |
| follow-up-provider | add-provider, evaluate-sessions, read, edit, bash, web_search, session_review | `1011110` |
| follow-up-fix | diagnose, tdd, read, edit, bash, web_search, session_review | `1011100` |
| explicit-pivot | add-provider, tdd, session_changes, read, edit, bash, web_search | `0011000` |
| session-review | evaluate-sessions, pi-logs, codebase-maintenance, session_review, subagent, read, edit, web_search | `10011000` |
| current-web-research | add-provider, pi-logs, web_search, get_search_content, fetch_content, read, edit, bash | `00111000` |
| no-capability-needed | diagnose, tdd, add-provider, read, edit, bash, web_search | `0000000` |

The complete requests, descriptions, history snippets, and per-candidate labels live in [benchmark.json](./benchmark.json), [benchmark-extra.json](./benchmark-extra.json), and [benchmark-real.json](./benchmark-real.json). [extract-real-prompts.mjs](./extract-real-prompts.mjs) extracts candidate prompts and observed subsequent tool calls from local session JSONL; labels remain human decisions under the >50% boundary rather than blindly treating every observed call as necessary.

## High-volume incremental sweep

[sweep.mjs](./sweep.mjs) runs resumable paired trials with per-call JSONL checkpoints, repeated sampling seeds, order-safe canonical name mapping, and case-clustered bootstrap intervals. The 2026-07-16 sweep made 3,130 scored Ollama calls and evaluated 23,012 binary labels, excluding a 50-call smoke test:

| Phase | Prompts | Variants | Seeds | Calls | Binary labels |
|---|---:|---:|---:|---:|---:|
| Broad controlled screen | 25 | 24 | 3 | 1,800 | 12,672 |
| Real-prompt holdout | 18 | 10 | 5 | 900 | 7,150 |
| Fresh-seed finalist replication | 43 | 2 | 5 | 430 | 3,190 |

The broad screen changed one dimension at a time:

| Dimension | Forged alternatives sent to Qwen 3.5 9B | Outcome |
|---|---|---|
| Sampling | Installed default `temperature=1`; explicit `0`, `.2`, `.5` | `.2` was the only improvement with a significant controlled accuracy and false-prune gain; it also led the real holdout |
| Grammar/schema | Prompt-only JSON; Ollama JSON mode; dynamic name-enum schema; typed skill/tool schema; fixed binary array | Plain flat `{"keep":[]}` remained best. Name schemas reproduced baseline decisions but added latency; typed/binary schemas reduced accuracy to 86.7%/70.3% and were much slower |
| Names/aliases | Canonical names; opaque `C01` IDs; semantic aliases | IDs added latency; aliases over-triggered generally useful tools and regressed both accuracy and validity |
| Descriptions | Current compact text; 80 chars; first sentence; names only; `Can:/Use when` rewrite | 80 chars/first sentence were statistically indistinguishable but not better; names-only collapsed to 80.7% controlled accuracy and caused parse failures |
| Catalog shape/order | Grouped skills then tools; tools first; flat numbered list; shuffled order | No repeatable gain. Flat lists caused parse failures and extra false keeps; shuffling exposed modest order sensitivity |
| Conversation input | Latest only; recent users only; bounded user+assistant dialogue; full history; previous keep decision | Bounded user+assistant dialogue won. On real vague prompts, user-only history significantly increased false prunes; full history produced an 18.5s tail without a quality gain |
| Decision grammar | Current probability/full-arc prompt; causal “materially hinder”; minimal prompt; next-step frontier | Short/causal prompts were faster but lost accuracy. Next-step selection over-pruned capabilities needed later in the work arc |

### Finalist result

Five fresh seeds over all 43 prompts produced 1,595 decisions per arm:

| Contract | Accuracy | Keep recall | Prune recall | False prunes | False keeps | Median | p95 | Parse failures |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Model default (`temperature=1`) | 90.97% | 85.92% | 95.57% | 107 | 37 | 1,188 ms | 1,913 ms | 0 |
| **Explicit `temperature=.2`** | **92.85%** | **87.63%** | **97.60%** | **94** | **20** | **1,128 ms** | **1,393 ms** | **0** |

The paired accuracy delta was **+1.82 percentage points** with a case-clustered bootstrap 95% interval of **+0.56 to +3.23**. Paired mean latency improved by 139 ms (95% interval 100–177 ms faster). False-prune direction improved, though its per-case interval still crossed zero; keep recall nevertheless improved in the aggregate and no other error category regressed.

### Research-informed hypotheses

- [Constraint Tax](https://arxiv.org/abs/2605.26128) reports that structured decoding can improve validity while reducing semantic accuracy in small language models. The sweep therefore scored parse validity separately from label correctness; this benchmark reproduced the semantic penalty for richer typed/binary schemas.
- [ToolChoiceConfusion](https://arxiv.org/abs/2606.06284) argues that lexical relevance alone is insufficient and proposes causal/precondition-effect filtering. The causal prompt was tested directly; it was faster but too keep-heavy on this full-session prediction target.
- [ToolDreamer](https://arxiv.org/abs/2510.19791) and [MetaTool](https://arxiv.org/abs/2310.03128) motivate treating query/tool-description mismatch and tool-use selection as first-class problems. Static semantic aliases did not help here and increased false keeps, so production retains canonical names plus concise trigger-rich descriptions.
- [ToolRet](https://arxiv.org/abs/2503.01763) highlights tool retrieval as a distinct hard problem. The results support treating prepass pruning as catalog retrieval for the full request arc, not a next-action router.

## Forged prompt contracts

The exact executable prompts are in [run.mjs](./run.mjs), and every result JSON records the exact system and user messages sent. These are the material prompt differences:

| Contract | Core instruction given to the small model | Output | Calls per case |
|---|---|---|---:|
| `current-prune-json` | “Decide which skills and tools can be safely REMOVED… Default to KEEPING.” | `{"pruneSkills":[],"pruneTools":[]}` | 1 |
| `catalog-keep-bits` | “Output 1 when probability of use is >50%; 0 otherwise; one bit per candidate.” | aligned bitstring | 1 |
| `catalog-prune-bits` | Same classification with `1 = prune`, `0 = keep`. | aligned bitstring | 1 |
| `item-keep-bit` | “For this one candidate, return exactly 1 if probably used, otherwise 0.” | one bit | candidate count |
| `item-label` | Same one-candidate question using natural binary labels. | `KEEP` or `PRUNE` | candidate count |
| `catalog-keep-json` | Select >50% candidates, separated into skill and tool keep arrays. | `{"keepSkills":[],"keepTools":[]}` | 1 |
| `catalog-keep-list` | Select >50% candidates into one flat list, removing type confusion. | `{"keep":[]}` | 1 |
| `production-keep-list` | Flat keep list plus explicit full-arc, follow-up, pivot, named-skill, web, and implementation guidance. | `{"keep":[]}` | 1 |

Reinforced bitstring and JSON-array variants were also tried. Qwen frequently copied the example (`101`), emitted one overall bit, or returned the words `KEEP`/`PRUNE` despite the numeric instruction. The flat JSON keep list was both simpler for the model and simpler to recover safely.

## Prompt/call-shape result

Warm-model latency is wall time until the prepass decision is available; that is the extra gate before the main provider request can begin. The same 75 labels were used throughout.

| Model | Contract | Accuracy | False prunes | False keeps | Parse-failed cases | Median case latency | Calls |
|---|---|---:|---:|---:|---:|---:|---:|
| Qwen 2.5 7B | current prune JSON | 50.7% | 1 | 36 | 0 | 929 ms | 10 |
| Qwen 2.5 7B | catalog keep bits | 44.0% | 3 | 39 | 9 | 738 ms | 10 |
| Qwen 2.5 7B | one numeric call/item | 76.0% | 16 | 2 | 0 | 3,575 ms | 75 |
| Qwen 2.5 7B | one label call/item | 74.7% | 19 | 0 | 0 | 3,219 ms | 75 |
| Qwen 2.5 7B | typed keep JSON | 88.0% | 5 | 4 | 0 | 1,231 ms | 10 |
| Qwen 2.5 7B | flat keep list | 88.0% | 5 | 4 | 0 | 1,475 ms | 10 |
| Qwen 3.5 9B | exact production keep list | **96.0%** | **3** | **0** | **0** | 1,499 ms | 10 |

The proposed “one call per skill/tool” design is rejected for now. Even with four concurrent requests it duplicated the request/context 75 times, used roughly 4–5× the prompt tokens, was 2–3× slower per case, and over-pruned general coding capabilities. Independent calls also lose the useful contrast between candidates.

## Local-model result

All models were warmed before scoring, used temperature 0 and seed 42, and ran the same flat keep-list contract.

| Model | Accuracy | False prunes | False keeps | Parse failures | Median case latency |
|---|---:|---:|---:|---:|---:|
| **Qwen 3.5 9B** | **94.7%** | **4** | **0** | **0** | 1,263 ms |
| Qwen 2.5 7B Instruct | 88.0% | 5 | 4 | 0 | 1,475 ms |
| Qwen 3.5 4B | 80.0% | 15 | 0 | 0 | 1,381 ms |
| Phi-4 Mini 3.8B | 77.3% | 17 | 0 | 0 | **706 ms** |
| Gemma 3 4B | 74.7% | 6 | 13 | 0 | 1,209 ms |
| Granite 4.1 8B | 68.0% | 17 | 7 | 0 | 922 ms |
| Llama 3.2 3B | 56.0% | 6 | 27 | 1 | 747 ms |

Qwen 3.5 9B is the only tested model near the quality/latency Pareto frontier: it materially improves accuracy over Qwen 2.5 while also being slightly faster on the common flat contract. The very fast 3–4B models pay for their latency with 15–17 false prunes.

## What context should reach the call?

| Context | Accuracy | False prunes | False keeps | Median case latency | Decision |
|---|---:|---:|---:|---:|---|
| Latest request only | 93.3% | 5 | 0 | 1,342 ms | Too weak for references |
| Recent user messages only | 93.3% | 5 | 0 | 1,104 ms | Misses completed/remaining-work clues |
| Recent user + assistant snippets | **94.7%** | **4** | **0** | 1,256 ms | **Keep** |
| Full stacked dialogue | 94.7% | 4 | 0 | 2,232 ms | Reject: no quality gain, more anchoring/input |
| Recent dialogue + previous prepass | 94.7% | 4 | 0 | 3,546 ms | Reject: exact production prompt regressed |

Recommendations:

- Send the latest request verbatim.
- Keep the existing bounded recent user/assistant snippets, including assistant tool-use names. They resolve “that”, “again”, and “continue” without replaying the transcript.
- Do not stack all user prompts or the full dialogue. Older unrelated work did not improve a decision and increased latency.
- Do not send agent reasoning or raw tool results. A short assistant outcome plus tool names is enough signal and avoids large/noisy payloads.
- Do not send previous pruning decisions. They duplicate a fallible model judgment and can anchor the next pass. Sticky recovered tools and the existing continuation cache already preserve the high-confidence operational information.
- Stop at compaction boundaries, as production already does; do not expand summarized history back into raw turns.

## Ollama versus LM Studio

There is no evidence-backed reason to migrate this prepass to LM Studio yet. Both servers expose OpenAI-compatible APIs, grammar-backed structured output, and parallel inference. Ollama already supports [JSON-schema structured outputs](https://docs.ollama.com/capabilities/structured-outputs) and [configurable per-model parallel requests](https://docs.ollama.com/faq#how-does-ollama-handle-concurrent-requests). LM Studio offers the same core advantages through [structured output](https://lmstudio.ai/docs/developer/openai-compat/structured-output) and [continuous batching](https://lmstudio.ai/docs/app/advanced/parallel-requests). Since the winning design is one short call with zero parse failures, changing the serving client would add operational surface without addressing the remaining semantic misses.

Structured decoding remains a useful follow-up once `pi-ai` exposes `response_format` on this completion path. It is not needed to ship the current change because the winning model/contract had no parse failures and the parser still fails open.

## Shipped production change

- Replace the two-category prune response with flat positive `{"keep":[]}`.
- Convert the keep list to internal prune lists by complement; retain backward parsing for old prune-list responses.
- Make `>50% probability of actual invocation` the primary decision rule. `topK` ceilings are tie-breakers only.
- Keep bounded user+assistant history and candidate-description compaction.
- Add Qwen 3.5 9B to the Ollama model catalog and select it for the active prepass with `discretion` strategy.
- Set the active Ollama prepass temperature to `.2`; it is an explicit optional prepass setting so providers that reject temperature overrides remain unaffected.
- Preserve parse-failure, tool-dependency, always-keep, recovery, and empty-agent safeguards.

Operational note: Pie's model registry is loaded by the running backend. If the backend has not restarted since the Qwen catalog entry was added, the prepass reports `Model 'qwen3.5:9b' (provider: ollama) not found in registry` and fails open. Ollama and the generated catalog already contain the model; restart Pie once to load both the registry entry and the `.2` setting.

## Reproduce

```powershell
node analysis/experiments/pruning-prepass/run.mjs --models qwen3.5:9b --approaches production-keep-list --contexts dialogue
node analysis/experiments/pruning-prepass/run.mjs --models qwen2.5:7b-instruct,qwen3.5:4b,qwen3.5:9b,gemma3:4b,phi4-mini:3.8b,llama3.2:3b,granite4.1:8b --approaches catalog-keep-list --contexts dialogue
node analysis/experiments/pruning-prepass/sweep.mjs --suite real --variants baseline,temperature_0,temperature_02,json_schema_names,compact_80,first_sentence,semantic_aliases,latest_only,user_history,causal_prompt --seeds 401,502,603,704,805
node analysis/experiments/pruning-prepass/sweep.mjs --suite all --variants baseline,temperature_02 --seeds 906,1007,1108,1209,1310
```

Raw trial outputs and resumable checkpoints are under `results/`. This is a deliberately difficult local benchmark, not a universal model claim. The next useful validation is shadow-mode outcome analysis after restart: stratify real pruning decisions by input size and vague-follow-up status, then inspect recoveries and false-prune reports.
