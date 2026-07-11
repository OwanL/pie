/**
 * Subagent execution orchestrator and supporting functions.
 */

import type { ExtensionAPI, ToolContext } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonOrThrow } from "../../../shared/error-message.js";
import { type AgentConfig, type AgentScope, discoverAgents } from "../agents.js";
import {
	readRuntimeContext,
	consumeTreeSlot,
	getMaxDepth,
	type SubagentRuntimeContext,
} from "../runner.js";
import { SubagentParams } from "../schema.js";
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
	getAllowedModelIdsForProviders,
	getDisabledProviders,
	loadModelConfig,
	parseProviderToggles,
	readBucketAssignments,
	readNestedAllowedBuckets,
	downgradeBucketForNested,
	selectModel,
} from "../bucket-selector.js";
import { MAX_SESSIONS_PER_CALL, makeDetails } from "./helpers.js";
import type { ParentBridge } from "./parent-extension-ui-bridge-proxy.js";
// Model-selection primitives (SelectionContext, resolveModel, …) now live in
// ./selection.ts. They are imported here for local use and re-exported below so
// existing `from "./execute.js"` imports (incl. tests) keep resolving. This
// extraction breaks the execute↔modes circular import that caused parallel
// subagent dispatch to crash with `Cannot read properties of undefined
// (reading 'checkTrailLoop')` under pi's TS→CJS loader.
import {
	resolveModel,
	attachSelectionMetadata,
	isModelFailure,
	checkTrailLoop,
	type SelectionContext,
} from "./selection.js";

/** Root of the pi-config repo, resolved from this extension's known position. */
const CONFIG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Environment key used by the pie host to force sub-agents to use the parent model. */
const SUBAGENT_ALWAYS_PARENT_MODEL_ENV = "PIE_SUBAGENT_ALWAYS_PARENT_MODEL";

/** Reads the always-parent-model override from the environment (set by the pie host). */
export function readAlwaysParentModel(): boolean {
	const raw = process.env[SUBAGENT_ALWAYS_PARENT_MODEL_ENV];
	return raw === "1" || raw === "true";
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

/**
 * Validates exactly-one-mode and agent name existence.
 * Returns the selected mode and any invalid agent results.
 */
export function validateSubagentParams(
	params: SubagentParams,
	agents: AgentConfig[],
):
	| { ok: true; mode: "single" | "parallel" | "chain"; invalidResults: SingleResult[] }
	| { ok: false; invalidResults: SingleResult[] } {
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
	if (modeCount !== 1) {
		return {
			ok: false,
			invalidResults: [
				{
					agent: "",
					agentSource: "unknown",
					task: "",
					exitCode: 1,
					messages: [],
					stderr: "Invalid parameters. Provide exactly one mode.",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				},
			],
		};
	}

	const mode = hasChain ? "chain" : hasTasks ? "parallel" : "single";

	const invalidResults: SingleResult[] = [];
	if (params.chain) {
		for (let i = 0; i < params.chain.length; i++) {
			const step = params.chain[i];
			if (!agents.some((a) => a.name === step.agent)) {
				invalidResults.push(createInvalidAgentResult(step.agent, step.task, agents, i + 1));
			}
		}
	}
	if (params.tasks) {
		for (const task of params.tasks) {
			if (!agents.some((a) => a.name === task.agent)) {
				invalidResults.push(createInvalidAgentResult(task.agent, task.task, agents));
			}
		}
	}
	if (params.agent && params.task && !agents.some((a) => a.name === params.agent)) {
		invalidResults.push(createInvalidAgentResult(params.agent, params.task, agents));
	}

	return { ok: true, mode, invalidResults };
}

// resolveModel / attachSelectionMetadata / isModelFailure / checkTrailLoop moved to
// ./selection.ts. Re-exported here so existing `from "./execute.js"` imports
// (incl. tests) keep resolving. modes.ts now imports them directly from
// ./selection.ts, which removes the execute↔modes circular import.
export { resolveModel, attachSelectionMetadata, isModelFailure, checkTrailLoop, type SelectionContext };

/** Standard error response shape used by early returns. */
export type Mode = "single" | "parallel" | "chain";
type ErrorResponse = { content: { type: "text"; text: string }[]; details: SubagentDetails; isError: true };

/** Environment key for the last-resort settlement deadline (milliseconds).
 *  See {@link resolveSettlementMs}. */
const SETTLEMENT_ENV = "PIE_SUBAGENT_SETTLEMENT_MS";
/** Default settlement net: 30 minutes. This is a defense-in-depth last resort,
 *  NOT the primary hang fix — abort propagation (Slice A) and abortable
 *  concurrency (Slice A) handle the known hang classes structurally. The net
 *  exists so that even a future bug that reintroduces an unbounded wait can't
 *  dangle the parent session forever. */
export const DEFAULT_SETTLEMENT_MS = 30 * 60 * 1000;

/** Resolve the settlement deadline for a subagent tool call, in milliseconds.
 *
 * Reads `PIE_SUBAGENT_SETTLEMENT_MS`:
 * - Unset/empty → {@link DEFAULT_SETTLEMENT_MS} (the net is ON by default).
 * - `0` → explicitly disabled (no net; only for debugging/emergency).
 * - A positive number → the deadline in ms.
 * - Invalid (NaN/negative) → {@link DEFAULT_SETTLEMENT_MS}.
 *
 * Returns the deadline in ms, or `0` to disable the net entirely.
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

/** Sentinel resolved by the settlement timer when the dispatch hasn't returned. */
const FORCE_SETTLE = Symbol("pie:subagent:force-settle");

/** Loud log for a settlement / hardening event. Mirrors the runner's `logLoud`
 *  shape so logs are uniformly grep-able under `source: "pie:subagent"`. Kept
 *  local to execute.ts to avoid a new cross-module import for one helper. */
function logLoud(event: string, details: Record<string, unknown>): void {
	console.error(JSON.stringify({ source: "pie:subagent", event, ...details }));
}

/** Returns the standard response when the tool is disabled. */
function disabledErrorResponse(params: SubagentParams): ErrorResponse {
	return {
		content: [
			{
				type: "text",
				text: "Sub agents are disabled. Enable them by removing the --no-subagent flag or unsetting the PI_SUBAGENT_DISABLED environment variable.",
			},
		],
		details: {
			mode: "single" as const,
			agentScope: params.agentScope ?? "user",
			projectAgentsDir: null,
			results: [],
		},
		isError: true,
	};
}

/** Returns the standard response when subagents are disabled via maxDepth = 0. */
function subagentsDisabledResponse(params: SubagentParams, maxDepth: number): ErrorResponse {
	return {
		content: [
			{
				type: "text",
				text: `Subagents are disabled (nesting levels set to ${maxDepth}). Set "Nesting levels" above 0 to delegate to subagents.`,
			},
		],
		details: {
			mode: "single" as const,
			agentScope: params.agentScope ?? "user",
			projectAgentsDir: null,
			results: [],
		},
		isError: true,
	};
}

/** Returns the standard response when subagent depth limit is reached. */
function depthLimitResponse(agentScope: AgentScope, maxDepth: number): ErrorResponse {
	return {
		content: [
			{
				type: "text",
				text: `Subagent depth limit reached (max ${maxDepth}). Cannot spawn further subagents.`,
			},
		],
		details: { mode: "single", agentScope, projectAgentsDir: null, results: [] },
		isError: true,
	};
}

/** Returns the standard response when the caller's canSpawn allowlist blocks a requested agent. */
function cannotSpawnResponse(
	disallowed: string[],
	mode: Mode,
	agentScope: AgentScope,
	projectAgentsDir: string | null,
): ErrorResponse {
	const listing = disallowed.map((n) => `"${n}"`).join(", ");
	return {
		content: [
			{
				type: "text",
				text: `Not permitted to spawn ${listing}: blocked by the caller's canSpawn allowlist. Choose an agent the caller is allowed to delegate to.`,
			},
		],
		details: makeDetails(mode, [], agentScope, projectAgentsDir),
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

/** Builds a counter that returns an error message after `MAX_SESSIONS_PER_CALL` invocations. */
function createSessionLimitChecker(): () => string | undefined {
	let sessionsSpawned = 0;
	return () => {
		if (++sessionsSpawned > MAX_SESSIONS_PER_CALL) {
			return `Sub-agent session limit reached (max ${MAX_SESSIONS_PER_CALL} sessions per reply).`;
		}
		return undefined;
	};
}

/** Returns a response when the caller provided zero or multiple execution modes. */
function modeCountErrorResponse(
	agents: AgentConfig[],
	agentScope: AgentScope,
	projectAgentsDir: string | null,
): ErrorResponse {
	const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
	return {
		content: [
			{
				type: "text",
				text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
			},
		],
		details: makeDetails("single", [], agentScope, projectAgentsDir),
		isError: true,
	};
}

/** Returns a response when one or more requested agent names do not exist. */
function invalidAgentsResponse(
	invalidResults: SingleResult[],
	mode: Mode,
	agentScope: AgentScope,
	projectAgentsDir: string | null,
): ErrorResponse {
	return {
		content: [{ type: "text", text: summarizeInvalidAgentResults(invalidResults) }],
		details: makeDetails(mode, invalidResults, agentScope, projectAgentsDir),
		isError: true,
	};
}

/** Collect the unique agent names referenced by `params` (chain, tasks, or single). */
function collectRequestedAgentNames(params: SubagentParams): Set<string> {
	const names = new Set<string>();
	if (params.chain) for (const step of params.chain) names.add(step.agent);
	if (params.tasks) for (const t of params.tasks) names.add(t.agent);
	if (params.agent) names.add(params.agent);
	return names;
}

/** Confirms project-local agent usage with the user; returns undefined on approval, response on cancel. */
export async function maybeApproveProjectAgents(
	params: SubagentParams,
	agents: AgentConfig[],
	discovery: ReturnType<typeof discoverAgents>,
	agentScope: AgentScope,
	mode: Mode,
	ctx: ToolContext,
): Promise<ErrorResponse | undefined> {
	if (
		!(agentScope === "project" || agentScope === "both") ||
		!(params.confirmProjectAgents ?? readSubagentConfirmDefault() ?? true) ||
		!ctx.hasUI
	) {
		return undefined;
	}

	const projectAgentsRequested = Array.from(collectRequestedAgentNames(params))
		.map((name) => agents.find((a) => a.name === name))
		.filter((a): a is AgentConfig => a?.source === "project");

	if (projectAgentsRequested.length === 0) return undefined;

	const names = projectAgentsRequested.map((a) => a.name).join(", ");
	const dir = discovery.projectAgentsDir ?? "(unknown)";
	const ok = await ctx.ui.confirm(
		"Run project-local agents?",
		`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
	);
	if (ok) return undefined;

	return {
		content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
		details: makeDetails(mode, [], agentScope, discovery.projectAgentsDir),
		isError: true,
	};
}

/** Loads simple model config, reads user-configured buckets, and builds provider/model allowlists. */
function setupModelSelection(ctx: ToolContext): SelectionContext {
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
	const availableModels = ctx.modelRegistry.getAvailable();
	const allowedModelIds = new Set<string>(
		availableModels
			.filter((m) => !disabledProviders.has(m.provider))
			.map((m) => m.id),
	);

	return { modelConfig, disabledProviders, allowedModelIds, bucketAssignments, alwaysParentModel: readAlwaysParentModel(), nestedAllowedBuckets: readNestedAllowedBuckets() };
}

/** Memoized handle to the dynamically-imported modes module.
 *
 *  `dispatchToMode` used to call `await import("./modes.js")` fresh on every
 *  invocation. Parallel-mode subagent dispatch calls `execute()` — and
 *  therefore `dispatchToMode` — concurrently, multiple times, from the same
 *  process. Under pi's on-the-fly TS→CJS extension loader, concurrent
 *  `import()` calls for the *same* specifier are not guaranteed to be
 *  deduped/serialized the way a spec-compliant ESM loader would: a second
 *  call can observe a not-yet-fully-populated module object from the first
 *  call's in-flight (re-)transpile, surfacing as
 *  `Cannot read properties of undefined (reading 'checkTrailLoop')` — this
 *  recurred even after the execute↔modes circular-import fix, confirming the
 *  race is independent of the cycle. Caching the promise here means the
 *  module is imported exactly once per process; every caller (sequential or
 *  concurrent) awaits the same settled promise instead of re-triggering the
 *  loader. On failure the cached promise is cleared so a subsequent call can
 *  retry rather than being permanently stuck on a rejected import. */
let modesModulePromise: Promise<typeof import("./modes.js")> | undefined;
function loadModesModule(): Promise<typeof import("./modes.js")> {
	if (!modesModulePromise) {
		modesModulePromise = import("./modes.js").catch((err) => {
			modesModulePromise = undefined;
			throw err;
		});
	}
	return modesModulePromise;
}

/** Routes the validated request to the mode-specific execution function. */
async function dispatchToMode(
	mode: Mode,
	params: SubagentParams,
	ctx: ToolContext,
	agents: AgentConfig[],
	checkSessionLimit: () => string | undefined,
	runtimeCtx: SubagentRuntimeContext,
	makeDetailsBound: (m: Mode, res: SingleResult[]) => SubagentDetails,
	onUpdate: OnUpdateCallback,
	signal: AbortSignal,
	selectionCtx: SelectionContext,
	_toolCallId: string,
	parentUiBridge: ParentBridge | undefined,
	parentSessionId: string | undefined,
	allToolNames: string[] | undefined,
) {
	// Lazy import to avoid circular dependencies (see loadModesModule for why
	// this is memoized rather than a bare `await import(...)` per call).
	const { executeChainMode, executeParallelMode, executeSingleMode } = await loadModesModule();

	const modeArgs = [
		params,
		ctx,
		agents,
		checkSessionLimit,
		runtimeCtx,
		makeDetailsBound,
		onUpdate,
		signal,
		selectionCtx,
		_toolCallId,
		parentUiBridge,
		parentSessionId,
		allToolNames,
	] as const;
	if (mode === "chain") return executeChainMode(...modeArgs);
	if (mode === "parallel") return executeParallelMode(...modeArgs);
	return executeSingleMode(...modeArgs);
}

/** Main execute function for the subagent tool. */
export async function execute(
	_toolCallId: string,
	params: SubagentParams,
	signal: AbortSignal,
	onUpdate: OnUpdateCallback,
	ctx: ToolContext,
	_pi: ExtensionAPI,
	isDisabled: () => boolean,
) {
	if (isDisabled()) return disabledErrorResponse(params);

	const explicitScope = params.agentScope;
	let agentScope: AgentScope = explicitScope ?? "user";
	const runtimeCtx = readRuntimeContext();
	const maxDepth = getMaxDepth();
	if (maxDepth === 0) return subagentsDisabledResponse(params, maxDepth);
	if (runtimeCtx.depth >= maxDepth) return depthLimitResponse(agentScope, maxDepth);

	// Seed the shared tree-wide session budget at the outermost call. Nested
	// calls inherit it via the AsyncLocalStorage context (see modes.ts buildRuntime).
	if (!runtimeCtx.budget) runtimeCtx.budget = { sessions: 0 };

	const checkSessionLimit = createSessionLimitChecker();
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
	if (params.tasks) for (const t of params.tasks) if (t.cwd) discoveryCwds.push(t.cwd);
	if (params.chain) for (const s of params.chain) if (s.cwd) discoveryCwds.push(s.cwd);
	let discovery = discoverAgents(discoveryCwds, agentScope);
	// Auto-escalate: when the caller relied on the default "user" scope and no
	// agents were discovered (e.g. PI_CODING_AGENT_DIR unset and
	// ~/.pi/agent/agents absent), retry with "both" so project-local agents
	// (this repo's agents/) are found instead of failing with a silent
	// "Available agents: none". A caller who explicitly passes agentScope is
	// respected as-is — this only recovers the implicit-default case.
	if (!explicitScope && discovery.agents.length === 0) {
		const escalated = discoverAgents(discoveryCwds, "both");
		if (escalated.agents.length > 0) {
			discovery = escalated;
			agentScope = "both";
		}
	}
	const agents = discovery.agents;
	const validation = validateSubagentParams(params, agents);
	if (!validation.ok) {
		return modeCountErrorResponse(agents, agentScope, discovery.projectAgentsDir);
	}
	const { mode, invalidResults } = validation;

	if (invalidResults.length > 0) {
		return invalidAgentsResponse(invalidResults, mode, agentScope, discovery.projectAgentsDir);
	}

	// Enforce the caller's canSpawn allowlist. The root caller (main agent) has
	// no canSpawn → unrestricted. An agent with a canSpawn list may only spawn the
	// named agents, preserving invariants such as read-only-only delegation.
	const callerCanSpawn = runtimeCtx.canSpawn;
	const disallowed = disallowedByCanSpawn(callerCanSpawn, collectRequestedAgentNames(params));
	if (disallowed.length > 0) {
		return cannotSpawnResponse(disallowed, mode, agentScope, discovery.projectAgentsDir);
	}

	const approvalError = await maybeApproveProjectAgents(params, agents, discovery, agentScope, mode, ctx);
	if (approvalError) return approvalError;

	const selectionCtx = setupModelSelection(ctx);
	const makeDetailsBound = (m: Mode, res: SingleResult[]) =>
		makeDetails(m, res, agentScope, discovery.projectAgentsDir);

	// Resolve the parent (main) session id and the full tool-name set once per
	// subagent tool call, so subagents can (a) inherit the main turn's pruned
	// skills by looking up the skill-pruner's kept set, and (b) have the
	// user-configured drop-tools list subtracted from unrestricted agents.
	// Both are defensive: undefined when unresolvable → today's behavior.
	const parentSessionId = (ctx as { sessionManager?: { getSessionId?: () => string } }).sessionManager?.getSessionId?.();
	let allToolNames: string[] | undefined;
	try {
		allToolNames = _pi.getAllTools().map((t) => t.name);
	} catch {
		allToolNames = undefined;
	}

	// Settlement net (last-resort, defense-in-depth): guarantee `execute()`
	// ALWAYS returns within `settlementMs` even if a downstream phase (a future
	// bug, an SDK that ignores abort, a dead provider stream the proxy didn't
	// surface) hangs forever. This is NOT the primary hang fix — abort
	// propagation (Slice A) + abortable concurrency (Slice A) + dead-stream
	// surfacing at the proxy (Slice C) handle the known hang classes
	// structurally. The net exists so the parent session can *never* dangle even
	// if a future bug reintroduces an unbounded wait. On timeout it aborts the
	// run (so runner.ts can return its own abort result), then force-returns a
	// synthesized error toolResult if the dispatch still doesn't settle.
	// Retain the latest immutable progress snapshot at the execute boundary. If
	// the last-resort settlement net fires, completed siblings and partial child
	// output must survive; only children that are still running are terminalized.
	let latestDetails: SubagentDetails | undefined;
	const captureDetails = (details: SubagentDetails | undefined): void => {
		if (!details?.results) return;
		const previous = latestDetails?.results ?? [];
		latestDetails = {
			...details,
			results: details.results.map((result, index) => ({
				...previous[index],
				...result,
				// Preserve partial prose across the settlement-triggered abort update.
				streamingText: result.streamingText ?? previous[index]?.streamingText,
			})),
		};
	};
	const preservingOnUpdate: OnUpdateCallback = (partial) => {
		captureDetails(partial.details);
		onUpdate?.(partial);
	};
	const fallbackResults = (cause: string): SingleResult[] => {
		const requested = mode === "single"
			? [{ agent: params.agent ?? "unknown", task: params.task ?? "" }]
			: mode === "parallel"
				? (params.tasks ?? [])
				: (params.chain ?? []);
		return requested.map((item, index) => ({
			agent: item.agent,
			agentSource: "unknown",
			task: item.task,
			exitCode: 1,
			messages: [],
			stderr: cause,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			stopReason: "error",
			errorMessage: cause,
			...(mode === "chain" ? { step: index + 1 } : {}),
		}));
	};
	const terminalDetails = (cause: string): SubagentDetails => {
		if (!latestDetails) return makeDetailsBound(mode, fallbackResults(cause));
		return {
			...latestDetails,
			results: latestDetails.results.map((result) => {
				const running = result.exitCode === -1 || result.streaming === true || (result.runningTools?.length ?? 0) > 0;
				if (!running) return result;
				return {
					...result,
					exitCode: 1,
					streaming: false,
					runningTools: [],
					stopReason: "error",
					errorMessage: result.errorMessage ?? cause,
					stderr: result.stderr || cause,
				};
			}),
		};
	};

	const settlementMs = resolveSettlementMs();
	if (settlementMs <= 0) {
		return dispatchToMode(
			mode,
			params,
			ctx,
			agents,
			checkSessionLimit,
			runtimeCtx,
			makeDetailsBound,
			preservingOnUpdate,
			signal,
			selectionCtx,
			_toolCallId,
			ctx.hasUI ? (ctx.ui as unknown as ParentBridge) : undefined,
			parentSessionId,
			allToolNames,
		);
	}

	// Combine the parent signal with a settlement controller so a settlement
	// abort propagates into runner.ts just like a user "Stop" (the runner's
	// pre-spawn `raceAbort` and prompt-phase abort both honor it).
	const settlementController = new AbortController();
	const runSignal: AbortSignal =
		typeof AbortSignal.any === "function"
			? AbortSignal.any([signal, settlementController.signal])
			: signal;

	const dispatchPromise = dispatchToMode(
		mode,
		params,
		ctx,
		agents,
		checkSessionLimit,
		runtimeCtx,
		makeDetailsBound,
		preservingOnUpdate,
		runSignal,
		selectionCtx,
		_toolCallId,
		ctx.hasUI ? (ctx.ui as unknown as ParentBridge) : undefined,
		parentSessionId,
		allToolNames,
	);
	// Swallow a late rejection from an orphaned dispatch so it never surfaces as
	// an unhandled rejection after we've already returned a synthesized result.
	dispatchPromise.catch(() => {});

	let settlementTimer: NodeJS.Timeout | undefined;
	const settlementTimerPromise: Promise<typeof FORCE_SETTLE> = new Promise((resolve) => {
		settlementTimer = setTimeout(() => resolve(FORCE_SETTLE), settlementMs);
		// Allow the process to exit even if the timer is still armed (defensive:
		// the timer is cleared in the finally below on the normal path).
		settlementTimer.unref?.();
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
		const cause = `subagent settlement deadline exceeded (${settlementMs / 1000}s)`;
		settlementController.abort(new Error(cause));
		logLoud("subagent force-settled", {
			toolCallId: _toolCallId,
			mode,
			stage: "settlement-deadline",
			settlementMs,
			cause,
		});
		onUpdate?.({
			content: [
				{ type: "text", text: `⚠ Subagent force-settled: did not return within ${settlementMs / 1000}s. This is a bug — please report. See logs for [pie:subagent].` },
			],
			details: terminalDetails(cause),
		});

		const graceMs = resolveSettlementGraceMs();
		let graceTimer: NodeJS.Timeout | undefined;
		const gracePromise: Promise<typeof FORCE_SETTLE> = new Promise((resolve) => {
			graceTimer = setTimeout(() => resolve(FORCE_SETTLE), graceMs);
			graceTimer.unref?.();
		});
		try {
			const graceWinner = await Promise.race([dispatchPromise, gracePromise]);
			if (graceWinner !== FORCE_SETTLE) {
				return {
					...graceWinner,
					details: terminalDetails(cause),
				};
			}
		} finally {
			if (graceTimer) clearTimeout(graceTimer);
		}

		// Dispatch still didn't settle after the grace window: synthesize a
		// terminal error toolResult so the SDK writes a result and the parent
		// transcript records the failure rather than dangling forever.
		return {
			content: [
				{
					type: "text",
					text: `Subagent did not settle within ${settlementMs / 1000}s and was force-settled. This is a bug — please report.`,
				},
			],
			details: terminalDetails(cause),
			isError: true,
		};
	} finally {
		if (settlementTimer) clearTimeout(settlementTimer);
	}
}
