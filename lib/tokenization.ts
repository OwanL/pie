/**
 * Real BPE token counting shared by the skill-pruner and tool-result-pruner
 * extensions (and available to any other pi extension that needs it).
 *
 * Uses `gpt-tokenizer` (cl100k_base) when resolvable. The pi extension
 * runtime resolves bare specifiers from the repo-root `node_modules` in
 * Node/jiti mode; if it is unavailable (e.g. the compiled Bun binary,
 * which only bundles a fixed module set) we fall back to the chars/4
 * heuristic so telemetry never breaks the agent runtime.
 */
import { createRequire } from "node:module";

declare const require: NodeRequire | undefined;

type TokenCounter = (text: string) => number;

let cachedCounter: TokenCounter | null | undefined;

function resolveCounter(): TokenCounter | null {
	if (cachedCounter !== undefined) return cachedCounter;

	let req: NodeRequire | null = null;
	try {
		// ESM contexts (jiti/tsx): import.meta.url is available. In plain CJS
		// this throws / is undefined and we fall through to the module require.
		const url = import.meta.url;
		if (typeof url === "string") req = createRequire(url);
	} catch {
		// Not an ESM context; handled below.
	}

	if (!req && typeof require === "function") {
		req = require;
	}

	if (req) {
		try {
			const mod = req("gpt-tokenizer/encoding/cl100k_base");
			const countFn: (input: string) => number =
				typeof mod.countTokens === "function"
					? mod.countTokens
					: (text: string) => mod.encode(text).length;
			cachedCounter = (text: string) => (text ? countFn(text) : 0);
		} catch {
			cachedCounter = null;
		}
	} else {
		cachedCounter = null;
	}

	return cachedCounter;
}

/**
 * Count BPE tokens in `text` using cl100k_base. Falls back to the chars/4
 * heuristic only if the tokenizer cannot be resolved in the current runtime.
 */
export function countTokens(text: string): number {
	if (typeof text !== "string" || text.length === 0) return 0;
	const counter = resolveCounter();
	return counter ? counter(text) : Math.ceil(text.length / 4);
}

/** `true` once a real tokenizer has been resolved (useful for tests). */
export function tokenizerAvailable(): boolean {
	return resolveCounter() !== null;
}
