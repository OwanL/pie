/**
 * In-process subagent runner. Uses the pi SDK directly via `createAgentSession`
 * so subagents share the parent's auth, model registry, and OAuth tokens.
 *
 * This replaces the previous CLI-subprocess approach (`pi --mode json -p ...`),
 * which failed for newer models routed through the GitHub Copilot gateway.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Message, Model } from "@mariozechner/pi-ai";
import type {
	AgentSession,
	CreateAgentSessionOptions,
	CreateAgentSessionResult,
	DefaultResourceLoader,
	ModelRegistry,
	ResourceDiagnostic,
	SessionManager,
	Skill,
} from "@mariozechner/pi-coding-agent";

import type { AgentConfig } from "./agents.js";
import { textContent } from "./src/text-content.js";
import { formatSubagentPrompt, type UserContextMode } from "./src/user-context.js";
import { getFinalOutput } from "./formatting.js";
import type { ThinkingLevel, BucketSelection } from "./bucket-selector.js";
import { resolveExecutionModel } from "./model-resolution.js";
import { formatRequirementDiagnostic, requirementIsActive } from "./src/selection.js";
import type { ModelRequirements, OnUpdateCallback, SingleResult, SubagentAttemptPhase, SubagentDetails, SubagentTurnThroughputSample } from "./types.js";
import { createInvalidAgentResult } from "./validation.js";
import { toErrorMessage } from "../../shared/error-message.js";
import { subagentContext } from "../../shared/subagent-context.js";
import { readKeptSkills } from "../../shared/pruned-skills.js";
import { readProviderCapacitySnapshot } from "../../shared/provider-capacity-bridge.js";
import {
	readAlwaysParentModelFromEnv,
	readRouteAroundSaturatedProviders,
} from "./src/provider-capacity.js";
import {
	classifyProviderFailure,
	markProviderReplayUnsafe,
} from "./src/provider-failure.js";
import {
	ParentExtensionUIBridgeProxy,
	type ParentBridge,
} from "./src/parent-extension-ui-bridge-proxy.js";
import { inflightSemaphore, type Release } from "./src/concurrency-limit.js";
import { globalOrphanRegistry, type OrphanCleanupRegistry } from "./src/cleanup.js";
import type { RetryClock } from "./src/retry.js";

type SubagentSkillsOverride = (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => { skills: Skill[]; diagnostics: ResourceDiagnostic[] };

/**
 * Minimal contract for the session events emitted by the pi SDK's
 * `createAgentSession` session. Mirrors the backend's `SdkSessionEvent`
 * (extension/src/backend/sdk.ts) — the SAME SDK's event surface — but defined
 * LOCALLY in the subagent package to avoid a cross-tree import (S9).
 * Typed only for the fields the subagent actually consumes; unknown SDK
 * fields are intentionally omitted to keep the minimal contract minimal.
 */
interface SubagentSessionEvent {
	type:
		| "session_start"
		| "agent_start"
		| "agent_end"
		| "message_start"
		| "message_update"
		| "message_end"
		| "tool_execution_start"
		| "tool_execution_update"
		| "tool_execution_end"
		| string;
	message?: SubagentEventMessage;
	assistantMessageEvent?: {
		type: "text_delta" | "thinking_delta" | string;
		delta?: string;
		thinking?: string;
	};
	toolCallId?: string;
	toolName?: string;
	/** Partial result from a tool's `onUpdate` callback. Present on
	 * `tool_execution_update` events — the exact event that carries a nested
	 * (depth ≥ 2) subagent's streaming output on the depth-1 session. */
	partialResult?: unknown;
}

/**
 * Minimal message shape carried on session events. The SDK's runtime event
 * `message` is a partial/streaming shape, so this is NOT the full `Message`
 * from `@mariozechner/pi-ai` — only the fields the subagent reads. Consumers
 * that need the full `Message` (e.g. to push into `result.messages`) narrow
 * via the existing `as Message` cast.
 */
interface SubagentEventMessage {
	role?: string;
	content?: unknown;
	stopReason?: string;
	model?: string;
	provider?: string;
	errorMessage?: string;
	timestamp?: number;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number };
		totalTokens?: number;
	};
}

interface SessionLike {
	agent?: { state?: { model?: { id: string } } };
	extensionRunner: { setUIContext: (ctx: unknown) => void };
	subscribe: (cb: (event: SubagentSessionEvent) => void) => () => void;
	prompt: (prompt: string) => Promise<void>;
	abort: () => Promise<void>;
	dispose: () => void;
}

interface ResourceLoaderLike {
	reload: () => Promise<void>;
}

interface SubagentSdk {
	createSession: (args: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
	createResourceLoader: (args: ConstructorParameters<typeof DefaultResourceLoader>[0]) => DefaultResourceLoader;
	createSessionManager: (cwd: string) => SessionManager;
	getAgentDir: () => string;
}

let cachedSdkPromise: Promise<SubagentSdk> | undefined;
let orphanAttemptCounter = 0;

/**
 * Generate a stable, globally-unique attempt identity. The same id is used for
 * orphan cleanup registry entries and per-attempt analytics, so a late-resolved
 * pre-spawn session can be correlated with its dispatch attempt.
 */
export function nextAttemptIdentity(agentName: string, toolCallId: string | undefined): string {
	return `${agentName}:${toolCallId ?? "no-tool-call"}:${orphanAttemptCounter++}`;
}

async function loadSubagentSdk(): Promise<SubagentSdk> {
	if (!cachedSdkPromise) {
		cachedSdkPromise = import("@mariozechner/pi-coding-agent").then((sdk) => ({
			createSession: sdk.createAgentSession,
			createResourceLoader: (args) => new sdk.DefaultResourceLoader(args),
			createSessionManager: (cwd) => sdk.SessionManager.inMemory(cwd),
			getAgentDir: sdk.getAgentDir,
		} as SubagentSdk));
	}
	return cachedSdkPromise;
}

/** Environment key for overriding the per-prompt subagent timeout (milliseconds). */
const SUBAGENT_TIMEOUT_ENV = "PI_SUBAGENT_TIMEOUT_MS";

/** No absolute per-prompt timeout is applied unless explicitly opted in. */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 0;

/**
 * Resolve the optional absolute per-prompt timeout for subagent runs.
 *
 * `PI_SUBAGENT_TIMEOUT_MS` is an opt-in containment ceiling: only a finite,
 * positive value enables it. Unset, empty, zero, negative, and non-finite
 * values all return `0`, leaving parent cancellation and the renewable
 * tree-wide settlement inactivity lease to handle a stalled child.
 */
export function resolveSubagentTimeoutMs(): number {
	const raw = process.env[SUBAGENT_TIMEOUT_ENV];
	if (raw === undefined || raw === "") return 0;
	const ms = Number(raw);
	return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * Mutable counter shared across an entire nested subagent tree via
 * {@link subagentRuntime}. A fresh one is created at the outermost call and
 * threaded down to every child so a tree-wide session budget can be enforced.
 */
export interface TreeBudget {
	sessions: number;
}

/**
 * Async-local context carried through nested subagent invocations.
 * Replaces the old PI_SUBAGENT_DEPTH / PI_SUBAGENT_TRAIL environment variables
 * (which only worked across subprocess boundaries).
 *
 * - `depth` / `trail` bound and trace the ancestry.
 * - `canSpawn` carries the *current* session agent's `canSpawn` allowlist (from
 *   its frontmatter) so the child tool call can enforce caller-restricted
 *   spawning without re-discovering the caller. `undefined` at the root caller
 *   (the main agent) and for agents without a `canSpawn` field → unrestricted.
 * - `budget` is the shared tree-wide session counter; created at the root call.
 */
export interface ProcessPermitScope {
	/** The root child owns this release handle. Descendants borrow the scope and
	 * never acquire another process permit, avoiding parent/child deadlock. */
	release: Release;
}

export interface SubagentRuntimeContext {
	depth: number;
	trail: string[];
	canSpawn?: string[];
	budget?: TreeBudget;
	/** Main chat session whose per-session provider policy applies to this tree. */
	rootSessionPath?: string;
	/** Effective subagent-only provider policy snapshotted by the root call. Child
	 * sessions have in-memory session managers, so they must inherit this policy
	 * rather than trying to resolve a per-chat override from their own path. */
	subagentProviderToggles?: Record<string, boolean>;
	/** Main-turn skill selection inherited by every descendant. */
	keptSkills?: string[] | "keep-all";
	/** One process-wide permit held for the complete root-tree lifetime. */
	processPermitScope?: ProcessPermitScope;
}

export const subagentRuntime = new AsyncLocalStorage<SubagentRuntimeContext>();

/** Read current runtime context, falling back to legacy env vars for outermost call. */
export function readRuntimeContext(): SubagentRuntimeContext {
	const store = subagentRuntime.getStore();
	if (store) return store;
	const depth = parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10);
	const trail = (process.env.PI_SUBAGENT_TRAIL ?? "").split(",").filter(Boolean);
	return { depth, trail };
}

/** Environment key for the pie host to override the max nesting depth. */
const MAX_DEPTH_ENV = "PIE_SUBAGENT_MAX_DEPTH";
/** Default max nesting depth when no override is supplied. */
export const DEFAULT_MAX_DEPTH = 3;

/**
 * Resolve the max nesting depth for subagent calls. Reads
 * `PIE_SUBAGENT_MAX_DEPTH` from the environment (set by the pie host from the
 * settings menu). Unset or invalid → {@link DEFAULT_MAX_DEPTH}.
 */
export function getMaxDepth(): number {
	const raw = process.env[MAX_DEPTH_ENV];
	if (raw === undefined || raw === "") return DEFAULT_MAX_DEPTH;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_DEPTH;
}

/** Environment key for the pie host to override the tree-wide session budget. */
const MAX_TREE_SESSIONS_ENV = "PIE_SUBAGENT_MAX_TREE_SESSIONS";
/** Default tree-wide session budget when no override is supplied. */
export const DEFAULT_MAX_TREE_SESSIONS = 10;

/**
 * Resolve the tree-wide session budget — the max number of subagent sessions
 * permitted across an entire nested tree (not just one tool call). Reads
 * `PIE_SUBAGENT_MAX_TREE_SESSIONS` from the environment. Unset or invalid →
 * {@link DEFAULT_MAX_TREE_SESSIONS}.
 */
export function getMaxTreeSessions(): number {
	const raw = process.env[MAX_TREE_SESSIONS_ENV];
	if (raw === undefined || raw === "") return DEFAULT_MAX_TREE_SESSIONS;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_TREE_SESSIONS;
}

/**
 * Consume one tree-wide session slot. Increments the shared budget counter and
 * returns an error message when the tree budget is exhausted (the call that
 * exceeds the cap still counts, so the message is accurate). A missing budget
 * (should not happen past the root) is a no-op pass-through.
 */
export function consumeTreeSlot(budget: TreeBudget | undefined): string | undefined {
	if (!budget) return undefined;
	budget.sessions++;
	if (budget.sessions > getMaxTreeSessions()) {
		return `Sub-agent tree session limit reached (max ${getMaxTreeSessions()} sessions across the nested tree).`;
	}
	return undefined;
}

/**
 * Build the initial SingleResult for a subagent run. The result is mutated
 * in place as the session streams events back. Usage counters start at zero.
 */
function createInitialResult(
	agent: AgentConfig,
	agentName: string,
	task: string,
	step: number | undefined,
	actualModelId: string | undefined,
	provider: string | undefined,
	contextWindow: number | undefined,
	selectedModel: string | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	modelResolutionDiagnostic: string | undefined,
): SingleResult {
	const now = Date.now();
	const result: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: actualModelId,
		provider,
		contextWindow,
		selectedModel,
		thinkingLevel,
		activityPhase: "preparing",
		activityDetail: "loading subagent resources",
		activitySince: now,
		startedAt: now,
		progressGeneration: 0,
		lastProgressAt: now,
		step,
	};
	if (modelResolutionDiagnostic) {
		result.modelResolutionDiagnostic = modelResolutionDiagnostic;
	}
	return result;
}

/** Record a credible child event. The generation, not its timestamp, is the
 * settlement lease's source of truth: duplicate snapshots leave it unchanged. */
function markProgress(result: SingleResult): void {
	result.progressGeneration = (result.progressGeneration ?? 0) + 1;
	result.lastProgressAt = Date.now();
}

/** Attempt phases whose elapsed time can be measured locally. `retry_wait` is
 * deliberately absent: retry.ts records the reported backoff on the following
 * attempt, avoiding a second count of the same wait. */
const TIMED_ATTEMPT_PHASES = new Set<SubagentAttemptPhase>([
	"queued", "preparing", "waiting_provider", "streaming", "running_tool", "orphaned_cleanup",
]);

/** Close the previous observed phase into a fixed-key, finite accumulator. */
function accumulatePhaseDuration(result: SingleResult, now: number): void {
	const previous = result.activityPhase;
	const since = result.activitySince;
	if (!previous || !TIMED_ATTEMPT_PHASES.has(previous as SubagentAttemptPhase)
		|| typeof since !== "number" || !Number.isFinite(since)) return;
	const elapsed = Math.max(0, Math.trunc(now - since));
	const phase = previous as SubagentAttemptPhase;
	const prior = result.phaseDurationsMs?.[phase] ?? 0;
	const total = Math.min(Number.MAX_SAFE_INTEGER, prior + elapsed);
	result.phaseDurationsMs = { ...result.phaseDurationsMs, [phase]: total };
}

/** Move the published lifecycle state forward. Returns whether this was a real
 * transition and records one progress generation only for such transitions. */
function setActivity(
	result: SingleResult,
	phase: NonNullable<SingleResult["activityPhase"]>,
	detail?: string,
): boolean {
	if (result.activityPhase === phase && result.activityDetail === detail) return false;
	const now = Date.now();
	accumulatePhaseDuration(result, now);
	result.activityPhase = phase;
	result.activityDetail = detail;
	result.activitySince = now;
	if (phase === "completed" || phase === "failed" || phase === "cancelled") {
		result.completedAt = result.activitySince;
	}
	markProgress(result);
	return true;
}

/** Build the update emitter that publishes partial state to the parent UI. */
type UpdateEmitter = ((immediate?: boolean) => void) & { close: () => void };

function createUpdateEmitter(
	result: SingleResult,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	streamingTextRef: { value: string },
): UpdateEmitter {
	let lastEmittedAt = 0;
	let emittedFirstStreamingUpdate = false;
	let pendingTimer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	const emitNow = () => {
		pendingTimer = undefined;
		if (closed || !onUpdate) return;
		lastEmittedAt = Date.now();
		const finalOutput = getFinalOutput(result.messages);
		const text = finalOutput || streamingTextRef.value || "(running...)";
		onUpdate({
			content: [textContent(text)],
			details: makeDetails([result]),
		});
	};
	const emit = ((immediate = true) => {
		if (closed || !onUpdate) return;
		if (immediate) {
			if (pendingTimer) clearTimeout(pendingTimer);
			emitNow();
			return;
		}
		// Full recursive transcripts are retained. Coalesce provider/nested-tool
		// token bursts to 20fps so repeated serialization does not become the
		// bottleneck; the trailing callback reads the latest mutable accumulator,
		// therefore no transcript content is omitted.
		if (!emittedFirstStreamingUpdate) {
			emittedFirstStreamingUpdate = true;
			emitNow();
			return;
		}
		const remaining = 50 - (Date.now() - lastEmittedAt);
		if (remaining <= 0 && !pendingTimer) emitNow();
		else if (!pendingTimer) {
			pendingTimer = setTimeout(emitNow, Math.max(1, remaining));
			pendingTimer.unref?.();
		}
	}) as UpdateEmitter;
	emit.close = () => {
		if (closed) return;
		closed = true;
		if (pendingTimer) {
			clearTimeout(pendingTimer);
			pendingTimer = undefined;
		}
	};
	return emit;
}

function assistantMessageStatus(msg: SubagentEventMessage): SubagentTurnThroughputSample["status"] {
	if (msg.errorMessage) return "error";
	if (msg.stopReason === "aborted") return "interrupted";
	return "completed";
}

/** Record a completed assistant message's usage, runtime model/provider, and a
 *  per-turn throughput sample into the result. */
function recordAssistantMessage(
	result: SingleResult,
	msg: SubagentEventMessage,
	turnStartMs: number | undefined,
	providerForModel?: (modelId: string) => string | undefined,
): void {
	result.usage.turns++;
	const usage = msg.usage;
	if (usage) {
		result.usage.input += usage.input || 0;
		result.usage.output += usage.output || 0;
		result.usage.cacheRead += usage.cacheRead || 0;
		result.usage.cacheWrite += usage.cacheWrite || 0;
		result.usage.cost += usage.cost?.total || 0;
		result.usage.contextTokens = usage.totalTokens || 0;
	}
	if (msg.model) result.model = msg.model;
	// Prefer the serving provider stamped by the runtime. Some adapters omit it;
	// only infer from the registry when the model id has exactly one provider.
	// Never use a first-match lookup: Codex and Copilot share model ids.
	if (msg.provider) result.provider = msg.provider;
	else if (msg.model) {
		const inferredProvider = providerForModel?.(msg.model);
		if (inferredProvider) result.provider = inferredProvider;
	}
	if (msg.stopReason) result.stopReason = msg.stopReason;
	if (msg.errorMessage) result.errorMessage = msg.errorMessage;

	const endedMs = typeof msg.timestamp === "number" && msg.timestamp > (turnStartMs ?? 0)
		? msg.timestamp
		: Date.now();
	const generationDurationMs =
		typeof turnStartMs === "number" && Number.isFinite(turnStartMs) && turnStartMs > 0
			? Math.max(0, endedMs - turnStartMs)
			: 0;
	const sample: SubagentTurnThroughputSample = {
		endedAt: new Date(endedMs).toISOString(),
		outputTokens: usage?.output || 0,
		generationDurationMs,
		status: assistantMessageStatus(msg),
		modelId: result.model,
		provider: result.provider,
	};
	result.turnThroughputSamples = [...(result.turnThroughputSamples ?? []), sample];
}

/**
 * Handle a `tool_execution_update` event by merging the tool's partial result
 * onto the matching toolCall in `result.messages`, then emitting an update.
 *
 * This is the event that carries a nested (depth ≥ 2) subagent's streaming
 * output: depth-2 activity happens *inside* a tool call of the depth-1
 * session, so it only ever travels as `tool_execution_update` on the depth-1
 * session — the one event the runner previously dropped. Without this handler
 * depth-2 progress never reaches the host transcript, which is the root cause
 * of the "nested subagent hangs / 0 tps / no reply" symptom.
 *
 * Generic over any nested tool's `onUpdate` partial (not only subagent): a
 * nested bash etc. also streams here, so its partial surfaces too. The partial
 * is stamped onto the assistant message's `toolCall` content part; the host
 * already forwards it (`onToolProgress` sets `toolCall.result =
 * payload.partialResult`) and the webview already recurses into nested results
 * — so no host/webview change is needed for *propagation*, only the runner must
 * emit it.
 *
 * Safe to mutate the pi-ai `ToolCall` part: provider serializers (Anthropic /
 * OpenAI / Google) pick only known fields (`type`/`id`/`name`/`arguments`)
 * when sending the message back to the model, so the extra `result`/`status`
 * fields live only in memory for the host/webview to read.
 *
 * Updates that arrive before the assistant message is committed are buffered by
 * the subscription and replayed once its `message_end` arrives.
 */
function progressFingerprint(value: unknown): string {
	// Nested modern subagent updates expose unique attempt ids and monotonic
	// progress generations. They are a complete cheap revision key for the
	// recursive result, avoiding JSON.stringify over multi-megabyte transcripts
	// merely to suppress a duplicate callback.
	if (value && typeof value === "object") {
		const root = value as Record<string, unknown>;
		const details = root.details && typeof root.details === "object"
			? root.details as Record<string, unknown>
			: undefined;
		const results = Array.isArray(details?.results) ? details.results : undefined;
		if (results && results.length > 0) {
			const revisions = results.map((item) => {
				if (!item || typeof item !== "object") return undefined;
				const result = item as Record<string, unknown>;
				return typeof result.attemptId === "string" && Number.isSafeInteger(result.progressGeneration)
					? `${result.attemptId}:${result.progressGeneration}`
					: undefined;
			});
			if (revisions.every((revision): revision is string => revision !== undefined)) {
				return `subagent:${revisions.join("|")}`;
			}
		}
	}
	const seen = new WeakSet<object>();
	try {
		return JSON.stringify(value, (_key, candidate) => {
			if (typeof candidate === "bigint") return `${candidate}n`;
			if (typeof candidate === "object" && candidate !== null) {
				if (seen.has(candidate)) return "[Circular]";
				seen.add(candidate);
			}
			return candidate;
		}) ?? String(value);
	} catch {
		return String(value);
	}
}

/** Only a changed nested/tool partial is a tool-update heartbeat. SDKs may
 * repeat an identical `onUpdate` payload while hung; that must remain visible
 * without renewing the parent tree's inactivity lease. */
function isNewToolProgress(
	toolProgress: Map<string, string>,
	toolCallId: string,
	partialResult: unknown,
): boolean {
	const fingerprint = progressFingerprint(partialResult);
	if (toolProgress.get(toolCallId) === fingerprint) return false;
	toolProgress.set(toolCallId, fingerprint);
	return true;
}

function applyToolExecutionUpdate(
	result: SingleResult,
	toolCallId: string,
	partialResult: unknown,
	emitUpdate: (immediate?: boolean) => void,
	toolProgress: Map<string, string>,
): boolean {
	if (partialResult === undefined) return false;
	for (let i = result.messages.length - 1; i >= 0; i--) {
		const msg = result.messages[i];
		if (msg.role !== "assistant") continue;
		const content = msg.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (typeof part !== "object" || part === null) continue;
			const tc = part as { type?: string; id?: string; result?: unknown; status?: string };
			if (tc.type !== "toolCall" || tc.id !== toolCallId) continue;
			// Don't clobber a terminal toolCall (its toolResult message already
			// landed). The pi-ai ToolCall part has no status field, so this is a
			// defensive guard for any path that stamps one.
			if (tc.status === "completed" || tc.status === "failed") return true;
			const progressed = isNewToolProgress(toolProgress, toolCallId, partialResult);
			tc.result = partialResult;
			tc.status = "running";
			if (progressed && !setActivity(result, "running_tool", (result.runningTools ?? []).join(", ") || "nested tool progress")) {
				markProgress(result);
			}
			emitUpdate(false);
			return true;
		}
	}
	return false;
}

/** Wire up a subscription to session events, mutating `result` and emitting updates. */
function subscribeToSession(
	session: { subscribe: (cb: (event: SubagentSessionEvent) => void) => () => void },
	result: SingleResult,
	emitUpdate: () => void,
	streamingTextRef: { value: string },
	streamingReasoningRef: { value: string },
	stageRef: { value: string },
	eventFence: { accepting: boolean },
	providerForModel?: (modelId: string) => string | undefined,
): () => void {
	let assistantMessageStartMs: number | undefined;
	const toolProgress = new Map<string, string>();
	// The SDK can report a tool update before the assistant's toolCall message
	// is committed. Keep only its latest partial, then attach it at message_end.
	const pendingToolUpdates = new Map<string, unknown>();
	// Completion is authoritative: providers may emit a late update after end,
	// which must never resurrect a completed toolCall in the transcript.
	const endedToolCallIds = new Set<string>();
	const unsubscribe = session.subscribe((event) => {
		// Some SDK/provider adapters return an unsubscribe handle that is a no-op,
		// while already-queued callbacks can also arrive after teardown. The local
		// ownership fence is authoritative: a completed attempt must never mutate
		// its result or publish UI state after a retry has taken ownership.
		if (!eventFence.accepting) return;
		if (event.type === "message_start" && event.message?.role === "assistant") {
			assistantMessageStartMs = event.message.timestamp ?? Date.now();
			return;
		}
		if (event.type === "message_update") {
			handleMessageUpdate(event, result, emitUpdate, streamingTextRef, streamingReasoningRef, stageRef);
			return;
		}
		if (event.type === "tool_execution_start" && event.toolName) {
			markProviderReplayUnsafe(result, "tool_side_effect");
			result.streaming = false;
			result.runningTools = [...(result.runningTools ?? []), event.toolName];
			setActivity(result, "running_tool", result.runningTools.join(", "));
			emitUpdate();
			return;
		}
		if (event.type === "tool_execution_end") {
			if (event.toolCallId !== undefined) {
				endedToolCallIds.add(event.toolCallId);
				pendingToolUpdates.delete(event.toolCallId);
			}
			if (!event.toolName) return;
			const tools = [...(result.runningTools ?? [])];
			const completedIndex = tools.indexOf(event.toolName);
			if (completedIndex >= 0) tools.splice(completedIndex, 1);
			result.runningTools = tools;
			const transitioned = tools.length > 0
				? setActivity(result, "running_tool", tools.join(", "))
				: setActivity(result, "waiting_provider", result.provider ? `waiting for ${result.provider}` : "waiting for model response");
			// A real end event remains progress even when concurrent tools leave the
			// same visible phase/detail. Ignore unmatched duplicate end events.
			if (completedIndex >= 0 && !transitioned) markProgress(result);
			emitUpdate();
			return;
		}
		if (event.type === "tool_execution_update" && event.toolCallId !== undefined) {
			if (endedToolCallIds.has(event.toolCallId)) return;
			if (!applyToolExecutionUpdate(result, event.toolCallId, event.partialResult, emitUpdate, toolProgress)
				&& event.partialResult !== undefined) {
				pendingToolUpdates.set(event.toolCallId, event.partialResult);
			}
			return;
		}
		if (event.type === "message_end" && event.message) {
			handleMessageEnd(event.message, result, emitUpdate, streamingTextRef, streamingReasoningRef, assistantMessageStartMs, providerForModel);
			assistantMessageStartMs = undefined;
			for (const [toolCallId, partialResult] of pendingToolUpdates) {
				if (endedToolCallIds.has(toolCallId)) {
					pendingToolUpdates.delete(toolCallId);
					continue;
				}
				if (applyToolExecutionUpdate(result, toolCallId, partialResult, emitUpdate, toolProgress)) {
					pendingToolUpdates.delete(toolCallId);
				}
			}
		}
	});
	return () => {
		if (!eventFence.accepting) return;
		eventFence.accepting = false;
		pendingToolUpdates.clear();
		toolProgress.clear();
		unsubscribe();
	};
}

/** Handle streaming text_delta / thinking_delta events from the assistant. */
function handleMessageUpdate(
	event: SubagentSessionEvent,
	result: SingleResult,
	emitUpdate: (immediate?: boolean) => void,
	streamingTextRef: { value: string },
	streamingReasoningRef: { value: string },
	stageRef: { value: string },
): void {
	// Accumulate streaming text/reasoning deltas so the user sees output as it arrives.
	// The SDK delivers events in order per message: message_start → message_update* → message_end.
	// A single buffer per kind is sufficient because only one assistant
	// message streams at a time in the subagent's single-prompt session.
	const streamEvent = event.assistantMessageEvent;
	const isTextDelta = streamEvent?.type === "text_delta" && !!streamEvent.delta;
	const isThinkingDelta = streamEvent?.type === "thinking_delta" && (!!streamEvent.delta || !!streamEvent.thinking);
	const isToolCallGeneration = streamEvent?.type === "toolcall_start" || streamEvent?.type === "toolcall_delta";
	if (isTextDelta || isThinkingDelta || isToolCallGeneration) {
		if (isTextDelta || isThinkingDelta) markProviderReplayUnsafe(result, "partial_output");
		// Any streamed provider content advances the visible lifecycle. Only text
		// and reasoning deltas drive the token-rate clock; tool-call argument
		// generation is active work but does not expose countable output tokens.
		stageRef.value = "streaming";
		result.streaming = isTextDelta || isThinkingDelta;
		if (!setActivity(result, "streaming", undefined)) markProgress(result);
		if (isTextDelta) {
			streamingTextRef.value += streamEvent.delta!;
			result.streamingText = streamingTextRef.value;
		}
		if (isThinkingDelta) {
			// Accumulate reasoning deltas into a separate buffer so the collapsed
			// preview can surface live thinking before any reply text arrives —
			// previously the only signal was a generic "Generating…" lifecycle
			// label. Reasoning and reply share a single assistant message; the
			// preview prefers reply text once it starts, so both buffers coexist
			// until `message_end` clears them.
			streamingReasoningRef.value += streamEvent.delta ?? streamEvent.thinking ?? "";
			result.streamingReasoning = streamingReasoningRef.value;
		}
		emitUpdate(false);
	}
}

/** Handle a completed message, recording usage and resetting streaming buffers. */
function handleMessageEnd(
	rawMessage: SubagentEventMessage,
	result: SingleResult,
	emitUpdate: () => void,
	streamingTextRef: { value: string },
	streamingReasoningRef: { value: string },
	turnStartMs: number | undefined,
	providerForModel?: (modelId: string) => string | undefined,
): void {
	const msg = rawMessage as Message;
	if (msg.role === "assistant" || msg.role === "toolResult") {
		result.messages.push(msg);
	}
	if (msg.role === "assistant") {
		recordAssistantMessage(result, rawMessage, turnStartMs, providerForModel);
		// Clear streaming text/reasoning once a complete assistant message is
		// committed. (Only assistant messages produce text/thinking_delta events,
		// so only reset on those.)
		streamingTextRef.value = "";
		result.streamingText = undefined;
		streamingReasoningRef.value = "";
		result.streamingReasoning = undefined;
	}
	result.streaming = false;
	const transitioned = (result.runningTools?.length ?? 0) > 0
		? setActivity(result, "running_tool", result.runningTools!.join(", "))
		: setActivity(result, "waiting_provider", result.provider ? `waiting for ${result.provider}` : "waiting for model response");
	// A committed message is credible work even if it leaves the lifecycle label
	// unchanged (for example a tool result while another tool remains active).
	if (!transitioned) markProgress(result);
	emitUpdate();
}

/** Build an error stamped as an AbortError and carrying the pre-spawn `stage`
 *  that was interrupted, so callers see *where* the abort happened rather than
 *  a bare "Request was aborted". Mirrors the stage-enrichment used by
 *  `applyThrownError` / `applyTimeoutFailure` for the prompt phase. */
function abortError(stage: string): Error {
	const err = new Error(`Subagent aborted (while ${stage})`);
	err.name = "AbortError";
	return err;
}

/** Race `promise` against the parent abort signal. Rejects with an
 *  {@link abortError} (carrying `stage`) if the signal fires first; resolves
 *  with `promise`'s value otherwise. No-op (returns `promise` unchanged) when
 *  no signal is supplied, preserving today's behavior for callers without one.
 *  This is the structural "Stop always works" fix for the pre-spawn phase:
 *  `reload()` / `acquire()` / `createSession()` each become interruptible
 *  without adding a timeout. */
async function raceAbort<T>(signal: AbortSignal | undefined, promise: Promise<T>, stage: string): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) throw abortError(stage);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortError(stage));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(err) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

/** Race a promise against a timeout — used ONLY for the `parentAlreadyAborted`
 *  branch where `raceAbort` can't be used (the signal is already aborted so
 *  `raceAbort` would throw immediately). Without this, a hung SDK/dead proxy
 *  that ignores `session.abort()` would dangle the worker until the 30-min
 *  settlement timer fires (the "scout :2 starts after abort" timing window).
 *  The timeout is long enough for a fast SDK to settle (especially after
 *  `session.abort()` is called), short enough that the user isn't stuck. */
function raceTimeout<T>(stage: string, ms: number, promise: Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(abortError(stage)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

/** Immediately stop the child session's billable windows — compaction LLM
 *  call, branch-summary, bash, retry — that `session.abort()` alone does NOT
 *  cover. These run in the narrow window between agent_end and teardownSession:
 *  without calling them here, a nested subagent's post-agent_end compaction
 *  call would keep billing until the try/catch/finally unwinds to dispose().
 *  Each is optional (defensive: no-op when the session doesn't expose it),
 *  and each is fire-and-forget synchronous — they stop the window instantly,
 *  we don't wait for the underlying provider call to settle. */
function hardAbortBillable(session: unknown): void {
	const s = session as Record<string, () => void> | null;
	if (!s || typeof s !== "object") return;
	for (const method of ["abortCompaction", "abortBranchSummary", "abortBash", "abortRetry"]) {
		try {
			s[method]?.();
		} catch {
			/* a stuck billable-window abort must not prevent the others — swallow */
		}
	}
}

/** Emit a structured, machine-readable error log for a subagent hardening
 *  event (abort, force-settle, pre-spawn failure). Pinned to `[pie:subagent]`
 *  via a `source` field so it's grep-able in the host log stream. Loud, not
 *  quiet — every timeout/abort path calls this. */
function logLoud(event: string, details: Record<string, unknown>): void {
	console.error(JSON.stringify({ source: "pie:subagent", event, ...details }));
}

/** Build a per-call abort signal that fires on either the parent signal or the timeout. */
function buildCombinedAbortSignal(parentSignal: AbortSignal | undefined, timeoutMs: number): {
	timeoutSignal: AbortSignal | undefined;
	/** The combined signal (parent ∨ timeout). `undefined` when neither source
	 *  is configured (no parent signal AND timeout disabled) — callers should
	 *  treat `undefined` as "prompt runs uninterrupted". Exposed so the caller
	 *  can race `session.prompt()` against it: a prompt that ignores
	 *  `session.abort()` (a hung provider stream / hung SDK) would otherwise
	 *  hang the parent even after the timeout fires. */
	combinedSignal: AbortSignal | undefined;
	onAbort: (handler: () => void) => () => void;
	/** Clear the refed timeout timer. MUST be called when the run settles
	 *  (success, abort, or timeout) so the timer doesn't keep the event loop
	 *  alive after the result is ready. No-op when no timeout is configured. */
	cleanup: () => void;
} {
	// No timeout configured (timeoutMs <= 0): only the parent signal can
	// interrupt the run. If there is no parent signal either, the prompt runs
	// uninterrupted until it completes naturally — subagents do not time out.
	if (!(timeoutMs > 0)) {
		const onAbort = (handler: () => void): (() => void) => {
			if (!parentSignal) return () => {};
			parentSignal.addEventListener("abort", handler, { once: true });
			return () => parentSignal.removeEventListener("abort", handler);
		};
		return { timeoutSignal: undefined, combinedSignal: parentSignal, onAbort, cleanup: () => {} };
	}

	// Create a REfed timeout timer. AbortSignal.timeout(timeoutMs) uses an
	// internally unref'd timer (Node: "we also don't want the timer to keep the
	// Node.js process open on its own"), which means a subagent run whose only
	// pending work is that unref'd timer + a never-resolving promise (a hung
	// provider stream, or a hanging test mock) will see the event loop drain
	// and `beforeExit` fire BEFORE the timeout can trigger — the timeout never
	// fires, the run never settles, and node:test cancels the test
	// ("Promise resolution is still pending but the event loop has already
	// resolved"). This was the root cause of the execution-paths.test.ts
	// 12-test cascade: tests #3-#14 were cancelled because the timeout signal
	// never fired under node:test. A refed setTimeout guarantees the timer
	// fires; the `cleanup` return clears it when the run settles so it doesn't
	// linger after the result is ready.
	const timeoutController = new AbortController();
	const timeoutTimer = setTimeout(() => {
		timeoutController.abort(new Error(`Subagent timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	const timeoutSignal = timeoutController.signal;
	const cleanupTimeout = () => clearTimeout(timeoutTimer);

	let signal: AbortSignal;
	if (parentSignal) {
		if (typeof AbortSignal.any === 'function') {
			signal = AbortSignal.any([parentSignal, timeoutSignal]);
		} else {
			// Fallback for runtimes without AbortSignal.any
			const controller = new AbortController();
			const stop = (reason: () => void) => {
				reason();
				parentSignal.removeEventListener('abort', onParent);
				timeoutSignal.removeEventListener('abort', onTimeout);
			};
			const onParent = () => stop(() => controller.abort());
			const onTimeout = () => stop(() => controller.abort());
			if (parentSignal.aborted) {
				stop(() => controller.abort());
			} else {
				parentSignal.addEventListener('abort', onParent, { once: true });
			}
			if (timeoutSignal.aborted) {
				stop(() => controller.abort());
			} else {
				timeoutSignal.addEventListener('abort', onTimeout, { once: true });
			}
			signal = controller.signal;
		}
	} else {
		signal = timeoutSignal;
	}
	const onAbort = (handler: () => void): (() => void) => {
		signal.addEventListener("abort", handler, { once: true });
		return () => signal.removeEventListener("abort", handler);
	};
	return { timeoutSignal, combinedSignal: signal, onAbort, cleanup: cleanupTimeout };
}

/** Preserve visible partial prose before terminalization clears live-only fields. */
function preservePartialOutput(result: SingleResult): void {
	if (!result.finalOutput && result.streamingText) result.finalOutput = result.streamingText;
}

/** Clear every field that can make a terminal child look active. Nested tool
 * end events are not guaranteed to arrive when a provider aborts or throws, so
 * terminalization — not tool_execution_end — owns this cleanup. */
function clearLiveState(result: SingleResult): void {
	result.runningTools = [];
	result.streamingText = undefined;
	result.streamingReasoning = undefined;
	result.streaming = false;
}

/** Apply a timeout-failure to a result. */
function applyTimeoutFailure(result: SingleResult, timeoutMs: number, stage?: string): void {
	result.exitCode = 1;
	result.stopReason = "timeout";
	const suffix = stage ? ` (while ${stage})` : "";
	result.errorMessage = `Subagent timed out after ${timeoutMs / 1000}s waiting for model response${suffix}.`;
	classifyProviderFailure(result);
	preservePartialOutput(result);
	clearLiveState(result);
	setActivity(result, "failed", result.errorMessage);
}

/** Apply a stop-reason-based exit code to a result. */
function applyStopReason(result: SingleResult, parentAborted: boolean, stage?: string): void {
	const stop = result.stopReason;
	if (stop === "error" || stop === "aborted") {
		result.exitCode = 1;
	} else {
		result.exitCode = 0;
	}
	preservePartialOutput(result);
	clearLiveState(result);
	if (parentAborted && result.exitCode === 0) {
		result.exitCode = 1;
		if (!result.errorMessage) result.errorMessage = "Subagent was aborted";
	}
	if (result.exitCode !== 0) classifyProviderFailure(result);
	// Enrich whatever message we have (the SDK's raw "Request was aborted" or
	// similar) with the run stage and cause, mirroring applyTimeoutFailure /
	// applyThrownError — otherwise an abort surfaces as a bare, contextless
	// provider string with no indication of when/why it happened.
	if (stop === "aborted" && stage) {
		const cause = parentAborted ? "parent interrupted" : "provider/session aborted";
		const base = result.errorMessage || "Request was aborted";
		result.errorMessage = `${base} (${cause}, while ${stage})`;
	}
	setActivity(
		result,
		result.exitCode === 0 ? "completed" : parentAborted || stop === "aborted" ? "cancelled" : "failed",
		result.errorMessage,
	);
}

/** Apply a thrown error to a result, preserving any previously-recorded message. */
function applyThrownError(
	result: SingleResult,
	err: unknown,
	stage?: string,
	parentAborted = false,
	clock?: RetryClock,
): void {
	result.exitCode = 1;
	const interrupted = parentAborted || (err as { name?: string } | null)?.name === "AbortError";
	if (interrupted) result.stopReason = "aborted";
	const message = toErrorMessage(err);
	const suffix = stage && !message.includes(`(while ${stage})`) ? ` (while ${stage})` : "";
	result.errorMessage = (result.errorMessage || message) + suffix;
	result.stderr = result.stderr || message;
	classifyProviderFailure(result, err, clock);
	preservePartialOutput(result);
	clearLiveState(result);
	setActivity(result, interrupted ? "cancelled" : "failed", result.errorMessage);
}

/** Tear down a session, swallowing disposal errors. */
function teardownSession(
	unsubscribe: () => void,
	session: { dispose: () => void },
	beforeDispose?: () => void,
): void {
	try {
		unsubscribe();
	} catch {
		/* ignore */
	}
	try {
		beforeDispose?.();
	} catch {
		/* ignore */
	}
	try {
		session.dispose();
	} catch {
		/* ignore */
	}
}

/**
 * Process signals whose listeners we audit around subagent session creation.
 *
 * The pi SDK's `DefaultResourceLoader.reload()` pulls in transitive provider
 * HTTP-handler code (notably `@smithy/node-http-handler` via the AWS SDK
 * dependency tree, reached while loading provider/model metadata) that
 * registers a per-loader exit-signal cleanup closure shaped like
 * `() => { for (const p of pools.values()) p.dispose(); }`. The SDK never
 * exposes a handle to remove it, and `DefaultResourceLoader` has no
 * `destroy()`/`dispose()`, so each subagent session leaks one such closure
 * on each of these signals — never removed. With sibling and nested runs, the
 * count crosses Node's default cap (10) and the host emits
 * `MaxListenersExceededWarning: N SIGINT listeners added to [process]`,
 * which looks like a pie memory leak.
 *
 * The leaked closures are pure no-arg pool-disposers: on a still-living host
 * the pools are already torn down by the time they could fire, so they are
 * harmless-but-accumulating. `reclaimOrphanedSignalListeners` removes the
 * ones added during a session so the host's listener count stays bounded at
 * the pre-session baseline. It matches ONLY the orphaned pool-dispose shape
 * (structural signature), never pie's own listeners or signal-exit's
 * idempotent singleton — so a future SDK that stops leaking, or that fixes
 * the registration to be removable, is unaffected (there is simply nothing
 * to remove).
 */
const EXIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;

/** Structural signature of the orphaned pool-dispose cleanup closure leaked
 *  by the SDK's transitive HTTP-handler deps per `resourceLoader.reload()`.
 *  Matches `() => { for (const p of pools.values()) p.dispose(); }` — the
 *  `pools.values()` iterable + `.dispose()` call is specific enough that
 *  legitimate signal-exit / pie listeners never match. */
const ORPHAN_POOL_DISPOSE_RE = /pools\.values\(\)/;

/** Snapshot the current listeners on every exit signal so a later
 *  {@link reclaimOrphanedSignalListeners} can remove only the listeners added
 *  since the snapshot. Returns an opaque handle. */
function snapshotSignalListeners(): Map<string, Set<Function>> {
	const snap = new Map<string, Set<Function>>();
	for (const sig of EXIT_SIGNALS) {
		snap.set(sig, new Set(process.listeners(sig) as unknown as Function[]));
	}
	return snap;
}

/** Remove exit-signal listeners added since `before` that match the orphaned
 *  pool-dispose shape. Pie's own listeners, signal-exit's singleton, and any
 *  listener present in the snapshot are preserved. No-ops when the SDK has
 *  nothing to clean up (e.g. the mock SDK in tests, or a fixed upstream). */
function reclaimOrphanedSignalListeners(before: Map<string, Set<Function>>): void {
	for (const sig of EXIT_SIGNALS) {
		const prev = before.get(sig);
		if (!prev) continue;
		for (const fn of process.listeners(sig) as unknown as Function[]) {
			if (prev.has(fn)) continue;
			let body = "";
			try {
				body = fn.toString();
			} catch {
				continue;
			}
			if (ORPHAN_POOL_DISPOSE_RE.test(body)) {
				try {
					process.removeListener(sig, fn as Parameters<typeof process.removeListener>[1]);
				} catch {
					/* ignore */
				}
			}
		}
	}
}

/** Environment key for the user-configured list of tool names to always drop
 *  from subagent sessions (e.g. ["ask_user"]). Mirrored by the pie host from
 *  the Subagent settings UI via the runtimePrefs.set RPC, same pattern as
 *  PIE_SUBAGENT_BUCKETS_JSON. Empty/unset → no tools dropped (today's behavior). */
const SUBAGENT_DROP_TOOLS_ENV = "PIE_SUBAGENT_DROP_TOOLS_JSON";

/** Reads the user-configured drop-tools list from the environment. Returns a
 *  Set for O(1) membership checks; empty when unset/invalid. */
function readDropTools(): Set<string> {
	const raw = process.env[SUBAGENT_DROP_TOOLS_ENV];
	if (!raw) return new Set();
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return new Set();
		return new Set(parsed.filter((t): t is string => typeof t === "string" && t.length > 0));
	} catch {
		return new Set();
	}
}

export async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	modelRegistry: ModelRegistry,
	callerModel: Model<any> | undefined,
	bucketSelection: BucketSelection | undefined,
	disabledProviders?: Set<string>,
	/** The parent tool call ID, used to stamp subagent ask_user requests. */
	_toolCallId?: string,
	/** The parent session's UI bridge, for proxying ask_user calls. */
	parentUiBridge?: ParentBridge,
	/** The PARENT (main) session id, used to look up the skill-pruner's kept-skill
	 *  set so this subagent inherits the main turn's pruned skills (direction C).
	 *  Undefined when unresolvable → no skill filtering (today's behavior). */
	parentSessionId?: string,
	/** The full set of tool names available in the parent session, used so the
	 *  user-configured drop-tools list can be subtracted from unrestricted agents
	 *  (those without a `tools:` frontmatter). Undefined → only explicit
	 *  `agent.tools` can be filtered. */
	allToolNames?: string[],
	/** Internal test seam to avoid loading the real SDK and long timeout delays. */
	_internal?: {
		sdk?: SubagentSdk;
		timeoutMs?: number;
		orphanRegistry?: OrphanCleanupRegistry;
		clock?: RetryClock;
	},
	/** Stable identity for this attempt; used by orphan registry and analytics. */
	attemptId?: string,
	/** Optional lean user-role context handoff extracted from the parent session.
	 * The mode and exact inserted packet are retained as result metadata so the
	 * parent UI can explain precisely what the child received. */
	parentUserContext?: { mode: UserContextMode; content?: string },
	/** Per-call hard model requirements (e.g. image input) to enforce at
	 *  execution-model resolution. Threaded from `params.modelRequirements` so
	 *  duplicate ids are resolved by provider-qualified capability on every
	 *  attempt and the resolution layer never escapes to an incompatible model. */
	modelRequirements?: ModelRequirements,
): Promise<SingleResult> {
	// 1. Preflight: locate the agent config or short-circuit with an invalid result.
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) return createInvalidAgentResult(agentName, task, agents, step);
	const runtimeContext = readRuntimeContext();
	let ownedProcessPermit: Release | undefined;

	// 2. Resolve the model the session will run on.
	const sessionCwd = cwd ?? defaultCwd;
	const modelOverride = bucketSelection?.modelId;
	const thinkingLevel = bucketSelection?.thinkingLevel;
	const requestedModel = modelOverride ?? agent.model;
	const {
		resolvedModel,
		actualModelId,
		diagnostic: modelResolutionDiagnostic,
	} = resolveExecutionModel(
		modelRegistry,
		callerModel,
		requestedModel,
		disabledProviders,
		readRouteAroundSaturatedProviders() && !readAlwaysParentModelFromEnv()
			? readProviderCapacitySnapshot()
			: undefined,
		modelRequirements,
	);

	// 3. Build the result accumulator and the update emitter.
	const currentResult = createInitialResult(
		agent,
		agentName,
		task,
		step,
		actualModelId,
		resolvedModel?.provider,
		resolvedModel?.contextWindow,
		bucketSelection?.modelId,
		thinkingLevel,
		modelResolutionDiagnostic,
	);
	if (parentUserContext) {
		currentResult.parentUserContextMode = parentUserContext.mode;
		if (parentUserContext.content) currentResult.parentUserContext = parentUserContext.content;
	}

	// Final provider-qualified enforcement. Bucket selection works by model id,
	// so execution resolution must remain fail-closed if the registry changes or
	// every enabled declaration for a duplicate id is incompatible. Never pass an
	// undefined model to createSession under an active hard requirement: the SDK
	// could otherwise select its default (possibly text-only) model.
	if (requirementIsActive(modelRequirements) && !resolvedModel) {
		const requirementDiagnostic = formatRequirementDiagnostic(
			modelRequirements,
			bucketSelection?.bucket ?? agent.bucket ?? "medium",
		);
		const now = Date.now();
		currentResult.exitCode = 1;
		currentResult.stopReason = "error";
		currentResult.stderr = requirementDiagnostic;
		currentResult.errorMessage = requirementDiagnostic;
		currentResult.requestedModelRequirements = modelRequirements;
		currentResult.modelRequirementsSatisfied = false;
		currentResult.requirementDiagnostic = requirementDiagnostic;
		currentResult.activityPhase = "failed";
		currentResult.activityDetail = requirementDiagnostic;
		currentResult.activitySince = now;
		currentResult.completedAt = now;
		return currentResult;
	}
	const streamingTextRef = { value: "" };
	const streamingReasoningRef = { value: "" };
	const emitUpdate = createUpdateEmitter(currentResult, onUpdate, makeDetails, streamingTextRef);

	const sdk = _internal?.sdk ?? (await loadSubagentSdk());
	const promptTimeoutMs = _internal?.timeoutMs ?? resolveSubagentTimeoutMs();

	// 4. Build an isolated resource loader and create the session.
	// - appendSystemPrompt threads the agent's instructions into the system prompt
	// - noExtensions is intentionally false so the subagent extension (and others)
	//   load into nested sessions, enabling further delegation. Nesting is bounded
	//   by the depth/trail/tree-budget guards in execute()/modes.ts, not by hiding
	//   the tool.
	// Skills: inherit the parent's pruned set (direction C). The skill-pruner
	// writes the kept-skill names for the main turn to a per-session store;
	// here we read them and filter the subagent's loaded skills by name. Both
	// sessions load skills from the same locations, so name-based filtering is
	// exact. Undefined / "keep-all" / not-found → no filter (today's behavior).
	let skillsOverride: SubagentSkillsOverride | undefined;
	if (parentSessionId) {
		const kept = readKeptSkills(parentSessionId);
		// A non-empty kept set filters the subagent's skills to exactly those the
		// main turn kept. An empty array is treated as keep-all (no filter): the
		// main turn may now legitimately prune every skill when tools remain, but a
		// subagent works on an isolated sub-task with no mid-turn skill recovery, so
		// it never inherits zero skills via this path. "keep-all" / undefined also
		// fall through to no filter (today's behavior).
		if (Array.isArray(kept) && kept.length > 0) {
			const keptSet = new Set(kept);
			skillsOverride = (base) => ({
				skills: base.skills.filter((s) => keptSet.has(s.name)),
				diagnostics: base.diagnostics,
			});
		}
	}

	// Tools: subtract the user-configured drop list (e.g. ["ask_user"]) from
	// the agent's effective tool set. For agents with an explicit `tools:`
	// frontmatter we filter that list; for unrestricted agents (no `tools:`)
	// we filter the full parent tool set passed in as `allToolNames`. When the
	// drop set is empty, `agent.tools` passes through unchanged (undefined →
	// SDK loads all tools), preserving today's behavior exactly.
	const dropSet = readDropTools();
	let effectiveTools: string[] | undefined = agent.tools;
	if (dropSet.size > 0) {
		const base = agent.tools ?? allToolNames;
		if (base && base.length > 0) {
			effectiveTools = base.filter((t) => !dropSet.has(t));
		}
	}

	const resourceLoader = sdk.createResourceLoader({
		cwd: sessionCwd,
		agentDir: sdk.getAgentDir(),
		appendSystemPrompt: agent.systemPrompt.trim() ? [agent.systemPrompt] : undefined,
		noExtensions: false,
		skillsOverride,
	});

	// Pre-spawn phase: resource load → root-tree permit → session creation.
	// Future parent aborts interrupt each phase. A root holds its process permit
	// through prompt teardown; descendants borrow the same async-local scope.
	//
	// Already-aborted-at-entry is exceptional: resource setup still runs to
	// settle pending UI, but the child must never queue for a process permit.
	// Passing the already-aborted signal to acquire() makes that boundary reject
	// immediately without claiming or waiting for a slot. Other setup phases are
	// bounded by a short timeout because no future abort edge exists to wake a
	// dead SDK/proxy.
	const parentAlreadyAborted = signal?.aborted === true;
	const ALREADY_ABORTED_TIMEOUT_MS = 10_000;
	// Snapshot exit-signal listeners BEFORE `resourceLoader.reload()`. The
	// SDK's loader pulls in transitive provider HTTP-handler code that leaks
	// an orphaned pool-dispose SIGINT/SIGTERM closure per reload (see
	// `reclaimOrphanedSignalListeners`); capturing the baseline here lets the
	// `finally` below reclaim exactly those additions so the host's listener
	// count stays bounded across many sibling/nested subagent runs.
	const signalListenersBefore = snapshotSignalListeners();
	const resolvedAttemptId = attemptId ?? nextAttemptIdentity(agentName, _toolCallId);
	currentResult.attemptId = resolvedAttemptId;
	const orphanRegistry = _internal?.orphanRegistry ?? globalOrphanRegistry;
	let session: SessionLike;
	let createSessionPromise: Promise<CreateAgentSessionResult> | undefined;
	// Publish before resource loading begins; otherwise a slow loader leaves the
	// parent showing its synthetic "Starting" state with no real child status.
	emitUpdate();
	try {
		if (parentAlreadyAborted) {
			await raceTimeout("loading subagent resources (already-aborted)", ALREADY_ABORTED_TIMEOUT_MS, resourceLoader.reload());
		} else {
			await raceAbort(signal, resourceLoader.reload(), "loading subagent resources");
		}
		if (!runtimeContext.processPermitScope) {
			setActivity(currentResult, "queued", "waiting for subagent concurrency slot");
			emitUpdate();
			ownedProcessPermit = await inflightSemaphore.acquire(signal);
			runtimeContext.processPermitScope = { release: ownedProcessPermit };
		}
		setActivity(currentResult, "preparing", "creating subagent session");
		emitUpdate();
		createSessionPromise = sdk.createSession({
			cwd: sessionCwd,
			modelRegistry,
			model: resolvedModel,
			thinkingLevel,
			tools: effectiveTools,
			sessionManager: sdk.createSessionManager(sessionCwd),
			resourceLoader,
		});
		const created = parentAlreadyAborted
			? await raceTimeout("creating subagent session (already-aborted)", ALREADY_ABORTED_TIMEOUT_MS, createSessionPromise)
			: await raceAbort(signal, createSessionPromise, "creating subagent session");
		session = created.session as SessionLike;
	} catch (err) {
		// Pre-spawn abort or failure: never reach the prompt phase. Return a
		// loud failure result so `execute()` always settles and the parent
		// transcript/toolResult is written. This is the structural guarantee
		// that a stuck worker can't silently dangle the parent session.
		//
		// REM-02: if session creation lost the abort/timeout race, retain
		// ownership of the underlying promise. A late resolution may still
		// produce a session; fence it from setup/prompt, dispose it exactly
		// once, reclaim attempt-owned loader listeners, and never retain a
		// process permit. The orphan registry handles retry/backoff and
		// best-effort drain.
		const interrupted = parentAlreadyAborted || !!signal?.aborted || (err as { name?: string } | null)?.name === "AbortError";
		if (createSessionPromise && interrupted) {
			const capturedCreatePromise = createSessionPromise;
			const capturedListenersBefore = signalListenersBefore;
			// Every registry retry observes the same in-flight cleanup task. This
			// matters when a registry timeout wins while createSession is still
			// pending: a later retry must keep awaiting that task rather than report
			// false completion or create a second eventual disposer. A synchronous
			// dispose failure clears the memoized task so bounded retry can try again.
			let cleanupTask: Promise<void> | undefined;
			orphanRegistry.register(resolvedAttemptId, () => {
				if (cleanupTask) return cleanupTask;
				cleanupTask = (async () => {
					let lateSession: SessionLike | undefined;
					try {
						const late = await capturedCreatePromise;
						lateSession = late.session as SessionLike | undefined;
					} catch {
						// createSession itself ultimately failed — nothing to clean up.
						return;
					}
					if (!lateSession) return;
					// The race was lost before this session reached setup/prompt.
					// Dispose it immediately; never set UI context, subscribe, or run
					// a prompt. Reclaim the loader-leaked listeners afterwards.
					logLoud("subagent orphan create resolved", {
						toolCallId: _toolCallId,
						agent: agentName,
						task,
						attemptId: resolvedAttemptId,
					});
					try {
						lateSession.dispose();
					} catch (error) {
						logLoud("subagent orphan dispose failed", {
							toolCallId: _toolCallId,
							agent: agentName,
							task,
							attemptId: resolvedAttemptId,
							error: toErrorMessage(error),
						});
						reclaimOrphanedSignalListeners(capturedListenersBefore);
						throw error;
					}
					reclaimOrphanedSignalListeners(capturedListenersBefore);
				})().catch((error) => {
					cleanupTask = undefined;
					throw error;
				});
				return cleanupTask;
			});
		}
		currentResult.exitCode = 1;
		if (interrupted) currentResult.stopReason = "aborted";
		currentResult.errorMessage = toErrorMessage(err);
		currentResult.stderr = currentResult.errorMessage;
		clearLiveState(currentResult);
		setActivity(currentResult, interrupted ? "cancelled" : "failed", currentResult.errorMessage);
		logLoud("subagent pre-spawn aborted/failed", {
			toolCallId: _toolCallId,
			agent: agentName,
			task,
			stage: "pre-spawn",
			cause: (err as { name?: string } | null)?.name === "AbortError" ? "aborted" : "error",
			error: currentResult.errorMessage,
		});
		onUpdate?.({
			content: [textContent(`⚠ ${agentName}: ${currentResult.errorMessage}`)],
			details: makeDetails([currentResult]),
		});
		emitUpdate.close();
		// Reclaim any orphaned exit-signal listeners the loader leaked before
		// the pre-spawn phase failed (reload may have run partially). See the
		// snapshot above and `reclaimOrphanedSignalListeners`.
		reclaimOrphanedSignalListeners(signalListenersBefore);
		if (ownedProcessPermit) {
			ownedProcessPermit();
			if (runtimeContext.processPermitScope?.release === ownedProcessPermit) runtimeContext.processPermitScope = undefined;
			ownedProcessPermit = undefined;
		}
		return currentResult;
	}

	// From the moment createSession succeeds, every exit path owns the session
	// and (for a root child) the process permit. Keep all post-create setup inside
	// one lifetime guard: setUIContext(), subscribe(), lifecycle updates, or any
	// future setup step may throw before the prompt's narrower try/finally is
	// reached. The no-op unsubscribe preserves exact-once session disposal even
	// when subscription itself throws before returning its cleanup handle.
	const sessionEventFence = { accepting: true };
	let unsubscribe: () => void = () => {
		sessionEventFence.accepting = false;
	};
	let sessionCleanedUp = false;
	let proxy: ParentExtensionUIBridgeProxy | undefined;
	let proxyCancelled = false;
	const cancelProxy = (): void => {
		if (!proxy || proxyCancelled) return;
		proxyCancelled = true;
		try {
			proxy.dispose();
		} catch {
			/* a broken parent bridge must not prevent owned-session teardown */
		}
	};
	const cleanupOwnedSession = (): void => {
		if (sessionCleanedUp) return;
		sessionCleanedUp = true;
		// Stop attempt-owned publication before teardown or a fallback attempt can
		// begin. This clears any trailing throttled update from the old attempt.
		emitUpdate.close();
		// Fence the SDK callback before cancelling UI or disposing the session;
		// either operation may synchronously flush provider/extension callbacks.
		teardownSession(unsubscribe, session, cancelProxy);
		// Reclaim the orphaned exit-signal listeners the SDK's loader leaked
		// during this session (see `snapshotSignalListeners` above). Runs after
		// `teardownSession` so the session's own disposal has settled; the
		// reclaimed closures are pure no-arg pool-disposers that are no-ops on
		// a live host anyway. No-op for the mock SDK / a fixed upstream.
		reclaimOrphanedSignalListeners(signalListenersBefore);
		if (ownedProcessPermit) {
			ownedProcessPermit();
			if (runtimeContext.processPermitScope?.release === ownedProcessPermit) runtimeContext.processPermitScope = undefined;
			ownedProcessPermit = undefined;
		}
	};
	// Variables used by the prompt phase are created before setup so setup
	// failures can propagate after cleanup without widening the prompt catch.
	const stageRef = { value: "preparing" };
	// Wrap the prompt in the shared subagent context (A) so extensions whose
	// before_agent_start hooks fire during session.prompt() — notably the
	// skill-pruner prepass — can detect they are inside a scoped subagent
	// session and skip. AsyncLocalStorage is per-async-context, so this is safe
	// under parallel subagent runs (unlike a process.env flag, which would race).
	const subagentDepth = readRuntimeContext().depth;
	const runPrompt = (): Promise<void> =>
		subagentContext.run({ depth: subagentDepth }, () => session.prompt(formatSubagentPrompt(task, parentUserContext?.content)));
	try {
		// Capture the model the session actually selected (in case our hint was overridden).
		if (session.agent?.state?.model) {
			currentResult.model = session.agent.state.model.id;
		}

		// Inject the parent UI bridge proxy so subagent ask_user calls appear in the parent UI.
		if (parentUiBridge && _toolCallId) {
			proxy = new ParentExtensionUIBridgeProxy(parentUiBridge, _toolCallId);
			session.extensionRunner.setUIContext(proxy);
		}

		// 5. Subscribe to session events.
		unsubscribe = subscribeToSession(
			session,
			currentResult,
			emitUpdate,
			streamingTextRef,
			streamingReasoningRef,
			stageRef,
			sessionEventFence,
			(modelId) => {
				const matches = modelRegistry.getAvailable().filter((candidate) => candidate.id === modelId);
				return matches.length === 1 ? matches[0]?.provider : undefined;
			},
		);

		// The session exists and the next potentially long window is provider
		// prefill. Publish that distinction before prompt() starts.
		setActivity(currentResult, "waiting_provider", currentResult.provider ? `waiting for ${currentResult.provider}` : "waiting for model response");
		emitUpdate();
	} catch (error) {
		cleanupOwnedSession();
		throw error;
	}

	// 6. Run the prompt with timeout / parent-signal handling, then shape the final result.
	try {
		if (parentAlreadyAborted) {
			// If the parent signal is already aborted, run the prompt anyway
			// (it'll abort quickly after session.abort()) and return an explicit
			// abort result. Race against a short timeout so a hung SDK/dead
			// proxy that ignores session.abort() can't dangle the worker.
			void session.abort();
			// Settle any in-flight parent-bridge ask_user prompt so it can't hang.
			cancelProxy();
			await raceTimeout("prompt (already-aborted)", ALREADY_ABORTED_TIMEOUT_MS, runPrompt());
			currentResult.stopReason = "aborted";
			applyStopReason(currentResult, true, stageRef.value);
			return currentResult;
		}

		const { timeoutSignal, combinedSignal, onAbort, cleanup } = buildCombinedAbortSignal(signal, promptTimeoutMs);
		let timedOut = false;
		const removeAbortListener = onAbort(() => {
			// If the prompt timeout has fired (even if the parent signal also fired
			// simultaneously), flag it as a timeout so callers can distinguish the cause.
			// When the timeout is disabled, timeoutSignal is undefined and this never fires.
			if (timeoutSignal?.aborted) timedOut = true;
			// Immediately stop the child's billable windows (compaction,
			// branch-summary, bash, retry) — these run in the gap between
			// agent_end and teardownSession and are NOT covered by abort().
			// Calling them here (synchronously, before abort()'s observability
			// race below) stops billing the instant the parent is interrupted.
			hardAbortBillable(session);
			// Observability: the un-awaited `void session.abort()` was previously
			// silent — a dangling child (abort() that never settles) was invisible.
			// Emit child.abort.invoked on entry, then race the abort for a short
			// grace to emit .completed (settled) or .dangling-detected (stuck).
			logLoud("child.abort.invoked", {
				toolCallId: _toolCallId,
				agent: agentName,
				task,
				stage: stageRef.value,
				cause: timedOut ? "timeout" : "parent-abort",
			});
			// The 5s dangling-grace timer MUST be clearable: when abort() settles
			// promptly (the common case) the raw `setTimeout` reference would
			// otherwise linger for the full 5s, keeping the event loop alive and
			// tripping node:test's "Promise resolution is still pending" guard on
			// every abort/timeout path (which cascaded into cancelling every later
			// test in execution-paths.test.ts). `clearTimeout` on settle removes it.
			let danglingTimer: ReturnType<typeof setTimeout> | undefined;
			void Promise.race([
				session.abort(),
				new Promise<"__dangling__">((r) => { danglingTimer = setTimeout(() => r("__dangling__"), 5_000); }),
			])
				.then((outcome) => {
					if (danglingTimer) clearTimeout(danglingTimer);
					if (outcome === "__dangling__") {
						logLoud("child.dangling-detected", {
							toolCallId: _toolCallId,
							agent: agentName,
							task,
							stage: stageRef.value,
							cause: "abort-never-settled",
							note: "session.abort() did not settle within 5s — provider teardown may be stuck; the prompt race + settlement net are the remaining escapes",
						});
					} else {
						logLoud("child.abort.completed", {
							toolCallId: _toolCallId,
							agent: agentName,
							task,
							stage: stageRef.value,
						});
					}
				})
				.catch(() => {
					if (danglingTimer) clearTimeout(danglingTimer);
					// abort() rejected — still log so a dangling child is diagnosable.
					logLoud("child.abort.rejected", {
						toolCallId: _toolCallId,
						agent: agentName,
						task,
						stage: stageRef.value,
					});
				});
			// Settle any in-flight parent-bridge ask_user prompt so it can't hang.
			cancelProxy();
		});

		stageRef.value = "waiting for model response";
		setActivity(currentResult, "waiting_provider", currentResult.provider ? `waiting for ${currentResult.provider}` : "waiting for model response");
		emitUpdate();
		// Race the prompt against the combined abort signal. A hung provider
		// stream / hung SDK that ignores `session.abort()` would otherwise
		// hang the parent even after the timeout fires — racing the prompt
		// against the signal guarantees the parent tool-call settles promptly
		// once the abort/timeout is observable. `combinedSignal` is undefined
		// only when there is no parent signal AND the opt-in timeout is disabled;
		// in that case the prompt runs uninterrupted and the settlement net is the
		// liveness escape.
		try {
			if (combinedSignal) {
				await raceAbort(combinedSignal, runPrompt(), "waiting for model response");
			} else {
				await runPrompt();
			}
		} catch (err) {
			// The prompt race rejects when the combined abort signal fires
			// (parent abort OR timeout). When the timeout was the cause —
			// recorded by the onAbort listener setting `timedOut` — stamp a
			// timeout failure so callers can distinguish a hung model response
			// from a user-initiated stop. This must be checked HERE, before the
			// prompt-rejection propagates to the outer catch: the outer catch
			// applies the generic `applyThrownError` (which leaves stopReason
			// undefined and stamps a bare "Request was aborted" message),
			// losing the timeout cause. Returning here short-circuits the outer
			// catch for the timeout case; non-timeout aborts fall through to the
			// outer catch to preserve their enriched stage/cause message.
			if (timedOut) {
				applyTimeoutFailure(currentResult, promptTimeoutMs, stageRef.value);
				return currentResult;
			}
			throw err;
		} finally {
			removeAbortListener();
			// Clear the refed timeout timer now that the race has settled —
			// without this the timer would linger for the remaining timeout
			// window and keep the event loop alive after the result is ready.
			cleanup();
		}

		applyStopReason(currentResult, !!signal?.aborted, stageRef.value);
		return currentResult;
	} catch (err) {
		applyThrownError(currentResult, err, stageRef.value, !!signal?.aborted, _internal?.clock);
		return currentResult;
	} finally {
		cleanupOwnedSession();
	}
}
