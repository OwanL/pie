export const TOOL_MODEL_EXCHANGE_CUSTOM_TYPE = "pie.tool-model-exchange";

export type ToolModelExchangeEntry = {
	version: 1;
	toolCallId: string;
	produced?: { name: string; arguments: unknown };
	received?: unknown[];
};

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function items(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/**
 * Extract only ID-bearing tool responses from known final request shapes.
 * Each response contributes one value (content arrays are not flattened).
 * Anthropic content is wrapped with its optional is_error; Bedrock content
 * with its optional status. Google response objects are kept as serialized,
 * wrapped with parts only for multimodal function responses.
 *
 * Traversal is limited to the owning serializer's message/block levels: no
 * recursive search, context reconstruction, ID normalization, or name-based
 * attribution. Detached user images and ID-less Google responses are omitted.
 * Content values are retained by reference; this function never mutates them.
 */
export function extractToolModelInputs(payload: unknown, api: string): Map<string, unknown[]> {
	const result = new Map<string, unknown[]>();
	const body = record(payload);
	if (!body) return result;

	const append = (id: unknown, value: unknown) => {
		if (typeof id !== "string" || id.length === 0) return;
		const values = result.get(id);
		if (values) values.push(value);
		else result.set(id, [value]);
	};

	switch (api) {
		case "openai-completions":
		case "mistral-conversations":
			for (const item of items(body.messages)) {
				const message = record(item);
				if (message?.role === "tool" && Object.hasOwn(message, "content")) {
					append(api === "mistral-conversations" ? message.toolCallId : message.tool_call_id, message.content);
				}
			}
			break;
		case "openai-responses":
		case "azure-openai-responses":
		case "openai-codex-responses":
			for (const item of items(body.input)) {
				const output = record(item);
				if (output?.type === "function_call_output" && Object.hasOwn(output, "output")) {
					append(output.call_id, output.output);
				}
			}
			break;
		case "anthropic-messages":
		case "bedrock-converse-stream":
			for (const item of items(body.messages)) {
				const message = record(item);
				if (message?.role !== "user") continue;
				for (const item of items(message.content)) {
					const block = record(item);
					if (api === "anthropic-messages") {
						if (block?.type !== "tool_result" || !Object.hasOwn(block, "content")) continue;
						append(block.tool_use_id, {
							content: block.content,
							...(Object.hasOwn(block, "is_error") ? { is_error: block.is_error } : {}),
						});
					} else {
						const output = record(block?.toolResult);
						if (!output || !Object.hasOwn(output, "content")) continue;
						append(output.toolUseId, {
							content: output.content,
							...(Object.hasOwn(output, "status") ? { status: output.status } : {}),
						});
					}
				}
			}
			break;
		case "google-generative-ai":
		case "google-vertex":
			for (const item of items(body.contents)) {
				const message = record(item);
				if (message?.role !== "user") continue;
				for (const item of items(message.parts)) {
					const output = record(record(item)?.functionResponse);
					if (!output || !Object.hasOwn(output, "response")) continue;
					append(
						output.id,
						Object.hasOwn(output, "parts") ? { response: output.response, parts: output.parts } : output.response,
					);
				}
			}
			break;
	}
	return result;
}
