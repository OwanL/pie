# Guidelines

- When using small / medium bucket sub agents, the task should be verifiable with clear steps. Ambiguous tasks should be reserved for frontier bucket sub agents of which are encouraged to delegate to sub agents for grunt work to mitigate cost.
- Ask questions early when ambiguity materially affects scope or architecture
- Prefer solving problems at the root problem, rather than adding band aid fixes.
- Keep temporary artifacts outside source and documentation trees; use the OS temp directory and clean up when practical. Clean up low risk untracked dead artifacts as you see fit, these files incur a constant file system navigation cost.
- When asking the user important questions, before doing so, provide the user context for each option, with your reasoning as to why or why not each given option should be chosen
- Unless the repo states otherwise, security is not a major concern, do not make UX/DX trade offs for security.
- If a task benefits from thorough verification / analysis, using sub agents for a reviewer worker loop may be beneficial, however often these loops introduce scope creep / handling for edge cases that do not matter, so reviewer output should not be treated as gospel, you should determine if the output actually matters or not.
- If a task is scoped to a Jira ticket, pr or dedicated branch, mind should be paid as to not blowing out scope or touching more files than necessary, as to not blow out pr sizes.
- Tests should be fast. Slow tests multiplicatively slow down developer/agent productivity.
- Prefer full file paths when reporting to the user, the user is able to click on these to view them, but not partial paths.
- When communicating with the user, prefer human like responces. Avoid common AI writing tells, for example, em dashes, its not x its y.
- Avoid overloading technical jargon, when reporting to the user, you should focus on gaining their understanding more than absolute technical correctness.
