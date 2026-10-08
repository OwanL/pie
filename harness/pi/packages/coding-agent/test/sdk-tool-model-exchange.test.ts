import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { TOOL_MODEL_EXCHANGE_CUSTOM_TYPE, type ToolModelExchangeEntry } from "../src/core/tool-model-exchange.ts";

type RequestMessage = {
	role: string;
	content: unknown;
	tool_call_id?: string;
	tool_calls?: unknown[];
};
type Request = { model: string; messages: RequestMessage[] };

// Serialize the context actually passed to the provider, not session history.
// This deliberately small OpenAI-shaped serializer needs no network client.
function requestFromContext(model: Model<Api>, context: Context): Request {
	return {
		model: model.id,
		messages: context.messages.map((message): RequestMessage => {
			if (message.role === "toolResult") {
				return {
					role: "tool",
					tool_call_id: message.toolCallId,
					content: message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n"),
				};
			}
			if (message.role === "assistant") {
				return {
					role: "assistant",
					content: message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n"),
					tool_calls: message.content
						.filter((part) => part.type === "toolCall")
						.map((part) => ({
							id: part.id,
							type: "function",
							function: { name: part.name, arguments: JSON.stringify(part.arguments) },
						})),
				};
			}
			return { role: "user", content: message.content };
		}),
	};
}

function captures(manager: SessionManager): ToolModelExchangeEntry[] {
	return manager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === TOOL_MODEL_EXCHANGE_CUSTOM_TYPE
				? [entry.data as ToolModelExchangeEntry]
				: [],
		);
}

describe("createAgentSession tool model exchange", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-tool-model-exchange-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	it("does not attribute an old hook-retained result to a reused durable call ID", async () => {
		const model: Model<Api> = {
			id: "reuse-model",
			name: "Reuse Model",
			api: "openai-completions",
			provider: "reuse-provider",
			baseUrl: "https://capture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const sessionManager = SessionManager.inMemory(cwd);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "test-api-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const sentRequests: Request[] = [];
		let invocation = 0;
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: (requestModel, context, options) => {
				const generation = invocation++;
				const message: AssistantMessage = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content:
						generation < 2
							? [
									{
										type: "toolCall",
										id: "reused",
										name: "echo",
										arguments: { text: `generation-${generation}` },
									},
								]
							: [{ type: "text", text: "done" }],
					stopReason: generation < 2 ? "toolUse" : "stop",
					timestamp: Date.now(),
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
				const stream = createAssistantMessageEventStream();
				void (async () => {
					const payload = requestFromContext(requestModel, context);
					const replacement = await options?.onPayload?.(payload, requestModel);
					sentRequests.push(structuredClone((replacement === undefined ? payload : replacement) as Request));
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
					stream.end();
				})().catch((error) => {
					stream.push({
						type: "error",
						reason: "error",
						error: { ...message, stopReason: "error", errorMessage: String(error) },
					});
					stream.end();
				});
				return stream;
			},
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				(pi) => {
					pi.on("context", (event) => {
						let retained = false;
						return {
							messages: event.messages.filter((message) => {
								if (message.role !== "toolResult" || message.toolCallId !== "reused") return true;
								if (retained) return false;
								retained = true;
								return true;
							}),
						};
					});
				},
			],
		});
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			await resourceLoader.reload();
			({ session } = await createAgentSession({
				cwd,
				agentDir,
				model,
				authStorage,
				modelRegistry,
				settingsManager,
				sessionManager,
				resourceLoader,
				tools: ["echo"],
				customTools: [
					{
						name: "echo",
						label: "Echo",
						description: "Echo generation",
						parameters: Type.Object({ text: Type.String() }),
						execute: async (_id, params) => ({
							content: [{ type: "text", text: (params as { text: string }).text }],
							details: {},
						}),
					},
				],
			}));
			await session.bindExtensions({});
			await session.prompt("run echo twice");
			expect(invocation).toBe(3);
			expect(sentRequests[2].messages.filter((message) => message.role === "tool")).toEqual([
				{ role: "tool", tool_call_id: "reused", content: "generation-0" },
			]);
			expect(
				sessionManager
					.getBranch()
					.filter(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "assistant" &&
							entry.message.content.some((part) => part.type === "toolCall" && part.id === "reused"),
					),
			).toHaveLength(2);
			expect(captures(sessionManager)).toEqual([
				{ version: 1, toolCallId: "reused", produced: { name: "echo", arguments: { text: "generation-0" } } },
				{ version: 1, toolCallId: "reused", received: ["generation-0"] },
				{ version: 1, toolCallId: "reused", produced: { name: "echo", arguments: { text: "generation-1" } } },
			]);
		} finally {
			session?.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});

	it.each(["replace", "remove"] as const)(
		"captures generated arguments and the final %s payload without replay duplication",
		async (mode) => {
			const model: Model<Api> = {
				id: "capture-model",
				name: "Capture Model",
				api: "openai-completions",
				provider: "capture-provider",
				baseUrl: "https://capture.invalid/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			};
			const settingsManager = SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: false },
			});
			const sessionManager = SessionManager.inMemory(cwd);
			const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
			authStorage.setRuntimeApiKey(model.provider, "test-api-key");
			const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
			const providerContexts: Context[] = [];
			const sentRequests: Request[] = [];
			const prePayloadRequests: Request[] = [];
			const lastHookInputs: Request[] = [];
			const capturesAtMessageEnd: ToolModelExchangeEntry[][] = [];
			const executionInputs: unknown[] = [];
			const toolCallInputs: unknown[] = [];
			const toolResultInputs: unknown[] = [];
			let invocation = 0;

			function response(toolCall: boolean): AssistantMessage {
				return {
					role: "assistant",
					content: toolCall
						? [{ type: "toolCall", id: "call-1", name: "echo", arguments: { text: "model-generated" } }]
						: [{ type: "text", text: "done" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: toolCall ? "toolUse" : "stop",
					timestamp: Date.now(),
				};
			}

			modelRegistry.registerProvider(model.provider, {
				api: model.api,
				streamSimple: (requestModel, context, options) => {
					const stream = createAssistantMessageEventStream();
					const message = response(invocation++ === 0);
					void (async () => {
						providerContexts.push({ messages: structuredClone(context.messages) });
						const payload = requestFromContext(requestModel, context);
						prePayloadRequests.push(structuredClone(payload));
						const replacement = await options?.onPayload?.(payload, requestModel);
						sentRequests.push(structuredClone((replacement === undefined ? payload : replacement) as Request));
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
						stream.end();
					})().catch((error) => {
						stream.push({
							type: "error",
							reason: "error",
							error: { ...message, stopReason: "error", errorMessage: String(error) },
						});
						stream.end();
					});
					return stream;
				},
			});

			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [
					(pi) => {
						pi.on("message_end", (event) => {
							if (event.message.role !== "assistant") return;
							capturesAtMessageEnd.push(structuredClone(captures(sessionManager)));
							return {
								message: {
									...event.message,
									content: event.message.content.map((part) =>
										part.type === "toolCall"
											? { ...part, arguments: { text: "message-end-rewritten" } }
											: part,
									),
								},
							};
						});
						pi.on("tool_call", (event) => {
							toolCallInputs.push(structuredClone(event.input));
							(event.input as { text: string }).text = "execution-rewritten";
						});
						// Stand in for deterministic tool-result pruning before subsequent hooks.
						pi.on("tool_result", () => ({ content: [{ type: "text", text: "pruned-result" }] }));
						pi.on("before_provider_request", (event) => {
							const payload = event.payload as Request;
							for (const message of payload.messages) {
								if (message.role === "tool") message.content = "first-payload-hook";
							}
						});
					},
					(pi) => {
						pi.on("tool_result", (event) => {
							toolResultInputs.push(structuredClone(event.content));
							return {
								content: [{ type: "text", text: "tool-result-rewritten" }],
								details: { hidden: "rewritten-details" },
							};
						});
						pi.on("context", (event) => ({
							messages: event.messages.map((message) =>
								message.role === "toolResult"
									? { ...message, content: [{ type: "text" as const, text: "context-rewritten" }] }
									: message,
							),
						}));
						pi.on("before_provider_request", (event) => {
							const payload = event.payload as Request;
							lastHookInputs.push(structuredClone(payload));
							return {
								...payload,
								messages:
									mode === "remove"
										? payload.messages.filter((message) => message.role !== "tool")
										: payload.messages.map((message) =>
												message.role === "tool" ? { ...message, content: "last-payload-hook" } : message,
											),
							};
						});
					},
				],
			});
			let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
			try {
				await resourceLoader.reload();
				({ session } = await createAgentSession({
					cwd,
					agentDir,
					model,
					authStorage,
					modelRegistry,
					settingsManager,
					sessionManager,
					resourceLoader,
					tools: ["echo"],
					customTools: [
						{
							name: "echo",
							label: "Echo",
							description: "Return a distinguishable raw result",
							parameters: Type.Object({ text: Type.String() }),
							execute: async (_id, params) => {
								executionInputs.push(structuredClone(params));
								return {
									content: [{ type: "text", text: "raw-tool-result" }],
									details: { hidden: "raw-details" },
								};
							},
						},
					],
				}));
				await session.bindExtensions({});
				await session.prompt("run echo");

				const produced: ToolModelExchangeEntry = {
					version: 1,
					toolCallId: "call-1",
					produced: { name: "echo", arguments: { text: "model-generated" } },
				};
				const expected =
					mode === "replace"
						? [produced, { version: 1, toolCallId: "call-1", received: ["last-payload-hook"] }]
						: [produced];
				expect(
					session.messages.filter((message) => message.role === "assistant" && message.stopReason === "error"),
				).toEqual([]);
				expect(invocation).toBe(2);
				expect(toolCallInputs).toEqual([{ text: "message-end-rewritten" }]);
				expect(executionInputs).toEqual([{ text: "execution-rewritten" }]);
				expect(toolResultInputs).toEqual([[{ type: "text", text: "pruned-result" }]]);
				expect(capturesAtMessageEnd).toEqual([[produced], expected]);
				expect(captures(sessionManager)).toEqual(expected);
				expect(prePayloadRequests[1].messages.filter((message) => message.role === "tool")).toEqual([
					{ role: "tool", tool_call_id: "call-1", content: "context-rewritten" },
				]);
				expect(lastHookInputs[1].messages.find((message) => message.role === "tool")?.content).toBe(
					"first-payload-hook",
				);
				expect(sentRequests[1].messages.filter((message) => message.role === "tool")).toEqual(
					mode === "replace" ? [{ role: "tool", tool_call_id: "call-1", content: "last-payload-hook" }] : [],
				);
				const rebuilt = sessionManager.buildSessionContext().messages;
				expect(rebuilt.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
				expect(rebuilt).toEqual(session.messages);
				const assistant = rebuilt.find((message) => message.role === "assistant");
				expect(assistant?.role === "assistant" && assistant.content[0]).toMatchObject({
					type: "toolCall",
					arguments: { text: "message-end-rewritten" },
				});
				expect(rebuilt.find((message) => message.role === "toolResult")).toMatchObject({
					content: [{ type: "text", text: "tool-result-rewritten" }],
					details: { hidden: "rewritten-details" },
				});

				// Replay the stored branch into the real agent, then ask again. Historical
				// tool results remain in context, but capture entries never do or duplicate.
				session.agent.state.messages = rebuilt;
				await session.prompt("continue");
				expect(invocation).toBe(3);
				expect(providerContexts[2].messages.map((message) => message.role)).toEqual([
					"user",
					"assistant",
					"toolResult",
					"assistant",
					"user",
				]);
				expect(providerContexts[2].messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
				expect(captures(sessionManager)).toEqual(expected);
				expect(capturesAtMessageEnd[2]).toEqual(expected);
			} finally {
				session?.dispose();
				modelRegistry.unregisterProvider(model.provider);
			}
		},
	);
});
