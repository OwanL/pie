import * as fs from "node:fs";
import * as path from "node:path";
import { getInstructionResourcePaths, type InstructionResourceRootOptions } from "../../agent-instructions/resource-roots.js";

export const SUBAGENT_SYSTEM_RELATIVE_PATH = path.join("harness", "agent-instructions", "SUBAGENT_SYSTEM.md");

// Registration warms the snapshot before any child runs; direct consumers warm
// it on first use. Missing files stay cached too. Nested extension evaluations
// share the snapshot in-process. Resource-root seams have independent snapshots.
const cacheKey = Symbol.for("pie.subagent-system-prompts.v2");
const shared = globalThis as unknown as Record<symbol, Map<string, string[]> | undefined>;
const prompts = shared[cacheKey] ??= new Map<string, string[]>();

function snapshot(agentDir: string, options: InstructionResourceRootOptions): string[] {
	const bundled = getInstructionResourcePaths(options).subagentSystemPath;
	const root = typeof agentDir === "string" && agentDir.trim() ? path.resolve(agentDir) : undefined;
	const key = JSON.stringify([bundled, root]);
	if (!prompts.has(key)) {
		const parts: string[] = [];
		const seen = new Set<string>();
		const files = [bundled, ...(root ? [path.join(root, SUBAGENT_SYSTEM_RELATIVE_PATH), path.join(root, "SUBAGENT_SYSTEM.md")] : [])];
		for (const file of files) {
			try {
				const identity = fs.realpathSync.native(file);
				if (seen.has(identity)) continue;
				seen.add(identity);
				const content = fs.readFileSync(file, "utf8").trim();
				if (content) parts.push(content);
			} catch {
				// Absent/unreadable guidance is optional, including source-only routes.
			}
		}
		prompts.set(key, parts);
	}
	return prompts.get(key)!;
}

/** Preserve the registration API while warming all shared child-only layers. */
export function initializeSubagentSystemPrompt(agentDir: string, options: InstructionResourceRootOptions = {}): string | undefined {
	return snapshot(agentDir, options).join("\n\n") || undefined;
}

export function subagentSystemPrompt(agentDir: string, role: string, options: InstructionResourceRootOptions = {}): string[] {
	// Always return an explicit array (even empty) to suppress native inheritance.
	return [...snapshot(agentDir, options), ...(role.trim() ? [role] : [])];
}
