import { describe, expect, it } from "vitest";
import {
	extractToolModelInputs,
	TOOL_MODEL_EXCHANGE_CUSTOM_TYPE,
	type ToolModelExchangeEntry,
} from "../src/core/tool-model-exchange.ts";

describe("tool model exchange extraction", () => {
	it("exports the versioned custom-entry contract", () => {
		const entry: ToolModelExchangeEntry = {
			version: 1,
			toolCallId: "call",
			produced: { name: "read", arguments: { path: "file" } },
			received: ["result"],
		};
		expect(TOOL_MODEL_EXCHANGE_CUSTOM_TYPE).toBe("pie.tool-model-exchange");
		expect(entry.version).toBe(1);
	});

	for (const api of ["openai-completions", "mistral-conversations"]) {
		it(`extracts only tool messages for ${api}`, () => {
			const content = [
				{ type: "text", text: "exact\nvalue" },
				{ type: "image_url", imageUrl: "data:image/png;base64,x" },
			];
			const id = api === "mistral-conversations" ? "toolCallId" : "tool_call_id";
			const payload = {
				messages: [
					{ role: "tool", [id]: "call", content, details: { secret: true }, name: "read" },
					{ role: "tool", [id]: "call", content: "" },
					{ role: "user", [id]: "user", content: "not a tool" },
					{ role: "assistant", [id]: "assistant", content: "not a result" },
				],
			};
			const extracted = extractToolModelInputs(payload, api);
			expect([...extracted]).toEqual([["call", [content, ""]]]);
			expect(extracted.get("call")?.[0]).toBe(content);
		});
	}

	for (const api of ["openai-responses", "azure-openai-responses", "openai-codex-responses"]) {
		it(`preserves serialized outputs for ${api}`, () => {
			const output = [
				{ type: "input_text", text: "first" },
				{ type: "input_image", image_url: "data:image/png;base64,x" },
			];
			const payload = {
				input: [
					{ type: "function_call_output", call_id: "call|normalized", output, details: "private" },
					{ type: "function_call_output", call_id: "call|normalized", output: "second" },
					{ type: "function_call", call_id: "ignore", output: "not a response" },
					{ role: "user", content: [{ type: "function_call_output", call_id: "nested", output: "ignore" }] },
				],
			};
			expect([...extractToolModelInputs(payload, api)]).toEqual([["call|normalized", [output, "second"]]]);
		});
	}

	it("preserves Anthropic content and explicit error flags, not cache metadata or details", () => {
		const content = [
			{ type: "text", text: "failed" },
			{ type: "image", source: { type: "base64", data: "x" } },
		];
		const blocks = [
			{
				type: "tool_result",
				tool_use_id: "call",
				content,
				is_error: true,
				cache_control: { type: "ephemeral" },
				details: "private",
			},
			{ type: "tool_result", tool_use_id: "call", content: "ok", is_error: false },
			{ type: "tool_result", tool_use_id: "call", content: [] },
			{ type: "text", tool_use_id: "ignore", content: "ignore" },
		];
		const extracted = extractToolModelInputs(
			{
				messages: [
					{ role: "user", content: blocks },
					{ role: "assistant", content: blocks },
				],
			},
			"anthropic-messages",
		);
		expect([...extracted]).toEqual([
			["call", [{ content, is_error: true }, { content: "ok", is_error: false }, { content: [] }]],
		]);
	});

	for (const api of ["google-generative-ai", "google-vertex"]) {
		it(`preserves Google response values and multimodal parts for ${api}, without guessing IDs`, () => {
			const response = { error: "serialized failure", nested: { value: null } };
			const parts = [{ inlineData: { mimeType: "image/png", data: "x" } }];
			const blocks = [
				{ functionResponse: { id: "call", name: "read", response, details: "private" } },
				{ functionResponse: { id: "call", name: "read", response: { output: "image" }, parts } },
				{ functionResponse: { name: "read", response: { output: "no id" } } },
				{ functionCall: { id: "ignore", name: "read", args: {} } },
			];
			const extracted = extractToolModelInputs(
				{
					contents: [
						{ role: "user", parts: blocks },
						{ role: "model", parts: blocks },
						{ role: "user", parts },
					],
				},
				api,
			);
			expect([...extracted]).toEqual([["call", [response, { response: { output: "image" }, parts }]]]);
			expect(extracted.get("call")?.[0]).toBe(response);
		});
	}

	it("preserves Bedrock tool content and status without surrounding message content", () => {
		const content = [{ text: "exact" }, { json: { result: [1, false, null] } }];
		const blocks = [
			{ toolResult: { toolUseId: "call", content, status: "error", details: "private" } },
			{ toolResult: { toolUseId: "call", content: [], status: "success" } },
			{ text: "unrelated user text" },
		];
		expect([
			...extractToolModelInputs(
				{
					messages: [
						{ role: "user", content: blocks },
						{ role: "assistant", content: blocks },
					],
				},
				"bedrock-converse-stream",
			),
		]).toEqual([
			[
				"call",
				[
					{ content, status: "error" },
					{ content: [], status: "success" },
				],
			],
		]);
	});

	it("rejects unknown adapters and does not recursively inspect envelopes or context", () => {
		const payload = { messages: [{ role: "tool", tool_call_id: "call", content: "result" }] };
		for (const api of ["custom-api", "google-gemini-cli", "openrouter-images", ""]) {
			expect(extractToolModelInputs(payload, api).size).toBe(0);
		}
		expect(extractToolModelInputs({ request: payload, context: payload }, "openai-completions").size).toBe(0);
	});

	it("ignores malformed structure, missing content and invalid IDs, preserving explicit null", () => {
		for (const payload of [null, undefined, false, "text", [], { messages: {} }]) {
			expect(extractToolModelInputs(payload, "openai-completions").size).toBe(0);
		}
		const messages = [
			null,
			[],
			"text",
			{ role: "tool", tool_call_id: "missing" },
			{ role: "tool", tool_call_id: 1, content: "bad" },
			{ role: "tool", tool_call_id: "", content: "bad" },
			{ role: "tool", content: "bad" },
			{ role: "tool", tool_call_id: "call", content: null },
		];
		expect([...extractToolModelInputs({ messages }, "openai-completions")]).toEqual([["call", [null]]]);
	});

	it("does not mutate even frozen payloads and does not traverse cyclic content", () => {
		const content: Record<string, unknown> = { details: "part of actual content, retained" };
		content.self = content;
		Object.freeze(content);
		const payload = Object.freeze({
			messages: Object.freeze([Object.freeze({ role: "tool", tool_call_id: "call", content })]),
		});
		const extracted = extractToolModelInputs(payload, "openai-completions");
		expect(extracted.get("call")?.[0]).toBe(content);
		expect(extractToolModelInputs(payload, "openai-completions")).not.toBe(extracted);
	});
});
