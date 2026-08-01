import path from "node:path";
import type { PruningDecision, PruningMode } from "./types.js";
import { countTokens } from "../../shared/tokenize.js";
import { JsonlWriter } from "../../shared/jsonl-writer.js";

/** Root of the pi-config repo, resolved from this extension's known position. */
const CONFIG_ROOT = process.env.PI_CODING_AGENT_DIR
	? path.resolve(process.env.PI_CODING_AGENT_DIR)
	: path.resolve(import.meta.dirname, "..", "..");

const writer = new JsonlWriter({
	defaultLogPath: path.join(CONFIG_ROOT, "data", "pruning.jsonl"),
	warnLabel: "[skill-pruner] failed to append pruning log",
});

interface SessionTracking {
	mode: PruningMode;
	knownSkillPathsLowercase: Set<string>;
	prunedSkillPathsLowercase: Set<string>;
	shadowPrunedPathsLowercase: Set<string>;
	skillNamesByPath: Map<string, string>;
}

type JsonLineEvent = PruningDecision | {
	event: "skill_read" | "skill_miss" | "shadow_miss_candidate" | "skill_recovered" | "tool_recovered" | "skills_block_not_found";
	skillName?: string;
	toolName?: string;
	mode?: PruningMode;
	sessionId: string;
	timestamp: string;
};

const sessionTracking = new Map<string, SessionTracking>();

function normalizeSkillPath(readPath: string): string {
	return readPath.replace(/\\/g, "/").toLowerCase();
}

function appendJsonLine(event: JsonLineEvent): void {
	writer.append(JSON.stringify(event));
}

/** Wait for all queued log writes to finish. Tests await this before reading
 *  the JSONL file; production may call it to drain on shutdown. */
export function flushLog(): Promise<void> {
	return writer.flush();
}

export function appendDecision(decision: PruningDecision): PruningDecision {
	appendJsonLine(decision);
	return decision;
}

export function recordKnownSkills(
	sessionId: string,
	mode: PruningMode,
	allSkillPaths: string[],
	prunedPaths: string[],
	shadowPrunedPaths: string[],
): void {
	const tracking: SessionTracking = {
		mode,
		knownSkillPathsLowercase: new Set(),
		prunedSkillPathsLowercase: new Set(),
		shadowPrunedPathsLowercase: new Set(),
		skillNamesByPath: new Map(),
	};

	for (const skillPath of allSkillPaths) {
		const normalizedPath = normalizeSkillPath(skillPath);
		tracking.knownSkillPathsLowercase.add(normalizedPath);
		tracking.skillNamesByPath.set(normalizedPath, deriveSkillName(skillPath));
	}

	for (const skillPath of prunedPaths) {
		tracking.prunedSkillPathsLowercase.add(normalizeSkillPath(skillPath));
	}

	for (const skillPath of shadowPrunedPaths) {
		tracking.shadowPrunedPathsLowercase.add(normalizeSkillPath(skillPath));
	}

	sessionTracking.set(sessionId, tracking);
}

export function recordSkillRead(sessionId: string, readPath: string): void {
	const normalizedPath = normalizeSkillPath(readPath);
	const tracking = sessionTracking.get(sessionId);

	// Only fire events when the path is a known skill path.
	if (!tracking?.knownSkillPathsLowercase.has(normalizedPath)) {
		return;
	}

	const skillName = tracking.skillNamesByPath.get(normalizedPath) ?? deriveSkillName(readPath);
	const timestamp = new Date().toISOString();

	if (tracking.mode === "auto" && tracking.prunedSkillPathsLowercase.has(normalizedPath)) {
		appendJsonLine({ event: "skill_miss", skillName, sessionId, timestamp });
	} else if (tracking.mode === "shadow" && tracking.shadowPrunedPathsLowercase.has(normalizedPath)) {
		appendJsonLine({ event: "shadow_miss_candidate", skillName, sessionId, timestamp });
	} else {
		appendJsonLine({ event: "skill_read", skillName, sessionId, timestamp });
	}
}

export function recordSkillRecovery(sessionId: string, skillName: string): void {
	appendJsonLine({ event: "skill_recovered", skillName, sessionId, timestamp: new Date().toISOString() });
}

export function recordToolRecovery(sessionId: string, toolName: string): void {
	appendJsonLine({ event: "tool_recovered", toolName, sessionId, timestamp: new Date().toISOString() });
}

/** Record that skill pruning self-disabled because the host skills block was
 *  missing from the system prompt (most likely a host system-prompt layout
 *  drift). Emitted to the JSONL log so the silent disable is auditable rather
 *  than just a transient `console.warn`. The analytics pipeline drops unknown
 *  event types, so this is a diagnostic signal, not a dashboard metric. */
export function recordSkillsBlockNotFound(sessionId: string, mode: PruningMode): void {
	appendJsonLine({
		event: "skills_block_not_found",
		mode,
		sessionId,
		timestamp: new Date().toISOString(),
	});
}

export function estimateTokens(text: string): number {
	return countTokens(text);
}

function deriveSkillName(readPath: string): string {
	const normalized = readPath.replace(/\\/g, "/");
	const parts = normalized.split("/").filter(Boolean);
	const last = parts.at(-1) ?? "unknown";
	if (last.toLowerCase() === "skill.md" && parts.length >= 2) {
		return parts[parts.length - 2];
	}
	return last.replace(/\.md$/i, "") || "unknown";
}

export function setLogPathForTesting(logPath: string | null): void {
	writer.setLogPathForTesting(logPath);
}

/** Lower the rotation threshold so tests can exercise rotation without writing 5MB. */
export function setMaxLogBytesForTesting(bytes: number | null): void {
	writer.setMaxLogBytesForTesting(bytes);
}

export function clearPruningTrackingForTesting(): void {
	sessionTracking.clear();
}
