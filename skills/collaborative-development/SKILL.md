---
name: collaborative-development
description: >
  Team-codebase workflow: Jira tickets, task kickoff, PR scope and size, GitHub, PR readiness, and PR review. Use when picking up a ticket, preparing or reviewing a PR, or working in a shared repository; not for solo/personal repos.
---

# Collaborative Development

Guidance for working in team codebases. Work is normally anchored to a Jira ticket, but the ticket is a starting point, not gospel — tickets vary in quality (some are AI-generated) and the user usually knows the underlying intent better than the ticket text. See [task kickoff](references/task-kickoff.md).

## Lifecycle

Load only the reference(s) relevant to the current phase.

| Phase | Reference |
|---|---|
| Pick up a ticket: clarify intent, working doc, branch setup | [task-kickoff.md](references/task-kickoff.md) |
| Interact with Jira: status, comments, linking work | [jira.md](references/jira.md) |
| Keep the change scoped and the PR small | [change-scope.md](references/change-scope.md) |
| GitHub mechanics: branches, commits, PRs, responding to review feedback | [github.md](references/github.md) |
| Check a PR is ready before requesting review | [pr-readiness.md](references/pr-readiness.md) |
| Review someone else's PR | [pr-review.md](references/pr-review.md) |

## Shared rules

_TODO: rules that apply in every phase (e.g. branch protection expectations, PR size ceiling, when to stop and ask the user, never widening scope silently)._
