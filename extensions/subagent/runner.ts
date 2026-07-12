/**
 * In-process subagent runner. Uses the pi SDK directly via `createAgentSession`
 * so subagents share the parent's auth, model registry, and OAuth tokens.
 *
 * This replaces the previous CLI-subprocess approach (`pi --mode json -p ...`),
 * which failed for newer models routed through the GitHub Copilot gateway.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Message, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

/** Minimal local shapes for the skills filter, avoiding a static import of
 *  Skill/ResourceDiagnostic from the SDK (tsx retains that import at module-load
 *  time in ESM contexts without a resolve hook, breaking execution-path tests
 *  that mock the SDK lazily). Runtime behaviour is unchanged: the override fn
 *  only reads `skill.name` and passes diagnostics through. */
type SubagentSkill = { name: string };
type SubagentSkillsOverride = (base: { skills: SubagentSkill[]; diagnostics: unknown[] }) => { skills: SubagentSkill[]; diagnostics: unknown[] };
import type { AgentConfig } from "./agents.js";
import { getFinalOutput } from "./formatting.js";
import type { ThinkingLevel, BucketSelection } from "./bucket-selector.js";
import { resolveExecutionModel } from "./model-resolution.js";
import type { OnUpdateCallback, SingleResult, SubagentDetails, SubagentTurnThroughputSample } from "./types.js";
import { createInvalidAgentResult } from "./validation.js";
import { toErrorMessage } from "../../shared/error-message.js";
import { subagentContext } from "../../shared/subagent-context.js";
import { readKeptSkills, type KeptSkills } from "../../shared/pruned-skills.js";
import {
	ParentExtensionUIBridgeProxy,
	type ParentBridge,
} from "./src/parent-extension-ui-bridge-proxy.js";
import { inflightSemaphore } from "./src/concurrency-limit.js";
import { ChildLifecycle, makeAttemptId, resolveLivenessConfig, type LeaseViolation } from "./src/lifecycle.js";
import { hardAbortBillable, orphanRegistry } from "./src/cleanup.js";

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
	errorMessage?: string;
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
	createSession: (args: {
		cwd: string;
		modelRegistry: ModelRegistry;
		model: Model<any> | undefined;
		thinkingLevel: ThinkingLevel | undefined;
		tools: string[] | undefined;
		sessionManager: unknown;
		resourceLoader: ResourceLoaderLike;
	}) => Promise<{ session: SessionLike }>;
	createResourceLoader: (args: {
		cwd: string;
		agentDir: string;
		appendSystemPrompt: string[] | undefined;
		noExtensions: boolean;
		/** Optional filter applied to the loaded skills before they enter the
		 *  subagent's system prompt. Used to inherit the parent's pruned set. */
		skillsOverride?: SubagentSkillsOverride;
	}) => ResourceLoaderLike;
	createSessionManager: (cwd: string) => unknown;
	getAgentDir: () => string;
}

let cachedSdkPromise: Promise<SubagentSdk> | undefined;

async function loadSubagentSdk(): Promise<SubagentSdk> {
	if (!cachedSdkPromise) {
		cachedSdkPromise = import("@mariozechner/pi-coding-agent").then((sdk) => ({
			createSession: sdk.createAgentSession,
			createResourceLoader: (args) => new sdk.DefaultResourceLoader(args),
			createSessionManager: (cwd) => sdk.SessionManager.inMemory(cwd),
			getAgentDir: sdk.getAgentDir,
		}));
	}
	return cachedSdkPromise;
}

/** Environment key for overriding the per-prompt subagent timeout (milliseconds). */
const SUBAGENT_TIMEOUT_ENV = "PI_SUBAGENT_TIMEOUT_MS";

/**
 * Default per-prompt timeout for subagent runs, in milliseconds.
 *
 * Subagents are scoped workers — unlike the main session, a subagent turn that
 * runs unboundedly for 30+ minutes is almost always a stuck provider stream /
 * hung SDK (the "Build Out" freeze class), not legitimate long-running work.
 * The parent's abort signal (Ctrl+C / parent cancellation) is the PRIMARY
 * escape; this timeout is the last-resort safety net that guarantees a stuck
 * subagent can't dangle the parent session indefinitely.
 *
 * Disabled by default: productive subagents are bounded by renewable,
 * phase-specific inactivity leases rather than total elapsed time. A custom
 * positive value enables an additional absolute containment ceiling. The main
 * pie session is not affected.
 */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 0;

/**
 * Resolve the per-prompt timeout for subagent runs, in milliseconds.
 *
 * Reads `PI_SUBAGENT_TIMEOUT_MS` from the environment:
 * - A positive number enables an explicit absolute prompt ceiling.
 * - Unset, zero, negative, or invalid disables that ceiling; renewable phase
 *   leases and the outer settlement net still bound inactivity.
 *
 * The parent's abort signal (Ctrl+C / parent cancellation) always takes
 * priority; the timeout is a last-resort net for cases where the provider
 * never responds AND abort() fails to unblock the SDK.
 *
 * Returns the timeout in ms, or `0` to disable the timeout entirely.
 */
export function resolveSubagentTimeoutMs(): number {
	const raw = process.env[SUBAGENT_TIMEOUT_ENV];
	if (raw === undefined || raw === "") return DEFAULT_SUBAGENT_TIMEOUT_MS;
	const ms = Number(raw);
	if (!Number.isFinite(ms) || ms <= 0) return 0;
	return ms;
}

/**
 * Mutable counter shared across an entire nested subagent tree via
 * {@link subagentRuntime}. A fresh one is created at the outermost call and
 * threaded down to every child so a tree-wide session budget can be enforced
 * (independent of the per-call `MAX_SESSIONS_PER_CALL` counter).
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
 * - `processPermitScope` marks a tree whose root child owns a process-wide
 *   capacity permit. Descendants borrow that tree permit instead of acquiring
 *   another one, preventing recursive fan-out from deadlocking behind its own
 *   active ancestors.
 */
export interface SubagentRuntimeContext {
	depth: number;
	trail: string[];
	canSpawn?: string[];
	budget?: TreeBudget;
	processPermitScope?: object;
	/** Main-turn skill selection inherited through every nested level. Storing it
	 * in AsyncLocalStorage avoids depth-2+ children looking up their immediate
	 * in-memory parent session (which has no skill-pruner record) and widening
	 * back to all skills. */
	keptSkills?: KeptSkills;
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

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
	/** When provided and already aborted, workers that haven't started `fn`
	 *  yet (still queued waiting for a free slot) skip their item and return
	 *  the `abortedPlaceholder` instead. `runSingleAgent` also rejects an
	 *  already-aborted entry, but skipping here avoids needless result setup and
	 *  keeps parallel cancellation prompt. */
	signal?: AbortSignal,
	abortedPlaceholder?: TOut,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const placeholder = abortedPlaceholder ?? (undefined as TOut);
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			// If the parent aborted while this worker was queued (waiting for a
			// free slot), skip the remaining items. Returning the placeholder
			// lets `Promise.all` settle promptly and avoids entering child setup
			// after cancellation.
			if (signal?.aborted) {
				results[current] = placeholder;
				continue;
			}
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
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
	modelResolutionDiagnostic: string | undefined,
	provider: string | undefined,
	contextWindow: number | undefined,
	thinkingLevel: ThinkingLevel | undefined,
): SingleResult {
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
		thinkingLevel,
		step,
		streaming: false,
		turnThroughputSamples: [],
	};
	if (modelResolutionDiagnostic) {
		result.modelResolutionDiagnostic = modelResolutionDiagnostic;
	}
	return result;
}

/** Progress delivery is observational and must never own child correctness.
 * A renderer/bridge exception cannot be allowed to leak a session or permit. */
function emitUpdateSafely(onUpdate: OnUpdateCallback | undefined, partial: Parameters<OnUpdateCallback>[0]): void {
	if (!onUpdate) return;
	try {
		onUpdate(partial);
	} catch (error) {
		logLoud("subagent progress callback failed", { error: toErrorMessage(error) });
	}
}

/** Build the update emitter that publishes partial state to the parent UI. */
function createUpdateEmitter(
	result: SingleResult,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	streamingTextRef: { value: string },
): () => void {
	return () => {
		if (!onUpdate) return;
		// Prefer the final output from completed messages; fall back to in-flight streaming text.
		const finalOutput = getFinalOutput(result.messages);
		const text = finalOutput || streamingTextRef.value || "(running...)";
		emitUpdateSafely(onUpdate, {
			content: [{ type: "text", text }],
			details: makeDetails([result]),
		});
	};
}

/** Record a completed assistant message's usage and metadata into the result. */
function recordAssistantMessage(result: SingleResult, msg: SubagentEventMessage): void {
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
	if (msg.stopReason) result.stopReason = msg.stopReason;
	if (msg.errorMessage) result.errorMessage = msg.errorMessage;
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
 * Graceful no-op when the assistant message carrying this toolCall hasn't been
 * committed yet (`message_end` pending) — the next update catches it.
 */
function applyToolExecutionUpdate(
	result: SingleResult,
	toolCallId: string,
	partialResult: unknown,
	emitUpdate: () => void,
): void {
	if (partialResult === undefined) return;
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
			if (tc.status === "completed" || tc.status === "failed") return;
			tc.result = partialResult;
			tc.status = "running";
			emitUpdate();
			return;
		}
	}
	// No matching toolCall part yet — the assistant message carrying it hasn't
	// been committed (message_end pending). The next update will catch it.
}

/** Wire up a subscription to session events, mutating `result` and emitting updates. */
function subscribeToSession(
	session: { subscribe: (cb: (event: SubagentSessionEvent) => void) => () => void },
	result: SingleResult,
	emitUpdate: () => void,
	streamingTextRef: { value: string },
	stageRef: { value: string },
	turnStartRef: { value: number | null },
	lifecycle?: ChildLifecycle,
): () => void {
	// Tool names are not unique in a parallel batch (two bash calls are common).
	// Track by call id so one completion cannot erase a still-running sibling.
	const runningTools = new Map<string, string>();
	let anonymousToolSequence = 0;
	return session.subscribe((event) => {
		if (lifecycle?.isTerminal) return;
		if (event.type === "message_start" && event.message?.role === "assistant") {
			lifecycle?.transition("waiting_provider", { type: "response-headers" });
			turnStartRef.value = Date.now();
			return;
		}
		if (event.type === "message_update") {
			lifecycle?.transition("streaming", { type: "model-delta" });
			handleMessageUpdate(event, result, emitUpdate, streamingTextRef, stageRef);
			return;
		}
		if (event.type === "tool_execution_start" && event.toolName) {
			const key = event.toolCallId ?? `anonymous:${anonymousToolSequence++}`;
			runningTools.set(key, event.toolName);
			lifecycle?.transition("running_tool", { type: "tool-start", description: event.toolName });
			result.runningTools = [...runningTools.values()];
			emitUpdate();
			return;
		}
		if (event.type === "tool_execution_end" && event.toolName) {
			if (event.toolCallId !== undefined) {
				runningTools.delete(event.toolCallId);
			} else {
				const matching = [...runningTools].find(([, name]) => name === event.toolName)?.[0];
				if (matching !== undefined) runningTools.delete(matching);
			}
			result.runningTools = [...runningTools.values()];
			if (runningTools.size > 0) {
				lifecycle?.progress({ type: "tool-end", description: `${runningTools.size} tool(s) still running` });
			} else {
				lifecycle?.transition("waiting_provider", { type: "tool-end", description: event.toolName });
			}
			emitUpdate();
			return;
		}
		if (event.type === "tool_execution_update" && event.toolCallId !== undefined) {
			lifecycle?.progress({ type: "tool-heartbeat" });
			applyToolExecutionUpdate(result, event.toolCallId, event.partialResult, emitUpdate);
			return;
		}
		if (event.type === "message_end" && event.message) {
			lifecycle?.progress({ type: "message-end" });
			handleMessageEnd(event.message, result, emitUpdate, streamingTextRef, turnStartRef);
		}
	});
}

/** Handle streaming text_delta events from the assistant. */
function handleMessageUpdate(
	event: SubagentSessionEvent,
	result: SingleResult,
	emitUpdate: () => void,
	streamingTextRef: { value: string },
	stageRef: { value: string },
): void {
	// Accumulate streaming text deltas so the user sees output as it arrives.
	// The SDK delivers events in order per message: message_start → message_update* → message_end.
	// A single `streamingText` buffer is sufficient because only one assistant
	// message streams at a time in the subagent's single-prompt session.
	const ae = event.assistantMessageEvent;
	if (!ae) return;
	if (ae.type === "text_delta" && ae.delta) {
		// First delta ⇒ the model has started streaming; tracked so abort/timeout
		// diagnostics can distinguish prefill ("waiting for model response") from
		// a mid-stream interrupt ("streaming").
		stageRef.value = "streaming";
		streamingTextRef.value += ae.delta;
		result.streamingText = streamingTextRef.value;
		result.streaming = true;
		emitUpdate();
	} else if (ae.type === "thinking_delta" && ae.thinking) {
		// Reasoning deltas don't accumulate into `streamingText` (a complete
		// thinking block is committed to `messages` at `message_end`), but they
		// DO signal the model is actively generating. Set the `streaming` flag so
		// the host's token-rate clock keeps advancing through a reasoning-only
		// stream — matching the main session, which counts the streaming
		// message's `thinking` live. Without this, a thinking-heavy subagent's
		// clock would pause mid-reasoning and spike when the message landed.
		stageRef.value = "streaming";
		result.streaming = true;
		emitUpdate();
	}
}

/**
 * Map a finished assistant message's stop reason onto a throughput-sample
 * status. Mirrors the host's `toTurnThroughputStatus` semantics.
 */
function toSubagentThroughputStatus(rawMessage: SubagentEventMessage): SubagentTurnThroughputSample['status'] {
	if (rawMessage.errorMessage || rawMessage.stopReason === 'error') {
		return 'error';
	}
	if (rawMessage.stopReason === 'aborted' || rawMessage.stopReason === 'interrupted') {
		return 'interrupted';
	}
	return 'completed';
}

/** Handle a completed message, recording usage and resetting streaming buffers. */
function handleMessageEnd(
	rawMessage: SubagentEventMessage,
	result: SingleResult,
	emitUpdate: () => void,
	streamingTextRef: { value: string },
	turnStartRef: { value: number | null },
): void {
	const msg = rawMessage as Message;
	if (msg.role === "assistant" || msg.role === "toolResult") {
		result.messages.push(msg);
	}
	if (msg.role === "assistant") {
		recordAssistantMessage(result, rawMessage);
		// Clear streaming text once a complete assistant message is committed.
		// (Only assistant messages produce text_delta events, so only reset on those.)
		streamingTextRef.value = "";
		result.streamingText = undefined;
		// The model finished generating this turn — clear the streaming flag so
		// the host's token-rate clock pauses during the subsequent tool call /
		// between turns, until the next turn's first delta re-sets it.
		result.streaming = false;

		// Record a per-turn throughput observation for this assistant turn so
		// the parent run's historical tok/s includes subagent generation work,
		// attributed to the model the subagent actually ran on.
		const nowMs = Date.now();
		const startedAt = turnStartRef.value;
		const generationDurationMs = Math.max(0, nowMs - (startedAt ?? nowMs));
		const outputTokens = rawMessage.usage?.output ?? 0;
		const status = toSubagentThroughputStatus(rawMessage);
		// Match the host tracker's guard: keep the sample when there is
		// measurable generation time, output tokens, or a non-completed status.
		if (generationDurationMs > 0 || outputTokens > 0 || status !== 'completed') {
			const samples = result.turnThroughputSamples ?? (result.turnThroughputSamples = []);
			samples.push({
				endedAt: new Date().toISOString(),
				outputTokens,
				generationDurationMs,
				status,
				modelId: result.model ?? rawMessage.model,
			});
		}
		turnStartRef.value = null;
	}
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

/** Combine abort sources without relying on AbortSignal.any. The fallback is
 * important for older embedded Node runtimes: dropping the lease signal would
 * make pre-spawn phases unbounded whenever a parent signal also existed. The
 * disposer is mandatory on normal completion because `once` listeners otherwise
 * remain attached forever when none of the sources aborts. */
function combineAbortSignals(signals: Array<AbortSignal | undefined>): {
	signal: AbortSignal | undefined;
	cleanup: () => void;
} {
	const active = signals.filter((value): value is AbortSignal => value !== undefined);
	if (active.length === 0) return { signal: undefined, cleanup: () => {} };
	if (active.length === 1) return { signal: active[0], cleanup: () => {} };
	if (typeof AbortSignal.any === "function") return { signal: AbortSignal.any(active), cleanup: () => {} };
	const controller = new AbortController();
	const listeners = new Map<AbortSignal, () => void>();
	const cleanup = () => {
		for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
		listeners.clear();
	};
	const abortFrom = (source: AbortSignal) => {
		if (!controller.signal.aborted) controller.abort(source.reason);
		cleanup();
	};
	for (const signal of active) {
		if (signal.aborted) {
			abortFrom(signal);
			break;
		}
		const listener = () => abortFrom(signal);
		listeners.set(signal, listener);
		signal.addEventListener("abort", listener, { once: true });
	}
	return { signal: controller.signal, cleanup };
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
			if (parentSignal.aborted) {
				handler();
				return () => {};
			}
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
	let cleanupCombined = () => {};
	if (parentSignal) {
		if (typeof AbortSignal.any === 'function') {
			signal = AbortSignal.any([parentSignal, timeoutSignal]);
		} else {
			// Fallback for runtimes without AbortSignal.any. Both listeners must be
			// removed on ordinary prompt completion, not only when one source aborts.
			const controller = new AbortController();
			const onParent = () => abortFrom(parentSignal);
			const onTimeout = () => abortFrom(timeoutSignal);
			cleanupCombined = () => {
				parentSignal.removeEventListener('abort', onParent);
				timeoutSignal.removeEventListener('abort', onTimeout);
			};
			const abortFrom = (source: AbortSignal) => {
				if (!controller.signal.aborted) controller.abort(source.reason);
				cleanupCombined();
			};
			if (parentSignal.aborted) {
				abortFrom(parentSignal);
			} else if (timeoutSignal.aborted) {
				abortFrom(timeoutSignal);
			} else {
				parentSignal.addEventListener('abort', onParent, { once: true });
				timeoutSignal.addEventListener('abort', onTimeout, { once: true });
			}
			signal = controller.signal;
		}
	} else {
		signal = timeoutSignal;
	}
	const onAbort = (handler: () => void): (() => void) => {
		if (signal.aborted) {
			handler();
			return () => {};
		}
		signal.addEventListener("abort", handler, { once: true });
		return () => signal.removeEventListener("abort", handler);
	};
	return {
		timeoutSignal,
		combinedSignal: signal,
		onAbort,
		cleanup: () => {
			cleanupTimeout();
			cleanupCombined();
		},
	};
}

/** Apply a timeout-failure to a result. */
function applyTimeoutFailure(result: SingleResult, timeoutMs: number, stage?: string): void {
	result.exitCode = 1;
	result.stopReason = "timeout";
	const suffix = stage ? ` (while ${stage})` : "";
	result.errorMessage = `Subagent timed out after ${timeoutMs / 1000}s waiting for model response${suffix}.`;
	result.streamingText = undefined;
	result.streaming = false;
	result.runningTools = [];
}

/** Apply a stop-reason-based exit code to a result. */
function applyStopReason(result: SingleResult, parentAborted: boolean, stage?: string): void {
	const stop = result.stopReason;
	if (stop === "error" || stop === "aborted") {
		result.exitCode = 1;
	} else {
		result.exitCode = 0;
	}
	result.streamingText = undefined;
	result.streaming = false;
	result.runningTools = [];
	if (parentAborted) {
		result.stopReason = "aborted";
		if (result.exitCode === 0) result.exitCode = 1;
		if (!result.errorMessage) result.errorMessage = "Subagent was aborted";
	}
	// Enrich whatever message we have (the SDK's raw "Request was aborted" or
	// similar) with the run stage and cause, mirroring applyTimeoutFailure /
	// applyThrownError — otherwise an abort surfaces as a bare, contextless
	// provider string with no indication of when/why it happened.
	if (stop === "aborted" && stage) {
		const cause = parentAborted ? "parent interrupted" : "provider/session aborted";
		const base = result.errorMessage || "Request was aborted";
		result.errorMessage = `${base} (${cause}, while ${stage})`;
	}
}

/** Apply a thrown error to a result, preserving any previously-recorded message. */
function applyThrownError(result: SingleResult, err: unknown, stage?: string): void {
	result.exitCode = 1;
	const message = toErrorMessage(err);
	const suffix = stage ? ` (while ${stage})` : "";
	result.errorMessage = (result.errorMessage || message) + suffix;
	result.stderr = result.stderr || message;
	result.streamingText = undefined;
	result.streaming = false;
	result.runningTools = [];
}

/** Copy lifecycle classification onto the durable child result so retry/failover
 * policy can reject auth, cancellation, partial-output, and tool-side-effect
 * replays instead of treating every non-zero exit as model-failover-safe. */
function attachFailureClassification(result: SingleResult, lifecycle: ChildLifecycle): void {
	const classified = lifecycle.classified;
	if (!classified) return;
	result.failureClass = classified.class;
	result.retryable = classified.retryable;
	result.replaySafety = classified.replaySafety;
	result.retryAfterMs = classified.retryAfterMs;
}

/** Terminalize and surface a failure that occurs before a child session is owned. */
function applyPreSpawnFailure(
	result: SingleResult,
	lifecycle: ChildLifecycle,
	err: unknown,
	parentAborted: boolean,
	metadata: { toolCallId?: string; agent: string; task: string; stage: string },
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): void {
	result.exitCode = 1;
	result.errorMessage = toErrorMessage(err);
	result.stderr = result.errorMessage;
	if (parentAborted) {
		result.stopReason = "aborted";
		lifecycle.cancel(result.errorMessage);
	} else {
		lifecycle.fail(err);
	}
	attachFailureClassification(result, lifecycle);
	const classified = lifecycle.classified;
	logLoud("subagent pre-spawn aborted/failed", {
		...metadata,
		cause: (err as { name?: string } | null)?.name === "AbortError" ? "aborted" : "error",
		failureClass: classified?.class,
		retryable: classified?.retryable,
		replaySafety: classified?.replaySafety,
		httpStatus: classified?.httpStatus,
		error: result.errorMessage,
	});
	emitUpdateSafely(onUpdate, {
		content: [{ type: "text", text: `⚠ ${metadata.agent}: ${result.errorMessage}` }],
		details: makeDetails([result]),
	});
}

/** Tear down a session, swallowing disposal errors. */
function teardownSession(unsubscribe: () => void, session: { dispose: () => void }): void {
	try {
		unsubscribe();
	} catch {
		/* ignore */
	}
	try {
		session.dispose();
	} catch {
		/* ignore */
	}
}

/** Best-effort cleanup for a session returned after its createSession race was
 * already abandoned. The caller has settled and released its permit, so this
 * cleanup must never be awaited; synchronously disposing still prevents a late
 * SDK resolution from leaking extensions, listeners, or provider resources. */
function cleanupLateCreatedSession(
	session: SessionLike,
	agentName: string,
	task: string,
	signalListenersBefore: Map<string, Set<Function>>,
): void {
	hardAbortBillable(session);
	try {
		void session.abort().catch((error) => {
			logLoud("late-created session abort rejected", {
				agent: agentName,
				task,
				error: toErrorMessage(error),
			});
		});
	} catch (error) {
		logLoud("late-created session abort threw", {
			agent: agentName,
			task,
			error: toErrorMessage(error),
		});
	}
	try {
		session.dispose();
	} catch (error) {
		logLoud("late-created session dispose threw", {
			agent: agentName,
			task,
			error: toErrorMessage(error),
		});
	} finally {
		// createSession may itself finish loading provider modules after the
		// caller's first reclaim pass. Sweep again at the actual late-settlement
		// boundary so those listeners cannot escape the snapshot window.
		reclaimOrphanedSignalListeners(signalListenersBefore);
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
 * on each of these signals — never removed. Parallel and nested runs can
 * quickly cross Node's default cap (10), causing the host to emit a
 * `MaxListenersExceededWarning` that looks like a pie memory leak.
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
		sdkPromise?: Promise<SubagentSdk>;
		timeoutMs?: number;
	},
): Promise<SingleResult> {
	// 1. Preflight: locate the agent config or short-circuit with an invalid result.
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) return createInvalidAgentResult(agentName, task, agents, step);

	// 2. Resolve the model the session will run on.
	const sessionCwd = cwd ?? defaultCwd;
	const modelOverride = bucketSelection?.modelId;
	const thinkingLevel = bucketSelection?.thinkingLevel;
	const requestedModel = modelOverride ?? agent.model;
	const {
		resolvedModel,
		actualModelId,
		diagnostic: modelResolutionDiagnostic,
	} = resolveExecutionModel(modelRegistry, callerModel, requestedModel, disabledProviders);

	// 3. Build the result accumulator and the update emitter.
	const currentResult = createInitialResult(
		agent,
		agentName,
		task,
		step,
		actualModelId,
		modelResolutionDiagnostic,
		resolvedModel?.provider,
		resolvedModel?.contextWindow,
		thinkingLevel,
	);

	// A queued retry or parallel worker can enter after the parent has already
	// been interrupted. Starting a fresh SDK session in that state is not
	// cleanup: it creates new provider work after Stop, and was the direct cause
	// of agents appearing to "wake up" only when interrupted before cancelling.
	// There is no child UI/session to settle yet, so terminalize without loading
	// resources, acquiring capacity, creating a session, or prompting a model.
	if (signal?.aborted) {
		currentResult.exitCode = 1;
		currentResult.stopReason = "aborted";
		currentResult.errorMessage = "Subagent was skipped because the parent was already aborted";
		currentResult.stderr = currentResult.errorMessage;
		onUpdate?.({
			content: [{ type: "text", text: `⚠ ${agentName}: ${currentResult.errorMessage}` }],
			details: makeDetails([currentResult]),
		});
		return currentResult;
	}

	const streamingTextRef = { value: "" };
	const emitUpdate = createUpdateEmitter(currentResult, onUpdate, makeDetails, streamingTextRef);
	const lifecycle = new ChildLifecycle(
		makeAttemptId(agentName),
		resolveLivenessConfig(),
		Date.now,
		(activity) => {
			currentResult.activityPhase = activity.phase;
			currentResult.activityDetail = activity.detail;
			currentResult.activitySince = activity.phaseStartedAt;
			currentResult.lastProgressAt = activity.lastProgressAt;
			currentResult.inactivityBudgetMs = activity.budgetMs;
			emitUpdate();
		},
	);
	lifecycle.provider = resolvedModel?.provider;
	lifecycle.model = actualModelId;
	const runtimeStore = readRuntimeContext();
	const inheritedPermitScope = runtimeStore.processPermitScope;
	lifecycle.transition(
		inheritedPermitScope ? "preparing" : "queued",
		inheritedPermitScope
			? { type: "permit-inherited", description: "using ancestor subagent tree capacity" }
			: { type: "concurrency-wait", description: "waiting for process-wide subagent tree capacity" },
	);
	const leaseController = new AbortController();
	let leaseViolation: LeaseViolation | undefined;
	lifecycle.startWatchdog((violation) => {
		leaseViolation = violation;
		leaseController.abort(new Error(violation.reason));
	});
	const effectiveAbort = combineAbortSignals([signal, leaseController.signal]);
	const effectiveSignal = effectiveAbort.signal!;
	lifecycle.registerCleanup(effectiveAbort.cleanup);

	let sdk: SubagentSdk;
	try {
		if (!inheritedPermitScope) {
			const release = await inflightSemaphore.acquire(effectiveSignal);
			const ownedPermitScope = {};
			runtimeStore.processPermitScope = ownedPermitScope;
			lifecycle.setRelease(() => {
				if (runtimeStore.processPermitScope === ownedPermitScope) {
					delete runtimeStore.processPermitScope;
				}
				release();
			});
		}
		lifecycle.transition("preparing", { type: "permit-acquired", description: "loading subagent runtime" });
		const sdkPromise = _internal?.sdkPromise
			?? (_internal?.sdk ? Promise.resolve(_internal.sdk) : loadSubagentSdk());
		sdk = await raceAbort(effectiveSignal, sdkPromise, "loading subagent SDK");
	} catch (err) {
		applyPreSpawnFailure(
			currentResult,
			lifecycle,
			err,
			signal?.aborted === true,
			{ toolCallId: _toolCallId, agent: agentName, task, stage: "sdk-load-or-capacity" },
			onUpdate,
			makeDetails,
		);
		return currentResult;
	}
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
	// Prefer the tree-threaded value. Depth-2+ immediate parents are in-memory
	// subagent sessions and never run the skill-pruner prepass, so looking them up
	// by session id widens nested prompts back to every skill.
	const kept = readRuntimeContext().keptSkills ?? (parentSessionId ? readKeptSkills(parentSessionId) : undefined);
	// A non-empty kept set filters the subagent's skills to exactly those the
	// main turn kept. An empty array remains the existing keep-all safeguard.
	if (Array.isArray(kept) && kept.length > 0) {
		const keptSet = new Set(kept);
		skillsOverride = (base) => ({
			skills: base.skills.filter((s) => keptSet.has(s.name)),
			diagnostics: base.diagnostics,
		});
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

	// Pre-spawn phase: resource load → session creation. Root children acquired a
	// process-wide tree permit before SDK/resource work; nested children borrow
	// that ancestor scope so a fully occupied process cannot deadlock when every
	// active parent delegates again. The parent abort signal MUST interrupt every
	// phase — not just `runPrompt()` — otherwise a worker stuck here can't be
	// stopped (the "Build Out" freeze class). Root permits remain registered with
	// the lifecycle for the complete tree lifetime and release exactly once.
	//
	// Snapshot exit-signal listeners BEFORE `resourceLoader.reload()`. The
	// SDK's loader pulls in transitive provider HTTP-handler code that leaks
	// an orphaned pool-dispose SIGINT/SIGTERM closure per reload (see
	// `reclaimOrphanedSignalListeners`); capturing the baseline here lets the
	// `finally` below reclaim exactly those additions so the host's listener
	// count stays bounded across many parallel/nested subagent runs.
	const signalListenersBefore = snapshotSignalListeners();
	let session: SessionLike;
	let resourceReloadPromise: Promise<void> | undefined;
	let createSessionPromise: Promise<{ session: SessionLike }> | undefined;
	try {
		resourceReloadPromise = resourceLoader.reload();
		await raceAbort(effectiveSignal, resourceReloadPromise, "loading subagent resources");
		lifecycle.progress({ type: "resources-loaded", description: "creating isolated session" });
		if (effectiveSignal.aborted) throw abortError("creating subagent session");
		createSessionPromise = sdk.createSession({
			cwd: sessionCwd,
			modelRegistry,
			model: resolvedModel,
			thinkingLevel,
			tools: effectiveTools,
			sessionManager: sdk.createSessionManager(sessionCwd),
			resourceLoader,
		});
		const created = await raceAbort(effectiveSignal, createSessionPromise, "creating subagent session");
		session = created.session;
	} catch (err) {
		// If createSession resolves after the abort race has already rejected,
		// nobody else owns the returned session. Dispose it asynchronously rather
		// than leaking a hidden child runtime after the parent tool call settled.
		if (resourceReloadPromise) {
			void resourceReloadPromise.then(
				() => reclaimOrphanedSignalListeners(signalListenersBefore),
				() => reclaimOrphanedSignalListeners(signalListenersBefore),
			);
		}
		if (createSessionPromise) {
			void createSessionPromise.then(
				(created) => cleanupLateCreatedSession(created.session, agentName, task, signalListenersBefore),
				() => {},
			);
		}
		// Pre-spawn abort or failure: never reach the prompt phase. Return a
		// loud failure result so `execute()` always settles and the parent
		// transcript/toolResult is written. This is the structural guarantee
		// that a stuck worker can't silently dangle the parent session.
		applyPreSpawnFailure(
			currentResult,
			lifecycle,
			err,
			signal?.aborted === true,
			{ toolCallId: _toolCallId, agent: agentName, task, stage: "pre-spawn" },
			onUpdate,
			makeDetails,
		);
		// Reclaim any orphaned exit-signal listeners the loader leaked before
		// the pre-spawn phase failed (reload may have run partially). See the
		// snapshot above and `reclaimOrphanedSignalListeners`.
		reclaimOrphanedSignalListeners(signalListenersBefore);
		return currentResult;
	}

	// Everything after session creation is inside one ownership boundary. Any
	// setup failure (model getter, UI bridge, subscribe, progress callback) must
	// still terminalize the lifecycle, release the permit, and dispose the child.
	const stageRef = { value: "preparing" };
	const turnStartRef: { value: number | null } = { value: null };
	let proxy: ParentExtensionUIBridgeProxy | undefined;
	let unsubscribe: () => void = () => {};
	const subagentDepth = readRuntimeContext().depth;
	const runPrompt = (): Promise<void> =>
		subagentContext.run({ depth: subagentDepth }, () => session.prompt(`Task: ${task}`));

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
	unsubscribe = subscribeToSession(session, currentResult, emitUpdate, streamingTextRef, stageRef, turnStartRef, lifecycle);

	// Emit an early progress signal (B) so the UI doesn't look hung during
	// resource load + model prefill, before the first streamed delta. The
	// skill-pruner prepass is skipped inside subagent sessions (see
	// shouldSkipPruning), so this window is just prefill — but it can still be
	// long for large prompts, and previously showed nothing at all.
	emitUpdateSafely(onUpdate, {
		content: [{ type: "text", text: `Starting ${agentName}…` }],
		details: makeDetails([currentResult]),
	});

	// 6. Run the prompt with timeout / parent-signal handling, then shape the final result.
		const { timeoutSignal, combinedSignal, onAbort, cleanup } = buildCombinedAbortSignal(effectiveSignal, promptTimeoutMs);
		let timedOut = false;
		const removeAbortListener = onAbort(() => {
			// If the prompt timeout has fired (even if the parent signal also fired
			// simultaneously), flag it as a timeout so callers can distinguish the cause.
			// When the timeout is disabled, timeoutSignal is undefined and this never fires.
			if (timeoutSignal?.aborted || leaseController.signal.aborted) timedOut = true;
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
			// Defer invocation so even a non-conforming synchronous throw from
			// session.abort() becomes a handled rejection rather than escaping the
			// AbortSignal event listener and skipping the remaining cleanup.
			const abortPromise = Promise.resolve().then(() => session.abort());
			void Promise.race([
				abortPromise,
				new Promise<"__dangling__">((r) => { danglingTimer = setTimeout(() => r("__dangling__"), 5_000); }),
			])
				.then((outcome) => {
					if (danglingTimer) clearTimeout(danglingTimer);
					if (outcome === "__dangling__") {
						orphanRegistry.register({
							attemptId: lifecycle.attemptId,
							provider: lifecycle.provider,
							model: lifecycle.model,
							phase: lifecycle.phase,
							detachedAt: Date.now(),
							lastError: "session.abort() did not settle within grace",
							billableWindowsStopped: true,
						}, async () => {
							await session.abort();
							session.dispose();
						});
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
			try { proxy?.cancelAll(); } catch (error) {
				logLoud("subagent UI cancellation failed", { agent: agentName, error: toErrorMessage(error) });
			}
		});

		stageRef.value = "waiting for model response";
		lifecycle.transition("waiting_provider", { type: "prompt-dispatched", description: "waiting for provider response" });
		// Race the prompt against the combined abort signal. A hung provider
		// stream / hung SDK that ignores `session.abort()` would otherwise
		// hang the parent even after the timeout fires — racing the prompt
		// against the signal guarantees the parent tool-call settles promptly
		// once the abort/timeout is observable. `combinedSignal` is undefined
		// only when there is no parent signal AND the timeout is disabled
		// (the pre-fix default); in that case the prompt runs uninterrupted
		// (today's behavior — the settlement net is the only escape).
		try {
			if (combinedSignal) {
				// Do not evaluate runPrompt() until after the abort check. An abort
				// can land after createSession/subscribe but before this phase; calling
				// prompt first would start fresh provider work after Stop and only then
				// notice that the signal was already aborted.
				if (combinedSignal.aborted) throw abortError("waiting for model response");
				const promptPromise = runPrompt();
				// A provider/mock can synchronously abort the parent while prompt()
				// creates its promise. In that narrow window raceAbort observes an
				// already-aborted signal and throws before attaching handlers to the
				// prompt promise. Observe its eventual rejection here so it cannot
				// escape as an unhandledRejection after the parent has settled.
				promptPromise.catch(() => {});
				await raceAbort(combinedSignal, promptPromise, "waiting for model response");
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
				applyTimeoutFailure(currentResult, leaseViolation?.budgetMs ?? promptTimeoutMs, leaseViolation?.phase ?? stageRef.value);
				lifecycle.fail(currentResult.errorMessage);
				attachFailureClassification(currentResult, lifecycle);
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

		applyStopReason(currentResult, signal?.aborted === true, stageRef.value);
		if (currentResult.exitCode === 0) lifecycle.finish(currentResult);
		else {
			lifecycle.fail(currentResult.errorMessage);
			attachFailureClassification(currentResult, lifecycle);
		}
		return currentResult;
	} catch (err) {
		applyThrownError(currentResult, err, stageRef.value);
		if (signal?.aborted) {
			// User/parent cancellation is terminal and must never be mistaken for
			// a model failure eligible for fallback retry. Override an earlier
			// toolUse/error stop reason because Stop owns the final outcome.
			currentResult.stopReason = "aborted";
			lifecycle.cancel(currentResult.errorMessage ?? "parent abort");
		} else {
			lifecycle.fail(err);
		}
		attachFailureClassification(currentResult, lifecycle);
		// Surface the classified provider failure so the cause (transport /
		// timeout / 429 / 5xx / auth / abort) and replay safety are observable
		// in the [pie:subagent] log stream. Classification is recorded only —
		// this does not change retry, model selection, or failover behaviour.
		const promptClassified = lifecycle.classified;
		logLoud("subagent prompt failed", {
			toolCallId: _toolCallId,
			agent: agentName,
			task,
			stage: stageRef.value,
			cause: signal?.aborted ? "parent-abort" : "error",
			failureClass: promptClassified?.class,
			retryable: promptClassified?.retryable,
			replaySafety: promptClassified?.replaySafety,
			httpStatus: promptClassified?.httpStatus,
			retryAfterMs: promptClassified?.retryAfterMs,
			error: currentResult.errorMessage,
		});
		return currentResult;
	} finally {
		lifecycle.dispose();
		teardownSession(unsubscribe, session);
		// Reclaim the orphaned exit-signal listeners the SDK's loader leaked
		// during this session (see `snapshotSignalListeners` above). Runs after
		// `teardownSession` so the session's own disposal has settled; the
		// reclaimed closures are pure no-arg pool-disposers that are no-ops on
		// a live host anyway. No-op for the mock SDK / a fixed upstream.
		reclaimOrphanedSignalListeners(signalListenersBefore);
	}
}
