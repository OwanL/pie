/**
 * Bug-finding tests for the agents module.
 *
 * Original tests: basic formatAgentList (re-implemented locally) and type contracts.
 * Added: parseDefaultScores edge cases, file-system-level loadAgentsFromDir behavior,
 * discoverAgents dedup/symlink behavior, boundary values for formatAgentList.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatAgentList, parseBucketAndThinking, type AgentConfig } from "../agents.js";

// ============================================================
// parseBucketAndThinking — INPUT TESTS
// ============================================================

test("parseBucketAndThinking: returns empty for undefined inputs", () => {
	const result = parseBucketAndThinking(undefined, undefined);
	assert.equal(result.bucket, undefined);
	assert.equal(result.thinkingLevel, undefined);
});

test("parseBucketAndThinking: returns empty for empty strings", () => {
	const result = parseBucketAndThinking("", "");
	assert.equal(result.bucket, undefined);
	assert.equal(result.thinkingLevel, undefined);
});

test("parseBucketAndThinking: returns empty for whitespace-only strings", () => {
	const result = parseBucketAndThinking("   ", "   ");
	assert.equal(result.bucket, undefined);
	assert.equal(result.thinkingLevel, undefined);
});

test("parseBucketAndThinking: parses valid bucket and thinkingLevel", () => {
	const result = parseBucketAndThinking("medium", "high");
	assert.equal(result.bucket, "medium");
	assert.equal(result.thinkingLevel, "high");
});

test("parseBucketAndThinking: handles whitespace and caps legacy xhigh", () => {
	const result = parseBucketAndThinking("  small  ", "  xhigh  ");
	assert.equal(result.bucket, "small");
	assert.equal(result.thinkingLevel, "high");
});

test("parseBucketAndThinking: rejects invalid bucket names", () => {
	assert.equal(parseBucketAndThinking("tiny", undefined).bucket, undefined);
	assert.equal(parseBucketAndThinking("large", undefined).bucket, undefined);
	assert.equal(parseBucketAndThinking("frontier ", undefined).bucket, "frontier");
});

test("parseBucketAndThinking: rejects invalid thinking levels and caps levels above high", () => {
	assert.equal(parseBucketAndThinking(undefined, "max").thinkingLevel, "high");
	assert.equal(parseBucketAndThinking(undefined, "off").thinkingLevel, undefined);
	assert.equal(parseBucketAndThinking(undefined, "xhigh").thinkingLevel, "high");
});

test("parseBucketAndThinking: parses only bucket when thinkingLevel omitted", () => {
	const result = parseBucketAndThinking("frontier", undefined);
	assert.equal(result.bucket, "frontier");
	assert.equal(result.thinkingLevel, undefined);
});

test("parseBucketAndThinking: parses only thinkingLevel when bucket omitted", () => {
	const result = parseBucketAndThinking(undefined, "low");
	assert.equal(result.bucket, undefined);
	assert.equal(result.thinkingLevel, "low");
});

// ============================================================
// formatAgentList — BOUNDARY + BUG TESTS
// ============================================================

test("formatAgentList: returns 'none' for empty list", () => {
	const { text, remaining } = formatAgentList([], 5);
	assert.equal(text, "none");
	assert.equal(remaining, 0);
});

test("formatAgentList: formats up to maxItems", () => {
	const agents: AgentConfig[] = [
		{ name: "a", description: "Agent A", systemPrompt: "", source: "user", filePath: "/a.md" },
		{ name: "b", description: "Agent B", systemPrompt: "", source: "user", filePath: "/b.md" },
		{ name: "c", description: "Agent C", systemPrompt: "", source: "project", filePath: "/c.md" },
	];
	const { text, remaining } = formatAgentList(agents, 2);
	assert.match(text, /Agent A/);
	assert.match(text, /Agent B/);
	assert.doesNotMatch(text, /Agent C/);
	assert.equal(remaining, 1);
});

test("formatAgentList: remaining is 0 when all fit", () => {
	const agents: AgentConfig[] = [
		{ name: "a", description: "Agent A", systemPrompt: "", source: "user", filePath: "/a.md" },
	];
	const { remaining } = formatAgentList(agents, 10);
	assert.equal(remaining, 0);
});

test("formatAgentList: zero maxItems returns empty text field", () => {
	const agents: AgentConfig[] = [
		{ name: "a", description: "Agent A", systemPrompt: "", source: "user", filePath: "/a.md" },
	];
	const { text, remaining } = formatAgentList(agents, 0);
	// slice(0, 0) = [] → "".join = ""
	assert.equal(text, "");
	assert.equal(remaining, 1);
});

test("formatAgentList: negative maxItems slices from the end", () => {
	// Array.slice with negative treats it as offset from end
	// slice(0, -1) = all but last. That's a potential bug if callers pass negative.
	const agents: AgentConfig[] = [
		{ name: "a", description: "Agent A", systemPrompt: "", source: "user", filePath: "/a.md" },
		{ name: "b", description: "Agent B", systemPrompt: "", source: "user", filePath: "/b.md" },
		{ name: "c", description: "Agent C", systemPrompt: "", source: "project", filePath: "/c.md" },
	];
	const { text, remaining } = formatAgentList(agents, -1);
	// slice(0, -1) returns first 2 items
	assert.match(text, /Agent A/);
	assert.match(text, /Agent B/);
	assert.doesNotMatch(text, /Agent C/);
	assert.equal(remaining, 1);
});

test("formatAgentList: very large maxItems shows all", () => {
	const agents: AgentConfig[] = [
		{ name: "a", description: "Agent A", systemPrompt: "", source: "user", filePath: "/a.md" },
		{ name: "b", description: "Agent B", systemPrompt: "", source: "user", filePath: "/b.md" },
	];
	const { text, remaining } = formatAgentList(agents, 999999);
	assert.match(text, /Agent A/);
	assert.match(text, /Agent B/);
	assert.equal(remaining, 0);
});

test("formatAgentList: agent with only required fields renders correctly", () => {
	const agents: AgentConfig[] = [
		{ name: "minimal", description: "Minimal agent", systemPrompt: "", source: "user", filePath: "/min.md" },
	];
	const { text, remaining } = formatAgentList(agents, 5);
	// Undefined optional fields should not cause "undefined" in output
	assert.doesNotMatch(text, /undefined/);
	assert.doesNotMatch(text, /null/);
	assert.equal(remaining, 0);
});

// ============================================================
// AgentConfig type contract tests
// ============================================================

test("AgentConfig: required fields are present", () => {
	const agent: AgentConfig = {
		name: "worker",
		description: "A worker",
		systemPrompt: "Be helpful",
		source: "user",
		filePath: "/agents/worker.md",
	};
	assert.equal(agent.name, "worker");
	assert.equal(agent.description, "A worker");
	assert.equal(agent.systemPrompt, "Be helpful");
	assert.equal(agent.source, "user");
	assert.equal(agent.filePath, "/agents/worker.md");
	assert.equal(agent.tools, undefined);
	assert.equal(agent.model, undefined);
	assert.equal(agent.bucket, undefined);
	assert.equal(agent.thinkingLevel, undefined);
});

test("AgentConfig: optional fields can be set", () => {
	const agent: AgentConfig = {
		name: "worker",
		description: "A worker",
		systemPrompt: "Be helpful",
		source: "project",
		filePath: "/agents/worker.md",
		tools: ["bash", "read"],
		model: "gpt-5.4",
		bucket: "medium",
		thinkingLevel: "high",
	};
	assert.deepEqual(agent.tools, ["bash", "read"]);
	assert.equal(agent.model, "gpt-5.4");
	assert.equal(agent.bucket, "medium");
	assert.equal(agent.thinkingLevel, "high");
});

// ============================================================
// AgentDiscoveryResult type contract
// ============================================================

test("AgentDiscoveryResult: agents is array, projectAgentsDir is string | null", () => {
	const result: { agents: AgentConfig[]; projectAgentsDir: string | null } = {
		agents: [],
		projectAgentsDir: null,
	};
	assert.ok(Array.isArray(result.agents));
	assert.ok(result.projectAgentsDir === null || typeof result.projectAgentsDir === "string");
});

test("AgentDiscoveryResult: projectAgentsDir can be a non-null path", () => {
	const result: { agents: AgentConfig[]; projectAgentsDir: string | null } = {
		agents: [],
		projectAgentsDir: "/some/project/agents",
	};
	assert.equal(typeof result.projectAgentsDir, "string");
	assert.match(result.projectAgentsDir, /\/agents$/);
});

// ============================================================
// FILE-SYSTEM INTEGRATION: loadAgentsFromDir behavior
// ============================================================
// These test the real functions from agents.ts. They require the SDK.
// We import dynamically to handle the dependency gracefully.

test("loadAgentsFromDir: non-existent directory returns empty array", async () => {
	const { discoverAgents } = await import("../agents.js");
	// Use a non-existent dir via project scope
	const tmpDir = path.join(os.tmpdir(), `pi-agent-test-nonexistent-${Date.now()}`);
	// Ensure it doesn't exist
	try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
	// discoverAgents with project scope on a random dir should find nothing
	const result = discoverAgents(tmpDir, "project");
	assert.deepEqual(result.agents, []);
	assert.equal(result.projectAgentsDir, null);
});

test("loadAgentsFromDir: empty agents/ directory returns empty array", async (t) => {
	const { discoverAgents } = await import("../agents.js");
	const tmpDir = path.join(os.tmpdir(), `pi-agent-test-empty-${Date.now()}`);
	const agentsDir = path.join(tmpDir, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	t.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

	const result = discoverAgents(tmpDir, "project");
	assert.deepEqual(result.agents, []);
	assert.ok(result.projectAgentsDir);
});

test("loadAgentsFromDir: discovers valid .md agent files", async (t) => {
	const { discoverAgents } = await import("../agents.js");
	const tmpDir = path.join(os.tmpdir(), `pi-agent-test-valid-${Date.now()}`);
	const agentsDir = path.join(tmpDir, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });

	const agentContent = `---
name: test-worker
description: A test worker agent
tools: bash, read
---
You are a test worker.
`;
	fs.writeFileSync(path.join(agentsDir, "test-worker.md"), agentContent);
	t.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

	const result = discoverAgents(tmpDir, "project");
	assert.equal(result.agents.length, 1);
	assert.equal(result.agents[0].name, "test-worker");
	assert.equal(result.agents[0].description, "A test worker agent");
	assert.deepEqual(result.agents[0].tools, ["bash", "read"]);
	assert.equal(result.agents[0].source, "project");
	assert.equal(result.agents[0].systemPrompt.trim(), "You are a test worker.");
});

test("loadAgentsFromDir: skips .md files without required frontmatter", async (t) => {
	const { discoverAgents } = await import("../agents.js");
	const tmpDir = path.join(os.tmpdir(), `pi-agent-test-skip-${Date.now()}`);
	const agentsDir = path.join(tmpDir, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });

	// Missing description
	fs.writeFileSync(path.join(agentsDir, "no-desc.md"), `---
name: no-desc
---
body
`);
	// Missing name
	fs.writeFileSync(path.join(agentsDir, "no-name.md"), `---
description: Missing name
---
body
`);
	// No frontmatter at all
	fs.writeFileSync(path.join(agentsDir, "no-fm.md"), `Just a markdown file, no frontmatter.`);
	// Valid agent (should be the only one discovered)
	fs.writeFileSync(path.join(agentsDir, "valid.md"), `---
name: valid
description: The only valid one
---
body
`);
	t.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

	const result = discoverAgents(tmpDir, "project");
	assert.equal(result.agents.length, 1, "Only the valid agent should be discovered");
	assert.equal(result.agents[0].name, "valid");
});

test("loadAgentsFromDir: handles non-.md files being ignored", async (t) => {
	const { discoverAgents } = await import("../agents.js");
	const tmpDir = path.join(os.tmpdir(), `pi-agent-test-ext-${Date.now()}`);
	const agentsDir = path.join(tmpDir, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });

	fs.writeFileSync(path.join(agentsDir, "notes.txt"), "not an agent");
	fs.writeFileSync(path.join(agentsDir, "config.json"), "{}");
	// Valid agent
	fs.writeFileSync(path.join(agentsDir, "real.md"), `---
name: real
description: real agent
---
body
`);
	t.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

	const result = discoverAgents(tmpDir, "project");
	assert.equal(result.agents.length, 1);
	assert.equal(result.agents[0].name, "real");
});

test("loadAgentsFromDir: handles symlinks to agent files", async (t) => {
	const { discoverAgents } = await import("../agents.js");
	const tmpDir = path.join(os.tmpdir(), `pi-agent-test-symlink-${Date.now()}`);
	const agentsDir = path.join(tmpDir, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });

	// Write agent in a different location, then symlink into agents dir
	const realFile = path.join(tmpDir, "real-agent.md");
	fs.writeFileSync(realFile, `---
name: linked-agent
description: Discovered via symlink
---
body
`);

	try {
		fs.symlinkSync(realFile, path.join(agentsDir, "linked-agent.md"));
	} catch {
		// symlinks may not be supported on this platform — skip
		t.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });
		return;
	}

	t.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

	const result = discoverAgents(tmpDir, "project");
	assert.equal(result.agents.length, 1);
	assert.equal(result.agents[0].name, "linked-agent");
});

test("loadAgentsFromDir: handles unreadable files gracefully", async (t) => {
	const { discoverAgents } = await import("../agents.js");
	const tmpDir = path.join(os.tmpdir(), `pi-agent-test-unreadable-${Date.now()}`);
	const agentsDir = path.join(tmpDir, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });

	// Create a directory that looks like a .md file — readFileSync will fail
	const dirAsFile = path.join(agentsDir, "not-a-file.md");
	fs.mkdirSync(dirAsFile);
	// Valid agent
	fs.writeFileSync(path.join(agentsDir, "real.md"), `---
name: real
description: Still works
---
body
`);
	t.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

	const result = discoverAgents(tmpDir, "project");
	assert.equal(result.agents.length, 1, "Should skip unreadable entries and discover valid ones");
	assert.equal(result.agents[0].name, "real");
});

test("loadAgentsFromDir: readdirSync failure returns empty array", async (t) => {
	const { discoverAgents } = await import("../agents.js");
	const tmpDir = path.join(os.tmpdir(), `pi-agent-test-readdir-fail-${Date.now()}`);
	fs.mkdirSync(tmpDir, { recursive: true });
	// Make `<agentDir>/agents` a FILE rather than a directory: existsSync passes
	// but readdirSync throws ENOTDIR, exercising loadAgentsFromDir's try/catch.
	fs.writeFileSync(path.join(tmpDir, "agents"), "not a directory");
	t.after(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		delete process.env.PI_CODING_AGENT_DIR;
	});

	process.env.PI_CODING_AGENT_DIR = tmpDir;
	// "user" scope reads from <agentDir>/agents (the file) → readdirSync throws → []
	const result = discoverAgents(tmpDir, "user");
	assert.deepEqual(result.agents, [], "readdirSync failure should yield an empty agent list");
});

// ============================================================
// discoverAgents — SCOPE BEHAVIOR
// ============================================================

test("discoverAgents: 'both' scope lets project agents override user agents with the same name", async (t) => {
	const { discoverAgents } = await import("../agents.js");
	// Control the user-agent directory via PI_CODING_AGENT_DIR so we can place a
	// user-level "worker" and assert the project-level one overrides it.
	const userDir = path.join(os.tmpdir(), `pi-agent-test-both-user-${Date.now()}`);
	const projectDir = path.join(os.tmpdir(), `pi-agent-test-both-proj-${Date.now()}`);
	const userAgentsDir = path.join(userDir, "agents");
	const projectAgentsDir = path.join(projectDir, "agents");
	fs.mkdirSync(userAgentsDir, { recursive: true });
	fs.mkdirSync(projectAgentsDir, { recursive: true });

	fs.writeFileSync(path.join(userAgentsDir, "worker.md"), `---
name: worker
description: User worker
---
body
`);
	fs.writeFileSync(path.join(projectAgentsDir, "worker.md"), `---
name: worker
description: Project worker (should override user)
---
body
`);
	t.after(() => {
		fs.rmSync(userDir, { recursive: true, force: true });
		fs.rmSync(projectDir, { recursive: true, force: true });
		delete process.env.PI_CODING_AGENT_DIR;
	});

	process.env.PI_CODING_AGENT_DIR = userDir;
	const result = discoverAgents(projectDir, "both");
	const worker = result.agents.find((a) => a.name === "worker");
	assert.ok(worker, "worker should be discovered from both scopes");
	assert.equal(worker!.source, "project", "project agent must override the user agent with the same name");
	assert.equal(worker!.description, "Project worker (should override user)");
});

test("discoverAgents: 'user' scope ignores project agents entirely", async (t) => {
	const { discoverAgents } = await import("../agents.js");
	const tmpDir = path.join(os.tmpdir(), `pi-agent-test-user-scope-${Date.now()}`);
	const agentsDir = path.join(tmpDir, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });

	fs.writeFileSync(path.join(agentsDir, "project-only.md"), `---
name: project-only
description: Should be invisible to user scope
---
body
`);
	t.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

	const result = discoverAgents(tmpDir, "user");
	const projectOnly = result.agents.find((a) => a.name === "project-only");
	assert.equal(projectOnly, undefined, "user scope must not see project agents");
});

test("discoverAgents: 'project' scope ignores user agents entirely", async (t) => {
	const { discoverAgents } = await import("../agents.js");
	const tmpDir = path.join(os.tmpdir(), `pi-agent-test-proj-scope-${Date.now()}`);
	const agentsDir = path.join(tmpDir, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });

	fs.writeFileSync(path.join(agentsDir, "proj-agent.md"), `---
name: proj-agent
description: Project agent
---
body
`);
	t.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

	const result = discoverAgents(tmpDir, "project");
	assert.equal(result.agents.length, 1);
	assert.equal(result.agents[0].name, "proj-agent");
	assert.equal(result.agents[0].source, "project");
});

// ============================================================
// findNearestProjectAgentsDir — nearest-ancestor resolution
// ============================================================

test("findNearestProjectAgentsDir: returns null when no agents/ found", async () => {
	const { discoverAgents } = await import("../agents.js");
	const tmpDir = path.join(os.tmpdir(), `pi-agent-test-no-dir-${Date.now()}`);
	fs.mkdirSync(tmpDir, { recursive: true });

	const result = discoverAgents(tmpDir, "project");
	assert.equal(result.projectAgentsDir, null);
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("findNearestProjectAgentsDir: finds agents/ in current dir", async (t) => {
	const { discoverAgents } = await import("../agents.js");
	const tmpDir = path.join(os.tmpdir(), `pi-agent-test-current-${Date.now()}`);
	const agentsDir = path.join(tmpDir, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	t.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

	const result = discoverAgents(tmpDir, "project");
	assert.ok(result.projectAgentsDir);
	assert.ok(result.projectAgentsDir!.endsWith(path.join("agents")));
});

test("findNearestProjectAgentsDir: finds agents/ in parent dir", async (t) => {
	const { discoverAgents } = await import("../agents.js");
	const tmpDir = path.join(os.tmpdir(), `pi-agent-test-parent-${Date.now()}`);
	const agentsDir = path.join(tmpDir, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	const childDir = path.join(tmpDir, "src", "deeply", "nested");
	fs.mkdirSync(childDir, { recursive: true });
	t.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

	const result = discoverAgents(childDir, "project");
	assert.ok(result.projectAgentsDir);
	assert.equal(fs.realpathSync(result.projectAgentsDir!), fs.realpathSync(agentsDir));
});

// ============================================================
// loadAgentsFromDir: frontmatter with bucket and thinkingLevel
// ============================================================

// ============================================================
// discoverAgents — multi-cwd union (subdirectory project roots)
// ============================================================
// When the session cwd is a workspace root that sits ABOVE the real project,
// walking up from it never reaches the nested project's `agents/` dir.
// Passing an array that includes a per-task cwd pointing at the nested project
// must surface its agents. This is the multi-repo workspace scenario.

test("discoverAgents: array cwd lets a nested project's agents be found from a parent workspace root", async (t) => {
	const { discoverAgents } = await import("../agents.js");
	const workspaceDir = path.join(os.tmpdir(), `pi-agent-test-ws-${Date.now()}`);
	fs.mkdirSync(workspaceDir, { recursive: true });
	const projectDir = path.join(workspaceDir, "pie");
	const agentsDir = path.join(projectDir, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(path.join(agentsDir, "scout.md"), "---\nname: scout\ndescription: nested project scout\n---\nbody\n");
	t.after(() => { fs.rmSync(workspaceDir, { recursive: true, force: true }); });

	const alone = discoverAgents(workspaceDir, "project");
	assert.equal(alone.agents.length, 0, "workspace root alone has no agents/ ancestor");
	assert.equal(alone.projectAgentsDir, null);

	const withNested = discoverAgents([workspaceDir, projectDir], "project");
	assert.equal(withNested.agents.length, 1);
	assert.equal(withNested.agents[0].name, "scout");
	assert.equal(withNested.agents[0].source, "project");
	assert.equal(withNested.projectAgentsDir, fs.realpathSync(agentsDir));
});

test("discoverAgents: array cwd dedupes the same agents/ dir reached via two cwds", async (t) => {
	const { discoverAgents } = await import("../agents.js");
	const projectDir = path.join(os.tmpdir(), `pi-agent-test-dedup-${Date.now()}`);
	const agentsDir = path.join(projectDir, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(path.join(agentsDir, "worker.md"), "---\nname: worker\ndescription: dedup\n---\nbody\n");
	const childDir = path.join(projectDir, "src", "deep");
	fs.mkdirSync(childDir, { recursive: true });
	t.after(() => { fs.rmSync(projectDir, { recursive: true, force: true }); });

	const result = discoverAgents([projectDir, childDir], "project");
	assert.equal(result.agents.length, 1, "same dir reached twice must not double-load");
	assert.equal(result.agents[0].name, "worker");
});

test("discoverAgents: with multiple distinct project dirs, first cwd's nearest dir wins", async (t) => {
	const { discoverAgents } = await import("../agents.js");
	const root = path.join(os.tmpdir(), `pi-agent-test-multidir-${Date.now()}`);
	const projA = path.join(root, "a");
	const projB = path.join(root, "b");
	fs.mkdirSync(path.join(projA, "agents"), { recursive: true });
	fs.mkdirSync(path.join(projB, "agents"), { recursive: true });
	fs.writeFileSync(path.join(projA, "agents", "shared.md"), "---\nname: shared\ndescription: from-a\n---\nbody\n");
	fs.writeFileSync(path.join(projB, "agents", "shared.md"), "---\nname: shared\ndescription: from-b\n---\nbody\n");
	fs.writeFileSync(path.join(projB, "agents", "only-b.md"), "---\nname: only-b\ndescription: b-only\n---\nbody\n");
	t.after(() => { fs.rmSync(root, { recursive: true, force: true }); });

	const result = discoverAgents([projA, projB], "project");
	assert.equal(result.projectAgentsDir, fs.realpathSync(path.join(projA, "agents")));
	const shared = result.agents.find((a) => a.name === "shared");
	assert.ok(shared);
	assert.equal(shared!.description, "from-a", "first project dir wins name collisions");
	assert.ok(result.agents.some((a) => a.name === "only-b"), "second dir still contributes non-colliding agents");
});

test("discoverAgents: string cwd still works (backward compatible)", async (t) => {
	const { discoverAgents } = await import("../agents.js");
	const tmpDir = path.join(os.tmpdir(), `pi-agent-test-strcwd-${Date.now()}`);
	const agentsDir = path.join(tmpDir, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(path.join(agentsDir, "x.md"), "---\nname: x\ndescription: str cwd compat\n---\nbody\n");
	t.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

	const result = discoverAgents(tmpDir, "project");
	assert.equal(result.agents.length, 1);
	assert.equal(result.agents[0].name, "x");
	assert.equal(result.projectAgentsDir, fs.realpathSync(agentsDir));
});

test("loadAgentsFromDir: parses bucket and thinkingLevel from frontmatter", async (t) => {
	const { discoverAgents } = await import("../agents.js");
	const tmpDir = path.join(os.tmpdir(), `pi-agent-test-bucket-${Date.now()}`);
	const agentsDir = path.join(tmpDir, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });

	fs.writeFileSync(path.join(agentsDir, "bucketed.md"), `---
name: bucketed
description: Has bucket and thinkingLevel
bucket: medium
thinkingLevel: high
---
body
`);
	t.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

	const result = discoverAgents(tmpDir, "project");
	assert.equal(result.agents.length, 1);
	assert.equal(result.agents[0].bucket, "medium");
	assert.equal(result.agents[0].thinkingLevel, "high");
});

test("loadAgentsFromDir: invalid bucket is ignored", async (t) => {
	const { discoverAgents } = await import("../agents.js");
	const tmpDir = path.join(os.tmpdir(), `pi-agent-test-badbucket-${Date.now()}`);
	const agentsDir = path.join(tmpDir, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });

	fs.writeFileSync(path.join(agentsDir, "bad-bucket.md"), `---
name: bad-bucket
description: Invalid bucket
bucket: tiny
---
body
`);
	t.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

	const result = discoverAgents(tmpDir, "project");
	assert.equal(result.agents.length, 1);
	assert.equal(result.agents[0].bucket, undefined);
});

test("loadAgentsFromDir: no defaultScores in repo-level agents", async () => {
	// Enforce that repo-level agent .md files do not use the deprecated defaultScores field
	const { discoverAgents } = await import("../agents.js");
	// Resolve the repo root from the test file location
	const repoRoot = path.resolve(import.meta.dirname ?? __dirname, "..", "..", "..");
	const result = discoverAgents(repoRoot, "project");
	for (const agent of result.agents) {
		// Read the raw frontmatter to check for defaultScores
		const content = fs.readFileSync(agent.filePath, "utf-8");
		const hasDefaultScores = /^defaultScores:/m.test(content);
		assert.ok(!hasDefaultScores, `Agent "${agent.name}" at ${agent.filePath} must not use deprecated defaultScores field`);
	}
});

test("loadAgentsFromDir: an explicit empty canSpawn list blocks all delegation", async (t) => {
	const { discoverAgents } = await import("../agents.js");
	const tmpDir = path.join(os.tmpdir(), `pi-agent-test-empty-can-spawn-${Date.now()}`);
	const agentsDir = path.join(tmpDir, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });

	fs.writeFileSync(path.join(agentsDir, "leaf.md"), `---
name: leaf
description: Must not delegate
canSpawn: []
---
body
`);
	t.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

	const result = discoverAgents(tmpDir, "project");
	assert.equal(result.agents.length, 1);
	assert.deepEqual(
		result.agents[0].canSpawn,
		[],
		"an explicit empty allowlist must not be widened to unrestricted",
	);
});

test("loadAgentsFromDir: empty tools string results in undefined tools", async (t) => {
	const { discoverAgents } = await import("../agents.js");
	const tmpDir = path.join(os.tmpdir(), `pi-agent-test-empty-tools-${Date.now()}`);
	const agentsDir = path.join(tmpDir, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });

	fs.writeFileSync(path.join(agentsDir, "no-tools.md"), `---
name: no-tools
description: No tools
tools:
---
body
`);
	t.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

	const result = discoverAgents(tmpDir, "project");
	assert.equal(result.agents.length, 1);
	assert.equal(result.agents[0].name, "no-tools");
	assert.equal(result.agents[0].tools, undefined, "Empty tools string should result in undefined");
});

test("loadAgentsFromDir: whitespace-only tools results in undefined", async (t) => {
	const { discoverAgents } = await import("../agents.js");
	const tmpDir = path.join(os.tmpdir(), `pi-agent-test-ws-tools-${Date.now()}`);
	const agentsDir = path.join(tmpDir, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });

	fs.writeFileSync(path.join(agentsDir, "ws-tools.md"), `---
name: ws-tools
description: Whitespace tools
tools: "  ,  ,  "
---
body
`);
	t.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

	const result = discoverAgents(tmpDir, "project");
	assert.equal(result.agents.length, 1);
	assert.equal(result.agents[0].tools, undefined, "Whitespace-only tools should result in undefined");
});

// ============================================================
// formatAgentList — EDGE CASES WITH REAL AGENT NAMES
// ============================================================

test("formatAgentList: handles agents with special characters in name", () => {
	const agents: AgentConfig[] = [
		{ name: "agent:with:colons", description: "colon agent", systemPrompt: "", source: "user", filePath: "/a.md" },
	];
	const { text } = formatAgentList(agents, 5);
	assert.match(text, /agent:with:colons/);
});

test("formatAgentList: handles agents with emoji in description", () => {
	const agents: AgentConfig[] = [
		{ name: "emoji", description: "Agent 🚀 with emoji", systemPrompt: "", source: "user", filePath: "/a.md" },
	];
	const { text } = formatAgentList(agents, 5);
	assert.match(text, /🚀/);
});
