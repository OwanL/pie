import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

// register.ts's chain runtime-imports `@mariozechner/pi-coding-agent`
// (render.ts also imports `@mariozechner/pi-tui`); under plain tsx neither is
// resolvable from the repo root — in production pi's loader aliases them (same
// reason render.test.ts mocks module resolution). Bootstrap the same
// createRequire + Module._resolveFilename mock, then require both entries.
installSdkResolverForTests();
const require = createRequire(import.meta.url);
// Both entries transpile to CJS; unwrap the default binding from each namespace.
const registerImplementation = ((require('../index.js') as { default?: unknown }).default ?? require('../index.js')) as typeof import('../index.js');
const registerDiscoveryShim = ((require('../../../extensions/subagent/index.js') as { default?: unknown }).default ?? require('../../../extensions/subagent/index.js')) as typeof import('../../../extensions/subagent/index.js');

function installSdkResolverForTests(): void {
	const mockDir = mkdtempSync(path.join(tmpdir(), 'subagent-shim-mock-'));
	const sdkPath = path.join(mockDir, 'pi-coding-agent.cjs');
	writeFileSync(sdkPath, 'exports.getMarkdownTheme = () => ({});\n', 'utf-8');
	const tuiPath = path.join(mockDir, 'pi-tui.cjs');
	writeFileSync(
		tuiPath,
		[
			'class Container { constructor(){ this.children = []; } addChild(c){ this.children.push(c); return this; } }',
			'class Markdown { constructor(t,x,y,th){ this.text = t; this.theme = th; } }',
			'class Spacer { constructor(n){ this.n = n; } }',
			'class Text { constructor(t,x,y){ this.text = t; this.x = x; this.y = y; } }',
			'module.exports = { Container, Markdown, Spacer, Text };',
		].join('\n'),
		'utf-8',
	);

	const M = Module as typeof Module & {
		_resolveFilename: (request: string, parent?: unknown, isMain?: boolean, options?: unknown) => string;
	};
	const original = M._resolveFilename;
	M._resolveFilename = function resolveFilename(request, parent, isMain, options): string {
		if (request === '@mariozechner/pi-coding-agent') return sdkPath;
		if (request === '@mariozechner/pi-tui') return tuiPath;
		return original.call(this, request, parent, isMain, options);
	};
}

test('subagent discovery shim re-exports the single implementation registrar', () => {
	assert.equal(registerDiscoveryShim, registerImplementation);

	const toolNames: string[] = [];
	const flags: string[] = [];
	const events: string[] = [];
	registerDiscoveryShim({
		on(event: string) { events.push(event); },
		registerTool(tool: { name: string }) { toolNames.push(tool.name); },
		registerFlag(name: string) { flags.push(name); },
		getFlag() { return false; },
	} as any);

	assert.deepEqual(toolNames, ['subagent']);
	assert.deepEqual(flags, ['no-subagent']);
	assert.deepEqual(events, ['before_provider_request']);
});