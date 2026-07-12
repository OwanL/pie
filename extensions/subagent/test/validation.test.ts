/**
 * Bug-finding tests for validation.ts.
 *
 * Original tests: basic formatAvailableAgents, findSuggestedAgentName,
 * buildUnknownAgentError, createInvalidAgentResult, summarizeInvalidAgentResults.
 * Added: empty array for summarize (CRASH?), whitespace-only agent names,
 * all scope keywords, empty agent list for every function, edge cases for
 * findSuggestedAgentName with tricky inputs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
	buildUnknownAgentError,
	createInvalidAgentResult,
	findSuggestedAgentName,
	formatAvailableAgents,
	summarizeInvalidAgentResults,
} from "../validation.js";
import type { AgentConfig } from "../agents.js";

// --- Fixtures ---

const MOCK_AGENTS: AgentConfig[] = [
	{
		name: "worker",
		description: "General-purpose worker",
		systemPrompt: "You are a worker.",
		source: "user",
		filePath: "/fake/worker.md",
	},
	{
		name: "reviewer",
		description: "Code reviewer",
		systemPrompt: "You are a reviewer.",
		source: "user",
		filePath: "/fake/reviewer.md",
	},
	{
		name: "scout",
		description: "Scout agent",
		systemPrompt: "You are a scout.",
		source: "project",
		filePath: "/fake/scout.md",
	},
];

const EMPTY_AGENTS: AgentConfig[] = [];

// ============================================================
// formatAvailableAgents
// ============================================================

test("formatAvailableAgents lists quoted names", () => {
	const result = formatAvailableAgents(MOCK_AGENTS);
	assert.equal(result, '"worker", "reviewer", "scout"');
});

test("formatAvailableAgents returns 'none' for empty list", () => {
	assert.equal(formatAvailableAgents([]), "none");
});

test("formatAvailableAgents handles single agent", () => {
	const result = formatAvailableAgents([MOCK_AGENTS[0]]);
	assert.equal(result, '"worker"');
});

// ============================================================
// findSuggestedAgentName
// ============================================================

test("findSuggestedAgentName finds case-insensitive match", () => {
	assert.equal(findSuggestedAgentName("Worker", MOCK_AGENTS), "worker");
	assert.equal(findSuggestedAgentName("REVIEWER", MOCK_AGENTS), "reviewer");
});

test("findSuggestedAgentName returns undefined for no match", () => {
	assert.equal(findSuggestedAgentName("planner", MOCK_AGENTS), undefined);
});

test("findSuggestedAgentName trims whitespace", () => {
	assert.equal(findSuggestedAgentName("  worker  ", MOCK_AGENTS), "worker");
});

test("findSuggestedAgentName: empty string returns undefined", () => {
	assert.equal(findSuggestedAgentName("", MOCK_AGENTS), undefined);
});

test("findSuggestedAgentName: whitespace-only string returns undefined", () => {
	assert.equal(findSuggestedAgentName("   ", MOCK_AGENTS), undefined);
});

test("findSuggestedAgentName: empty agent list returns undefined", () => {
	assert.equal(findSuggestedAgentName("worker", EMPTY_AGENTS), undefined);
	assert.equal(findSuggestedAgentName("", EMPTY_AGENTS), undefined);
});

test("findSuggestedAgentName: exact match is found", () => {
	// The function normalizes to lowercase; an exact match of the lowercased name
	assert.equal(findSuggestedAgentName("worker", MOCK_AGENTS), "worker");
});

test("findSuggestedAgentName: partial substring does NOT match", () => {
	// "work" !== "worker" even after lowercasing
	assert.equal(findSuggestedAgentName("work", MOCK_AGENTS), undefined);
	assert.equal(findSuggestedAgentName("revie", MOCK_AGENTS), undefined);
});

test("findSuggestedAgentName: superstring does NOT match", () => {
	assert.equal(findSuggestedAgentName("workers", MOCK_AGENTS), undefined);
});

test("findSuggestedAgentName: unicode characters in comparison", () => {
	const agents: AgentConfig[] = [
		{ name: "über-agent", description: "unicode", systemPrompt: "", source: "user", filePath: "/a.md" },
	];
	// The real implementation trims + lowercases both sides. toLowerCase() folds
	// \u00dc (Ü) -> \u00fc (ü), so "Über-Agent" normalizes to "über-agent" and matches.
	const result = findSuggestedAgentName("Über-Agent", agents);
	assert.equal(result, "über-agent");
});

test("findSuggestedAgentName: agents with duplicate-like names", () => {
	const agents: AgentConfig[] = [
		{ name: "agent1", description: "a", systemPrompt: "", source: "user", filePath: "/a.md" },
		{ name: "agent2", description: "b", systemPrompt: "", source: "user", filePath: "/b.md" },
		{ name: "agent", description: "c", systemPrompt: "", source: "user", filePath: "/c.md" },
	];
	assert.equal(findSuggestedAgentName("Agent1", agents), "agent1");
	assert.equal(findSuggestedAgentName("Agent", agents), "agent");
	// Should NOT match "agent2" for "Agent" input
	assert.notEqual(findSuggestedAgentName("Agent", agents), "agent2");
});

// ============================================================
// buildUnknownAgentError — SCOPE KEYWORD DETECTION
// ============================================================

test("buildUnknownAgentError suggests correct name on case mismatch", () => {
	const err = buildUnknownAgentError("Worker", MOCK_AGENTS);
	assert.match(err, /Did you mean "worker"/);
});

test("buildUnknownAgentError detects 'user' as scope keyword", () => {
	const err = buildUnknownAgentError("user", MOCK_AGENTS);
	assert.match(err, /not an available agent name/);
});

test("buildUnknownAgentError detects 'project' as scope keyword", () => {
	const err = buildUnknownAgentError("project", MOCK_AGENTS);
	assert.match(err, /not an available agent name/);
});

test("buildUnknownAgentError detects 'both' as scope keyword", () => {
	const err = buildUnknownAgentError("both", MOCK_AGENTS);
	assert.match(err, /not an available agent name/);
});

test("buildUnknownAgentError includes worker hint when worker exists", () => {
	const err = buildUnknownAgentError("nonexistent", MOCK_AGENTS);
	assert.match(err, /try "worker"/);
});

test("buildUnknownAgentError omits worker hint when no worker agent", () => {
	const noWorker = MOCK_AGENTS.filter((a) => a.name !== "worker");
	const err = buildUnknownAgentError("nonexistent", noWorker);
	assert.doesNotMatch(err, /try "worker"/);
});

test("buildUnknownAgentError lists available agents", () => {
	const err = buildUnknownAgentError("nonexistent", MOCK_AGENTS);
	assert.match(err, /Available agents: "worker", "reviewer", "scout"/);
});

test("buildUnknownAgentError: empty agents list", () => {
	const err = buildUnknownAgentError("any-agent", EMPTY_AGENTS);
	assert.match(err, /Unknown agent/);
	assert.match(err, /Available agents: none/);
	assert.doesNotMatch(err, /try "worker"/);
});

test("buildUnknownAgentError: scope keyword with empty agents still detected", () => {
	const err = buildUnknownAgentError("user", EMPTY_AGENTS);
	assert.match(err, /not an available agent name/);
});

test("buildUnknownAgentError: exact name that exists but scope keyword collision", () => {
	// If an agent is literally named "user", "project", or "both" — the scope check
	// fires first, which might be a false positive
	const agentsWithUser: AgentConfig[] = [
		{ name: "user", description: "An agent named user", systemPrompt: "", source: "user", filePath: "/a.md" },
	];
	const err = buildUnknownAgentError("user", agentsWithUser);
	// BUG?: Even though "user" is a valid agent, the scope keyword check fires first
	// and produces a misleading error suggesting you can't use "user" as an agent name
	// This is actually a design issue — agents named after scope values are ambiguous
	assert.match(err, /agentScope value, not an agent name/);
});

test("buildUnknownAgentError: whitespace-only agent name", () => {
	const err = buildUnknownAgentError("   ", MOCK_AGENTS);
	assert.match(err, /Unknown agent/);
	assert.doesNotMatch(err, /agentScope value/); // "   " is not a scope value
});

test("buildUnknownAgentError: empty string agent name", () => {
	const err = buildUnknownAgentError("", MOCK_AGENTS);
	assert.match(err, /Unknown agent/);
});

test("buildUnknownAgentError: scope keyword message no longer references agentScope", () => {
	const err = buildUnknownAgentError("both", MOCK_AGENTS);
	assert.doesNotMatch(err, /agentScope/);
});

// ============================================================
// createInvalidAgentResult
// ============================================================

test("createInvalidAgentResult builds error result with stderr", () => {
	const result = createInvalidAgentResult("bad-agent", "do stuff", MOCK_AGENTS);
	assert.equal(result.agent, "bad-agent");
	assert.equal(result.task, "do stuff");
	assert.equal(result.exitCode, 1);
	assert.equal(result.agentSource, "unknown");
	assert.equal(result.messages.length, 0);
	assert.ok(result.stderr.length > 0);
	assert.equal(result.usage.input, 0);
	assert.equal(result.usage.cost, 0);
});

test("createInvalidAgentResult includes step number when provided", () => {
	const result = createInvalidAgentResult("bad-agent", "task", MOCK_AGENTS, 3);
	assert.equal(result.step, 3);
});

test("createInvalidAgentResult omits step when not provided", () => {
	const result = createInvalidAgentResult("bad-agent", "task", MOCK_AGENTS);
	assert.equal(result.step, undefined);
});

test("createInvalidAgentResult: zero step number is valid", () => {
	const result = createInvalidAgentResult("bad-agent", "task", MOCK_AGENTS, 0);
	assert.equal(result.step, 0);
});

test("createInvalidAgentResult: negative step number", () => {
	const result = createInvalidAgentResult("bad-agent", "task", MOCK_AGENTS, -1);
	assert.equal(result.step, -1);
});

test("createInvalidAgentResult: task can be empty string", () => {
	const result = createInvalidAgentResult("bad-agent", "", MOCK_AGENTS);
	assert.equal(result.task, "");
});

test("createInvalidAgentResult: result for scope keyword misuse includes specific error", () => {
	const result = createInvalidAgentResult("both", "do work", MOCK_AGENTS);
	assert.match(result.stderr, /not an available agent name/);
});

// ============================================================
// summarizeInvalidAgentResults — CRASH CASES
// ============================================================

test("summarizeInvalidAgentResults returns single error directly", () => {
	const results = [createInvalidAgentResult("x", "t", MOCK_AGENTS)];
	const summary = summarizeInvalidAgentResults(results);
	// Single result returns the stderr directly — no wrapping prefix
	assert.equal(summary, results[0].stderr);
});

test("summarizeInvalidAgentResults wraps multiple errors", () => {
	const results = [
		createInvalidAgentResult("bad1", "t1", MOCK_AGENTS),
		createInvalidAgentResult("bad2", "t2", MOCK_AGENTS),
	];
	const summary = summarizeInvalidAgentResults(results);
	assert.match(summary, /Invalid agent names in 2 subagent tasks/);
	assert.match(summary, /\[bad1\]/);
	assert.match(summary, /\[bad2\]/);
});

test("summarizeInvalidAgentResults: EMPTY ARRAY — will this crash?", () => {
	// The code does: if (results.length === 1) return results[0].stderr
	// If results.length === 0, it falls to the `else` branch and builds:
	//   `Invalid agent names in ${results.length} subagent tasks.`
	//   followed by results.map(...).join("\n") which yields ""
	// Result: "Invalid agent names in 0 subagent tasks.\n\n"
	// This is a minor bug: produces a confusing message for 0 invalid results
	const summary = summarizeInvalidAgentResults([]);
	assert.ok(summary.length > 0, "Should produce some output, not crash");
	assert.match(summary, /Invalid agent names in 0/);
});

test("summarizeInvalidAgentResults: single result with empty stderr", () => {
	// This shouldn't happen through createInvalidAgentResult (which always sets stderr)
	// but if someone constructs a SingleResult with empty stderr, the summary would
	// be empty string for a single result
	const emptyStderr = { ...createInvalidAgentResult("x", "t", MOCK_AGENTS), stderr: "" };
	const summary = summarizeInvalidAgentResults([emptyStderr]);
	assert.equal(summary, "");
});

test("summarizeInvalidAgentResults: many results", () => {
	const results = Array.from({ length: 50 }, (_, i) =>
		createInvalidAgentResult(`bad-${i}`, `task-${i}`, MOCK_AGENTS),
	);
	const summary = summarizeInvalidAgentResults(results);
	assert.match(summary, /Invalid agent names in 50 subagent tasks/);
	// Should include all 50 agent names
	for (let i = 0; i < 50; i++) {
		assert.match(summary, new RegExp(`\\[bad-${i}\\]`));
	}
});
