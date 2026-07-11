/**
 * Settlement-net tests (Slice B): `execute()` MUST always return within
 * `PIE_SUBAGENT_SETTLEMENT_MS`, even if a downstream phase (here: a prompt that
 * never resolves and ignores abort) hangs forever. This is the last-resort net
 * that guarantees the parent session can never dangle — the structural fixes
 * (abort propagation, abortable concurrency) are the primary hang defence; the
 * net exists so a future bug reintroducing an unbounded wait still can't hang
 * the parent.
 *
 * Approach: register an ESM resolve hook (same technique as modes.test.ts) that
 * redirects `@mariozechner/pi-coding-agent` to an in-memory mock whose `prompt`
 * reads `globalThis.__MOCK_SDK_BEHAVIOR__`. A never-resolving `onPrompt`
 * simulates a dead provider stream / hung SDK that ignores abort — exactly the
 * case the settlement net must catch. Kept self-contained (own mock + hook) but
 * idempotent: a global guard prevents double-registration if modes.test.ts
 * already installed a hook in the same process.
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

const MOCK_SDK_SOURCE = [
	"export class DefaultResourceLoader { constructor(a){ this.a = a; } async reload(){} }",
	"export const SessionManager = { inMemory(cwd){ return { cwd: cwd }; } };",
	"export function getAgentDir(){ return '.'; }",
	"export async function createAgentSession(args){",
	"  const listeners = [];",
	"  let release;",
	"  const session = {",
	"    agent: { state: { model: { id: 'session-model' } } },",
	"    extensionRunner: { setUIContext(){} },",
	"    subscribe(cb){ listeners.push(cb); return () => {}; },",
	"    async prompt(p){",
	"      const b = globalThis.__MOCK_SDK_BEHAVIOR__;",
	"      if (b && b.onPrompt) { await b.onPrompt(function(ev){ for (const l of listeners) l(ev); }, p); return; }",
	"      await new Promise(function(r){ release = r; });",
	"    },",
	"    async abort(){ if (release) release(); },",
	"    dispose(){}",
	"  };",
	"  return { session: session };",
	"}",
].join("\n");

const mockDir = mkdtempSync(path.join(tmpdir(), "settlement-mock-sdk-"));
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
// Guard against double-registration when modes.test.ts loads in the same tsx
// process (the repo runner globs all subagent test files into one `tsx --test`).
if (!(globalThis as { __PIE_SDK_HOOK_REGISTERED__?: boolean }).__PIE_SDK_HOOK_REGISTERED__) {
	(globalThis as { __PIE_SDK_HOOK_REGISTERED__?: boolean }).__PIE_SDK_HOOK_REGISTERED__ = true;
	Module.register(pathToFileURL(hookPath));
}

// ---------------------------------------------------------------------------
// Test fixtures: a temp agent dir so discoverAgents(scope:"user") finds "worker"
// ---------------------------------------------------------------------------

const agentDir = mkdtempSync(path.join(tmpdir(), "settlement-agents-"));
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
	// Force the mock SDK to always-parent-model (pure selection, no analytics),
	// a generous inflight cap so the permit never blocks, and disable the
	// per-prompt timeout so the ONLY thing that can settle a hung dispatch is
	// the settlement net (what we're testing). A generous default grace so the
	// abort path gets a real window unless a test overrides it.
	process.env.PIE_SUBAGENT_ALWAYS_PARENT_MODEL = "1";
	process.env.PIE_SUBAGENT_MAX_INFLIGHT = "8";
	process.env.PIE_SUBAGENT_TIMEOUT_MS = "0";
	process.env.PIE_SUBAGENT_SETTLEMENT_GRACE_MS = "200";
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
afterEach(() => setMockBehavior(undefined));

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

/** A prompt that hangs forever and ignores `abort()` (release stays unset):
 *  simulates a dead provider stream / hung SDK that never settles. Uses a bare
 *  never-resolving promise (no timer handle) so it never holds the event loop. */
function hangingPromptBehavior(): { onPrompt: () => Promise<void> } {
	return {
		onPrompt: () => new Promise<void>(() => {}),
	};
}

/** A prompt that hangs until `abort()` resolves it (the default mock branch:
 *  `release` is set so `abort()` can unblock it). Used to verify the parent
 *  abort path still works when the settlement net is disabled — the net must
 *  NOT be the only escape, the structural abort fix must work on its own. */
function abortablePromptBehavior(): Record<string, never> {
	// No `onPrompt` → mock falls through to `await new Promise(r => release = r)`,
	// which `abort()` resolves. Returns an empty object so setMockBehavior still
	// flips the global (unset behavior would use the same default branch, but
	// being explicit avoids relying on test ordering).
	return {};
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("execute(): a dispatch that never settles is force-settled within PIE_SUBAGENT_SETTLEMENT_MS and returns a loud error toolResult", async () => {
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "50"; // tiny net
	process.env.PIE_SUBAGENT_SETTLEMENT_GRACE_MS = "0"; // skip grace → synthesize immediately
	setMockBehavior({
		onPrompt: (emit: (event: unknown) => void) => {
			emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial progress" } });
			return new Promise<void>(() => {});
		},
	});

	const response = await within(2000, execute(
		"tool-settle-1",
		{ agent: "worker", task: "do work" } as never,
		new AbortController().signal, // no parent abort — the net is the only escape
		() => undefined,
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
	));

	assert.equal(response.isError, true);
	const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "";
	// Either the synthesized force-settle message, or the runner's abort result
	// (which arrives during the grace window after the settlement abort). Both
	// are acceptable "loud" outcomes — what matters is execute() returned.
	assert.match(text, /force-settled|settle|abort/i);
	assert.equal(response.details.results.length, 1);
	assert.equal(response.details.results[0]?.streamingText, "partial progress");
	assert.equal(response.details.results[0]?.exitCode, 1);
});

test("execute(): parent abort still works when the settlement net is disabled (settlementMs=0) — the net is not the primary fix", async () => {
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "0"; // net OFF
	setMockBehavior(abortablePromptBehavior()); // prompt hangs but responds to abort

	const controller = new AbortController();
	const responseP = execute(
		"tool-settle-2",
		{ agent: "worker", task: "do work" } as never,
		controller.signal,
		() => undefined,
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
	);
	// Abort shortly after dispatch starts; with the net off this is the only
	// way out, and the runner's pre-spawn/prompt abort path must settle it.
	setTimeout(() => controller.abort(), 30);
	const response = await within(2000, responseP);

	assert.equal(response.isError, true);
	const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "";
	assert.match(text, /abort/i);
});

test("execute(): a normally-completing dispatch is unaffected by the settlement net (returns the real result, not force-settled)", async () => {
	process.env.PIE_SUBAGENT_SETTLEMENT_MS = "50"; // net ON but small — must NOT fire for a fast success
	setMockBehavior({
		onPrompt: (emit: (event: unknown) => void) => {
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
					model: "m",
					stopReason: "completed",
				},
			});
		},
	});

	const response = await within(2000, execute(
		"tool-settle-3",
		{ agent: "worker", task: "do work" } as never,
		new AbortController().signal,
		() => undefined,
		makeCtx() as never,
		{ getAllTools: () => [] } as never,
		() => false,
	));

	// Real success result, not a force-settle error.
	assert.equal(response.isError, undefined);
	const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "";
	assert.equal(text, "done");
});
