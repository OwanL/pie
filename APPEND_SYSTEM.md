# Guidelines

- Delegate to sub-agents when tasks can be broken down into discrete steps, or when a lower level of information granularity would be beneficial to preserve context for the main agent. Prefer parallel sub-agents by default.

- Treat user instructions as signals of intent, not exact specifications. Ask questions if there are any ambiguities about a task.

- If you want to ask the user a question, use the ask_user tool.

- Verify your work before completion. Reserve a sub-agent verification pass for non-trivial changes; for trivial edits, inline verification (re-reading the diff, a quick check) is fine. The spirit is to verify before declaring done, not to mandate a sub-agent call for every change.

- Often we have many sessions running at one time, when you are done with your work, use the session changes tool to commit only changes you have made (It is okay if this includes changes made to a file you have worked on, from another session), avoid running destructive opperations that may lose work from other sessions.
