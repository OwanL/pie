/** Focused lifecycle and root-tree concurrency tests for runner.ts. */

import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { runSingleAgent, subagentRuntime } from "../runner.js";
import { captureSubagentTerminalResult } from "../src/analytics-capture.js";
import { parseModelPricing, resolveApplicablePricing } from "../../../shared/pricing-core.js";
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
	cwd?: string,
) {
	return runSingleAgent(
		process.cwd(),
		[makeAgent()],
		"worker",
		"do work",
		cwd,
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
		{ sdk: sdk as any },
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

test("runSingleAgent persists the effective child cwd", async () => {
	const { sdk } = successfulFakeSdk();
	const cwd = path.join(process.cwd(), "child-cwd");

	const result = await runFakeAgent(sdk, undefined, undefined, cwd);

	assert.equal(result.cwd, cwd);
});

test("runner trace labels only source and dedupe work at the producer boundary", async () => {
	const sinkKey = Symbol.for("pie.runtime-trace-sink.v1");
	const target = globalThis as Record<PropertyKey, unknown>;
	const previous = target[sinkKey];
	const events: Array<Record<string, unknown>> = [];
	target[sinkKey] = (event: unknown) => events.push(event as Record<string, unknown>);
	try {
		const partial = {
			details: {
				results: [{ attemptId: "nested-attempt", progressGeneration: 1, messages: [] }],
			},
		};
		const { sdk } = createFakeSdk({
			onPrompt: async (emit) => {
				emit({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "nested-call", name: "subagent", arguments: {} }],
						stopReason: "toolUse",
						usage: { input: 1, output: 1 },
					},
				});
				emit({ type: "tool_execution_update", toolCallId: "nested-call", partialResult: partial });
				emit({ type: "tool_execution_update", toolCallId: "nested-call", partialResult: partial });
				emit({
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "completed", usage: { output: 1 } },
				});
			},
		});
		await runFakeAgent(sdk, () => {});
	} finally {
		if (previous === undefined) delete target[sinkKey];
		else target[sinkKey] = previous;
	}

	const dedupe = events.filter((event) => event.phase === "dedupe");
	assert.deepEqual(dedupe.map((event) => [event.outcome, event.payloadClass]), [
		["changed", undefined],
		["duplicate", undefined],
	]);
	assert.ok(events.some((event) => event.phase === "source_update" && event.payloadClass === "source"));
	assert.ok(events.some((event) => event.phase === "terminal"));
	assert.equal(events.some((event) => event.phase === "measure"), false, "runner does not measure settlement budgets");
	assert.equal(events.some((event) => event.phase === "recursive_projection"), false, "tool attachment is not recursive projection");
	assert.equal(events.some((event) => event.payloadClass === "compact"), false, "fingerprint bytes are not labeled compact-event bytes");
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
		{ sdk: sdk as any },
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

// ============================================================
// COST EVIDENCE PROJECTION
// ============================================================

test("runSingleAgent leaves projected cost absent when no provider turn reports cost", async () => {
	// Older/mock SDK event shapes may omit the cost block entirely. The
	// transcript projection must carry no invented zero so the UI cannot
	// display a fabricated "$0.000" free-run claim (STATE_CONTRACT: unknown
	// values are absent rather than invented zeroes).
	const { sdk } = createFakeSdk({
		onPrompt: async (emit) => {
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 11, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 19 },
					model: "session-model",
					stopReason: "completed",
				},
			});
		},
	});

	const result = await runFakeAgent(sdk);

	assert.equal(result.usage.input, 11);
	assert.equal(result.usage.output, 5);
	assert.equal(result.usage.cost, undefined, "missing cost evidence must stay absent, not become 0");
});

test("runSingleAgent keeps SDK catalog estimates out of provider-reported cost", async () => {
	const { sdk } = createFakeSdk({
		onPrompt: async (emit) => {
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "estimated only" }],
					usage: {
						input: 11,
						output: 5,
						cacheRead: 2,
						cacheWrite: 1,
						totalTokens: 19,
						cost: { total: 0.42 },
					},
					model: "session-model",
					stopReason: "completed",
				},
			});
		},
	});

	const result = await runFakeAgent(sdk);

	assert.equal(result.usage.cost, undefined, "SDK catalog estimates are not provider billing");
	assert.equal(result.providerInvocations?.[0]?.usage?.cost, undefined);
	assert.equal(result.providerInvocations?.[0]?.usage?.reportedCostUsd, undefined);
});

test("provider invocation keeps missing SDK start unknown and observes terminal clock", async () => {
	const terminalObservedAt = 1_800_000_000_000;
	const originalDateNow = Date.now;
	Date.now = () => terminalObservedAt;
	let result: Awaited<ReturnType<typeof runFakeAgent>>;
	try {
		const { sdk } = createFakeSdk({
			onPrompt: async (emit) => {
				emit({ type: "message_start", message: { role: "assistant" } });
				emit({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "untimed" }],
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
						model: "session-model",
						stopReason: "completed",
					},
				});
			},
		});
		result = await runFakeAgent(sdk);
	} finally {
		Date.now = originalDateNow;
	}
	assert.equal(result.providerInvocations?.[0]?.startedAt, undefined);
	assert.equal(result.providerInvocations?.[0]?.completedAt, terminalObservedAt);
});

test("provider invocation completion uses message_end wall time for scheduled pricing", async () => {
	// The SDK stamps its assistant message when the request starts and reuses
	// that timestamp at message_end. This interval crosses the schedule boundary.
	const startedAt = Date.UTC(2026, 8, 24, 11, 59, 59, 500);
	const terminalObservedAt = startedAt + 1_000;
	const pricing = parseModelPricing({
		input: 0.1,
		output: 0.2,
		cacheRead: 0.01,
		cacheWrite: 0,
		peak: {
			weekdaysUtc: [4],
			startMinutesUtc: 12 * 60,
			endMinutesUtc: 13 * 60,
			override: { input: 0.3, output: 0.4, cacheRead: 0.02, cacheWrite: 0 },
		},
	});
	assert.ok(pricing);

	let wallClock = startedAt;
	const originalDateNow = Date.now;
	Date.now = () => wallClock;
	let result: Awaited<ReturnType<typeof runFakeAgent>>;
	try {
		const { sdk } = createFakeSdk({
			onPrompt: async (emit) => {
				emit({ type: "message_start", message: { role: "assistant", timestamp: startedAt } });
				wallClock = terminalObservedAt;
				emit({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "timed" }],
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
						model: "session-model",
						// Deliberately the same creation timestamp as message_start.
						timestamp: startedAt,
						stopReason: "completed",
					},
				});
			},
		});
		result = await runFakeAgent(sdk);
	} finally {
		Date.now = originalDateNow;
	}

	assert.equal(result.providerInvocations?.[0]?.startedAt, startedAt);
	assert.equal(result.providerInvocations?.[0]?.completedAt, terminalObservedAt);
	assert.equal(result.turnThroughputSamples?.[0]?.endedAt, new Date(terminalObservedAt).toISOString());
	assert.equal(result.turnThroughputSamples?.[0]?.generationDurationMs, terminalObservedAt - startedAt);

	const observations: any[] = [];
	const priceRequests: any[] = [];
	assert.equal(captureSubagentTerminalResult(result, {
		generationId: "runner-timestamp-regression",
		captureSubject: { kind: "session", rootSessionId: "runner-timestamp-regression" },
		sink: { submitDetail: () => undefined },
		factSink: { submit: (observation) => observations.push(observation) },
		priceSettlement: (request) => {
			priceRequests.push(request);
			if (request.startedAtMs === undefined || request.endedAtMs === undefined) return undefined;
			const applicable = resolveApplicablePricing(pricing, {
				interval: { startedAtMs: request.startedAtMs, endedAtMs: request.endedAtMs },
				cacheReadTokens: request.usage.cacheRead,
			});
			return applicable ? {
				inputUsdPerMillionTokens: applicable.input,
				outputUsdPerMillionTokens: applicable.output,
				cacheReadUsdPerMillionTokens: applicable.cacheRead,
				cacheWriteUsdPerMillionTokens: applicable.cacheWrite,
			} : undefined;
		},
	}, "parent-tool"), "submitted");
	assert.deepEqual(priceRequests.map(({ startedAtMs, endedAtMs }) => ({ startedAtMs, endedAtMs })), [
		{ startedAtMs: startedAt, endedAtMs: terminalObservedAt },
	]);
	const settlement = observations.find((observation) => observation.observationKind === "providerSettlement");
	assert.equal(settlement?.fields?.pricing, undefined, "a schedule-boundary crossing remains explicitly unpriced");
	assert.equal(settlement?.fields?.endedAtMs, terminalObservedAt);
});

test("runSingleAgent preserves incomplete provider token channels as unknown", async () => {
	const { sdk } = createFakeSdk({
		onPrompt: async (emit) => {
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "partial" }],
					// The provider omitted cache channels and supplied an invalid
					// negative output count; neither may become a known zero.
					usage: { input: 11, output: -5, cacheRead: Number.NaN },
					model: "session-model",
					stopReason: "completed",
				},
			});
		},
	});

	const result = await runFakeAgent(sdk);

	assert.equal(result.usage.input, 11);
	assert.equal(result.usage.output, 0);
	assert.equal(result.usage.cacheRead, 0);
	assert.equal(result.usage.tokenChannelsKnown, false);
	assert.deepEqual(result.usage.tokenChannelPresence, {
		input: true,
		output: false,
		cacheRead: false,
		cacheWrite: false,
	});
	assert.deepEqual(result.providerInvocations?.[0]?.usage, { input: 11 });
});

test("runSingleAgent accumulates only provider-reported cost across turns", async () => {
	const { sdk } = createFakeSdk({
		onPrompt: async (emit) => {
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "first" }],
					usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7, reportedCostUsd: 0.3, cost: { total: 0.3 } },
					model: "session-model",
					stopReason: "toolUse",
				},
			});
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					// Second turn's event shape carries no cost evidence.
					usage: { input: 4, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 7 },
					model: "session-model",
					stopReason: "completed",
				},
			});
		},
	});

	const result = await runFakeAgent(sdk);

	assert.equal(result.usage.turns, 2);
	assert.equal(result.usage.cost, 0.3, "only the reported turn contributes cost evidence");
});

test("runSingleAgent keeps provider-reported zero cost as evidence", async () => {
	const { sdk } = createFakeSdk({
		onPrompt: async (emit) => {
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, reportedCostUsd: 0, cost: { total: 0 } },
					model: "session-model",
					stopReason: "completed",
				},
			});
		},
	});

	const result = await runFakeAgent(sdk);

	assert.equal(result.usage.cost, 0, "an explicitly reported zero stays a numeric zero");
});

test("runSingleAgent ignores malformed cost evidence", async () => {
	const { sdk } = createFakeSdk({
		onPrompt: async (emit) => {
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "first" }],
					usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { total: Number.NaN } },
					model: "session-model",
					stopReason: "toolUse",
				},
			});
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 4, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 7, reportedCostUsd: 0.25, cost: { total: 0.25 } },
					model: "session-model",
					stopReason: "completed",
				},
			});
		},
	});

	const result = await runFakeAgent(sdk);

	assert.equal(result.usage.cost, 0.25, "non-finite reported totals are not cost evidence");
});
