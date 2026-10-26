import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initializeSubagentSystemPrompt, subagentSystemPrompt, SUBAGENT_SYSTEM_RELATIVE_PATH } from "../system-prompt.js";
import { getInstructionResourcePaths } from "../../../agent-instructions/resource-roots.js";
import { readCentralAppendSystemPrompt } from "../../../agent-instructions/prompt-assembly/append-system-prompt.js";

function fixture(run: (root: string, file: string) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pie-child-system-"));
	const file = path.join(root, SUBAGENT_SYSTEM_RELATIVE_PATH);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	try { run(root, file); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("child append snapshots configured shared guidance before invocation and keeps role separate", () => {
	fixture((root, file) => {
		fs.writeFileSync(file, " Shared child guidance \n");
		assert.equal(initializeSubagentSystemPrompt(root), "Shared child guidance");
		fs.writeFileSync(file, "changed after registration");
		assert.deepEqual(subagentSystemPrompt(root, "Role instructions"), ["Shared child guidance", "Role instructions"]);
		assert.deepEqual(subagentSystemPrompt(root, " \n"), ["Shared child guidance"]);
	});
});

test("direct consumers load once and missing configuration stays compatible and cached", () => {
	fixture((root, file) => {
		assert.deepEqual(subagentSystemPrompt(root, "role"), ["role"]);
		fs.writeFileSync(file, "late file");
		assert.deepEqual(subagentSystemPrompt(root, ""), []);
	});
	fixture((root, file) => {
		fs.writeFileSync(file, " \n");
		assert.deepEqual(subagentSystemPrompt(root, ""), []);
	});
	assert.deepEqual(subagentSystemPrompt("", "role"), ["role"]);
});

test("relocated bundle layers before selected profile and role, with registration snapshots", () => {
	fixture((root, legacy) => {
		const moduleDir = path.join(root, "relocated-runtime");
		const options = { moduleDir };
		const bundled = getInstructionResourcePaths(options).subagentSystemPath;
		fs.mkdirSync(path.dirname(bundled), { recursive: true });
		fs.writeFileSync(bundled, "bundled child");
		const neutral = path.join(root, "neutral-profile");
		assert.deepEqual(subagentSystemPrompt(neutral, "", options), ["bundled child"]);
		fs.writeFileSync(legacy, "legacy child");
		fs.writeFileSync(path.join(root, "SUBAGENT_SYSTEM.md"), "profile child");
		assert.equal(initializeSubagentSystemPrompt(root, options), "bundled child\n\nlegacy child\n\nprofile child");
		fs.writeFileSync(bundled, "later bundle");
		fs.writeFileSync(legacy, "later legacy");
		fs.unlinkSync(path.join(root, "SUBAGENT_SYSTEM.md"));
		assert.deepEqual(subagentSystemPrompt(root, "role", options), ["bundled child", "legacy child", "profile child", "role"]);
		const result = subagentSystemPrompt(root, "", options);
		result.length = 0;
		assert.equal(subagentSystemPrompt(root, "", options).length, 3);
	});
});

test("source seam deduplicates file identity, not equal content, and isolates main/project guidance", () => {
	fixture((root, legacy) => {
		const options = { instructionsRoot: path.dirname(legacy) };
		fs.writeFileSync(legacy, "same text");
		fs.writeFileSync(path.join(root, "SUBAGENT_SYSTEM.md"), "same text");
		fs.writeFileSync(path.join(root, "APPEND_SYSTEM.md"), "main only");
		fs.writeFileSync(path.join(path.dirname(legacy), "APPEND_SYSTEM.md"), "legacy main only");
		fs.mkdirSync(path.join(root, ".pi"));
		fs.writeFileSync(path.join(root, ".pi", "SUBAGENT_SYSTEM.md"), "project only");
		assert.deepEqual(subagentSystemPrompt(root, "role", options), ["same text", "same text", "role"]);
	});
});

test("missing relocated resources remain cached and explicit empty arrays suppress inheritance", () => {
	fixture((root) => {
		const options = { moduleDir: path.join(root, "absent-runtime") };
		assert.equal(initializeSubagentSystemPrompt(root, options), undefined);
		const bundled = getInstructionResourcePaths(options).subagentSystemPath;
		fs.mkdirSync(path.dirname(bundled), { recursive: true });
		fs.writeFileSync(bundled, "late bundle");
		fs.writeFileSync(path.join(root, "SUBAGENT_SYSTEM.md"), "late profile");
		assert.deepEqual(subagentSystemPrompt(root, "", options), []);
		assert.deepEqual(subagentSystemPrompt(root, "role", options), ["role"]);
		assert.deepEqual(subagentSystemPrompt("", "", { instructionsRoot: path.join(root, "missing") }), []);
	});
});

test("main and child append files do not cross prompt boundaries, even for empty roles", () => {
	fixture((root, file) => {
		fs.writeFileSync(file, "child only");
		assert.equal(readCentralAppendSystemPrompt(root), undefined);
		fs.writeFileSync(path.join(path.dirname(file), "APPEND_SYSTEM.md"), "main only");
		assert.equal(readCentralAppendSystemPrompt(root), "main only");
		assert.deepEqual(subagentSystemPrompt(root, ""), ["child only"]);
	});
});
