/** Focused lifecycle and root-tree concurrency tests for runner.ts. */

import test from "node:test";
import assert from "node:assert/strict";
import { runSingleAgent, subagentRuntime } from "../runner.js";
import type { AgentConfig } from "../agents.js";

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

function makeModelRegistry() {
	const model = { id: "model-a", provider: "test", contextWindow: 128_000 } as any;
	return {
		getAvailable: () => [model],
		getAll: () => [model],
		find: (_provider: string, id: string) => (id === model.id ? model : undefined),
	} as any;
}

function createFakeSdk(options?: {
	onPrompt?: (emit: (event: any) => void) => Promise<void>;
	subscribeThrows?: boolean;
}) {
	const listeners: Array<(event: any) => void> = [];
	let releasePrompt: (() => void) | undefined;
	const state: { resourceReloadCalls: number; createdModel?: { provider?: string; id?: string } } = {
		resourceReloadCalls: 0,
	};

	const session = {
		agent: { state: { model: { id: "session-model" } } },
		extensionRunner: { setUIContext: () => undefined },
		subscribe: (cb: (event: any) => void) => {
			if (options?.subscribeThrows) throw new Error("subscribe setup failed");
			listeners.push(cb);
			return () => undefined;
		},
		prompt: async (_prompt: string) => {
			if (options?.onPrompt) {
				await options.onPrompt((event) => {
					for (const listener of listeners) listener(event);
				});
				return;
			}
			await new Promise<void>((resolve) => {
				releasePrompt = resolve;
			});
		},
		abort: async () => {
			releasePrompt?.();
		},
		dispose: () => undefined,
	};

	const sdk = {
		createSession: async (args: { model?: { provider?: string; id?: string } }) => {
			state.createdModel = args.model;
			return { session };
		},
		createResourceLoader: () => ({
			reload: async () => { state.resourceReloadCalls++; },
		}),
		createSessionManager: () => ({}),
		getAgentDir: () => ".",
	};

	return { sdk, state };
}

function runFakeAgent(
	sdk: unknown,
	onUpdate?: (partial: any) => void,
	signal?: AbortSignal,
	timeoutMs = 0,
) {
	return runSingleAgent(
		process.cwd(),
		[makeAgent()],
		"worker",
		"do work",
		undefined,
		undefined,
		signal,
		onUpdate,
		(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
		makeModelRegistry(),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ sdk: sdk as any, timeoutMs },
	);
}

function successfulFakeSdk() {
	return createFakeSdk({
		onPrompt: async (emit) => {
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
					model: "session-model",
					stopReason: "completed",
				},
			});
		},
	});
}

test("runSingleAgent exposes tool-call drafts while the child model generates them", async () => {
	const { sdk } = createFakeSdk({
		onPrompt: async (emit) => {
			emit({
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_start",
					contentIndex: 0,
					partial: { content: [{ type: "toolCall", id: "tool-1", name: "bash" }] },
				},
			});
			emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: '{"command":' } });
			emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: '"npm test"}' } });
			await new Promise((resolve) => setTimeout(resolve, 75));
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "npm test" } }],
					usage: { input: 1, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 9, cost: { total: 0 } },
					model: "session-model",
					stopReason: "toolUse",
				},
			});
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
					model: "session-model",
					stopReason: "completed",
				},
			});
		},
	});
	const updates: any[] = [];

	const result = await runFakeAgent(sdk, (update) => updates.push(structuredClone(update)));
	const drafting = updates.find((update) => update.details.results[0]?.draftingToolCall?.argumentsText === '{"command":"npm test"}');

	assert.equal(drafting?.details.results[0]?.draftingToolCall?.name, "bash");
	assert.equal(drafting?.details.results[0]?.streaming, true);
	assert.equal(result.draftingToolCall, undefined);
});

test("runSingleAgent publishes its terminal lifecycle before a successful run settles", async () => {
	const { sdk } = successfulFakeSdk();
	const updates: any[] = [];

	const result = await runFakeAgent(sdk, (update) => updates.push(structuredClone(update)));

	assert.equal(result.activityPhase, "completed");
	assert.equal(updates.at(-1)?.details.results[0]?.activityPhase, "completed");
	assert.equal(updates.at(-1)?.details.results[0]?.exitCode, 0);
});

test("runSingleAgent executes a qualified bucket spec on its exact provider", async () => {
	const github = { id: "gpt-5.4", provider: "github-copilot", contextWindow: 128_000 } as any;
	const codex = { id: "gpt-5.4", provider: "openai-codex", contextWindow: 128_000 } as any;
	const registry = {
		getAvailable: () => [github, codex],
		getAll: () => [github, codex],
		find: (provider: string, id: string) => [github, codex].find((model) => model.provider === provider && model.id === id),
	} as any;
	const { sdk, state } = successfulFakeSdk();

	await runSingleAgent(
		process.cwd(),
		[makeAgent()],
		"worker",
		"do work",
		undefined,
		undefined,
		undefined,
		undefined,
		(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
		registry,
		github,
		{
			modelId: "openai-codex/gpt-5.4",
			bucket: "medium",
			pool: ["github-copilot/gpt-5.4", "openai-codex/gpt-5.4"],
			fallback: false,
		},
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ sdk: sdk as any, timeoutMs: 0 },
	);

	assert.equal(state.createdModel?.provider, "openai-codex");
	assert.equal(state.createdModel?.id, "gpt-5.4");
});

async function within<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

// ============================================================
// ROOT-TREE CONCURRENCY
// ============================================================

test("nested descendants borrow the root process permit without deadlocking", async () => {
	const previous = process.env.PIE_SUBAGENT_MAX_INFLIGHT;
	process.env.PIE_SUBAGENT_MAX_INFLIGHT = "1";
	try {
		const nestedSdk = successfulFakeSdk();
		const parentSdk = createFakeSdk({
			onPrompt: async (emit) => {
				const nested = await within(runFakeAgent(nestedSdk.sdk), 500);
				assert.equal(nested.exitCode, 0);
				emit({
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "parent done" }], stopReason: "completed", usage: { output: 1 } },
				});
			},
		});
		const parent = await within(subagentRuntime.run({ depth: 1, trail: ["worker"] }, () => runFakeAgent(parentSdk.sdk)), 1_000);
		assert.equal(parent.exitCode, 0);

		// The root release happens only after prompt teardown; a later root can
		// then claim the sole permit.
		const later = await within(subagentRuntime.run({ depth: 1, trail: ["worker"] }, () => runFakeAgent(successfulFakeSdk().sdk)), 1_000);
		assert.equal(later.exitCode, 0);
	} finally {
		if (previous === undefined) delete process.env.PIE_SUBAGENT_MAX_INFLIGHT;
		else process.env.PIE_SUBAGENT_MAX_INFLIGHT = previous;
	}
});

// ============================================================
// SUBAGENT THROUGHPUT SAMPLES (Layer B)
// ============================================================

test("runSingleAgent keeps duplicate-name parallel tools distinct until each call id ends", async () => {
	const snapshots: Array<{ tools: string[] }> = [];
	const { sdk } = createFakeSdk({
		onPrompt: async (emit) => {
			emit({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash" });
			emit({ type: "tool_execution_start", toolCallId: "bash-2", toolName: "bash" });
			emit({ type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash" });
			emit({
				type: "message_end",
				message: { role: "assistant", content: [], stopReason: "stop", usage: { output: 0 } },
			});
			emit({ type: "tool_execution_end", toolCallId: "bash-2", toolName: "bash" });
		},
	});
	const result = await runFakeAgent(sdk, (partial) => {
		const current = partial.details?.results?.[0];
		if (current) snapshots.push({ tools: [...(current.runningTools ?? [])] });
	});
	assert.equal(result.exitCode, 0);
	assert.ok(
		snapshots.some((snapshot) => snapshot.tools.length === 1 && snapshot.tools[0] === "bash"),
		"ending one bash call must leave the sibling visible",
	);
});
