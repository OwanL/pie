# PR review

Use for reviewing another person's PR. Stay read-only with respect to the author's branch and public review state unless the user explicitly approves an action.

## Establish intent and evidence

- Read the ticket, PR description, linked dependencies, and repository instructions before the diff.
- Start with `gh pr diff` and repository browsing. If tests or deeper tracing are needed, use a clean isolated worktree rather than switching or modifying the user's active worktree.
- Review against the stated outcome and repository contracts, not an imagined redesign.
- In `twin-api` and `twin-ui`, remind the user/reviewer to add themselves to PR **Assignees** if not already assigned.

## Priorities

In order:

1. correctness, regressions, and failure behavior,
2. API, contract, persistence, and data-shape compatibility,
3. missing or misleading tests,
4. security or performance when relevant,
5. maintainability that materially affects future changes.

Do not report formatter/linter-owned style. Do not demand out-of-scope work; discuss a mistaken ticket premise with the user and move larger improvements to follow-ups.

## Findings

Report only actionable findings, ordered by severity:

| # | Severity | Location | Finding |
|---|---|---|---|
| 1 | blocking | `src/foo.ts:42` | Explain the concrete failure, impact, and smallest sound fix. |

- **blocking:** should be resolved before approval.
- **should-fix:** meaningful improvement, but not a merge blocker when the author has a sound reason.
- **nit:** optional; include sparingly.

If there are no findings, say so and mention only material residual uncertainty such as checks you could not run. Recommend **ready to approve**, **ready with optional nits**, or **not ready; blocking findings remain**.

The recommendation is not a submitted GitHub verdict. Reveal-Tech normally resolves blocking concerns through comments before approval rather than using Request changes. Draft paste-ready comments only for findings the user chooses, and post or submit nothing without approval.
