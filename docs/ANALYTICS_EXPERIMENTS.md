# Analytics storage experiments

Status: exploratory synthetic measurements, 2026-09-09. Not production qualification.
Related: [scope plan](ANALYTICS_REWORK_PLAN.md),
[implementation contract](ANALYTICS_IMPLEMENTATION_CONTRACT.md).

The user authorized mock experiments. No production code, installed configuration, real sessions or
runtime data was changed. Scripts, generated databases and raw results were placed in one uniquely
owned OS-temp directory, not committed as a second analytics pipeline.

## Corrected experiment only

Earlier runs are **superseded and must not support an engine decision**. The original probe passed
integral JS numbers to DuckDB `bindValue`, which selected INT32. Epoch-millisecond values wrapped;
e.g. `1735690844443` was stored as `524056859`. Token/count-only oracles missed this because those
inputs fitted in INT32. Some preliminary topology cases also scanned a different file from the writer.

The corrected pass explicitly used `bindBigInt(index, BigInt(value))` for integral DuckDB parameters,
including query bounds. A ten-row timestamp smoke test gated the full run. Ordered/keyset verification
checked every scalar field, configurations, session deadlines and actual payload byte hashes, both
before and after clean reopen. Both engines had zero mismatches and identical normalized readback
hashes. This validates the generated dataset's persistence, not production billable semantics.

## Fixture and method

- Windows 10.0.26200 x64, AMD Ryzen 9 6900HX, 16 logical CPUs, about 15.3 GiB RAM; about 3.2 GiB
  available at corrected-run start. The desktop was not isolated and OS caches were not flushed.
- Node 24.16.0; built-in SQLite 3.53.0; DuckDB 1.5.2 via `@duckdb/node-api` / bindings 1.5.2-r.1
  resolved from the existing analysis package. No package installation was needed. Initial runs used
  the Proto-resolved Node and corrected runs the existing native Node of the same pinned version;
  exact executable paths are retained in raw runtime metadata, not a machine-wide toolchain change.
- Corrected direct tests: 100,000 generic 22-field facts, 5,000 sessions, 12 configurations and 10,000
  linked payloads. Primary/idempotency plus session/time/model/parent/payload/deadline indexes.
- Payload mix: 95% 2 KiB, 4.9% 32 KiB, 0.1% 2 MiB among linked payloads; 56,483,840 logical bytes.
  80% repetitive content, 20% deterministic unique content. No application compression or content
  deduplication. Payload sizes are clustered by ID, not a realistic stationary arrival distribution.
- SQLite WAL + synchronous FULL, 5-second busy timeout; DuckDB one thread, 256 MB engine memory limit,
  default durable persistent commits/native compression. These are not identical durability controls;
  no crash/power-loss equivalence was demonstrated.
- Prepared multi-row INSERT transactions, 50 facts per transaction; 2,000 samples per engine. Timings
  include per-batch fixture assembly, hashing and binding as well as commit; no IPC in this direct test.
  Separate fixture preparation, schema/setup and full verification are outside that timing.
- Queries run ten times each after ingestion/verification. Report observed p50/max, not a claimed
  population p99 from ten reads. Full readback verification took 5.28 s SQLite / 9.68 s DuckDB across
  its two passes; it is test overhead, not a proposed production replay operation.

### Direct results

| Measurement | SQLite | DuckDB |
|---|---:|---:|
| 50-fact transaction p50 / p95 / p99 | 5.54 / 35.39 / 45.16 ms | 37.07 / 59.12 / 81.56 ms |
| Transaction maximum | 378.66 ms | 578.32 ms |
| Sustained unpaced bulk facts/s | 5,702 | 1,277 |
| Indexed session query p50 / max | 0.114 / 0.717 ms | 3.664 / 4.518 ms |
| Lifecycle point query p50 / max | 0.012 / 0.081 ms | 0.413 / 0.700 ms |
| Due-deadline range query p50 / max | 0.156 / 0.382 ms | 1.037 / 1.643 ms |
| Model/time aggregation p50 / max | 16.72 / 23.95 ms | 1.76 / 1.99 ms |
| Parent join p50 / max | 28.01 / 30.85 ms | 8.15 / 8.95 ms |
| Broad grouped history p50 / max | 157.99 / 203.54 ms | 7.39 / 7.95 ms |
| Final database bytes after close | 103,079,936 | 101,462,016 |
| Database + WAL/SHM immediately after writes | 114,735,256 | 88,201,301 |

The 50-row p99 is **not** a single-small-fact end-to-end latency. The chosen prepared-INSERT adapter
was measured, not every viable native path; in particular an optimized DuckDB appender/staging path
with equivalent idempotency still needs evaluation. Snapshot schema/index tuning may also change
results. Do not extrapolate 100k timings into a 10M-row performance claim.

Process peak RSS was approximately 351 MiB SQLite / 641 MiB DuckDB, including fixture work and full
verification. This is not isolated steady-state recorder memory. Bulk CPU was 63% / 95% of one logical
core respectively, at different maximum throughputs, not CPU at a matched 50-fact/s production load.
The DuckDB engine memory limit did not cap total Node/native RSS.

Raw direct BLOB timing is **not used for comparative conclusions**: its generic result consumer hashed
SQLite byte arrays but did not equivalently unwrap DuckDB BLOB values (`blobBytes=0`). Corrected
canonical verification did explicitly read/hash all actual bytes; a future detail-latency probe must
use the same byte materialization/consumption on both engines and report each payload size separately.

## Corrected same-live-database mixed check

Each condition cloned its verified 100k fixture. A producer sent one fact per transaction over Node IPC
at 50/s for 15 seconds (750 acknowledgements), with 10% precomputed 2 KiB source detail. One broad scan
per second read the **same live database** being written. SQLite used a query worker thread/connection
beside its helper writer; DuckDB used two connections to the same instance in its helper. These are
viable but different native concurrency arrangements, not a pure engine-only isolation experiment.

| Measurement | SQLite | DuckDB |
|---|---:|---:|
| Source -> commit ACK p50 / p95 / p99 | 2.67 / 5.81 / 15.65 ms | 10.88 / 14.67 / 25.03 ms |
| ACK maximum | 44.46 ms | 67.28 ms |
| Broad scan p50 / max (15 scans) | 146.51 / 171.58 ms | 7.68 / 9.83 ms |
| Sampled helper peak RSS | 80.2 MiB | 112.3 MiB |
| Helper queue maximum messages / bytes | 1 / 3,413 | 3 / 4,007 |

ACK latency includes reply IPC, not just observation-to-commit. No matched non-analytics baseline,
repeated independent trials or 10k-sample steady-state qualification was performed. Both ended with
100,750 facts / 10,075 payloads and passed totals/literal-row checks; scans observed newly committed
rows, with eventual visibility in both engines. Equivalent final broad-scan checksums were verified.
A sample taken before the first write commit is allowed to see the previous snapshot.

Neither result met the then-proposed small-fact p99 <= 9 ms ingestion target. Subsequent user alignment
applies single-digit milliseconds to synchronous agent-path overhead, not background commit latency.
These ACK timings do not measure that overhead or establish UI/agent non-interference; the changed
target does not make these runs production qualification. The query results favor DuckDB's scans and
SQLite's point/write workload in these particular prototypes.

## Interpretation and remaining gate

No production engine is selected. These measurements support testing SQLite's incremental path first,
not a production choice or proof of execution isolation. The current decision procedure is owned by
[the scope plan](ANALYTICS_REWORK_PLAN.md) §10; the real-producer prototype, workload and numerical
gates are owned by [the implementation contract](ANALYTICS_IMPLEMENTATION_CONTRACT.md) §6. This evidence
note does not maintain a second set of future requirements.

The generic fixture's cross-session parent links, ID-modulo span kinds and placeholder prices are not
a semantic accounting oracle. These runs did not establish nested-child payload ownership, referenced
result reconstruction, cross-window refresh, delete-on-close races or operational writer revocation.
The aligned follow-up changes that future qualification work, not the measurements above. No production
activation is authorized; the deferred outage/overflow policy remains undecided.

## Reproduction and evidence

Local temporary evidence root (not a permanent source/dependency path):
`C:/Users/OWANLA~1/AppData/Local/Temp/pie-analytics-micro-OFPJmz/`.

- `probe-fixed.mjs`, `run-fixed-probes.mjs`: corrected direct runner and orchestration.
- `corrected-summary.json`, `corrected-hashes.json`, `corrected-commands.txt`, `runtime-fixed.json`:
  exact settings/commands, script hashes, machine context and invalidation evidence.
- `sqlite-100k-batch50-fixed.json`, `duckdb-100k-batch50-fixed.json`: direct raw samples and full oracles.
- `topology-correction-fixed.mjs`; directory `topology-microcheck-run-1788930844995-22752/` containing
  `source-fixture.json`, `topology-microcheck-summary.json`, `same-live-{sqlite,duckdb}.json`: corrected
  mixed protocol/raw samples. Only this mixed run is used above.
- Seed: `pie-analytics-micro-2026-09-09-seed-v1`.
- Dataset digest: `e6c330343b2ca4f129e483c6d3bb45ca39a6d9b8d14c6fd78330b0283c304f85`.
- Persisted scalar-facts digest: `23fda215edd2dba8325880126746288b5079519646df5e3f96a9d43e1e36f788`.
- Persisted payload digest: `495923adaaf8d41534ad9ad1459c3601c8e6791b37b91b9a008af4f929b1be72`.

Per-pass resource caps were enforced; the corrected direct phase took 125.3 seconds and the optional
mixed phase was separately bounded. Raw summaries report their incremental disk use, not an assertion
that all exploratory passes together occupied only one pass's budget. These temp paths can expire;
this document retains the corrected observations and limitations, not a permanently runnable benchmark
package. Superseded/smoke generated databases were removed after review; corrected seeds/mixed data and
all scripts/raw results remain temporary. No generated databases belong in the repository or its
documentation tree.
