/**
 * Subagent execution orchestrator and supporting functions.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TextContent } from "@mariozechner/pi-ai";
import type { ToolContext } from "./tool-context.js";
import { textContent } from "./text-content.js";
import { realRetryClock, type RetryClock } from "./retry.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readKeptSkills } from "../../../shared/pruned-skills.js";
import { type AgentConfig, type AgentScope, discoverAgents } from "../agents.js";
import {
	readRuntimeContext,
	consumeTreeSlot,
	getMaxDepth,
	type SubagentRuntimeContext,
} from "../runner.js";
import { resolveInstalledSubagentAnalyticsCapture } from "./analytics-runtime-bridge.js";
import {
	type OnUpdateCallback,
	type SingleResult,
	type SubagentDetails,
} from "../types.js";
import { createInvalidAgentResult, summarizeInvalidAgentResults } from "../validation.js";
import {
	type BucketSelection,
	type ThinkingLevel,
	type RuntimeThinkingSupport,
	type BucketAssignments,
	type SimpleModelConfig,
	type NestedAllowedBuckets,
	ALL_NESTED_BUCKETS_ALLOWED,
	PROVIDER_TOGGLES_ENV,
	SUBAGENT_PROVIDER_DEFAULTS_ENV,
	SUBAGENT_PROVIDER_TOGGLES_ENV,
	getDisabledProviders,
	loadModelConfig,
	parseProviderToggles,
	parseSessionProviderToggles,
	resolveSubagentProviderToggles,
	readBucketAssignments,
	readNestedAllowedBuckets,
	canSpawnFromSubagentBucket,
	getRuntimeThinkingSupport,
	qualifiedModelSpec,
	downgradeBucketForNested,
	selectModel,
} from "../bucket-selector.js";
import { makeDetails } from "./helpers.js";
import { executeSingleTask, type SingleSubagentParams } from "./single.js";
import { readRecursiveProjectionCounters } from "./result-compaction.js";
import {
	readAlwaysParentModelFromEnv,
	readRouteAroundSaturatedProviders,
} from "./provider-capacity.js";
import type { ParentBridge } from "./parent-extension-ui-bridge-proxy.js";
import { readFallbackOnProviderFailure } from "./provider-failure.js";
import { hashDelegatedPrompt, loadModelFamilies, withRuntimeProvenance } from "./runtime-provenance.js";
import { recordRuntimeTrace } from "./runtime-trace.js";
// Model-selection primitives live in ./selection.ts and remain re-exported
// here for compatibility with existing focused tests and integrations.
import {
	resolveModel,
	attachSelectionMetadata,
	isModelFailure,
	checkTrailLoop,
	modelInputSatisfiesRequirement,
	requirementIsActive,
	type ModelInputKind,
	type SelectionContext,
} from "./selection.js";

/** Root of the pi-config repo, resolved from this extension's known position. */
const CONFIG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Reads the always-parent-model override from the environment (set by the pie host). */
export function readAlwaysParentModel(): boolean {
	return readAlwaysParentModelFromEnv();
}

// SelectionContext moved to ./selection.ts (see import above).

/** Validate the sole supported invocation shape and agent name. */
export function validateSubagentParams(
	params: SingleSubagentParams,
	agents: AgentConfig[],
):
	| { ok: true; mode: "single"; invalidResults: SingleResult[] }
	| { ok: false; invalidResults: SingleResult[] } {
	if (typeof params.agent !== "string" || params.agent.trim() === "" || typeof params.task !== "string" || params.task.trim() === "") {
		return {
			ok: false,
			invalidResults: [{
				agent: "",
				agentSource: "unknown",
				task: "",
				exitCode: 1,
				messages: [],
				stderr: "Invalid parameters. Provide one non-empty agent and task; use sibling calls for independent work.",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			}],
		};
	}
	const invalidResults = agents.some((agent) => agent.name === params.agent)
		? []
		: [createInvalidAgentResult(params.agent, params.task, agents)];
	return { ok: true, mode: "single", invalidResults };
}

// Compatibility re-exports for existing focused imports.
export { resolveModel, attachSelectionMetadata, isModelFailure, checkTrailLoop, type SelectionContext };

/** Standard error response shape used by early returns. */
type ErrorResponse = { content: TextContent[]; details: SubagentDetails; isError: true };

/** Loud log for a hardening event. Mirrors the runner's `logLoud` shape so
 *  logs are uniformly grep-able under `source: "pie:subagent"`. Kept local to
 *  execute.ts to avoid a new cross-module import for one helper. */
function logLoud(event: string, details: Record<string, unknown>): void {
	console.error(JSON.stringify({ source: "pie:subagent", event, ...details }));
}

const DEFAULT_AGENT_SCOPE: AgentScope = "both";

/** Returns the standard response when the tool is disabled. */
function disabledErrorResponse(): ErrorResponse {
	return {
		content: [textContent("Sub agents are disabled. Enable them by removing the --no-subagent flag or unsetting the PI_SUBAGENT_DISABLED environment variable.")],
		details: {
			mode: "single" as const,
			agentScope: DEFAULT_AGENT_SCOPE,
			projectAgentsDir: null,
			results: [],
		},
		isError: true,
	};
}

/** Returns the standard response when subagents are disabled via maxDepth = 0. */
function subagentsDisabledResponse(maxDepth: number): ErrorResponse {
	return {
		content: [textContent(`Subagents are disabled (nesting levels set to ${maxDepth}). Set "Nesting levels" above 0 to delegate to subagents.`)],
		details: {
			mode: "single" as const,
			agentScope: DEFAULT_AGENT_SCOPE,
			projectAgentsDir: null,
			results: [],
		},
		isError: true,
	};
}

/** Returns the standard response when subagent depth limit is reached. */
function depthLimitResponse(maxDepth: number): ErrorResponse {
	return {
		content: [textContent(`Subagent depth limit reached (max ${maxDepth}). Cannot spawn further subagents.`)],
		details: { mode: "single", agentScope: DEFAULT_AGENT_SCOPE, projectAgentsDir: null, results: [] },
		isError: true,
	};
}

/** Returns the standard response when the caller's effective bucket is a leaf. */
function bucketDelegationBlockedResponse(bucket: string): ErrorResponse {
	return {
		content: [textContent(`Subagents in the "${bucket}" bucket are not allowed to create further subagents. Complete the task directly or return control to the parent agent.`)],
		details: { mode: "single", agentScope: DEFAULT_AGENT_SCOPE, projectAgentsDir: null, results: [] },
		isError: true,
	};
}

/**
 * Returns the requested agent names the caller is not permitted to spawn.
 * `canSpawn` undefined (root caller, or agent without the field) → unrestricted
 * → empty result. Otherwise any requested name not in the allowlist is disallowed.
 */
export function disallowedByCanSpawn(
	canSpawn: string[] | undefined,
	requested: Set<string>,
): string[] {
	if (!canSpawn) return [];
	return [...requested].filter((name) => !canSpawn.includes(name));
}

/** Invalid executions throw so pi persists isError=true per the tool contract. */
function throwParamsError(agents: AgentConfig[]): never {
	const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
	throw new Error(`Invalid parameters. Provide one non-empty agent and task; use sibling calls for independent work.\nAvailable agents: ${available}`);
}

/** Throws when one or more requested agent names do not exist.
 *  Invalid executions throw so pi persists isError=true per the tool contract. */
function throwInvalidAgents(invalidResults: SingleResult[]): never {
	throw new Error(summarizeInvalidAgentResults(invalidResults));
}

/** Collect the sole requested agent name. */
function collectRequestedAgentNames(params: SingleSubagentParams): Set<string> {
	return new Set([params.agent]);
}

/** Resolve and snapshot the effective subagent-only provider policy for a tree.
 * Nested AgentSessions use in-memory session managers whose paths do not identify
 * the main chat, so descendants must consume the root snapshot rather than
 * re-resolving per-session preferences against their own session manager. */
export function resolveTreeSubagentProviderToggles(
	runtimeCtx: SubagentRuntimeContext,
	rootSessionPath: string | undefined,
): Record<string, boolean> {
	if (runtimeCtx.subagentProviderToggles !== undefined) {
		return runtimeCtx.subagentProviderToggles;
	}
	const resolved = resolveSubagentProviderToggles(
		parseProviderToggles(process.env[SUBAGENT_PROVIDER_DEFAULTS_ENV]),
		parseSessionProviderToggles(process.env[SUBAGENT_PROVIDER_TOGGLES_ENV], rootSessionPath),
	);
	runtimeCtx.subagentProviderToggles = resolved;
	return resolved;
}

/** Loads simple model config, reads user-configured buckets, and builds provider/model allowlists. */
function setupModelSelection(
	ctx: ToolContext,
	runtimeCtx: SubagentRuntimeContext,
	modelRequirements?: import("../types.js").ModelRequirements,
	callerThinkingLevel?: ThinkingLevel,
): SelectionContext {
	const modelConfigPath = path.join(CONFIG_ROOT, "model-profiles.json");
	let modelConfig: SimpleModelConfig[] = [];
	try {
		modelConfig = loadModelConfig(modelConfigPath);
	} catch {
		/* ignore */
	}

	// User-configured bucket assignments, mirrored by the pie host into the
	// process environment (PIE_SUBAGENT_BUCKETS_JSON) via the runtimePrefs.set
	// RPC. Empty when unset (stock pi / unconfigured) → falls back to the
	// caller's active model.
	const bucketAssignments = readBucketAssignments();

	const disabledProviders = getDisabledProviders(parseProviderToggles(process.env[PROVIDER_TOGGLES_ENV]));
	const sessionPath = runtimeCtx.rootSessionPath
		?? ctx.sessionManager?.getSessionFile?.()
		?? undefined;
	const subagentProviderToggles = resolveTreeSubagentProviderToggles(runtimeCtx, sessionPath);
	const subagentDisabled = getDisabledProviders(subagentProviderToggles);
	for (const provider of subagentDisabled) disabledProviders.add(provider);
	const availableModels = ctx.modelRegistry.getAvailable();
	const enabledModels = availableModels.filter((m) => !disabledProviders.has(m.provider));
	// Minimal test/runtime registries may only expose getAvailable(). Fall back to
	// that snapshot when the broader registry enumeration is unavailable.
	const enabledRegistryModels = (ctx.modelRegistry.getAll?.() ?? availableModels)
		.filter((model) => !disabledProviders.has(model.provider));
	const allowedModelIds = new Set<string>(
		enabledModels.flatMap((m) => [m.id, qualifiedModelSpec(m.provider, m.id)]),
	);
	// Prefer exact runtime support for provider-qualified bucket entries. Include
	// every enabled declaration that execution resolution can choose via getAll(),
	// not only currently available declarations, so a bare id cannot be admitted
	// and then resolved to an unsupported caller/default provider.
	const runtimeThinkingSupport = new Map<string, ReadonlySet<ThinkingLevel>>();
	for (const model of enabledRegistryModels) {
		runtimeThinkingSupport.set(
			qualifiedModelSpec(model.provider, model.id),
			getRuntimeThinkingSupport(model as typeof model & {
				reasoning?: unknown;
				thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
			}),
		);
	}

	// Hard model requirement snapshot. Capability comes from the runtime
	// `Model.input` array on `modelRegistry.getAvailable()` — `SimpleModelConfig`
	// remains responsible for profile eligibility and thinking metadata only and
	// is NOT treated as a capability source. A model id is requirement-qualified when at least one
	// enabled provider-qualified declaration satisfies the requirement; this set
	// is the hard filter applied by `selectModel` so duplicate ids exposed by an
	// incompatible provider can never become eligible. Undefined (no filtering)
	// when the requirement is absent or empty, preserving current behaviour.
	const requirementActive = requirementIsActive(modelRequirements);
	const requirementQualifiedModelIds = requirementActive
		? new Set<string>(
				enabledModels
					.filter((m) => modelInputSatisfiesRequirement(
						(m as { input?: ReadonlyArray<string> }).input,
						modelRequirements,
					))
					.flatMap((m) => [m.id, qualifiedModelSpec(m.provider, m.id)]),
			)
		: undefined;

	return {
		modelConfig,
		disabledProviders,
		allowedModelIds,
		bucketAssignments,
		runtimeThinkingSupport,
		callerThinkingLevel,
		alwaysParentModel: readAlwaysParentModel(),
		routeAroundSaturatedProviders: readRouteAroundSaturatedProviders(),
		fallbackOnProviderFailure: readFallbackOnProviderFailure(),
		registryModels: availableModels,
		modelFamilies: loadModelFamilies(path.join(CONFIG_ROOT, "models.json")),
		nestedAllowedBuckets: readNestedAllowedBuckets(),
		modelRequirements,
		callerModelInput: ctx.model?.input as ReadonlyArray<ModelInputKind> | undefined,
		requirementQualifiedModelIds,
	};
}

/** Dispatch the sole supported execution route. */
function dispatchSingle(
	params: SingleSubagentParams,
	ctx: ToolContext,
	agents: AgentConfig[],
	runtimeCtx: SubagentRuntimeContext,
	makeDetailsBound: (results: SingleResult[]) => SubagentDetails,
	onUpdate: OnUpdateCallback,
	signal: AbortSignal | undefined,
	selectionCtx: SelectionContext,
	toolCallId: string,
	parentUiBridge: ParentBridge | undefined,
	parentSessionId: string | undefined,
	allToolNames: string[] | undefined,
	clock: RetryClock,
) {
	return executeSingleTask({
		params,
		ctx,
		agents,
		runtimeCtx,
		makeDetails: makeDetailsBound,
		onUpdate,
		signal,
		selectionCtx,
		toolCallId,
		parentUiBridge,
		parentSessionId,
		allToolNames,
		_internal: { clock },
	});
}

/** Main execute function for the subagent tool. */
export async function execute(
	_toolCallId: string,
	params: SingleSubagentParams,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback,
	ctx: ToolContext,
	_pi: ExtensionAPI,
	isDisabled: () => boolean,
	/** Deterministic clock seam for retry/backoff acceptance tests. */
	_internal?: { clock?: RetryClock },
) {
	if (isDisabled()) return disabledErrorResponse();
	const retryClock = _internal?.clock ?? realRetryClock;

	const runtimeCtx = readRuntimeContext();
	// The isolated worker installs this process-local bridge only after a
	// canonical activation descriptor has been validated. Nested calls inherit
	// the resulting context through AsyncLocalStorage; legacy/unconfigured
	// workers keep the historical no-op path.
	runtimeCtx.analyticsCapture ??= resolveInstalledSubagentAnalyticsCapture();
	const maxDepth = getMaxDepth();
	if (maxDepth === 0) return subagentsDisabledResponse(maxDepth);
	if (!canSpawnFromSubagentBucket(runtimeCtx.bucket)) {
		return bucketDelegationBlockedResponse(runtimeCtx.bucket!);
	}
	if (runtimeCtx.depth >= maxDepth) return depthLimitResponse(maxDepth);

	// Seed the shared tree-wide session budget at the outermost call. Nested
	// calls inherit it through the AsyncLocalStorage runtime context.
	if (!runtimeCtx.budget) runtimeCtx.budget = { sessions: 0 };

	// Project-local agents are found by walking up from a cwd looking for an
	// `agents/` dir. The session cwd (`ctx.cwd`) is the VS Code workspace root,
	// which may sit ABOVE the actual project (e.g. a multi-repo workspace whose
	// `agents/` lives in a subdirectory). Include each per-task `cwd` so a caller
	// can point at a nested project root and have its agents discovered.
	// CONFIG_ROOT (this repo) is included as a stable fallback so project agents
	// are discoverable even when the session cwd has no `agents/` dir and
	// PI_CODING_AGENT_DIR is unset (e.g. a session launched from System32).
	const discoveryCwds = [ctx.cwd, CONFIG_ROOT];
	if (params.cwd) discoveryCwds.push(params.cwd);
	const discovery = discoverAgents(discoveryCwds, DEFAULT_AGENT_SCOPE);
	const agents = discovery.agents;
	const validation = validateSubagentParams(params, agents);
	if (!validation.ok) {
		throwParamsError(agents);
	}
	const { invalidResults } = validation;

	if (invalidResults.length > 0) {
		throwInvalidAgents(invalidResults);
	}

	// Starting an agent is a routine orchestration action and must not prompt.
	// Resulting tool calls remain subject to the normal action-level safeguards.
	// Enforce the caller's canSpawn allowlist. The root caller (main agent) has
	// no canSpawn → unrestricted. An agent with a canSpawn list may only spawn the
	// named agents, preserving invariants such as read-only-only delegation.
	// Returning an isError response (rather than throwing) keeps the error
	// surfaced in the tool result the same way other dispatch-level guards do.
	const callerCanSpawn = runtimeCtx.canSpawn;
	const disallowed = disallowedByCanSpawn(callerCanSpawn, collectRequestedAgentNames(params));
	if (disallowed.length > 0) {
		const listing = disallowed.map((n) => `"${n}"`).join(", ");
		return {
			content: [textContent(`Not permitted to spawn ${listing}: blocked by the caller's canSpawn allowlist. Choose an agent the caller is allowed to delegate to.`)],
			details: makeDetails("single", [], DEFAULT_AGENT_SCOPE, discovery.projectAgentsDir),
			isError: true,
		};
	}

	// Older/minimal ExtensionAPI test doubles may not expose the newer getter.
	// Keep the historical subagent default when it is unavailable.
	const callerThinkingLevel = _pi.getThinkingLevel?.() ?? "high";
	const selectionCtx = setupModelSelection(ctx, runtimeCtx, params.modelRequirements, callerThinkingLevel);
	const requestedAgent = agents.find((candidate) => candidate.name === params.agent);
	const provenanceSeed = {
		promptHash: hashDelegatedPrompt(params.task),
		requestedBucket: params.bucket ?? requestedAgent?.bucket ?? "medium",
		parentToolCallId: _toolCallId,
		modelFamilies: selectionCtx.modelFamilies,
		registryModels: selectionCtx.registryModels,
	};
	const makeDetailsBound = (results: SingleResult[]) =>
		makeDetails(
			"single",
			results.map((result) => withRuntimeProvenance(result, provenanceSeed)),
			DEFAULT_AGENT_SCOPE,
			discovery.projectAgentsDir,
		);

	// Resolve the parent (main) session id and the full tool-name set once per
	// subagent tool call, so subagents can (a) inherit the main turn's pruned
	// skills by looking up the skill-pruner's kept set, and (b) have the
	// user-configured drop-tools list subtracted from unrestricted agents.
	// Both are defensive: undefined when unresolvable → today's behavior.
	const parentSessionId = (ctx as { sessionManager?: { getSessionId?: () => string } }).sessionManager?.getSessionId?.();
	// Seed once from the main session; the runtime context carries this
	// immutable selection through every deeper nested child.
	if (runtimeCtx.keptSkills === undefined && parentSessionId) {
		runtimeCtx.keptSkills = readKeptSkills(parentSessionId);
	}
	let allToolNames: string[] | undefined;
	try {
		allToolNames = _pi.getAllTools().map((t) => t.name);
	} catch {
		allToolNames = undefined;
	}

	// Dispatch with the caller's abort signal only. Settlement is owned by
	// explicit completion, parent/user cancellation, the runner's local
	// terminal CAS, and bounded detached cleanup after cancellation/terminal.
	// There is deliberately NO elapsed-inactivity or absolute-duration force
	// settlement (no settlement net, phase lease, or prompt timer): a healthy
	// long-running child stays alive until it completes or is explicitly
	// cancelled. Provider retry/admission/transport bounds remain in retry.ts,
	// provider-capacity.ts, and the shared provider gate.
	const safeOnUpdate: OnUpdateCallback = (partial) => {
		try {
			onUpdate?.(partial);
		} catch (error) {
			logLoud("subagent progress delivery failed", { toolCallId: _toolCallId, error: String(error) });
		}
	};
	const winner = await dispatchSingle(
		params,
		ctx,
		agents,
		runtimeCtx,
		makeDetailsBound,
		safeOnUpdate,
		signal,
		selectionCtx,
		_toolCallId,
		ctx.hasUI ? (ctx.ui as unknown as ParentBridge) : undefined,
		parentSessionId,
		allToolNames,
		retryClock,
	);
	// The runner's compactSingleResult traversal measured its own duration
	// alongside the counters on the same symbol metadata. Emit that measured
	// projection before the terminal handoff; nothing here re-walks or
	// re-serializes the recursive payload.
	const recursiveCounters = readRecursiveProjectionCounters(winner.details);
	const runtimeContext = readRuntimeContext();
	recordRuntimeTrace({
		phase: "recursive_projection",
		durationMs: recursiveCounters?.durationMs,
		childCount: recursiveCounters?.childCount,
		messageCount: recursiveCounters?.messageCount,
		maxRecursiveDepth: recursiveCounters?.maxRecursiveDepth,
		identifiers: {
			session: runtimeContext.rootSessionPath,
			attempt: winner.details?.results?.[0]?.attemptId,
			tool: _toolCallId,
		},
	});
	recordRuntimeTrace({
		phase: "terminal",
		childCount: recursiveCounters?.childCount,
		messageCount: recursiveCounters?.messageCount,
		maxRecursiveDepth: recursiveCounters?.maxRecursiveDepth,
		identifiers: {
			session: runtimeContext.rootSessionPath,
			attempt: winner.details?.results?.[0]?.attemptId,
			tool: _toolCallId,
		},
	});
	return winner;
}
