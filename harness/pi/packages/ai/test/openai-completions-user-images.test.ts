import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convertMessages } from "../src/api/openai-completions.ts";
import type { Model, OpenAICompletionsCompat, UserMessage } from "../src/types.ts";

const model: Model<"openai-completions"> = {
	id: "test-vision",
	name: "Test vision",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 512,
};
const compat: Required<OpenAICompletionsCompat> = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	cacheControlFormat: "anthropic",
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: true,
};
const image = { type: "image", data: "ZmFrZQ==", mimeType: "image/png" } as const;
const imagePart = { type: "image_url", image_url: { url: "data:image/png;base64,ZmFrZQ==" } };

function convert(content: UserMessage["content"]) {
	return convertMessages(model, { messages: [{ role: "user", content, timestamp: 1 }] }, compat);
}

// Selective port of upstream pi v0.87.1 user-content filtering; no TranscriptContext migration.
describe("OpenAI completions user image content", () => {
	it("preserves an image-only message without adding text", () => {
		assert.deepEqual(convert([image]), [{ role: "user", content: [imagePart] }]);
	});
	it("omits empty text parts before and after an image", () => {
		assert.deepEqual(convert([{ type: "text", text: "" }, image, { type: "text", text: "" }]), [
			{ role: "user", content: [imagePart] },
		]);
	});
	it("preserves ordinary mixed content and ordering", () => {
		const before = { type: "text", text: "Describe this" } as const;
		const after = { type: "text", text: " in detail." } as const;
		assert.deepEqual(convert([before, image, after]), [{ role: "user", content: [before, imagePart, after] }]);
	});
	it("preserves whitespace text accompanying an image", () => {
		const whitespace = { type: "text", text: " \n\t" } as const;
		assert.deepEqual(convert([whitespace, image]), [{ role: "user", content: [whitespace, imagePart] }]);
	});
	it("skips empty text-only arrays but preserves nonempty and whitespace parts", () => {
		assert.deepEqual(convert([{ type: "text", text: "" }]), []);
		assert.deepEqual(convert([]), []);
		const text = { type: "text", text: "hello" } as const;
		const whitespace = { type: "text", text: " " } as const;
		assert.deepEqual(convert([{ type: "text", text: "" }, text, whitespace]), [
			{ role: "user", content: [text, whitespace] },
		]);
	});
	it("does not filter string content, including empty strings", () => {
		for (const content of ["", " \n\t", "hello"]) {
			assert.deepEqual(convert(content), [{ role: "user", content }]);
		}
	});
});
