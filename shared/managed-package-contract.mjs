// Read-only contract for Pi packages that Pie supports through the managed
// npm install. Consumers must never discover or patch a global npm copy.

import path from 'node:path';

export const MANAGED_PACKAGE_REQUIREMENTS = Object.freeze([
  Object.freeze({
    name: 'pi-web-access',
    version: '0.27.0',
    source: 'npm:pi-web-access@0.27.0',
    requiredFiles: Object.freeze([
      'index.ts',
      'storage.ts',
      'node_modules/@mozilla/readability/Readability.js',
    ]),
    cacheTargets: Object.freeze(['PIE_CACHE_DIR/web-search-cache']),
  }),
  Object.freeze({
    name: 'pi-mcp-adapter',
    version: '2.20.1',
    source: 'npm:pi-mcp-adapter@2.20.1',
    requiredFiles: Object.freeze(['agent-dir.ts']),
    cacheTargets: Object.freeze(['PIE_CACHE_DIR/mcp-cache.json', 'PIE_CACHE_DIR/mcp-npx-cache.json']),
  }),
]);

export function managedPackageRoot(agentDir, packageName) {
  return path.join(agentDir, 'npm', 'node_modules', packageName);
}

/**
 * Resolve a required package file only in the package root or its one exact
 * managed npm-prefix node_modules directory. npm commonly hoists dependencies
 * beside the package; walking farther would accidentally discover globals.
 */
export function managedRequiredFileCandidates(root, relative) {
  const nested = path.join(root, relative);
  if (!relative.startsWith('node_modules/')
    || path.basename(root) !== 'pi-web-access'
    || path.basename(path.dirname(root)) !== 'node_modules'
    || path.basename(path.dirname(path.dirname(root))) !== 'npm') return [nested];
  const hoisted = path.join(path.dirname(root), relative.slice('node_modules/'.length));
  return [nested, hoisted];
}

export function resolveManagedCacheTargets(packageName, cacheDir) {
  const requirement = MANAGED_PACKAGE_REQUIREMENTS.find((entry) => entry.name === packageName);
  if (!requirement || typeof cacheDir !== 'string' || !path.isAbsolute(cacheDir.trim())) return null;
  const absolute = path.resolve(cacheDir.trim());
  return requirement.cacheTargets.map((target) => path.join(absolute, target.slice('PIE_CACHE_DIR/'.length)));
}

// Fingerprint complete supported seams, rather than loose feature markers.
// Runtime and doctor must agree when a source was edited or only partly patched.
const WEB_WORKFLOW_PRISTINE = [
  'function resolveWorkflow(input: unknown, hasUI: boolean): WebSearchWorkflow {',
  '\tconst normalized = typeof input === "string" ? input.trim().toLowerCase() : "";',
  '\tif (normalized === "auto-summary") return "auto-summary";',
  '\tif (!hasUI) return "none";',
  '\tif (normalized === "none") return "none";',
  '\treturn "summary-review";',
  '}',
].join('\n');
const WEB_WORKFLOW_PATCHED = [
  'function resolveWorkflow(input: unknown, hasUI: boolean): WebSearchWorkflow {',
  '\treturn "none";',
  '}',
].join('\n');
const WEB_WORKFLOW_ENUM_PRISTINE = [
  'StringEnum(["none", "summary-review", "auto-summary"], {',
  '\t\t\t\t\tdescription: "Search workflow mode: none = no curator, summary-review = open curator with auto summary draft (default), auto-summary = generate summary without opening curator",',
  '\t\t\t\t}),',
].join('\n');
const WEB_WORKFLOW_ENUM_PATCHED = 'StringEnum(["none"], { description: "Search workflow mode: none = raw results only (curator and LLM summary disabled)" })';
const WEB_DESCRIPTION = 'Searches auto-open the interactive browser curator and stream results live; set workflow to "none" to skip curation or "auto-summary" for a model-generated summary without the browser curator.';
const WEB_DESCRIPTION_FIXED = 'Only raw search results are returned in this deployment — the interactive curator and LLM summary modes are disabled (workflow is fixed to "none").';
const WEB_STORAGE_PRISTINE = [
  'export function getFetchCacheDir(): string {',
  '\treturn join(getWebSearchConfigDir(), FETCH_CACHE_DIR);',
  '}',
].join('\n');
const WEB_STORAGE_PATCHED = [
  'export function getFetchCacheDir(): string {',
  '  const configured = process.env.PIE_CACHE_DIR?.trim();',
  '  const baseDir = configured && isAbsolute(configured)',
  '    ? configured',
  '    : getWebSearchConfigDir();',
  '  return join(baseDir, FETCH_CACHE_DIR);',
  '}',
].join('\n');
const WEB_STORAGE_PATCHED_IMPORT = 'import { isAbsolute, join } from "node:path";';
const MCP_AGENT_PRISTINE = [
  'export function getAgentPath(...segments: string[]): string {',
  '  return join(getAgentDir(), ...segments);',
  '}',
].join('\n');
const MCP_AGENT_PATCHED = [
  'export function getAgentPath(...segments: string[]): string {',
  '  const cacheDir = process.env.PIE_CACHE_DIR?.trim();',
  '  if (cacheDir && segments.length === 1 && (segments[0] === "mcp-cache.json" || segments[0] === "mcp-npx-cache.json")) {',
  '    return join(resolve(cacheDir), segments[0]);',
  '  }',
  '  return join(getAgentDir(), ...segments);',
  '}',
].join('\n');
const MCP_AGENT_PATCHED_IMPORT = 'import { join, resolve } from "node:path";';

function countExact(content, needle) {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = content.indexOf(needle, offset);
    if (found === -1) return count;
    count++;
    offset = found + needle.length;
  }
}

function classifyPart(content, pristine, patched) {
  const pristineCount = countExact(content, pristine);
  const patchedCount = countExact(content, patched);
  if (pristineCount === 1 && patchedCount === 0) return 'pristine';
  if (patchedCount === 1 && pristineCount === 0) return 'supported-patched';
  return 'unsupported';
}

function classifyStorage(content) {
  const pristine = countExact(content, WEB_STORAGE_PRISTINE) === 1
    && countExact(content, 'import { join } from "node:path";') === 1
    && countExact(content, WEB_STORAGE_PATCHED) === 0
    && countExact(content, WEB_STORAGE_PATCHED_IMPORT) === 0;
  if (pristine) return 'pristine';
  const patched = countExact(content, WEB_STORAGE_PATCHED_IMPORT) === 1
    && countExact(content, 'import { join } from "node:path";') === 0
    && countExact(content, WEB_STORAGE_PATCHED) === 1
    && countExact(content, WEB_STORAGE_PRISTINE) === 0;
  if (patched) return 'supported-patched';
  return 'unsupported';
}

function classifyMcpAgent(content) {
  const pristine = countExact(content, MCP_AGENT_PRISTINE) === 1
    && countExact(content, MCP_AGENT_PATCHED_IMPORT) === 1
    && countExact(content, MCP_AGENT_PATCHED) === 0;
  if (pristine) return 'pristine';
  const patched = countExact(content, MCP_AGENT_PATCHED_IMPORT) === 1
    && countExact(content, MCP_AGENT_PATCHED) === 1
    && countExact(content, MCP_AGENT_PRISTINE) === 0;
  if (patched) return 'supported-patched';
  return 'unsupported';
}

/** Classify the exact pinned source seams; mixed pristine/patched seams remain supported. */
export function classifyManagedPackageSources(packageName, files) {
  const parts = packageName === 'pi-web-access'
    ? [
        classifyPart(files.index ?? '', WEB_WORKFLOW_PRISTINE, WEB_WORKFLOW_PATCHED),
        classifyPart(files.index ?? '', WEB_WORKFLOW_ENUM_PRISTINE, WEB_WORKFLOW_ENUM_PATCHED),
        classifyPart(files.index ?? '', WEB_DESCRIPTION, WEB_DESCRIPTION_FIXED),
        classifyStorage(files.storage ?? ''),
      ]
    : [classifyMcpAgent(files.agentDir ?? '')];
  if (parts.includes('unsupported')) return 'unsupported';
  return parts.every((part) => part === 'pristine') ? 'pristine' : 'supported-patched';
}
