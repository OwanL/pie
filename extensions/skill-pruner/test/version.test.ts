/**
 * Unit tests for the code-version tag stamped onto every pruning decision.
 *
 * `getCodeVersion()` resolves the repo HEAD short SHA lazily and caches it,
 * so analytics can split pruning runs into cohorts (e.g. before/after a
 * prompt-compaction change) even when the provider reports no token usage.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { getCodeVersion, __setCodeVersionForTesting } from "../src/version.js";

test("getCodeVersion: resolves to a non-empty string (hex SHA or the unknown fallback)", () => {
	__setCodeVersionForTesting(null); // reset cache → trigger real resolution
	const v = getCodeVersion();
	assert.equal(typeof v, "string");
	assert.ok(v.length > 0, "must resolve to a non-empty string");
	// Either a real short SHA (hex, 4-40 chars) or "unknown" when git is absent.
	assert.ok(/^[0-9a-f]{4,40}$/i.test(v) || v === "unknown", `unexpected version: ${v}`);
});

test("getCodeVersion: caches the resolved value across calls", () => {
	__setCodeVersionForTesting(null);
	const first = getCodeVersion();
	const second = getCodeVersion();
	assert.equal(first, second, "cached value is returned on the second call");
});

test("__setCodeVersionForTesting: overrides the cached version", () => {
	__setCodeVersionForTesting("deadbeef");
	assert.equal(getCodeVersion(), "deadbeef");
	__setCodeVersionForTesting(null); // restore real resolution for any later tests
});
