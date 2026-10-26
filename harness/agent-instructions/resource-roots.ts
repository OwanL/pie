import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface InstructionResourceRootOptions {
	/** Explicit authored-resource root for source routes and fixtures; never inferred from agentDir. */
	instructionsRoot?: string;
	/** Directory containing the flat emitted entries/chunks. Defaults to this module's directory. */
	moduleDir?: string;
}

/** Application-owned resources, independent of cwd, user configuration and other Pi profiles. */
export function resolveInstructionResourceRoot(options: InstructionResourceRootOptions = {}): string {
	if (options.instructionsRoot !== undefined) return path.resolve(options.instructionsRoot);
	const moduleDir = options.moduleDir ?? (typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url)));
	return path.resolve(moduleDir, "resources", "agent-instructions");
}

export function getInstructionResourcePaths(options: InstructionResourceRootOptions = {}) {
	const root = resolveInstructionResourceRoot(options);
	return {
		root,
		appendSystemPath: path.join(root, "APPEND_SYSTEM.md"),
		subagentSystemPath: path.join(root, "SUBAGENT_SYSTEM.md"),
		agentsDir: path.join(root, "agents"),
		skillsDir: path.join(root, "skills"),
	};
}

/** Low to high priority; caller supplies the selected profile, with no alternate-profile lookup. */
export function getUserAgentResourceDirs(agentDir: string): string[] {
	return [
		path.resolve(agentDir, "harness", "agent-instructions", "agents"),
		path.resolve(agentDir, "agents"),
	];
}
