/** Pie-owned model tools. Importing this catalog must not load tool runtimes.
 * Schemas/descriptions remain owned by each implementation, not copied here.
 * Extension discovery adapters preserve existing SDK IDs and lifecycle hooks;
 * backend tools are constructed separately with worker-owned service ports.
 */
export type ToolContext = 'primary' | 'subagent' | 'inventory';

export interface PieToolEntry {
  name: string;
  sourcePath: string;
  registration:
    | { kind: 'extension'; extensionId: string; entryPath: string }
    | { kind: 'backend' };
  contexts: readonly ToolContext[];
}

export const PIE_TOOLS: readonly PieToolEntry[] = [
  { name: 'ask_user', sourcePath: 'tools/ask-user/index.ts', registration: { kind: 'extension', extensionId: 'ask-user', entryPath: 'extensions/ask-user/index.ts' }, contexts: ['primary', 'subagent', 'inventory'] },
  { name: 'bash', sourcePath: 'tools/warm-bash/index.ts', registration: { kind: 'extension', extensionId: 'warm-bash', entryPath: 'extensions/warm-bash/index.ts' }, contexts: ['primary', 'subagent', 'inventory'] },
  { name: 'computer', sourcePath: 'tools/computer-use/index.ts', registration: { kind: 'extension', extensionId: 'computer-use', entryPath: 'extensions/computer-use/index.ts' }, contexts: ['primary', 'subagent', 'inventory'] },
  { name: 'defer_trigger', sourcePath: 'tools/deferred-triggers/index.ts', registration: { kind: 'extension', extensionId: 'deferred-triggers', entryPath: 'extensions/deferred-triggers/index.ts' }, contexts: ['primary', 'inventory'] },
  { name: 'playwright', sourcePath: 'tools/playwright/index.ts', registration: { kind: 'extension', extensionId: 'playwright', entryPath: 'extensions/playwright/index.ts' }, contexts: ['primary', 'subagent', 'inventory'] },
  { name: 'request_capability', sourcePath: 'tools/request-capability/index.ts', registration: { kind: 'extension', extensionId: 'skill-pruner', entryPath: 'extensions/skill-pruner/index.ts' }, contexts: ['primary', 'subagent', 'inventory'] },
  { name: 'session_changes', sourcePath: 'tools/session-changes/index.ts', registration: { kind: 'extension', extensionId: 'session-changes', entryPath: 'extensions/session-changes/index.ts' }, contexts: ['primary', 'subagent', 'inventory'] },
  { name: 'session_control', sourcePath: 'tools/session-control/index.ts', registration: { kind: 'backend' }, contexts: ['primary', 'inventory'] },
  { name: 'subagent', sourcePath: 'tools/subagent/src/register.ts', registration: { kind: 'extension', extensionId: 'subagent', entryPath: 'extensions/subagent/index.ts' }, contexts: ['primary', 'subagent', 'inventory'] },
];

/** Eligibility, not active visibility: toggles, agent allowlists, and pruning
 * can still remove an eligible tool. Inventory represents primary definitions. */
export function pieToolsForContext(context: ToolContext): readonly PieToolEntry[] {
  return PIE_TOOLS.filter((entry) => entry.contexts.includes(context));
}

export function unavailablePieToolNames(context: ToolContext): string[] {
  return PIE_TOOLS.filter((entry) => !entry.contexts.includes(context)).map((entry) => entry.name);
}

/** External implementations stay in their packages. These are default names,
 * not a claim that every runtime registers all of them. MCP may add dynamic
 * server-tool and resource-reader names; web-access names are configurable. */
export const TOOL_INTEGRATIONS = [
  { source: '@earendil-works/pi-coding-agent', names: ['read', 'edit', 'write', 'grep', 'find', 'ls', 'bash'], note: 'bash is overridden by Pie warm-bash; SDK coding defaults omit grep/find/ls.' },
  { source: 'pi-web-access', names: ['web_search', 'source_check', 'fetch_content', 'get_search_content'], note: 'Configured names and enablement; Pie web-access-guard patches raw-result policy.' },
  { source: 'pi-mcp-adapter', names: ['mcp', 'mcpScript'], note: 'Configured enablement, plus dynamically registered direct tools and resource readers.' },
] as const;
