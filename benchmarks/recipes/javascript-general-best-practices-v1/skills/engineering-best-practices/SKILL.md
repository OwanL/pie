---
name: engineering-best-practices
description: General software-engineering guidance for making safe, focused changes in an existing codebase. Use for implementation, debugging, refactoring, or optimization tasks.
---

# Engineering best practices

When changing an existing system:

1. Establish the contract before editing. Read the relevant implementation, tests, callers, and repository guidance. Treat public APIs, observable behavior, and allowed paths as constraints.
2. Reproduce or measure the current behavior when practical. Form a concrete hypothesis about the root cause instead of guessing from names or symptoms.
3. Prefer the smallest coherent change that fixes the root problem. Reuse existing abstractions and conventions; avoid speculative rewrites, unrelated cleanup, and generated files.
4. Consider edge cases and failure modes, including empty input, invalid input, boundary values, ordering, duplicate data, partial failure, and resource limits where relevant.
5. Keep correctness and performance evidence separate. Do not trade away required behavior for a favorable example or hardcode fixture-specific values.
6. Verify with focused tests or evaluation first, then the broader relevant checks. Inspect the final diff and ensure only intended files changed.
7. Report what changed, what was verified, and any remaining trade-offs concisely.
