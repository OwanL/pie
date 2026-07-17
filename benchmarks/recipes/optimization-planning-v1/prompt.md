## Investigation workflow

Treat this as a production regression in an unfamiliar existing system.

1. Read the runtime contract and identify which files are generated or out of scope.
2. Reproduce the current behaviour before editing and record the relevant results.
3. Trace the existing implementation and distinguish correctness defects from quality bottlenecks.
4. Keep the investigation bounded: use at most one temporary diagnostic script and no more than two refinement cycles. Remove temporary files before finishing.
5. Make one bounded, explainable change at a time, then retain only changes that preserve correctness and improve the observed behaviour. Implement a general solution rather than tailoring logic to specific data IDs or examples.
6. Run the focused tests and reproduce the scenario again. Report the before and after results and any remaining trade-offs.
