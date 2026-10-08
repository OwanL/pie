import type { Api, AssistantMessage, Context, Model, ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import type { ToolModelExchangeEntry } from "../src/core/tool-model-exchange.ts";
import { createToolModelExchangeCapture } from "../src/core/tool-model-exchange-capture.ts";

const model = { api: "openai-completions", provider: "openai", id: "target" } as Model<Api>;
function assistant(ids: string[] = [], source = model): AssistantMessage {
	return {
		role: "assistant",
		api: source.api,
		provider: source.provider,
		model: source.id,
		content: ids.map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: id } })),
		stopReason: "toolUse",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
function context(ids: string[], source = model): Context {
	return {
		messages: [
			assistant(ids, source),
			...ids.map(
				(id): ToolResultMessage => ({
					role: "toolResult",
					toolCallId: id,
					toolName: "read",
					content: [{ type: "text", text: id }],
					isError: false,
					timestamp: 0,
				}),
			),
		],
	};
}
function manager() {
	const branch: SessionEntry[] = [];
	return {
		branch,
		getBranch: () => branch,
		appendCustomEntry(customType: string, data?: unknown) {
			const id = String(branch.length);
			branch.push({ type: "custom", id, parentId: null, timestamp: "", customType, data });
			return id;
		},
		data: () => branch.map((entry) => (entry as { data: ToolModelExchangeEntry }).data),
	};
}
function stream(message = assistant(["new"])) {
	let calls = 0;
	return {
		get calls() {
			return calls;
		},
		result: () => {
			calls++;
			return Promise.resolve(message);
		},
		async *[Symbol.asyncIterator]() {
			yield "event";
		},
	};
}
const payload = (id = "old", content: unknown = "result") => ({
	messages: [{ role: "tool", tool_call_id: id, content }],
});

describe("tool model exchange capture", () => {
	it("captures final hook replacement once, preserving stream identity, iteration, result identity and memoization", async () => {
		const store = manager();
		const capture = createToolModelExchangeCapture(store, model, context(["old"]));
		const output = { answer: ["modified"] };
		const replacement = payload("old", output);
		let hooks = 0;
		const hook = capture.wrapOnPayload(async () => {
			hooks++;
			return replacement;
		});
		expect(await hook(payload(), model)).toBe(replacement);
		output.answer[0] = "later mutation";
		const final = assistant(["new"]);
		const original = stream(final);
		const wrapped = capture.wrapStream(original);
		expect(wrapped).toBe(original);
		const events = [];
		for await (const event of wrapped) events.push(event);
		expect(events).toEqual(["event"]);
		const first = wrapped.result();
		expect(wrapped.result()).toBe(first);
		expect(await first).toBe(final);
		const toolCall = final.content[0];
		if (toolCall.type === "toolCall") toolCall.arguments.path = "execution rewrite";
		expect(original.calls).toBe(1);
		expect(hooks).toBe(1);
		expect(store.data()).toEqual([
			{ version: 1, toolCallId: "old", received: [{ answer: ["modified"] }] },
			{ version: 1, toolCallId: "new", produced: { name: "read", arguments: { path: "new" } } },
		]);
	});

	it("handles missing and undefined hooks without changing their return values; removal means unavailable", async () => {
		for (const hook of [undefined, () => undefined, () => ({ messages: [] })]) {
			const store = manager();
			const capture = createToolModelExchangeCapture(store, model, context(["old"]));
			const result = await capture.wrapOnPayload(hook)(payload(), model);
			await capture.wrapStream(stream(assistant())).result();
			expect(store.data().length).toBe(result === undefined ? 1 : 0);
		}
	});

	it("records independent calls and only their first successful consumption on the current branch", async () => {
		const store = manager();
		for (const content of ["first", "compacted"]) {
			const capture = createToolModelExchangeCapture(store, model, context(["a", "b"]));
			await capture.wrapOnPayload(undefined)(
				{ messages: [...payload("a", content).messages, ...payload("b", content).messages] },
				model,
			);
			await capture.wrapStream(stream(assistant())).result();
		}
		expect(store.data()).toEqual([
			{ version: 1, toolCallId: "a", received: ["first"] },
			{ version: 1, toolCallId: "b", received: ["first"] },
		]);
		store.branch.length = 0; // a different branch can consume independently
		const capture = createToolModelExchangeCapture(store, model, context(["a"]));
		await capture.wrapOnPayload(undefined)(payload("a", "branch"), model);
		await capture.wrapStream(stream(assistant())).result();
		expect(store.data()[0].received).toEqual(["branch"]);
	});

	it("snapshots in-place hook edits, discards earlier hook invocations, and omits uncloneable output", async () => {
		const store = manager();
		const capture = createToolModelExchangeCapture(store, model, context(["old"]));
		const body = payload("old", { text: "before" });
		await capture.wrapOnPayload((value) => {
			(value as typeof body).messages[0].content = { text: "after" };
		})(body, model);
		body.messages[0].content = { text: "later" };
		await capture.wrapStream(stream(assistant())).result();
		expect(store.data()[0].received).toEqual([{ text: "after" }]);
		for (const value of [() => "uncloneable", undefined]) {
			const separate = manager();
			const request = createToolModelExchangeCapture(separate, model, context(["old"]));
			const hook = request.wrapOnPayload(undefined);
			await hook(payload(), model);
			await hook(value === undefined ? { messages: [] } : payload("old", value), model);
			await request.wrapStream(stream(assistant())).result();
			expect(separate.data()).toEqual([]);
		}
	});

	it("allows first receipt for a new generated call reusing an ID", async () => {
		const store = manager();
		store.appendCustomEntry("pie.tool-model-exchange", {
			version: 1,
			toolCallId: "old",
			received: ["previous call"],
		});
		await createToolModelExchangeCapture(store, model, context([]))
			.wrapStream(stream(assistant(["old"])))
			.result();
		const capture = createToolModelExchangeCapture(store, model, context(["old"]));
		await capture.wrapOnPayload(undefined)(payload(), model);
		await capture.wrapStream(stream(assistant())).result();
		expect(store.data()[2].received).toEqual(["result"]);
	});

	it.each(["durable calls", "produced markers", "both"] as const)(
		"leaves a hook-retained old result unavailable when reuse is evidenced by %s",
		async (evidence) => {
			const store = manager();
			const produced = { version: 1, toolCallId: "old", produced: { name: "read", arguments: { path: "old" } } };
			for (let generation = 0; generation < 2; generation++) {
				if (evidence !== "produced markers") {
					store.branch.push({
						type: "message",
						id: `call-${generation}`,
						parentId: null,
						timestamp: "",
						message: assistant(["old"]),
					});
				}
				if (evidence !== "durable calls" || generation === 1)
					store.appendCustomEntry("pie.tool-model-exchange", produced);
				if (generation === 0)
					store.appendCustomEntry("pie.tool-model-exchange", {
						version: 1,
						toolCallId: "old",
						received: ["previous valid receipt"],
					});
			}
			const before = structuredClone(store.branch);
			// The context hook removed the newest result, leaving only the old one.
			const capture = createToolModelExchangeCapture(store, model, context(["old", "unique"]));
			await capture.wrapOnPayload(undefined)(
				{ messages: [...payload("old", "previous result").messages, ...payload("unique").messages] },
				model,
			);
			await capture.wrapStream(stream(assistant(["next"]))).result();
			expect(store.branch.slice(0, before.length)).toEqual(before);
			expect(store.branch.slice(before.length).map((entry) => entry.type === "custom" && entry.data)).toEqual([
				{ version: 1, toolCallId: "unique", received: ["result"] },
				{ version: 1, toolCallId: "next", produced: { name: "read", arguments: { path: "next" } } },
			]);
		},
	);

	it("snapshots durable ownership and consumption before provider hooks can mutate the branch", async () => {
		const store = manager();
		for (const id of ["old", "old"])
			store.branch.push({
				type: "message",
				id: String(store.branch.length),
				parentId: null,
				timestamp: "",
				message: assistant([id]),
			});
		store.appendCustomEntry("pie.tool-model-exchange", { version: 1, toolCallId: "unique", received: ["first"] });
		const capture = createToolModelExchangeCapture(store, model, context(["old", "unique"]));
		await capture.wrapOnPayload(() => {
			store.branch.length = 0;
		})({ messages: [...payload("old").messages, ...payload("unique").messages] }, model);
		await capture.wrapStream(stream(assistant())).result();
		expect(store.data()).toEqual([]);
	});

	it("does not claim receipt for errors, aborts or rejected streams, allowing a later successful request", async () => {
		const store = manager();
		for (const reason of ["error", "aborted", "stop"] as const) {
			const capture = createToolModelExchangeCapture(store, model, context(["old"]));
			await capture.wrapOnPayload(undefined)(payload(), model);
			const message = assistant();
			message.stopReason = reason;
			await capture.wrapStream(stream(message)).result();
			expect(store.data().length).toBe(reason === "stop" ? 1 : 0);
		}
		const capture = createToolModelExchangeCapture(manager(), model, context(["old"]));
		const error = new Error("failed");
		const wrapped = capture.wrapStream({ result: () => Promise.reject(error) });
		const first = wrapped.result();
		expect(wrapped.result()).toBe(first);
		await expect(first).rejects.toBe(error);
	});

	for (const api of [
		"anthropic-messages",
		"bedrock-converse-stream",
		"google-generative-ai",
		"google-vertex",
		"openai-completions",
		"openai-responses",
		"azure-openai-responses",
		"openai-codex-responses",
	] as const) {
		it(`maps ${api} wire IDs using cross-model serializer rules`, async () => {
			const target = { ...model, api };
			const source = { ...model, id: "other" };
			const original = api.includes("responses") || api === "openai-completions" ? "call+one|item" : "call+one";
			const wire = "call_one";
			const store = manager();
			const capture = createToolModelExchangeCapture(store, target, context([original], source));
			const body = api.includes("responses")
				? { input: [{ type: "function_call_output", call_id: wire, output: "result" }] }
				: api === "openai-completions"
					? payload(wire)
					: api.startsWith("google")
						? {
								contents: [
									{
										role: "user",
										parts: [{ functionResponse: { id: wire, response: { output: "result" } } }],
									},
								],
							}
						: api === "anthropic-messages"
							? {
									messages: [
										{
											role: "user",
											content: [{ type: "tool_result", tool_use_id: wire, content: "result" }],
										},
									],
								}
							: {
									messages: [
										{
											role: "user",
											content: [{ toolResult: { toolUseId: wire, content: [{ text: "result" }] } }],
										},
									],
								};
			await capture.wrapOnPayload(undefined)(body, target);
			await capture.wrapStream(stream(assistant())).result();
			expect(store.data()[0]?.toolCallId).toBe(original);
			expect(store.data()[0]?.received).toBeDefined();
		});
	}

	it("splits same-model Responses IDs but does not normalize other same-model IDs", async () => {
		const target = { ...model, api: "openai-responses" as const };
		const store = manager();
		const capture = createToolModelExchangeCapture(store, target, context(["call|item"], target));
		await capture.wrapOnPayload(undefined)(
			{ input: [{ type: "function_call_output", call_id: "call", output: "ok" }] },
			target,
		);
		await capture.wrapStream(stream(assistant())).result();
		expect(store.data()[0].toolCallId).toBe("call|item");
		const unchanged = createToolModelExchangeCapture(store, model, context(["unsafe+id"]));
		await unchanged.wrapOnPayload(undefined)(payload("unsafe_id"), model);
		await unchanged.wrapStream(stream(assistant())).result();
		expect(store.data()).toHaveLength(1);
	});

	it("leaves repeated context result IDs unavailable rather than merging old and new receipts", async () => {
		const store = manager();
		store.appendCustomEntry("pie.tool-model-exchange", {
			version: 1,
			toolCallId: "old",
			produced: { name: "read", arguments: {} },
		});
		const capture = createToolModelExchangeCapture(store, model, context(["old", "old", "unique"]));
		await capture.wrapOnPayload(undefined)(
			{
				messages: [
					...payload("old", "older").messages,
					...payload("old", "newer").messages,
					...payload("unique").messages,
				],
			},
			model,
		);
		await capture.wrapStream(stream(assistant())).result();
		expect(store.data()).toEqual([
			{ version: 1, toolCallId: "old", produced: { name: "read", arguments: {} } },
			{ version: 1, toolCallId: "unique", received: ["result"] },
		]);
	});

	for (const api of [
		"openai-completions",
		"mistral-conversations",
		"google-generative-ai",
		"google-vertex",
	] as const) {
		it(`does not claim complete ${api} receipt for detached images plus text`, async () => {
			const target = { ...model, api, input: ["text", "image"] } as Model<Api>;
			const input = context(["old", "text-only"], target);
			const result = input.messages[1] as ToolResultMessage;
			result.content.push({ type: "image", mimeType: "image/png", data: "aW1hZ2U=" });
			const image = { inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } };
			const body = api.startsWith("google")
				? {
						contents: [
							{
								role: "user",
								parts: ["old", "text-only"].map((id) => ({
									functionResponse: { id, response: { output: "text" } },
								})),
							},
							{ role: "user", parts: [image] },
						],
					}
				: {
						messages: [
							...["old", "text-only"].map((id) => ({
								role: "tool",
								tool_call_id: id,
								toolCallId: id,
								content: "text",
							})),
							{
								role: "user",
								content: [{ type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } }],
							},
						],
					};
			const store = manager();
			const capture = createToolModelExchangeCapture(store, target, input);
			await capture.wrapOnPayload(undefined)(body, target);
			await capture.wrapStream(stream(assistant())).result();
			expect(store.data()).toHaveLength(1);
			expect(store.data()[0].toolCallId).toBe("text-only");
		});
	}

	it("captures text when the target does not accept context images", async () => {
		const target = { ...model, input: ["text"] } as Model<Api>;
		const input = context(["old"], target);
		(input.messages[1] as ToolResultMessage).content.push({ type: "image", mimeType: "image/png", data: "aW1hZ2U=" });
		const store = manager();
		const capture = createToolModelExchangeCapture(store, target, input);
		await capture.wrapOnPayload(undefined)(payload(), target);
		await capture.wrapStream(stream(assistant())).result();
		expect(store.data()).toEqual([{ version: 1, toolCallId: "old", received: ["result"] }]);
	});

	for (const api of [
		"openai-responses",
		"azure-openai-responses",
		"openai-codex-responses",
		"anthropic-messages",
		"bedrock-converse-stream",
		"google-generative-ai",
		"google-vertex",
	] as const) {
		it(`captures attributable inline ${api} images plus text`, async () => {
			const target = { ...model, api, input: ["text", "image"] } as Model<Api>;
			const input = context(["old"], target);
			(input.messages[1] as ToolResultMessage).content.push({
				type: "image",
				mimeType: "image/png",
				data: "aW1hZ2U=",
			});
			const googleImage = { inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } };
			const content = api.includes("responses")
				? [
						{ type: "input_text", text: "text" },
						{ type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
					]
				: api === "anthropic-messages"
					? [
							{ type: "text", text: "text" },
							{ type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
						]
					: [{ text: "text" }, { image: { format: "png", source: { bytes: new Uint8Array([1, 2]) } } }];
			const expected = api.startsWith("google")
				? { response: { output: "text" }, parts: [googleImage] }
				: api.includes("responses")
					? content
					: { content };
			const body = api.startsWith("google")
				? { contents: [{ role: "user", parts: [{ functionResponse: { id: "old", ...(expected as object) } }] }] }
				: api.includes("responses")
					? { input: [{ type: "function_call_output", call_id: "old", output: content }] }
					: {
							messages: [
								{
									role: "user",
									content: [
										api === "anthropic-messages"
											? { type: "tool_result", tool_use_id: "old", content }
											: { toolResult: { toolUseId: "old", content } },
									],
								},
							],
						};
			const store = manager();
			const capture = createToolModelExchangeCapture(store, target, input);
			await capture.wrapOnPayload(undefined)(body, target);
			await capture.wrapStream(stream(assistant())).result();
			expect(store.data()).toEqual([{ version: 1, toolCallId: "old", received: [expected] }]);
		});
	}

	it("leaves ambiguous, unknown, ID-less and context-absent outputs unavailable", async () => {
		const target = { ...model, api: "anthropic-messages" as const };
		const store = manager();
		const capture = createToolModelExchangeCapture(store, target, context(["a+b", "a/b"], model));
		await capture.wrapOnPayload(undefined)(
			{ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "a_b", content: "collision" }] }] },
			target,
		);
		await capture.wrapStream(stream(assistant())).result();
		expect(store.data()).toEqual([]);
		const syntheticContext = context(["a+b"], model);
		syntheticContext.messages.unshift(assistant(["a/b"], model));
		const synthetic = createToolModelExchangeCapture(store, target, syntheticContext);
		await synthetic.wrapOnPayload(undefined)(
			{
				messages: [
					{ role: "user", content: [{ type: "tool_result", tool_use_id: "a_b", content: "synthetic collision" }] },
				],
			},
			target,
		);
		await synthetic.wrapStream(stream(assistant())).result();
		const google = { ...model, api: "google-generative-ai" as const };
		const idless = createToolModelExchangeCapture(store, google, context(["old"], google));
		await idless.wrapOnPayload(undefined)(
			{
				contents: [
					{ role: "user", parts: [{ functionResponse: { name: "read", response: { output: "ID-less" } } }] },
				],
			},
			google,
		);
		await idless.wrapStream(stream(assistant())).result();
		const unknown = createToolModelExchangeCapture(store, { ...model, api: "unknown" as Api }, context(["old"]));
		await unknown.wrapOnPayload(undefined)(payload(), model);
		await unknown.wrapStream(stream(assistant())).result();
		const absent = createToolModelExchangeCapture(store, model, context([]));
		await absent.wrapOnPayload(undefined)(payload("not-in-context"), model);
		await absent.wrapStream(stream(assistant())).result();
		expect(store.data()).toEqual([]);
	});
});
