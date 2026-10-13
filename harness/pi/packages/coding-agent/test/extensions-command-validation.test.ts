import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory, loadExtensions } from "../src/core/extensions/loader.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

// Validation semantics selectively ported from earendil-works/pi v0.99.2:
// https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/src/core/extensions/loader.ts
// Deliberately do not trim names or impose additional slash-command syntax restrictions.
for (const name of [undefined, null, 42, {}, ""]) {
	test(`rejects malformed command name ${JSON.stringify(name)} during factory loading`, async () => {
		await assert.rejects(
			loadExtensionFromFactory(
				(pi) => pi.registerCommand(name as string, { handler: async () => {} }),
				process.cwd(),
				createEventBus(),
				createExtensionRuntime(),
				"<bad-name>",
			),
			{
				message:
					'Command registered by extension "<bad-name>" must have a non-empty string name. Use pi.registerCommand("name", { description, handler }).',
			},
		);
	});
}

for (const options of [undefined, null, {}, { handler: undefined }, { handler: "not a function" }, { handler: 42 }]) {
	test(`rejects malformed command handler ${JSON.stringify(options)} during factory loading`, async () => {
		await assert.rejects(
			loadExtensionFromFactory(
				(pi) => pi.registerCommand("bad", options as Parameters<ExtensionAPI["registerCommand"]>[1]),
				process.cwd(),
				createEventBus(),
				createExtensionRuntime(),
				"<bad-handler>",
			),
			{ message: 'Command "/bad" registered by extension "<bad-handler>" must define handler().' },
		);
	});
}

test("preserves valid names, handlers, metadata and replacement registrations", async () => {
	const handler = async () => {};
	const extension = await loadExtensionFromFactory(
		(pi) => {
			for (const name of ["normal", " ", "/slash", "with space"]) {
				pi.registerCommand(name, { description: "original", handler: async () => {} });
				pi.registerCommand(name, { description: "replacement", handler });
			}
		},
		process.cwd(),
		createEventBus(),
		createExtensionRuntime(),
		"<valid>",
	);
	assert.deepEqual([...extension.commands.keys()], ["normal", " ", "/slash", "with space"]);
	for (const [name, command] of extension.commands) {
		assert.equal(command.name, name);
		assert.equal(command.handler, handler);
		assert.equal(command.description, "replacement");
		assert.equal(command.sourceInfo, extension.sourceInfo);
	}
});

test("file loader reports malformed registration and still loads a valid extension", async () => {
	const directory = mkdtempSync(path.join(tmpdir(), "pi-command-validation-"));
	try {
		const badName = path.join(directory, "bad-name.js");
		const badHandler = path.join(directory, "bad-handler.js");
		const valid = path.join(directory, "valid.js");
		writeFileSync(
			badName,
			'export default (pi) => pi.registerCommand({ name: "bad" }, { handler: async () => {} });',
		);
		writeFileSync(badHandler, 'export default (pi) => pi.registerCommand("bad", {});');
		writeFileSync(valid, 'export default (pi) => pi.registerCommand("valid", { handler: async () => {} });');
		const result = await loadExtensions([badName, badHandler, valid], directory);
		assert.deepEqual(result.errors, [
			{
				path: badName,
				error: `Failed to load extension: Command registered by extension "${badName}" must have a non-empty string name. Use pi.registerCommand("name", { description, handler }).`,
			},
			{
				path: badHandler,
				error: `Failed to load extension: Command "/bad" registered by extension "${badHandler}" must define handler().`,
			},
		]);
		assert.equal(result.extensions.length, 1);
		assert.equal(result.extensions[0].path, valid);
		assert.equal(typeof result.extensions[0].commands.get("valid")?.handler, "function");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
