import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Shared in-process signal marking that execution is currently inside a
 * subagent session (run via the `subagent` extension's in-process runner).
 *
 * The subagent runner enters this context around `session.prompt()` so that
 * extensions whose `before_agent_start` / lifecycle hooks fire during that
 * prompt can detect they are running in a scoped subagent session. The shared
 * skill-pruner uses this signal to apply the child enable switch and select
 * capabilities once for the child's assignment rather than on each turn.
 *
 * Safety with sibling calls: `AsyncLocalStorage` is per-async-context, NOT
 * process-global, so concurrent subagent runs each carry their own
 * store. This is why an environment variable is not used here — `process.env`
 * is shared across parallel runs and would race.
 *
 * Propagation: the pi SDK emits `before_agent_start` via an `await`ed
 * `emitBeforeAgentStart(...)` *inside* `session.prompt()` (which is itself
 * `await`ed within this context), so the store is visible to extension hooks.
 */
export interface SubagentSignal {
	/** Nesting depth of the current subagent (>= 1 inside a subagent session). */
	readonly depth: number;
}

export const subagentContext = new AsyncLocalStorage<SubagentSignal>();

/**
 * Returns true when called from within a subagent session's prompt lifecycle
 * (i.e. inside `subagentContext.run(...)` with a positive depth). Extensions
 * call this to decide whether to skip main-agent-oriented work.
 */
export function isInSubagentContext(): boolean {
	const store = subagentContext.getStore();
	return !!store && store.depth > 0;
}
