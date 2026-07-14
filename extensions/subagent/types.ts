/**
 * Shared types for the subagent extension. Extracted from `index.ts` purely
 * to bound that file's size — no behaviour changes.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentScope } from "./agents.js";
import type { ThinkingLevel } from "./bucket-selector.js";

export const COLLAPSED_ITEM_COUNT = 10;
export const MAX_MODEL_RETRIES = 5;
/** Max characters shown when previewing a task description in chain/parallel renderCall. */
export const TASK_PREVIEW_SHORT = 40;
/** Max characters shown when previewing a task description in single-mode renderCall. */
export const TASK_PREVIEW_LONG = 60;
export const AGENT_SCOPE_VALUES = new Set<AgentScope>(["user", "project", "both"]);

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SubagentTurnThroughputSample {
	/** ISO timestamp when the assistant turn ended (`message_end`). */
	endedAt: string;
	/** Output tokens reported for this turn. */
	outputTokens: number;
	/** Wall-clock generation time for this turn in ms (tool-execution excluded). */
	generationDurationMs: number;
	/** Terminal status of the turn. */
	status: 'completed' | 'error' | 'interrupted';
	/** The model this turn ran on. */
	modelId?: string;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	/** Bounded terminal answer kept separately so durable transcript compaction
	 * can remove duplicate final prose from messages without degrading the UI. */
	finalOutput?: string;
	/** True when the durable parent-facing transcript has been compacted. */
	transcriptCompacted?: boolean;
	/** Compact modifying-tool summary used by host/session_changes after verbose
	 * write/edit payloads are removed from the durable child transcript. */
	fileChanges?: Array<{
		path: string;
		kind: "created" | "modified" | "deleted";
		description: string;
		additions?: number;
		deletions?: number;
	}>;
	stderr: string;
	usage: UsageStats;
	/** The model the subagent session actually ran with. */
	model?: string;
	/** Provider that owns the selected model. Kept separate from `model` because
	 * model ids are not guaranteed to include a provider prefix. */
	provider?: string;
	/** Maximum context window of the selected model. Paired with
	 * `usage.contextTokens` for per-child context telemetry in the parent UI. */
	contextWindow?: number;
	stopReason?: string;
	errorMessage?: string;
	/** Streaming text accumulated from in-progress assistant turn, available while running. */
	streamingText?: string;
	/** Streaming reasoning (thinking) accumulated from the in-progress assistant
	 *  turn, available while running. Mirrors {@link streamingText} but captures
	 *  `thinking_delta` events so the parent UI can preview live reasoning before
	 *  any reply text has arrived (the gap that previously surfaced as a generic
	 *  "Generating…" placeholder). Cleared on `message_end` alongside
	 *  {@link streamingText}. */
	streamingReasoning?: string;
	/** True while the subagent's model is actively generating output for the
	 *  in-progress assistant turn (set on the first text/thinking delta, cleared
	 *  on `message_end`). The host's token-rate clock reads this to keep
	 *  advancing through mid-stream stalls AND reasoning-only streams while
	 *  PAUSING during the subagent's own tool calls, between turns, and before
	 *  the first token — mirroring the main session's clock semantics. Without
	 *  it the clock used a sticky "has ever produced" predicate that kept
	 *  advancing (collapsing the rate to 0) while a nested scout sat in
	 *  read/grep/bash calls. */
	streaming?: boolean;
	/**
	 * Per-turn throughput observations recorded from this subagent session.
	 * Forwarded into the parent run's snapshot so historical tok/s includes
	 * subagent work, attributed to the model the subagent actually ran on.
	 */
	turnThroughputSamples?: SubagentTurnThroughputSample[];
	step?: number;
	/** Tool names currently executing in this subagent (cleared when tool finishes). */
	runningTools?: string[];
	/** Current lifecycle phase while the child is running. This deliberately
	 * remains in partial tool-result details so the parent UI can distinguish a
	 * provider wait from useful streaming/tool work or a local queue. */
	activityPhase?: "queued" | "preparing" | "waiting_provider" | "streaming" | "running_tool" | "retry_wait" | "completed" | "failed" | "cancelled" | "orphaned_cleanup";
	/** Human-readable detail for the current phase (for example the active tool). */
	activityDetail?: string;
	/** Epoch milliseconds at which this phase began. */
	activitySince?: number;
	/** Monotonically increasing per-child progress sequence. Incremented only for
	 * credible child activity, allowing parents to distinguish real work from
	 * duplicate `onUpdate` snapshots without relying on wall-clock timestamps. */
	progressGeneration?: number;
	/** Epoch milliseconds at which credible progress was last observed. Kept for
	 * display/diagnostics; settlement renewal uses {@link progressGeneration}. */
	lastProgressAt?: number;
	/** Inactivity budget for this phase. Generous provider budgets remain valid;
	 * exposing them makes a slow/unreliable provider observable rather than
	 * falsely looking crashed. */
	inactivityBudgetMs?: number;
	/** The model actually chosen by bucket selection. */
	selectedModel?: string;
	/** Thinking level applied to this run. */
	thinkingLevel?: ThinkingLevel;
	/** Bucket used for selection ("small", "medium", "frontier"). */
	bucket?: string;
	/** The models that were candidates in the selected bucket. */
	selectionPool?: string[];
	/** Whether the active model fallback was used. */
	fallback?: boolean;
	/** Model that failed before this result was retried with a different model. */
	failedModel?: string;
	/** How many fallback attempts were made before this result (0 = first try). */
	retryCount?: number;
	/** Classified provider/SDK failure metadata. Model failover is permitted only
	 * when the class is transient and replaying the turn is side-effect-safe. */
	failureClass?: "transport" | "timeout" | "rate_limit" | "server_error" | "auth" | "abort" | "unknown";
	retryable?: boolean;
	replaySafety?: "safe" | "partial_output" | "tool_side_effect" | "terminal";
	retryAfterMs?: number;
	/** Diagnostic when a requested model could not be resolved and execution fell back. */
	modelResolutionDiagnostic?: string;
	/** Diagnostic when a nested subagent's requested bucket was not allowed and
	 *  was downgraded (or fell back to the active model) under the nested-bucket cap. */
	bucketDowngradeReason?: string;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;
