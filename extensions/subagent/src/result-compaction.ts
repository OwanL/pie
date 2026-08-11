import type { Message } from "@mariozechner/pi-ai";
import type { SingleResult, SubagentDetails } from "../types.js";
import { getFinalOutput } from "../formatting.js";

/**
 * Terminalize a child result without discarding transcript information.
 *
 * This function retains its historical name because it is part of the
 * subagent execution pipeline, but it no longer performs lossy compaction.
 * Parent-facing text is already a concise summary; `details.results` is the
 * durable UI record and must preserve the same reasoning, tool calls/results,
 * and recursively nested subagents that were visible while the child ran.
 */
export function compactSingleResult(result: SingleResult): SingleResult {
	const messages = Array.isArray(result.messages) ? result.messages : [];
	return {
		...result,
		messages: terminalizeNestedSubagents(messages),
		finalOutput: (result.finalOutput ?? (getFinalOutput(messages) || result.streamingText)) || undefined,
		transcriptCompacted: false,
		streamingText: undefined,
		streamingReasoning: undefined,
		streaming: false,
		runningTools: [],
		completedAt: result.completedAt ?? Date.now(),
	};
}

function terminalizeNestedSubagents(messages: Message[]): Message[] {
	const durableToolResultIds = collectDurableToolResultIds(messages);
	return messages.map((message) => {
		const raw = message as Message & Record<string, unknown>;
		if (raw.role === "assistant" && Array.isArray(raw.content)) {
			return {
				...raw,
				content: raw.content.map((part) => terminalizeContentPart(part, durableToolResultIds)),
			} as Message;
		}
		if (raw.role === "toolResult" && raw.toolName === "subagent") {
			return { ...raw, details: terminalizeDetails(raw.details) } as Message;
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

function terminalizeContentPart(part: unknown, durableToolResultIds: Set<string>): unknown {
	if (!part || typeof part !== "object" || Array.isArray(part)) return part;
	const record = part as Record<string, unknown>;
	if (record.type !== "toolCall" || record.result === undefined) return part;
	if (record.id != null && durableToolResultIds.has(String(record.id))) {
		const { result: _duplicateResult, ...deduplicated } = record;
		return deduplicated;
	}
	if (record.name !== "subagent") return part;
	return { ...record, result: terminalizeNestedResult(record.result) };
}

function terminalizeNestedResult(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const result = value as Record<string, unknown>;
	return { ...result, details: terminalizeDetails(result.details) };
}

function terminalizeDetails(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const details = value as Record<string, unknown>;
	if (!Array.isArray(details.results)) return value;
	return {
		...details,
		results: details.results.map((entry) => (
			entry && typeof entry === "object" && !Array.isArray(entry)
				? compactSingleResult(entry as SingleResult)
				: entry
		)),
	};
}

export function compactSubagentDetails(details: SubagentDetails): SubagentDetails {
	return { ...details, results: details.results.map(compactSingleResult) };
}
