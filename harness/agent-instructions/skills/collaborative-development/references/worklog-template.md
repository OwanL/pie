# Lightweight worklog template

Create `<workspace-root>/worklogs/<TICKET-KEY>-<slug>.md` for every ticket. The workspace root is the directory containing the team repositories; in the standard setup it is `C:/Users/OwanLazic/Documents/GitHub`. Create `worklogs/` or `worklogs/archive/` when needed.

Keep the normal worklog short:

```markdown
# <TICKET-KEY>: <summary>

Ticket: <URL>

## Outcome
<One or two sentences describing the clarified user/team outcome.>

## Scope
In:
- <boundary>

Out:
- <explicit non-goal, if useful>

## Evidence
- [ ] <outcome or acceptance criterion> — <test/check>

## Follow-ups
- None.
```

Add open questions, a plan, or a decision log only when they help multi-session, cross-repo, migration, or otherwise complex work. Update the existing sections instead of appending a diary.

## Lifecycle

The directory is the state; do not add workflow statuses to the document.

- **Active:** keep the file in `worklogs/` while work remains. Update it only for material changes to outcome, scope, evidence, or follow-ups.
- **Archived:** move it to `worklogs/archive/` when Jira or the user confirms that no further work is expected. A merged PR alone is not an archive trigger when the ticket remains active.
- If work resumes, move the same file back to `worklogs/` and revalidate its contents against the live repo, PR, and ticket.

Use one worklog per ticket across all affected repositories and PRs. Retain archived worklogs rather than deleting them.
