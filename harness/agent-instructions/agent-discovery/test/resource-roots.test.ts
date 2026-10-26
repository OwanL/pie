import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getInstructionResourcePaths, getUserAgentResourceDirs } from "../../resource-roots.js";
import { discoverAgents } from "../agents.js";

test("resource paths follow a relocated flat runtime, or an explicit source root only", () => {
	const moduleDir = path.resolve(os.tmpdir(), "relocated-runtime");
	const paths = getInstructionResourcePaths({ moduleDir });
	assert.deepEqual(paths, {
		root: path.join(moduleDir, "resources", "agent-instructions"),
		appendSystemPath: path.join(moduleDir, "resources", "agent-instructions", "APPEND_SYSTEM.md"),
		subagentSystemPath: path.join(moduleDir, "resources", "agent-instructions", "SUBAGENT_SYSTEM.md"),
		agentsDir: path.join(moduleDir, "resources", "agent-instructions", "agents"),
		skillsDir: path.join(moduleDir, "resources", "agent-instructions", "skills"),
	});
	const instructionsRoot = path.resolve(os.tmpdir(), "explicit-source");
	assert.equal(getInstructionResourcePaths({ moduleDir, instructionsRoot }).root, instructionsRoot);
});

test("whole definitions layer bundled < legacy user < conventional user < project; removal reveals defaults", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pie-agent-layers-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const moduleDir = path.join(root, "runtime");
	const agentDir = path.join(root, "selected-profile");
	const project = path.join(root, "project");
	const options = { moduleDir, agentDir };
	const bundled = getInstructionResourcePaths(options).agentsDir;
	const [legacy, conventional] = getUserAgentResourceDirs(agentDir);
	const projectAgents = path.join(project, "agents");
	const write = (dir: string, desc: string, policy = "") => {
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, "role.md");
		fs.writeFileSync(file, `---\nname: reviewer\ndescription: ${desc}\n${policy}---\n${desc} body\n`);
		return file;
	};
	const bundledFile = write(bundled, "bundled read-only", "tools: [read]\ncanSpawn: []\nbucket: small\n");
	let role = discoverAgents(project, "user", options).agents[0];
	assert.equal(role.source, "bundled");
	assert.equal(role.filePath, bundledFile);
	assert.deepEqual(role.tools, ["read"]);
	assert.deepEqual(role.canSpawn, []);
	const legacyFile = write(legacy, "legacy", "tools: []\ncanSpawn: []\n");
	role = discoverAgents(project, "user", options).agents[0];
	assert.equal(role.filePath, legacyFile);
	assert.equal(role.source, "user");
	assert.deepEqual(role.tools, []);
	assert.deepEqual(role.canSpawn, []);
	assert.equal(role.bucket, undefined, "replacement must not merge bundled metadata");
	const userFile = write(conventional, "conventional");
	role = discoverAgents(project, "user", options).agents[0];
	assert.equal(role.filePath, userFile);
	assert.equal(role.tools, undefined);
	assert.equal(role.canSpawn, undefined);
	const projectFile = write(projectAgents, "project");
	assert.equal(discoverAgents(project, "both", options).agents[0].filePath, projectFile);
	assert.equal(discoverAgents(project, "project", options).agents[0].filePath, projectFile);
	assert.equal(discoverAgents(project, "user", options).agents[0].filePath, userFile);
	fs.rmSync(userFile);
	assert.equal(discoverAgents(project, "user", options).agents[0].filePath, legacyFile);
	fs.rmSync(legacyFile);
	assert.equal(discoverAgents(project, "user", options).agents[0].filePath, bundledFile);
	fs.rmSync(projectFile);
	assert.deepEqual(discoverAgents(project, "project", options).agents, []);
	assert.equal(discoverAgents(project, "both", options).agents[0].filePath, bundledFile);
	fs.rmSync(bundledFile);
	assert.deepEqual(discoverAgents(project, "user", options).agents, []);
});

test("bundled discovery does not infer a source checkout or another profile", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pie-agent-isolation-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const sourceRoot = path.join(root, "checkout", "harness", "agent-instructions");
	fs.mkdirSync(path.join(sourceRoot, "agents"), { recursive: true });
	fs.writeFileSync(path.join(sourceRoot, "agents", "hidden.md"), "---\nname: hidden\ndescription: checkout only\n---\nbody");
	const options = { moduleDir: path.join(root, "runtime"), agentDir: path.join(root, "other-profile") };
	assert.deepEqual(discoverAgents(path.join(root, "checkout"), "user", options).agents, []);
	const explicit = discoverAgents(root, "user", { ...options, instructionsRoot: sourceRoot });
	assert.equal(explicit.agents[0].name, "hidden");
	assert.equal(explicit.agents[0].source, "bundled");
});
