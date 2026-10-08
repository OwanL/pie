import type { Api, AssistantMessage, Context, Model, StreamOptions } from "@earendil-works/pi-ai/compat";
import type { SessionManager } from "./session-manager.ts";
import {
	extractToolModelInputs,
	TOOL_MODEL_EXCHANGE_CUSTOM_TYPE,
	type ToolModelExchangeEntry,
} from "./tool-model-exchange.ts";

type CaptureManager = Pick<SessionManager, "getBranch" | "appendCustomEntry">;

// Keep these rules aligned with ai/src/api's owning serializers. Normalization
// in transform-messages applies only to cross-model assistant calls; orphan
// results are not normalized. Never reverse a lossy ID or attribute by name.
function wireId(id: string, model: Model<Api>): string | undefined {
	switch (model.api) {
		case "anthropic-messages":
		case "bedrock-converse-stream":
		case "google-generative-ai":
		case "google-vertex":
			return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
		case "openai-completions":
			return id.includes("|")
				? id
						.split("|")[0]
						.replace(/[^a-zA-Z0-9_-]/g, "_")
						.slice(0, 40)
				: model.provider === "openai"
					? id.slice(0, 40)
					: id;
		case "openai-responses":
		case "azure-openai-responses":
		case "openai-codex-responses": {
			const allowed = ["openai", "openai-codex", "opencode"];
			if (model.api === "azure-openai-responses") allowed.push("azure-openai-responses");
			const part = allowed.includes(model.provider) ? id.split("|")[0] : id;
			return part
				.replace(/[^a-zA-Z0-9_-]/g, "_")
				.slice(0, 64)
				.replace(/_+$/, "");
		}
		// Mistral uses a stateful hash/collision allocator. Without running that
		// serializer, only unchanged same-model IDs can be attributed safely.
		default:
			return undefined;
	}
}

function snapshot<T>(value: T): T | undefined {
	try {
		return structuredClone(value);
	} catch {
		// Exotic hook output is unavailable, not a reason to change the request.
		return undefined;
	}
}

/** One capture per provider invocation; no request or mutable payload retained. */
export function createToolModelExchangeCapture(manager: CaptureManager, model: Model<Api>, context: Context) {
	// Snapshot only ownership metadata from the active durable branch before
	// invoking the provider. Context hooks may hide a generation or its result;
	// a single surviving same-ID result is not proof that it belongs to the latest.
	const callCounts = new Map<string, number>();
	const producedCounts = new Map<string, number>();
	const consumed = new Set<string>();
	for (const entry of manager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			for (const block of entry.message.content) {
				if (block.type === "toolCall") callCounts.set(block.id, (callCounts.get(block.id) ?? 0) + 1);
			}
		}
		if (entry.type !== "custom" || entry.customType !== TOOL_MODEL_EXCHANGE_CUSTOM_TYPE) continue;
		const data = entry.data as ToolModelExchangeEntry | undefined;
		if (data?.version !== 1 || typeof data.toolCallId !== "string") continue;
		if (data.produced) {
			producedCounts.set(data.toolCallId, (producedCounts.get(data.toolCallId) ?? 0) + 1);
			consumed.delete(data.toolCallId);
		}
		if (data.received) consumed.add(data.toolCallId);
	}
	const normalized = new Map<string, string>();
	const candidates = new Map<string, Set<string>>();
	const contextResultCounts = new Map<string, number>();
	const imageResultIds = new Set<string>();
	for (const message of context.messages) {
		if (message.role === "assistant") {
			const sameModel =
				message.api === model.api && message.provider === model.provider && message.model === model.id;
			for (const block of message.content) {
				if (block.type !== "toolCall" || sameModel) continue;
				const id = wireId(block.id, model);
				if (id !== undefined && id !== block.id) normalized.set(block.id, id);
			}
		}
		const originalIds =
			message.role === "toolResult"
				? [message.toolCallId]
				: message.role === "assistant"
					? message.content.filter((block) => block.type === "toolCall").map((block) => block.id)
					: [];
		if (message.role === "toolResult") {
			contextResultCounts.set(message.toolCallId, (contextResultCounts.get(message.toolCallId) ?? 0) + 1);
			if (message.content.some((block) => block.type === "image")) imageResultIds.add(message.toolCallId);
		}
		for (const originalId of originalIds) {
			let id = normalized.get(originalId) ?? originalId;
			if (["openai-responses", "azure-openai-responses", "openai-codex-responses"].includes(model.api)) {
				id = id.split("|")[0]; // function_call_output serialization always splits
			}
			const ids = candidates.get(id) ?? new Set<string>();
			ids.add(originalId);
			candidates.set(id, ids);
		}
	}
	let received = new Map<string, unknown[]>();

	return {
		wrapOnPayload(hook: StreamOptions["onPayload"]): NonNullable<StreamOptions["onPayload"]> {
			return async (payload, requestModel) => {
				const replacement = await hook?.(payload, requestModel);
				const finalPayload = replacement === undefined ? payload : replacement;
				received = new Map();
				for (const [id, values] of extractToolModelInputs(finalPayload, model.api)) {
					const ids = candidates.get(id);
					if (ids?.size !== 1) continue;
					const originalId = [...ids][0];
					// Reuse in either durable history or context makes receipt ownership ambiguous.
					if (
						contextResultCounts.get(originalId) !== 1 ||
						(callCounts.get(originalId) ?? 0) > 1 ||
						(producedCounts.get(originalId) ?? 0) > 1
					)
						continue;
					if (imageResultIds.has(originalId) && model.input?.includes("image")) {
						// These serializers detach images into untagged user messages.
						// Never guess their owner or claim the tagged text is the whole receipt.
						if (model.api === "openai-completions" || model.api === "mistral-conversations") continue;
						if (
							(model.api === "google-generative-ai" || model.api === "google-vertex") &&
							!values.every(
								(value) =>
									value !== null &&
									typeof value === "object" &&
									"parts" in value &&
									Array.isArray(value.parts) &&
									value.parts.length > 0,
							)
						)
							continue;
					}
					const copy = snapshot(values);
					if (copy !== undefined) received.set(originalId, copy);
				}
				return replacement;
			};
		},
		wrapStream<T extends { result(): Promise<AssistantMessage> }>(stream: T): T {
			const result = stream.result.bind(stream);
			let promise: Promise<AssistantMessage> | undefined;
			stream.result = () => {
				promise ??= result().then((message) => {
					// This continuation runs before agent-loop emits message_end and
					// extensions rewrite the assistant or execution arguments.
					if (message.stopReason !== "error" && message.stopReason !== "aborted") {
						for (const [toolCallId, values] of received) {
							if (!consumed.has(toolCallId))
								manager.appendCustomEntry(TOOL_MODEL_EXCHANGE_CUSTOM_TYPE, {
									version: 1,
									toolCallId,
									received: values,
								} satisfies ToolModelExchangeEntry);
						}
					}
					for (const block of message.content) {
						if (block.type !== "toolCall") continue;
						const produced = snapshot({ name: block.name, arguments: block.arguments });
						if (produced !== undefined)
							manager.appendCustomEntry(TOOL_MODEL_EXCHANGE_CUSTOM_TYPE, {
								version: 1,
								toolCallId: block.id,
								produced,
							} satisfies ToolModelExchangeEntry);
					}
					return message;
				});
				return promise;
			};
			return stream;
		},
	};
}
