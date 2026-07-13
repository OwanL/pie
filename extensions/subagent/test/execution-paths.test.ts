import test from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type { AgentConfig } from "../agents.js";
import { runSingleAgent, subagentRuntime } from "../runner.js";
import { execute, validateSubagentParams } from "../src/execute.js";
import { isInSubagentContext } from "../../../shared/subagent-context.js";

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
	const model = { id: "model-a", provider: "test" } as any;
	return {
		getAvailable: () => [model],
		getAll: () => [model],
		find: (_provider: string, id: string) => (id === model.id ? model : undefined),
	} as any;
}

function makeParentBridge() {
	const calls = {
		cancelAll: 0,
	};
	const bridge = {
		select: async () => undefined,
		confirm: async () => true,
		input: async () => undefined,
		notify: () => undefined,
		cancelAll: () => {
			calls.cancelAll++;
		},
	};
	return { bridge, calls };
}

function createFakeSdk(options?: {
	onCreateSession?: () => void | Promise<void>;
	onSubscribe?: () => void;
	onPrompt?: (emit: (event: any) => void) => Promise<void>;
}) {
	const state = {
		setUIContextCalls: 0,
		abortCalls: 0,
		disposeCalls: 0,
		unsubscribeCalls: 0,
		promptCalls: 0,
		createSessionArgs: [] as Array<Record<string, unknown>>,
		createResourceLoaderArgs: [] as Array<Record<string, unknown>>,
	};

	const listeners: Array<(event: any) => void> = [];
	let releasePrompt: (() => void) | undefined;

	const session = {
		agent: { state: { model: { id: "session-model" } } },
		extensionRunner: {
			setUIContext: (_ctx: unknown) => {
				state.setUIContextCalls++;
			},
		},
		subscribe: (cb: (event: any) => void) => {
			listeners.push(cb);
			options?.onSubscribe?.();
			return () => {
				state.unsubscribeCalls++;
			};
		},
		prompt: async (_prompt: string) => {
			state.promptCalls++;
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
			state.abortCalls++;
			releasePrompt?.();
		},
		dispose: () => {
			state.disposeCalls++;
		},
	};

	const sdk = {
		createSession: async (args: Record<string, unknown>) => {
			state.createSessionArgs.push(args);
			await options?.onCreateSession?.();
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

test("runSingleAgent returns successful result and captures usage/model", async () => {
	const { sdk, state } = createFakeSdk({
		onPrompt: async (emit) => {
			// Simulate a child tool whose end event races behind the terminal
			// assistant message. Terminal results must not retain live UI state.
			emit({ type: "tool_execution_start", toolCallId: "nested-1", toolName: "bash" });
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: {
						input: 11,
						output: 5,
						cacheRead: 2,
						cacheWrite: 1,
						totalTokens: 16,
						cost: { total: 0.42 },
					},
					model: "assistant-model",
					stopReason: "completed",
				},
			});
		},
	});

	const result = await runSingleAgent(
		process.cwd(),
		[makeAgent()],
		"worker",
		"do work",
		undefined,
		undefined,
		undefined,
		undefined,
		(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
		makeModelRegistry(),
		undefined,
		{ modelId: "model-a", bucket: "medium", thinkingLevel: "low", pool: ["model-a"], fallback: false },
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ sdk: sdk as any, timeoutMs: 50 },
	);

	assert.equal(result.exitCode, 0);
	assert.equal(result.model, "assistant-model");
	assert.equal(result.usage.input, 11);
	assert.equal(result.usage.output, 5);
	assert.equal(result.usage.cost, 0.42);
	assert.deepEqual(result.runningTools, ["bash"], "runningTools is only cleared by tool_execution_end, which this event stream omits");
	assert.equal(state.promptCalls, 1);
	assert.equal(state.unsubscribeCalls, 1);
	assert.equal(state.disposeCalls, 1);
});

test("runSingleAgent aborts promptly when the parent signal is already aborted", async () => {
	const { sdk, state } = createFakeSdk({
		onPrompt: async () => assert.fail("an already-aborted parent must abort the child prompt immediately"),
	});
	const { bridge, calls } = makeParentBridge();
	const controller = new AbortController();
	controller.abort();

	const result = await runSingleAgent(
		process.cwd(),
		[makeAgent()],
		"worker",
		"do work",
		undefined,
		undefined,
		controller.signal,
		undefined,
		(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
		makeModelRegistry(),
		undefined,
		undefined,
		undefined,
		"tool-1",
		bridge,
		undefined,
		undefined,
		{ sdk: sdk as any, timeoutMs: 50 },
	);

	assert.equal(result.exitCode, 1);
	assert.match(result.errorMessage ?? "", /aborted/i);
	assert.equal(state.createResourceLoaderArgs.length, 1, "resources load under the short already-aborted timeout");
	assert.equal(state.createSessionArgs.length, 1, "session is created under the short already-aborted timeout");
	assert.equal(state.promptCalls, 1, "prompt is invoked but aborts immediately");
	assert.equal(state.abortCalls, 1, "session is aborted after the already-aborted prompt");
	assert.equal(state.setUIContextCalls, 1);
	assert.equal(state.unsubscribeCalls, 1);
	assert.equal(state.disposeCalls, 1);
	assert.equal(calls.cancelAll, 1, "parent-bridged UI is cancelled at the abort boundary");
});

test("runSingleAgent aborts the child prompt when the parent aborts after session creation", async () => {
	const controller = new AbortController();
	const { bridge, calls } = makeParentBridge();
	const { sdk, state } = createFakeSdk({
		onSubscribe: () => controller.abort(),
	});

	const result = await runSingleAgent(
		process.cwd(),
		[makeAgent()],
		"worker",
		"do work",
		undefined,
		undefined,
		controller.signal,
		undefined,
		(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
		makeModelRegistry(),
		undefined,
		undefined,
		undefined,
		"tool-create-race",
		bridge,
		undefined,
		undefined,
		{ sdk: sdk as any, timeoutMs: 0 },
	);

	assert.equal(result.exitCode, 1);
	assert.match(result.errorMessage ?? "", /aborted/i);
	assert.equal(state.createSessionArgs.length, 1);
	assert.equal(state.promptCalls, 1, "prompt is invoked and then aborted by the parent signal");
	assert.equal(state.abortCalls, 0, "abort happened before the prompt race was armed; dispose is the cleanup path");
	assert.equal(state.disposeCalls, 1);
	assert.equal(calls.cancelAll, 0, "abort listener never fired because the signal was already aborted");
});

test("runSingleAgent returns an abort result when the parent aborts before createSession resolves", async () => {
	const controller = new AbortController();
	let releaseCreateSession: (() => void) | undefined;
	const createSessionGate = new Promise<void>((resolve) => {
		releaseCreateSession = resolve;
	});
	const { sdk, state } = createFakeSdk({
		onCreateSession: () => createSessionGate,
		onPrompt: async () => assert.fail("createSession aborted before resolving, so prompt must not run"),
	});

	const resultPromise = runSingleAgent(
		process.cwd(),
		[makeAgent()],
		"worker",
		"do work",
		undefined,
		undefined,
		controller.signal,
		undefined,
		(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
		makeModelRegistry(),
		undefined,
		undefined,
		undefined,
		"tool-late-create",
		undefined,
		undefined,
		undefined,
		{ sdk: sdk as any, timeoutMs: 0 },
	);

	for (let i = 0; i < 100 && state.createSessionArgs.length === 0; i++) {
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	assert.equal(state.createSessionArgs.length, 1);
	controller.abort();
	const result = await resultPromise;
	assert.equal(result.exitCode, 1);
	assert.match(result.errorMessage ?? "", /creating subagent session/i);
	assert.equal(state.disposeCalls, 0, "the SDK has not returned a session yet");

	releaseCreateSession?.();
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(state.promptCalls, 0);
	assert.equal(state.abortCalls, 0, "no session existed to abort");
	assert.equal(state.disposeCalls, 0, "late-created sessions are not tracked after the caller settled");
});

test("runSingleAgent returns timeout failure and calls cancelAll", async () => {
	const { sdk, state } = createFakeSdk();
	const { bridge, calls } = makeParentBridge();

	const result = await runSingleAgent(
		process.cwd(),
		[makeAgent()],
		"worker",
		"do work",
		undefined,
		undefined,
		undefined,
		undefined,
		(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
		makeModelRegistry(),
		undefined,
		undefined,
		undefined,
		"tool-timeout",
		bridge,
		undefined,
		undefined,
		{ sdk: sdk as any, timeoutMs: 10 },
	);

	assert.equal(result.exitCode, 1);
	assert.equal(result.stopReason, "timeout");
	assert.match(result.errorMessage ?? "", /timed out after 0.01s/);
	assert.equal(calls.cancelAll, 1);
	assert.ok(state.abortCalls >= 1);
	assert.equal(state.unsubscribeCalls, 1);
	assert.equal(state.disposeCalls, 1);
});

test("runSingleAgent with timeout disabled and no parent signal completes normally", async () => {
	// Default (env unset) = no timeout. With no parent signal either, the prompt
	// runs uninterrupted until it completes naturally — exercises the
	// `!parentSignal && timeoutMs <= 0` branch of buildCombinedAbortSignal.
	const prevTimeout = process.env.PI_SUBAGENT_TIMEOUT_MS;
	delete process.env.PI_SUBAGENT_TIMEOUT_MS;
	try {
		const { sdk, state } = createFakeSdk({
			onPrompt: async (emit) => {
				emit({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
						model: "m",
						stopReason: "completed",
					},
				});
			},
		});

		const result = await runSingleAgent(
			process.cwd(),
			[makeAgent()],
			"worker",
			"do work",
			undefined,
			undefined,
			undefined, // no parent signal
			undefined,
			(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
			makeModelRegistry(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ sdk: sdk as any }, // no timeoutMs seam → default (disabled)
		);

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "m");
		assert.equal(state.promptCalls, 1);
		assert.equal(state.unsubscribeCalls, 1);
		assert.equal(state.disposeCalls, 1);
	} finally {
		if (prevTimeout === undefined) delete process.env.PI_SUBAGENT_TIMEOUT_MS;
		else process.env.PI_SUBAGENT_TIMEOUT_MS = prevTimeout;
	}
});

test("runSingleAgent with timeout disabled: parent abort interrupts without timeout stamp", async () => {
	// Default (env unset) = no timeout. A hanging prompt must be interruptible
	// via the parent abort signal, and the result must NOT be stamped as a
	// timeout — exercises the `parentSignal && timeoutMs <= 0` branch.
	const prevTimeout = process.env.PI_SUBAGENT_TIMEOUT_MS;
	delete process.env.PI_SUBAGENT_TIMEOUT_MS;
	try {
		const { sdk, state } = createFakeSdk(); // prompt hangs until abort
		const { bridge, calls } = makeParentBridge();
		const controller = new AbortController();

		const resultPromise = runSingleAgent(
			process.cwd(),
			[makeAgent()],
			"worker",
			"do work",
			undefined,
			undefined,
			controller.signal,
			undefined,
			(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
			makeModelRegistry(),
			undefined,
			undefined,
			undefined,
			"tool-no-timeout",
			bridge,
			undefined,
			undefined,
			{ sdk: sdk as any }, // no timeoutMs seam → default (disabled)
		);

		setTimeout(() => controller.abort(), 5);
		const result = await resultPromise;

		assert.equal(result.exitCode, 1);
		assert.notEqual(result.stopReason, "timeout");
		assert.doesNotMatch(result.errorMessage ?? "", /timed out/);
		assert.ok(state.abortCalls >= 1);
		assert.equal(calls.cancelAll, 1);
		assert.equal(state.unsubscribeCalls, 1);
		assert.equal(state.disposeCalls, 1);
	} finally {
		if (prevTimeout === undefined) delete process.env.PI_SUBAGENT_TIMEOUT_MS;
		else process.env.PI_SUBAGENT_TIMEOUT_MS = prevTimeout;
	}
});

test("runSingleAgent honours PI_SUBAGENT_TIMEOUT_MS env var (no seam): hanging prompt times out", async () => {
	// End-to-end: a positive env var (with no _internal.timeoutMs seam) drives
	// resolveSubagentTimeoutMs -> buildCombinedAbortSignal(timeoutMs > 0) ->
	// AbortSignal.timeout fires -> session.abort -> applyTimeoutFailure.
	const prevTimeout = process.env.PI_SUBAGENT_TIMEOUT_MS;
	process.env.PI_SUBAGENT_TIMEOUT_MS = "20";
	try {
		const { sdk, state } = createFakeSdk(); // prompt hangs until abort
		const { bridge, calls } = makeParentBridge();

		const result = await runSingleAgent(
			process.cwd(),
			[makeAgent()],
			"worker",
			"do work",
			undefined,
			undefined,
			undefined, // no parent signal — only the env-var timeout can interrupt
			undefined,
			(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
			makeModelRegistry(),
			undefined,
			undefined,
			undefined,
			"tool-env-timeout",
			bridge,
			undefined,
			undefined,
			{ sdk: sdk as any }, // no timeoutMs seam — env var is the source of truth
		);

		assert.equal(result.exitCode, 1);
		assert.equal(result.stopReason, "timeout");
		assert.match(result.errorMessage ?? "", /timed out after 0.02s/);
		assert.ok(state.abortCalls >= 1);
		assert.equal(calls.cancelAll, 1);
		assert.equal(state.unsubscribeCalls, 1);
		assert.equal(state.disposeCalls, 1);
	} finally {
		if (prevTimeout === undefined) delete process.env.PI_SUBAGENT_TIMEOUT_MS;
		else process.env.PI_SUBAGENT_TIMEOUT_MS = prevTimeout;
	}
});

test("validateSubagentParams enforces exactly one mode and validates agent names", () => {
	const agents = [makeAgent({ name: "worker" })];

	const invalidMode = validateSubagentParams({}, agents);
	assert.equal(invalidMode.ok, false);

	const invalidAgent = validateSubagentParams({ agent: "missing", task: "x" } as any, agents);
	assert.equal(invalidAgent.ok, true);
	if (!invalidAgent.ok) {
		assert.fail("expected valid mode with invalid-agent result");
	}
	assert.equal(invalidAgent.invalidResults.length, 1);
	assert.equal(invalidAgent.invalidResults[0].exitCode, 1);

	const validSingle = validateSubagentParams({ agent: "worker", task: "x" } as any, agents);
	assert.equal(validSingle.ok, true);
	if (!validSingle.ok) {
		assert.fail("expected single mode validation to pass");
	}
	assert.equal(validSingle.mode, "single");
	assert.equal(validSingle.invalidResults.length, 0);
});

test("execute returns disabled response before any discovery", async () => {
	const response = await execute(
		"tool-1",
		{ agent: "worker", task: "x" } as any,
		new AbortController().signal,
		() => undefined,
		{ cwd: process.cwd() } as any,
		{} as any,
		() => true,
	);

	assert.equal(response.isError, true);
	assert.match(response.content[0].text, /Sub agents are disabled/);
});

test("execute returns depth-limit response when nested depth is exhausted", async () => {
	const previousDepth = process.env.PI_SUBAGENT_DEPTH;
	const previousMaxDepth = process.env.PIE_SUBAGENT_MAX_DEPTH;
	process.env.PI_SUBAGENT_DEPTH = "3";
	process.env.PIE_SUBAGENT_MAX_DEPTH = "3";
	try {
		const response = await execute(
			"tool-2",
			{ agent: "worker", task: "x" } as any,
			new AbortController().signal,
			() => undefined,
			{ cwd: process.cwd() } as any,
			{} as any,
			() => false,
		);
		assert.equal(response.isError, true);
		assert.match(response.content[0].text, /depth limit reached/i);
	} finally {
		if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = previousDepth;
		if (previousMaxDepth === undefined) delete process.env.PIE_SUBAGENT_MAX_DEPTH;
		else process.env.PIE_SUBAGENT_MAX_DEPTH = previousMaxDepth;
	}
});

test("execute throws mode-count error for invalid mode selection", async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "subagent-mode-test-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempDir;
	try {
		await assert.rejects(
			execute(
				"tool-3",
				{} as any,
				new AbortController().signal,
				() => undefined,
				{ cwd: tempDir, hasUI: false } as any,
				{} as any,
				() => false,
			),
			/Provide exactly one mode/,
		);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("runSingleAgent runs the prompt inside the shared subagent context (A)", async () => {
	// The runner wraps session.prompt() in subagentContext.run({ depth }) so that
	// before_agent_start extensions (skill-pruner) can detect a scoped subagent
	// session and skip the prepass. Verify the signal is live during the prompt
	// by observing it from inside the fake SDK's onPrompt.
	let observed: boolean | undefined;
	const { sdk } = createFakeSdk({
		onPrompt: async () => {
			observed = isInSubagentContext();
		},
	});

	const result = await subagentRuntime.run({ depth: 1, trail: ["worker"] }, async () => {
		return runSingleAgent(
			process.cwd(),
			[makeAgent()],
			"worker",
			"do work",
			undefined,
			undefined,
			undefined,
			undefined,
			(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
			makeModelRegistry(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ sdk: sdk as any, timeoutMs: 0 },
		);
	});

	assert.equal(observed, true);
	assert.equal(result.exitCode, 0);
});

test("runSingleAgent: error thrown during prefill is annotated with the run stage (D)", async () => {
	// A provider error during prefill (e.g. an aborted fetch surfacing as
	// "Request was aborted") must carry the stage so the user knows where it died
	// — previously the bare message gave no hint whether it was prefill or a
	// mid-stream interrupt.
	const { sdk } = createFakeSdk({
		onPrompt: async () => {
			throw new Error("Request was aborted");
		},
	});

	const result = await runSingleAgent(
		process.cwd(),
		[makeAgent()],
		"worker",
		"do work",
		undefined,
		undefined,
		undefined,
		undefined,
		(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
		makeModelRegistry(),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ sdk: sdk as any, timeoutMs: 0 },
	);

	assert.equal(result.exitCode, 1);
	assert.match(result.errorMessage ?? "", /Request was aborted/);
	assert.match(result.errorMessage ?? "", /while waiting for model response/);
});

test("runSingleAgent propagates nested tool_execution_update partials onto result.messages (T1)", async () => {
	// Depth-2 subagent output travels as `tool_execution_update` on the depth-1
	// session — the one event the runner previously dropped. Without propagating
	// it, depth-2 streaming never reaches the host transcript (the "no reply"
	// half of the hang). Verify the runner stamps the partial onto the matching
	// toolCall in result.messages and emits an update.
	const nestedPartial = {
		content: [{ type: "text", text: "nested streaming..." }],
		details: {
			mode: "single",
			results: [
				{ agent: "scout", task: "x", exitCode: -1, messages: [], streamingText: "nested streaming..." },
			],
		},
	};
	let updateCount = 0;
	let lastDetails: { results: unknown[] } | undefined;

	const { sdk } = createFakeSdk({
		onPrompt: async (emit) => {
			// 1. assistant message carrying a nested subagent toolCall
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "spawning nested scout" },
						{ type: "toolCall", id: "tc-nested", name: "subagent", arguments: { agent: "scout", task: "x" } },
					],
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
					model: "m",
					stopReason: "toolUse",
				},
			});
			// 2. nested tool starts
			emit({ type: "tool_execution_start", toolCallId: "tc-nested", toolName: "subagent" });
			// 3. nested tool streams a partial (depth-2 output)
			emit({ type: "tool_execution_update", toolCallId: "tc-nested", partialResult: nestedPartial });
		},
	});

	const result = await runSingleAgent(
		process.cwd(),
		[makeAgent()],
		"worker",
		"do work",
		undefined,
		undefined,
		undefined,
		(partial) => {
			updateCount++;
			lastDetails = partial.details as { results: unknown[] } | undefined;
		},
		(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
		makeModelRegistry(),
		undefined,
		{ modelId: "model-a", bucket: "medium", thinkingLevel: "low", pool: ["model-a"], fallback: false },
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ sdk: sdk as any, timeoutMs: 0 },
	);

	// The depth-1 result's messages carry the assistant message whose toolCall
	// part now holds the nested partial (stamped by tool_execution_update).
	const asst = result.messages.find((m) => m.role === "assistant") as any;
	assert.ok(asst, "assistant message committed");
	const tcPart = asst.content.find((p: any) => p.type === "toolCall" && p.id === "tc-nested");
	assert.ok(tcPart, "nested toolCall part present");
	assert.equal(tcPart.result, nestedPartial, "nested partial stamped on the toolCall part");
	assert.equal(tcPart.status, "running", "toolCall part marked running");
	// The nested partial's streamingText survives — the webview/token-rate read it.
	assert.equal(tcPart.result.details.results[0].streamingText, "nested streaming...");
	// The update propagated through the emitter (onUpdate fired for the partial).
	assert.ok(updateCount > 0, "onUpdate fired");
	assert.ok(lastDetails, "last update carried details");
});

test("runSingleAgent tool_execution_update is a graceful no-op before the assistant message lands (T1)", async () => {
	// An update arriving before message_end committed the toolCall's owner
	// assistant message must not throw — the next update catches it.
	const { sdk } = createFakeSdk({
		onPrompt: async (emit) => {
			emit({ type: "tool_execution_update", toolCallId: "tc-early", partialResult: { content: [], details: { results: [] } } });
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
					model: "m",
					stopReason: "completed",
				},
			});
		},
	});

	const result = await runSingleAgent(
		process.cwd(),
		[makeAgent()],
		"worker",
		"do work",
		undefined,
		undefined,
		undefined,
		undefined,
		(results) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }),
		makeModelRegistry(),
		undefined,
		{ modelId: "model-a", bucket: "medium", thinkingLevel: "low", pool: ["model-a"], fallback: false },
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ sdk: sdk as any, timeoutMs: 0 },
	);

	assert.equal(result.exitCode, 0);
});
