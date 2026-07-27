/**
 * Subagent execution orchestrator and supporting functions.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TextContent } from "@mariozechner/pi-ai";
import type { ToolContext } from "./tool-context.js";
import { textContent } from "./text-content.js";
import { realRetryClock, type RetryClock, type RetryTimer } from "./retry.js";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonOrThrow, toErrorMessage } from "../../../shared/error-message.js";
import { readKeptSkills } from "../../../shared/pruned-skills.js";
import { type AgentConfig, type AgentScope, discoverAgents } from "../agents.js";
import {
	readRuntimeContext,
	consumeTreeSlot,
	getMaxDepth,
	type SubagentRuntimeContext,
} from "../runner.js";
import {
	type OnUpdateCallback,
	type SingleResult,
	type SubagentDetails,
} from "../types.js";
import { createInvalidAgentResult, summarizeInvalidAgentResults } from "../validation.js";
import {
	type BucketSelection,
	type ThinkingLevel,
	type BucketAssignments,
	type SimpleModelConfig,
	type NestedAllowedBuckets,
	ALL_NESTED_BUCKETS_ALLOWED,
	PROVIDER_TOGGLES_ENV,
	SUBAGENT_PROVIDER_DEFAULTS_ENV,
	SUBAGENT_PROVIDER_TOGGLES_ENV,
	getAllowedModelIdsForProviders,
	getDisabledProviders,
	loadModelConfig,
	parseProviderToggles,
	parseSessionProviderToggles,
	resolveSubagentProviderToggles,
	readBucketAssignments,
	readNestedAllowedBuckets,
	downgradeBucketForNested,
	selectModel,
} from "../bucket-selector.js";
import { makeDetails } from "./helpers.js";
import { executeSingleTask, type SingleSubagentParams } from "./single.js";
import { compactSubagentDetails } from "./result-compaction.js";
import {
	readAlwaysParentModelFromEnv,
	readRouteAroundSaturatedProviders,
} from "./provider-capacity.js";
import type { ParentBridge } from "./parent-extension-ui-bridge-proxy.js";
import { readFallbackOnProviderFailure } from "./provider-failure.js";
import { hashDelegatedPrompt, loadModelFamilies, withRuntimeProvenance } from "./runtime-provenance.js";
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

/**
 * Reads the `subagent.confirmProjectAgents` value from a settings.json file.
 * Returns undefined when the file or key is absent, so callers fall back to
 * the per-call parameter (which itself defaults to true). A per-call
 * `confirmProjectAgents` value always takes precedence over this setting.
 *
 * Exported separately from `readSubagentConfirmDefault` so the parsing logic
 * can be unit-tested against an arbitrary path.
 */
export function readConfirmDefaultFromSettings(settingsPath: string): boolean | undefined {
	if (!existsSync(settingsPath)) return undefined;
	try {
		const parsed = parseJsonOrThrow<Record<string, unknown>>(readFileSync(settingsPath, "utf-8"), settingsPath);
		const subagent = parsed.subagent as Record<string, unknown> | undefined;
		if (subagent && typeof subagent.confirmProjectAgents === "boolean") {
			return subagent.confirmProjectAgents;
		}
	} catch {
		/* ignore malformed settings.json */
	}
	return undefined;
}

/** Reads the `subagent.confirmProjectAgents` default from settings.json at the config root. */
export function readSubagentConfirmDefault(): boolean | undefined {
	return readConfirmDefaultFromSettings(path.join(CONFIG_ROOT, "settings.json"));
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
export type Mode = "single";
type ErrorResponse = { content: TextContent[]; details: SubagentDetails; isError: true };

/** Environment key for the last-resort settlement inactivity budget
 *  (milliseconds). Kept under its existing name for configuration compatibility.
 *  See {@link resolveSettlementMs}. */
const SETTLEMENT_ENV = "PIE_SUBAGENT_SETTLEMENT_MS";
/** Default settlement inactivity budget: 12 minutes. This is deliberately
 *  longer than the normal provider/tool phase leases. Credible progress renews
 *  it, so productive long-running children are not capped by total wall time;
 *  a completely silent dispatch still cannot dangle the parent forever. */
export const DEFAULT_SETTLEMENT_MS = 12 * 60 * 1000;

/** Default inactivity lease per observable child phase. Provider queue/header
 * liveness remains additionally bounded by ProviderGate; these outer leases
 * guarantee the parent tool call also reaches a terminal decision. */
export const PHASE_INACTIVITY_MS: Partial<Record<NonNullable<SingleResult['activityPhase']>, number>> = {
	queued: 10 * 60 * 1000,
	preparing: 2 * 60 * 1000,
	waiting_provider: 5 * 60 * 1000,
	streaming: 3 * 60 * 1000,
	running_tool: 15 * 60 * 1000,
	retry_wait: 3 * 60 * 1000,
	orphaned_cleanup: 60 * 1000,
};

function hasSettlementOverride(): boolean {
	const raw = process.env[SETTLEMENT_ENV];
	return raw !== undefined && raw !== '';
}

/** Choose the active lease. An explicit compatibility override continues to
 * control every phase; otherwise the latest child phase owns its own budget. */
export function resolvePhaseInactivityMs(
	details: SubagentDetails | undefined,
	fallbackMs = DEFAULT_SETTLEMENT_MS,
): number {
	if (hasSettlementOverride()) return resolveSettlementMs();
	const activeBudgets = (details?.results ?? [])
		.filter((result) => result.exitCode === -1)
		.map((result) => PHASE_INACTIVITY_MS[result.activityPhase ?? 'waiting_provider'] ?? fallbackMs);
	return activeBudgets.length > 0 ? Math.max(...activeBudgets) : fallbackMs;
}

/** Resolve the settlement inactivity budget for a subagent tool call.
 *
 * Reads `PIE_SUBAGENT_SETTLEMENT_MS`:
 * - Unset/empty → {@link DEFAULT_SETTLEMENT_MS} (the net is ON by default).
 * - `0` → explicitly disabled (no net; only for debugging/emergency).
 * - A positive number → the renewable inactivity budget in ms.
 * - Invalid (NaN/negative) → {@link DEFAULT_SETTLEMENT_MS}.
 *
 * Returns the inactivity budget in ms, or `0` to disable the net entirely.
 */
export function resolveSettlementMs(): number {
	const raw = process.env[SETTLEMENT_ENV];
	if (raw === undefined || raw === "") return DEFAULT_SETTLEMENT_MS;
	const ms = Number(raw);
	if (!Number.isFinite(ms) || ms < 0) return DEFAULT_SETTLEMENT_MS;
	return ms;
}

/** Environment key for the post-deadline grace period (milliseconds).
 *  See {@link resolveSettlementGraceMs}. */
const SETTLEMENT_GRACE_ENV = "PIE_SUBAGENT_SETTLEMENT_GRACE_MS";
/** Default grace given to a force-settled dispatch to surface its own abort
 *  result before we synthesize one (prefers the real abort result over a
 *  synthesized error). */
export const DEFAULT_SETTLEMENT_GRACE_MS = 5000;

/** Resolve the grace period allowed after the settlement deadline fires before
 *  synthesizing a terminal error toolResult. Unset/invalid → default; `0` →
 *  skip the grace and synthesize immediately (useful in tests). */
export function resolveSettlementGraceMs(): number {
	const raw = process.env[SETTLEMENT_GRACE_ENV];
	if (raw === undefined || raw === "") return DEFAULT_SETTLEMENT_GRACE_MS;
	const ms = Number(raw);
	if (!Number.isFinite(ms) || ms < 0) return DEFAULT_SETTLEMENT_GRACE_MS;
	return ms;
}

/** Compact semantic fallback for old snapshots that predate progressGeneration.
 * Do not include timestamps: a producer repeatedly stamping Date.now() is not
 * credible work and must not keep a hung tree alive. */
function legacyProgressFingerprint(result: SingleResult): string {
	return JSON.stringify([
		result.agent, result.task, result.step, result.exitCode, result.model,
		result.stopReason, result.errorMessage, result.activityPhase, result.activityDetail,
		result.streaming, result.streamingText, result.streamingReasoning, result.runningTools,
		result.messages.length, result.usage.turns, result.usage.input, result.usage.output,
		result.retryCount, result.failedModel, result.selectedModel,
	]);
}

/** Identify one stable child attempt. A generation reset is only credible
 * when this identity changes (for example, a model retry moves to another
 * provider/model); agent/task/step alone are not enough. */
function progressAttemptIdentity(result: SingleResult): string {
	return JSON.stringify([
		result.agent,
		result.task,
		result.step ?? null,
		result.provider ?? null,
		result.model ?? null,
	]);
}

/** Tracks the latest per-child progress sequence at this execute boundary.
 * Modern children renew only when their generation advances past the highest
 * value observed for the same attempt. Keeping a high-water mark is important:
 * a stale 5 → 4 → 5 sequence must not turn the final 5 into fresh progress.
 * Legacy snapshots use a semantic fingerprint until an explicit generation is
 * observed, so duplicate callbacks still do not renew the settlement lease. */
export function createProgressObserver(): (details: SubagentDetails | undefined) => boolean {
	type ProgressState = {
		identity: string;
		highWaterGeneration?: number;
		sawGeneration: boolean;
		fingerprint: string;
	};
	const previous = new Map<number, ProgressState>();
	return (details) => {
		if (!details?.results) return false;
		let progressed = false;
		for (let index = 0; index < details.results.length; index++) {
			const result = details.results[index];
			const generation = Number.isSafeInteger(result.progressGeneration) && result.progressGeneration! >= 0
				? result.progressGeneration
				: undefined;
			const fingerprint = legacyProgressFingerprint(result);
			const identity = progressAttemptIdentity(result);
			const before = previous.get(index);
			if (!before || before.identity !== identity) {
				// A changed attempt identity is the one allowed generation reset.
				progressed = true;
				previous.set(index, {
					identity,
					highWaterGeneration: generation,
					sawGeneration: generation !== undefined,
					fingerprint,
				});
				continue;
			}

			if (generation !== undefined) {
				if (!before.sawGeneration) {
					progressed = true;
					before.sawGeneration = true;
					before.highWaterGeneration = generation;
				} else if (generation > (before.highWaterGeneration ?? -1)) {
					progressed = true;
					before.highWaterGeneration = generation;
				}
			} else if (!before.sawGeneration && fingerprint !== before.fingerprint) {
				// Compatibility path for pre-generation snapshots only.
				progressed = true;
			}
			before.fingerprint = fingerprint;
		}
		return progressed;
	};
}

/** Sentinel resolved by the settlement timer when the dispatch hasn't returned. */
const FORCE_SETTLE = Symbol("pie:subagent:force-settle");

function combineSignals(left: AbortSignal, right: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
	if (typeof AbortSignal.any === "function") return { signal: AbortSignal.any([left, right]), cleanup: () => {} };
	const controller = new AbortController();
	const cleanup = () => {
		left.removeEventListener("abort", onLeft);
		right.removeEventListener("abort", onRight);
	};
	const abort = (source: AbortSignal) => {
		if (!controller.signal.aborted) controller.abort(source.reason);
		cleanup();
	};
	const onLeft = () => abort(left);
	const onRight = () => abort(right);
	if (left.aborted) abort(left);
	else if (right.aborted) abort(right);
	else {
		left.addEventListener("abort", onLeft, { once: true });
		right.addEventListener("abort", onRight, { once: true });
	}
	return { signal: controller.signal, cleanup };
}

/** Loud log for a settlement / hardening event. Mirrors the runner's `logLoud`
 *  shape so logs are uniformly grep-able under `source: "pie:subagent"`. Kept
 *  local to execute.ts to avoid a new cross-module import for one helper. */
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

/** Confirms project-local agent usage with the user; returns undefined on approval, response on cancel. */
export async function maybeApproveProjectAgents(
	params: SingleSubagentParams,
	agents: AgentConfig[],
	discovery: ReturnType<typeof discoverAgents>,
	mode: Mode,
	ctx: ToolContext,
): Promise<ErrorResponse | undefined> {
	if (!(params.confirmProjectAgents ?? readSubagentConfirmDefault() ?? true)) {
		return undefined;
	}

	// No project agents dir was discovered, so there is nothing repo-controlled to
	// confirm. This also keeps unit tests that inject project-sourced agents
	// without a real discovery dir from spuriously failing closed.
	if (!discovery.projectAgentsDir) {
		return undefined;
	}

	const projectAgentsRequested = Array.from(collectRequestedAgentNames(params))
		.map((name) => agents.find((a) => a.name === name))
		.filter((a): a is AgentConfig => a?.source === "project");

	if (projectAgentsRequested.length === 0) return undefined;

	const names = projectAgentsRequested.map((a) => a.name).join(", ");
	const dir = discovery.projectAgentsDir ?? "(unknown)";
	if (!ctx.hasUI) {
		return {
			content: [textContent(`Cannot confirm project-local agents (${names}) in a non-interactive mode. Re-run with UI, or explicitly set confirmProjectAgents: false only for a trusted repository.`)],
			details: makeDetails(mode, [], DEFAULT_AGENT_SCOPE, discovery.projectAgentsDir),
			isError: true,
		};
	}
	const ok = await ctx.ui.confirm(
		"Run project-local agents?",
		`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
	);
	if (ok) return undefined;

	return {
		content: [textContent("Canceled: project-local agents not approved.")],
		details: makeDetails(mode, [], DEFAULT_AGENT_SCOPE, discovery.projectAgentsDir),
		isError: true,
	};
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
	const allowedModelIds = new Set<string>(
		availableModels
			.filter((m) => !disabledProviders.has(m.provider))
			.map((m) => m.id),
	);

	// Hard model requirement snapshot. Capability comes from the runtime
	// `Model.input` array on `modelRegistry.getAvailable()` — `SimpleModelConfig`
	// remains responsible for thinking/cost metadata only and is NOT treated as
	// a capability source. A model id is requirement-qualified when at least one
	// enabled provider-qualified declaration satisfies the requirement; this set
	// is the hard filter applied by `selectModel` so duplicate ids exposed by an
	// incompatible provider can never become eligible. Undefined (no filtering)
	// when the requirement is absent or empty, preserving current behaviour.
	const requirementActive = requirementIsActive(modelRequirements);
	const requirementQualifiedModelIds = requirementActive
		? new Set<string>(
				availableModels
					.filter((m) =>
						!disabledProviders.has(m.provider)
						&& modelInputSatisfiesRequirement(
							(m as { input?: ReadonlyArray<string> }).input,
							modelRequirements,
						),
					)
					.map((m) => m.id),
			)
		: undefined;

	return {
		modelConfig,
		disabledProviders,
		allowedModelIds,
		bucketAssignments,
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
	/** Deterministic timer seam for lifecycle acceptance tests. */
	_internal?: { clock?: RetryClock },
) {
	if (isDisabled()) return disabledErrorResponse();
	const settlementClock = _internal?.clock ?? realRetryClock;

	const runtimeCtx = readRuntimeContext();
	const maxDepth = getMaxDepth();
	if (maxDepth === 0) return subagentsDisabledResponse(maxDepth);
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
	const { mode, invalidResults } = validation;

	if (invalidResults.length > 0) {
		throwInvalidAgents(invalidResults);
	}

	const approvalError = await maybeApproveProjectAgents(params, agents, discovery, mode, ctx);
	if (approvalError) return approvalError;

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

	const selectionCtx = setupModelSelection(ctx, runtimeCtx, params.modelRequirements);
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

	// Settlement net (last-resort, defense-in-depth): guarantee `execute()`
	// returns after a bounded period with NO credible progress even if a
	// downstream phase (a future bug, an SDK that ignores abort, a dead provider
	// stream the proxy didn't surface) hangs forever. This is NOT a total-runtime
	// ceiling: preservingOnUpdate renews it whenever a child publishes progress,
	// so a productive worker can run for 30+ minutes. On inactivity it aborts the
	// run (so runner.ts can return its own abort result), then force-returns a
	// synthesized error toolResult if the dispatch still doesn't settle.
	// Retain the latest immutable progress snapshot at the execute boundary. If
	// the net fires, completed siblings and partial child output must survive;
	// only children that are still running are terminalized.
	let latestDetails: SubagentDetails | undefined;
	let activeSettlementMs = resolveSettlementMs();
	const captureDetails = (details: SubagentDetails | undefined): void => {
		if (!details?.results) return;
		const previous = latestDetails?.results ?? [];
		latestDetails = {
			...details,
			results: details.results.map((result, index) => ({
				...previous[index],
				...result,
				// Preserve partial prose/reasoning across the settlement-triggered abort update.
				streamingText: result.streamingText ?? previous[index]?.streamingText,
				streamingReasoning: result.streamingReasoning ?? previous[index]?.streamingReasoning,
			})),
		};
		activeSettlementMs = resolvePhaseInactivityMs(latestDetails);
	};
	let renewSettlementDeadline: (() => void) | undefined;
	const observeProgress = createProgressObserver();
	let acceptDispatchUpdates = true;
	const deliverUpdate = (partial: Parameters<OnUpdateCallback>[0]): void => {
		try { onUpdate?.(partial); } catch (error) {
			logLoud("subagent progress delivery failed", { toolCallId: _toolCallId, error: String(error) });
		}
	};
	const preservingOnUpdate: OnUpdateCallback = (partial) => {
		if (!acceptDispatchUpdates) return;
		captureDetails(partial.details);
		// Never treat callback frequency as progress. Runner-owned results advance
		// progressGeneration for lifecycle/model/tool/terminal activity (including
		// propagated nested children); old snapshots fall back to semantic changes.
		if (observeProgress(partial.details)) renewSettlementDeadline?.();
		deliverUpdate(partial);
	};
	const fallbackResults = (cause: string): SingleResult[] => [{
		agent: params.agent,
		agentSource: "unknown",
		task: params.task,
		exitCode: 1,
		messages: [],
		stderr: cause,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		stopReason: "error",
		errorMessage: cause,
	}];
	const terminalDetails = (cause: string): SubagentDetails => {
		if (!latestDetails) return compactSubagentDetails(makeDetailsBound(fallbackResults(cause)));
		return compactSubagentDetails({
			...latestDetails,
			results: latestDetails.results.map((result) => {
				// exitCode is authoritative; runningTools/streaming can be stale when
				// the nested lifecycle ends without its final event.
				if (result.exitCode !== -1) return result;
				return {
					...result,
					exitCode: 1,
					streaming: false,
					runningTools: [],
					activityPhase: "failed",
					activityDetail: cause,
					stopReason: "error",
					errorMessage: result.errorMessage ?? cause,
					stderr: result.stderr || cause,
				};
			}),
		});
	};

	const settlementMs = resolveSettlementMs();
	if (settlementMs <= 0) {
		return dispatchSingle(
			params,
			ctx,
			agents,
			runtimeCtx,
			makeDetailsBound,
			preservingOnUpdate,
			signal,
			selectionCtx,
			_toolCallId,
			ctx.hasUI ? (ctx.ui as unknown as ParentBridge) : undefined,
			parentSessionId,
			allToolNames,
			settlementClock,
		);
	}

	// Combine the parent signal with a settlement controller so a settlement
	// abort propagates into runner.ts just like a user "Stop" (the runner's
	// pre-spawn `raceAbort` and prompt-phase abort both honor it).
	const settlementController = new AbortController();
	const combinedRunSignal = signal
		? combineSignals(signal, settlementController.signal)
		: { signal: settlementController.signal, cleanup: () => {} };
	const runSignal = combinedRunSignal.signal;

	let settlementTimer: RetryTimer | undefined;
	let settlementDeadlineActive = true;
	let lastSettlementProgressAt = settlementClock.now();
	let resolveSettlementDeadline!: (value: typeof FORCE_SETTLE) => void;
	const settlementTimerPromise = new Promise<typeof FORCE_SETTLE>((resolve) => {
		resolveSettlementDeadline = resolve;
	});
	const armSettlementDeadline = (): void => {
		if (!settlementDeadlineActive) return;
		settlementTimer?.cancel();
		lastSettlementProgressAt = settlementClock.now();
		const timer = settlementClock.setTimer(activeSettlementMs);
		settlementTimer = timer;
		void timer.promise.then(() => {
			if (settlementTimer !== timer || !settlementDeadlineActive) return;
			settlementTimer = undefined;
			settlementDeadlineActive = false;
			resolveSettlementDeadline(FORCE_SETTLE);
		});
	};
	renewSettlementDeadline = armSettlementDeadline;
	armSettlementDeadline();

	const dispatchPromise = dispatchSingle(
		params,
		ctx,
		agents,
		runtimeCtx,
		makeDetailsBound,
		preservingOnUpdate,
		runSignal,
		selectionCtx,
		_toolCallId,
		ctx.hasUI ? (ctx.ui as unknown as ParentBridge) : undefined,
		parentSessionId,
		allToolNames,
		settlementClock,
	);
	// Observe a late rejection from an orphaned dispatch so it never surfaces as
	// unhandled, but retain the root cause in diagnostics after force-settlement.
	let forceSettlementTriggered = false;
	void dispatchPromise.catch((error) => {
		if (forceSettlementTriggered) {
			logLoud("dispatch rejected after force-settle", {
				toolCallId: _toolCallId,
				mode,
				error: toErrorMessage(error),
			});
		}
	});

	try {
		const winner = await Promise.race([dispatchPromise, settlementTimerPromise]);
		if (winner !== FORCE_SETTLE) {
			// Dispatch returned first (normal case AND the abort-quickly case,
			// because on settlement abort runner.ts aborts and returns its own
			// abort result, which dispatchToMode turns into the response).
			return winner;
		}

		// FORCE_SETTLE won: the dispatch hasn't returned within the deadline.
		// Abort the run so runner.ts can return a proper abort result, then give
		// the dispatch a short grace to surface that result (prefer the real
		// abort result over a synthesized one). Loud-log + user-visible message.
		const idleMs = Math.max(0, settlementClock.now() - lastSettlementProgressAt);
		const expiredSettlementMs = activeSettlementMs;
		const cause = `subagent settlement inactivity deadline exceeded (${expiredSettlementMs / 1000}s without progress)`;
		forceSettlementTriggered = true;
		settlementController.abort(new Error(cause));
		logLoud("subagent force-settled", {
			toolCallId: _toolCallId,
			mode,
			stage: "settlement-inactivity-deadline",
			settlementMs: expiredSettlementMs,
			idleMs,
			cause,
		});
		deliverUpdate({
			content: [textContent(`⚠ Subagent force-settled after ${expiredSettlementMs / 1000}s without progress. This is a bug — please report. See logs for [pie:subagent].`)],
			details: terminalDetails(cause),
		});

		const graceMs = resolveSettlementGraceMs();
		const graceTimer = settlementClock.setTimer(graceMs);
		const gracePromise: Promise<typeof FORCE_SETTLE> = graceTimer.promise.then(() => FORCE_SETTLE);
		try {
			const graceWinner = await Promise.race([dispatchPromise, gracePromise]);
			if (graceWinner !== FORCE_SETTLE) {
				// The settled dispatch may carry terminal attempt analytics that were
				// never emitted through onUpdate. Capture them before applying the
				// force-settlement terminal projection so host persistence retains the
				// real attempt evidence instead of degrading this call to unknown.
				captureDetails(graceWinner.details);
				return {
					...graceWinner,
					details: terminalDetails(cause),
				};
			}
		} finally {
			graceTimer.cancel();
		}

		// Dispatch still didn't settle after the grace window: synthesize a
		// terminal error toolResult so the SDK writes a result and the parent
		// transcript records the failure rather than dangling forever.
		return {
			content: [textContent(`Subagent made no progress for ${expiredSettlementMs / 1000}s and was force-settled. This is a bug — please report.`)],
			details: terminalDetails(cause),
			isError: true,
		};
	} finally {
		acceptDispatchUpdates = false;
		renewSettlementDeadline = undefined;
		settlementDeadlineActive = false;
		settlementTimer?.cancel();
		combinedRunSignal.cleanup();
	}
}
