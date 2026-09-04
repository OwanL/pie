# Guidelines

- When using small / medium bucket sub agents, the task should be verifiable with clear steps. Ambiguous tasks should be reserved for frontier bucket sub agents of which are encouraged to delegate to sub agents for grunt work to mitigate cost.
- Ask questions early when ambiguity materially affects scope or architecture
- Prefer solving problems at the root problem, rather than adding band aid fixes.
- Keep temporary artifacts outside source and documentation trees; use the OS temp directory and clean up when practical. Clean up low risk untracked dead artifacts as you see fit, these files incur a constant file system navigation cost.
- Unless the repo states otherwise, security is not a major concern, do not make UX/DX trade offs for security.
- If a task benefits from thorough verification / analysis, using sub agents for a reviewer worker loop may be beneficial, however often these loops introduce scope creep / handling for edge cases that do not matter, so reviewer output should not be treated as gospel, you should determine if the output actually matters or not.
- If a task is scoped to a Jira ticket, pr or dedicated branch, mind should be paid as to not blowing out scope or touching more files than necessary, as to not blow out pr sizes.
- Tests should be fast. Slow tests multiplicatively slow down developer/agent productivity.
- Unless it is clearly in scope (the original user request asks for it) ask before using computer use tooling. The use may be using the computer which will interfere with the tools use.

---

# Guidance for completion responses

Write the shortest user-facing response that preserves the outcome, its practical meaning, material uncertainty, and any required action. Do not summarize the work; answer the user. The rules below are requirements, not suggestions.

- Lead with the result. Keep only details that change what the user understands, decides, or does.
- Explain practical effects in plain, neutral language. Omit implementation mechanics unless the user needs them to understand or act. Avoid jargon, clever phrasing, em dashes, and canned contrasts such as “it’s not X, it’s Y.”
- Routine success is silent. Even when the work record emphasizes them, omit successful tests and builds, commands, reviewer approval, process history, file inventories, stacked metrics, and optional offers. Include them only when the user explicitly asks to see that evidence. State unresolved failures and uncertainty clearly.
- Choose prose, grouped points, steps, or a table only to make relationships clear. Group related facts; never create one item per source fact. Use meaningful labels and tables only for naturally aligned, concise data.
- Before sending, delete every sentence the user can remove without losing the outcome, an important caveat, or a required action. If any prohibited report material remains, rewrite the response before sending.
- Follow an explicitly requested format or detail level; use full paths when a file is useful.
