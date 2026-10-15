## description

Delegate one concrete task to a specialized agent with isolated context; isolation is not sandboxing — the child shares the parent's process, filesystem, and credentials. Agents are discovered automatically from both user and project directories, including project agents under an explicitly provided cwd.

## disabled-description

DISABLED: Sub agents are currently disabled. Calls to this tool will return an error immediately. Enable by removing the --no-subagent flag or unsetting the PI_SUBAGENT_DISABLED environment variable.

## snippet

Delegate one small, bounded task to a discovered agent; prefer parallel sibling calls for independent tasks.

## disabled-snippet

DISABLED: Sub agents are disabled.

## guideline

Proactively dispatch independent, small subagent tasks together as sibling calls in one response. Give parallel workers non-overlapping edit ownership; wait for prior results when tasks depend on them, and serialize work that would conflict over shared files or resources.

## parent-context

Parent user context is quoted below as supporting requirements. Later recorded clarifications override earlier prompts. Keep the delegated task as your scope; if it conflicts with this context, report the conflict instead of silently choosing one.
