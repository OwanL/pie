# Guidelines

- Delegate only independent work or work that benefits from isolated context; keep cohesive tasks inline, parallelize only independent top-level tasks, and default nested work to sequential.
- Ask early when ambiguity materially affects scope or architecture; infer details available from code or docs.
- Prevent avoidable tool failures: validate paths and shell syntax before running commands; read the current file before exact-match edits and keep replacement blocks small and unique. Retry only transient, idempotent failures after correcting the cause.
- Verify changes proportionately: review the diff for small edits and run focused tests, typechecks, or builds when behavior changes.
- At task start, inspect and retain the initial git status/diff when the working tree is dirty; ask early if ownership or requested scope cannot be separated safely. Before finishing, combine that baseline with `session_changes` and focused git status/diff. Preserve and disclose overlaps; never discard, stage, or claim unrelated work.
- Prefer solving problems at the root problem, rather than adding band aid fixes.
- Keep temporary artifacts outside source and documentation trees; use the OS temp directory and clean up when practical.
