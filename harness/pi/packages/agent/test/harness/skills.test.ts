import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { formatSkillInvocation, loadSkills, loadSourcedSkills } from "../../src/harness/skills.ts";
import type { ExecutionEnv, FileInfo } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

describe("loadSkills", () => {
	it("loads SKILL.md files through the execution environment", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir(".agents/skills/example", { recursive: true });
		await env.writeFile(
			".agents/skills/example/SKILL.md",
			`---
name: example
description: Example skill
disable-model-invocation: true
---
Use this skill.
`,
		);

		const { skills, diagnostics } = await loadSkills(env, ".agents/skills");

		expect(diagnostics).toEqual([]);
		expect(skills).toEqual([
			{
				name: "example",
				description: "Example skill",
				content: "Use this skill.",
				filePath: join(root, ".agents/skills/example/SKILL.md"),
				disableModelInvocation: true,
			},
		]);
	});

	it("loads skills through symlinked directories", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("actual/example", { recursive: true });
		await env.writeFile(
			"actual/example/SKILL.md",
			"---\nname: example\ndescription: Example skill\n---\nUse this skill.",
		);
		await symlink(join(root, "actual"), join(root, "skills-link"), process.platform === "win32" ? "junction" : "dir");

		const { skills } = await loadSkills(env, "skills-link");

		expect(skills.map((skill) => skill.name)).toEqual(["example"]);
		expect(skills[0]?.filePath).toBe(join(root, "skills-link/example/SKILL.md"));
	});

	it("handles Windows execution paths for ignore rules and skill locations", async () => {
		const root = "C:\\workspace\\skills";
		const ignoredDir = `${root}\\ignored-skill`;
		const visibleDir = `${root}\\visible-skill`;
		const ignorePath = `${root}\\.gitignore`;
		const skillPath = `${visibleDir}\\SKILL.md`;
		const fileInfos = new Map<string, FileInfo>([
			[root, { name: "skills", path: root, kind: "directory", size: 0, mtimeMs: 0 }],
			[ignoredDir, { name: "ignored-skill", path: ignoredDir, kind: "directory", size: 0, mtimeMs: 0 }],
			[visibleDir, { name: "visible-skill", path: visibleDir, kind: "directory", size: 0, mtimeMs: 0 }],
			[ignorePath, { name: ".gitignore", path: ignorePath, kind: "file", size: 0, mtimeMs: 0 }],
			[skillPath, { name: "SKILL.md", path: skillPath, kind: "file", size: 0, mtimeMs: 0 }],
		]);
		const fileContents = new Map([
			[ignorePath, "ignored-skill/"],
			[skillPath, "---\ndescription: Visible skill\n---\nUse this skill."],
		]);
		const rootEntries = [fileInfos.get(ignorePath)!, fileInfos.get(ignoredDir)!, fileInfos.get(visibleDir)!];
		const env = {
			cwd: "C:\\workspace",
			fileInfo: async (path: string) => {
				const info = fileInfos.get(path);
				return info
					? { ok: true, value: info }
					: { ok: false, error: { code: "not_found", message: "missing", path } };
			},
			listDir: async (path: string) => ({
				ok: true,
				value: path === root ? rootEntries : path === visibleDir ? [fileInfos.get(skillPath)!] : [],
			}),
			readTextFile: async (path: string) => {
				const content = fileContents.get(path);
				return content === undefined
					? { ok: false, error: { code: "not_found", message: "missing", path } }
					: { ok: true, value: content };
			},
		} as unknown as ExecutionEnv;

		const { skills, diagnostics } = await loadSkills(env, root);

		expect(diagnostics).toEqual([]);
		expect(skills.map((skill) => skill.name)).toEqual(["visible-skill"]);
		expect(skills[0]?.filePath).toBe(skillPath);
		expect(formatSkillInvocation(skills[0]!)).toContain(`References are relative to ${visibleDir}.`);
	});

	it("preserves source info for sourced skills", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("user/example", { recursive: true });
		await env.writeFile(
			"user/example/SKILL.md",
			"---\nname: example\ndescription: Example skill\n---\nUse this skill.",
		);

		const { skills, diagnostics } = await loadSourcedSkills(env, [
			{ path: "user", source: { type: "user" as const } },
		]);

		expect(diagnostics).toEqual([]);
		expect(skills).toEqual([
			{
				skill: {
					name: "example",
					description: "Example skill",
					content: "Use this skill.",
					filePath: join(root, "user/example/SKILL.md"),
					disableModelInvocation: false,
				},
				source: { type: "user" },
			},
		]);
	});

	it("attaches source info to diagnostics", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("user/broken", { recursive: true });
		await env.writeFile("user/broken/SKILL.md", "---\nname: broken\n---\nMissing description.");

		const { skills, diagnostics } = await loadSourcedSkills(env, [
			{ path: "user", source: { type: "user" as const } },
		]);

		expect(skills).toEqual([]);
		expect(diagnostics).toEqual([
			{
				type: "warning",
				code: "invalid_metadata",
				message: "description is required",
				path: join(root, "user/broken/SKILL.md"),
				source: { type: "user" },
			},
		]);
	});

	it("loads direct markdown children only from the root directory", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await env.createDir("skills/nested", { recursive: true });
		await env.writeFile("skills/root.md", "---\ndescription: Root skill\n---\nRoot content");
		await env.writeFile("skills/nested/ignored.md", "---\ndescription: Ignored\n---\nIgnored content");

		const { skills } = await loadSkills(env, "skills");

		expect(skills.map((skill) => skill.name)).toEqual(["skills"]);
		expect(skills[0]?.content).toBe("Root content");
	});
});
