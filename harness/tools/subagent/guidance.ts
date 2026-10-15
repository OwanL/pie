import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const relativePath = "harness/agent-instructions/subagent-guidance.md";
// Unbundled extensions resolve beside their source; bundled direct consumers
// use the installed/configured agent directory, like APPEND_SYSTEM.md.
const sourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..", relativePath);
const hasSource = existsSync(sourcePath);
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!hasSource && !agentDir) {
	throw new Error("Subagent guidance unavailable: set PI_CODING_AGENT_DIR to the Pie configuration directory.");
}
const guidancePath = hasSource ? sourcePath : path.join(agentDir!, relativePath);
const markdown = readFileSync(guidancePath, "utf8").replace(/\r\n/g, "\n");
const sections = new Map(markdown.split(/^## /m).slice(1).map((section) => {
	const newline = section.indexOf("\n");
	return [section.slice(0, newline), section.slice(newline).trim()];
}));

function section(name: string): string {
	const text = sections.get(name);
	if (!text) throw new Error(`Missing subagent guidance section: ${name} (${guidancePath})`);
	return text;
}

/** Read once at module startup, including for direct user-context consumers. */
export const SUBAGENT_GUIDANCE = Object.freeze({
	description: section("description"),
	disabledDescription: section("disabled-description"),
	snippet: section("snippet"),
	disabledSnippet: section("disabled-snippet"),
	guideline: section("guideline"),
	parentContext: section("parent-context"),
});
