import type { ToolContext } from "./tool-context.js";
import { TRAVERSAL_POLICY_PROMPT } from "../../../shared/traversal-policy.js";

export type UserContextMode = "latest" | "all";
export type ParentSessionManager = ToolContext["sessionManager"];
type SessionEntry = ReturnType<ParentSessionManager["getBranch"]>[number];

/** Keep optional parent context materially smaller than a copied transcript. */
export const MAX_USER_CONTEXT_CHARS = 12_000;

interface ContextBlock {
	kind: "prompt" | "clarification";
	text: string;
}

/**
 * Extract only user-role prompts and completed ask_user decisions from the
 * active parent branch. Assistant prose, reasoning, and unrelated tool output
 * are deliberately excluded.
 */
export function buildParentUserContext(
	mode: UserContextMode | undefined,
	sessionManager: ParentSessionManager | undefined,
): string | undefined {
	if (!mode || !sessionManager) return undefined;

	let branch: SessionEntry[];
	try {
		branch = sessionManager.getBranch();
	} catch {
		// Optional context must never make an otherwise-valid delegation fail.
		return undefined;
	}

	const questions = collectAskUserQuestions(branch);
	const latestUserIndex = findLatestUserMessageIndex(branch);
	if (mode === "latest" && latestUserIndex < 0) return undefined;
	const startIndex = mode === "latest" ? latestUserIndex : 0;
	const blocks: ContextBlock[] = [];

	for (let index = startIndex; index < branch.length; index++) {
		const message = getMessage(branch[index]);
		if (!message) continue;

		if (message.role === "user") {
			const text = extractText(message.content);
			if (text) blocks.push({ kind: "prompt", text });
			continue;
		}

		if (message.role !== "toolResult" || message.toolName !== "ask_user" || message.isError === true) {
			continue;
		}
		const details = asRecord(message.details);
		if (details?.cancelled === true || details?.source === "cancelled") continue;
		const answer = typeof details?.answer === "string"
			? details.answer.trim()
			: extractText(message.content);
		if (!answer) continue;
		const question = typeof message.toolCallId === "string"
			? questions.get(message.toolCallId)
			: undefined;
		blocks.push({
			kind: "clarification",
			text: `Question: ${question ?? "(question unavailable)"}\nAnswer: ${answer}`,
		});
	}

	if (blocks.length === 0) return undefined;
	const rendered = blocks.map((block) => (
		block.kind === "prompt"
			? `[User prompt]\n${block.text}`
			: `[Recorded clarification]\n${block.text}`
	)).join("\n\n");
	return truncateMiddle(rendered, MAX_USER_CONTEXT_CHARS);
}

/** Build the sole user turn sent to the isolated child session.
 *
 * Every task prompt embeds the canonical traversal-safety policy paragraph
 * (shared/traversal-policy.ts) so root agents and subagents receive the same
 * protected-directory policy without depending on agent memory or repo docs
 * (STABILITY-ARCHITECTURE-PLAN §7.7). */
export function formatSubagentPrompt(task: string, parentUserContext?: string): string {
	const taskPrompt = `${TRAVERSAL_POLICY_PROMPT}\n\nTask: ${task}`;
	if (!parentUserContext) return taskPrompt;
	return `${taskPrompt}\n\nParent user context is quoted below as supporting requirements. Later recorded clarifications override earlier prompts. Keep the delegated task as your scope; if it conflicts with this context, report the conflict instead of silently choosing one.\n\n<parent_user_context>\n${parentUserContext}\n</parent_user_context>`;
}

function collectAskUserQuestions(entries: SessionEntry[]): Map<string, string> {
	const questions = new Map<string, string>();
	for (const entry of entries) {
		const message = getMessage(entry);
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			const record = asRecord(part);
			if (record?.type !== "toolCall" || record.name !== "ask_user" || typeof record.id !== "string") {
				continue;
			}
			const args = asRecord(record.arguments);
			if (typeof args?.question === "string" && args.question.trim()) {
				questions.set(record.id, args.question.trim());
			}
		}
	}
	return questions;
}

function findLatestUserMessageIndex(entries: SessionEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		if (getMessage(entries[index])?.role === "user") return index;
	}
	return -1;
}

function getMessage(entry: SessionEntry): Record<string, unknown> | undefined {
	if (entry.type !== "message") return undefined;
	return asRecord(entry.message);
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const record = asRecord(part);
			if (record?.type === "text" && typeof record.text === "string") return record.text;
			if (record?.type === "image") return "[image attachment omitted]";
			return "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function truncateMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const marker = "\n\n[... parent user context truncated to stay lean ...]\n\n";
	const available = maxChars - marker.length;
	const head = Math.ceil(available / 2);
	const tail = Math.floor(available / 2);
	return text.slice(0, head) + marker + text.slice(text.length - tail);
}
