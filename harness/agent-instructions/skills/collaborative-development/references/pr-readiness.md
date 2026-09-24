# PR readiness

Use the gate matching the next action. Report blockers first, then the smallest action needed; do not dump a successful checklist unless asked.

## Draft-ready

Before opening or substantially updating a draft PR:

- Read the full diff against the intended base, including staged, committed, generated, and untracked files relevant to the work.
- Every hunk traces to the worklog Outcome/Scope; remove debug code, accidental files, secrets, stale TODOs, and unrelated churn.
- Run the repository's documented, proportionate verification. New or changed behavior has tests at the right seam.
- Update obligated docs, API specs/contracts, generated artifacts, and the worklog evidence.
- Prepare a title and body using the current repository template; state risk and cross-repo dependencies accurately.

## Human-review-ready

Before marking ready or requesting a human review:

- Draft-ready still holds for the latest commit.
- The PR description matches the final diff and contains concrete verification evidence.
- Required CI is green or any unresolved external failure is clearly disclosed.
- Automated review findings have been handled. In `twin-api` and `twin-ui`, all Copilot comments must be resolved.
- The branch has no known conflict with the base.
- CODEOWNERS and repository norms have been checked before choosing reviewers.

## Merge-ready

Before recommending merge:

- Required CI is green on the current head and there are no conflicts.
- Required human/code-owner approval is present and outstanding review threads are resolved.
- Any required screenshots, migration/rollout notes, counterpart PRs, or dependency order are present.
- Jira is in the appropriate live workflow state; draft any due transition rather than assuming it.
- Verification evidence and follow-ups are current in the worklog.

State one of: **draft-ready**, **human-review-ready**, **merge-ready**, or **not ready** with blockers. Readiness is a report; externally visible actions still follow the approval boundary in [github.md](github.md).
