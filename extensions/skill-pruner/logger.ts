import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { PruningDecision, PruningMode } from "./types.js";
import { countTokens } from "./tokenize.js";
import { toErrorMessage } from "../../shared/error-message.js";

/** Root of the pi-config repo, resolved from this extension's known position. */
const CONFIG_ROOT = process.env.PI_CODING_AGENT_DIR
	? path.resolve(process.env.PI_CODING_AGENT_DIR)
	: path.resolve(import.meta.dirname, "..", "..");

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
let logPathOverride: string | null = null;

/** Serializes async writes so concurrent appends preserve line ordering. Each
 *  call chains onto this promise; an error in one write doesn't break the next. */
let writeQueue: Promise<void> = Promise.resolve();

/** Rotate the log once it grows past this many bytes (~5MB) so it can't grow unbounded. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** Number of rotated backups to keep (newest first: .1, .2, ...). */
const MAX_ROTATIONS = 2;
let maxLogBytesOverride: number | null = null;

function getLogPath(): string {
	return logPathOverride ?? path.join(CONFIG_ROOT, "data", "pruning.jsonl");
}

function getLogByteLimit(): number {
	return maxLogBytesOverride ?? MAX_LOG_BYTES;
}

function normalizeSkillPath(readPath: string): string {
	return readPath.replace(/\\/g, "/").toLowerCase();
}

function appendJsonLine(event: JsonLineEvent): void {
	// Non-blocking: serialize the line and chain an async append onto the write
	// queue (preserves ordering without blocking the event loop). Capturing the
	// resolved path here — not at write time — keeps an already-queued write
	// pointed at the right file if the override changes later (e.g. between tests).
	const logPath = getLogPath();
	const line = `${JSON.stringify(event)}\n`;
	writeQueue = writeQueue
		.then(() => writeJsonLine(logPath, line))
		.catch((error) => {
			console.warn(`[skill-pruner] failed to append pruning log: ${toErrorMessage(error)}`);
		});
}

async function writeJsonLine(logPath: string, line: string): Promise<void> {
	await mkdir(path.dirname(logPath), { recursive: true });
	if (await shouldRotateLog(logPath)) {
		await rotateLog(logPath);
	}
	await appendFile(logPath, line, "utf-8");
}

async function shouldRotateLog(logPath: string): Promise<boolean> {
	try {
		const stats = await stat(logPath);
		return stats.size >= getLogByteLimit();
	} catch {
		// File doesn't exist yet — nothing to rotate.
		return false;
	}
}

/** Rename the current log to `.1` (shifting older backups down) so the next
 *  append starts a fresh file. Keeps the newest `MAX_ROTATIONS` backups. */
async function rotateLog(logPath: string): Promise<void> {
	// Drop the oldest backup, then shift each remaining backup up by one slot.
	await rm(`${logPath}.${MAX_ROTATIONS}`, { force: true });
	for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
		await safeRename(`${logPath}.${i}`, `${logPath}.${i + 1}`);
	}
	// Move the current log into the .1 slot; the next append recreates it fresh.
	await safeRename(logPath, `${logPath}.1`);
}

async function safeRename(from: string, to: string): Promise<void> {
	try {
		await rename(from, to);
	} catch (error) {
		// A backup slot may not exist yet on the first few rotations — skip it.
		if (!isEnoent(error)) throw error;
	}
}

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Wait for all queued log writes to finish. Tests await this before reading
 *  the JSONL file; production may call it to drain on shutdown. */
export function flushLog(): Promise<void> {
	return writeQueue;
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
	logPathOverride = logPath;
}

/** Lower the rotation threshold so tests can exercise rotation without writing 5MB. */
export function setMaxLogBytesForTesting(bytes: number | null): void {
	maxLogBytesOverride = bytes;
}

export function clearPruningTrackingForTesting(): void {
	sessionTracking.clear();
}
