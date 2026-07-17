## Robust investigation workflow

Treat this as a production regression in an unfamiliar existing system.

1. Read the runtime contract and identify generated and out-of-scope files before editing.
2. Work exclusively inside the repository. If diagnostics are necessary, use at most one temporary script under `.diagnostics-tmp/`; never write to `/tmp` or any absolute path, and delete `.diagnostics-tmp/` before finishing.
3. Reproduce the current behaviour before editing and record the relevant results. Trace the implementation to distinguish correctness defects from quality bottlenecks.
4. Use existing workload generators or exported interfaces to check your assumptions over a fixed, reproducible set of at least eight additional inputs or seeds. Do not hardcode data IDs, seeds, or expected outputs into production code.
5. Compare at least two plausible bounded alternatives when the contract permits it. Retain a change only when it preserves correctness and improves aggregate behaviour across the broader diagnostic set.
6. Keep the investigation bounded to no more than two refinement cycles. Prefer the smallest explainable robust change and avoid speculative rewrites.
7. Run focused tests and reproduce the original scenario again. Confirm that only relevant production paths remain changed and all diagnostic files are removed. Report the before and after results, the broader diagnostic result, and remaining trade-offs.
