/**
 * Mode-specific execution functions for subagent tool.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolContext } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "../agents.js";
import { getFinalOutput, previewText } from "../formatting.js";
import {
	mapWithConcurrencyLimit,
	runSingleAgent,
	subagentRuntime,
	consumeTreeSlot,
	type SubagentRuntimeContext,
} from "../runner.js";
import { SubagentParams } from "../schema.js";
import {
	MAX_MODEL_RETRIES,
	type OnUpdateCallback,
	type SingleResult,
	type SubagentDetails,
	type UsageStats,
} from "../types.js";
import { getMaxConcurrency, getMaxParallelTasks } from "./concurrency-limit.js";
// Shared model-selection helpers live in ./selection.ts (NOT ./execute.ts) —
// importing them from there breaks the execute↔modes circular import that
// crashed parallel subagent dispatch with `Cannot read properties of
// undefined (reading 'checkTrailLoop')`.
import { resolveModel, attachSelectionMetadata, isModelFailure, checkTrailLoop, type SelectionContext } from "./selection.js";
import type { ParentBridge } from "./parent-extension-ui-bridge-proxy.js";
import type { ThinkingLevel } from "../bucket-selector.js";

type Mode = "single" | "parallel" | "chain";
type MakeDetails = (mode: Mode, results: SingleResult[]) => SubagentDetails;
type ModeResult = AgentToolResult<SubagentDetails>;

const TRAIL_LOOP_MESSAGE = (agent: string) =>
	`Trail loop detected: agent "${agent}" already appeared twice in ancestor chain.`;

/** Empty `UsageStats` used to seed in-flight and error placeholders. */
function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** Placeholder result representing a task that has not yet finished. */
function createPendingResult(agent: string, task: string, step?: number): SingleResult {
	return {
		agent,
		agentSource: "unknown",
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		step,
	};
}

/** Result representing a single agent that failed without actually running. */
function createErrorResult(agent: string, task: string, errorMessage: string, step?: number): SingleResult {
	return {
		agent,
		agentSource: "unknown",
		task,
		exitCode: 1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		errorMessage,
		step,
	};
}

/** Placeholder result for a task that was never started because the parent
 *  aborted while it was queued behind `mapWithConcurrencyLimit`. This is the
 *  "scout :2" case: the worker never entered `runSingleAgent`, so there's no
 *  `onAbort` handler, no `child.abort.invoked` log, and no `session.abort()`
 *  call. Returning this placeholder from the worker slot lets
 *  `Promise.all(workers)` settle promptly when the parent aborts — without it,
 *  the queued task would start `runSingleAgent` with an already-aborted signal,
 *  hitting the `parentAlreadyAborted` branch where `createSession` and
 *  `runPrompt()` run without `raceAbort` and can hang a dead proxy
 *  indefinitely (30-min settlement timer is the only escape). */
function createAbortedPlaceholderResult(agent: string, task: string, step?: number): SingleResult {
	return {
		agent,
		agentSource: "unknown",
		task,
		exitCode: 1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		errorMessage: "Subagent was skipped (parent aborted while queued)",
		step,
	};
}

/** Pick the most informative message we have for a failed result. */
function failureMessage(result: SingleResult): string {
	return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
}

/** Whether a finished result counts as an error for downstream reporting. */
function isResultError(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

interface RunWithModelRetryArgs {
	agent: AgentConfig;
	excludeModels: Set<string>;
	bucket: string | undefined;
	thinkingLevel: string | undefined;
	activeModelId: string;
	selectionCtx: SelectionContext;
	/** Depth of the subagent being spawned (parent depth + 1). Drives the
	 *  nested-bucket cap in resolveModel (applied when ≥ 1). */
	childDepth: number;
	/** Build a fresh runtime context for the attempt. */
	buildRuntime: () => SubagentRuntimeContext;
	/** Execute one attempt with the resolved model; returns the raw result. */
	runAttempt: (resolved: ReturnType<typeof resolveModel>) => Promise<SingleResult>;
}

interface ModelRetryOutcome {
	result: SingleResult;
}

/**
 * Run a subagent call with model-failure retry. If the model selection produces
 * a failure and a fallback is available, retry with the next model up to
 * `MAX_MODEL_RETRIES` times. Returns the final result.
 */
async function runWithModelRetry(args: RunWithModelRetryArgs): Promise<ModelRetryOutcome> {
	let result: SingleResult | undefined;

	for (let attempt = 0; attempt <= MAX_MODEL_RETRIES; attempt++) {
		const resolved = await resolveModel(
			args.agent,
			args.selectionCtx,
			args.activeModelId,
			args.bucket,
			args.thinkingLevel as ThinkingLevel | undefined,
			args.excludeModels,
			args.childDepth,
		);
		result = await subagentRuntime.run(args.buildRuntime(), () => args.runAttempt(resolved));
		attachSelectionMetadata(result, resolved);

		const failure = isModelFailure(result, resolved.modelOverride, !!args.selectionCtx.bucketAssignments);
		if (!failure || attempt >= MAX_MODEL_RETRIES) break;

		args.excludeModels.add(resolved.modelOverride!);
		result.failedModel = resolved.modelOverride;
		result.retryCount = attempt + 1;

		const next = await resolveModel(
			args.agent,
			args.selectionCtx,
			args.activeModelId,
			args.bucket,
			args.thinkingLevel as ThinkingLevel | undefined,
			args.excludeModels,
			args.childDepth,
		);
		if (!next.modelOverride || args.excludeModels.has(next.modelOverride)) break;
	}

	return { result: result! };
}

/** Handles single agent execution. */
export async function executeSingleMode(
	params: SubagentParams,
	ctx: ToolContext,
	agents: AgentConfig[],
	checkSessionLimit: () => string | undefined,
	runtimeCtx: SubagentRuntimeContext,
	makeDetails: MakeDetails,
	onUpdate: OnUpdateCallback,
	signal: AbortSignal,
	selectionCtx: SelectionContext,
	_toolCallId: string,
	parentUiBridge: ParentBridge | undefined,
	parentSessionId: string | undefined,
	allToolNames: string[] | undefined,
) {
	if (checkTrailLoop(params.agent!, runtimeCtx.trail)) {
		return {
			content: [
				{
					type: "text" as const,
					text: `Trail loop detected: agent "${params.agent}" already appeared twice in ancestor chain.`,
				},
			],
			details: makeDetails("single", []),
			isError: true,
		};
	}

	const treeLimitError = consumeTreeSlot(runtimeCtx.budget);
	if (treeLimitError) {
		return {
			content: [{ type: "text" as const, text: treeLimitError }],
			details: makeDetails("single", []),
			isError: true,
		};
	}

	const singleAgent = agents.find((a) => a.name === params.agent)!;
	const { result } = await runWithModelRetry({
		agent: singleAgent,
		excludeModels: new Set<string>(),
		bucket: params.bucket,
		thinkingLevel: params.thinkingLevel,
		activeModelId: ctx.model?.id ?? "",
		selectionCtx,
		childDepth: runtimeCtx.depth + 1,
		buildRuntime: () => ({
			depth: runtimeCtx.depth + 1,
			trail: [...runtimeCtx.trail, params.agent!],
			canSpawn: singleAgent.canSpawn,
			budget: runtimeCtx.budget,
		}),
		runAttempt: (resolved) => {
			const sel = resolved.selection ?? {
				modelId: resolved.modelOverride ?? ctx.model?.id ?? "",
				thinkingLevel: resolved.thinkingLevel,
				bucket: resolved.bucket ?? "medium",
				pool: [],
				fallback: true,
			};
			return runSingleAgent(
				ctx.cwd,
				agents,
				params.agent!,
				params.task!,
				params.cwd,
				undefined,
				signal,
				onUpdate,
				(res) => makeDetails("single", res),
				ctx.modelRegistry,
				ctx.model,
				sel,
				selectionCtx.disabledProviders,
				_toolCallId,
				parentUiBridge,
				parentSessionId,
				allToolNames,
			);
		},
	});

	if (isResultError(result)) {
		return {
			content: [
				{ type: "text" as const, text: `Agent ${result.stopReason || "failed"}: ${failureMessage(result)}` },
			],
			details: makeDetails("single", [result]),
			isError: true,
		};
	}
	return {
		content: [{ type: "text" as const, text: getFinalOutput(result.messages) || "(no output)" }],
		details: makeDetails("single", [result]),
	};
}

/** Handles parallel tasks array execution. */
export async function executeParallelMode(
	params: SubagentParams,
	ctx: ToolContext,
	agents: AgentConfig[],
	checkSessionLimit: () => string | undefined,
	runtimeCtx: SubagentRuntimeContext,
	makeDetails: MakeDetails,
	onUpdate: OnUpdateCallback,
	signal: AbortSignal,
	selectionCtx: SelectionContext,
	_toolCallId: string,
	parentUiBridge: ParentBridge | undefined,
	parentSessionId: string | undefined,
	allToolNames: string[] | undefined,
) {
	const tooMany = buildParallelTaskLimitError(params.tasks!.length, makeDetails);
	if (tooMany) return tooMany;

	const allResults = createPendingResultsForTasks(params.tasks!);
	const emitParallelUpdate = makeParallelUpdateEmitter(allResults, makeDetails, onUpdate);

	// Pass the parent abort signal to `mapWithConcurrencyLimit` so queued
	// workers (the "scout :2" case — still waiting for a free slot when the
	// parent aborts) skip their item instead of entering `runSingleAgent`
	// with an already-aborted signal. Without this, scout :2 would hit the
	// `parentAlreadyAborted` branch where `createSession` and `runPrompt()`
	// run without `raceAbort` — a hung SDK/dead proxy then dangles the worker
	// until the 30-min settlement timer fires. Skipped slots get an explicit
	// "skipped" result below so the final formatted output is complete.
	const results = await mapWithConcurrencyLimit(
		params.tasks!,
		getMaxConcurrency(),
		(t, index) =>
			runParallelTask(t, index, {
				ctx,
				agents,
				signal,
				selectionCtx,
				runtimeCtx,
				makeDetails,
				allResults,
				emitUpdate: emitParallelUpdate,
				checkSessionLimit,
				// Mirror the webview's SubagentCallContext: it uses `${id}:${index}` only
				// when multiple results render (results.length > 1). A single-task
				// parallel call renders as one block with the bare id, so stamp bare to
				// match — otherwise the inline ask_user prompt never finds its request.
				_toolCallId: params.tasks!.length > 1 ? `${_toolCallId}:${index}` : _toolCallId,
				parentUiBridge,
				parentSessionId,
				allToolNames,
			}),
		signal,
	);

	// Skipped slots (scout :2) are `undefined` from the `mapWithConcurrencyLimit`
	// signal-aborted placeholder. Replace them with an explicit aborted result so
	// `formatParallelResult` sees a full array and the user sees a clear message.
	for (let i = 0; i < results.length; i++) {
		if (results[i] === undefined) {
			const task = params.tasks![i];
			// Prefer the pending result already tracked in allResults (it has
			// the correct agent name + task), stamped with the abort message.
			results[i] = createAbortedPlaceholderResult(task.agent, task.task);
			allResults[i] = results[i];
		}
	}
	emitParallelUpdate();

	return formatParallelResult(results as SingleResult[], makeDetails);
}

interface ParallelTaskArgs {
	ctx: ToolContext;
	agents: AgentConfig[];
	signal: AbortSignal;
	selectionCtx: SelectionContext;
	runtimeCtx: SubagentRuntimeContext;
	makeDetails: MakeDetails;
	allResults: SingleResult[];
	emitUpdate: () => void;
	checkSessionLimit: () => string | undefined;
	_toolCallId: string;
	parentUiBridge: ParentBridge | undefined;
	parentSessionId: string | undefined;
	allToolNames: string[] | undefined;
}

async function runParallelTask(
	t: NonNullable<SubagentParams["tasks"]>[number],
	index: number,
	args: ParallelTaskArgs,
): Promise<SingleResult> {
	const { ctx, agents, signal, selectionCtx, runtimeCtx, makeDetails, allResults, emitUpdate, checkSessionLimit, _toolCallId, parentUiBridge, parentSessionId, allToolNames } =
		args;

	const sessionLimitError = checkSessionLimit();
	if (sessionLimitError) {
		const limitResult = createErrorResult(t.agent, t.task, sessionLimitError);
		allResults[index] = limitResult;
		emitUpdate();
		return limitResult;
	}

	const treeLimitError = consumeTreeSlot(runtimeCtx.budget);
	if (treeLimitError) {
		const limitResult = createErrorResult(t.agent, t.task, treeLimitError);
		allResults[index] = limitResult;
		emitUpdate();
		return limitResult;
	}

	if (checkTrailLoop(t.agent, runtimeCtx.trail)) {
		const loopResult = createErrorResult(t.agent, t.task, TRAIL_LOOP_MESSAGE(t.agent));
		allResults[index] = loopResult;
		emitUpdate();
		return loopResult;
	}

	const parallelAgent = agents.find((a) => a.name === t.agent)!;
	const { result } = await runWithModelRetry({
		agent: parallelAgent,
		excludeModels: new Set<string>(),
		bucket: t.bucket,
		thinkingLevel: t.thinkingLevel,
		activeModelId: ctx.model?.id ?? "",
		selectionCtx,
		childDepth: runtimeCtx.depth + 1,
		buildRuntime: () => ({
			depth: runtimeCtx.depth + 1,
			trail: [...runtimeCtx.trail, t.agent],
			canSpawn: parallelAgent.canSpawn,
			budget: runtimeCtx.budget,
		}),
		runAttempt: (resolved) => {
			const sel = resolved.selection ?? {
				modelId: resolved.modelOverride ?? ctx.model?.id ?? "",
				thinkingLevel: resolved.thinkingLevel,
				bucket: resolved.bucket ?? "medium",
				pool: [],
				fallback: true,
			};
			return runSingleAgent(
				ctx.cwd,
				agents,
				t.agent,
				t.task,
				t.cwd,
				undefined,
				signal,
				(partial) => {
					if (partial.details?.results[0]) {
						allResults[index] = partial.details.results[0];
						emitUpdate();
					}
				},
				(res) => makeDetails("parallel", res),
				ctx.modelRegistry,
				ctx.model,
				sel,
				selectionCtx.disabledProviders,
				_toolCallId,
				parentUiBridge,
				parentSessionId,
				allToolNames,
			);
		},
	});

	allResults[index] = result;
	emitUpdate();
	return result;
}

/** Build the standard "too many tasks" error response. */
function buildParallelTaskLimitError(count: number, makeDetails: MakeDetails): ModeResult | undefined {
	const max = getMaxParallelTasks();
	if (count <= max) return undefined;
	return {
		content: [
			{
				type: "text" as const,
				text: `Too many parallel tasks (${count}). Max is ${max}.`,
			},
		],
		details: makeDetails("parallel", []),
		isError: true,
	};
}

/** Seed the parallel results array with in-progress placeholders. */
function createPendingResultsForTasks(tasks: NonNullable<SubagentParams["tasks"]>): SingleResult[] {
	return tasks.map((t) => createPendingResult(t.agent, t.task));
}

/** Build an update emitter that reports running/done counts for the parallel UI. */
function makeParallelUpdateEmitter(
	allResults: SingleResult[],
	makeDetails: MakeDetails,
	onUpdate: OnUpdateCallback | undefined,
): () => void {
	return () => {
		if (!onUpdate) return;
		const running = allResults.filter((r) => r.exitCode === -1).length;
		const done = allResults.filter((r) => r.exitCode !== -1).length;
		onUpdate({
			content: [
				{
					type: "text" as const,
					text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
				},
			],
			details: makeDetails("parallel", [...allResults]),
		});
	};
}

/** Compose the final text and structured response for a completed parallel run. */
export function formatParallelResult(results: SingleResult[], makeDetails: MakeDetails): ModeResult {
	const successCount = results.filter((r) => r.exitCode === 0).length;
	const hasFailures = successCount !== results.length;
	const summaries = results.map(formatParallelSummaryLine);
	return {
		content: [
			{
				type: "text" as const,
				text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
			},
		],
		details: makeDetails("parallel", results),
		isError: hasFailures,
	};
}

/** Build the one-line summary shown for each parallel task. */
function formatParallelSummaryLine(result: SingleResult): string {
	const text = result.exitCode === 0 ? getFinalOutput(result.messages) : failureMessage(result);
	const preview = previewText(text) || "(no output)";
	return `[${result.agent}] ${result.exitCode === 0 ? "completed" : "failed"}: ${preview}`;
}

/** Handles chain execution with {previous} placeholder substitution. */
export async function executeChainMode(
	params: SubagentParams,
	ctx: ToolContext,
	agents: AgentConfig[],
	checkSessionLimit: () => string | undefined,
	runtimeCtx: SubagentRuntimeContext,
	makeDetails: MakeDetails,
	onUpdate: OnUpdateCallback,
	signal: AbortSignal,
	selectionCtx: SelectionContext,
	_toolCallId: string,
	parentUiBridge: ParentBridge | undefined,
	parentSessionId: string | undefined,
	allToolNames: string[] | undefined,
) {
	const results: SingleResult[] = [];
	let previousOutput = "";
	const chainExcludeModels = new Set<string>();

	for (let i = 0; i < params.chain!.length; i++) {
		const step = params.chain![i];
		const taskWithContext = step.task.replace(/\{previous\}/g, () => previousOutput);

		const chainUpdate = buildChainUpdateCallback(results, makeDetails, onUpdate);

		const earlyExit = checkChainPreFlight(i, step, taskWithContext, {
			runtimeCtx,
			checkSessionLimit,
			results,
			makeDetails,
		});
		if (earlyExit) return earlyExit;

		const chainAgent = agents.find((a) => a.name === step.agent)!;
		const { result } = await runWithModelRetry({
			agent: chainAgent,
			excludeModels: chainExcludeModels,
			bucket: step.bucket,
			thinkingLevel: step.thinkingLevel,
			activeModelId: ctx.model?.id ?? "",
			selectionCtx,
			childDepth: runtimeCtx.depth + 1,
			buildRuntime: () => ({
				depth: runtimeCtx.depth + 1,
				trail: [...runtimeCtx.trail, step.agent],
				canSpawn: chainAgent.canSpawn,
				budget: runtimeCtx.budget,
			}),
			runAttempt: (resolved) => {
				const sel = resolved.selection ?? {
					modelId: resolved.modelOverride ?? ctx.model?.id ?? "",
					thinkingLevel: resolved.thinkingLevel,
					bucket: resolved.bucket ?? "medium",
					pool: [],
					fallback: true,
				};
				return runSingleAgent(
					ctx.cwd,
					agents,
					step.agent,
					taskWithContext,
					step.cwd,
					i + 1,
					signal,
					chainUpdate,
					(res) => makeDetails("chain", res),
					ctx.modelRegistry,
					ctx.model,
					sel,
					selectionCtx.disabledProviders,
					// Mirror the webview's SubagentCallContext for chain: step 0 renders
					// as a single block (bare id) while results.length <= 1, then as
					// `${id}:${i}` once earlier steps complete (results.length > 1).
					// Without this, a chain step 2+ ask_user would be orphaned (no
					// inline match, not surfaced to the bottom bar) and hang.
					i > 0 ? `${_toolCallId}:${i}` : _toolCallId,
					parentUiBridge,
					parentSessionId,
					allToolNames,
				);
			},
		});

		results.push(result);

		const failure = buildChainStepFailureResponse(i, step, result, results, makeDetails);
		if (failure) return failure;

		previousOutput = getFinalOutput(result.messages);
	}

	return formatChainSuccessResult(results, makeDetails);
}

interface ChainPreFlightArgs {
	runtimeCtx: SubagentRuntimeContext;
	checkSessionLimit: () => string | undefined;
	results: SingleResult[];
	makeDetails: MakeDetails;
}

/** Build the per-step `onUpdate` wrapper that mirrors partial results into the chain view. */
function buildChainUpdateCallback(
	results: SingleResult[],
	makeDetails: MakeDetails,
	onUpdate: OnUpdateCallback | undefined,
): OnUpdateCallback | undefined {
	if (!onUpdate) return undefined;
	return (partial) => {
		const currentResult = partial.details?.results[0];
		if (!currentResult) return;
		const allResults = [...results, currentResult];
		onUpdate({
			content: partial.content,
			details: makeDetails("chain", allResults),
		});
	};
}

/** Check trail-loop and session-limit guards for a chain step; return a stop response if either fires. */
export function checkChainPreFlight(
	stepIndex: number,
	step: NonNullable<SubagentParams["chain"]>[number],
	taskWithContext: string,
	args: ChainPreFlightArgs,
): ModeResult | undefined {
	const { runtimeCtx, checkSessionLimit, results, makeDetails } = args;

	if (checkTrailLoop(step.agent, runtimeCtx.trail)) {
		const loopErrorResult = createErrorResult(
			step.agent,
			taskWithContext,
			TRAIL_LOOP_MESSAGE(step.agent),
			stepIndex + 1,
		);
		results.push(loopErrorResult);
		return {
			content: [
				{
					type: "text" as const,
					text: `Chain stopped at step ${stepIndex + 1}: trail loop for agent "${step.agent}".`,
				},
			],
			details: makeDetails("chain", results),
			isError: true,
		};
	}

	const sessionLimitError = checkSessionLimit();
	if (sessionLimitError) {
		const limitErrorResult = createErrorResult(
			step.agent,
			taskWithContext,
			sessionLimitError,
			stepIndex + 1,
		);
		results.push(limitErrorResult);
		return {
			content: [
				{ type: "text" as const, text: `Chain stopped at step ${stepIndex + 1}: ${sessionLimitError}` },
			],
			details: makeDetails("chain", results),
			isError: true,
		};
	}

	const treeLimitError = consumeTreeSlot(runtimeCtx.budget);
	if (treeLimitError) {
		const limitErrorResult = createErrorResult(
			step.agent,
			taskWithContext,
			treeLimitError,
			stepIndex + 1,
		);
		results.push(limitErrorResult);
		return {
			content: [
				{ type: "text" as const, text: `Chain stopped at step ${stepIndex + 1}: ${treeLimitError}` },
			],
			details: makeDetails("chain", results),
			isError: true,
		};
	}

	return undefined;
}

/** After a chain step finishes, decide whether the chain should stop and report an error. */
export function buildChainStepFailureResponse(
	stepIndex: number,
	step: NonNullable<SubagentParams["chain"]>[number],
	result: SingleResult,
	results: SingleResult[],
	makeDetails: MakeDetails,
): ModeResult | undefined {
	if (!isResultError(result)) return undefined;
	return {
		content: [
			{
				type: "text" as const,
				text: `Chain stopped at step ${stepIndex + 1} (${step.agent}): ${failureMessage(result)}`,
			},
		],
		details: makeDetails("chain", results),
		isError: true,
	};
}

/** Build the final success response for a completed chain run. */
export function formatChainSuccessResult(results: SingleResult[], makeDetails: MakeDetails): ModeResult {
	return {
		content: [
			{
				type: "text" as const,
				text: getFinalOutput(results[results.length - 1].messages) || "(no output)",
			},
		],
		details: makeDetails("chain", results),
	};
}
