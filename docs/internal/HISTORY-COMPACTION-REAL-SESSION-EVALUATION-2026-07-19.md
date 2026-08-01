# Real-session history-compaction evaluation — 2026-07-19

## Scope and privacy

This is an offline, aggregate-only analysis of the authoritative local Pie session store, `data/outcomes/sessions/`. Raw sessions were processed only in the trusted host process. The analyzer emits no session identifiers, prompts, summaries, file paths, source text, or tool output.

This report is the retained record of that analysis; the one-shot analyzer script has been retired. The findings below are observational evidence, not a controlled quality experiment. The corpus has only five sessions containing compaction, so conclusions should guide implementation and a later controlled benchmark rather than establish causality.

## Corpus

| Measure | Result |
|---|---:|
| Session files | 67 |
| Sessions with compaction | 5 |
| Sessions with repeated compaction | 2 |
| Compaction entries | 11 |
| Malformed JSONL lines | 0 |

## Token behavior

All token values below are either persisted Pi measurements (`tokensBefore`) or privacy-safe `chars / 4` estimates over model-visible entry shapes.

| Measure | Minimum | Median | Maximum |
|---|---:|---:|---:|
| Tokens before compaction | 31,922 | 193,332 | 371,606 |
| Summary tokens | 585 | 3,709 | 6,764 |
| Recent tokens retained | 11,517 | 18,925 | 20,346 |

The estimated post-compaction-to-pre-compaction ratio had a median of **11.3%**. One early compaction retained at least half of its prior footprint (**55.5%**), showing that compaction near 32k with a roughly 20k retention budget reclaims relatively little. A 100k soft trigger with 30k retention should avoid that specific low-yield shape.

## Layered-compaction signal

| Measure | Result |
|---|---:|
| Median tool-result share of summarized history | **81.0%** |
| Maximum tool-result share | **98.1%** |
| Compactions where tool results were at least one third of summarized history | **11/11** |

This strongly supports a gentle, age-aware tool-history layer before full LLM summarization. It does **not** mean Pie's deterministic tool-result pruning should be merged with history compaction: tool-result pruning rewrites each current tool result before it enters context, while historical tool-group collapse would operate later on complete, old tool-call/result groups.

Recommended future layered policy:

1. Keep deterministic per-result pruning as the inflow layer.
2. At an intermediate history budget, collapse old complete tool-call/result groups while preserving recent groups and atomicity.
3. At the configured soft/hard history thresholds, run structured LLM compaction.
4. Keep overflow detection and one bounded retry as the emergency backstop.

A controlled experiment is still needed to determine whether historical collapse improves completion quality rather than merely reducing tokens.

## Durable structured state

| Measure | Result |
|---|---:|
| Entries with durable `readFiles` and `modifiedFiles` arrays | 11/11 |
| Repeated-compaction modified-file cumulative checks | 6/6 |
| Repeated-compaction tracked-file union cumulative checks | 6/6 |
| Repeated-compaction read-only-list cumulative checks | 1/6 |
| Summaries with all required structured headings | 11/11 |
| Summaries with `<read-files>` tags | 11/11 |
| Summaries with `<modified-files>` tags | 10/11 |
| Median durable read-file count | 44 |
| Median durable modified-file count | 18 |

The low read-only-list cumulative score is expected when a previously read file later becomes modified: Pi moves it from the read-only list into the modified list. The union of tracked files remained cumulative in every repeated-compaction check.

The durable details object was more reliable than prose formatting: all entries retained structured file arrays, while one generated summary omitted its modified-file tag. This supports extending `CompactionEntry.details` (or an adjacent durable sidecar) rather than relying solely on iterative prose for critical state.

Recommended durable spine fields for a future treatment:

- Exact modified-file set
- Test commands and latest outcomes
- Unresolved errors and blockers
- User requirements and constraints
- Architectural decisions with status (`active` or `superseded`)
- Current plan and next action

File tracking already has evidence of correct cumulative behavior. The additional fields require a schema, deterministic extraction where possible, and a later decision-preservation benchmark.

## Conclusions

1. **Expose retention now:** observed retained history clustered around Pi's 20k default, confirming this hidden setting materially defines post-compaction shape.
2. **Raw 100k/150k thresholds remain reasonable:** the median historical compaction occurred near 193k, while the one 32k compaction was low-yield.
3. **Layered tool-history handling is worth prototyping:** old tool results dominated every summarized span, with an 81% median share.
4. **Durable structured state should supplement prose:** tracked-file unions survived all repeated compactions, while prose tags were not perfectly reliable.
5. **Do not claim a quality win yet:** this offline analysis measures composition and persistence, not downstream task correctness. A controlled compaction-recall suite remains the appropriate next evaluation step.
