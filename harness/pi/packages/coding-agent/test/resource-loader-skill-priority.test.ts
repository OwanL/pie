import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader, type DefaultResourceLoaderOptions } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { SourceInfo } from "../src/core/source-info.ts";

describe("skill path priority", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-skill-priority-"));
		cwd = join(root, "project");
		agentDir = join(root, "user");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function skill(path: string, description: string, disabled = false): string {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			`---\nname: shared\ndescription: ${description}\ndisable-model-invocation: ${disabled}\n---\n${description} body`,
		);
		return path;
	}

	function fixtures() {
		const user = skill(join(agentDir, "skills", "shared", "SKILL.md"), "user");
		const bundled = skill(join(root, "bundled", "shared", "SKILL.md"), "bundled");
		const pkg = join(root, "project-package");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(
			join(pkg, "package.json"),
			JSON.stringify({ name: "project-package", pi: { skills: ["skills"] } }),
		);
		const project = skill(join(pkg, "skills", "shared", "SKILL.md"), "project package", true);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: [pkg] }));
		return { user, bundled, project, pkg };
	}

	it("preserves native ordering by default and for stable ties", async () => {
		const { bundled } = fixtures();
		const options = { cwd, agentDir, additionalSkillPaths: [bundled] };
		const native = new DefaultResourceLoader(options);
		const tied = new DefaultResourceLoader({ ...options, skillPathPriority: () => 0 });
		await native.reload();
		await tied.reload();
		expect(tied.getSkills()).toEqual(native.getSkills());
		expect(native.getSkills().skills[0].description).not.toBe("bundled");
	});

	it("selects complete project package then user then explicit bundled definitions with native collisions", async () => {
		const { user, bundled, project, pkg } = fixtures();
		const seen = new Map<string, Readonly<SourceInfo>>();
		const skillPathPriority: DefaultResourceLoaderOptions["skillPathPriority"] = ({ path, sourceInfo }) => {
			seen.set(path, sourceInfo);
			return sourceInfo.scope === "project" ? 0 : sourceInfo.scope === "user" ? 1 : 2;
		};
		const loader = new DefaultResourceLoader({ cwd, agentDir, additionalSkillPaths: [bundled], skillPathPriority });
		await loader.reload();
		const winner = loader.getSkills().skills[0];
		expect(winner).toMatchObject({
			filePath: project,
			baseDir: dirname(project),
			description: "project package",
			disableModelInvocation: true,
			sourceInfo: { scope: "project", origin: "package", baseDir: pkg },
		});
		expect([...seen.values()]).toContainEqual(expect.objectContaining({ scope: "project", origin: "package" }));
		expect(loader.getSkills().diagnostics.filter((d) => d.type === "collision").map((d) => d.collision)).toEqual([
			expect.objectContaining({ winnerPath: project, loserPath: user }),
			expect.objectContaining({ winnerPath: project, loserPath: bundled }),
		]);

		const extra = skill(join(root, "extra", "SKILL.md"), "extra");
		const extension = {
			path: dirname(extra),
			metadata: { source: "extension:test", scope: "temporary" as const, origin: "top-level" as const },
		};
		loader.extendResources({ skillPaths: [extension] });
		expect(loader.getSkills().skills[0]).toEqual(winner);
		expect(seen.get(dirname(extra))?.source).toBe("extension:test");
		await loader.reload();
		loader.extendResources({ skillPaths: [extension] });
		expect(loader.getSkills().skills[0]).toEqual(winner);

		const untrusted = new DefaultResourceLoader({
			cwd,
			agentDir,
			additionalSkillPaths: [bundled],
			skillPathPriority,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
		});
		await untrusted.reload();
		expect(untrusted.getSkills().skills[0].filePath).toBe(user);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: ["-skills/shared"] }));
		await untrusted.reload();
		expect(untrusted.getSkills().skills[0].filePath).toBe(bundled);
	});

	it("retains extension ancestry provenance across updates and discards it on reload", async () => {
		const first = skill(join(root, "first", "shared", "SKILL.md"), "first");
		const second = skill(join(root, "second", "shared", "SKILL.md"), "second");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			additionalSkillPaths: [first],
			skillPathPriority: ({ sourceInfo }) => (sourceInfo.source === "extension:preferred" ? -1 : 0),
		});
		await loader.reload();
		loader.extendResources({
			skillPaths: [{
				path: dirname(dirname(second)),
				metadata: { source: "extension:preferred", scope: "user", origin: "package" },
			}],
		});
		const winner = loader.getSkills().skills[0];
		expect(winner).toMatchObject({
			filePath: second,
			sourceInfo: { path: second, source: "extension:preferred", scope: "user", origin: "package" },
		});
		loader.extendResources({
			skillPaths: [{
				path: first,
				metadata: { source: "extension:other", scope: "temporary", origin: "top-level" },
			}],
		});
		expect(loader.getSkills().skills[0]).toEqual(winner);
		await loader.reload();
		expect(loader.getSkills().skills[0]).toMatchObject({
			filePath: first,
			sourceInfo: { source: "local", scope: "temporary" },
		});
	});

	it("leaves missing explicit paths to native diagnostics", async () => {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			additionalSkillPaths: [join(root, "missing")],
			skillPathPriority: () => 0,
		});
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);
		expect(loader.getSkills().diagnostics).toContainEqual(expect.objectContaining({ message: "skill path does not exist" }));
	});
});
