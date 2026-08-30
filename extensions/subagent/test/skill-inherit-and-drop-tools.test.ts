/**
 * Tests for the two v1 subagent-scoping features:
 *  - Skills inherit the parent (main) turn's pruned set (direction C).
 *  - Tools: the user-configured drop-tools list is subtracted from every
 *    subagent's effective tool set.
 *
 * Self-contained: defines a minimal capturing SDK mock so we can assert what
 * `tools` and `skillsOverride` were passed to createSession / createResourceLoader.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { Model, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { runSingleAgent, subagentRuntime } from "../runner.js";
import type { AgentConfig } from "../agents.js";
import { recordKeptSkills, clearKeptSkills, readKeptSkills } from "../../../shared/pruned-skills.js";

interface CapturingState {
	createSessionArgs: Array<Record<string, unknown>>;
	createResourceLoaderArgs: Array<Record<string, unknown>>;
}

/** Build a capturing fake SDK + session that completes immediately. */
function createCapturingSdk(): { sdk: any; state: CapturingState } {
	const state: CapturingState = {
		createSessionArgs: [],
		createResourceLoaderArgs: [],
	};
	const session = {
		agent: { state: { model: { id: "session-model" } } },
		extensionRunner: { setUIContext: () => {} },
		subscribe: () => () => {},
		prompt: async (_prompt: string) => {
			for (const listener of listeners) {
				listener({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
						model: "m",
						stopReason: "completed",
					},
				});
			}
		},
		abort: async () => {},
		dispose: () => {},
	};
	const listeners: Array<(event: any) => void> = [];
	session.subscribe = (cb: (event: any) => void) => {
		listeners.push(cb);
		return () => {};
	};
	const sdk = {
		createSession: async (args: Record<string, unknown>) => {
			state.createSessionArgs.push(args);
			return { session };
		},
		createResourceLoader: (args: Record<string, unknown>) => {
			state.createResourceLoaderArgs.push(args);
			return { reload: async () => undefined };
		},
		createSessionManager: () => ({}),
		getAgentDir: () => ".",
	};
	return { sdk, state };
}

function makeModelRegistry(): ModelRegistry {
	return {
		getAvailable: () => [{ id: "model-a", provider: "test" }],
		getAll: () => [{ id: "model-a", provider: "test" }],
		find: (_provider: string, id: string) => (id === "model-a" ? { id: "model-a", provider: "test" } : undefined),
	} as any;
}

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "test agent",
		systemPrompt: "",
		source: "user",
		filePath: "worker.md",
		...overrides,
	};
}

const selection = { modelId: "model-a", bucket: "medium" as const, thinkingLevel: "low" as const, pool: ["model-a"], fallback: false };
const details = (results: any) => ({ mode: "single" as const, agentScope: "user" as const, projectAgentsDir: null, results });

const DROP_ENV = "PIE_SUBAGENT_DROP_TOOLS_JSON";

test("runSingleAgent subtracts the drop-tools list from an unrestricted agent's tools (allToolNames)", async () => {
	const previous = process.env[DROP_ENV];
	process.env[DROP_ENV] = JSON.stringify(["ask_user", "web_search"]);
	try {
		const { sdk, state } = createCapturingSdk();
		await runSingleAgent(
			process.cwd(), [makeAgent()], "worker", "do work", undefined, undefined, undefined, undefined,
			details, makeModelRegistry(), undefined, selection,
			undefined, undefined, undefined, undefined,
			["read", "write", "edit", "bash", "ask_user", "web_search"],
			{ sdk, timeoutMs: 0 },
		);
		assert.equal(state.createSessionArgs.length, 1);
		assert.deepEqual(state.createSessionArgs[0].tools, ["read", "write", "edit", "bash"]);
	} finally {
		if (previous === undefined) delete process.env[DROP_ENV];
		else process.env[DROP_ENV] = previous;
	}
});

test("runSingleAgent subtracts the drop-tools list from an agent's explicit tools frontmatter", async () => {
	const previous = process.env[DROP_ENV];
	process.env[DROP_ENV] = JSON.stringify(["ask_user"]);
	try {
		const { sdk, state } = createCapturingSdk();
		await runSingleAgent(
			process.cwd(), [makeAgent({ tools: ["read", "write", "ask_user"] })], "worker", "do work",
			undefined, undefined, undefined, undefined,
			details, makeModelRegistry(), undefined, selection,
			undefined, undefined, undefined, undefined, undefined,
			{ sdk, timeoutMs: 0 },
		);
		assert.deepEqual(state.createSessionArgs[0].tools, ["read", "write"]);
	} finally {
		if (previous === undefined) delete process.env[DROP_ENV];
		else process.env[DROP_ENV] = previous;
	}
});

test("runSingleAgent leaves the tool set unchanged when the drop list is empty", async () => {
	const previous = process.env[DROP_ENV];
	delete process.env[DROP_ENV];
	try {
		const { sdk, state } = createCapturingSdk();
		await runSingleAgent(
			process.cwd(), [makeAgent({ tools: ["read", "write", "ask_user"] })], "worker", "do work",
			undefined, undefined, undefined, undefined,
			details, makeModelRegistry(), undefined, selection,
			undefined, undefined, undefined, undefined, undefined,
			{ sdk, timeoutMs: 0 },
		);
		// No drop list → agent.tools passes through unchanged.
		assert.deepEqual(state.createSessionArgs[0].tools, ["read", "write", "ask_user"]);
	} finally {
		if (previous === undefined) delete process.env[DROP_ENV];
		else process.env[DROP_ENV] = previous;
	}
});

test("runSingleAgent preserves an explicit zero-tool agent allowlist", async () => {
	const previous = process.env[DROP_ENV];
	delete process.env[DROP_ENV];
	try {
		const { sdk, state } = createCapturingSdk();
		await runSingleAgent(
			process.cwd(), [makeAgent({ tools: [] })], "worker", "return structured output",
			undefined, undefined, undefined, undefined,
			details, makeModelRegistry(), undefined, selection,
			undefined, undefined, undefined, undefined, ["read", "write", "bash"],
			{ sdk, timeoutMs: 0 },
		);
		assert.deepEqual(state.createSessionArgs[0].tools, []);
	} finally {
		if (previous === undefined) delete process.env[DROP_ENV];
		else process.env[DROP_ENV] = previous;
	}
});

test("runSingleAgent passes a skillsOverride that filters to the parent's kept-skill set", async () => {
	const sessionId = "test-parent-session-for-skills-inherit";
	recordKeptSkills(sessionId, ["librarian", "tdd"]);
	try {
		const { sdk, state } = createCapturingSdk();
		await runSingleAgent(
			process.cwd(), [makeAgent()], "worker", "do work", undefined, undefined, undefined, undefined,
			details, makeModelRegistry(), undefined, selection,
			undefined, undefined, undefined, sessionId, undefined,
			{ sdk: sdk as any, timeoutMs: 0 },
		);
		assert.equal(state.createResourceLoaderArgs.length, 1);
		const override = state.createResourceLoaderArgs[0].skillsOverride as
			| ((base: { skills: Array<{ name: string }>; diagnostics: unknown[] }) => { skills: Array<{ name: string }>; diagnostics: unknown[] })
			| undefined;
		assert.equal(typeof override, "function");
		const filtered = override!({ skills: [{ name: "librarian" }, { name: "tdd" }, { name: "diagnose" }], diagnostics: [] });
		assert.deepEqual(filtered.skills.map((s) => s.name), ["librarian", "tdd"]);
	} finally {
		clearKeptSkills(sessionId);
	}
});

test("depth-2+ run without a parent session record does not inherit async-local kept skills", async () => {
	const { sdk, state } = createCapturingSdk();
	await subagentRuntime.run(
		{ depth: 2, trail: ["worker", "worker"], budget: { sessions: 2 } },
		() => runSingleAgent(
			process.cwd(), [makeAgent()], "worker", "nested work", undefined, undefined, undefined, undefined,
			details, makeModelRegistry(), undefined, selection,
			undefined, undefined, undefined, undefined, undefined,
			{ sdk: sdk as any, timeoutMs: 0 },
		),
	);
	assert.equal(state.createResourceLoaderArgs[0].skillsOverride, undefined);
});

// --- pruned-skills store (shared/pruned-skills.ts) ---

test("recordKeptSkills / readKeptSkills round-trips a kept set and clearKeptSkills removes it", () => {
	const id = "store-unit-session";
	try {
		recordKeptSkills(id, ["librarian", "tdd"]);
		assert.deepEqual(readKeptSkills(id), ["librarian", "tdd"]);
		clearKeptSkills(id);
		assert.equal(readKeptSkills(id), undefined);
	} finally {
		clearKeptSkills(id);
	}
});

test("recordKeptSkills stores the keep-all sentinel and readKeptSkills returns it", () => {
	const id = "store-unit-keepall";
	try {
		recordKeptSkills(id, "keep-all");
		assert.equal(readKeptSkills(id), "keep-all");
	} finally {
		clearKeptSkills(id);
	}
});

test("readKeptSkills returns undefined for an unknown session", () => {
	assert.equal(readKeptSkills("never-recorded-session"), undefined);
});

test("runSingleAgent passes no skillsOverride when the parent kept-set is empty (keep-all safeguard)", async () => {
	const sessionId = "test-parent-session-empty-kept";
	recordKeptSkills(sessionId, []);
	try {
		const { sdk, state } = createCapturingSdk();
		await runSingleAgent(
			process.cwd(), [makeAgent()], "worker", "do work", undefined, undefined, undefined, undefined,
			details, makeModelRegistry(), undefined, selection,
			undefined, undefined, undefined, sessionId, undefined,
			{ sdk, timeoutMs: 0 },
		);
		// An empty kept set must NOT strip all skills — it falls back to no filter
		// (keep-all), matching the pruner's own keep-all safeguard.
		assert.equal(state.createResourceLoaderArgs[0].skillsOverride, undefined);
	} finally {
		clearKeptSkills(sessionId);
	}
});

test("runSingleAgent passes no skillsOverride when no parent kept-set is recorded (today's behavior)", async () => {
	const { sdk, state } = createCapturingSdk();
	await runSingleAgent(
		process.cwd(), [makeAgent()], "worker", "do work", undefined, undefined, undefined, undefined,
		details, makeModelRegistry(), undefined, selection,
		undefined, undefined, undefined, undefined, undefined,
		{ sdk, timeoutMs: 0 },
	);
	assert.equal(state.createResourceLoaderArgs[0].skillsOverride, undefined);
});
