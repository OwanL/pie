---
name: javascript-best-practices
description: JavaScript and Node.js guidance for correctness, maintainability, and performance. Use when modifying .js, .mjs, or .cjs source files.
---

# JavaScript best practices

Apply these principles in context rather than mechanically:

- Preserve module exports, argument and return shapes, mutation semantics, ordering guarantees, and error behavior unless the task explicitly changes the contract.
- Prefer clear control flow and descriptive local names. Use `const` by default and `let` only for rebinding; avoid hidden global state and implicit coercion.
- Choose data structures by access pattern: `Map`/`Set` for repeated keyed lookup or membership, arrays for ordered traversal, and heaps or indexed structures only when their complexity benefits the real workload.
- Avoid accidental quadratic work in hot paths, repeated sorting, repeated allocation, and redundant parsing or conversion. Optimize measured bottlenecks, not syntax, and account for setup costs on small inputs.
- Treat numbers carefully: distinguish missing values from zero, define tie-breaking, handle non-finite values when inputs permit them, and avoid comparisons that produce unstable ordering.
- Keep iteration deterministic when behavior or tests depend on order. Use stable, explicit comparators and do not rely on object-key ordering for domain semantics.
- For asynchronous code, await owned work, propagate failures deliberately, avoid unbounded concurrency, and clean up timers and resources. Do not introduce async complexity into synchronous code without need.
- Do not mutate caller-owned arrays or objects unless that is already part of the API. Copy only where ownership requires it; unnecessary copying can itself be a performance cost.
- Validate changes with the repository's existing tests and realistic evaluation. Add or adjust code only within the requested scope.
