import test from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AgentConfig } from "../agents.js";
import {
	maybeApproveProjectAgents,
	readConfirmDefaultFromSettings,
} from "../src/execute.js";
import type { SubagentParams } from "../schema.js";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "test agent",
		systemPrompt: "",
		source: "project",
		filePath: "agents/worker.md",
		...overrides,
	};
}

function makeDiscovery(projectAgentsDir: string | null) {
	return { agents: [], projectAgentsDir };
}

function makeCtx(confirmReturnValue: boolean, hasUI = true) {
	const confirmCalls: { title: string; body: string }[] = [];
	return {
		ctx: {
			hasUI,
			ui: {
				confirm: async (title: string, body: string) => {
					confirmCalls.push({ title, body });
					return confirmReturnValue;
				},
			},
		} as any,
		confirmCalls,
	};
}

const projectAgent = makeAgent();
const singleParams = (overrides: Partial<SubagentParams> = {}): SubagentParams =>
	({ agent: "worker", task: "do thing", ...overrides }) as any;

test("readConfirmDefaultFromSettings returns undefined when the file is missing", async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "subagent-settings-"));
	try {
		assert.equal(readConfirmDefaultFromSettings(path.join(tempDir, "settings.json")), undefined);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("readConfirmDefaultFromSettings returns the boolean when set", async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "subagent-settings-"));
	try {
		const settingsPath = path.join(tempDir, "settings.json");
		await writeFile(settingsPath, JSON.stringify({ subagent: { confirmProjectAgents: false } }));
		assert.equal(readConfirmDefaultFromSettings(settingsPath), false);

		await writeFile(settingsPath, JSON.stringify({ subagent: { confirmProjectAgents: true } }));
		assert.equal(readConfirmDefaultFromSettings(settingsPath), true);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("readConfirmDefaultFromSettings returns undefined when the key is absent", async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "subagent-settings-"));
	try {
		const settingsPath = path.join(tempDir, "settings.json");
		await writeFile(settingsPath, JSON.stringify({ pruning: { mode: "auto" } }));
		assert.equal(readConfirmDefaultFromSettings(settingsPath), undefined);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("readConfirmDefaultFromSettings tolerates malformed JSON", async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "subagent-settings-"));
	try {
		const settingsPath = path.join(tempDir, "settings.json");
		await writeFile(settingsPath, "{ not valid json");
		assert.equal(readConfirmDefaultFromSettings(settingsPath), undefined);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("maybeApproveProjectAgents skips the prompt when the per-call flag is false", async () => {
	const { ctx, confirmCalls } = makeCtx(true);
	const res = await maybeApproveProjectAgents(
		singleParams({ confirmProjectAgents: false }),
		[projectAgent],
		makeDiscovery("/repo/agents"),
		"single",
		ctx,
	);
	assert.equal(res, undefined);
	assert.equal(confirmCalls.length, 0);
});

test("maybeApproveProjectAgents returns undefined (approved) when the user accepts", async () => {
	const { ctx, confirmCalls } = makeCtx(true);
	const res = await maybeApproveProjectAgents(
		singleParams({ confirmProjectAgents: true }),
		[projectAgent],
		makeDiscovery("/repo/agents"),
		"single",
		ctx,
	);
	assert.equal(res, undefined);
	assert.equal(confirmCalls.length, 1);
});

test("maybeApproveProjectAgents returns an error response when the user declines", async () => {
	const { ctx, confirmCalls } = makeCtx(false);
	const res = await maybeApproveProjectAgents(
		singleParams({ confirmProjectAgents: true }),
		[projectAgent],
		makeDiscovery("/repo/agents"),
		"single",
		ctx,
	);
	assert.equal(res?.isError, true);
	assert.match((res!.content[0] as any).text, /not approved/i);
	assert.equal(confirmCalls.length, 1);
});

test("maybeApproveProjectAgents skips the prompt when no project agents are requested", async () => {
	const { ctx, confirmCalls } = makeCtx(true);
	// A user-scoped agent, not project.
	const userAgent = makeAgent({ source: "user" });
	const res = await maybeApproveProjectAgents(
		singleParams({ confirmProjectAgents: true }),
		[userAgent],
		makeDiscovery("/repo/agents"),
		"single",
		ctx,
	);
	assert.equal(res, undefined);
	assert.equal(confirmCalls.length, 0);
});

test("maybeApproveProjectAgents fails closed when confirmation is required without UI", async () => {
	const { ctx, confirmCalls } = makeCtx(true, false);
	const res = await maybeApproveProjectAgents(
		singleParams({ confirmProjectAgents: true }),
		[projectAgent],
		makeDiscovery("/repo/agents"),
		"single",
		ctx,
	);
	assert.equal(res?.isError, true);
	assert.match((res!.content[0] as any).text, /cannot confirm|non-interactive/i);
	assert.equal(confirmCalls.length, 0);
});

test("maybeApproveProjectAgents skips the prompt when no project agents dir exists", async () => {
	const { ctx, confirmCalls } = makeCtx(true);
	const res = await maybeApproveProjectAgents(
		singleParams({ confirmProjectAgents: true }),
		[projectAgent],
		makeDiscovery(null),
		"single",
		ctx,
	);
	assert.equal(res, undefined);
	assert.equal(confirmCalls.length, 0);
});

test("maybeApproveProjectAgents suppresses the prompt when the settings.json default resolves to false", async (t) => {
	// Reproduces what execute() does when the per-call flag is omitted: resolve the
	// settings default via readSubagentConfirmDefaultFromSettings (an explicit path with a
	// written `false`), then feed that resolved value into maybeApproveProjectAgents.
	// This verifies the settings → suppression path without depending on the real
	// repo settings.json (which happens to ship `false` today).
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "subagent-settings-"));
	try {
		const settingsPath = path.join(tempDir, "settings.json");
		await writeFile(settingsPath, JSON.stringify({ subagent: { confirmProjectAgents: false } }));
		const settingsDefault = readConfirmDefaultFromSettings(settingsPath);
		assert.equal(settingsDefault, false);

		const { ctx, confirmCalls } = makeCtx(true);
		const res = await maybeApproveProjectAgents(
			singleParams({ confirmProjectAgents: settingsDefault }),
			[projectAgent],
			makeDiscovery("/repo/agents"),
			"single",
			ctx,
		);
		assert.equal(res, undefined);
		assert.equal(confirmCalls.length, 0);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});
