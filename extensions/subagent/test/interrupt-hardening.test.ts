/**
 * Phase 1 red-test battery — subagent interrupt / abort hardening.
 *
 * These tests pin the THREE suspected subagent lifecycle bugs surfaced by
 * recent provider-side instability (long time-to-first-token, stream cuts):
 *
 *  Bug 1 — Stop mid-subagent-prompt: parent signal aborts AFTER the child
 *          `session.prompt()` has started streaming. Settlement must be owned
 *          by the local prompt/abort race, not delayed until the outer renewable
 *          inactivity net. Asserts a tight cancellation bound exists.
 *
 *  Bug 2 — Stop while child `session.abort()` itself hangs (provider connection
 *          teardown stuck). Remote teardown is advisory: it must be observed and
 *          detached without owning parent settlement.
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
	// rather than papering over it with the outer inactivity net.
	process.env.PIE_SUBAGENT_ALWAYS_PARENT_MODEL = "1";
	process.env.PIE_SUBAGENT_MAX_INFLIGHT = "8";
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
 *  cold start); subsequent calls hit the cached module. Under the parallel
 *  fast suite the same cold compile can take far longer on a CPU-saturated
 *  machine, so the default timeout is a generous failure bound (the counter
 *  increments on its own; this only caps a never-started child). */
async function waitForCounter(key: string, min: number, timeoutMs = 15000): Promise<void> {
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

test("Bug 1: aborting after child prompt() starts settles locally without waiting for the outer inactivity net", async () => {
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
	const response = await within(5000, responseP);
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

	const response = await within(5000, responseP);
	const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "";
	assert.match(text, /abort/i, "tool call must surface an abort result, not hang");

	// Every billable window was hard-stopped on the child synchronously in
	// onAbort (before dispose() in the finally, which is a no-op mock here).
	assert.equal(mockState().abortCompactionCalls, 1, "child abortCompaction() must be invoked on parent abort");
	assert.equal(mockState().abortBranchSummaryCalls, 1, "child abortBranchSummary() must be invoked on parent abort");
	assert.equal(mockState().abortBashCalls, 1, "child abortBash() must be invoked on parent abort");
	assert.equal(mockState().abortRetryCalls, 1, "child abortRetry() must be invoked on parent abort");
});

test("Bug 1 gap: parent abort settles even when child abort() does not release prompt()", async () => {
	// Bug 2's shape, isolated: abort() resolves (so the abort promise itself
	// is fine) BUT does not release prompt() (the stream teardown didn't
	// unblock the SDK's prompt promise). The local prompt race must still own
	// parent settlement with the outer net disabled.
	setMockBehavior({
		onAbort: () => {
			// abort() resolves, but DOES NOT release the prompt — simulates a
			// provider teardown that completes without unblocking the stream.
			return Promise.resolve();
		},
	});
	// Keep an explicit containment ceiling as additional test protection.
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

	// The prompt is raced directly against parent cancellation, so remote
	// teardown cannot keep the tool call open.
	const response = await within(5000, responseP);
	assert.equal(response.isError, true, "an abort that doesn't release the prompt must surface an error, not hang");
	const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "";
	assert.match(text, /abort|timeout|timed out/i, "tool call must surface an abort/timeout result, not hang");

	// Restore env (the test-suite env snapshot block restores at the end).
	process.env.PI_SUBAGENT_TIMEOUT_MS = prevTimeout;
});

// ---------------------------------------------------------------------------
// Bug 2 — Stop while child session.abort() itself hangs (provider teardown stuck)
// ---------------------------------------------------------------------------

test("Bug 2: a hung child session.abort() cannot own parent settlement", async () => {
	// Default mock behaviour: abort() hangs forever (the bug window). With the
	// outer inactivity net OFF, the prompt is raced directly against the parent
	// signal, so the tool call settles regardless of whether abort() resolves.
	setMockBehavior(undefined); // default → abort() never resolves, prompt() never released
	// Keep an explicit containment ceiling as additional test protection.
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

	// Parent cancellation settles the local prompt race even when remote
	// session.abort() never resolves.
	const response = await within(5000, responseP);
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
