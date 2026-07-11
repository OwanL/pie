import test from "node:test";
import assert from "node:assert/strict";
import { ChildLifecycle, DEFAULT_LIVENESS_CONFIG } from "../src/lifecycle.js";

function config(overrides: Partial<typeof DEFAULT_LIVENESS_CONFIG> = {}) {
	return { ...DEFAULT_LIVENESS_CONFIG, ...overrides };
}

test("ChildLifecycle renews the current phase lease on credible progress", () => {
	let now = 0;
	const lifecycle = new ChildLifecycle("attempt-1", config({ streamIdleMs: 100 }), () => now);
	lifecycle.transition("streaming");
	now = 90;
	assert.equal(lifecycle.checkLease(), undefined);
	lifecycle.progress({ type: "text-delta" });
	now = 180;
	assert.equal(lifecycle.checkLease(), undefined);
	now = 191;
	assert.equal(lifecycle.checkLease()?.phase, "streaming");
});

test("ChildLifecycle publishes phase, detail, timing, and generous inactivity budget", () => {
	let now = 1_000;
	const snapshots: Array<{ phase: string; detail?: string; phaseStartedAt: number; lastProgressAt: number; budgetMs?: number }> = [];
	const lifecycle = new ChildLifecycle(
		"attempt-status",
		config({ firstTokenMs: 300_000 }),
		() => now,
		(snapshot) => snapshots.push(snapshot),
	);
	lifecycle.transition("waiting_provider", { type: "prompt-dispatched", description: "waiting for provider response" });
	now = 2_500;
	lifecycle.progress({ type: "heartbeat" });
	assert.deepEqual(snapshots.at(-1), {
		phase: "waiting_provider",
		detail: "waiting for provider response",
		phaseStartedAt: 1_000,
		lastProgressAt: 2_500,
		budgetMs: 300_000,
	});
});

test("ChildLifecycle terminal compare-and-set ignores late progress and transitions", () => {
	let releases = 0;
	const lifecycle = new ChildLifecycle("attempt-2", config());
	lifecycle.setRelease(() => { releases++; });
	assert.equal(lifecycle.cancel("stop"), true);
	assert.equal(lifecycle.fail(new Error("late")), false);
	assert.equal(lifecycle.transition("streaming"), false);
	lifecycle.progress({ type: "late-delta" });
	assert.equal(lifecycle.phase, "cancelled");
	assert.equal(releases, 1);
});
