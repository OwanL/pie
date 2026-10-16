import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initializeSubagentSystemPrompt, subagentSystemPrompt, SUBAGENT_SYSTEM_RELATIVE_PATH } from "../system-prompt.js";
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

test("main and child append files do not cross prompt boundaries, even for empty roles", () => {
	fixture((root, file) => {
		fs.writeFileSync(file, "child only");
		assert.equal(readCentralAppendSystemPrompt(root), undefined);
		fs.writeFileSync(path.join(path.dirname(file), "APPEND_SYSTEM.md"), "main only");
		assert.equal(readCentralAppendSystemPrompt(root), "main only");
		assert.deepEqual(subagentSystemPrompt(root, ""), ["child only"]);
	});
});
