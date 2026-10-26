import { PIE_TOOLS, type ToolContext } from './index.js';

export interface CoreExtensionEntry {
  id: string;
  /** Source build input, not a runtime checkout lookup. */
  entryPath: string;
  /** Exact known source-profile routes relative to the selected agentDir. */
  legacyPaths: readonly string[];
  outputFile: string;
  shipped: boolean;
}

function entry(id: string, aliases: readonly string[] = [], shipped = true): CoreExtensionEntry {
  const entryPath = `extensions/${id}/index.ts`;
  // These curated index routes are native directory entrypoints. Declare the
  // directory itself too: an explicit absent directory must still suppress the
  // default, without relying on discovery of a now-missing index file.
  const legacyPaths = [entryPath, ...aliases].flatMap(route =>
    route.endsWith('/index.ts') ? [route, route.slice(0, -'/index.ts'.length)] : [route]);
  return { id, entryPath, legacyPaths, outputFile: `${id}.js`, shipped };
}

/** Pie-owned adapters only. Third-party web/MCP packages retain their managed owner.
 * cwd-skills remains a supported legacy adapter; native additionalProjectSkillPaths
 * now supplies cwd/skills discovery, so it must not also ship as a default factory.
 */
export const CORE_EXTENSIONS: readonly CoreExtensionEntry[] = [
  entry('ask-user', ['harness/tools/ask-user/index.ts']),
  entry('computer-use', ['harness/tools/computer-use/index.ts']),
  entry('copilot-model-discovery', ['harness/model-providers/model-discovery/index.ts']),
  entry('cwd-skills', ['harness/agent-instructions/skill-discovery/index.ts'], false),
  entry('deferred-triggers', ['harness/tools/deferred-triggers/index.ts']),
  entry('playwright', ['harness/tools/playwright/index.ts']),
  entry('safeguard'),
  entry('session-changes', ['harness/tools/session-changes/index.ts']),
  entry('skill-pruner', ['harness/tool-and-skill-selection/lifecycle/register.ts']),
  entry('subagent', ['harness/tools/subagent/index.ts', 'harness/tools/subagent/register.ts']),
  entry('tool-result-pruner'),
  entry('warm-bash', ['harness/tools/warm-bash/index.ts']),
  entry('web-access-guard', ['harness/tools/package-integrations/web-access/index.ts']),
];

export const BUNDLED_EXTENSIONS = CORE_EXTENSIONS.filter(entry => entry.shipped);

/** Tool-backed adapters follow catalog eligibility. Hook-only adapters keep their
 * existing child/runtime guards; loading them never widens a child's tool allowlist.
 */
export function bundledExtensionsForContext(context: ToolContext): readonly CoreExtensionEntry[] {
  return BUNDLED_EXTENSIONS.filter(entry => {
    const tools = PIE_TOOLS.filter(tool => tool.registration.kind === 'extension' && tool.registration.extensionId === entry.id);
    return tools.length === 0 || tools.some(tool => tool.contexts.includes(context));
  });
}
