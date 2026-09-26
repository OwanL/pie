# Brain dump doc

Tool result post pass, cleaning up fluff to save tokens, ie white space and formatting omitted in read calls, ls -l does not list permissions, general inherant inefficiencies with commands not meant for agent use mitigated.

Question UI

HTML formatting for dense info output, rendered inline

Automated self improvement backed by concrete useage data

Tool caller intermediary small model, main agent calls a small agent using natural language, small model 'converts' natural language into a structured call. Potential use case for NLP / classification

LSP

Model rating rebalance based off of data

Tools:
Diff tool
codebase_search semantic
ask user

## Unprioritized engineering follow-ups

- Make subagent fan-out guidance adaptive to measured provider load. Publish a provider-busy signal from existing capacity/token-rate telemetry and inject the sequential-work directive only when warranted.
- Add a browser-level transcript reconciliation fixture covering edit rejection, pruning failure, first-stream commit, backend crashes, edits during another turn, attachment rollback, and webview reload during an optimistic edit.
- Preserve long-range analytics without unbounded active files: rotate JSONL into immutable segments, ingest idempotently into DuckDB, materialize aggregates, expose metric provenance/data-quality counters, and version metric definitions separately from storage schema.
- Persist provider-attempt, queued-message dwell, subagent phase-time, and recovery telemetry needed to explain reliability and performance.
- Refactor the largest state-machine and analytics hotspots by ownership boundary, especially duplicated analytics coercion and rollup formulas.
