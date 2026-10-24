import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { pieToolsForContext } from '../../tools/catalog/index.js';
import { createSessionControlTool, type SessionControlToolRequest } from '../../tools/session-control/index.js';
import { createSessionCollaborationTools } from '../../tools/session-control/collaboration.js';

export type BackendToolEnvironment =
  | { kind: 'primary'; requestSessionControl: SessionControlToolRequest }
  | { kind: 'inventory' }
  | { kind: 'subagent'; requestSessionControl: SessionControlToolRequest };

/** Shared backend-tool assembly for actual primary runtimes and their inventory.
 * This module is separate from the metadata-only catalog so extension discovery
 * and subagent eligibility checks never load backend dependencies.
 */
export function createBackendTools(environment: BackendToolEnvironment): ToolDefinition[] {
  const request: SessionControlToolRequest = environment.kind !== 'inventory'
        ? environment.requestSessionControl
        : async () => { throw new Error('Inventory tool definitions cannot execute session operations.'); };
  const definitions = environment.kind === 'subagent'
    ? [createSessionControlTool(request, { readOnly: true })]
    : createSessionCollaborationTools(request);
  const advertised = pieToolsForContext(environment.kind).filter(entry => entry.registration.kind === 'backend');
  for (const entry of advertised) {
    if (!definitions.some(tool => tool.name === entry.name)) throw new Error(`No backend factory for catalog tool: ${entry.name}`);
  }
  return definitions;
}
