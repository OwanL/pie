import type { Message } from "@mariozechner/pi-ai";
import type { SingleResult, SubagentDetails } from "../types.js";
import { getFinalOutput } from "../formatting.js";
import { isRuntimeTraceEnabled } from "./runtime-trace.js";

/**
 * Terminalize a child result without discarding transcript information.
 *
 * This function retains its historical name because it is part of the
 * subagent execution pipeline, but it no longer performs lossy compaction.
 * Parent-facing text is already a concise summary; `details.results` is the
 * durable UI record and must preserve the same reasoning, tool calls/results,
 * and recursively nested subagents that were visible while the child ran.
 */
export interface RecursiveProjectionCounters {
	childCount: number;
	messageCount: number;
	maxRecursiveDepth: number;
	/** Total elapsed time of the recursive projection traversal itself, in
	 * milliseconds, measured inside the existing terminal traversal. */
	durationMs: number;
}

const RECURSIVE_PROJECTION_COUNTERS = Symbol.for("pie.subagent-recursive-projection-counters.v1");
type MeasuredSingleResult = SingleResult & { [RECURSIVE_PROJECTION_COUNTERS]?: RecursiveProjectionCounters };

export function compactSingleResult(
	result: SingleResult,
	counters?: RecursiveProjectionCounters,
	recursiveDepth = 1,
): SingleResult {
	const activeCounters = counters ?? (isRuntimeTraceEnabled()
		? { childCount: 0, messageCount: 0, maxRecursiveDepth: 0, durationMs: 0 }
		: undefined);
	// Measure inside the existing traversal: each top-level call owns one
	// contiguous synchronous segment whose nested calls are contained in it, so
	// summing top-level segments equals the whole projection duration without
	// an extra pass and without double counting nested work.
	const segmentStartedAt = recursiveDepth === 1 ? performance.now() : undefined;
	const messages = Array.isArray(result.messages) ? result.messages : [];
	if (activeCounters) {
		activeCounters.childCount += 1;
		activeCounters.messageCount += messages.length;
		activeCounters.maxRecursiveDepth = Math.max(activeCounters.maxRecursiveDepth, recursiveDepth);
	}
	const compacted = {
		...result,
		messages: terminalizeNestedSubagents(messages, activeCounters, recursiveDepth),
		finalOutput: (result.finalOutput ?? (getFinalOutput(messages) || result.streamingText)) || undefined,
		transcriptCompacted: false,
		streamingText: undefined,
		streamingReasoning: undefined,
		streaming: false,
		runningTools: [],
		completedAt: result.completedAt ?? Date.now(),
	};
	if (activeCounters) {
		if (segmentStartedAt !== undefined) {
			activeCounters.durationMs += Math.max(0, performance.now() - segmentStartedAt);
		}
		// Enumerable symbols survive the provenance spread at the execute
		// boundary, while JSON serialization ignores symbol keys entirely.
		(compacted as MeasuredSingleResult)[RECURSIVE_PROJECTION_COUNTERS] = activeCounters;
	}
	return compacted;
}

function terminalizeNestedSubagents(
	messages: Message[],
	counters: RecursiveProjectionCounters | undefined,
	recursiveDepth: number,
): Message[] {
	const durableToolResultIds = collectDurableToolResultIds(messages);
	return messages.map((message) => {
		const raw = message as Message & Record<string, unknown>;
		if (raw.role === "assistant" && Array.isArray(raw.content)) {
			return {
				...raw,
				content: raw.content.map((part) => terminalizeContentPart(part, durableToolResultIds, counters, recursiveDepth)),
			} as Message;
		}
		if (raw.role === "toolResult" && raw.toolName === "subagent") {
			return { ...raw, details: terminalizeDetails(raw.details, counters, recursiveDepth) } as Message;
		}
		return message;
	});
}

/** Completed nested tools can appear twice in the SDK message snapshot: once
 * on the assistant tool-call part and again in the matching toolResult message.
 * The nested transcript renderer already treats toolResult as authoritative.
 * Keep that durable copy and omit only the redundant assistant mirror so each
 * recursively nested result is serialized once rather than doubling at every
 * delegation depth. Running tools without a durable result retain their inline
 * progress result. */
function collectDurableToolResultIds(messages: Message[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		const raw = message as Message & Record<string, unknown>;
		if (raw.role === "toolResult" && raw.toolCallId != null) {
			ids.add(String(raw.toolCallId));
			continue;
		}
		if (raw.role !== "user" || !Array.isArray(raw.content)) continue;
		for (const part of raw.content) {
			if (!part || typeof part !== "object" || Array.isArray(part)) continue;
			const record = part as unknown as Record<string, unknown>;
			if (record.type === "toolResult" && record.id != null) ids.add(String(record.id));
		}
	}
	return ids;
}

function terminalizeContentPart(
	part: unknown,
	durableToolResultIds: Set<string>,
	counters: RecursiveProjectionCounters | undefined,
	recursiveDepth: number,
): unknown {
	if (!part || typeof part !== "object" || Array.isArray(part)) return part;
	const record = part as Record<string, unknown>;
	if (record.type !== "toolCall" || record.result === undefined) return part;
	if (record.id != null && durableToolResultIds.has(String(record.id))) {
		const { result: _duplicateResult, ...deduplicated } = record;
		return deduplicated;
	}
	if (record.name !== "subagent") return part;
	return { ...record, result: terminalizeNestedResult(record.result, counters, recursiveDepth) };
}

function terminalizeNestedResult(
	value: unknown,
	counters: RecursiveProjectionCounters | undefined,
	recursiveDepth: number,
): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const result = value as Record<string, unknown>;
	return { ...result, details: terminalizeDetails(result.details, counters, recursiveDepth) };
}

function terminalizeDetails(
	value: unknown,
	counters: RecursiveProjectionCounters | undefined,
	recursiveDepth: number,
): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const details = value as Record<string, unknown>;
	if (!Array.isArray(details.results)) return value;
	return {
		...details,
		results: details.results.map((entry) => (
			entry && typeof entry === "object" && !Array.isArray(entry)
				? compactSingleResult(entry as SingleResult, counters, recursiveDepth + 1)
				: entry
		)),
	};
}

export function compactSubagentDetails(
	details: SubagentDetails,
	counters?: RecursiveProjectionCounters,
): SubagentDetails {
	const activeCounters = counters ?? (isRuntimeTraceEnabled()
		? { childCount: 0, messageCount: 0, maxRecursiveDepth: 0, durationMs: 0 }
		: undefined);
	return { ...details, results: details.results.map((result) => compactSingleResult(result, activeCounters, 1)) };
}

/** Read counters maintained by the terminal projection itself. No fallback
 * traversal is performed when a result did not pass through that projection. */
export function readRecursiveProjectionCounters(details: SubagentDetails | undefined): RecursiveProjectionCounters | undefined {
	if (!details) return undefined;
	for (const result of details.results) {
		const counters = (result as MeasuredSingleResult)[RECURSIVE_PROJECTION_COUNTERS];
		if (counters) return { ...counters };
	}
	return undefined;
}
