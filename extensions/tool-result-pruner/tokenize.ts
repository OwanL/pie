/**
 * Real BPE token counting for tool-result-pruner telemetry.
 *
 * Mirrors skill-pruner/tokenize.ts: uses `gpt-tokenizer` (cl100k_base) when
 * resolvable; falls back to the chars/4 heuristic so telemetry never breaks
 * the agent runtime if the tokenizer isn't bundled.
 */
import { createRequire } from "node:module";

declare const require: NodeRequire | undefined;

type TokenCounter = (text: string) => number;

let cachedCounter: TokenCounter | null | undefined;

function resolveCounter(): TokenCounter | null {
  if (cachedCounter !== undefined) return cachedCounter;

  let req: NodeRequire | null = null;
  try {
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

/** Count BPE tokens in `text` (cl100k_base). Falls back to chars/4 only if the
 *  tokenizer cannot be resolved in the current runtime. */
export function countTokens(text: string): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  const counter = resolveCounter();
  return counter ? counter(text) : Math.ceil(text.length / 4);
}

/** `true` once a real tokenizer has been resolved (useful for tests). */
export function tokenizerAvailable(): boolean {
  return resolveCounter() !== null;
}