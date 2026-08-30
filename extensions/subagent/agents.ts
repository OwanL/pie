/**
 * Agent discovery and configuration
 */

/// <reference types="node" />

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	/** Bucket hint for model selection: "small", "medium", or "frontier". */
	bucket?: string;
	/**
	 * Optional allowlist restricting which agents this agent may spawn via the
	 * subagent tool. When omitted, the agent may spawn any agent (default).
	 * When present (including empty), only the listed agent names are
	 * permitted. Used to preserve invariants such as a read-only agent only
	 * being able to delegate to other read-only agents.
	 */
	canSpawn?: string[];
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function getAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	if (configured) {
		return path.resolve(configured);
	}
	return path.join(os.homedir(), ".pi", "agent");
}

function parseFrontmatter<T extends Record<string, string>>(content: string): { frontmatter: T; body: string } {
	if (!content.startsWith("---")) {
		return { frontmatter: {} as T, body: content };
	}

	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) {
		return { frontmatter: {} as T, body: content };
	}

	const [, rawFrontmatter, body] = match;
	const frontmatter = {} as Record<string, string>;
	for (const line of rawFrontmatter.split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator === -1) continue;
		const key = line.slice(0, separator).trim();
		if (!key) continue;
		const rawValue = line.slice(separator + 1).trim();
		frontmatter[key] = rawValue.replace(/^['"]|['"]$/g, "");
	}

	return { frontmatter: frontmatter as T, body };
}

const VALID_BUCKETS = new Set(["small", "medium", "frontier"]);

/**
 * Parse a frontmatter `tools` value into a list of tool names. Accepts both a
 * comma-separated string (`read, write`) and inline YAML list syntax
 * (`[read, write]`), stripping surrounding brackets and per-item quotes.
 */
function parseToolsList(rawTools: string | undefined): string[] | undefined {
	if (rawTools === undefined) return undefined;
	const inner = rawTools.trim().replace(/^\[|\]$/g, "");
	const tools = inner
		.split(",")
		.map((t) => t.trim().replace(/^['"]|['"]$/g, "").trim())
		.filter(Boolean);
	// Presence is an authority boundary: omitted means the SDK may expose its
	// normal tool set, while `tools: []` (or an intentionally empty value)
	// means the child must receive no tools. Do not widen explicit emptiness to
	// `undefined`, which the SDK interprets as unrestricted.
	return tools;
}

export function parseBucket(rawBucket: string | undefined): string | undefined {
	const bucket = rawBucket?.trim();
	return bucket && VALID_BUCKETS.has(bucket) ? bucket : undefined;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = parseToolsList(frontmatter.tools);
		// `canSpawn` is an allowlist, so presence matters independently of
		// length: an explicit `canSpawn: []` means this is a leaf agent and must
		// block every nested delegation. Collapsing [] to undefined would widen
		// that policy to unrestricted.
		const canSpawn = frontmatter.canSpawn === undefined
			? undefined
			: (parseToolsList(frontmatter.canSpawn) ?? []);

		const bucket = parseBucket(frontmatter.bucket);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools,
			model: frontmatter.model,
			bucket,
			canSpawn,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Discover agents for a given scope.
 *
 * `searchCwds` may be a single cwd or an array. Project-local agents are
 * found by walking up from each cwd looking for an `agents/` directory
 * (`findNearestProjectAgentsDir`). Accepting multiple cwds lets a caller point
 * at a subdirectory project root — e.g. when the session's cwd is a
 * multi-repo workspace root but the task targets one repo nested inside it
 * whose `agents/` dir would never be reached by walking up from the root.
 *
 * Distinct project dirs (deduped by realpath) are all loaded. The nearest dir
 * to the FIRST cwd is reported as `projectAgentsDir`; among multiple project
 * dirs the first one to define a given agent name wins (later dirs only add
 * agents not yet seen). Project agents always override same-named user agents
 * (preserving the existing `"both"` scope semantics).
 */
export function discoverAgents(searchCwds: string | string[], scope: AgentScope): AgentDiscoveryResult {
	const cwds = Array.isArray(searchCwds)
		? Array.from(new Set(searchCwds.filter((c): c is string => typeof c === "string" && c.length > 0)))
		: [searchCwds];
	const userDir = path.join(getAgentDir(), "agents");

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");

	// Walk up from each cwd to find project-local `agents/` dirs. Dedup by
	// realpath so the same dir reached via different cwds isn't loaded twice.
	const projectDirs: string[] = [];
	const seenDirs = new Set<string>();
	for (const cwd of cwds) {
		const dir = findNearestProjectAgentsDir(cwd);
		if (!dir) continue;
		let key = dir;
		try {
			key = fs.realpathSync(dir);
		} catch {
			/* fall back to the literal path as the dedup key */
		}
		if (seenDirs.has(key)) continue;
		seenDirs.add(key);
		projectDirs.push(dir);
	}

	// First-wins among project dirs: nearer project roots aren't clobbered by
	// farther ones reached via later cwds.
	const projectMap = new Map<string, AgentConfig>();
	if (scope !== "user") {
		for (const dir of projectDirs) {
			const agents = loadAgentsFromDir(dir, "project");
			for (const agent of agents) {
				if (!projectMap.has(agent.name)) projectMap.set(agent.name, agent);
			}
		}
	}

	const agentMap = new Map<string, AgentConfig>();
	if (scope === "both" || scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	}
	// Project agents override same-named user agents ("both" scope semantics).
	if (scope !== "user") {
		for (const agent of projectMap.values()) agentMap.set(agent.name, agent);
	}

	const projectAgentsDir = projectDirs.length > 0 ? projectDirs[0] : null;
	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
