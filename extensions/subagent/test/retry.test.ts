/**
 * REM-03 retry/attempt semantics tests.
 *
 * Covers:
 *  - stable unique attemptId per dispatched attempt (shared with orphan registry)
 *  - shared tree budget charged per actual dispatched attempt, including retries
 *  - provider-aware failover excludes every configured model of the failed provider
 *  - Retry-After hint parsing, clamping, bounded exponential fallback, abortable wait
 *  - no retry after auth/client failures or partial output/tool side effects
 *  - bounded per-attempt analytics persisted on the final result
 *
 * Approach: drive executeSingleMode with an injected runAttempt seam and a
 * deterministic retry clock so no real SDK, network, or wall-clock delay is
 * needed. A fake SDK module hook is shared with modes.test.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import type { SingleResult } from "../types.js";
import { parseRetryAfterMs, computeBackoffMs, abortableDelay, buildAttemptRecord, readRetryPolicy } from "../src/retry.js";
import { resetFairSelectionBags } from "../bucket-selector.js";

// ---------------------------------------------------------------------------
// Mock SDK + hook (same technique as modes.test.ts)
// ---------------------------------------------------------------------------

const MOCK_SDK_SOURCE = [
	"export class DefaultResourceLoader { constructor(a){ this.a = a; } async reload(){} }",
	"export const SessionManager = { inMemory(cwd){ return { cwd: cwd }; } };",
	"export function getAgentDir(){ return '.'; }",
	"export async function createAgentSession(args){",
	"  const listeners = [];",
	"  let release;",
	"  const session = {",
	"    agent: { state: { model: { id: 'session-model' } } },",
	"    extensionRunner: { setUIContext(ctx){ (globalThis.__MOCK_PROXIES__ = globalThis.__MOCK_PROXIES__ || []).push(ctx); } },",
	"    subscribe(cb){ listeners.push(cb); return () => {}; },",
	"    async prompt(p){",
	"      const b = globalThis.__MOCK_SDK_BEHAVIOR__;",
	"      if (b && b.onPrompt) { await b.onPrompt(function(ev){ for (const l of listeners) l(ev); }, p); return; }",
	"      await new Promise(function(r){ release = r; });",
	"    },",
	"    async abort(){ if (release) release(); },",
	"    dispose(){}",
	"  };",
	"  return { session: session };",
	"}",
].join("\n");

const __mockSdkDir = mkdtempSync(path.join(tmpdir(), "retry-mock-sdk-"));
const __mockSdkPath = path.join(__mockSdkDir, "mock-sdk.mjs");
writeFileSync(__mockSdkPath, MOCK_SDK_SOURCE, "utf-8");
const __hookPath = path.join(__mockSdkDir, "hook.mjs");
writeFileSync(
	__hookPath,
	[
		"export async function resolve(specifier, context, nextResolve){",
		`  if (specifier === '@mariozechner/pi-coding-agent') return { url: ${JSON.stringify(pathToFileURL(__mockSdkPath).href)}, shortCircuit: true };`,
		"  return nextResolve(specifier, context);",
		"}",
	].join("\n"),
	"utf-8",
);
if (!(globalThis as { __PIE_SDK_HOOK_REGISTERED__?: boolean }).__PIE_SDK_HOOK_REGISTERED__) {
	(globalThis as { __PIE_SDK_HOOK_REGISTERED__?: boolean }).__PIE_SDK_HOOK_REGISTERED__ = true;
	Module.register(pathToFileURL(__hookPath));
}

const __require = createRequire(import.meta.url);
const __modesPath = path.resolve("extensions/subagent/src/modes.ts");
const { executeSingleMode } = __require(__modesPath) as typeof import("../src/modes.js");
const { resolvePhaseInactivityMs, PHASE_INACTIVITY_MS } = __require(
	path.resolve("extensions/subagent/src/execute.ts"),
) as typeof import("../src/execute.js");
const execSingle = executeSingleMode as any;

const agentDir = mkdtempSync(path.join(tmpdir(), "retry-agents-"));
const agentsSubdir = path.join(agentDir, "agents");
mkdirSync(agentsSubdir, { recursive: true });
writeFileSync(
	path.join(agentsSubdir, "worker.md"),
	"---\nname: worker\ndescription: test agent\n---\nYou are a worker.\n",
	"utf-8",
);

function makeCtx(models: any[] = []) {
	return {
		cwd: process.cwd(),
		model: models[0] ?? { id: "active-model", provider: "active-provider" },
		modelRegistry: {
			getAvailable: () => models,
			getAll: () => models,
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		},
	};
}
function makeAgents(): any[] {
	return [{ name: "worker", description: "d", systemPrompt: "", source: "user", filePath: "w.md" }];
}

function assignedModels(...models: string[]) {
	return models.map((model) => ({ model, thinkingLevel: "high" as const }));
}

function selCtx(over: Record<string, unknown> = {}): any {
	return {
		modelConfig: [],
		disabledProviders: new Set(),
		allowedModelIds: undefined,
		bucketAssignments: undefined,
		alwaysParentModel: true,
		nestedAllowedBuckets: { small: true, medium: true, frontier: true },
		...over,
	};
}
const noSignal = () => new AbortController().signal;
const noOpDetails = (mode: any, results: any[]) => ({ mode, agentScope: "user" as const, projectAgentsDir: null, results });

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

test("parseRetryAfterMs recognizes seconds, ms, headers, and HTTP dates", () => {
	const policy = { ...readRetryPolicy(), maxRetryAfterMs: 600_000 };
	assert.equal(parseRetryAfterMs({ retryAfter: 5 } as any, policy), 5_000, "numeric seconds");
	// Values above 1e10 are interpreted as already-milliseconds (SDK bug path).
	assert.equal(parseRetryAfterMs({ retryAfter: 20_000_000_000 } as any, policy), 600_000, "numeric ms clamped");
	assert.equal(parseRetryAfterMs({ retryAfterMs: 7_000 } as any, policy), 7_000, "explicit ms field");
	assert.equal(
		parseRetryAfterMs({ headers: { "retry-after": "12" } } as any, policy),
		12_000,
		"headers seconds",
	);
	assert.equal(
		parseRetryAfterMs({ response: { headers: { "retry-after": "8" } } } as any, policy),
		8_000,
		"nested response headers",
	);
	const future = new Date(Date.now() + 90_000).toUTCString();
	const fromDate = parseRetryAfterMs({ headers: { "retry-after": future } } as any, policy);
	assert.ok(fromDate != null && fromDate >= 85_000 && fromDate <= 95_000, "HTTP date");
});

test("parseRetryAfterMs HTTP-date parsing uses an injected now value deterministically", () => {
	const policy = { ...readRetryPolicy(), maxRetryAfterMs: 600_000 };
	const now = new Date("2026-07-16T12:00:00.000Z").getTime();
	const future = new Date(now + 90_000).toUTCString();
	assert.equal(parseRetryAfterMs({ headers: { "retry-after": future } } as any, policy, now), 90_000, "injected now value");
	const clock = { now: () => now + 60_000, setTimer: () => ({ promise: Promise.resolve(), cancel: () => {} }) };
	assert.equal(parseRetryAfterMs({ headers: { "retry-after": future } } as any, policy, clock), 30_000, "injected clock");
});

test("parseRetryAfterMs preserves an explicit immediate retry", () => {
	const policy = readRetryPolicy();
	assert.equal(parseRetryAfterMs({ retryAfterMs: 0 }, policy), 0);
	assert.equal(parseRetryAfterMs({ retryAfter: 0 }, policy), 0);
	assert.equal(parseRetryAfterMs({ headers: { "retry-after": "0" } }, policy), 0);
});

test("parseRetryAfterMs clamps to policy maximum", () => {
	const policy = { ...readRetryPolicy(), maxRetryAfterMs: 30_000 };
	assert.equal(parseRetryAfterMs({ retryAfter: 600 } as any, policy), 30_000, "clamp seconds");
	assert.equal(parseRetryAfterMs({ retryAfterMs: 1_000_000 } as any, policy), 30_000, "clamp ms");
});

test("computeBackoffMs is bounded exponential", () => {
	const policy = { ...readRetryPolicy(), initialRetryMs: 1_000, maxRetryMs: 10_000, retryMultiplier: 2 };
	assert.equal(computeBackoffMs(0, policy), 1_000);
	assert.equal(computeBackoffMs(3, policy), 8_000);
	assert.equal(computeBackoffMs(10, policy), 10_000, "bounded at max");
});

test("buildAttemptRecord carries only bounded execution-phase evidence, never retry_wait", () => {
	const record = buildAttemptRecord(syntheticResult({
		exitCode: 0,
		stopReason: "completed",
		phaseDurationsMs: { preparing: 12, waiting_provider: 34, retry_wait: 99 } as any,
	}), 250);
	assert.deepEqual(record.phaseDurationsMs, { preparing: 12, waiting_provider: 34 });
	assert.equal(record.backoffMs, 250, "retry backoff stays separately reported");
	assert.equal(record.attemptSettlementOutcome, "completed");
});

test("abortableDelay rejects immediately when already aborted", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		() => abortableDelay(1_000, controller.signal, new ImmediateClock()),
		/Retry delay aborted/,
	);
});

test("abortableDelay rejects when signal aborts during the wait", async () => {
	const controller = new AbortController();
	const clock = new PendingClock();
	const delay = abortableDelay(1_000_000, controller.signal, clock);
	setTimeout(() => controller.abort(), 5);
	await assert.rejects(() => delay, /Retry delay aborted/);
});

/** Deterministic retry clock: timers resolve immediately so tests don't wait. */
class ImmediateClock {
	nowMs = 0;
	now(): number { return this.nowMs; }
	setTimer(_ms: number): { promise: Promise<void>; cancel: () => void } {
		return { promise: Promise.resolve(), cancel: () => {} };
	}
}

/** Retry clock whose timers stay pending until explicitly advanced. */
class PendingClock {
	nowMs = 0;
	private timers: Array<{ deadline: number; resolve: () => void }> = [];

	now(): number { return this.nowMs; }

	setTimer(ms: number): { promise: Promise<void>; cancel: () => void } {
		const deadline = this.nowMs + ms;
		let resolve!: () => void;
		const promise = new Promise<void>((r) => {
			resolve = r;
		});
		const timer = { deadline, resolve };
		this.timers.push(timer);
		return {
			promise,
			cancel: () => {
				this.timers = this.timers.filter((t) => t !== timer);
			},
		};
	}

	async advance(ms: number): Promise<void> {
		const target = this.nowMs + ms;
		let safety = 0;
		while (this.nowMs < target && safety < 1_000) {
			safety++;
			const next = this.timers
				.filter((t) => t.deadline <= target)
				.sort((a, b) => a.deadline - b.deadline)[0];
			if (!next) {
				this.nowMs = target;
				break;
			}
			this.nowMs = next.deadline;
			this.timers = this.timers.filter((t) => t !== next);
			next.resolve();
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
	}
}

function syntheticResult(over: Partial<SingleResult>): SingleResult {
	const now = Date.now();
	return {
		agent: "worker",
		agentSource: "user",
		task: "do work",
		exitCode: 1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		startedAt: now,
		completedAt: now,
		...over,
	} as SingleResult;
}

const ENV_KEYS = ["PIE_SUBAGENT_MAX_INFLIGHT", "PIE_SUBAGENT_MAX_TREE_SESSIONS", "PI_CODING_AGENT_DIR"];
const savedEnv: Record<string, string | undefined> = {};
let savedRandom: () => number;
test.before(() => {
	savedRandom = Math.random;
	Math.random = () => 0;
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	process.env.PIE_SUBAGENT_MAX_INFLIGHT = "10";
	process.env.PIE_SUBAGENT_MAX_TREE_SESSIONS = "10";
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
test.beforeEach(() => {
	resetFairSelectionBags();
});
test.after(() => {
	Math.random = savedRandom;
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

// ---------------------------------------------------------------------------
// Retry-After / backoff / abort
// ---------------------------------------------------------------------------

test("Retry-After hint is parsed, clamped, and recorded in attempt analytics", async () => {
	const models = [
		{ id: "model-a", provider: "provider-a", family: "family-a" },
		{ id: "model-b", provider: "provider-b", family: "family-b" },
	];
	const attempts: Array<{ model: string; attemptId: string; error?: Error }> = [];
	const clock = new ImmediateClock();
	const response: any = await execSingle(
		{ agent: "worker", task: "do work", bucket: "medium" },
		makeCtx(models),
		makeAgents(),
		() => undefined,
		{ depth: 0, trail: [] },
		noOpDetails,
		undefined,
		noSignal(),
		selCtx({
			alwaysParentModel: false,
			fallbackOnProviderFailure: true,
			bucketAssignments: { small: [], medium: assignedModels("model-a", "model-b"), frontier: [] },
			registryModels: models,
		}),
		"t-retry-after",
		undefined,
		undefined,
		undefined,
		{
			clock,
			runAttempt: (resolved: any, attemptId: string) => {
				const model = resolved.modelOverride;
				if (model === "model-a") {
					const error = Object.assign(new Error("rate limited"), {
						status: 429,
						headers: { "retry-after": "300" }, // 5 minutes, clamped to max
					});
					attempts.push({ model, attemptId, error });
					return Promise.resolve(
						syntheticResult({
							exitCode: 1,
							stopReason: "error",
							errorMessage: error.message,
							stderr: error.message,
							selectedModel: model,
							model,
							provider: "provider-a",
							retryable: true,
							replaySafety: "safe",
							failureClass: "rate_limit",
							// Simulate a Retry-After hint that exceeds the policy maximum.
							retryAfterMs: 300_000,
						}),
					);
				}
				attempts.push({ model, attemptId });
				return Promise.resolve(
					syntheticResult({
						exitCode: 0,
						stopReason: "completed",
						selectedModel: model,
						model,
						provider: "provider-b",
					}),
				);
			},
		},
	);

	assert.equal(response.isError, undefined);
	assert.equal(attempts.length, 2);
	assert.equal(attempts[0]?.model, "model-a");
	assert.equal(attempts[1]?.model, "model-b");
	const records = response.details.results[0].attemptRecords;
	assert.equal(records?.length, 2);
	assert.equal(records?.[1]?.backoffMs, 120_000, "Retry-After is clamped to policy max");
	const runtime = response.details.results[0];
	assert.equal(runtime.promptHash, "64d6f071c16a0984c4d1331002dd6f6a2ec7a503d23b38648fa52069af7330e7");
	assert.equal(runtime.requestedBucket, "medium");
	assert.equal(runtime.bucketDowngraded, false);
	assert.equal(runtime.parentToolCallId, "t-retry-after");
	assert.equal(runtime.model, "model-b");
	assert.equal(runtime.provider, "provider-b");
	assert.equal(runtime.family, "family-b", "final provenance follows the effective retry model/provider");
});

test("bounded exponential backoff is used when no Retry-After hint is present", async () => {
	const models = [
		{ id: "model-a", provider: "provider-a" },
		{ id: "model-b", provider: "provider-b" },
	];
	const clock = new ImmediateClock();
	const response: any = await execSingle(
		{ agent: "worker", task: "do work", bucket: "medium" },
		makeCtx(models),
		makeAgents(),
		() => undefined,
		{ depth: 0, trail: [] },
		noOpDetails,
		undefined,
		noSignal(),
		selCtx({
			alwaysParentModel: false,
			fallbackOnProviderFailure: true,
			bucketAssignments: { small: [], medium: assignedModels("model-a", "model-b"), frontier: [] },
			registryModels: models,
		}),
		"t-backoff",
		undefined,
		undefined,
		undefined,
		{
			clock,
			runAttempt: (resolved: any, _attemptId: string) => {
				const model = resolved.modelOverride;
				if (model === "model-a") {
					return Promise.resolve(
						syntheticResult({
							exitCode: 1,
							stopReason: "error",
							errorMessage: "timed out",
							stderr: "timed out",
							selectedModel: model,
							model,
							provider: "provider-a",
							retryable: true,
							replaySafety: "safe",
							failureClass: "timeout",
						}),
					);
				}
				return Promise.resolve(
					syntheticResult({
						exitCode: 0,
						stopReason: "completed",
						selectedModel: model,
						model,
						provider: "provider-b",
					}),
				);
			},
		},
	);

	const records = response.details.results[0].attemptRecords;
	assert.equal(records?.length, 2);
	assert.equal(records?.[1]?.backoffMs, 1_000, "initial exponential backoff is used");
});

test("retry wait is immediately abortable", async () => {
	const models = [
		{ id: "model-a", provider: "provider-a" },
		{ id: "model-b", provider: "provider-b" },
	];
	const controller = new AbortController();
	const clock = new PendingClock();
	let secondAttemptStarted = false;

	const responsePromise = execSingle(
		{ agent: "worker", task: "do work", bucket: "medium" },
		makeCtx(models),
		makeAgents(),
		() => undefined,
		{ depth: 0, trail: [] },
		noOpDetails,
		undefined,
		controller.signal,
		selCtx({
			alwaysParentModel: false,
			fallbackOnProviderFailure: true,
			bucketAssignments: { small: [], medium: assignedModels("model-a", "model-b"), frontier: [] },
			registryModels: models,
		}),
		"t-abort-wait",
		undefined,
		undefined,
		undefined,
		{
			clock,
			runAttempt: (resolved: any, _attemptId: string) => {
				const model = resolved.modelOverride;
				if (model === "model-a") {
					// Abort during the first backoff window.
					setTimeout(() => controller.abort(), 0);
					return Promise.resolve(
						syntheticResult({
							exitCode: 1,
							stopReason: "error",
							errorMessage: "timed out",
							stderr: "timed out",
							selectedModel: model,
							model,
							provider: "provider-a",
							retryable: true,
							replaySafety: "safe",
							failureClass: "timeout",
						}),
					);
				}
				secondAttemptStarted = true;
				return Promise.resolve(
					syntheticResult({
						exitCode: 0,
						stopReason: "completed",
						selectedModel: model,
						model,
						provider: "provider-b",
					}),
				);
			},
		},
	);

	const response = await responsePromise;
	assert.equal(secondAttemptStarted, false, "abort during backoff must prevent the retry attempt");
	assert.equal(response.details.results[0].retryCount, undefined);
});

test("retry wait publishes a running snapshot with advanced progressGeneration", async () => {
	const models = [
		{ id: "model-a", provider: "provider-a" },
		{ id: "model-b", provider: "provider-b" },
	];
	const clock = new PendingClock();
	const snapshots: SingleResult[] = [];

	const responsePromise = execSingle(
		{ agent: "worker", task: "do work", bucket: "medium" },
		makeCtx(models),
		makeAgents(),
		() => undefined,
		{ depth: 0, trail: [] },
		noOpDetails,
		(partial: any) => {
			const result = partial.details?.results?.[0];
			if (result) snapshots.push(result);
		},
		noSignal(),
		selCtx({
			alwaysParentModel: false,
			fallbackOnProviderFailure: true,
			bucketAssignments: { small: [], medium: assignedModels("model-a", "model-b"), frontier: [] },
			registryModels: models,
		}),
		"t-retry-wait-gen",
		undefined,
		undefined,
		undefined,
		{
			clock,
			runAttempt: (resolved: any, _attemptId: string) => {
				const model = resolved.modelOverride;
				if (model === "model-a") {
					return Promise.resolve(
						syntheticResult({
							exitCode: 1,
							stopReason: "error",
							errorMessage: "timed out",
							stderr: "timed out",
							selectedModel: model,
							model,
							provider: "provider-a",
							retryable: true,
							replaySafety: "safe",
							failureClass: "timeout",
							progressGeneration: 3,
						}),
					);
				}
				return Promise.resolve(
					syntheticResult({
						exitCode: 0,
						stopReason: "completed",
						selectedModel: model,
						model,
						provider: "provider-b",
					}),
				);
			},
		},
	);

	// Flush the synchronous retry-wait snapshot emission.
	for (let i = 0; i < 10; i++) await Promise.resolve();
	const waitSnapshot = snapshots.find((s) => s.activityPhase === "retry_wait");
	assert.ok(waitSnapshot, "retry_wait snapshot must be emitted via onUpdate");
	assert.equal(waitSnapshot.exitCode, -1, "retry_wait is an active child lifecycle, not a terminal attempt snapshot");
	assert.equal(waitSnapshot.progressGeneration, 4, "progressGeneration must advance for retry_wait");
	assert.ok(waitSnapshot.lastProgressAt != null, "lastProgressAt must be set");
	assert.equal(
		resolvePhaseInactivityMs(noOpDetails("single", [waitSnapshot])),
		PHASE_INACTIVITY_MS.retry_wait,
		"outer settlement must use the retry_wait phase budget",
	);

	await clock.advance(1_000_000);
	const response = await responsePromise;
	assert.equal(response.isError, undefined);
});

// ---------------------------------------------------------------------------
// Provider-aware failover and safety
// ---------------------------------------------------------------------------

test("provider-aware failover excludes every configured model of the failed provider", async () => {
	const models = [
		{ id: "model-a", provider: "provider-x" },
		{ id: "model-b", provider: "provider-x" },
		{ id: "model-c", provider: "provider-y" },
	];
	const attempts: string[] = [];
	const clock = new ImmediateClock();
	const response: any = await execSingle(
		{ agent: "worker", task: "do work", bucket: "medium" },
		makeCtx(models),
		makeAgents(),
		() => undefined,
		{ depth: 0, trail: [] },
		noOpDetails,
		undefined,
		noSignal(),
		selCtx({
			alwaysParentModel: false,
			fallbackOnProviderFailure: true,
			bucketAssignments: { small: [], medium: assignedModels("model-a", "model-b", "model-c"), frontier: [] },
			registryModels: models,
		}),
		"t-same-provider",
		undefined,
		undefined,
		undefined,
		{
			clock,
			runAttempt: (resolved: any, _attemptId: string) => {
				attempts.push(resolved.modelOverride);
				return Promise.resolve(
					syntheticResult({
						exitCode: 1,
						stopReason: "error",
						selectedModel: resolved.modelOverride,
						model: resolved.modelOverride,
						provider: resolved.modelOverride === "model-c" ? "provider-y" : "provider-x",
						retryable: true,
						replaySafety: "safe",
						failureClass: "timeout",
					}),
				);
			},
		},
	);

	assert.equal(response.isError, true);
	assert.deepEqual(attempts, ["model-a", "model-c"], "model-b must not be retried because it belongs to the failed provider; model-c (different provider) is still eligible");
	assert.ok(!attempts.includes("model-b"), "model-b belongs to the failed provider and must never be attempted");
	assert.equal(response.details.results[0].retryCount, 1);
});

test("provider-aware failover preserves a qualified duplicate on another provider", async () => {
	const models = [
		{ id: "gpt-5.4", provider: "github-copilot" },
		{ id: "gpt-5.4", provider: "openai-codex" },
	];
	const attempts: string[] = [];
	const response: any = await execSingle(
		{ agent: "worker", task: "do work", bucket: "medium" },
		makeCtx(models),
		makeAgents(),
		() => undefined,
		{ depth: 0, trail: [] },
		noOpDetails,
		undefined,
		noSignal(),
		selCtx({
			alwaysParentModel: false,
			fallbackOnProviderFailure: true,
			bucketAssignments: {
				small: [],
				medium: assignedModels("github-copilot/gpt-5.4", "openai-codex/gpt-5.4"),
				frontier: [],
			},
			allowedModelIds: new Set([
				"github-copilot/gpt-5.4",
				"openai-codex/gpt-5.4",
				"gpt-5.4",
			]),
			registryModels: models,
		}),
		"t-qualified-duplicate",
		undefined,
		undefined,
		undefined,
		{
			clock: new ImmediateClock(),
			runAttempt: (resolved: any) => {
				const spec = resolved.modelOverride as string;
				attempts.push(spec);
				const provider = spec.slice(0, spec.indexOf("/"));
				const first = attempts.length === 1;
				return Promise.resolve(syntheticResult({
					exitCode: first ? 1 : 0,
					stopReason: first ? "error" : "completed",
					selectedModel: spec,
					model: "gpt-5.4",
					provider,
					retryable: first,
					replaySafety: "safe",
					failureClass: first ? "timeout" : undefined,
				}));
			},
		},
	);

	assert.equal(response.isError, undefined);
	assert.equal(attempts.length, 2);
	assert.deepEqual(new Set(attempts), new Set([
		"github-copilot/gpt-5.4",
		"openai-codex/gpt-5.4",
	]));
	assert.equal(response.details.results[0].model, "gpt-5.4");
});

test("auth failures are never retried", async () => {
	const models = [
		{ id: "model-a", provider: "provider-a" },
		{ id: "model-b", provider: "provider-b" },
	];
	const attempts: string[] = [];
	const clock = new ImmediateClock();
	const response: any = await execSingle(
		{ agent: "worker", task: "do work", bucket: "medium" },
		makeCtx(models),
		makeAgents(),
		() => undefined,
		{ depth: 0, trail: [] },
		noOpDetails,
		undefined,
		noSignal(),
		selCtx({
			alwaysParentModel: false,
			fallbackOnProviderFailure: true,
			bucketAssignments: { small: [], medium: assignedModels("model-a", "model-b"), frontier: [] },
			registryModels: models,
		}),
		"t-auth",
		undefined,
		undefined,
		undefined,
		{
			clock,
			runAttempt: (resolved: any, _attemptId: string) => {
				attempts.push(resolved.modelOverride);
				return Promise.resolve(
					syntheticResult({
						exitCode: 1,
						stopReason: "error",
						selectedModel: resolved.modelOverride,
						model: resolved.modelOverride,
						provider: resolved.modelOverride === "model-a" ? "provider-a" : "provider-b",
						retryable: false,
						replaySafety: "safe",
						failureClass: "auth",
					}),
				);
			},
		},
	);

	assert.equal(response.isError, true);
	assert.deepEqual(attempts, ["model-a"]);
	assert.equal(response.details.results[0].retryCount, undefined);
});

test("partial output prevents retry", async () => {
	const models = [
		{ id: "model-a", provider: "provider-a" },
		{ id: "model-b", provider: "provider-b" },
	];
	const attempts: string[] = [];
	const clock = new ImmediateClock();
	const response: any = await execSingle(
		{ agent: "worker", task: "do work", bucket: "medium" },
		makeCtx(models),
		makeAgents(),
		() => undefined,
		{ depth: 0, trail: [] },
		noOpDetails,
		undefined,
		noSignal(),
		selCtx({
			alwaysParentModel: false,
			fallbackOnProviderFailure: true,
			bucketAssignments: { small: [], medium: assignedModels("model-a", "model-b"), frontier: [] },
			registryModels: models,
		}),
		"t-partial",
		undefined,
		undefined,
		undefined,
		{
			clock,
			runAttempt: (resolved: any, _attemptId: string) => {
				attempts.push(resolved.modelOverride);
				return Promise.resolve(
					syntheticResult({
						exitCode: 1,
						stopReason: "error",
						selectedModel: resolved.modelOverride,
						model: resolved.modelOverride,
						provider: resolved.modelOverride === "model-a" ? "provider-a" : "provider-b",
						retryable: true,
						replaySafety: "partial_output",
						failureClass: "timeout",
					}),
				);
			},
		},
	);

	assert.equal(response.isError, true);
	assert.deepEqual(attempts, ["model-a"]);
});

// ---------------------------------------------------------------------------
// Tree budget
// ---------------------------------------------------------------------------

test("shared tree budget is charged per actual dispatched attempt including retries", async () => {
	const models = [
		{ id: "model-a", provider: "provider-a" },
		{ id: "model-b", provider: "provider-b" },
	];
	const budget = { sessions: 0 };
	const clock = new ImmediateClock();
	const response: any = await execSingle(
		{ agent: "worker", task: "do work", bucket: "medium" },
		makeCtx(models),
		makeAgents(),
		() => undefined,
		{ depth: 0, trail: [], budget },
		noOpDetails,
		undefined,
		noSignal(),
		selCtx({
			alwaysParentModel: false,
			fallbackOnProviderFailure: true,
			bucketAssignments: { small: [], medium: assignedModels("model-a", "model-b"), frontier: [] },
			registryModels: models,
		}),
		"t-budget",
		undefined,
		undefined,
		undefined,
		{
			clock,
			runAttempt: (resolved: any, _attemptId: string) => {
				const model = resolved.modelOverride;
				if (model === "model-a") {
					return Promise.resolve(
						syntheticResult({
							exitCode: 1,
							stopReason: "error",
							selectedModel: model,
							model,
							provider: "provider-a",
							retryable: true,
							replaySafety: "safe",
							failureClass: "timeout",
						}),
					);
				}
				return Promise.resolve(
					syntheticResult({
						exitCode: 0,
						stopReason: "completed",
						selectedModel: model,
						model,
						provider: "provider-b",
					}),
				);
			},
		},
	);

	assert.equal(response.isError, undefined);
	assert.equal(budget.sessions, 2, "tree budget must be charged for both attempts");
});

test("tree budget exhaustion stops further attempts without synthetic undispatched analytics", async () => {
	const models = [
		{ id: "model-a", provider: "provider-a" },
		{ id: "model-b", provider: "provider-b" },
	];
	const budget = { sessions: 9 }; // one slot below default limit of 10
	const clock = new ImmediateClock();
	const response: any = await execSingle(
		{ agent: "worker", task: "do work", bucket: "medium" },
		makeCtx(models),
		makeAgents(),
		() => undefined,
		{ depth: 0, trail: [], budget },
		noOpDetails,
		undefined,
		noSignal(),
		selCtx({
			alwaysParentModel: false,
			fallbackOnProviderFailure: true,
			bucketAssignments: { small: [], medium: assignedModels("model-a", "model-b"), frontier: [] },
			registryModels: models,
		}),
		"t-budget-exhaust",
		undefined,
		undefined,
		undefined,
		{
			clock,
			runAttempt: (resolved: any, _attemptId: string) => {
				const model = resolved.modelOverride;
				return Promise.resolve(
					syntheticResult({
						exitCode: 1,
						stopReason: "error",
						selectedModel: model,
						model,
						provider: model === "model-a" ? "provider-a" : "provider-b",
						retryable: true,
						replaySafety: "safe",
						failureClass: "timeout",
					}),
				);
			},
		},
	);

	assert.equal(response.isError, true);
	assert.equal(budget.sessions, 10, "the undispatched blocked retry must not consume tree budget");
	const records = response.details.results[0].attemptRecords;
	assert.equal(records?.length, 1, "only the dispatched first attempt is recorded; no synthetic undispatched record");
	assert.equal(records?.[0]?.outcome, "failure");
	assert.equal(response.details.results[0].retryCount, undefined, "no retry was actually dispatched");
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

test("per-attempt analytics records are bounded and include attempt identity", async () => {
	const models = [
		{ id: "model-a", provider: "provider-a" },
		{ id: "model-b", provider: "provider-b" },
		{ id: "model-c", provider: "provider-c" },
	];
	const clock = new ImmediateClock();
	const response: any = await execSingle(
		{ agent: "worker", task: "do work", bucket: "medium" },
		makeCtx(models),
		makeAgents(),
		() => undefined,
		{ depth: 0, trail: [] },
		noOpDetails,
		undefined,
		noSignal(),
		selCtx({
			alwaysParentModel: false,
			fallbackOnProviderFailure: true,
			bucketAssignments: { small: [], medium: assignedModels("model-a", "model-b", "model-c"), frontier: [] },
			registryModels: models,
		}),
		"t-analytics",
		undefined,
		undefined,
		undefined,
		{
			clock,
			runAttempt: (resolved: any, attemptId: string) => {
				const model = resolved.modelOverride;
				const idx = ["model-a", "model-b", "model-c"].indexOf(model);
				return Promise.resolve(
					syntheticResult({
						exitCode: idx === 2 ? 0 : 1,
						stopReason: idx === 2 ? "completed" : "error",
						selectedModel: model,
						model,
						provider: model === "model-a" ? "provider-a" : model === "model-b" ? "provider-b" : "provider-c",
						retryable: true,
						replaySafety: "safe",
						failureClass: idx === 2 ? undefined : "timeout",
						attemptId,
					}),
				);
			},
		},
	);

	assert.equal(response.isError, undefined);
	const records = response.details.results[0].attemptRecords;
	assert.equal(records?.length, 3);
	assert.ok(records?.every((r: any, i: number) => i === 0 || r.attemptId !== records[i - 1].attemptId), "attempt ids are unique");
	assert.equal(records?.[0]?.model, "model-a");
	assert.equal(records?.[0]?.provider, "provider-a");
	assert.equal(records?.[0]?.outcome, "failure");
	assert.equal(records?.[0]?.failureClass, "timeout");
	assert.equal(records?.[2]?.model, "model-c");
	assert.equal(records?.[2]?.outcome, "success");
	assert.ok(records?.[0]?.startedAt != null && records?.[0]?.completedAt != null);
	assert.ok(records?.[0]?.attemptSettlementOutcome != null);
});

test("attempt records satisfy the host-analytics extraction contract", async () => {
	// The host extraction (getTerminalSubagentAttemptSamplesFromToolCall) reads
	// result.details.results[].attemptRecords and maps each record to a
	// SubagentAttemptSample with reported/measured/estimated/unknown provenance.
	// This test pins the producer side of that contract so a field rename or a
	// missing field is caught in the subagent package, not only in the host.
	const models = [
		{ id: "model-a", provider: "provider-a" },
		{ id: "model-b", provider: "provider-b" },
	];
	const clock = new ImmediateClock();
	const response: any = await execSingle(
		{ agent: "worker", task: "do work", bucket: "medium" },
		makeCtx(models),
		makeAgents(),
		() => undefined,
		{ depth: 0, trail: [] },
		noOpDetails,
		undefined,
		noSignal(),
		selCtx({
			alwaysParentModel: false,
			fallbackOnProviderFailure: true,
			bucketAssignments: { small: [], medium: assignedModels("model-a", "model-b"), frontier: [] },
			registryModels: models,
		}),
		"t-extraction-contract",
		undefined,
		undefined,
		undefined,
		{
			clock,
			runAttempt: (resolved: any, _attemptId: string) => {
				const model = resolved.modelOverride;
				if (model === "model-a") {
					return Promise.resolve(
						syntheticResult({
							exitCode: 1,
							stopReason: "error",
							errorMessage: "timed out",
							stderr: "timed out",
							selectedModel: model,
							model,
							provider: "provider-a",
							retryable: true,
							replaySafety: "safe",
							failureClass: "timeout",
						}),
					);
				}
				return Promise.resolve(
					syntheticResult({
						exitCode: 0,
						stopReason: "completed",
						selectedModel: model,
						model,
						provider: "provider-b",
					}),
				);
			},
		},
	);

	assert.equal(response.isError, undefined);
	const records = response.details.results[0].attemptRecords;
	assert.ok(Array.isArray(records), "attemptRecords must be an array for host extraction");
	assert.equal(records.length, 2);
	// First attempt: zero backoff (reported immediate), terminal failure.
	assert.equal(records[0].outcome, "failure");
	assert.equal(records[0].backoffMs, 0, "first attempt reports zero backoff");
	assert.equal(records[0].replaySafety, "safe", "replaySafety is present for host aggregation");
	assert.equal(records[0].cleanupOutcome, undefined, "cleanupOutcome is unset — host treats as unknown");
	assert.equal(records[0].phaseDurationsMs, undefined, "injected results without runner evidence remain explicitly unavailable");
	assert.ok(typeof records[0].attemptId === "string" && records[0].attemptId.length > 0);
	assert.ok(records[0].startedAt != null && records[0].completedAt != null, "timestamps present for measured duration");
	assert.ok(records[0].attemptSettlementOutcome != null, "attempt settlement outcome is present without claiming parent settlement provenance");
	// Retry attempt: non-zero backoff, terminal success, cleanup unknown.
	assert.equal(records[1].outcome, "success");
	assert.equal(records[1].backoffMs, 1_000, "retry attempt reports the backoff waited before it");
	assert.equal(records[1].cleanupOutcome, undefined, "cleanupOutcome is unset — host treats as unknown");
});

// ---------------------------------------------------------------------------
// REM-03 regression tests
// ---------------------------------------------------------------------------

test("abortableDelay cancels the underlying timer when aborted", async () => {
	const controller = new AbortController();
	const clock = new PendingClock();
	const delay = abortableDelay(1_000_000, controller.signal, clock);
	assert.equal(clock["timers"].length, 1, "a timer is scheduled");
	controller.abort();
	await assert.rejects(() => delay, /Retry delay aborted/);
	assert.equal(clock["timers"].length, 0, "abort must cancel the timer so it cannot keep the event loop alive");
});

test("provider exclusion prefers result.provider over model-id registry lookup", async () => {
	const models = [
		{ id: "shared-id", provider: "provider-a" },
		{ id: "model-b", provider: "provider-b" },
	];
	const attempts: string[] = [];
	const clock = new ImmediateClock();
	const response: any = await execSingle(
		{ agent: "worker", task: "do work", bucket: "medium" },
		makeCtx(models),
		makeAgents(),
		() => undefined,
		{ depth: 0, trail: [] },
		noOpDetails,
		undefined,
		noSignal(),
		selCtx({
			alwaysParentModel: false,
			fallbackOnProviderFailure: true,
			bucketAssignments: { small: [], medium: assignedModels("shared-id", "model-b"), frontier: [] },
			registryModels: models,
		}),
		"t-provider-preference",
		undefined,
		undefined,
		undefined,
		{
			clock,
			runAttempt: (resolved: any, _attemptId: string) => {
				const model = resolved.modelOverride;
				attempts.push(model);
				// The result stamps a different provider than the registry would infer
				// from the model id, so failover must use result.provider.
				return Promise.resolve(
					syntheticResult({
						exitCode: 1,
						stopReason: "error",
						selectedModel: model,
						model,
						provider: model === "shared-id" ? "provider-x" : "provider-b",
						retryable: true,
						replaySafety: "safe",
						failureClass: "timeout",
					}),
				);
			},
		},
	);

	assert.equal(response.isError, true);
	assert.deepEqual(attempts, ["shared-id", "model-b"], "retry uses a model from a different provider");
});
