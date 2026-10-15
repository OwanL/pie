/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Each subagent invocation runs an isolated AgentSession in-process via the
 * pi SDK (`createAgentSession`). The session shares the parent's auth and
 * model registry but gets its own context window, system prompt, and tools.
 *
 * One invocation delegates one task. Pi's native sibling-tool execution is the
 * only parallel route; sequential delegation uses normal agent turns.
 *
 * Files:
 *   - ./types.ts        — shared interfaces and constants
 *   - ./formatting.ts   — token / tool-call / display formatters
 *   - ./validation.ts   — agent-name validation + error helpers
 *   - ./runner.ts       — in-process AgentSession runner + depth/trail context
 *   - ./schema.ts       — typebox parameter schema
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAgents } from "../../agent-instructions/agent-discovery/agents.js";
import { SubagentParams, prepareSubagentArguments } from "./schema.js";
import { renderSubagentCall, renderSubagentResult } from "./render.js";
import type { OnUpdateCallback } from "./types.js";
import { SUBAGENT_GUIDANCE } from "./guidance.js";
import { registerSubagentAnalyticsProviderHook } from "./analytics-provider-hook.js";

/** Root of the pi-config repo, resolved from this tool's known position
 *  (harness/tools/subagent). Used as a stable fallback discovery cwd so the agent
 *  list is populated even when the session cwd has no `agents/` dir and
 *  PI_CODING_AGENT_DIR is unset (e.g. a session launched from
 *  C:\WINDOWS\System32). Mirrors CONFIG_ROOT in ./execute.ts — keep the two
 *  in sync. */
const CONFIG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Discover agents for the tool description/prompt snippet. Uses "both" scope
 *  (user + project) and includes CONFIG_ROOT as a stable fallback cwd so the
 *  listing is never a silent "none" when the session cwd has no `agents/` and
 *  PI_CODING_AGENT_DIR is unset. Built once at load; execution re-discovers
 *  per call (see ./execute.ts) so the executable set is always current. */
function discoverAgentsForDescription() {
	return discoverAgents([process.cwd(), CONFIG_ROOT], "both").agents;
}

function buildDescription(disabled = false): string {
	if (disabled) {
		return SUBAGENT_GUIDANCE.disabledDescription;
	}

	// Sibling-call/dependency ordering and model-bucket guidance live in
	// promptGuidelines and the bucket parameter schema respectively; do not
	// duplicate them here.
	const lines = [SUBAGENT_GUIDANCE.description];

	try {
		const agents = discoverAgentsForDescription();
		if (agents.length > 0) {
			const listing = agents.map((a) => `${a.name}: ${a.description}`).join("; ");
			lines.push(`Available agents: ${listing}.`);
		}
	} catch {
		// Discovery failed — omit listing; agents will still be validated at execution time
	}

	return lines.join(" ");
}

function buildPromptSnippet(disabled = false): string {
	if (disabled) {
		return SUBAGENT_GUIDANCE.disabledSnippet;
	}
	return SUBAGENT_GUIDANCE.snippet;
}

/** Check whether subagent execution is disabled via flag or env var. */
function isDisabled(pi: ExtensionAPI): () => boolean {
	return () =>
		pi.getFlag("no-subagent") === true ||
		["1", "true", "yes"].includes((process.env.PI_SUBAGENT_DISABLED ?? "").toLowerCase());
}

export default function (pi: ExtensionAPI) {
	// Register a CLI flag so users can disable subagent execution.
	// When set, the tool still registers (preventing LLM tool-call hangs)
	// but execute() returns an immediate error.
	pi.registerFlag("no-subagent", {
		description: "Disable subagent execution. The subagent tool will still appear in the tool list but will return an error immediately when called.",
		type: "boolean",
		default: false,
	});

	// This supported SDK hook runs for every agent-loop provider request,
	// including later turns after tools. The attempt state lives on the current
	// AsyncLocalStorage context, so the root session and unrelated siblings are
	// strict no-ops. Capture is synchronous and never modifies the provider
	// payload or waits for recorder acknowledgement/persistence.
	registerSubagentAnalyticsProviderHook(pi);

	const isDisabledFn = isDisabled(pi);
	const disabled = isDisabledFn();
	// Registration exposes metadata only. Share the first implementation load
	// between sibling calls while keeping each registration's Pi API closure fresh.
	let executionModule: Promise<typeof import("./execute.js")> | undefined;

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: buildDescription(disabled),
		promptSnippet: buildPromptSnippet(disabled),
		promptGuidelines: [SUBAGENT_GUIDANCE.guideline],
		parameters: SubagentParams,
		prepareArguments: prepareSubagentArguments,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { execute } = await (executionModule ??= import("./execute.js"));
			return execute(_toolCallId, params, signal, onUpdate as OnUpdateCallback, ctx, pi, isDisabledFn);
		},

		renderCall(args, theme, context) {
			return renderSubagentCall(args, theme, context);
		},

		renderResult(result, options, theme, context) {
			return renderSubagentResult(result, options, theme, context);
		},
	});
}
