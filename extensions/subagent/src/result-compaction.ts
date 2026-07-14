import type { Message } from "@mariozechner/pi-ai";
import type { SingleResult, SubagentDetails } from "../types.js";
import { getFinalOutput } from "../formatting.js";

/** Parent-facing subagent output budget. The full child transcript is useful
 * while live, but terminal results are persisted in the parent session and
 * re-sent over the host/webview transport. Keep that durable shape bounded. */
export const MAX_SUBAGENT_OUTPUT_CHARS = 32_000;
const MAX_INTERMEDIATE_TEXT_CHARS = 500;
const MAX_TOOL_RESULT_TEXT_CHARS = 2_000;
const MAX_DETAILS_CHARS = 2_000;

function cap(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n… (+${text.length - maxChars} chars omitted)`;
}

function compactUnknownDetails(value: unknown): unknown {
	if (value === undefined) return undefined;
	try {
		const encoded = JSON.stringify(value);
		if (encoded.length <= MAX_DETAILS_CHARS) return value;
		return { truncated: true, originalChars: encoded.length };
	} catch {
		return { truncated: true, reason: "non-serializable details" };
	}
}

function compactNestedToolResult(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const result = value as Record<string, unknown>;
	const details = result.details;
	if (!details || typeof details !== "object" || Array.isArray(details)) {
		return { ...result, details: compactUnknownDetails(details) };
	}
	const detailRecord = details as Record<string, unknown>;
	if (!Array.isArray(detailRecord.results)) {
		return { ...result, details: compactUnknownDetails(details) };
	}
	return {
		...result,
		details: {
			...detailRecord,
			results: detailRecord.results.map((entry) => compactSingleResult(entry as SingleResult)),
		},
	};
}

type CompactFileChange = NonNullable<SingleResult["fileChanges"]>[number];

function countLines(text: string): number {
	if (!text) return 0;
	return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n").length;
}

function deriveCompactFileChanges(messages: Message[]): CompactFileChange[] | undefined {
	const changes: CompactFileChange[] = [];
	for (const message of messages) {
		const raw = message as Message & Record<string, unknown>;
		if (raw.role !== "assistant" || !Array.isArray(raw.content)) continue;
		for (const part of raw.content) {
			if (!part || typeof part !== "object" || Array.isArray(part)) continue;
			const call = part as Record<string, unknown>;
			if (call.type !== "toolCall" || typeof call.name !== "string") continue;
			const name = call.name.toLowerCase();
			// Shell mutation parsing is intentionally left to the shared host core;
			// retain the full transcript whenever a shell call is present.
			if (["bash", "shell", "execute_bash", "run_command", "execute_command"].includes(name)) return undefined;
			if (!/(edit|write|create|delete|remove|rename|move)/.test(name)) continue;
			const input = call.arguments;
			if (!input || typeof input !== "object" || Array.isArray(input)) continue;
			const args = input as Record<string, unknown>;
			const path = ["path", "filePath", "file", "filepath", "target", "targetPath"]
				.map((key) => args[key])
				.find((value): value is string => typeof value === "string" && value.trim() !== "");
			if (!path) continue;
			const isWrite = /(write|create)/.test(name);
			const isDelete = /(delete|remove)/.test(name);
			let additions = 0;
			let deletions = 0;
			if (isWrite) {
				const content = args.content ?? args.text ?? args.data;
				if (typeof content === "string") additions = countLines(content);
			} else if (typeof args.oldText === "string" && typeof args.newText === "string") {
				deletions = countLines(args.oldText);
				additions = countLines(args.newText);
			} else if (Array.isArray(args.edits)) {
				for (const edit of args.edits) {
					if (!edit || typeof edit !== "object" || Array.isArray(edit)) continue;
					const entry = edit as Record<string, unknown>;
					if (typeof entry.oldText === "string") deletions += countLines(entry.oldText);
					if (typeof entry.newText === "string") additions += countLines(entry.newText);
				}
			}
			changes.push({
				path: path.trim(),
				kind: isWrite ? "created" : isDelete ? "deleted" : "modified",
				description: isWrite ? "created" : isDelete ? "deleted" : Array.isArray(args.edits) ? `${args.edits.length} edits` : "edited",
				...(additions > 0 ? { additions } : {}),
				...(deletions > 0 ? { deletions } : {}),
			});
		}
	}
	return changes;
}

function compactToolArguments(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const args = value as Record<string, unknown>;
	const compact: Record<string, unknown> = {};
	for (const key of ["path", "filePath", "file", "filepath", "target", "targetPath"]) {
		if (typeof args[key] === "string") compact[key] = args[key];
	}
	if (Array.isArray(args.edits)) compact.editCount = args.edits.length;
	return compact;
}

function compactContentPart(
	part: unknown,
	keepText: boolean,
	redactModifyingArguments: boolean,
	pairedToolResultIds: ReadonlySet<string>,
): unknown | undefined {
	if (!part || typeof part !== "object" || Array.isArray(part)) return part;
	const record = part as Record<string, unknown>;
	if (record.type === "thinking") return undefined;
	if (record.type === "text" && typeof record.text === "string") {
		if (!keepText) return undefined;
		return { ...record, text: cap(record.text, MAX_INTERMEDIATE_TEXT_CHARS) };
	}
	if (record.type === "toolCall") {
		const name = typeof record.name === "string" ? record.name.toLowerCase() : "";
		const modifying = /(edit|write|create|delete|remove|rename|move)/.test(name);
		const compacted = { ...record };
		if (typeof record.id === "string" && pairedToolResultIds.has(record.id)) {
			delete compacted.result;
		} else if (record.name === "subagent" && record.result !== undefined) {
			compacted.result = compactNestedToolResult(record.result);
		}
		if (redactModifyingArguments && modifying) compacted.arguments = compactToolArguments(record.arguments);
		return compacted;
	}
	return record;
}

function compactMessage(
	message: Message,
	keepAssistantText: boolean,
	redactModifyingArguments: boolean,
	pairedToolResultIds: ReadonlySet<string>,
): Message {
	const raw = message as Message & Record<string, unknown>;
	if (raw.role === "assistant") {
		const content = Array.isArray(raw.content)
			? raw.content
				.map((part) => compactContentPart(part, keepAssistantText, redactModifyingArguments, pairedToolResultIds))
				.filter((part) => part !== undefined)
			: raw.content;
		return { ...raw, content } as Message;
	}
	if (raw.role === "toolResult") {
		const content = Array.isArray(raw.content)
			? raw.content.map((part) => {
				if (!part || typeof part !== "object" || Array.isArray(part)) return part;
				const record = part as Record<string, unknown>;
				return typeof record.text === "string"
					? { ...record, text: cap(record.text, MAX_TOOL_RESULT_TEXT_CHARS) }
					: record;
			})
			: raw.content;
		let compactedDetails: unknown;
		if (raw.toolName === "subagent") {
			const nested = compactNestedToolResult({ details: raw.details }) as Record<string, unknown>;
			compactedDetails = nested.details;
		} else {
			compactedDetails = compactUnknownDetails(raw.details);
		}
		return { ...raw, content, details: compactedDetails } as Message;
	}
	return raw;
}

function nestedFileChanges(messages: Message[]): CompactFileChange[] | undefined {
	const changes: CompactFileChange[] = [];
	for (const message of messages) {
		const raw = message as Message & Record<string, unknown>;
		if (raw.role !== "toolResult" || raw.toolName !== "subagent") continue;
		const details = raw.details;
		if (!details || typeof details !== "object" || Array.isArray(details)) continue;
		const results = (details as Record<string, unknown>).results;
		if (!Array.isArray(results)) continue;
		for (const result of results) {
			if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
			const nested = (result as Record<string, unknown>).fileChanges;
			if (!Array.isArray(nested)) return undefined;
			changes.push(...nested as CompactFileChange[]);
		}
	}
	return changes;
}

/** Compact a completed child result without mutating the live result object.
 * Tool-call identity/path metadata and explicit file-change summaries survive;
 * verbose reasoning, write/edit payloads, repeated prose, and oversized tool
 * output do not. */
export function compactSingleResult(result: SingleResult): SingleResult {
	const messages = Array.isArray(result.messages) ? result.messages : [];
	const finalOutput = cap(result.finalOutput ?? (getFinalOutput(messages) || result.streamingText || ""), MAX_SUBAGENT_OUTPUT_CHARS);
	const fileChanges = result.fileChanges ?? deriveCompactFileChanges(messages);
	let finalAssistantIndex = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "assistant") {
			finalAssistantIndex = index;
			break;
		}
	}

	const pairedToolResultIds = new Set(messages.flatMap((message) => {
		const raw = message as Message & Record<string, unknown>;
		return raw.role === "toolResult" && typeof raw.toolCallId === "string" ? [raw.toolCallId] : [];
	}));
	let compactedMessages = messages.map((message, index) => compactMessage(
		message,
		index !== finalAssistantIndex,
		fileChanges !== undefined,
		pairedToolResultIds,
	));
	const nestedChanges = nestedFileChanges(compactedMessages);
	if (fileChanges !== undefined && nestedChanges === undefined) {
		// A nested shell transcript still needs legacy host-side derivation. Keep
		// this level's modifying arguments too so the fallback remains complete.
		compactedMessages = messages.map((message, index) => compactMessage(
			message,
			index !== finalAssistantIndex,
			false,
			pairedToolResultIds,
		));
	}
	const persistedFileChanges = fileChanges === undefined || nestedChanges === undefined
		? undefined
		: [...fileChanges, ...nestedChanges];
	return {
		...result,
		messages: compactedMessages,
		finalOutput: finalOutput || undefined,
		fileChanges: persistedFileChanges,
		transcriptCompacted: true,
		streamingText: undefined,
		streamingReasoning: undefined,
		streaming: false,
		runningTools: [],
	};
}

export function compactSubagentDetails(details: SubagentDetails): SubagentDetails {
	return { ...details, results: details.results.map(compactSingleResult) };
}
