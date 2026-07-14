/**
 * Tests for runtime configuration resolvers: subagent timeout and parallel
 * preview length. Both are driven by environment variables with safe defaults
 * (no timeout; generous parallel preview).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolveSubagentTimeoutMs, DEFAULT_SUBAGENT_TIMEOUT_MS } from "../runner.js";

const ENV_KEYS = ["PI_SUBAGENT_TIMEOUT_MS", "PI_SUBAGENT_PARALLEL_PREVIEW"] as const;
const snapshot: Record<string, string | undefined> = {};

test.before(() => {
	for (const key of ENV_KEYS) snapshot[key] = process.env[key];
});

test.after(() => {
	for (const key of ENV_KEYS) {
		if (snapshot[key] === undefined) delete process.env[key];
		else process.env[key] = snapshot[key];
	}
});

// ============================================================
// resolveSubagentTimeoutMs — no ordinary wall-clock deadline by default.
// A positive value opts into a last-resort absolute containment ceiling.
// ============================================================

test("resolveSubagentTimeoutMs: unset → disabled", () => {
	delete process.env.PI_SUBAGENT_TIMEOUT_MS;
	assert.equal(resolveSubagentTimeoutMs(), DEFAULT_SUBAGENT_TIMEOUT_MS);
});

test("resolveSubagentTimeoutMs: empty string → DEFAULT_SUBAGENT_TIMEOUT_MS", () => {
	process.env.PI_SUBAGENT_TIMEOUT_MS = "";
	assert.equal(resolveSubagentTimeoutMs(), DEFAULT_SUBAGENT_TIMEOUT_MS);
});

test("resolveSubagentTimeoutMs: positive ms → that value", () => {
	process.env.PI_SUBAGENT_TIMEOUT_MS = "300000";
	assert.equal(resolveSubagentTimeoutMs(), 300000);
});

test("resolveSubagentTimeoutMs: 0 → disabled", () => {
	process.env.PI_SUBAGENT_TIMEOUT_MS = "0";
	assert.equal(resolveSubagentTimeoutMs(), 0);
});

test("resolveSubagentTimeoutMs: negative → disabled", () => {
	process.env.PI_SUBAGENT_TIMEOUT_MS = "-5";
	assert.equal(resolveSubagentTimeoutMs(), DEFAULT_SUBAGENT_TIMEOUT_MS);
});

test("resolveSubagentTimeoutMs: non-numeric → disabled", () => {
	process.env.PI_SUBAGENT_TIMEOUT_MS = "abc";
	assert.equal(resolveSubagentTimeoutMs(), DEFAULT_SUBAGENT_TIMEOUT_MS);
});

test("resolveSubagentTimeoutMs: positive float → accepted", () => {
	process.env.PI_SUBAGENT_TIMEOUT_MS = "1500.5";
	assert.equal(resolveSubagentTimeoutMs(), 1500.5);
});

// ============================================================
// resolveParallelPreviewLimit — default is PARALLEL_SUMMARY_PREVIEW
// ============================================================
