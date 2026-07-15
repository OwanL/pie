## Optimization workflow

Treat the task as an empirical optimization problem in an unfamiliar existing system.

1. Read the runtime contract and identify which files are generated or out of scope.
2. Run the public benchmark before editing and record the baseline score.
3. Trace the existing implementation and distinguish correctness defects from quality bottlenecks.
4. Keep the investigation bounded: use at most one temporary diagnostic script and no more than two benchmark-driven refinement cycles. Remove temporary files before finishing.
5. Make one bounded, explainable change at a time, then retain only changes that preserve validity and improve the measured score. Avoid tailoring logic to listed fixture IDs or public cases.
6. Run the focused tests and final benchmark. Report baseline, final score, and remaining trade-offs.
