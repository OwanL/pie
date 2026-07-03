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
import type { AgentConfig } from "./agents.js";
import { getFinalOutput } from "./formatting.js";
import type { ThinkingLevel, BucketSelection } from "./bucket-selector.js";
import { resolveExecutionModel } from "./model-resolution.js";
import type { OnUpdateCallback, SingleResult, SubagentDetails } from "./types.js";
import { createInvalidAgentResult } from "./validation.js";
import { toErrorMessage } from "../../shared/error-message.js";
import { subagentContext } from "../../shared/subagent-context.js";
import {
	ParentExtensionUIBridgeProxy,
	type ParentBridge,
} from "./src/parent-extension-ui-bridge-proxy.js";
import { inflightSemaphore } from "./src/concurrency-limit.js";

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
 * Resolve the per-prompt timeout for subagent runs, in milliseconds.
 *
 * Reads `PI_SUBAGENT_TIMEOUT_MS` from the environment:
 * - A positive number (milliseconds) sets an explicit timeout safety net that
 *   wraps the *entire* multi-turn run (all turns + tool calls), not just one
 *   model response.
 * - Unset, `0`, or invalid → no timeout. Subagents run until they finish or
 *   the parent aborts. This is the default: subagents should not time out
 *   during legitimate long-running work. The parent's abort signal (Ctrl+C /
 *   parent cancellation) always remains the real escape hatch.
 *
 * Returns the timeout in ms, or `0` to disable the timeout entirely.
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
 */
export interface SubagentRuntimeContext {
	depth: number;
	trail: string[];
	canSpawn?: string[];
	budget?: TreeBudget;
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
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
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
	actualModelId: string,
	modelResolutionDiagnostic: string | undefined,
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
		step,
	};
	if (modelResolutionDiagnostic) {
		result.modelResolutionDiagnostic = modelResolutionDiagnostic;
	}
	return result;
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
		onUpdate({
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
): () => void {
	return session.subscribe((event) => {
		if (event.type === "message_update") {
			handleMessageUpdate(event, result, emitUpdate, streamingTextRef, stageRef);
			return;
		}
		if (event.type === "tool_execution_start" && event.toolName) {
			result.runningTools = [...(result.runningTools ?? []), event.toolName];
			emitUpdate();
			return;
		}
		if (event.type === "tool_execution_end" && event.toolName) {
			result.runningTools = (result.runningTools ?? []).filter((t) => t !== event.toolName);
			emitUpdate();
			return;
		}
		if (event.type === "tool_execution_update" && event.toolCallId !== undefined) {
			applyToolExecutionUpdate(result, event.toolCallId, event.partialResult, emitUpdate);
			return;
		}
		if (event.type === "message_end" && event.message) {
			handleMessageEnd(event.message, result, emitUpdate, streamingTextRef);
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
	if (event.assistantMessageEvent?.type === "text_delta" && event.assistantMessageEvent.delta) {
		// First delta ⇒ the model has started streaming; tracked so abort/timeout
		// diagnostics can distinguish prefill ("waiting for model response") from
		// a mid-stream interrupt ("streaming").
		stageRef.value = "streaming";
		streamingTextRef.value += event.assistantMessageEvent.delta;
		result.streamingText = streamingTextRef.value;
		emitUpdate();
	}
}

/** Handle a completed message, recording usage and resetting streaming buffers. */
function handleMessageEnd(
	rawMessage: SubagentEventMessage,
	result: SingleResult,
	emitUpdate: () => void,
	streamingTextRef: { value: string },
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
	}
	emitUpdate();
}

/** Build a per-call abort signal that fires on either the parent signal or the timeout. */
function buildCombinedAbortSignal(parentSignal: AbortSignal | undefined, timeoutMs: number): {
	timeoutSignal: AbortSignal | undefined;
	onAbort: (handler: () => void) => () => void;
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
		return { timeoutSignal: undefined, onAbort };
	}

	const timeoutSignal = AbortSignal.timeout(timeoutMs);
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
	return { timeoutSignal, onAbort };
}

/** Apply a timeout-failure to a result. */
function applyTimeoutFailure(result: SingleResult, timeoutMs: number, stage?: string): void {
	result.exitCode = 1;
	result.stopReason = "timeout";
	const suffix = stage ? ` (while ${stage})` : "";
	result.errorMessage = `Subagent timed out after ${timeoutMs / 1000}s waiting for model response${suffix}.`;
	result.streamingText = undefined;
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
	if (parentAborted && result.exitCode === 0) {
		result.exitCode = 1;
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
	/** Internal test seam to avoid loading the real SDK and long timeout delays. */
	_internal?: {
		sdk?: SubagentSdk;
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
	);
	const streamingTextRef = { value: "" };
	const emitUpdate = createUpdateEmitter(currentResult, onUpdate, makeDetails, streamingTextRef);

	const sdk = _internal?.sdk ?? (await loadSubagentSdk());
	const promptTimeoutMs = _internal?.timeoutMs ?? resolveSubagentTimeoutMs();

	// 4. Build an isolated resource loader and create the session.
	// - appendSystemPrompt threads the agent's instructions into the system prompt
	// - noExtensions is intentionally false so the subagent extension (and others)
	//   load into nested sessions, enabling further delegation. Nesting is bounded
	//   by the depth/trail/tree-budget guards in execute()/modes.ts, not by hiding
	//   the tool.
	const resourceLoader = sdk.createResourceLoader({
		cwd: sessionCwd,
		agentDir: sdk.getAgentDir(),
		appendSystemPrompt: agent.systemPrompt.trim() ? [agent.systemPrompt] : undefined,
		noExtensions: false,
	});
	await resourceLoader.reload();

	const release = await inflightSemaphore.acquire();
	let session: SessionLike;
	try {
		const created = await sdk.createSession({
			cwd: sessionCwd,
			modelRegistry,
			model: resolvedModel,
			thinkingLevel,
			tools: agent.tools,
			sessionManager: sdk.createSessionManager(sessionCwd),
			resourceLoader,
		});
		session = created.session;
	} finally {
		release();
	}

	// Capture the model the session actually selected (in case our hint was overridden).
	if (session.agent?.state?.model) {
		currentResult.model = session.agent.state.model.id;
	}

	// Inject the parent UI bridge proxy so subagent ask_user calls appear in the parent UI.
	let proxy: ParentExtensionUIBridgeProxy | undefined;
	if (parentUiBridge && _toolCallId) {
		proxy = new ParentExtensionUIBridgeProxy(parentUiBridge, _toolCallId);
		session.extensionRunner.setUIContext(proxy);
	}

	// Track the current run stage for abort/timeout diagnostics (D). The first
	// streamed text_delta flips this to "streaming" (see handleMessageUpdate);
	// "waiting for model response" covers prefill (the common abort window, and
	// the one that produced the bare "Request was aborted" symptom).
	const stageRef = { value: "preparing" };

	// 5. Subscribe to session events.
	const unsubscribe = subscribeToSession(session, currentResult, emitUpdate, streamingTextRef, stageRef);

	// Wrap the prompt in the shared subagent context (A) so extensions whose
	// before_agent_start hooks fire during session.prompt() — notably the
	// skill-pruner prepass — can detect they are inside a scoped subagent
	// session and skip. AsyncLocalStorage is per-async-context, so this is safe
	// under parallel subagent runs (unlike a process.env flag, which would race).
	const subagentDepth = readRuntimeContext().depth;
	const runPrompt = (): Promise<void> =>
		subagentContext.run({ depth: subagentDepth }, () => session.prompt(`Task: ${task}`));

	// Emit an early progress signal (B) so the UI doesn't look hung during
	// resource load + model prefill, before the first streamed delta. The
	// skill-pruner prepass is skipped inside subagent sessions (see
	// shouldSkipPruning), so this window is just prefill — but it can still be
	// long for large prompts, and previously showed nothing at all.
	onUpdate?.({
		content: [{ type: "text", text: `Starting ${agentName}…` }],
		details: makeDetails([currentResult]),
	});

	// 6. Run the prompt with timeout / parent-signal handling, then shape the final result.
	try {
		const parentAlreadyAborted = signal?.aborted === true;
		if (parentAlreadyAborted) {
			// If the parent signal is already aborted, run the prompt anyway
			// (it'll abort quickly) and return an explicit abort result.
			void session.abort();
			// Settle any in-flight parent-bridge ask_user prompt so it can't hang.
			proxy?.cancelAll();
			await runPrompt();
			currentResult.exitCode = 1;
			if (!currentResult.errorMessage) currentResult.errorMessage = `Subagent was aborted (while ${stageRef.value})`;
			return currentResult;
		}

		const { timeoutSignal, onAbort } = buildCombinedAbortSignal(signal, promptTimeoutMs);
		let timedOut = false;
		const removeAbortListener = onAbort(() => {
			// If the prompt timeout has fired (even if the parent signal also fired
			// simultaneously), flag it as a timeout so callers can distinguish the cause.
			// When the timeout is disabled, timeoutSignal is undefined and this never fires.
			if (timeoutSignal?.aborted) timedOut = true;
			void session.abort();
			// Settle any in-flight parent-bridge ask_user prompt so it can't hang.
			proxy?.cancelAll();
		});

		stageRef.value = "waiting for model response";
		try {
			// Race the prompt against a timeout to prevent indefinite hangs.
			// The parent's abort signal takes priority; the timeout is a safety net
			// for cases where the provider never responds.
			await runPrompt();
		} finally {
			removeAbortListener();
		}

		if (timedOut) {
			applyTimeoutFailure(currentResult, promptTimeoutMs, stageRef.value);
			return currentResult;
		}

		applyStopReason(currentResult, signal?.aborted === true, stageRef.value);
		return currentResult;
	} catch (err) {
		applyThrownError(currentResult, err, stageRef.value);
		return currentResult;
	} finally {
		teardownSession(unsubscribe, session);
	}
}
