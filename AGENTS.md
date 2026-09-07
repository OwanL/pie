# Global agent conventions

This file loads globally because the Pie checkout is also Pi's configuration directory.
Follow the target repository's own instructions for its development workflow.

For work on Pie itself or its Pi-based configuration, read the
[develop-pie skill](skills/develop-pie/SKILL.md) (relative to this file) for repository
conventions, commands, and architecture references. Do not load it for unrelated
repository work merely because Pie is the active harness.

## Traversal safety

<!-- canonical-traversal-policy:start -->
Traversal safety: dependency, version-control, generated/build, cache, coverage, runtime-data (e.g. data/), session, log, packaged-artifact, and temporary-SDK trees are protected. Never traverse them with broad recursive searches (`grep -r`, bare `find .`) or unscoped directory walks; known protected directories are pruned automatically, and the rest are simply very large. To inspect a protected path deliberately, read an exact file, scope the search to that path, or use a Git-aware tool (rg). Do not widen a search to work around an empty result.
<!-- canonical-traversal-policy:end -->

This block is drift-checked against `shared/traversal-policy.ts` in the Pie checkout.

## Shell and paths

On Windows the harness `bash` tool is Git Bash, not PowerShell. Use `/dev/null`
for shell redirection, never `NUL`; a literal `NUL` file breaks Windows ripgrep
traversal. Native Windows programs may print `%TEMP%` paths even when Bash also
exposes the same directory as `/tmp`; tools should accept either spelling. Use
native `C:/...` paths for Windows programs and Git-Bash `/c/...` paths for shell
commands. For Node ESM imports from a Windows path, use
`pathToFileURL(...).href` instead of importing a raw drive-letter path. Scope
`MSYS2_ARG_CONV_EXCL` to the individual native command that needs it; never set
it globally. When no ripgrep match is an acceptable result, use `rg ... || true`.
