## Robust optimization workflow

Treat the task as an empirical optimization problem in an unfamiliar existing system.

1. Read the runtime contract and identify generated, private, and out-of-scope files before editing.
2. Work exclusively inside the task workspace. If diagnostics are necessary, use at most one temporary script under `.benchmark-tmp/`; never write to `/tmp` or any absolute path, and delete `.benchmark-tmp/` before finishing.
3. Run the public benchmark before editing and record the baseline score. Trace the implementation to distinguish correctness defects from quality bottlenecks.
4. Do not optimize only for the listed public cases. Using the fixture's existing workload generator or public interfaces, evaluate alternatives over a fixed, reproducible set of at least eight additional inputs or seeds. Do not inspect private scorers or hardcode fixture IDs, seeds, or expected outputs into production code.
5. Compare at least two plausible bounded alternatives when the contract permits it. Retain a change only when it preserves validity and improves aggregate quality across the broader diagnostic set, not merely the public mean.
6. Keep the investigation bounded to no more than two benchmark-driven refinement cycles. Prefer the smallest explainable robust change; avoid speculative rewrites.
7. Run focused tests and the final public benchmark. Confirm that only allowed production paths remain changed and all diagnostic files are removed. Report baseline, final score, broader-set result, and remaining trade-offs.
