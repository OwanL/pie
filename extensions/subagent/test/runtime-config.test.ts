/**
 * Tests for runtime configuration resolvers: subagent timeout and parallel
 * preview length. Both are driven by environment variables with safe defaults
 * (no timeout; generous parallel preview).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolveSubagentTimeoutMs, DEFAULT_SUBAGENT_TIMEOUT_MS } from "../runner.js";
import { resolveParallelPreviewLimit, previewText } from "../formatting.js";
import { PARALLEL_SUMMARY_PREVIEW } from "../types.js";

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

test("resolveParallelPreviewLimit: unset → PARALLEL_SUMMARY_PREVIEW default", () => {
	delete process.env.PI_SUBAGENT_PARALLEL_PREVIEW;
	assert.equal(resolveParallelPreviewLimit(), PARALLEL_SUMMARY_PREVIEW);
});

test("resolveParallelPreviewLimit: positive number → that value", () => {
	process.env.PI_SUBAGENT_PARALLEL_PREVIEW = "5000";
	assert.equal(resolveParallelPreviewLimit(), 5000);
});

test("resolveParallelPreviewLimit: 0 → 0 (no truncation)", () => {
	process.env.PI_SUBAGENT_PARALLEL_PREVIEW = "0";
	assert.equal(resolveParallelPreviewLimit(), 0);
});

test("resolveParallelPreviewLimit: negative → default", () => {
	process.env.PI_SUBAGENT_PARALLEL_PREVIEW = "-1";
	assert.equal(resolveParallelPreviewLimit(), PARALLEL_SUMMARY_PREVIEW);
});

test("resolveParallelPreviewLimit: non-numeric → default", () => {
	process.env.PI_SUBAGENT_PARALLEL_PREVIEW = "nope";
	assert.equal(resolveParallelPreviewLimit(), PARALLEL_SUMMARY_PREVIEW);
});

test("resolveParallelPreviewLimit: empty string → default", () => {
	process.env.PI_SUBAGENT_PARALLEL_PREVIEW = "";
	assert.equal(resolveParallelPreviewLimit(), PARALLEL_SUMMARY_PREVIEW);
});

// ============================================================
// previewText — truncation behavior
// ============================================================

test("previewText: short text unchanged", () => {
	delete process.env.PI_SUBAGENT_PARALLEL_PREVIEW;
	assert.equal(previewText("short"), "short");
});

test("previewText: truncates to limit and notes elided chars", () => {
	process.env.PI_SUBAGENT_PARALLEL_PREVIEW = "10";
	const text = "abcdefghijklmnopqrstuvwxyz"; // 26 chars
	assert.equal(previewText(text), "abcdefghij... (+16 chars)");
});

test("previewText: exactly at limit is not truncated", () => {
	process.env.PI_SUBAGENT_PARALLEL_PREVIEW = "5";
	assert.equal(previewText("abcde"), "abcde");
});

test("previewText: limit 0 disables truncation", () => {
	process.env.PI_SUBAGENT_PARALLEL_PREVIEW = "0";
	const long = "x".repeat(100000);
	assert.equal(previewText(long), long);
});

test("previewText: uses default when env unset", () => {
	delete process.env.PI_SUBAGENT_PARALLEL_PREVIEW;
	const text = "y".repeat(PARALLEL_SUMMARY_PREVIEW);
	assert.equal(previewText(text), text); // exactly at default limit, not truncated
	assert.equal(
		previewText(text + "z"),
		`${"y".repeat(PARALLEL_SUMMARY_PREVIEW)}... (+1 chars)`,
	);
});
