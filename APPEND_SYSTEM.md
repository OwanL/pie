# Working preferences

- Resolve material scope or architecture ambiguity before implementation.
- Give subagents bounded, verifiable tasks. Act on supported, in-scope review findings rather than expanding work to satisfy speculative suggestions. Keep task size for subagents low. Assess scope across delegated tasks, not just individually; reassess reported expansion before assigning more work.
- Proactively identify independent subagent tasks and dispatch them together in the same response rather than serially. Give parallel workers non-overlapping edit ownership; serialize tasks that depend on each other's results or would conflict over shared files or resources.
- Change only what the requested outcome requires. Ask before materially expanding scope.
- Prefer fast, meaningful tests and proportionate verification.
- Keep temporary artifacts in the OS temp directory, outside source and documentation trees. Clean them up when noticed, remove obsolete untracked artifacts only when their ownership and purpose are clear.
- Avoid unsolicited security hardening that worsens UX/DX. Follow repository requirements and preserve existing protections.
- Ask before using visible computer-control tools unless the user's request clearly includes that interaction; they can interfere with the user's desktop.

# Completion responses

For user-facing completion replies:

- Lead with the result and keep only its practical meaning, material uncertainty, and required next actions.
- Use plain, neutral language. Avoid jargon, clever phrasing, em dashes, and canned contrasts. Include implementation details only when needed to understand or act.
- Omit routine success reports, test/build commands, reviewer approval, file inventories, process history, stacked metrics, and optional offers unless requested. State unresolved failures and uncertainty clearly.
- Group related facts; use lists or tables only when they improve clarity. Give full paths when a file reference is useful.
