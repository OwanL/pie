# Jira

Use for ticket reads, collaborator-visible updates, links, assignments, and transitions. For Reveal-Tech conventions, also read [team-conventions.md](team-conventions.md).

## Connector and reads

Use the active Jira MCP integration; subagents may not have access, so perform Jira operations in the main session. Follow any connector preflight required by [team-conventions.md](team-conventions.md).

Reads need no approval. Before acting, fetch the issue's description, status, assignee, labels, parent, links, comments, development links, and available transitions. Prefer live fields and transitions over remembered workflow names.

## Writes

Jira writes require an explicit user request or approval. If the exact action or wording was not supplied, draft it first. Batch a related assignment, transition, and short comment into one approval request where practical.

Keep the split clear:

- The worklog holds agent working state, scope, evidence, and candidate follow-ups.
- Jira holds findings, decisions, dependencies, and progress teammates need to see.

## Routine moments

- **Kickoff:** if needed, draft assignment to the driving developer and the available In Progress transition.
- **Meaningful discovery or decision:** draft a concise comment only when collaborators would otherwise miss important context.
- **PR or dependency:** rely on the ticket key for automatic development links where supported; add native issue links or a comment when the dependency is not otherwise clear.
- **After merge/resolution:** fetch available transitions, then draft the outcome comment and appropriate transition. Do not guess who owns QA or release stages.

## Creating and splitting work

Out-of-scope findings stay under Follow-ups in the worklog until the user decides to file them. A proposed issue should:

- use the issue type definitions in [team-conventions.md](team-conventions.md),
- state the problem and desired outcome rather than prescribing an unsupported solution,
- use the relevant existing epic when one exists,
- use native links such as Blocks, Relates, Duplicate, or Work item split.

Draft the issue first; create or link it only after approval.
