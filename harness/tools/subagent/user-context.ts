import type { ImageContent } from "@mariozechner/pi-ai";
import { ALLOWED_IMAGE_MIME_TYPES, decodedBase64ByteLength, MAX_IMAGE_INPUT_BYTES, MAX_AGGREGATE_IMAGE_INPUT_BYTES } from "../../model-providers/request-validation/image-constraints.js";
import type { ToolContext } from "./tool-context.js";
import { TRAVERSAL_POLICY_PROMPT } from "../execution-safety/traversal-policy.js";

export type UserContextMode = "latest" | "all";
export interface ParentUserContext {
	mode: UserContextMode;
	content?: string;
	images: ImageContent[];
}
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
): ParentUserContext | undefined {
	if (!mode) return undefined;
	if (!sessionManager) throw new Error("Parent user context unavailable: session manager is missing. Retry with an available parent session or omit userContext and include requirements in task.");

	let branch: SessionEntry[];
	try {
		branch = sessionManager.getBranch();
	} catch {
		throw new Error("Parent user context unavailable: active branch could not be read. Retry with an available parent session or omit userContext and include requirements in task.");
	}

	const questions = collectAskUserQuestions(branch);
	const latestUserIndex = findLatestUserMessageIndex(branch);
	if (mode === "latest" && latestUserIndex < 0) return undefined;
	const startIndex = mode === "latest" ? latestUserIndex : 0;
	const blocks: ContextBlock[] = [];
	const images: ImageContent[] = [];
	let aggregateBytes = 0;

	for (let index = startIndex; index < branch.length; index++) {
		const message = getMessage(branch[index]);
		if (!message) continue;

		if (message.role === "user") {
			const text = extractText(message.content, (record) => {
				const number = images.length + 1;
				const { data, mimeType } = record;
				if (typeof data !== "string" || !data || typeof mimeType !== "string" || !ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
					throw new Error(`Parent image ${number} has missing or invalid data/MIME type. Supply a valid image attachment or narrow userContext.`);
				}
				const bytes = decodedBase64ByteLength(data);
				if (bytes > MAX_IMAGE_INPUT_BYTES) throw new Error(`Parent image ${number} exceeds the shared 10 MiB image limit. Narrow the request.`);
				aggregateBytes += bytes;
				if (aggregateBytes > MAX_AGGREGATE_IMAGE_INPUT_BYTES) throw new Error("Parent images exceed the shared 20 MiB aggregate limit. Choose latest or narrow the request.");
				// Validate flat, unwrapped base64 without decoding or copying large buffers.
				const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
				const body = data.slice(0, data.length - padding);
				if (!body || /[^A-Za-z0-9+/]/.test(body) || body.length % 4 === 1 || (padding > 0 && (data.length % 4 !== 0 || padding !== (4 - body.length % 4) % 4))) {
					throw new Error(`Parent image ${number} has malformed base64 data. Supply a valid image attachment.`);
				}
				images.push({ type: "image", data, mimeType });
				return `[Parent image ${number}]`;
			});
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
	if (images.length > 0 && rendered.length > MAX_USER_CONTEXT_CHARS) {
		throw new Error("Image-bearing parent user context exceeds the text limit; choose latest or narrow the request to preserve text/image associations.");
	}
	return { mode, content: truncateMiddle(rendered, MAX_USER_CONTEXT_CHARS), images };
}

/** Build the sole user turn sent to the isolated child session.
 *
 * Every task prompt embeds the canonical traversal-safety policy paragraph
 * (harness/tools/execution-safety/traversal-policy.ts) so root agents and subagents receive the same
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

function extractText(content: unknown, imageMarker?: (image: Record<string, unknown>) => string): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const record = asRecord(part);
			if (record?.type === "text" && typeof record.text === "string") return record.text;
			if (record?.type === "image") return imageMarker?.(record) ?? "";
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
