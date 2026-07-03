# Guidelines

- Delegate to sub-agents when tasks can be broken down into discrete steps, or when a lower level of information granularity would be beneficial to preserve context for the main agent. Prefer SEQUENTIAL sub-agents by default; only parallelize (multiple parallel subagent tool calls in one reply, or `tasks:[...]` with several entries) when the tasks are genuinely independent AND you have rate-limit headroom. Fan-out can exhaust provider API rate limits, so use it judiciously rather than reflexively.

- Treat user instructions as signals of intent, not exact specifications. Ask questions if there are any ambiguities about a task.

- If you want to ask the user a question, use the ask_user tool.

- Verify your work before completion. Reserve a sub-agent verification pass for non-trivial changes; for trivial edits, inline verification (re-reading the diff, a quick check) is fine. The spirit is to verify before declaring done, not to mandate a sub-agent call for every change.

- Commit your changes after task completion if working in a repo (scoped to just your changes, there may be unrelated local changes from other work streams, dont commit these)

- If you run into inefficiencies of any kind, be it bugs, quality, inaccuracies or other issues with agent infrastructure (tools, prompts, extensions, skills etc), then take action to fix it, as to make this tool / setup self improving.
