import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolContext } from "./tool-context.js";
import type { AgentConfig } from "../agents.js";
import { getFinalOutput } from "../formatting.js";
import {
	runSingleAgent,
	subagentRuntime,
	consumeTreeSlot,
	getMaxTreeSessions,
	nextAttemptIdentity,
	type SubagentRuntimeContext,
} from "../runner.js";
import type { Static } from "@mariozechner/pi-ai";
import { SubagentParams } from "../schema.js";
import {
	MAX_MODEL_RETRIES,
	type OnUpdateCallback,
	type SingleResult,
	type SubagentDetails,
	type SubagentResult,
	type SubagentAttemptRecord,
	type UsageStats,
} from "../types.js";
import {
	resolveModel,
	attachSelectionMetadata,
	isModelFailure,
	checkTrailLoop,
	type SelectionContext,
} from "./selection.js";
import type { ParentBridge } from "./parent-extension-ui-bridge-proxy.js";
import type { ThinkingLevel } from "../bucket-selector.js";
import { compactSingleResult } from "./result-compaction.js";
import { textContent } from "./text-content.js";
import { buildParentUserContext } from "./user-context.js";
import {
	readRetryPolicy,
	parseRetryAfterMs,
	clampRetryAfter,
	computeBackoffMs,
	abortableDelay,
	providerForModel,
	excludeProviderModels,
	buildAttemptRecord,
	zeroUsage,
	type RetryClock,
	realRetryClock,
} from "./retry.js";

export type SingleSubagentParams = Static<typeof SubagentParams>;
type MakeDetails = (results: SingleResult[]) => SubagentDetails;
type SingleResultEnvelope = SubagentResult;

function failureMessage(result: SingleResult): string {
	return result.errorMessage || result.stderr || result.finalOutput || getFinalOutput(result.messages) || "(no output)";
}

function isResultError(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function addUsage(target: UsageStats, source: UsageStats): void {
	target.input += source.input || 0;
	target.output += source.output || 0;
	target.cacheRead += source.cacheRead || 0;
	target.cacheWrite += source.cacheWrite || 0;
	target.cost += source.cost || 0;
	// Context occupancy is a latest-turn gauge, not a billable cumulative stream.
	if (source.contextTokens > 0) target.contextTokens = source.contextTokens;
	target.turns += source.turns || 0;
}

interface RunWithModelRetryArgs {
	agent: AgentConfig;
	excludeModels: Set<string>;
	bucket: string | undefined;
	thinkingLevel: string | undefined;
	activeModelId: string;
	selectionCtx: SelectionContext;
	childDepth: number;
	buildRuntime: () => SubagentRuntimeContext;
	signal: AbortSignal | undefined;
	toolCallId: string;
	task: string;
	clock: RetryClock;
	makeDetails: MakeDetails;
	onUpdate?: OnUpdateCallback;
	runAttempt: (resolved: Awaited<ReturnType<typeof resolveModel>>, attemptId: string) => Promise<SingleResult>;
}



async function runWithModelRetry(args: RunWithModelRetryArgs): Promise<SingleResult> {
	let result: SingleResult | undefined;
	let retryCount = 0;
	let lastFailedModel: string | undefined;
	const attemptRecords: SubagentAttemptRecord[] = [];
	const excludeModels = new Set<string>(args.excludeModels);
	const policy = readRetryPolicy();
	const clock = args.clock;
	const cumulativeUsage: UsageStats = zeroUsage();
	let nextBackoffMs = 0;

	for (let attempt = 0; attempt <= MAX_MODEL_RETRIES; attempt++) {
		if (attempt > 0) retryCount++; // tentative count; undone if no eligible model

		const runtimeCtx = args.buildRuntime();
		// Preserve the immediate tree-limit failure at entry without charging an
		// undispatched attempt. Retries perform the same check after model
		// eligibility is known.
		if (attempt === 0 && runtimeCtx.budget && runtimeCtx.budget.sessions >= getMaxTreeSessions()) {
			throw new Error(`Sub-agent tree session limit reached (max ${getMaxTreeSessions()} sessions across the nested tree).`);
		}
		const resolved = await resolveModel(
			args.agent,
			args.selectionCtx,
			args.activeModelId,
			args.bucket,
			args.thinkingLevel as ThinkingLevel | undefined,
			excludeModels,
			args.childDepth,
		);

		// Provider failover is stricter than normal bucket exhaustion: it may only
		// dispatch another configured model from the same bucket, and must not
		// retry the same provider that just failed. The first attempt may fall back
		// to the caller's active model when the bucket is empty, but retries are
		// never allowed to escape the bucket.
		const hasEligibleModel = resolved.modelOverride && !excludeModels.has(resolved.modelOverride);
		const isFallback = resolved.selection?.fallback === true;
		if (!hasEligibleModel || (isFallback && attempt > 0)) {
			// No eligible model remains; preserve the last failure (if any) and stop.
			retryCount--;
			break;
		}

		// Charge only an attempt that is about to dispatch. A missing retry target
		// therefore consumes neither tree budget nor attempt analytics.
		if (runtimeCtx.budget && runtimeCtx.budget.sessions >= getMaxTreeSessions()) {
			if (attempt === 0) {
				throw new Error(`Sub-agent tree session limit reached (max ${getMaxTreeSessions()} sessions across the nested tree).`);
			}
			retryCount--;
			break;
		}
		const treeLimitError = consumeTreeSlot(runtimeCtx.budget);
		if (treeLimitError) {
			if (attempt === 0) throw new Error(treeLimitError);
			retryCount--;
			break;
		}

		const attemptId = nextAttemptIdentity(args.agent.name, args.toolCallId);
		result = await subagentRuntime.run(runtimeCtx, () => args.runAttempt(resolved, attemptId));
		attachSelectionMetadata(result, resolved);
		result.attemptId = attemptId;
		attemptRecords.push(buildAttemptRecord(result, nextBackoffMs));
		addUsage(cumulativeUsage, result.usage);

		if (args.signal?.aborted) break;
		const failure = args.selectionCtx.fallbackOnProviderFailure !== false
			&& resolved.selection?.fallback !== true
			&& isModelFailure(result, resolved.modelOverride, !!args.selectionCtx.bucketAssignments);
		if (!failure || attempt >= MAX_MODEL_RETRIES) break;

		// REM-03: provider-aware failover excludes every configured model belonging
		// to the failed provider so fallback cannot retry that provider. Prefer the
		// provider stamped on the result (the actual runtime provider) over an
		// ambiguous model-id-to-provider registry lookup. If the result provider is
		// unmapped, fall back to excluding the failed model id so the same target
		// is never retried.
		const failedProvider = result.provider ?? providerForModel(resolved.modelOverride, args.selectionCtx.registryModels);
		if (failedProvider) {
			excludeProviderModels(failedProvider, args.selectionCtx.registryModels, excludeModels);
		}
		excludeModels.add(resolved.modelOverride);
		lastFailedModel = resolved.modelOverride;

		// REM-03: use a structured Retry-After hint when present, otherwise bounded
		// exponential backoff. The wait is immediately abortable.
		const retryAfter = result.retryAfterMs !== undefined ? clampRetryAfter(result.retryAfterMs, policy) : undefined;
		const baseBackoff = computeBackoffMs(retryCount, policy);
		const backoffMs = retryAfter ?? baseBackoff;
		result.retryAfterMs = backoffMs;

		if (backoffMs > 0) {
			result.activityPhase = "retry_wait";
			result.activityDetail = `waiting ${backoffMs}ms to retry`;
			result.activitySince = clock.now();
			result.lastProgressAt = clock.now();
			result.progressGeneration = (result.progressGeneration ?? 0) + 1;
			// The completed attempt remains terminal for analytics, but the child
			// dispatch is still active while it waits to retry. Publish that transient
			// lifecycle as running so the outer phase resolver applies retry_wait's
			// bounded inactivity lease instead of its generic fallback.
			const retryWaitSnapshot: SingleResult = {
				...result,
				exitCode: -1,
				stopReason: undefined,
				completedAt: undefined,
			};
			args.onUpdate?.({
				content: [textContent(result.finalOutput || result.streamingText || result.streamingReasoning || result.activityDetail || "(running...)")],
				details: args.makeDetails([retryWaitSnapshot]),
			});
		}
		try {
			await abortableDelay(backoffMs, args.signal, clock);
		} catch {
			// Parent aborted during the wait: stop retrying and use the last result.
			break;
		}

		nextBackoffMs = backoffMs;
	}

	if (!result) throw new Error("Subagent did not produce a result.");
	if (retryCount > 0) {
		result.failedModel = lastFailedModel;
		result.retryCount = retryCount;
	}
	// REM-03: the returned result must be billable for every dispatched attempt,
	// including failed retries that were discarded before the final successful one.
	return { ...result, usage: cumulativeUsage, attemptRecords };
}

/** Execute exactly one delegated task. Parallelism is provided exclusively by
 * pi's native sibling tool-call execution; dependent work uses later turns. */
export async function executeSingleTask(args: {
	params: SingleSubagentParams;
	ctx: ToolContext;
	agents: AgentConfig[];
	runtimeCtx: SubagentRuntimeContext;
	makeDetails: MakeDetails;
	onUpdate: OnUpdateCallback;
	signal: AbortSignal | undefined;
	selectionCtx: SelectionContext;
	toolCallId: string;
	parentUiBridge: ParentBridge | undefined;
	parentSessionId: string | undefined;
	allToolNames: string[] | undefined;
	/** Internal test seam for retry/backoff/analytics. */
	_internal?: {
		clock?: RetryClock;
		runAttempt?: (resolved: Awaited<ReturnType<typeof resolveModel>>, attemptId: string) => Promise<SingleResult>;
	};
}): Promise<SingleResultEnvelope> {
	const { params, ctx, agents, runtimeCtx, makeDetails, onUpdate, signal, selectionCtx, _internal } = args;
	if (checkTrailLoop(params.agent, runtimeCtx.trail)) {
		throw new Error(`Trail loop detected: agent "${params.agent}" already appeared twice in ancestor chain.`);
	}

	const agent = agents.find((candidate) => candidate.name === params.agent);
	if (!agent) throw new Error(`Unknown subagent: ${params.agent}`);

	const injectedRunAttempt = _internal?.runAttempt;
	// Snapshot optional parent context once so provider retries receive the same
	// lean handoff even if the parent transcript advances while an attempt runs.
	const parentUserContext = buildParentUserContext(params.userContext, ctx.sessionManager);
	const result = await runWithModelRetry({
		agent,
		excludeModels: new Set<string>(),
		bucket: params.bucket,
		thinkingLevel: params.thinkingLevel,
		activeModelId: ctx.model?.id ?? "",
		selectionCtx,
		childDepth: runtimeCtx.depth + 1,
		signal,
		toolCallId: args.toolCallId,
		task: params.task,
		clock: _internal?.clock ?? realRetryClock,
		makeDetails,
		onUpdate,
		buildRuntime: () => ({
			depth: runtimeCtx.depth + 1,
			trail: [...runtimeCtx.trail, params.agent],
			canSpawn: agent.canSpawn,
			budget: runtimeCtx.budget,
			rootSessionPath: runtimeCtx.rootSessionPath ?? ctx.sessionManager?.getSessionFile?.() ?? undefined,
			keptSkills: runtimeCtx.keptSkills,
			processPermitScope: runtimeCtx.processPermitScope,
		}),
		runAttempt: injectedRunAttempt
			? (resolved, attemptId) => injectedRunAttempt(resolved, attemptId)
			: (resolved, attemptId) => {
				const selection = resolved.selection ?? {
					modelId: resolved.modelOverride ?? ctx.model?.id ?? "",
					thinkingLevel: resolved.thinkingLevel,
					bucket: resolved.bucket ?? "medium",
					pool: [],
					fallback: true,
				};
				return runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					(results) => makeDetails(results),
					ctx.modelRegistry,
					ctx.model,
					selection,
					selectionCtx.disabledProviders,
					args.toolCallId,
					args.parentUiBridge,
					args.parentSessionId,
					args.allToolNames,
					{ clock: _internal?.clock ?? realRetryClock },
					attemptId,
					parentUserContext,
				);
			},
	});

	const compact = compactSingleResult(result);
	const details = makeDetails([compact]);
	if (isResultError(result)) {
		return {
			content: [textContent(`Agent ${result.stopReason || "failed"}: ${failureMessage(compact)}`)],
			details,
			isError: true,
		};
	}
	return {
		content: [textContent(compact.finalOutput || "(no output)")],
		details,
	};
}
