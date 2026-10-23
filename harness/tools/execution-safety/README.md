# safeguard

Blocks high-confidence dangerous agent operations before they execute. Purely programmatic—no LLM calls.

## Design

Shell input is lexed into executable commands before policy checks run. Quoted arguments, comments, grep/rg patterns, and heredoc bodies are treated as data rather than scanned as commands. This avoids prompts when agents write tests/docs/scripts that merely contain dangerous-looking examples.

The policy intentionally favors precision:

- **Hard block** only catastrophic operations with a clear executable and destructive arguments.
- **Prompt** meaningful system changes, broad permissions, and recursive force-deletes outside the project or disposable directories.
- **Allow** ordinary development operations, including read-only firewall/network inspection, permission changes on concrete project children, public SSH keys, and cross-project `.env`, shell-config, `.gitconfig`, and `.ssh/config` edits. Private keys, AWS credentials, npm auth, and Docker auth still prompt outside the cwd.

## Behavior

- **Bash timeout passthrough** — bash timing fields are never rewritten; omitted or invalid timeouts are resolved by the executor (warm-bash applies the `PIE_BASH_DEFAULT_TIMEOUT` default, nonpositive values use the default, and explicit timeouts are capped at the maximum). Explicit valid timeouts reach the executor unchanged.
- **Hard blocks** — disk/volume destruction, root recursive deletion, boot/recovery tampering, reverse shells, remote-content-to-shell pipelines, fork bombs, and writes to core system paths.
- **Prompts** — privilege escalation, recursive force-deletes outside the cwd, destructive service/firewall/account changes, broad permission changes, system package removal, and writes to credential-bearing files outside the cwd. Concrete children of `/tmp`, `/var/tmp`, or the platform temp directory are treated as routine cleanup; platform temp aliases such as Windows short and long paths are recognized. Deleting a temp root or using a broad wildcard still prompts.
- **Autonomous mode** — while `PIE_AUTONOMOUS_MODE=1` (see `harness/tool-and-skill-selection/settings/autonomous-mode.ts`), confirmation-required operations are immediately refused with a blocked tool result instead of opening the confirmation dialog, since nobody is present to answer. Allowances and hard blocks are unchanged; clearing the flag restores normal prompts.
- **Shell context** — backslash-newline continuations are removed outside single quotes. Simple `cd` command lists track possible success/failure directories, including `&&`, `||`, pipelines, background lists, and nested shell payloads, while retaining the original project boundary. Dynamic directory changes remain uncertain; this is not a full shell interpreter. On Windows, native drive paths and Git Bash drive mounts compare equally. Hard blocks take priority over prompts, including across nested shells.
- **Redirection handling** — redirection operators (`>`, `<`, `>>`, `2>`, `2>&1`, `&>` and numbered variants) and their targets are parsed as shell data and excluded from command and `rm`-target analysis. This keeps routine forms such as `rm -rf ./build 2>/dev/null` from being misread (`2>/dev/null` as a delete target) or `git status > log.txt` from treating the redirect target as a command, while redirections can never hide a dangerous command elsewhere in the line.

## API

This directory owns shared shell and path helpers. The policy and public API
are implemented by the [safeguard extension](../../../extensions/safeguard/index.ts).
From this directory:

```typescript
import { isSafe } from '../../../extensions/safeguard/index.ts';

isSafe('rm -rf ./build', { cwd: '/repo' }); // true
isSafe('rg "rm -rf /" docs/', { cwd: '/repo' }); // true: quoted search data
isSafe('rm -rf /', { cwd: '/repo' }); // false
isSafe('sudo apt update', { cwd: '/repo' }); // false: requires prompt
```

Bash timeout defaults do not belong to the safeguard; see `extensions/warm-bash` (whose implementation lives in `harness/tools/warm-bash/timeout.ts`) for executor-owned resolution.
