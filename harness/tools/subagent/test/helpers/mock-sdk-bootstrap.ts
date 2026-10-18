import Module from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SESSION_MOCK_SDK_SOURCE = [
	"export class DefaultResourceLoader { constructor(a){ this.a = a; } async reload(){} }",
	"export const SessionManager = { inMemory(cwd){ return { cwd: cwd }; } };",
	"export function getAgentDir(){ return '.'; }",
	"export async function createAgentSession(args){",
	"  const listeners = [];",
	"  let release;",
	"  const session = {",
	"    agent: { state: { model: { id: 'session-model' } } },",
	"    extensionRunner: { setUIContext(ctx){ (globalThis.__MOCK_PROXIES__ = globalThis.__MOCK_PROXIES__ || []).push(ctx); } },",
	"    subscribe(cb){ listeners.push(cb); return () => {}; },",
	"    async prompt(p){",
	"      const b = globalThis.__MOCK_SDK_BEHAVIOR__;",
	"      if (b && b.onPrompt) { await b.onPrompt(function(ev){ for (const l of listeners) l(ev); }, p); return; }",
	"      await new Promise(function(r){ release = r; });",
	"    },",
	"    async abort(){ if (release) release(); },",
	"    dispose(){}",
	"  };",
	"  return { session: session };",
	"}",
].join("\n");

/** Call synchronously before requiring production; each test file owns its hook. */
export function bootstrapMockSdk(prefix: string, source: string) {
	const configPath = process.env.TSX_TSCONFIG_PATH;
	let selectedPath: string | undefined;
	if (configPath !== undefined) {
		const config = JSON.parse(readFileSync(path.resolve(configPath), "utf-8"));
		const paths = config.compilerOptions?.paths;
		const canonical = paths?.["@earendil-works/pi-coding-agent"]?.[0];
		const legacy = paths?.["@mariozechner/pi-coding-agent"]?.[0];
		if (typeof canonical !== "string" || typeof legacy !== "string" || !path.isAbsolute(canonical) || path.resolve(canonical) !== path.resolve(legacy)) {
			throw new Error("The shared TSX config must map canonical and legacy coding-agent aliases to the same selected module");
		}
		selectedPath = path.resolve(canonical);
	}
	const selectedUrl = selectedPath && pathToFileURL(selectedPath).href;
	const directory = mkdtempSync(path.join(tmpdir(), prefix));
	const cleanup = () => rmSync(directory, { recursive: true, force: true });
	try {
		const mockPath = path.join(directory, "mock-sdk.mjs");
		const hookPath = path.join(directory, "hook.mjs");
		writeFileSync(mockPath, source, "utf-8");
		writeFileSync(hookPath, [
			"export async function resolve(specifier, context, nextResolve){",
			`  if (specifier === '@earendil-works/pi-coding-agent' || specifier === '@mariozechner/pi-coding-agent'${selectedPath ? ` || specifier === ${JSON.stringify(selectedPath)} || specifier === ${JSON.stringify(selectedUrl)} || specifier.startsWith(${JSON.stringify(`${selectedUrl}?tsx-namespace=`)})` : ""}) return { url: ${JSON.stringify(pathToFileURL(mockPath).href)}, shortCircuit: true };`,
			"  return nextResolve(specifier, context);",
			"}",
		].join("\n"), "utf-8");
		Module.register(pathToFileURL(hookPath));
		return { directory, cleanup };
	} catch (error) {
		cleanup();
		throw error;
	}
}
