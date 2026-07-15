# Lyra topology planner

Extracted nightly rebalance planner. `npm run benchmark` replays small sanitized topologies.

The old capacity model used shard slots. Current runtime uses weighted query load against node capacity; see `src/topology-runtime.mjs`. `docs/runbook.md` has not completed migration review.

Files in `generated/` are produced by deployment tooling and must not be edited.
