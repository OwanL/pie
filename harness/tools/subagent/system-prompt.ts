import * as fs from "node:fs";
import * as path from "node:path";

export const SUBAGENT_SYSTEM_RELATIVE_PATH = path.join("harness", "agent-instructions", "SUBAGENT_SYSTEM.md");

// Registration warms this cache before any child runs. Direct runner consumers
// initialize their configured root once on first SDK startup. Missing config is
// cached too, preserving source-only consumers without a configured prompt.
// Native extension loaders may evaluate this module again for nested children.
// Keep their registration snapshots shared in the same process.
const cacheKey = Symbol.for("pie.subagent-system-prompts.v1");
const shared = globalThis as unknown as Record<symbol, Map<string, string | undefined> | undefined>;
const prompts = shared[cacheKey] ??= new Map<string, string | undefined>();

export function initializeSubagentSystemPrompt(agentDir: string): string | undefined {
	if (typeof agentDir !== "string" || !agentDir.trim()) return undefined;
	const root = path.resolve(agentDir);
	if (!prompts.has(root)) {
		let content: string | undefined;
		try {
			content = fs.readFileSync(path.join(root, SUBAGENT_SYSTEM_RELATIVE_PATH), "utf8").trim() || undefined;
		} catch {
			// As with the main append, absent/unreadable configuration is optional.
		}
		prompts.set(root, content);
	}
	return prompts.get(root);
}

export function subagentSystemPrompt(agentDir: string, role: string): string[] {
	const shared = initializeSubagentSystemPrompt(agentDir);
	return [shared, role.trim() ? role : undefined].filter((part): part is string => part !== undefined);
}
