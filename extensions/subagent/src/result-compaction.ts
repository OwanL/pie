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
	return messages.map((message) => {
		const raw = message as Message & Record<string, unknown>;
		if (raw.role === "assistant" && Array.isArray(raw.content)) {
			return {
				...raw,
				content: raw.content.map((part) => terminalizeContentPart(part)),
			} as Message;
		}
		if (raw.role === "toolResult" && raw.toolName === "subagent") {
			return { ...raw, details: terminalizeDetails(raw.details) } as Message;
		}
		return message;
	});
}

function terminalizeContentPart(part: unknown): unknown {
	if (!part || typeof part !== "object" || Array.isArray(part)) return part;
	const record = part as Record<string, unknown>;
	if (record.type !== "toolCall" || record.name !== "subagent" || record.result === undefined) return part;
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
