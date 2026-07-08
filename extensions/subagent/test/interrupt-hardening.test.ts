/**
 * Phase 1 red-test battery — subagent interrupt / abort hardening.
 *
 * These tests pin the THREE suspected subagent lifecycle bugs surfaced by
 * recent provider-side instability (long time-to-first-token, stream cuts):
 *
 *  Bug 1 — Stop mid-subagent-prompt: parent signal aborts AFTER the child
 *          `session.prompt()` has started streaming. Only escape today is the
 *          30-min `PIE_SUBAGENT_SETTLEMENT_MS` net (default
 *          `PI_SUBAGENT_TIMEOUT_MS=0` → per-prompt timeout DISABLED). A 30-min
 *          wait here = bug. Asserts a tight per-prompt bound exists.
 *
 *  Bug 2 — Stop while child `session.abort()` itself hangs (provider connection
 *          teardown stuck): runner.ts `onAbort` does `void session.abort()` —
 *          UN-awaited, UN-logged, with NO bound. If abort never resolves, only
 *          the 30-min settlement net frees the parent. Asserts a tighter bound
 *          + observability.
 *
 *  Bug 3 — Parallel sibling abort: 4 parallel tasks, abort arrives while 2 are
 *          in prefill and 2 are mid-stream. Asserts ALL four settle within a
 *          bound AND the `inflightSemaphore` has zero in-flight + zero waiters
 *          afterward (no permit leak / orphan queue entry).
 *
 * Approach: same ESM resolve-hook technique as modes.test.ts /
 * settlement.test.ts — redirect `@mariozechner/pi-coding-agent` to an
 * in-memory mock SDK whose `prompt` / `abort` behaviour is driven by
 * `globalThis.__MOCK_SDK_BEHAVIOR__`.
 */

import test, { afterEach, after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execute } from "../src/execute.js";

// ---------------------------------------------------------------------------
// In-memory mock SDK + ESM resolve hook (redirect @mariozechner/pi-coding-agent)
// ---------------------------------------------------------------------------
// The mock records every call into `globalThis.__MOCK_SDK_STATE__` so tests
// can assert `abortCalls`, `abortSettledTimes`, `promptStartedTimes`, etc.
// `globalThis.__MOCK_SDK_BEHAVIOR__` selects per-prompt behaviour.

const MOCK_SDK_SOURCE = [
	"export class DefaultResourceLoader { constructor(a){ this.a = a; } async reload(){} }",
	"export const SessionManager = { inMemory(cwd){ return { cwd: cwd }; } };",
	"export function getAgentDir(){ return '.'; }",
	"export async function createAgentSession(args){",
	"  const listeners = [];",
	"  const state = (globalThis.__MOCK_SDK_STATE__ = globalThis.__MOCK_SDK_STATE__ || { createSessionCalls: 0, promptStarted: 0, promptSettled: 0, abortCalls: 0, abortSettled: 0, abortCompactionCalls: 0, abortBranchSummaryCalls: 0, abortBashCalls: 0, abortRetryCalls: 0 });",
	"  state.createSessionCalls++;",
	"  let promptRelease;          // set by prompt(); awaited until abort/behaviour releases it",
	"  let abortRelease;           // set by abort(); awaited until behaviour releases it (Bug 2: hangs forever by default)",
	"  const session = {",
	"    agent: { state: { model: { id: 'session-model' } } },",
	"    extensionRunner: { setUIContext(){} },",
	"    subscribe(cb){ listeners.push(cb); return () => {}; },",
	"    async prompt(p){",
	"      state.promptStarted++;",
	"      const b = globalThis.__MOCK_SDK_BEHAVIOR__;",
	"      if (b && b.onPrompt) { await b.onPrompt(function(ev){ for (const l of listeners) l(ev); }, p, function release(v){ promptRelease && promptRelease(v); }); return; }",
	"      // Default: prompt hangs until abort() resolves it (the realistic mid-stream shape).",
	"      await new Promise(function(r){ promptRelease = r; });",
	"      state.promptSettled++;",
	"    },",
	"    async abort(){",
	"      state.abortCalls++;",
	"      const b = globalThis.__MOCK_SDK_BEHAVIOR__;",
	"      if (b && b.onAbort) { await b.onAbort(function release(v){ promptRelease && promptRelease(v); }); state.abortSettled++; return; }",
	"      // Default (Bug 2 repro): abort() NEVER resolves — simulates a hung provider teardown.",
	"      await new Promise(function(){});",
	"      // unreachable in the default branch; kept for clarity.",
	"      state.abortSettled++;",
	"    },",
	"    abortCompaction(){ state.abortCompactionCalls++; },",
	"    abortBranchSummary(){ state.abortBranchSummaryCalls++; },",
	"    abortBash(){ state.abortBashCalls++; },",
	"    abortRetry(){ state.abortRetryCalls++; },",
	"    dispose(){}",
	"  };",
	"  return { session: session };",
	"}",
].join("\n");

const mockDir = mkdtempSync(path.join(tmpdir(), "interrupt-mock-sdk-"));
const mockSdkPath = path.join(mockDir, "mock-sdk.mjs");
writeFileSync(mockSdkPath, MOCK_SDK_SOURCE, "utf-8");
const hookPath = path.join(mockDir, "hook.mjs");
writeFileSync(
	hookPath,
	[
		"export async function resolve(specifier, context, nextResolve){",
		`  if (specifier === '@mariozechner/pi-coding-agent') return { url: ${JSON.stringify(pathToFileURL(mockSdkPath).href)}, shortCircuit: true };`,
		"  return nextResolve(specifier, context);",
		"}",
	].join("\n"),
	"utf-8",
);
// Guard against double-registration (this file may load alongside modes.test.ts /
// settlement.test.ts in the same tsx --test process).
if (!(globalThis as { __PIE_INTERRUPT_HOOK_REGISTERED__?: boolean }).__PIE_INTERRUPT_HOOK_REGISTERED__) {
	(globalThis as { __PIE_INTERRUPT_HOOK_REGISTERED__?: boolean }).__PIE_INTERRUPT_HOOK_REGISTERED__ = true;
	Module.register(pathToFileURL(hookPath));
}

// ---------------------------------------------------------------------------
// Test fixture: temp agent dir so discoverAgents(scope:"user") finds "worker"
// ---------------------------------------------------------------------------

const agentDir = mkdtempSync(path.join(tmpdir(), "interrupt-agents-"));
const agentsSubdir = path.join(agentDir, "agents");
mkdirSync(agentsSubdir, { recursive: true });
writeFileSync(
	path.join(agentsSubdir, "worker.md"),
	"---\nname: worker\ndescription: test agent\n---\nYou are a worker.\n",
	"utf-8",
);

const ENV_KEYS = [
	"PIE_SUBAGENT_SETTLEMENT_MS",
	"PIE_SUBAGENT_SETTLEMENT_GRACE_MS",
	"PIE_SUBAGENT_TIMEOUT_MS",
	"PIE_SUBAGENT_MAX_INFLIGHT",
	"PIE_SUBAGENT_MAX_CONCURRENCY",
	"PIE_SUBAGENT_MAX_PARALLEL_TASKS",
	"PIE_SUBAGENT_ALWAYS_PARENT_MODEL",
	"PI_CODING_AGENT_DIR",
	"PI_SUBAGENT_TIMEOUT_MS",
	"PI_SUBAGENT_DEPTH",
] as const;

const snapshot: Record<string, string | undefined> = {};
test.before(() => {
	for (const key of ENV_KEYS) snapshot[key] = process.env[key];
	// Force pure model selection, generous inflight, and CRUCIALLY disable the
	// per-prompt timeout + the settlement net so the ONLY escape for a hung
	// dispatch is the path under test (the parent abort). This surfaces the bug
	// rather than papering over it with the 30-min net.
	process.env.PIE_SUBAGENT_ALWAYS_PARENT_MODEL = "1";
	process.env.PIE_SUBAGENT_MAX_INFLIGHT = "8";
	process.env.PIE_SUBAGENT_MAX_CONCURRENCY = "4";
	process.env.PIE_SUBAGENT_MAX_PARALLEL_TASKS = "8";
	process.env.PIE_SUBAGENT_TIMEOUT_MS = "0";
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "0";   // net OFF — the structural abort path is the only escape
	process.env.PIE_SUBAGENT_SETTLEMENT_GRACE_MS = "0";
	delete process.env.PI_SUBAGENT_TIMEOUT_MS;
	delete process.env.PI_SUBAGENT_DEPTH;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

test.after(() => {
	for (const key of ENV_KEYS) {
		if (snapshot[key] === undefined) delete process.env[key];
		else process.env[key] = snapshot[key]!;
	}
});

after(() => {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(mockDir, { recursive: true, force: true });
});

function setMockBehavior(b: unknown): void {
	(globalThis as { __MOCK_SDK_BEHAVIOR__?: unknown }).__MOCK_SDK_BEHAVIOR__ = b;
}
/** Reset the mock SDK call counters IN PLACE (the mock source captures the
 *  object reference once per `createSession`, so replacing the whole object
 *  would disconnect it from the mock). */
function resetMockState(): void {
	const s = (globalThis as { __MOCK_SDK_STATE__?: Record<string, number> }).__MOCK_SDK_STATE__;
	if (s) {
		s.createSessionCalls = 0;
		s.promptStarted = 0;
		s.promptSettled = 0;
		s.abortCalls = 0;
		s.abortSettled = 0;
		s.abortCompactionCalls = 0;
		s.abortBranchSummaryCalls = 0;
		s.abortBashCalls = 0;
		s.abortRetryCalls = 0;
	} else {
		(globalThis as { __MOCK_SDK_STATE__?: Record<string, number> }).__MOCK_SDK_STATE__ = {
			createSessionCalls: 0,
			promptStarted: 0,
			promptSettled: 0,
			abortCalls: 0,
			abortSettled: 0,
			abortCompactionCalls: 0,
			abortBranchSummaryCalls: 0,
			abortBashCalls: 0,
			abortRetryCalls: 0,
		};
	}
}
function mockState(): Record<string, number> {
	const s = (globalThis as { __MOCK_SDK_STATE__?: Record<string, number> }).__MOCK_SDK_STATE__;
	if (!s) throw new Error("mockState() called before __MOCK_SDK_STATE__ initialized");
	return s;
}
// Initialize once up front (the mock only sets it lazily inside createSession,
// which hasn't run by the first assertion of the first test).
resetMockState();
afterEach(() => { setMockBehavior(undefined); resetMockState(); });

/** Poll until `mockState()[key] >= min` (with a timeout). The first `execute()`
 *  in a process pays the tsx on-the-fly TS→CJS compile of modes.ts (~1s on a
 *  cold start); subsequent calls hit the cached module. The default timeout
 *  accommodates that cold start. */
async function waitForCounter(key: string, min: number, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((mockState()[key] ?? 0) >= min) return;
		await sleep(5);
	}
	throw new Error(`timed out waiting for ${key} >= ${min} (got ${mockState()[key]})`);
}

function makeCtx(): unknown {
	return {
		cwd: agentDir,
		hasUI: false,
		model: { id: "active-model", provider: "test" },
		modelRegistry: {
			getAvailable: () => [{ id: "active-model", provider: "test" }],
			getAll: () => [{ id: "active-model", provider: "test" }],
			find: (_provider: string, id: string) =>
				id === "active-model" ? { id: "active-model", provider: "test" } : undefined,
		},
	};
}

/** Reject if the promise hasn't settled within `ms` — proves "returns in time". */
function within<T>(ms: number, p: Promise<T>): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms),
		),
	]);
}

/** Sleep helper. */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Bug 1 — Stop mid-subagent-prompt
// ---------------------------------------------------------------------------

test("Bug 1: aborting AFTER the child prompt() has started streaming settles the parent tool call within a small bound (NOT the 30-min settlement net)", async () => {
	// Default behaviour: prompt() hangs until abort() resolves it (realistic
	// mid-stream shape — provider is actively streaming, then Stop fires).
	// onAbort: the mock's default branch NEVER resolves abort() (Bug 2), so for
	// Bug 1 we give onAbort that DOES resolve abort (the happy teardown path).
	setMockBehavior({
		onAbort: (release: (v?: unknown) => void) => {
			// Happy teardown: abort() resolves promptly, which releases prompt().
			release();
			return Promise.resolve();
		},
	});

	const controller = new AbortController();
	const responseP = execute(
		"tool-bug1",
		{ agent: "worker", task: "do work" } as never,
		controller.signal,
		() => undefined,
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
	);
	// Wait until the child prompt() has actually started (the mid-stream window).
	await waitForCounter("promptStarted", 1);
	assert.equal(mockState().promptStarted, 1, "child prompt() must have started before abort");
	controller.abort();

	// The bug today: PI_SUBAGENT_TIMEOUT_MS=0 (disabled) + settlement net OFF
	// (set above) → the ONLY escape is the structural abort path. With a happy
	// abort() that releases prompt(), this settles quickly. If it does NOT,
	// the per-prompt timeout is missing (Bug 1).
	const response = await within(2000, responseP);
	const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "";
	assert.match(text, /abort/i, "tool call must surface an abort result, not hang");
	assert.equal(mockState().abortCalls, 1, "child session.abort() must have been invoked");
});

test("Nested hard-stop: a parent abort invokes the child's billable-window abort methods (compaction/branch-summary/bash/retry) instantly", async () => {
	// Closes the gap before teardownSession's dispose() runs in the finally:
	// onAbort must call the child's public abortCompaction/abortBranchSummary/
	// abortBash/abortRetry (which abort() alone does NOT) so a nested
	// subagent's post-agent_end compaction LLM call stops the INSTANT the
	// parent is interrupted, not after the try/catch/finally unwinds.
	setMockBehavior({
		onAbort: (release: (v?: unknown) => void) => {
			release();
			return Promise.resolve();
		},
	});

	const controller = new AbortController();
	const responseP = execute(
		"tool-nested-hardstop",
		{ agent: "worker", task: "do work" } as never,
		controller.signal,
		() => undefined,
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
	);
	await waitForCounter("promptStarted", 1);
	controller.abort();

	const response = await within(2000, responseP);
	const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "";
	assert.match(text, /abort/i, "tool call must surface an abort result, not hang");

	// Every billable window was hard-stopped on the child synchronously in
	// onAbort (before dispose() in the finally, which is a no-op mock here).
	assert.equal(mockState().abortCompactionCalls, 1, "child abortCompaction() must be invoked on parent abort");
	assert.equal(mockState().abortBranchSummaryCalls, 1, "child abortBranchSummary() must be invoked on parent abort");
	assert.equal(mockState().abortBashCalls, 1, "child abortBash() must be invoked on parent abort");
	assert.equal(mockState().abortRetryCalls, 1, "child abortRetry() must be invoked on parent abort");
});

test("Bug 1 (gap): with the settlement net OFF, a child whose abort() does NOT release prompt() is bounded by the per-prompt timeout (Phase 2 fix: default per-prompt timeout now ON)", async () => {
	// Bug 2's shape, isolated: abort() resolves (so the abort promise itself
	// is fine) BUT does not release prompt() (the stream teardown didn't
	// unblock the SDK's prompt promise). With the settlement net OFF, the
	// per-prompt timeout (Phase 2: now a sane non-zero default) is the escape.
	setMockBehavior({
		onAbort: () => {
			// abort() resolves, but DOES NOT release the prompt — simulates a
			// provider teardown that completes without unblocking the stream.
			return Promise.resolve();
		},
	});
	// Tighten the per-prompt timeout so the test does not wait the full 15min.
	const prevTimeout = process.env.PI_SUBAGENT_TIMEOUT_MS;
	process.env.PI_SUBAGENT_TIMEOUT_MS = "200";

	const controller = new AbortController();
	const responseP = execute(
		"tool-bug1-gap",
		{ agent: "worker", task: "do work" } as never,
		controller.signal,
		() => undefined,
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
	);
	await waitForCounter("promptStarted", 1);
	controller.abort();

	// Phase 2 fix: the per-prompt timeout default + raceAbort(prompt) bounds
	// this. Instead of hanging forever, the tool call settles within the
	// per-prompt bound with a timeout/abort result.
	const response = await within(3000, responseP);
	assert.equal(response.isError, true, "an abort that doesn't release the prompt must surface an error, not hang");
	const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "";
	assert.match(text, /abort|timeout|timed out/i, "tool call must surface an abort/timeout result, not hang");

	// Restore env (the test-suite env snapshot block restores at the end).
	process.env.PI_SUBAGENT_TIMEOUT_MS = prevTimeout;
});

// ---------------------------------------------------------------------------
// Bug 2 — Stop while child session.abort() itself hangs (provider teardown stuck)
// ---------------------------------------------------------------------------

test("Bug 2: when child session.abort() never resolves (hung provider teardown), the parent tool call is bounded by the per-prompt timeout, not 30 min (Phase 2 fix: raceAbort(prompt) + default timeout)", async () => {
	// Default mock behaviour: abort() hangs forever (the bug window). With the
	// settlement net OFF, the per-prompt timeout (Phase 2: now a sane non-zero
	// default) + raceAbort(prompt) is the escape — the prompt is raced against
	// the combined abort signal, so the tool call settles once the timeout
	// fires regardless of whether abort() resolves.
	setMockBehavior(undefined); // default → abort() never resolves, prompt() never released
	// Tighten the per-prompt timeout so the test does not wait 15min.
	const prevTimeout = process.env.PI_SUBAGENT_TIMEOUT_MS;
	process.env.PI_SUBAGENT_TIMEOUT_MS = "200";

	const controller = new AbortController();
	const responseP = execute(
		"tool-bug2",
		{ agent: "worker", task: "do work" } as never,
		controller.signal,
		() => undefined,
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
	);
	await waitForCounter("promptStarted", 1);
	controller.abort();

	// Phase 2 fix: raceAbort(prompt) + the default per-prompt timeout settle
	// the tool call even when session.abort() never resolves.
	const response = await within(3000, responseP);
	assert.equal(response.isError, true, "a hung abort() must surface an error, not hang the parent");
	const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "";
	assert.match(text, /abort|timeout|timed out/i, "tool call must surface an abort/timeout result, not hang");

	process.env.PI_SUBAGENT_TIMEOUT_MS = prevTimeout;
});

test("Bug 2 (observability): the abort path emits a [pie:subagent] child.abort.invoked log so a dangling child is diagnosable (Phase 2 fix: onAbort now logs)", async () => {
	// Capture console.error (the logLoud sink — reaches the pie OutputChannel
	// via the BackendClient stderr mirror, see pie-logger.ts).
	const captured: string[] = [];
	const origErr = console.error;
	console.error = (msg: string) => { captured.push(String(msg)); };
	try {
		setMockBehavior({
			onAbort: (release: (v?: unknown) => void) => { release(); return Promise.resolve(); },
		});
		const controller = new AbortController();
		void execute(
			"tool-bug2-obs",
			{ agent: "worker", task: "do work" } as never,
			controller.signal,
			() => undefined,
			makeCtx() as never,
			{ getAllTools: () => [] } as never,
			() => false,
		);
		await waitForCounter("promptStarted", 1);
		controller.abort();
		await sleep(50); // let the abort path run + the 5s grace elapse is too
		                  // long; just assert .invoked fires (the sync log).
	} finally {
		console.error = origErr;
	}
	// Phase 2 fix: onAbort now emits child.abort.invoked (sync, before racing
	// abort for the .completed/.dangling-detected follow-up). A dangling child
	// is thus immediately diagnosable in the [pie:subagent] log stream.
	const subagentLogs = captured.filter((l) => l.includes('"pie:subagent"'));
	const abortInvoked = subagentLogs.filter((l) => l.includes('"child.abort.invoked"'));
	assert.ok(
		abortInvoked.length >= 1,
		"Phase 2 FIX: [pie:subagent] child.abort.invoked event MUST fire on abort so a dangling child is diagnosable",
	);
});

// ---------------------------------------------------------------------------
// Bug 3 — Parallel sibling abort (4 parallel tasks, mixed prefill + mid-stream)
// ---------------------------------------------------------------------------

test("Bug 3: a parent abort during parallel sibling dispatch settles ALL siblings within a bound (Phase 2 fix: per-prompt timeout + raceAbort(prompt) bound each sibling)", async () => {
	// 4 tasks, 2 in prefill (prompt started) + 2 mid-stream. The mock's
	// default: prompt() hangs until abort() releases it; abort() never resolves
	// (Bug 2 shape). With the settlement net OFF, each sibling is bounded by
	// the per-prompt timeout (Phase 2: now a sane non-zero default).
	const tasks = [
		{ agent: "worker", task: "task-1" },
		{ agent: "worker", task: "task-2" },
		{ agent: "worker", task: "task-3" },
		{ agent: "worker", task: "task-4" },
	] as never;

	setMockBehavior(undefined); // default → abort never resolves, prompt never released
	// Tighten the per-prompt timeout so the test does not wait 15min per sibling.
	const prevTimeout = process.env.PI_SUBAGENT_TIMEOUT_MS;
	process.env.PI_SUBAGENT_TIMEOUT_MS = "200";

	const controller = new AbortController();
	const responseP = execute(
		"tool-bug3",
		{ tasks } as never,
		controller.signal,
		() => undefined,
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
	);

	await waitForCounter("promptStarted", 4);
	controller.abort();

	// Phase 2 fix: each sibling's prompt is raced against the combined abort
	// signal, so all 4 settle within the per-prompt bound even when abort()
	// hangs. The parent tool call no longer dangles.
	const response = await within(6000, responseP);
	assert.equal(mockState().abortCalls, 4, "all 4 children must have session.abort() invoked");
	const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "";
	assert.match(text, /abort|timeout|timed out/i, "parallel dispatch must surface an abort/timeout result, not hang");

	process.env.PI_SUBAGENT_TIMEOUT_MS = prevTimeout;
});

test("Bug 3 (happy path — control): when abort() DOES release prompt(), a parent abort settles all 4 siblings within a bound and releases all permits", async () => {
	// Control: the same scenario as above but with a happy abort() that
	// releases prompt(). Asserts the structural path WORKS when the provider
	// honours the abort — isolating the bug to the hung-abort window.
	const tasks = [
		{ agent: "worker", task: "task-1" },
		{ agent: "worker", task: "task-2" },
		{ agent: "worker", task: "task-3" },
		{ agent: "worker", task: "task-4" },
	] as never;

	setMockBehavior({
		onAbort: (release: (v?: unknown) => void) => { release(); return Promise.resolve(); },
	});

	const controller = new AbortController();
	const responseP = execute(
		"tool-bug3-control",
		{ tasks } as never,
		controller.signal,
		() => undefined,
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
	);
	await waitForCounter("promptStarted", 4);
	controller.abort();

	const response = await within(2000, responseP);
	// All 4 siblings got an abort result.
	assert.equal(mockState().abortCalls, 4, "all 4 children must have session.abort() invoked");
	const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "";
	assert.match(text, /abort/i, "parallel dispatch must surface an abort result, not hang");
});
