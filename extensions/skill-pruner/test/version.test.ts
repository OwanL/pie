/**
 * Unit tests for the code-version tag stamped onto every pruning decision.
 *
 * `getCodeVersion()` resolves the repo HEAD short SHA lazily and caches it,
 * so analytics can split pruning runs into cohorts (e.g. before/after a
 * prompt-compaction change) even when the provider reports no token usage.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { getCodeVersion, __setCodeVersionForTesting, prewarmCodeVersion, __peekCodeVersionCacheForTesting } from "../src/version.js";

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

test("prewarmCodeVersion: asynchronously populates the cache without blocking registration", async () => {
	__setCodeVersionForTesting(null); // reset → cache empty
	assert.equal(__peekCodeVersionCacheForTesting(), undefined);
	// Fire-and-forget: returns immediately (no synchronous subprocess on the
	// registration path). The async `exec` resolves the SHA off the event loop.
	prewarmCodeVersion();
	// Poll the cache directly (NOT getCodeVersion, which would trigger the sync
	// fallback and defeat the point) until the pre-warm lands.
	const deadline = Date.now() + 3_000;
	while (__peekCodeVersionCacheForTesting() === undefined && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 10));
	}
	const peeked = __peekCodeVersionCacheForTesting();
	assert.ok(peeked !== undefined, "pre-warm must populate the cache asynchronously");
	assert.ok(/^[0-9a-f]{4,40}$/i.test(peeked!) || peeked === "unknown", `unexpected version: ${peeked}`);
	// getCodeVersion now returns the pre-warmed value with no sync subprocess.
	assert.equal(getCodeVersion(), peeked);
	__setCodeVersionForTesting(null);
});

test("prewarmCodeVersion: no-op when the cache is already populated", async () => {
	__setCodeVersionForTesting("deadbeef");
	prewarmCodeVersion(); // cached is set → must not spawn an exec
	assert.equal(__peekCodeVersionCacheForTesting(), "deadbeef");
	// Give the event loop a tick to prove no async exec overwrites the override.
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(__peekCodeVersionCacheForTesting(), "deadbeef");
	assert.equal(getCodeVersion(), "deadbeef");
	__setCodeVersionForTesting(null);
});
