import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { pieToolsForContext } from './index.js';
import { createSessionControlTool, type SessionControlToolRequest } from './session-control/index.js';

export type BackendToolEnvironment =
  | { kind: 'primary'; requestSessionControl: SessionControlToolRequest }
  | { kind: 'inventory' }
  | { kind: 'subagent' };

/** Shared backend-tool assembly for actual primary runtimes and their inventory.
 * This module is separate from the metadata-only catalog so extension discovery
 * and subagent eligibility checks never load backend dependencies.
 */
export function createBackendTools(environment: BackendToolEnvironment): ToolDefinition[] {
  return pieToolsForContext(environment.kind)
    .filter((entry) => entry.registration.kind === 'backend')
    .map((entry) => {
      if (entry.name !== 'session_control') {
        throw new Error(`No backend factory for catalog tool: ${entry.name}`);
      }
      const request: SessionControlToolRequest = environment.kind === 'primary'
        ? environment.requestSessionControl
        : async () => { throw new Error('Inventory tool definitions cannot execute session operations.'); };
      return createSessionControlTool(request);
    });
}
