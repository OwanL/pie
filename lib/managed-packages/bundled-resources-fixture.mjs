// Small pristine source fixture reused from prepare-managed-closure.test.mjs.
// Tests adapt these through the public contract rather than duplicating transforms.
const webIndex = [
  'function resolveWorkflow(input: unknown, hasUI: boolean): WebSearchWorkflow {',
  '\tconst normalized = typeof input === "string" ? input.trim().toLowerCase() : "";',
  '\tif (normalized === "auto-summary") return "auto-summary";', '\tif (!hasUI) return "none";',
  '\tif (normalized === "none") return "none";', '\treturn "summary-review";', '}',
  'StringEnum(["none", "summary-review", "auto-summary"], {',
  '\t\t\t\t\tdescription: "Search workflow mode: none = no curator, summary-review = open curator with auto summary draft (default), auto-summary = generate summary without opening curator",',
  '\t\t\t\t}),',
  'Searches auto-open the interactive browser curator and stream results live; set workflow to "none" to skip curation or "auto-summary" for a model-generated summary without the browser curator.',
].join('\n');
const storage = 'import { join } from "node:path";\nexport function getFetchCacheDir(): string {\n\treturn join(getWebSearchConfigDir(), FETCH_CACHE_DIR);\n}';
const mcpIndex = 'import { runMcpScript } from "./mcp-code.ts";\n\n        executeOwner?.throwIfInactive();\n        return runMcpScript(state, params.code, params.timeoutMs, getPiTools, signal);\n';
const agentDir = 'import { join, resolve } from "node:path";\nexport function getAgentPath(...segments: string[]): string {\n  return join(getAgentDir(), ...segments);\n}';

export const pristineSources = { webIndex, storage, mcpIndex, agentDir };
