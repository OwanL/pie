# Change scope

Use throughout implementation to keep the change aligned with the clarified outcome and easy to review.

## Boundary

The worklog's Outcome and Scope are the current contract. Update them deliberately with the user when the intended outcome changes; do not let implementation convenience move them silently.

Necessary support for the scoped behavior is in scope even when the ticket does not name every file:

- tests for new or changed behavior,
- contract/spec and user-facing documentation updates,
- generated artifacts and lockfile changes required by the source change,
- a small in-path repair without which the scoped diff would be misleading or broken.

Unrelated cleanup, speculative abstractions, broad test expansion, and drive-by refactors are not in scope.

## Detect drift

Warning signs:

- a touched file has no path back to the outcome,
- the change starts solving a second user problem,
- a rename, move, formatting pass, or dependency update obscures the behavioral diff,
- review feedback expands the intended outcome.

When drift appears, remove it or record it under Follow-ups. If it genuinely must ship with this work, explain why and get agreement before updating Scope.

## Keep the PR reviewable

Prefer one coherent outcome per PR. Propose a split when parts can be reviewed, deployed, and reverted independently or when mechanical churn hides behavioral reasoning. Do not split coupled generated files, migrations, or compatibility work merely to reduce line count.

For cross-repo changes, use one PR per repo, change the contract owner first, and link dependencies. For a preparatory/behavioral split, ensure each PR leaves the repository valid and makes the dependency explicit.
