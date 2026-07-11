# safeguard

Blocks high-confidence dangerous agent operations before they execute. Purely programmatic—no LLM calls.

## Design

Shell input is lexed into executable commands before policy checks run. Quoted arguments, comments, grep/rg patterns, and heredoc bodies are treated as data rather than scanned as commands. This avoids prompts when agents write tests/docs/scripts that merely contain dangerous-looking examples.

The policy intentionally favors precision:

- **Hard block** only catastrophic operations with a clear executable and destructive arguments.
- **Prompt** actions that can legitimately be needed but alter system state.
- **Allow** ordinary development operations, including cross-project `.env`, shell-config, `.gitconfig`, and `.ssh/config` edits. Credential-bearing files such as private keys, AWS credentials, npm auth, and Docker auth still prompt outside the cwd.

## Behavior

- **Default bash timeout** — applies a 600s default to `bash` calls without a positive finite timeout. Explicit timeouts are preserved.
- **Hard blocks** — disk/volume destruction, root recursive deletion, boot/recovery tampering, reverse shells, remote-content-to-shell pipelines, fork bombs, and writes to core system paths.
- **Prompts** — privilege escalation, recursive force-deletes outside the cwd, destructive service/firewall/account changes, system package removal, and writes to credential-bearing files outside the cwd.

## API

```typescript
import { isSafe, DEFAULT_BASH_TIMEOUT_SECONDS } from './index.js';

isSafe('rm -rf ./build', { cwd: '/repo' }); // true
isSafe('rg "rm -rf /" docs/', { cwd: '/repo' }); // true: quoted search data
isSafe('rm -rf /', { cwd: '/repo' }); // false
isSafe('sudo apt update', { cwd: '/repo' }); // false: requires prompt

DEFAULT_BASH_TIMEOUT_SECONDS; // 600
```
