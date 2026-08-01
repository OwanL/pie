import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	appendDecision,
	clearPruningTrackingForTesting,
	estimateTokens,
	flushLog,
	recordKnownSkills,
	recordSkillRead,
	setLogPathForTesting,
	setMaxLogBytesForTesting,
} from "../logger.js";
import { tokenizerAvailable } from "../../../shared/tokenize.js";
import type { PruningDecision } from "../types.js";

function tempLogPath(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "skill-pruner-logger-"));
	return path.join(dir, "pruning.jsonl");
}

test("recordSkillRead logs known non-SKILL.md paths with derived filename", async () => {
	const logPath = tempLogPath();
	setLogPathForTesting(logPath);
	clearPruningTrackingForTesting();
	try {
		recordKnownSkills(
			"session-logger",
			"auto",
			["C:\\Repo\\skills\\CustomGuide.md"],
			[],
			[],
		);
		recordSkillRead("session-logger", "c:/repo/skills/customguide.md");
		await flushLog();

		const entries = readFileSync(logPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(entries.length, 1);
		assert.equal(entries[0].event, "skill_read");
		assert.equal(entries[0].skillName, "CustomGuide");
	} finally {
		setLogPathForTesting(null);
		clearPruningTrackingForTesting();
	}
});

test("recordSkillRead with unknown session/path is a no-op", () => {
	const logPath = tempLogPath();
	setLogPathForTesting(logPath);
	clearPruningTrackingForTesting();
	try {
		recordSkillRead("missing-session", "/repo/skills/unknown/SKILL.md");
		assert.equal(existsSync(logPath), false);
	} finally {
		setLogPathForTesting(null);
		clearPruningTrackingForTesting();
	}
});

test("appendDecision returns the same decision object and appends JSONL", async () => {
	const logPath = tempLogPath();
	setLogPathForTesting(logPath);
	clearPruningTrackingForTesting();
	try {
		const decision: PruningDecision = {
			timestamp: new Date().toISOString(),
			sessionId: "s1",
			sessionPath: "/repo/s1",
			mode: "auto",
			query: "query",
			llmModel: "test-model",
			llmThinkingLevel: "medium",
			llmResponse: "{}",
			llmLatencyMs: 0,
			pinned: [],
			included: [],
			excluded: [],
			skillBlockTokens: 1,
			originalBlockTokens: 2,
		};
		const returned = appendDecision(decision);
		assert.equal(returned, decision);
		await flushLog();

		const stored = JSON.parse(readFileSync(logPath, "utf-8").trim());
		assert.equal(stored.sessionId, "s1");
	} finally {
		setLogPathForTesting(null);
		clearPruningTrackingForTesting();
	}
});

test("appendJsonLine warning path is handled when log path is invalid for append", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "skill-pruner-logger-dir-"));
	const asDirectoryPath = path.join(dir, "as-directory");
	mkdirSync(asDirectoryPath, { recursive: true });

	setLogPathForTesting(asDirectoryPath);
	clearPruningTrackingForTesting();
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (message?: unknown) => {
		warnings.push(String(message));
	};
	try {
		appendDecision({
			timestamp: new Date().toISOString(),
			sessionId: "s2",
			sessionPath: "/repo/s2",
			mode: "shadow",
			query: "query",
			llmModel: "test-model",
			llmThinkingLevel: "medium",
			llmResponse: "{}",
			llmLatencyMs: 0,
			pinned: [],
			included: [],
			excluded: [],
			skillBlockTokens: 1,
			originalBlockTokens: 1,
		});
		await flushLog();
		assert.ok(warnings.some((warning) => warning.includes("failed to append pruning log")));
	} finally {
		console.warn = originalWarn;
		setLogPathForTesting(null);
		clearPruningTrackingForTesting();
	}
});

test("appendJsonLine rotates the log to .1/.2 past the size limit and keeps the newest entries", async () => {
	const logPath = tempLogPath();
	setLogPathForTesting(logPath);
	setMaxLogBytesForTesting(64); // tiny limit so each line triggers a rotation
	clearPruningTrackingForTesting();
	try {
		// Each decision serializes to well over the 64-byte limit.
		for (let i = 0; i < 4; i++) {
			appendDecision(makeDecision(`s${i}`));
		}
		await flushLog();

		// Newest 2 rotations are kept: .1 = most recent backup, .2 = older.
		assert.ok(existsSync(`${logPath}.1`), "rotated backup .1 should exist");
		assert.ok(existsSync(`${logPath}.2`), "rotated backup .2 should exist");
		// The current log holds the most recent entry (s3).
		assert.ok(existsSync(logPath));
		const currentLines = readFileSync(logPath, "utf-8").trim().split("\n");
		assert.equal(currentLines.length, 1);
		assert.equal(JSON.parse(currentLines[0]).sessionId, "s3");
		// .1 holds the previous entry (s2); the oldest (s0) was dropped.
		const oneLines = readFileSync(`${logPath}.1`, "utf-8").trim().split("\n");
		assert.equal(oneLines.length, 1);
		assert.equal(JSON.parse(oneLines[0]).sessionId, "s2");
	} finally {
		setLogPathForTesting(null);
		setMaxLogBytesForTesting(null);
		clearPruningTrackingForTesting();
	}
});

function makeDecision(sessionId: string): PruningDecision {
	return {
		timestamp: new Date().toISOString(),
		sessionId,
		sessionPath: `/repo/${sessionId}`,
		mode: "auto",
		query: "x".repeat(200), // ensure each line exceeds the tiny test limit
		llmModel: "test-model",
		llmThinkingLevel: "medium",
		llmResponse: "{}",
		llmLatencyMs: 0,
		pinned: [],
		included: [],
		excluded: [],
		skillBlockTokens: 1,
		originalBlockTokens: 2,
	};
}

test("estimateTokens counts real BPE tokens via cl100k_base (falls back to chars/4 if unavailable)", () => {
	assert.equal(estimateTokens(""), 0);
	assert.equal(estimateTokens("abcd"), 1);
	assert.equal(estimateTokens("abcde"), 2);
	if (tokenizerAvailable()) {
		// "hello world" is 2 cl100k tokens; the chars/4 heuristic would give 3.
		assert.equal(estimateTokens("hello world"), 2);
		assert.equal(estimateTokens("The quick brown fox"), 4);
	} else {
		assert.equal(estimateTokens("hello world"), Math.ceil("hello world".length / 4));
	}
});
