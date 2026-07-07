/**
 * SIGINT listener hygiene — pins the fix for the `MaxListenersExceededWarning:
 * N SIGINT listeners added to [process]` that pie's host emitted whenever a
 * subagent-heavy turn ran (3+ parallel scouts → 11+ listeners → warning).
 *
 * Root cause (confirmed via local_utils/repro-sigint-leak.mjs): the pi SDK's
 * `DefaultResourceLoader.reload()` pulls in transitive provider HTTP-handler
 * code (`@smithy/node-http-handler` via the AWS SDK dep tree, reached while
 * loading provider/model metadata) that registers a per-loader exit-signal
 * cleanup closure shaped like `() => { for (const p of pools.values()) p.dispose(); }`.
 * The SDK never exposes a handle to remove it and `DefaultResourceLoader` has
 * no `destroy()`, so each subagent session leaks one such closure on SIGINT
 * (and SIGTERM) — never removed. `runner.ts` now snapshots exit-signal
 * listeners before `reload()` and reclaims the orphaned pool-dispose closures
 * on session teardown, keeping the host's listener count bounded.
 *
 * This test simulates the leak with a mock SDK whose `DefaultResourceLoader.reload()`
 * registers the exact orphaned closure, then asserts:
 *  - after a subagent run completes, the leaked closure is removed (count returns to baseline);
 *  - the reclaim is surgical: an UNRELATED SIGINT listener is preserved.
 */

import test, { after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execute } from "../src/execute.js";

// ---------------------------------------------------------------------------
// Mock SDK that SIMULATES the upstream SIGINT leak on resourceLoader.reload()
// ---------------------------------------------------------------------------

const MOCK_SDK_SOURCE = [
	"import process from 'node:process';",
	"// A stand-in for the leaked smithy/aws-sdk pool map. The closure captures",
	"// it by reference, exactly like the real upstream leak.",
	"const pools = new Map();",
	"export class DefaultResourceLoader {",
	"  constructor(a){ this.a = a; }",
	"  async reload(){",
	"    // Mirror the upstream leak: register an orphaned pool-dispose cleanup",
	"    // on SIGINT that is NEVER removed. This is the exact shape that",
	"    // reproduces the MaxListenersExceededWarning in the real host.",
	"    process.on('SIGINT', () => { for (const p of pools.values()) p.dispose(); });",
	"    process.on('SIGTERM', () => { for (const p of pools.values()) p.dispose(); });",
	"  }",
	"}",
	"export const SessionManager = { inMemory(cwd){ return { cwd: cwd }; } };",
	"export function getAgentDir(){ return '.'; }",
	"export async function createAgentSession(args){",
	"  const session = {",
	"    agent: { state: { model: { id: 'session-model' } } },",
	"    extensionRunner: { setUIContext(){} },",
	"    subscribe(cb){ return () => {}; },",
	"    // Prompt completes immediately so execute() returns promptly.",
	"    async prompt(){ const b = globalThis.__MOCK_SDK_BEHAVIOR__; if (b && b.onPrompt) { await b.onPrompt(); } },",
	"    async abort(){},",
	"    dispose(){},",
	"  };",
	"  return { session: session };",
	"}",
].join("\n");

const mockDir = mkdtempSync(path.join(tmpdir(), "sigint-leak-mock-sdk-"));
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
if (!(globalThis as { __PIE_SIGINT_LEAK_HOOK_REGISTERED__?: boolean }).__PIE_SIGINT_LEAK_HOOK_REGISTERED__) {
	(globalThis as { __PIE_SIGINT_LEAK_HOOK_REGISTERED__?: boolean }).__PIE_SIGINT_LEAK_HOOK_REGISTERED__ = true;
	Module.register(pathToFileURL(hookPath));
}

// ---------------------------------------------------------------------------
// Agent fixture
// ---------------------------------------------------------------------------

const agentDir = mkdtempSync(path.join(tmpdir(), "sigint-leak-agents-"));
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
	for (const k of ENV_KEYS) snapshot[k] = process.env[k];
	process.env.PIE_SUBAGENT_ALWAYS_PARENT_MODEL = "1";
	process.env.PIE_SUBAGENT_MAX_INFLIGHT = "8";
	process.env.PIE_SUBAGENT_MAX_CONCURRENCY = "4";
	process.env.PIE_SUBAGENT_MAX_PARALLEL_TASKS = "8";
	// Per-prompt + settlement nets OFF so the only path under test is the
	// session completing promptly (the leak/reclaim lifecycle around reload).
	process.env.PIE_SUBAGENT_TIMEOUT_MS = "0";
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "0";
	process.env.PIE_SUBAGENT_SETTLEMENT_GRACE_MS = "0";
	delete process.env.PI_SUBAGENT_TIMEOUT_MS;
	delete process.env.PI_SUBAGENT_DEPTH;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
test.after(() => {
	for (const k of ENV_KEYS) {
		if (snapshot[k] === undefined) delete process.env[k];
		else process.env[k] = snapshot[k]!;
	}
});
after(() => {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(mockDir, { recursive: true, force: true });
});

function makeCtx(): unknown {
	return {
		cwd: agentDir,
		hasUI: false,
		model: { id: "active-model", provider: "test" },
		modelRegistry: {
			getAvailable: () => [{ id: "active-model", provider: "test" }],
			getAll: () => [{ id: "active-model", provider: "test" }],
			find: (_p: string, id: string) =>
				id === "active-model" ? { id: "active-model", provider: "test" } : undefined,
		},
	};
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A sentinel SIGINT listener we own, so we can assert the reclaim is
 *  surgical and does NOT remove unrelated listeners. */
function sentinel(): () => void {
	const fn = (): void => { /* sentinel */ };
	process.on("SIGINT", fn);
	return fn;
}

beforeEach(() => {
	(globalThis as { __MOCK_SDK_BEHAVIOR__?: unknown }).__MOCK_SDK_BEHAVIOR__ = undefined;
});
afterEach(() => {
	(globalThis as { __MOCK_SDK_BEHAVIOR__?: unknown }).__MOCK_SDK_BEHAVIOR__ = undefined;
});

// ---------------------------------------------------------------------------

test("runSingleAgent reclaims the orphaned SIGINT pool-dispose closure leaked by DefaultResourceLoader.reload() (root-cause fix for the MaxListenersExceededWarning)", async () => {
	const before = process.listenerCount("SIGINT");
	const sentinelFn = sentinel();
	const baseline = process.listenerCount("SIGINT"); // before + 1 sentinel

	// Prompt resolves immediately → session completes → teardown + reclaim run.
	(globalThis as { __MOCK_SDK_BEHAVIOR__?: { onPrompt: () => Promise<void> } }).__MOCK_SDK_BEHAVIOR__ = {
		onPrompt: async () => { /* complete */ },
	};

	const controller = new AbortController(); // never aborted
	await execute(
		"tool-sigint-leak",
		{ agent: "worker", task: "do work" } as never,
		controller.signal,
		() => undefined,
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
	);
	// Yield once so the runner's `finally { reclaimOrphanedSignalListeners }` is
	// guaranteed to have run (execute resolves AFTER its own finally, but be safe).
	await sleep(20);

	const after = process.listenerCount("SIGINT");
	// Leaked SIGINT closure MUST be gone: count returns to baseline (before + sentinel).
	assert.equal(
		after,
		baseline,
		`leaked SIGINT pool-dispose closure was NOT reclaimed: before=${before}, baseline=${baseline}, after=${after}. ` +
			`This regression reintroduces the MaxListenersExceededWarning under parallel subagent loads.`,
	);

	// Reclaim must be surgical: our sentinel listener survives.
	assert.ok(
		process.listeners("SIGINT").includes(sentinelFn),
		"surgical reclaim: an UNRELATED SIGINT listener (the sentinel) must be preserved",
	);
	process.removeListener("SIGINT", sentinelFn);
});

test("runSingleAgent reclaims orphaned SIGTERM listeners too (the leak fires on every exit signal)", async () => {
	const beforeTerm = process.listenerCount("SIGTERM");

	(globalThis as { __MOCK_SDK_BEHAVIOR__?: { onPrompt: () => Promise<void> } }).__MOCK_SDK_BEHAVIOR__ = {
		onPrompt: async () => { /* complete */ },
	};

	const controller = new AbortController(); // never aborted
	await execute(
		"tool-sigterm-leak",
		{ agent: "worker", task: "do work" } as never,
		controller.signal,
		() => undefined,
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
	);
	await sleep(20);

	const afterTerm = process.listenerCount("SIGTERM");
	assert.equal(
		afterTerm,
		beforeTerm,
		`leaked SIGTERM pool-dispose closure was NOT reclaimed: before=${beforeTerm}, after=${afterTerm}`,
	);
});

test("runSingleAgent reclaims the leaked closure even when the pre-spawn phase aborts (the reload path runs before the abort is observable)", async () => {
	const before = process.listenerCount("SIGINT");

	// Prompt that never runs: abort the parent signal AFTER reload has leaked
	// the listener but BEFORE createSession/prompt settle. The pre-spawn catch
	// path returns early; it must ALSO reclaim.
	const controller = new AbortController();
	(globalThis as { __MOCK_SDK_BEHAVIOR__?: { onPrompt: () => Promise<void> } }).__MOCK_SDK_BEHAVIOR__ = {
		// onPrompt never resolves — we rely on the parent abort to escape.
		onPrompt: async () => { await new Promise(() => {}); },
	};

	const execP = execute(
		"tool-presigint-leak",
		{ agent: "worker", task: "do work" } as never,
		controller.signal,
		() => undefined,
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
	);
	// Give reload time to run (and leak), then abort to escape the hung prompt.
	await sleep(50);
	controller.abort();
	await execP.catch(() => {});
	await sleep(20);

	const after = process.listenerCount("SIGINT");
	assert.equal(
		after,
		before,
		`pre-spawn-abort path leaked SIGINT closure: before=${before}, after=${after}`,
	);
});
