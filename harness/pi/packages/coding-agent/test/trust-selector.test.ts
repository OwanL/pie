import { setKeybindings } from "@earendil-works/pi-tui";
import { join, parse } from "path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { TrustSelectorComponent } from "../src/modes/interactive/components/trust-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

// Short, synthetic native absolute paths: no cwd-relative normalization or real
// fixture ancestors, and the parent option fits on one rendered row on Windows.
const fixtureRoot = join(parse(process.cwd()).root, "pie-trust-fixture");
const projectPath = join(fixtureRoot, "project");
const parentPath = join(fixtureRoot, "parent");
const childPath = join(parentPath, "project");

describe("TrustSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("marks the saved trusted decision", () => {
		const selector = new TrustSelectorComponent({
			cwd: projectPath,
			savedDecision: { path: projectPath, decision: true },
			projectTrusted: true,
			onSelect: () => {},
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain(`Saved decision: trusted (${projectPath})`);
		expect(output).toContain("Current session: trusted");
		expect(output).toContain("Trust ✓");
		expect(output).not.toContain("Do not trust ✓");
	});

	it("selects a trust decision", () => {
		const onSelect = vi.fn();
		const selector = new TrustSelectorComponent({
			cwd: projectPath,
			savedDecision: null,
			projectTrusted: false,
			onSelect,
			onCancel: () => {},
		});

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({ trusted: true, updates: [{ path: projectPath, decision: true }] });
	});

	it("labels saved ancestor decisions as inherited", () => {
		const selector = new TrustSelectorComponent({
			cwd: join(childPath, "nested"),
			savedDecision: { path: parentPath, decision: true },
			projectTrusted: true,
			onSelect: () => {},
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain(`Saved decision: trusted (inherited from ${parentPath})`);
	});

	it("adds a trust parent option", () => {
		const onSelect = vi.fn();
		const selector = new TrustSelectorComponent({
			cwd: childPath,
			savedDecision: { path: parentPath, decision: true },
			projectTrusted: true,
			onSelect,
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain(`Saved decision: trusted (inherited from ${parentPath})`);
		expect(output).toContain(`Trust parent folder (${parentPath}) ✓`);

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({
			trusted: true,
			updates: [
				{ path: parentPath, decision: true },
				{ path: childPath, decision: null },
			],
		});
	});
});
