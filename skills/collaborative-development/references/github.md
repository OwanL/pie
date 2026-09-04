# GitHub

Use the authenticated `gh` CLI for GitHub API actions. For Reveal-Tech defaults and templates, also read [team-conventions.md](team-conventions.md).

## Autonomy

Proceed with branch creation, commits, pushes to the user's own feature branch, and investigated CI re-runs. GitHub collaboration actions require an explicit request or approval: opening/editing/closing PRs, comments, labels, review requests, submitted reviews, and merging.

Never push to `main`, mutate another person's branch, or submit an approval/request-changes verdict under the user's identity. Ask before force-pushing once review activity exists.

## Branches and commits

- Inspect status and existing branches before switching. Preserve unrelated work.
- In Reveal-Tech repos, branch from fetched `origin/main` as `<TICKET-KEY>-kebab-summary`.
- Keep a pushed branch current by merging `main`; do not rebase it without agreement.
- Follow the repository's recent commit style. Intermediate commits should be coherent enough to debug even where squash merge is common.
- Before committing, inspect staged content so unrelated files are not included.

## PR lifecycle

1. Pass the **draft-ready** gate in [pr-readiness.md](pr-readiness.md).
2. When requested, draft a concise title and body from the repository template. Preserve the ticket key and describe the outcome; provide verification evidence.
3. Once the user approves opening it, open as draft unless they explicitly request a ready PR.
4. Address CI and automated review feedback.
5. Pass the **human-review-ready** gate, then ask who should review if CODEOWNERS or prior context does not answer it. Mark ready/request review only after approval.
6. Re-request review after a substantive feedback round, with approval.
7. Pass the **merge-ready** gate. The user controls merge and branch deletion.

## CI and review feedback

Treat a failure as real until investigated. Re-running a check is fine when evidence suggests infrastructure or flakiness; do not use reruns to avoid understanding a deterministic failure.

For each review comment, either change the code or draft a concise reason not to. Resolve only after the concern is addressed. Larger suggestions remain follow-ups unless the user deliberately expands scope.

After merge, update the worklog and prepare any Jira outcome comment or transition through [jira.md](jira.md). Archive the worklog only when no further work is expected, as defined in [worklog-template.md](worklog-template.md).
