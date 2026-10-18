import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { bootstrapMockSdk } from "./mock-sdk-bootstrap.js";

test("selected SDK identities resolve to the owned fixture", async () => {
	const fixture = bootstrapMockSdk("bootstrap-test-", "export const intercepted = true;");
	try {
		const identities = ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"];
		const configPath = process.env.TSX_TSCONFIG_PATH;
		if (configPath !== undefined) {
			const config = JSON.parse(readFileSync(configPath, "utf8"));
			const selected = config.compilerOptions.paths["@earendil-works/pi-coding-agent"][0];
			identities.push(selected, pathToFileURL(selected).href, `${pathToFileURL(selected).href}?tsx-namespace=fixture`);
		}
		for (const identity of identities) {
			assert.equal((await import(identity)).intercepted, true, identity);
		}
	} finally {
		fixture.cleanup();
	}
	assert.equal(existsSync(fixture.directory), false);
});

test("setup write failure removes its owned directory", () => {
	const prefix = `bootstrap-failure-${process.pid}-`;
	const before = readdirSync(tmpdir()).filter((name) => name.startsWith(prefix));
	assert.throws(() => bootstrapMockSdk(prefix, undefined as unknown as string), /data/);
	assert.deepEqual(readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)), before);
});
