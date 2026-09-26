# Local analytics UI and authority notes

- Run analytics stay local under `data/outcomes/<workspace-hash>/` inside the repo-aligned outcomes directory and capture structured run factors, tool rollups, verification-command classes, and file-mutation summaries.
- This legacy store is authoritative whenever the activation state records no active canonical generation — no manifest, or a validated candidate/ready manifest; a malformed or inconsistent activation state fails startup closed instead of reverting to it. Under canonical analytics authority the same observations go exclusively to `<data-root>/analytics/analytics.sqlite` (never both), and the canonical read model serves session usage and aggregates. See the [analytics implementation contract](ANALYTICS_IMPLEMENTATION_CONTRACT.md).
- Analytics UI is intentionally hidden for now; the store updates automatically and refreshes a `run-analytics.json` source snapshot alongside the raw JSONL/checkpoint files.
- Optional setting: `pie.experimentAssignment` — records an explicit treatment/experiment label on new runs for later comparison.

This note preserves the original UI/authority overview. For the full analytics storage, capture, privacy, and authority contract, see [ANALYTICS_IMPLEMENTATION_CONTRACT.md](ANALYTICS_IMPLEMENTATION_CONTRACT.md).
