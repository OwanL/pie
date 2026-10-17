import type { CreateAgentSessionOptions } from '@mariozechner/pi-coding-agent';

export type SubagentBackendToolsFactory = () => NonNullable<CreateAgentSessionOptions['customTools']>;
const KEY = Symbol.for('pie.subagent-backend-tools.v1');
const host = globalThis as unknown as Record<PropertyKey, unknown>;

/** Worker-owned seam shared across independently loaded extension modules.
 * The factory captures the authenticated primary transport, never child params.
 */
export function installSubagentBackendTools(factory: SubagentBackendToolsFactory): () => void {
  if (host[KEY]) throw new Error('Subagent backend tools are already installed.');
  host[KEY] = factory;
  return () => { if (host[KEY] === factory) delete host[KEY]; };
}

export function createSubagentBackendTools(): NonNullable<CreateAgentSessionOptions['customTools']> {
  const factory = host[KEY];
  return typeof factory === 'function' ? (factory as SubagentBackendToolsFactory)() : [];
}
