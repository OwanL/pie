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
import { discoverAgents } from "../agents.js";
import { SubagentParams, prepareSubagentArguments, BUCKET_GUIDANCE as BUCKET_GUIDANCE_BASE } from "../schema.js";
import { renderSubagentCall, renderSubagentResult } from "../render.js";
import { execute } from "./execute.js";
import type { OnUpdateCallback } from "../types.js";

const THINKING_LEVEL_HINT = "Optional thinkingLevel: minimal, low, medium, high, or xhigh.";
const BUCKET_GUIDANCE = `${BUCKET_GUIDANCE_BASE} ${THINKING_LEVEL_HINT}`;

/** Root of the pi-config repo, resolved from this extension's known position.
 *  Used as a stable fallback discovery cwd so the agent list is populated even
 *  when the session cwd has no `agents/` dir and PI_CODING_AGENT_DIR is unset
 *  (e.g. a session launched from C:\WINDOWS\System32). Mirrors CONFIG_ROOT in
 *  ./execute.ts — keep the two in sync. */
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
		return "DISABLED: Sub agents are currently disabled. Calls to this tool will return an error immediately. Enable by removing the --no-subagent flag or unsetting the PI_SUBAGENT_DISABLED environment variable.";
	}

	const lines = [
		"Delegate one concrete task to a specialized agent with isolated context.",
		"For independent work, issue multiple sibling subagent calls in the same response; for dependent work, call subagent sequentially after reading the prior result.",
		"Agents are discovered automatically from both user and project directories; project-local agents require user confirmation before they run.",
		BUCKET_GUIDANCE,
	];

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
		return "DISABLED: Sub agents are disabled.";
	}
	return "Delegate one concrete task to a discovered agent; sibling calls run in parallel natively.";
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

	const isDisabledFn = isDisabled(pi);
	const disabled = isDisabledFn();

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: buildDescription(disabled),
		promptSnippet: buildPromptSnippet(disabled),
		promptGuidelines: [
			"Use sibling subagent calls in one response only for independent work; for dependent work, wait for the prior subagent result before calling another.",
		],
		parameters: SubagentParams,
		prepareArguments: prepareSubagentArguments,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
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
