import type { SdkSessionManager } from './sdk';
import type { SessionEntryLike } from './transcript';

/** Durable custom entry identifying a session created through agent session_control. */
export const AGENT_CREATED_SESSION_CUSTOM_TYPE = 'pie.agent-created-session';
const AGENT_CREATED_SESSION_PROVENANCE_VERSION = 1;

interface SessionHeaderLike {
  id?: unknown;
}

interface AgentCreatedProvenanceData {
  version?: unknown;
  sessionId?: unknown;
}

function sessionIdFromManager(manager: Pick<SdkSessionManager, 'getSessionId' | 'getHeader'>): string | undefined {
  const sdkId = manager.getSessionId?.();
  if (typeof sdkId === 'string' && sdkId.trim()) return sdkId.trim();
  const header = manager.getHeader?.();
  if (!header || typeof header !== 'object' || Array.isArray(header)) return undefined;
  const headerId = (header as SessionHeaderLike).id;
  return typeof headerId === 'string' && headerId.trim() ? headerId.trim() : undefined;
}

function isAgentCreatedProvenanceEntry(entry: SessionEntryLike, sessionId: string): boolean {
  if (entry.type !== 'custom' || entry.customType !== AGENT_CREATED_SESSION_CUSTOM_TYPE) return false;
  if (!entry.data || typeof entry.data !== 'object' || Array.isArray(entry.data)) return false;
  const data = entry.data as AgentCreatedProvenanceData;
  return data.version === AGENT_CREATED_SESSION_PROVENANCE_VERSION
    && data.sessionId === sessionId;
}

/**
 * Read explicit provenance without using parentSession. Forks copy custom
 * entries, so the marker carries the source session id and cannot authenticate
 * a fork whose new header has a different id.
 */
export function isAgentCreatedSession(
  manager: Pick<SdkSessionManager, 'getSessionId' | 'getHeader' | 'getEntries'>,
): boolean {
  const sessionId = sessionIdFromManager(manager);
  if (!sessionId) return false;
  return manager.getEntries().some((entry) => isAgentCreatedProvenanceEntry(entry, sessionId));
}

/** Append the explicit provenance marker after the SDK has durably created the header. */
export function appendAgentCreatedSessionProvenance(
  manager: Pick<SdkSessionManager, 'getSessionId' | 'getHeader'> & {
    appendCustomEntry?: (customType: string, data?: unknown) => string;
  },
): void {
  const sessionId = sessionIdFromManager(manager);
  if (!sessionId) throw new Error('Cannot mark agent-created session without a durable session id.');
  if (typeof manager.appendCustomEntry !== 'function') {
    throw new Error('Cannot mark agent-created session: SDK custom entries are unavailable.');
  }
  manager.appendCustomEntry(AGENT_CREATED_SESSION_CUSTOM_TYPE, {
    version: AGENT_CREATED_SESSION_PROVENANCE_VERSION,
    sessionId,
  });
}
