# Pie analytics

This package reads privacy safe `run-analytics` exports or local analytics
storage stores, prepares typed rows, and builds a local DuckDB database for
named analytics queries. It has no dashboard or static site pipeline.

## Commands

```powershell
npm run typecheck
npm run test
npm run build-db -- --help
npm run query -- --name core_runs
```

`build-db` accepts an explicit export or storage directory and writes the
requested DuckDB database. `query` opens an existing database or rebuilds the
local default when its run stores or catalog inputs are newer. Named queries
cover core runs, verification, tool usage and failures,
treatment comparisons, timeline, pruning prepass cost, warm bash, retry
timing, and latency friction.

The fixture at `fixtures/small-run-analytics.json` is used only when an
explicit source is omitted in test and development flows. Prepared rows retain
unknown values as null and preserve privacy safe hashes; raw prompts, paths,
tool output, and review material are not part of this package output.

The source reader supports the versioned export and storage formats documented
in the analytics implementation contract. Storage discovery is explicit and
does not search outside the selected outcomes root. DuckDB staging files remain
in the selected exports directory so the build inputs can be inspected.
