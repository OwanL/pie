import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("additional scoped skill roots", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-extra-skills-"));
		cwd = join(root, "project");
		agentDir = join(root, "user");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function skill(base: string, name: string, description = name): string {
		const path = join(base, name, "SKILL.md");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n---\n${description}`);
		return path;
	}

	it("does not scan cwd/skills by default and treats opted-in roots as project before priority selection", async () => {
		const project = skill(join(cwd, "skills"), "shared", "project");
		skill(join(agentDir, "skills"), "shared", "user");
		const native = new DefaultResourceLoader({ cwd, agentDir });
		await native.reload();
		expect(native.getSkills().skills[0].description).toBe("user");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			additionalProjectSkillPaths: ["skills"],
			skillPathPriority: ({ path, sourceInfo }) => {
				if (path === project) {
					expect(sourceInfo).toMatchObject({
						path: project, source: "auto", scope: "project", origin: "top-level", baseDir: join(cwd, ".pi"),
					});
				}
				return sourceInfo.scope === "project" ? 0 : 1;
			},
		});
		await loader.reload();
		expect(loader.getSkills().skills[0]).toMatchObject({ filePath: project, description: "project" });
		expect(loader.getSkills().diagnostics).toContainEqual(expect.objectContaining({
			type: "collision", collision: expect.objectContaining({ winnerPath: project }),
		}));
		// Rebuild both eligibility and metadata; do not retain disappeared project definitions.
		rmSync(dirname(project), { recursive: true });
		await loader.reload();
		expect(loader.getSkills().skills[0]).toMatchObject({ description: "user", sourceInfo: { scope: "user" } });
	});

	it("honors trust changes and noSkills without force-enabling the project root", async () => {
		skill(join(cwd, "skills"), "project-only");
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalProjectSkillPaths: ["skills"] });
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);
		settingsManager.setProjectTrusted(true);
		await loader.reload();
		expect(loader.getSkills().skills.map((s) => s.name)).toEqual(["project-only"]);
		settingsManager.setProjectTrusted(false);
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);
		const disabled = new DefaultResourceLoader({ cwd, agentDir, additionalProjectSkillPaths: ["skills"], noSkills: true });
		await disabled.reload();
		expect(disabled.getSkills().skills).toEqual([]);
	});

	it("uses native project exclusions relative to .pi and reloads changed exclusions", async () => {
		skill(join(cwd, "skills"), "skip");
		skill(join(cwd, "skills"), "keep");
		const settings = join(cwd, ".pi", "settings.json");
		writeFileSync(settings, JSON.stringify({ skills: ["-../skills/skip"] }));
		const loader = new DefaultResourceLoader({ cwd, agentDir, additionalProjectSkillPaths: ["skills"] });
		await loader.reload();
		expect(loader.getSkills().skills.map((s) => s.name)).toEqual(["keep"]);
		writeFileSync(settings, JSON.stringify({ skills: ["!**/SKILL.md"] }));
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);
		writeFileSync(settings, "{}");
		await loader.reload();
		expect(loader.getSkills().skills.map((s) => s.name).sort()).toEqual(["keep", "skip"]);
	});

	it("shares native skill-root ignore and nested definition discovery", async () => {
		const skillsDir = join(cwd, "skills");
		const kept = skill(skillsDir, "keep");
		skill(skillsDir, "ignored");
		skill(skillsDir, "fd-ignored");
		skill(skillsDir, "dot-ignored");
		skill(join(skillsDir, "node_modules"), "dependency");
		writeFileSync(join(skillsDir, ".gitignore"), "ignored/\n");
		writeFileSync(join(skillsDir, ".fdignore"), "fd-ignored/\n");
		writeFileSync(join(skillsDir, ".ignore"), "dot-ignored/\n");
		writeFileSync(join(dirname(kept), "README.md"), "not a skill");
		const loader = new DefaultResourceLoader({ cwd, agentDir, additionalProjectSkillPaths: ["skills"] });
		await loader.reload();
		expect(loader.getSkills().skills.map((s) => s.filePath)).toEqual([kept]);
		expect(loader.getSkills().diagnostics).toEqual([]);
	});

	it("canonically deduplicates overlapping/default roots in the native resolver", async () => {
		const nativePath = skill(join(cwd, ".pi", "skills"), "native");
		const extraPath = skill(join(cwd, "skills"), "extra");
		const alias = join(cwd, "alias-skills");
		symlinkSync(resolve(cwd, "skills"), alias, process.platform === "win32" ? "junction" : "dir");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const manager = new DefaultPackageManager({
			cwd, agentDir, settingsManager,
			additionalProjectSkillPaths: [".pi/skills", "skills", "skills/extra", alias],
		});
		const resolved = await manager.resolve();
		expect(resolved.skills.map((s) => s.path)).toEqual([nativePath, extraPath]);
		expect(resolved.skills.every((s) => s.enabled && s.metadata.scope === "project")).toBe(true);
		const native = new DefaultPackageManager({ cwd, agentDir, settingsManager });
		const empty = new DefaultPackageManager({
			cwd, agentDir, settingsManager, additionalProjectSkillPaths: [], additionalUserSkillPaths: [],
		});
		expect(await empty.resolve()).toEqual(await native.resolve());
	});

	it("loads user-authorized roots independently of project trust, with native metadata before priority", async () => {
		const bundleRoot = join(root, "bundle");
		const bundled = skill(bundleRoot, "shared", "bundled");
		const authored = skill(join(agentDir, "authored"), "shared", "authored");
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const defaults = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await defaults.reload();
		expect(defaults.getSkills().skills).toEqual([]);
		const loader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager,
			additionalUserSkillPaths: [bundleRoot, "authored", "optional-missing"],
			skillPathPriority: ({ path, sourceInfo }) => {
				expect(sourceInfo).toMatchObject({
					source: "auto", scope: "user", origin: "top-level", baseDir: agentDir,
				});
				return path === bundled ? 1 : 0;
			},
		});
		await loader.reload();
		expect(loader.getSkills().skills[0]).toMatchObject({
			filePath: authored, description: "authored", sourceInfo: { scope: "user", path: authored },
		});
		expect(loader.getSkills().diagnostics).toEqual([expect.objectContaining({
			type: "collision", collision: expect.objectContaining({ winnerPath: authored, loserPath: bundled }),
		})]);
		rmSync(dirname(authored), { recursive: true });
		await loader.reload();
		expect(loader.getSkills().skills[0].filePath).toBe(bundled);
		rmSync(bundleRoot, { recursive: true });
		await loader.reload();
		expect(loader.getSkills()).toEqual({ skills: [], diagnostics: [] });
	});

	it("honors user exclusions, ignore rules, noSkills and canonical root deduplication", async () => {
		const extraRoot = join(agentDir, "authored");
		const kept = skill(extraRoot, "keep");
		skill(extraRoot, "skip");
		skill(extraRoot, "ignored");
		writeFileSync(join(extraRoot, ".ignore"), "ignored/\n");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: ["-authored/skip"] }));
		const additionalUserSkillPaths = ["authored", "authored/keep", "authored/../authored"];
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager, additionalUserSkillPaths });
		const resolved = await manager.resolve();
		expect(resolved.skills.filter((s) => s.enabled).map((s) => s.path)).toEqual([kept]);
		expect(resolved.skills).toHaveLength(2);
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalUserSkillPaths });
		await loader.reload();
		expect(loader.getSkills().skills.map((s) => s.filePath)).toEqual([kept]);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: ["!**/SKILL.md"] }));
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);
		const disabled = new DefaultResourceLoader({ cwd, agentDir, additionalUserSkillPaths, noSkills: true });
		await disabled.reload();
		expect(disabled.getSkills()).toEqual({ skills: [], diagnostics: [] });
	});
});
