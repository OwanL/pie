# Reveal-Tech team conventions

Use this profile only for `reveal`, `twin-api`, and `twin-ui`. Repository instructions and live configuration are authoritative; inspect them when a fact affects the work.

## Sources of truth

- All repos: `AGENTS.md`; also `CONTEXT.md` in `reveal` and `twin-api`.
- Jira: `reveal/docs/agents/issue-tracker.md` and `reveal/docs/agents/triage-labels.md`.
- PR content: `reveal/.github/pull_request_template.md`, `twin-api/pull_request_template.md`, or `twin-ui/pull_request_template.md`.
- Review ownership and checks: each repo's CODEOWNERS and `.github/workflows/`.

## Repositories and dependencies

| Repo | Owns | Default verification |
|---|---|---|
| `reveal` | Pipelines, workflow orchestration, shared packages and service contracts | Repo `AGENTS.md`; normal CI entrypoint is `moon ci` |
| `twin-api` | Product API and long-running operations | `yarn build`, `yarn test`, `yarn lint`; use `yarn test:one <path>` while iterating |
| `twin-ui` | Product UI and client state | `yarn build`, `yarn typecheck`, `yarn test`, `yarn lint` |

For cross-repo contracts, change the owner first. `twin-api` syncs workflow contracts from `reveal`; `twin-ui` syncs OpenAPI artifacts from `twin-api`. Use one PR per repo, disclose the dependency, and link counterpart PRs.

## Jira defaults

- Engineering work belongs to project `UM`.
- **Story**: requires merged code. **Task**: discovery or other non-code work. **Bug**: defect. **Epic**: initiative grouping.
- Stories and tasks normally belong under the relevant existing epic.
- Triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
- Claim/assign work before beginning and use the issue's currently available transitions; do not assume a remembered status sequence.

Use the active Jira connector. If it requires Atlassian site discovery and `cloudId`, call `atlassian_getAccessibleAtlassianResources` first as the team documentation requires. A connector that exposes project-scoped Jira tools directly may not require that preflight.

## GitHub defaults

- Default branch: `main`.
- Feature branch: `<TICKET-KEY>-kebab-summary`.
- Keep a pushed branch current by merging `main`; do not rebase it without agreement.
- Draft PRs are the normal starting point. Squash merges are common, but not universal, so inspect the repo/PR rather than assuming a merge method.
- Preserve the ticket key in the PR title and make the title a useful outcome-oriented commit subject. Follow the repo's recent title style rather than imposing one commit convention.
- Copilot reviews PRs automatically. The twin repo templates require all Copilot comments resolved before requesting human review.
- CODEOWNERS can request reviewers. In `reveal`, Data Ops co-owns several registry/config paths; inspect CODEOWNERS instead of assuming one reviewer is sufficient.
- A reviewer of a `twin-api` or `twin-ui` PR should add themselves to the PR's **Assignees**, as required by those templates.

## PR templates

- `reveal`: choose Impact Level; provide concise Context, Change, Risk & Mitigation when relevant, and Verification evidence.
- `twin-api` / `twin-ui`: Jira link and story readiness, test considerations, counterpart UI/API dependency, risk, security, debt, and screenshots where relevant.
- Delete template guidance and inapplicable optional sections where the template permits it. Provide evidence rather than assurances.
