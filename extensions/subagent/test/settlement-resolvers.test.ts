/**
 * Unit tests for the settlement-net env resolvers in `execute.ts`.
 *
 * `settlement.test.ts` exercises the full `execute()` force-settle path
 * (setting the env vars and asserting the dispatch returns in time), but the
 * pure resolver functions `resolveSettlementMs` / `resolveSettlementGraceMs`
 * are never called directly there. This pins their input→output contract. The
 * settlement value is a renewable inactivity budget, not total wall time.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
	resolveSettlementMs,
	resolveSettlementGraceMs,
	DEFAULT_SETTLEMENT_MS,
	DEFAULT_SETTLEMENT_GRACE_MS,
} from "../src/execute.js";

const ENV_KEYS = [
	"PIE_SUBAGENT_SETTLEMENT_MS",
	"PIE_SUBAGENT_SETTLEMENT_GRACE_MS",
] as const;

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

// ---------------------------------------------------------------------------
// resolveSettlementMs
// ---------------------------------------------------------------------------

test("resolveSettlementMs: unset → 12-minute renewable inactivity budget", () => {
	delete process.env.PIE_SUBAGENT_SETTLEMENT_MS;
	assert.equal(resolveSettlementMs(), DEFAULT_SETTLEMENT_MS);
	assert.equal(DEFAULT_SETTLEMENT_MS, 12 * 60 * 1000);
});

test("resolveSettlementMs: empty string → default", () => {
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "";
	assert.equal(resolveSettlementMs(), DEFAULT_SETTLEMENT_MS);
});

test("resolveSettlementMs: '0' → 0 (net explicitly disabled)", () => {
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "0";
	assert.equal(resolveSettlementMs(), 0);
});

test("resolveSettlementMs: positive number → honoured", () => {
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "120000";
	assert.equal(resolveSettlementMs(), 120000);
});

test("resolveSettlementMs: negative → default (invalid)", () => {
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "-5";
	assert.equal(resolveSettlementMs(), DEFAULT_SETTLEMENT_MS);
});

test("resolveSettlementMs: non-numeric → default", () => {
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "soon";
	assert.equal(resolveSettlementMs(), DEFAULT_SETTLEMENT_MS);
});

test("resolveSettlementMs: NaN string 'NaN' → default", () => {
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "NaN";
	assert.equal(resolveSettlementMs(), DEFAULT_SETTLEMENT_MS);
});

test("resolveSettlementMs: float is preserved (not floored) — Number() passthrough", () => {
	// The resolver uses Number(raw) with no floor; a finite positive float is
	// returned as-is. Pinning this documents the current contract.
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "1500.5";
	assert.equal(resolveSettlementMs(), 1500.5);
});

// ---------------------------------------------------------------------------
// resolveSettlementGraceMs
// ---------------------------------------------------------------------------

test("resolveSettlementGraceMs: unset → DEFAULT_SETTLEMENT_GRACE_MS", () => {
	delete process.env.PIE_SUBAGENT_SETTLEMENT_GRACE_MS;
	assert.equal(resolveSettlementGraceMs(), DEFAULT_SETTLEMENT_GRACE_MS);
	assert.equal(DEFAULT_SETTLEMENT_GRACE_MS, 5000);
});

test("resolveSettlementGraceMs: empty string → default", () => {
	process.env.PIE_SUBAGENT_SETTLEMENT_GRACE_MS = "";
	assert.equal(resolveSettlementGraceMs(), DEFAULT_SETTLEMENT_GRACE_MS);
});

test("resolveSettlementGraceMs: '0' → 0 (skip grace, synthesize immediately)", () => {
	process.env.PIE_SUBAGENT_SETTLEMENT_GRACE_MS = "0";
	assert.equal(resolveSettlementGraceMs(), 0);
});

test("resolveSettlementGraceMs: positive number → honoured", () => {
	process.env.PIE_SUBAGENT_SETTLEMENT_GRACE_MS = "3000";
	assert.equal(resolveSettlementGraceMs(), 3000);
});

test("resolveSettlementGraceMs: negative → default", () => {
	process.env.PIE_SUBAGENT_SETTLEMENT_GRACE_MS = "-1";
	assert.equal(resolveSettlementGraceMs(), DEFAULT_SETTLEMENT_GRACE_MS);
});

test("resolveSettlementGraceMs: non-numeric → default", () => {
	process.env.PIE_SUBAGENT_SETTLEMENT_GRACE_MS = "never";
	assert.equal(resolveSettlementGraceMs(), DEFAULT_SETTLEMENT_GRACE_MS);
});
