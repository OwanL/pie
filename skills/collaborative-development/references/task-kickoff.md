# Task kickoff

Use when starting or resuming ticketed implementation work.

## 1. Establish local context

- Read the repo's `AGENTS.md`, `CONTEXT.md` where present, and directly relevant domain docs.
- Inspect `git status`, the current branch, remotes, and existing branches for the ticket key before changing branch state.
- Preserve unrelated work. Do not stash, reset, switch away from a dirty branch, or reuse an ambiguous existing branch without asking.

## 2. Read the ticket

- Fetch description, acceptance criteria, status, assignee, labels, parent, links, comments, and development links through Jira. See [jira.md](jira.md).
- Read linked tickets or recent related PRs only when they can clarify intent, dependencies, or established implementation patterns.
- Judge the ticket by substance. Unsupported implementation details, including plausible AI-generated detail, need corroboration from code, docs, or the user.

If team code work has no ticket, ask once whether one exists or should be created before branching; do not invent a key.

## 3. Clarify only what matters

Summarize the intended outcome and in/out boundary. If the ticket is clear and the code agrees, record that interpretation and proceed. Ask the user before coding only when ambiguity could materially change behavior, scope, architecture, or risk.

The user's clarified intent supersedes the raw ticket wording. Record a ticket mismatch in the worklog and propose a teammate-visible Jira note if it matters to collaborators.

## 4. Create or resume the worklog

- Create `worklogs/` if absent, then search from the workspace root: `rg --files worklogs | rg '<TICKET-KEY>-'`.
- Create the lightweight file from [worklog-template.md](worklog-template.md) if none exists.
- Record outcome, in/out scope, and how each acceptance outcome will be verified. Keep follow-ups empty until needed.

## 5. Prepare the branch

For Reveal-Tech repos, use `<TICKET-KEY>-kebab-summary` from current `origin/main`:

1. Fetch `origin`.
2. If the worktree is safe to switch and no branch exists, create it from `origin/main`.
3. If a branch exists locally or remotely, inspect it and reuse it only when it clearly belongs to this work.

Creating the branch, committing, and pushing it are autonomous. Never push to `main` or another person's branch.

## 6. Claim the work

If assignment or an In Progress transition is due, present one combined Jira draft for approval. Do not let this block safe local discovery, but resolve it before substantial implementation because team practice is to claim work before beginning.

Then continue with [change-scope.md](change-scope.md) while implementing and [github.md](github.md) for Git/PR work.
